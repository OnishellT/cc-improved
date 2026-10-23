#!/usr/bin/env bash
# TEMPLATE for a nix verification tool: a script that only calls binaries its shell.nix / flake.nix pins.
# Copy it next to that env file, rename it after what it proves and replace the EXAMPLE check.
set -euo pipefail

TOOL="check-tool" # EXAMPLE name: use the file name.
MAX_DETAIL=300

usage() {
  cat <<'HELP'
EXAMPLE: check that a running local instance answers on its health endpoint.

Usage: check-tool.sh --url <url> [--expect <status>]
Read-only: sends one GET request. Does not start, stop or change anything.
Output: one JSON object on stdout: {"tool", "ok", "checks": [{"name", "ok", "detail"}]}.
Exit codes: 0 pass, 1 fail or no answer, 2 bad usage.
HELP
}

emit() { # ok name detail code
  jq -cn --arg tool "$TOOL" --argjson ok "$1" --arg name "$2" --arg detail "${3:0:$MAX_DETAIL}" \
    '{tool: $tool, ok: $ok, checks: [{name: $name, ok: $ok, detail: $detail}]}'
  exit "$4"
}

url="" expect=200
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --url) url="${2:-}"; shift 2 ;;
    --expect) expect="${2:-}"; shift 2 ;;
    *) emit false usage "unknown argument $1, see --help" 2 ;;
  esac
done
[ -n "$url" ] || emit false usage "--url is required, see --help" 2

# EXAMPLE check: replace with the project's own.
status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" || true)
if [ "$status" = "$expect" ]; then emit true "$url" "status $status" 0; fi
emit false "$url" "status ${status:-none}, expected $expect" 1
