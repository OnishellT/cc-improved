#!/usr/bin/env bash
# Spike 0.3: does a SubagentStop hook with decision "block" send the subagent back to work,
# and does the second SubagentStop arrive with stop_hook_active: true?
#
# Usage: docs/spikes/0.3-subagent-stop.sh <empty-workdir> [once|always]
#   once   (default) block the first SubagentStop of `echoer` only (while stop_hook_active is false).
#   always block every SubagentStop of `echoer`, to observe the continuation cap.
#          Set CLAUDE_CODE_STOP_HOOK_BLOCK_CAP in the environment to test a custom cap.
#
# Requires: claude (2.1.309 tested), jq. Costs money: one headless haiku session per run.
# The lab is created inside <workdir>; never point it at a real repository.
set -euo pipefail

WORK="${1:?usage: $0 <empty-workdir> [once|always]}"
MODE="${2:-once}"
case "$MODE" in once|always) ;; *) echo "mode must be once or always" >&2; exit 2 ;; esac

mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
LAB="$WORK/lab-$MODE"
rm -rf "$LAB"
mkdir -p "$LAB/.claude/agents" "$LAB/hooks"
git -C "$LAB" init -q

cat > "$LAB/.claude/agents/echoer.md" <<'EOF'
---
name: echoer
description: Lab subagent. Runs one echo command and reports its output.
tools: Bash
model: haiku
---

You run exactly the shell command the prompt gives you with Bash and reply with its output, nothing else.
EOF

# dump.sh records every event's stdin JSON in hooks.log.
cat > "$LAB/hooks/dump.sh" <<'EOF'
#!/usr/bin/env bash
set -u
LAB="$(cd "$(dirname "$0")/.." && pwd)"
jq -c --arg e "$1" '{event:$e, input:.}' >> "$LAB/hooks.log"
exit 0
EOF

# gate.sh is the SubagentStop hook under test (matcher: echoer).
cat > "$LAB/hooks/gate.sh" <<'EOF'
#!/usr/bin/env bash
set -u
LAB="$(cd "$(dirname "$0")/.." && pwd)"
MODE="$(cat "$LAB/hooks/mode")"
INPUT="$(cat)"
printf '%s\n' "$INPUT" | jq -c '{event:"gate", input:.}' >> "$LAB/gate.log"
ACTIVE="$(printf '%s' "$INPUT" | jq -r '.stop_hook_active')"
if [[ "$MODE" == "always" || "$ACTIVE" != "true" ]]; then
  N=$(( $(wc -l < "$LAB/gate.log") ))
  jq -n --arg n "$N" '{decision:"block", reason:("SPIKE GATE " + $n + ": before finishing, run exactly this command with Bash: echo gate-ok-" + $n + ". Then reply with its output.")}' | tee -a "$LAB/gate.out"
fi
exit 0
EOF
printf '%s\n' "$MODE" > "$LAB/hooks/mode"

cat > "$LAB/.claude/settings.json" <<'EOF'
{
  "hooks": {
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/hooks/dump.sh\" SubagentStart", "timeout": 10 }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/hooks/dump.sh\" PostToolUse", "timeout": 10 }] }],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/hooks/dump.sh\" SubagentStop", "timeout": 10 }] },
      { "matcher": "echoer", "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/hooks/gate.sh\"", "timeout": 10 }] }
    ],
    "Stop": [{ "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/hooks/dump.sh\" Stop", "timeout": 10 }] }]
  }
}
EOF

PROMPT='Use the Agent tool with subagent_type "echoer" (in the foreground, not in the background) and the prompt "Run: echo hi". Wait until it finishes, then reply with the final report the subagent returned, verbatim.'

cd "$LAB"
# --setting-sources project: only this lab's hooks (no user hooks); --strict-mcp-config: no MCP servers.
env -u CLAUDECODE claude -p --model haiku \
  --setting-sources project --strict-mcp-config \
  --allowedTools "Agent" "Bash(echo:*)" \
  --max-budget-usd 0.20 \
  --output-format json \
  "$PROMPT" > "$LAB/result.json" 2> "$LAB/result.err" || true

echo "== result"
jq -c '{subtype, is_error, num_turns, total_cost_usd, result}' "$LAB/result.json"
echo "== SubagentStop events (agent_type, stop_hook_active, last_assistant_message)"
jq -c 'select(.event=="SubagentStop") | .input | {agent_type, stop_hook_active, last_assistant_message}' "$LAB/hooks.log"
echo "== gate decisions"
cat "$LAB/gate.out" 2>/dev/null || echo "(none)"
echo "== Agent tool_response"
jq -c 'select(.event=="PostToolUse" and .input.tool_name=="Agent") | .input.tool_response | {status, isAsync, totalToolUseCount}' "$LAB/hooks.log"
echo "== stop_hook_active across SubagentStop events (count value)"
jq -r 'select(.event=="SubagentStop") | .input.stop_hook_active' "$LAB/hooks.log" | sort | uniq -c
echo "== blocks in the subagent transcript (a turn with tool_use resets the consecutive count)"
TRANSCRIPT="$(jq -r 'select(.event=="SubagentStop") | .input.agent_transcript_path' "$LAB/hooks.log" | head -1)"
if [[ -n "$TRANSCRIPT" && -f "$TRANSCRIPT" ]]; then
  jq -s -c 'reduce .[] as $e ({n:0, max:0, total:0};
      if ($e.type=="assistant" and ([$e.message.content[]? | select(.type=="tool_use")] | length > 0)) then .n = 0
      elif ($e.type=="attachment" and $e.attachment.type=="hook_blocking_error") then .n += 1 | .total += 1 | .max = ([.max, .n] | max)
      else . end)
    | {blocks_total: .total, trailing_consecutive_blocks_without_tool_use: .n, max_consecutive: .max}' "$TRANSCRIPT"
fi
