#!/usr/bin/env bash
# Spike 0.5: does `permissionDecision: "ask"` from a PreToolUse hook that fires INSIDE a subagent reach the
# permission channel with its reason, and what does the subagent receive after the answer?
#
# Usage: docs/spikes/0.5-ask-in-subagent.sh <work-dir> [variant...]
#   <work-dir>  a throwaway directory (never a real repo); it is created if missing.
#   variant     <host>-<where>, host in {nohost, allow, deny}, where in {fg, bg}
#               (default: nohost-fg allow-fg deny-fg nohost-bg allow-bg deny-bg).
#     nohost  plain `claude -p`, nobody answers permission prompts.
#     allow   `--permission-prompt-tool stdio` + host.mjs that answers every can_use_tool with allow.
#     deny    same, but host.mjs answers with deny and a message.
#     fg      the main session delegates to agent `implementer` (foreground).
#     bg      the main session delegates to agent `implementer-bg` (frontmatter `background: true`).
#
# Each variant builds a fixture repo in <work-dir>/<variant>/repo with both agents in .claude/agents/, and a
# hook (passed via --settings) that logs PreToolUse/PostToolUse/PostToolUseFailure/PermissionRequest/
# PermissionDenied/SubagentStart/SubagentStop/Stop to <variant>/hooks.log and answers `ask` with a reason
# for Edit/Write when agent_type starts with "implementer". The session runs with --permission-mode acceptEdits,
# so without the hook the Edit would be allowed silently: any prompt comes from the hook's `ask`.
# Output: hooks.log, result.json(l), host.log (host variants), subagent transcript copy, and a summary.
# Requires: claude, jq, git, node. Cost observed on 2.1.309 with --model haiku: ~$0.02-0.06 per variant.
set -euo pipefail

WORK="${1:?usage: $0 <work-dir> [variant...]}"
shift || true
VARIANTS=("$@")
[[ ${#VARIANTS[@]} -eq 0 ]] && VARIANTS=(nohost-fg allow-fg deny-fg nohost-bg allow-bg deny-bg)

REASON='OUT-OF-PLAN GUARD: a.js is not in the plan files list. Ask the person before editing it.'
HOST_DENY_MSG='HOST: the person rejected this edit.'

# In 2.1.309 subagents run in the background by default, also in -p (Agent returns `async_launched`).
# fg therefore asks the model to pass `run_in_background: false`; bg relies on the agent's `background: true`.
prompt_for() {
  local agent="$1" how
  if [[ "$agent" == "implementer" ]]; then how=' and run_in_background set to false (foreground: you need its result before replying)'; else how=''; fi
  printf 'Use the Agent tool with subagent_type "%s"%s and this exact prompt: "In a.js add an exported function sub(a,b) that returns a-b." Wait for it to finish, then reply with the subagent final message verbatim and nothing else. Do not edit any file yourself.' "$agent" "$how"
}

setup_fixture() {
  local dir="$1"
  rm -rf "$dir"
  mkdir -p "$dir/repo/.claude/agents"
  printf 'export function add(a,b){return a+b}\n' > "$dir/repo/a.js"
  local body='You edit files with the Edit tool. Make exactly the change the prompt asks for, with one Edit call.
If a tool call is denied, rejected or returns an error, do NOT retry and do not try another tool: reply with
"DENIED: " followed by the exact, complete text of the error or tool result you received, verbatim.
If the edit succeeds, reply with the single word: DONE.'
  printf -- '---\nname: implementer\ndescription: Spike subagent. Applies one edit.\ntools: Read, Edit\nmodel: haiku\n---\n\n%s\n' "$body" \
    > "$dir/repo/.claude/agents/implementer.md"
  printf -- '---\nname: implementer-bg\ndescription: Spike subagent that always runs in background. Applies one edit.\ntools: Read, Edit\nmodel: haiku\nbackground: true\n---\n\n%s\n' "$body" \
    > "$dir/repo/.claude/agents/implementer-bg.md"
  git -C "$dir/repo" init -q
  git -C "$dir/repo" add -A
  git -C "$dir/repo" -c user.name=spike -c user.email=spike@example.invalid commit -qm fixture

  cat > "$dir/hook.sh" <<HOOK
#!/usr/bin/env bash
# Records the payload; answers "ask" with a reason for Edit/Write inside an implementer* subagent.
set -u
EVENT="\$1"
DIR="\$(cd "\$(dirname "\$0")" && pwd)"
INPUT="\$(cat)"
printf '%s\n' "\$INPUT" | jq -c --arg e "\$EVENT" '{event:\$e, input:.}' >> "\$DIR/hooks.log" 2>>"\$DIR/hooks.err" \\
  || printf '{"event":"%s","raw":%s}\n' "\$EVENT" "\$(printf '%s' "\$INPUT" | jq -Rs .)" >> "\$DIR/hooks.log"
if [[ "\$EVENT" == "PreToolUse" ]]; then
  AT="\$(printf '%s' "\$INPUT" | jq -r '.agent_type // empty')"
  TOOL="\$(printf '%s' "\$INPUT" | jq -r '.tool_name // empty')"
  if [[ "\$AT" == implementer* && ( "\$TOOL" == "Edit" || "\$TOOL" == "Write" ) ]]; then
    jq -nc --arg r '$REASON' '{hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision:"ask", permissionDecisionReason:\$r}}' \\
      | tee -a "\$DIR/hook-outputs.log"
  fi
fi
exit 0
HOOK
  chmod +x "$dir/hook.sh"

  local h="bash $dir/hook.sh"
  jq -n --arg h "$h" '
    def ev($e): [{matcher:"*", hooks:[{type:"command", command:($h+" "+$e), timeout:10}]}];
    def evn($e): [{hooks:[{type:"command", command:($h+" "+$e), timeout:10}]}];
    {hooks: {
      PreToolUse: ev("PreToolUse"), PostToolUse: ev("PostToolUse"), PostToolUseFailure: ev("PostToolUseFailure"),
      PermissionRequest: ev("PermissionRequest"), PermissionDenied: ev("PermissionDenied"),
      SubagentStart: ev("SubagentStart"), SubagentStop: ev("SubagentStop"), Stop: evn("Stop")
    }}' > "$dir/settings.json"
}

write_host() {
  cat > "$1" <<'HOST'
// Minimal stream-json host: sends the prompt, answers every can_use_tool with allow or deny (by mode),
// logs the requests verbatim. Closes stdin only after a result AND 20 s of silence, so background
// subagents that finish after the first result still get their turn.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
const [dir, mode, denyMsg, prompt, sep, ...claudeArgs] = process.argv.slice(2);
if (sep !== "--") throw new Error("usage: host.mjs <dir> <allow|deny> <denyMsg> <prompt> -- <claude args>");
const log = (file, obj) => appendFileSync(`${dir}/${file}`, JSON.stringify(obj) + "\n");
const child = spawn("claude", ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...claudeArgs],
  { stdio: ["pipe", "pipe", "inherit"] });
const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
send({ type: "control_request", request_id: "init_1", request: { subtype: "initialize" } });
send({ type: "user", message: { role: "user", content: prompt } });
let buf = "", sawResult = false, idle = null;
const armIdle = () => { clearTimeout(idle); if (sawResult) idle = setTimeout(() => child.stdin.end(), 20000); };
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    log("result.jsonl", msg);
    if (msg.type === "control_request" && msg.request?.subtype === "can_use_tool") {
      log("host.log", { can_use_tool: msg });
      const response = mode === "allow"
        ? { behavior: "allow", updatedInput: msg.request.input }
        : { behavior: "deny", message: denyMsg };
      log("host.log", { answered: response });
      send({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response } });
    }
    if (msg.type === "result") sawResult = true;
    armIdle();
  }
});
child.on("exit", (code) => { clearTimeout(idle); process.exit(code ?? 1); });
HOST
}

