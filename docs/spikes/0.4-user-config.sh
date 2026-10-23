#!/usr/bin/env bash
# Spike 0.4: is ${user_config.strong_model} substituted in the `model:` frontmatter of a plugin agent?
#
# Usage: bash docs/spikes/0.4-user-config.sh <empty-work-dir>
#   The work dir must be a scratch folder outside any real repo. The script builds a throwaway
#   plugin (uc-lab) and project there, and runs `claude -p --model haiku` a few times (~$0.03).
# Requires: claude (tested on 2.1.309), jq, git, timeout.
# Output: <work-dir>/evidence/*.txt and a summary on stdout.
set -euo pipefail

WORK="${1:?usage: $0 <empty-work-dir>}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
PLUGIN="$WORK/plugin"
PROJ="$WORK/proj"
EV="$WORK/evidence"
CONFIG_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
mkdir -p "$PLUGIN/.claude-plugin" "$PLUGIN/agents" "$PLUGIN/hooks" "$PLUGIN/skills/show-model" "$PROJ" "$EV"
git -C "$PROJ" init -q

# ---------------------------------------------------------------- fixtures
cat > "$PLUGIN/.claude-plugin/plugin.json" <<'EOF'
{
  "name": "uc-lab",
  "version": "0.0.1",
  "description": "Spike 0.4: userConfig substitution in agent frontmatter model.",
  "author": { "name": "spike" },
  "userConfig": {
    "strong_model": {
      "type": "string",
      "title": "Strong model",
      "description": "Model for strong agents (alias or full id).",
      "default": "opus"
    }
  }
}
EOF
# Agent under test: model comes from user config.
cat > "$PLUGIN/agents/strong-echo.md" <<'EOF'
---
name: strong-echo
description: Spike agent. Replies with one word.
tools: Read
model: ${user_config.strong_model}
---
Reply with the single word: pong. Do not use tools.
EOF
# Control: literal model, placeholder only in the body.
cat > "$PLUGIN/agents/body-echo.md" <<'EOF'
---
name: body-echo
description: Spike control agent. Fixed model; echoes the user_config placeholder from its body.
tools: Read
model: haiku
---
The configured value is: [${user_config.strong_model}]. Reply with exactly the text between the brackets, brackets included. Do not use tools.
EOF
# Control: placeholder in a skill body.
cat > "$PLUGIN/skills/show-model/SKILL.md" <<'EOF'
---
name: show-model
description: Spike skill. Echoes the strong_model user config value.
---
The strong model value is: [${user_config.strong_model}]. Reply with exactly the text between the brackets, brackets included, and nothing else.
EOF
# Control: placeholder in a hook (exec form; shell form with ${user_config.*} is refused by Claude Code).
cat > "$PLUGIN/hooks/hooks.json" <<'EOF'
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "timeout": 10, "command": "bash", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/probe.sh", "${user_config.strong_model}"] } ] }
    ],
    "SubagentStart": [
      { "hooks": [ { "type": "command", "timeout": 10, "command": "bash", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/probe.sh", "${user_config.strong_model}"] } ] }
    ]
  }
}
EOF
cat > "$PLUGIN/hooks/probe.sh" <<'EOF'
#!/usr/bin/env bash
# Records the substituted hook argument, the exported option env var and the raw event payload.
input="$(cat)"
jq -nc --arg arg "$1" --arg env "${CLAUDE_PLUGIN_OPTION_STRONG_MODEL-<unset>}" --argjson in "$input" \
  '{event:$in.hook_event_name, substituted_arg:$arg, env_CLAUDE_PLUGIN_OPTION_STRONG_MODEL:$env, agent_type:$in.agent_type, payload_keys:($in|keys)}' >> "${PROBE_OUT:-/dev/null}"
EOF

# ---------------------------------------------------------------- helpers
settings_for() { # $1 = value or "none"
  if [ "$1" = none ]; then echo '{}'; else jq -nc --arg v "$1" '{pluginConfigs:{"uc-lab@inline":{options:{strong_model:$v}}}}'; fi
}
run_claude() { # $1 = run name, $2 = value|none, $3 = prompt
  local name="$1" value="$2" prompt="$3"
  rm -f "$WORK/$name.probe.jsonl"
  (cd "$PROJ" && timeout 300 env -u CLAUDECODE PROBE_OUT="$WORK/$name.probe.jsonl" \
    claude -p --model haiku --plugin-dir "$PLUGIN" --settings "$(settings_for "$value")" \
      --output-format stream-json --verbose --max-turns 6 --debug-file "$WORK/$name.debug.log" \
      "$prompt" < /dev/null > "$WORK/$name.stream.jsonl" 2> "$WORK/$name.err") || true
}
report() { # $1 = run name -> evidence/<name>.txt
  local name="$1" s="$WORK/$1.stream.jsonl" sid dir
  sid="$(jq -r 'select(.type=="system" and .subtype=="init") | .session_id' "$s" | head -1)"
  {
    echo "## $name (session $sid)"
    echo "# stderr"; cat "$WORK/$name.err"
    echo "# Agent tool calls"; jq -c 'select(.type=="assistant") | .message.content[] | select(.type=="tool_use" and .name=="Agent") | .input' "$s"
    echo "# task notifications"; jq -c 'select(.type=="system" and .subtype=="task_notification") | {task_id, status, summary}' "$s"
    echo "# subagent transcripts (model per assistant message)"
    for dir in "$CONFIG_HOME"/projects/*/"$sid"/subagents; do
      [ -d "$dir" ] || continue
      for f in "$dir"/*.jsonl; do
        printf '%s ' "$(jq -r .agentType "${f%.jsonl}.meta.json")"
        jq -c 'select(.type=="assistant") | {model: .message.model, text: [.message.content[]? | .text? | select(.)]}' "$f"
      done
    done
    echo "# hook errors (debug log)"; grep -E 'Hook failed to run' "$WORK/$name.debug.log" | cut -c1-300 || true
    echo "# plugin hook probe"; cat "$WORK/$name.probe.jsonl" 2>/dev/null || echo "(no probe output)"
    echo "# final result"; jq -c 'select(.type=="result") | {total_cost_usd, modelUsage: (.modelUsage | map_values(.costUSD)), result}' "$s" | tail -1
  } > "$EV/$name.txt"
  cat "$EV/$name.txt"; echo
}

# ---------------------------------------------------------------- 0. validate
{ claude plugin validate "$PLUGIN"; claude plugin validate "$PLUGIN/agents"; claude plugin validate "$PLUGIN/skills"; } > "$EV/00-validate.txt" 2>&1 || true
grep -E '✔|✘ Found [0-9]+ error' "$EV/00-validate.txt"

# ---------------------------------------------------------------- 1. claude plugin configure (isolated config dir, no model call)
MKT="$WORK/mkt"; CFG="$WORK/cfg"; PROJ_INST="$WORK/proj-installed"
mkdir -p "$MKT/.claude-plugin" "$CFG" "$PROJ_INST"
cp -r "$PLUGIN" "$MKT/uc-lab"
echo '{ "name": "uc-lab-mkt", "owner": { "name": "spike" }, "plugins": [ { "name": "uc-lab", "source": "./uc-lab" } ] }' > "$MKT/.claude-plugin/marketplace.json"
(
  cd "$PROJ_INST"; export CLAUDE_CONFIG_DIR="$CFG"
  claude plugin marketplace add "$MKT"
  claude plugin install uc-lab@uc-lab-mkt --scope project
  echo "# configure --json right after install"; claude plugin configure uc-lab@uc-lab-mkt --json
  echo '{"strong_model":"sonnet"}' | claude plugin configure uc-lab@uc-lab-mkt --values-stdin
  echo "# configure --json after --values-stdin"; claude plugin configure uc-lab@uc-lab-mkt --json
  echo "# where the value is stored ($CFG/settings.json)"; jq '.pluginConfigs' "$CFG/settings.json"
) > "$EV/01-configure.txt" 2>&1 || true
cat "$EV/01-configure.txt"; echo

# ---------------------------------------------------------------- 2. model runs (haiku session)
TWO_CALLS='Call the Agent tool twice, one after the other, with run_in_background false: first subagent_type "uc-lab:body-echo" with prompt "go", then subagent_type "uc-lab:strong-echo" with prompt "ping". Then report each result verbatim.'
run_claude A-unset none "$TWO_CALLS";   report A-unset
run_claude B-sonnet sonnet "$TWO_CALLS"; report B-sonnet
run_claude C-override sonnet "Call the Agent tool twice, one after the other, with run_in_background false and the Agent tool's model parameter set to \"sonnet\" both times: first subagent_type \"uc-lab:body-echo\" with prompt \"go\", then subagent_type \"uc-lab:strong-echo\" with prompt \"ping\". Then report each result verbatim."
report C-override
run_claude D-skill-unset none "/uc-lab:show-model";   report D-skill-unset
run_claude D-skill-sonnet sonnet "/uc-lab:show-model"; report D-skill-sonnet

echo "## total cost (USD)"
for f in "$WORK"/*.stream.jsonl; do jq -r 'select(.type=="result") | .total_cost_usd' "$f" | tail -1; done | awk '{s+=$1} END {printf "%.4f\n", s}' | tee "$EV/99-cost.txt"
