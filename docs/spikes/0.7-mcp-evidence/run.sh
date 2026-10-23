#!/usr/bin/env bash
# Spike 0.7: what does PostToolUse of mcp__* receive in tool_response?
#
# Usage: docs/spikes/0.7-mcp-evidence/run.sh <empty-work-dir>
#
# Builds a throwaway project in <work-dir> with a local, credential-free MCP stdio server
# (ticket-server.mjs, server name "lab-tickets") and a dump hook on PreToolUse / PostToolUse /
# PostToolUseFailure (matcher "mcp__.*") plus SubagentStart / SubagentStop. Then runs three
# headless sessions with haiku:
#   A  main session calls get_ticket, get_ticket_two_blocks, get_ticket_mixed,
#      get_ticket_structured and get_ticket_error
#   B  main session calls get_ticket_big (20,000 chars) with MAX_MCP_OUTPUT_TOKENS=2000
#   S<n>  same with the default limit and <n> chars, for each n in $SPIKE_SIZES
#   C  a subagent (--agents) calls get_ticket
# Only MCP servers from --mcp-config are loaded (--strict-mcp-config) and only the project and
# --settings sources are read, so no personal connector or user hook takes part.
# Costs real money (about $0.10-0.20 in total with haiku); each run is capped by --max-budget-usd.
# The prompt goes on stdin because --allowedTools and --agents take variadic values.
# Output: <work-dir>/hooks.<run>.jsonl (hook stdin), <work-dir>/<run>.stream.jsonl (session).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${1:?usage: run.sh <empty-work-dir>}"
MODEL="${SPIKE_MODEL:-haiku}"
BUDGET="${SPIKE_BUDGET_PER_RUN:-0.15}"
SIZES="${SPIKE_SIZES:-10000 30000 50000 60000 120000}"
RUNS="${SPIKE_RUNS:-A B C $(printf 'S%s ' $SIZES)}"   # subset, e.g. SPIKE_RUNS="A"

mkdir -p "$WORK/.claude"
WORK="$(cd "$WORK" && pwd)"
cp "$HERE/ticket-server.mjs" "$HERE/dump-hook.mjs" "$WORK/"
git -C "$WORK" init -q 2>/dev/null || true

cat > "$WORK/mcp.json" <<JSON
{ "mcpServers": { "lab-tickets": { "type": "stdio", "command": "node", "args": ["$WORK/ticket-server.mjs"] } } }
JSON

settings_for() { # $1 = run label
  local log="$WORK/hooks.$1.jsonl" hook="node $WORK/dump-hook.mjs"
  cat <<JSON
{
  "hooks": {
    "PreToolUse":         [{ "matcher": "mcp__.*", "hooks": [{ "type": "command", "timeout": 10, "command": "SPIKE_LOG=$log $hook PreToolUse" }] }],
    "PostToolUse":        [{ "matcher": "mcp__.*", "hooks": [{ "type": "command", "timeout": 10, "command": "SPIKE_LOG=$log $hook PostToolUse" }] }],
    "PostToolUseFailure": [{ "matcher": "mcp__.*", "hooks": [{ "type": "command", "timeout": 10, "command": "SPIKE_LOG=$log $hook PostToolUseFailure" }] }],
    "SubagentStart":      [{ "hooks": [{ "type": "command", "timeout": 10, "command": "SPIKE_LOG=$log $hook SubagentStart" }] }],
    "SubagentStop":       [{ "hooks": [{ "type": "command", "timeout": 10, "command": "SPIKE_LOG=$log $hook SubagentStop" }] }]
  }
}
JSON
}

run() { # $1 = label, $2 = prompt, rest = extra claude args
  local label="$1" prompt="$2"; shift 2
  [[ " $RUNS " == *" $label "* ]] || return 0
  settings_for "$label" > "$WORK/settings.$label.json"
  : > "$WORK/hooks.$label.jsonl"
  (cd "$WORK" && env -u CLAUDECODE claude -p --model "$MODEL" \
      --output-format stream-json --verbose \
      --max-budget-usd "$BUDGET" \
      --setting-sources project --settings "$WORK/settings.$label.json" \
      --strict-mcp-config --mcp-config "$WORK/mcp.json" \
      "$@" <<< "$prompt" > "$WORK/$label.stream.jsonl" 2> "$WORK/$label.err") || echo "run $label exited $?" >&2
  local cost
  cost="$(jq -r 'select(.type=="result") | .total_cost_usd' "$WORK/$label.stream.jsonl" | tail -1)"
  echo "run $label: cost_usd=${cost:-?} hook_calls=$(wc -l < "$WORK/hooks.$label.jsonl")"
  jq -r '"  \(.label)\t\(.input.tool_name // "-")\tagent_type=\(.input.agent_type // "-")\ttool_response=\(.input.tool_response | type)\tstdin_bytes=\(.stdinBytes)"' \
    "$WORK/hooks.$label.jsonl"
}

run A "Call these MCP tools in this order, one at a time: mcp__lab-tickets__get_ticket (id LAB-142), mcp__lab-tickets__get_ticket_two_blocks (id LAB-146), mcp__lab-tickets__get_ticket_mixed (id LAB-147), mcp__lab-tickets__get_ticket_structured (id LAB-143), mcp__lab-tickets__get_ticket_error (id LAB-144). Do not use any other tool except to load them. Then reply with the single word: done." \
  --allowedTools "mcp__lab-tickets__get_ticket" "mcp__lab-tickets__get_ticket_two_blocks" "mcp__lab-tickets__get_ticket_mixed" "mcp__lab-tickets__get_ticket_structured" "mcp__lab-tickets__get_ticket_error"

MAX_MCP_OUTPUT_TOKENS=2000 \
run B "Call the MCP tool mcp__lab-tickets__get_ticket_big with id LAB-145 and chars 20000, once. Do not use any other tool and do not read any file. Then reply with the single word: done." \
  --allowedTools "mcp__lab-tickets__get_ticket_big"

AGENTS='{"ticket-reader":{"description":"Reads a ticket through the lab-tickets MCP server.","prompt":"You read tickets. Call mcp__lab-tickets__get_ticket with the id you are given, exactly once, and reply with the ticket title only.","tools":["mcp__lab-tickets__get_ticket"],"model":"haiku"}}'
run C "Use the Agent tool with subagent_type ticket-reader to read ticket LAB-142. Do not call the MCP tool yourself. Then reply with the title it returns." \
  --agents "$AGENTS" --allowedTools "Agent" "mcp__lab-tickets__get_ticket"

for n in $SIZES; do
  run "S$n" "Call the MCP tool mcp__lab-tickets__get_ticket_big with id LAB-145 and chars $n, once. Do not use any other tool and do not read any file. Then reply with the single word: done." \
    --allowedTools "mcp__lab-tickets__get_ticket_big"
done

echo "logs in $WORK"
