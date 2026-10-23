#!/usr/bin/env bash
# Spike 0.1: does PreToolUse(ExitPlanMode) carry `plan` and `planFilePath`, and does a deny reason reach the model?
#
# Usage: docs/spikes/0.1-exit-plan-mode.sh <work-dir> [variant...]
#   <work-dir>  a throwaway directory (never a real repo); it is created if missing.
#   variant     one of: plan-default, plan-tools, stream-json, sdk-host (default: all four).
#
# Each variant runs `claude -p --model haiku` in a fresh fixture repo inside <work-dir>/<variant>/,
# with a hook (passed via --settings) that appends every PreToolUse/PostToolUse/PostToolUseFailure/
# PermissionRequest payload to <variant>/hooks.log and denies the FIRST ExitPlanMode call with a reason.
# Note: Claude Code still writes the plan file under ~/.claude/plans/ (the `plansDirectory` setting was
# tried and ignored in 2.1.309), so each run leaves one small plan-*.md there; the summary prints its path.
# Output: <variant>/result.json (or result.jsonl for stream-json), hooks.log, and a summary on stdout.
# Requires: claude, jq, git, node. Cost: $0.04-0.08 per variant (observed on 2.1.309: in plan mode most of the
# usage is billed to claude-sonnet-5-5 even with --model haiku); each run is capped by --max-budget-usd 0.15.
set -euo pipefail

WORK="${1:?usage: $0 <work-dir> [variant...]}"
shift || true
VARIANTS=("$@")
[[ ${#VARIANTS[@]} -eq 0 ]] && VARIANTS=(plan-default plan-tools stream-json sdk-host)

PROMPT='Plan how to add an exported function `sub(a,b)` to a.js. Write a short plan to the plan file and then call the ExitPlanMode tool. If ExitPlanMode is denied, read the reason, update the plan file accordingly, and call ExitPlanMode again. After approval, do not implement anything; just reply with the single word: planned.'

setup_fixture() {
  local dir="$1"
  rm -rf "$dir"
  mkdir -p "$dir/repo"
  printf 'export function add(a,b){return a+b}\n' > "$dir/repo/a.js"
  git -C "$dir/repo" init -q
  git -C "$dir/repo" add a.js
  git -C "$dir/repo" -c user.name=spike -c user.email=spike@example.invalid commit -qm fixture

  cat > "$dir/hook.sh" <<'HOOK'
#!/usr/bin/env bash
# Records the hook payload; denies the first ExitPlanMode with a reason, lets later ones through untouched.
set -u
EVENT="$1"
DIR="$(cd "$(dirname "$0")" && pwd)"
INPUT="$(cat)"
printf '%s\n' "$INPUT" | jq -c --arg e "$EVENT" '{event:$e, input:.}' >> "$DIR/hooks.log" 2>>"$DIR/hooks.err" \
  || printf '{"event":"%s","raw":%s}\n' "$EVENT" "$(printf '%s' "$INPUT" | jq -Rs .)" >> "$DIR/hooks.log"
TOOL="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')"
if [[ "$EVENT" == "PreToolUse" && "$TOOL" == "ExitPlanMode" && ! -f "$DIR/.denied" ]]; then
  touch "$DIR/.denied"
  jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision:"deny",
    permissionDecisionReason:"PLAN GATE: the plan must name the export `fooBar` literally (add a section \"Exports: fooBar\"). Update the plan file, then call ExitPlanMode again."}}'
fi
exit 0
HOOK
  chmod +x "$dir/hook.sh"

  local h="bash $dir/hook.sh"
  jq -n --arg h "$h" '{
    hooks: {
      PreToolUse:         [{matcher:"*", hooks:[{type:"command", command:($h+" PreToolUse"), timeout:10}]}],
      PostToolUse:        [{matcher:"*", hooks:[{type:"command", command:($h+" PostToolUse"), timeout:10}]}],
      PostToolUseFailure: [{matcher:"*", hooks:[{type:"command", command:($h+" PostToolUseFailure"), timeout:10}]}],
      PermissionRequest:  [{matcher:"*", hooks:[{type:"command", command:($h+" PermissionRequest"), timeout:10}]}]
    }}' > "$dir/settings.json"
}

write_host() {
  cat > "$1" <<'HOST'
// Minimal stream-json host: sends the prompt, approves every can_use_tool request, stops at the result.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
const [dir, prompt, sep, ...claudeArgs] = process.argv.slice(2);
if (sep !== "--") throw new Error("usage: host.mjs <dir> <prompt> -- <claude args>");
const log = (file, obj) => appendFileSync(`${dir}/${file}`, JSON.stringify(obj) + "\n");
const child = spawn("claude", ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...claudeArgs],
  { stdio: ["pipe", "pipe", "inherit"] });