run_variant() {
  local v="$1" dir="$WORK/$1" host="${1%-*}" where="${1#*-}" agent
  [[ "$where" == "bg" ]] && agent="implementer-bg" || agent="implementer"
  setup_fixture "$dir"
  local prompt; prompt="$(prompt_for "$agent")"
  local common=(--model haiku --permission-mode acceptEdits --settings "$dir/settings.json" --max-budget-usd 0.12)
  echo "== $v (agent $agent)"
  case "$host" in
    nohost)
      (cd "$dir/repo" && timeout 300 env -u CLAUDECODE claude -p "${common[@]}" --output-format json "$prompt" \
        > "$dir/result.json" 2> "$dir/run.err") || true
      ;;
    allow|deny)
      write_host "$dir/host.mjs"
      (cd "$dir/repo" && timeout 300 env -u CLAUDECODE node "$dir/host.mjs" "$dir" "$host" "$HOST_DENY_MSG" "$prompt" -- \
        "${common[@]}" --permission-prompt-tool stdio 2> "$dir/run.err") || true
      ;;
    *) echo "unknown variant: $v" >&2; return 1 ;;
  esac
  summarize "$dir"
}

summarize() {
  local dir="$1" res
  if [[ -f "$dir/result.json" ]]; then res="$dir/result.json"; else res="$(mktemp)"; grep '"type":"result"' "$dir/result.jsonl" | tail -1 > "$res" || true; fi
  jq -c '{cost:.total_cost_usd, turns:.num_turns, result:.result, denials:.permission_denials}' "$res" 2>/dev/null || echo "no result"
  [[ -f "$dir/result.jsonl" ]] && { echo "-- all results:"; jq -c 'select(.type=="result") | {cost:.total_cost_usd, result:.result}' "$dir/result.jsonl"; }
  echo "-- hook events:"
  jq -c '{event, tool:.input.tool_name, agent_type:.input.agent_type}' "$dir/hooks.log" 2>/dev/null || echo "(no hooks.log)"
  echo "-- a.js now:"; cat "$dir/repo/a.js"
  if [[ -f "$dir/host.log" ]]; then echo "-- host:"; cat "$dir/host.log"; fi
  # Copy the subagent transcript (path from SubagentStop) and show the tool_result the subagent saw for Edit.
  local tp; tp="$(jq -r 'select(.event=="SubagentStop") | .input.agent_transcript_path // empty' "$dir/hooks.log" 2>/dev/null | tail -1)"
  if [[ -n "$tp" && -f "$tp" ]]; then
    cp "$tp" "$dir/subagent.jsonl"
    echo "-- subagent tool_results:"
    jq -c 'select(.type=="user") | .message.content[]? | select(.type=="tool_result") | {is_error, content}' "$dir/subagent.jsonl"
  fi
}

mkdir -p "$WORK"
for v in "${VARIANTS[@]}"; do run_variant "$v"; done
