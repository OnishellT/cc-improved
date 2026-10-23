#!/usr/bin/env bash
# Clean install test of cc-improved (issue #31).
#
# Usage: docs/clean-install.sh <empty work dir> [git source]
#   git source: a local repo or branch checkout to serve as the marketplace (default: this repo).
#   After the PR is merged, run the remote variant by hand instead:
#     CLAUDE_CONFIG_DIR=<empty dir> claude plugin marketplace add OnishellT/cc-improved
#     CLAUDE_CONFIG_DIR=<empty dir> claude plugin install cc-improved@cc-improved
#
# Everything lives under <work dir>: an EMPTY, isolated CLAUDE_CONFIG_DIR, a smart-HTTP git server that serves the
# source's current HEAD (so `marketplace add <url>` goes through the same git path as GitHub, see
# docs/spikes/0.6-plugin-deps.md), and the evidence. Only COMMITTED files are served: commit before running.
#
# Steps without model (cost $0): marketplace add, install, list, validate the cached copy, hooks smoke test.
# Steps with model (cost > 0, only if CC_CREDENTIALS points to a .credentials.json; it is copied INTO the
# isolated config dir, so delete <work dir>/config after): wf-doctor and /verify via `claude -p`, and the e2e flow of
# test/e2e/run.mjs against the INSTALLED plugin (no --plugin-dir) with a hard cap E2E_BUDGET (default 0.45).
set -euo pipefail

WORK=${1:?usage: $0 <empty work dir> [git source]}
SRC=$(cd "${2:-$(dirname "$0")/..}" && pwd)
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd)
export CLAUDE_CONFIG_DIR="$WORK/config"
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_AUTH_TOKEN || true
PORT=${PORT:-8767}
MODEL=${MODEL:-claude-haiku-5-5}
mkdir -p "$CLAUDE_CONFIG_DIR" "$WORK/srv" "$WORK/tools" "$WORK/evidence"
say() { printf '\n=== %s\n' "$*"; }
short() { sed "s|$WORK|<work>|g"; }

say "0. isolated config starts empty"
ls -A "$CLAUDE_CONFIG_DIR" | wc -l | sed 's/^/  entries in config dir: /'
if [ -n "${CC_CREDENTIALS:-}" ]; then cp "$CC_CREDENTIALS" "$CLAUDE_CONFIG_DIR/.credentials.json"; chmod 600 "$CLAUDE_CONFIG_DIR/.credentials.json"; fi

say "1. serve the marketplace over git/HTTP (HEAD of $SRC)"
git -C "$SRC" log --oneline -1 | sed 's/^/  /'
rm -rf "$WORK/srv/cc-improved.git"
git clone -q --bare "$SRC" "$WORK/srv/cc-improved.git"
sed -n '/^cat >"\$WORK\/tools\/git-http.mjs" <<.EOF.$/,/^EOF$/p' "$(dirname "$0")/spikes/0.6-plugin-deps.sh" | sed '1d;$d' >"$WORK/tools/git-http.mjs"
node "$WORK/tools/git-http.mjs" "$WORK/srv" "$PORT" &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
sleep 1

say "2. marketplace add + install"
claude plugin marketplace add "http://127.0.0.1:$PORT/cc-improved.git" 2>&1 | short | tail -n 2
claude plugin install cc-improved@cc-improved 2>&1 | short | tail -n 2
claude plugin list 2>&1 | short

say "3. what was installed"
ROOT=$(ls -d "$CLAUDE_CONFIG_DIR"/plugins/cache/cc-improved/cc-improved/*/ | head -n 1)
echo "  root: ${ROOT#$WORK/}"
echo "  top level: $(ls -A "$ROOT" | tr '\n' ' ')"
echo "  version: $(node -p "require('${ROOT}.claude-plugin/plugin.json').version")"
echo "  node_modules/typescript present (devDependencies are installed): $([ -d "${ROOT}node_modules/typescript" ] && echo yes || echo no)"
claude plugin validate "$ROOT" 2>&1 | short | tail -n 3

say "4. hooks smoke test with the installed copy (no model)"
REPO="$WORK/repo-smoke"; mkdir -p "$REPO"; git -C "$REPO" init -q
echo '{"hook_event_name":"SessionStart","session_id":"smoke","cwd":"'"$REPO"'","source":"startup"}' |
  CLAUDE_PLUGIN_ROOT="$ROOT" CLAUDE_PLUGIN_DATA="$WORK/smoke-data" node --experimental-strip-types "$ROOT/bin/wf-hook.mjs" 2>&1 | short | head -c 600
echo

if [ -z "${CC_CREDENTIALS:-}" ]; then say "no CC_CREDENTIALS: model steps skipped"; exit 0; fi

say "5. model session with the installed plugin ($MODEL)"
(cd "$REPO" && timeout 180 claude -p --model "$MODEL" --max-budget-usd 0.10 --output-format json \
  --permission-mode acceptEdits --settings '{"permissions":{"allow":["Bash(node *)"]}}' \
  '/cc-improved:wf-doctor' >"$WORK/evidence/doctor.json" 2>&1 || true)
node -e "const r=JSON.parse(require('fs').readFileSync('$WORK/evidence/doctor.json','utf8').trim().split('\n').pop());console.log('  cost',r.total_cost_usd,'\n'+String(r.result).slice(0,1500))" 2>&1 | short || true

say "6. e2e flow against the installed plugin (cap \$${E2E_BUDGET:-0.45})"
# A copy of test/e2e/run.mjs with: no --plugin-dir, the installed plugin key, user settings enabled (the install is
# user-scope) and the plugin data dir of the isolated config. Nothing else changes.
sed -e '/"--plugin-dir", PLUGIN_ROOT,/d' \
    -e 's/"--setting-sources", "project"/"--setting-sources", "user,project"/' \
    -e 's/cc-improved@inline/cc-improved@cc-improved/' \
    -e 's|path.join(os.homedir(), ".claude/plugins/data/cc-improved-inline")|path.join(process.env.CLAUDE_CONFIG_DIR, "plugins/data/cc-improved-cc-improved")|' \
    "$SRC/test/e2e/run.mjs" >"$WORK/tools/run-installed.mjs"
grep -c 'plugin-dir' "$WORK/tools/run-installed.mjs" | sed 's/^/  remaining --plugin-dir lines (comments only): /' || true
E2E_WORK="$WORK/e2e" E2E_BUDGET="${E2E_BUDGET:-0.45}" E2E_MODEL="$MODEL" E2E_STRONG=sonnet \
  node "$WORK/tools/run-installed.mjs" 2>&1 | short | tail -n 40