const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
send({ type: "control_request", request_id: "init_1", request: { subtype: "initialize" } });
send({ type: "user", message: { role: "user", content: prompt } });
let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    log("result.jsonl", msg);
    if (msg.type === "system" && msg.subtype === "init" && !msg.tools.includes("ExitPlanMode")) {
      log("host.log", { abort: "ExitPlanMode not in init tools", tools: msg.tools });
      child.kill("SIGTERM");
    }
    if (msg.type === "control_request" && msg.request?.subtype === "can_use_tool") {
      log("host.log", { can_use_tool: msg.request });
      send({ type: "control_response", response: { subtype: "success", request_id: msg.request_id,
        response: { behavior: "allow", updatedInput: msg.request.input } } });
    }
    if (msg.type === "result") child.stdin.end();
  }
});
child.on("exit", (code) => process.exit(code ?? 1));
HOST
}

run_variant() {
  local v="$1" dir="$WORK/$1"
  setup_fixture "$dir"
  local common=(--model haiku --permission-mode plan --settings "$dir/settings.json" --max-budget-usd 0.15)
  echo "== $v"
  case "$v" in
    plan-default)
      # Plain headless plan mode (what the lab tried): the default tool set.
      (cd "$dir/repo" && env -u CLAUDECODE claude -p "${common[@]}" --output-format json "$PROMPT" \
        > "$dir/result.json" 2> "$dir/run.err") || true
      ;;
    plan-tools)
      # Same, but ExitPlanMode named explicitly in --tools so it is not left behind ToolSearch.
      (cd "$dir/repo" && env -u CLAUDECODE claude -p "${common[@]}" --tools "Read,Write,Edit,Glob,Grep,ExitPlanMode" \
        --output-format json "$PROMPT" > "$dir/result.json" 2> "$dir/run.err") || true
      ;;
    stream-json)
      # SDK-style host: stream-json in/out; permission prompts go to the host (us), which never answers.
      local msg
      msg="$(jq -cn --arg p "$PROMPT" '{type:"user", message:{role:"user", content:$p}}')"
      # `timeout` because an unanswered permission request would wait forever.
      (cd "$dir/repo" && printf '%s\n' "$msg" | timeout 240 env -u CLAUDECODE claude -p "${common[@]}" \
        --tools "Read,Write,Edit,Glob,Grep,ExitPlanMode" --input-format stream-json --output-format stream-json --verbose \
        > "$dir/result.jsonl" 2> "$dir/run.err") || true
      ;;
    sdk-host)
      # What the Agent SDK does when the host passes `canUseTool`: --permission-prompt-tool stdio, and the host
      # answers each `can_use_tool` control request over stdin. host.mjs approves everything and logs the requests.
      # It kills the run right after `system/init` if ExitPlanMode is not in the tool list (no tokens wasted).
      write_host "$dir/host.mjs"
      (cd "$dir/repo" && timeout 300 env -u CLAUDECODE node "$dir/host.mjs" "$dir" "$PROMPT" -- "${common[@]}" \
        --tools "Read,Write,Edit,Glob,Grep,ExitPlanMode" --permission-prompt-tool stdio \
        2> "$dir/run.err") || true
      ;;
    *) echo "unknown variant: $v" >&2; return 1 ;;
  esac
  summarize "$dir"
}

summarize() {
  local dir="$1" res
  if [[ -f "$dir/result.json" ]]; then res="$dir/result.json"; else res="$(mktemp)"; grep '"type":"result"' "$dir/result.jsonl" | tail -1 > "$res" || true; fi
  jq -c '{cost:.total_cost_usd, turns:.num_turns, result:.result, denials:[.permission_denials[]?.tool_name]}' "$res" 2>/dev/null || echo "no result"
  echo "-- tool calls seen by hooks:"
  jq -c '{event, tool:.input.tool_name}' "$dir/hooks.log" 2>/dev/null | uniq -c || echo "(no hooks.log)"
  echo "-- ExitPlanMode payloads:"
  jq -c 'select(.input.tool_name=="ExitPlanMode") | {event, input_keys:(.input|keys), tool_input_keys:(.input.tool_input|keys? // null), planFilePath:.input.tool_input.planFilePath, plan_head:(.input.tool_input.plan // "" | .[0:120]), response:(.input.tool_response // .input.error // null | tostring | .[0:300])}' \
    "$dir/hooks.log" 2>/dev/null || true
  if [[ -f "$dir/host.log" ]]; then
    echo "-- host (can_use_tool requests / abort):"
    jq -c '.abort // {tool:.can_use_tool.tool_name, input_keys:(.can_use_tool.input|keys)}' "$dir/host.log"
  fi
  echo "-- plan files written:"
  jq -r 'select(.event=="PostToolUse" and .input.tool_name=="Write") | .input.tool_input.file_path' "$dir/hooks.log" 2>/dev/null | sort -u || true
}

mkdir -p "$WORK"
for v in "${VARIANTS[@]}"; do run_variant "$v"; done
