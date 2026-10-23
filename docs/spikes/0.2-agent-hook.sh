#!/usr/bin/env bash
# Spike 0.2: a PreToolUse hook of type "agent" (model opus, timeout 240) reads a project file
# and returns {ok:false, reason}; check that the write is blocked, that the reason reaches the
# main model, and measure cost and latency.
#
# Usage: docs/spikes/0.2-agent-hook.sh <empty-work-dir>
# Costs money (claude -p with haiku in the session, opus in the hook). Cap: --max-budget-usd 0.50.
# Never point it at a real repo: it creates a throwaway project inside <work-dir>.
set -euo pipefail

WORK="${1:?usage: $0 <empty-work-dir>}"
mkdir -p "$WORK"
if [[ -n "$(ls -A "$WORK")" ]]; then echo "work dir not empty: $WORK" >&2; exit 2; fi
WORK="$(cd "$WORK" && pwd)"
PROJ="$WORK/proj"
mkdir -p "$PROJ/.claude/hooks" "$PROJ/.checker"

# --- throwaway project -------------------------------------------------------------------
printf 'export function add(a,b){return a+b}\n' > "$PROJ/a.js"
# The rule lives where the main model is not told to look; only the hook agent reads it.
cat > "$PROJ/.checker/plan-rules.md" <<'EOF'
# Plan rules

1. Every plan must contain a line that starts with `Risk:` followed by `low` or `high`.
2. Every plan must name each file it changes by its relative path.
EOF

# Command hook that only records timestamps and payloads (runs in parallel with the agent hook).
cat > "$PROJ/.claude/hooks/dump.sh" <<'EOF'
#!/usr/bin/env bash
set -u
EVENT="$1"
INPUT="$(cat)"
printf '%s\n' "$INPUT" | jq -c --arg e "$EVENT" --arg ts "$(date +%s.%N)" '{event:$e, ts:($ts|tonumber), input:.}' >> "$CLAUDE_PROJECT_DIR/../hooks.log"
exit 0
EOF

AGENT_PROMPT='You are a plan checker running as a PreToolUse hook. The pending tool call is this JSON: $ARGUMENTS
If tool_input.file_path does not end with "PLAN.md", answer ok=true and stop.
Otherwise read the file .checker/plan-rules.md inside the project directory given by "cwd" and check tool_input.content against every rule in it.
If any rule is broken, answer ok=false with reason starting with "PLAN CHECK:" and saying which rule is broken and exactly what to add. If every rule holds, answer ok=true.'

jq -n --arg p "$AGENT_PROMPT" '{
  hooks: {
    PreToolUse: [
      { matcher: "Write", hooks: [
        { type: "agent", model: "opus", timeout: 240, prompt: $p },
        { type: "command", command: "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/dump.sh\" PreToolUse", timeout: 10 }
      ]}
    ],
    PostToolUse: [
      { matcher: "Write", hooks: [
        { type: "command", command: "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/dump.sh\" PostToolUse", timeout: 10 }
      ]}
    ]
  }
}' > "$PROJ/.claude/settings.json"

git -C "$PROJ" init -q
git -C "$PROJ" add -A
git -C "$PROJ" -c user.name=spike -c user.email=spike@example.invalid commit -q -m fixture

PROMPT='Write a short plan (3-6 lines) to the file PLAN.md in the current directory describing how to add an exported function sub(a,b) to a.js. Do not read any file and do not edit a.js; only write PLAN.md with the Write tool. If a write is blocked, read the reason, fix the plan exactly as it says and write PLAN.md again. When PLAN.md is written, reply with the single word: done.'

# --- run ----------------------------------------------------------------------------------
START=$(date +%s.%N)
(
  cd "$PROJ"
  env -u CLAUDECODE claude -p --model haiku \
    --setting-sources project \
    --permission-mode acceptEdits \
    --max-budget-usd 0.50 \
    --output-format stream-json --verbose \
    --debug-file "$WORK/debug.log" \
    "$PROMPT" > "$WORK/stream.jsonl" 2> "$WORK/stderr.log"
) || echo "claude exited with $?" >&2
END=$(date +%s.%N)

# --- report -------------------------------------------------------------------------------
echo "== wall time (s): $(awk -v s="$START" -v e="$END" 'BEGIN{printf "%.1f", e-s}')"
echo "== result"
jq -c 'select(.type=="result") | {subtype, is_error, num_turns, duration_ms, total_cost_usd, result, modelUsage: (.modelUsage | with_entries(.value |= {costUSD, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens}))}' "$WORK/stream.jsonl"
echo "== tool results the main model saw for Write"
jq -c 'select(.type=="user") | .message.content[]? | select(.type=="tool_result") | {tool_use_id, is_error, content}' "$WORK/stream.jsonl"
echo "== Write calls (content)"
jq -c 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="Write") | {id, file: .input.file_path, content: .input.content}' "$WORK/stream.jsonl"
echo "== hook lines from debug log"
grep -E 'Hooks: (Starting agent query|Got structured output|Agent hook)|Slow PreToolUse|tool_dispatch_(start|end) tool=' "$WORK/debug.log" | cut -c1-400 || true
echo "== PLAN.md on disk"
cat "$PROJ/PLAN.md" 2>/dev/null || echo "(missing)"
