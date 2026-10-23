#!/usr/bin/env bash
# Spike 0.6: does Claude Code install a plugin's npm dependencies (package.json +
# package-lock.json) when the plugin is installed from a marketplace, and does a
# hook that imports one of them run?
#
# Usage: docs/spikes/0.6-plugin-deps.sh <empty work dir>
#
# Everything lives under <work dir>: an isolated CLAUDE_CONFIG_DIR (no real
# config, no credentials), the lab marketplaces, a local git server and the
# evidence. Needs: claude, node >= 22, npm, git, and network once to resolve the
# lockfiles of the lab dependencies (picocolors, kleur: tiny, zero deps). It
# never touches the cc-improved package.json.
#
# Sessions are started with `claude -p` in the isolated config. With no
# credentials the model call fails ("Not logged in") at no cost, but the
# SessionStart hook has already fired with the real CLAUDE_PLUGIN_ROOT, which is
# what this spike looks at.
#
# Scenarios:
#   A. marketplace = local folder (`marketplace add <dir>`)
#   B. marketplace = git repo (served by a local smart-HTTP server, like GitHub)
#      B1 install, B2 session, B3 update to a new version, B4 node_modules removed
#   C. `--plugin-dir <dir>` (no marketplace)
#   D. git marketplace whose plugin is the repo root (source "./", like cc-improved)
set -euo pipefail

WORK=${1:?usage: $0 <empty work dir>}
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd)
export CLAUDE_CONFIG_DIR="$WORK/config"
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_AUTH_TOKEN || true
EVIDENCE="$WORK/evidence"
PORT=${PORT:-8766}
mkdir -p "$CLAUDE_CONFIG_DIR" "$EVIDENCE" "$WORK/tools" "$WORK/srv" "$WORK/session"
touch "$EVIDENCE/hook.jsonl"
GITC=(-c user.name=spike -c user.email=spike@example.invalid -c init.defaultBranch=main)

say() { printf '\n=== %s\n' "$*"; }
short() { sed "s|$WORK|<work>|g"; }

# picocolors versions under every node_modules of the isolated config.
show_deps() {
  find "$CLAUDE_CONFIG_DIR" \( -path '*node_modules/picocolors/package.json' -o -path '*node_modules/kleur/package.json' \) 2>/dev/null | sort |
    while read -r f; do echo "  $(node -p "const p=require('$f');p.name+'@'+p.version")  $f"; done | short
  [ -n "$(find "$CLAUDE_CONFIG_DIR" -type d -name node_modules 2>/dev/null)" ] || echo "  (no node_modules under the config dir)"
}

# Starts a session (SessionStart fires), prints the hook record it produced.
session() { # $@ = extra claude args
  local before after
  before=$(wc -l <"$EVIDENCE/hook.jsonl" 2>/dev/null || echo 0)
  (cd "$WORK/session" && timeout 90 claude -p --model haiku --output-format json "$@" 'say ok' >"$EVIDENCE/session-last.json" 2>&1 || true)
  echo "  session result: $(node -p "try{const r=JSON.parse(require('fs').readFileSync('$EVIDENCE/session-last.json','utf8').trim().split('\n').pop());r.result+' (cost '+r.total_cost_usd+')'}catch{'unparsed'}")"
  after=$(wc -l <"$EVIDENCE/hook.jsonl" 2>/dev/null || echo 0)
  if [ "$after" -gt "$before" ]; then tail -n $((after - before)) "$EVIDENCE/hook.jsonl" | short | sed 's/^/  hook: /'; else echo "  hook: (no SessionStart record)"; fi
}

# Writes the lab plugin into $1. package.json asks "^1.0.0" for picocolors but
# the lockfile pins $3: plain `npm install` would pick the newest 1.x, so
# finding $3 installed proves the lockfile was honoured. kleur is a devDependency.
write_plugin() { # $1 = dir, $2 = plugin version, $3 = picocolors version pinned in the lockfile
  local dir=$1 npmq=(--package-lock-only --ignore-scripts --no-audit --no-fund)
  mkdir -p "$dir/.claude-plugin" "$dir/hooks"
  cat >"$dir/.claude-plugin/plugin.json" <<EOF
{ "name": "deplab", "version": "$2", "description": "Spike 0.6 lab plugin: one npm dependency used by a hook.", "author": { "name": "spike" } }
EOF
  cat >"$dir/hooks/hooks.json" <<'EOF'
{ "hooks": { "SessionStart": [ { "hooks": [
  { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hook.mjs\" session-start", "timeout": 10 } ] } ] } }
EOF
  # The hook records whether `import 'picocolors'` resolves, and from where.
  cat >"$dir/hook.mjs" <<EOF
import { appendFileSync } from 'node:fs';
const rec = { via: process.argv[2], root: process.env.CLAUDE_PLUGIN_ROOT ?? null, data: process.env.CLAUDE_PLUGIN_DATA ?? null };
try {
  const pc = (await import('picocolors')).default;
  rec.ok = true; rec.resolved = import.meta.resolve('picocolors'); void pc.green('x');
} catch (e) { rec.ok = false; rec.error = String(e.code ?? e.message); }
appendFileSync('$EVIDENCE/hook.jsonl', JSON.stringify(rec) + '\n');
EOF
  (cd "$dir" && rm -rf package-lock.json package.json node_modules \
    && printf '{ "name": "deplab", "version": "%s", "private": true, "type": "module" }\n' "$2" >package.json \
    && npm install "${npmq[@]}" "picocolors@$3" >/dev/null \
    && npm install "${npmq[@]}" -D kleur@4.1.5 >/dev/null \
    && node -e 'const fs=require("fs"),p=JSON.parse(fs.readFileSync("package.json"));p.dependencies.picocolors="^1.0.0";fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")' \
    && npm install "${npmq[@]}" >/dev/null)
  echo "  $2: lockfile pins picocolors@$(node -p "require('$dir/package-lock.json').packages['node_modules/picocolors'].version"), package.json asks ^1.0.0; devDependency kleur@4.1.5"
}

write_market() { # $1 = dir, $2 = marketplace name
  mkdir -p "$1/.claude-plugin"
  cat >"$1/.claude-plugin/marketplace.json" <<EOF
{ "name": "$2", "owner": { "name": "spike" }, "description": "Spike 0.6 lab marketplace.",
  "plugins": [ { "name": "deplab", "source": "./plugins/deplab", "description": "Spike 0.6 lab plugin." } ] }
EOF
}

# Minimal smart-HTTP git server (git http-backend as CGI), so the marketplace
# can be added by URL like a GitHub one, without network.
cat >"$WORK/tools/git-http.mjs" <<'EOF'
import http from 'node:http'; import { spawn } from 'node:child_process';
const [root, port] = process.argv.slice(2);
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const env = { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: u.pathname,
    QUERY_STRING: u.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] ?? '',
    GIT_PROTOCOL: req.headers['git-protocol'] ?? '', HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '' };
  const p = spawn('git', ['http-backend'], { env }); req.pipe(p.stdin);
  let buf = Buffer.alloc(0), head = false;
  p.stdout.on('data', d => {
    if (head) return res.write(d);
    buf = Buffer.concat([buf, d]); const i = buf.indexOf('\r\n\r\n'); if (i < 0) return;
    head = true; let status = 200;
    for (const l of buf.subarray(0, i).toString().split('\r\n')) {
      const [k, ...v] = l.split(':'); const val = v.join(':').trim();
      if (k.toLowerCase() === 'status') status = parseInt(val); else res.setHeader(k, val);
    }
    res.writeHead(status); res.write(buf.subarray(i + 4));
  });
  p.on('close', () => res.end());
}).listen(+port, '127.0.0.1');
EOF

say "A. marketplace = local folder"
write_market "$WORK/folder-market" deplab-folder
write_plugin "$WORK/folder-market/plugins/deplab" 0.1.0 1.1.0
claude plugin validate "$WORK/folder-market" | tail -n 1
claude plugin marketplace add "$WORK/folder-market" | tail -n 1
claude plugin install deplab@deplab-folder | tail -n 1
claude plugin list | short | grep -A4 'deplab@deplab-folder'
echo "  source folder has node_modules? $(test -d "$WORK/folder-market/plugins/deplab/node_modules" && echo yes || echo no)"
echo "  deps after install:"; show_deps
echo "  A2 session:"; session
claude plugin disable deplab@deplab-folder | tail -n 1

say "B. marketplace = git repo over HTTP"
write_market "$WORK/git-market" deplab-git
write_plugin "$WORK/git-market/plugins/deplab" 0.1.0 1.1.0
git "${GITC[@]}" -C "$WORK/git-market" init -q && git -C "$WORK/git-market" add -A && git "${GITC[@]}" -C "$WORK/git-market" commit -qm v0.1.0
git clone -q --bare "$WORK/git-market" "$WORK/srv/git-market.git"
node "$WORK/tools/git-http.mjs" "$WORK/srv" "$PORT" & SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
sleep 1
echo "  B1 install:"
claude plugin marketplace add "http://127.0.0.1:$PORT/git-market.git" | tail -n 1
claude plugin install deplab@deplab-git | tail -n 1
claude plugin list | short | grep -A4 'deplab@deplab-git'
echo "  deps after install:"; show_deps
echo "  B2 session:"; session
echo "  B3 update to 0.2.0 (lockfile now pins picocolors 1.0.1):"
write_plugin "$WORK/git-market/plugins/deplab" 0.2.0 1.0.1
git -C "$WORK/git-market" add -A && git "${GITC[@]}" -C "$WORK/git-market" commit -qm v0.2.0
git -C "$WORK/git-market" push -q "$WORK/srv/git-market.git" HEAD:main
claude plugin marketplace update deplab-git | tail -n 1
claude plugin update deplab@deplab-git | tail -n 1
echo "  deps after update:"; show_deps
session
echo "  B4 node_modules removed from the installed root, then a session:"
ROOT=$(node -p "require('$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json').plugins['deplab@deplab-git'][0].installPath")
rm -rf "$ROOT/node_modules"
session
echo "  node_modules back after the session? $(test -d "$ROOT/node_modules" && echo yes || echo no)"
claude plugin disable deplab@deplab-git | tail -n 1

say "C. --plugin-dir on a source folder"
write_plugin "$WORK/plugin-dir/deplab" 0.1.0 1.1.0
session --plugin-dir "$WORK/plugin-dir/deplab"
echo "  source folder has node_modules after the session? $(test -d "$WORK/plugin-dir/deplab/node_modules" && echo yes || echo no)"

say "D. git marketplace whose plugin is the repo root (source \"./\", the cc-improved layout)"
write_plugin "$WORK/root-market" 0.1.0 1.1.0
cat >"$WORK/root-market/.claude-plugin/marketplace.json" <<'EOF'
{ "name": "deplab-root", "owner": { "name": "spike" }, "description": "Spike 0.6 lab marketplace.",
  "plugins": [ { "name": "deplab", "source": "./", "description": "Spike 0.6 lab plugin." } ] }
EOF
git "${GITC[@]}" -C "$WORK/root-market" init -q && git -C "$WORK/root-market" add -A && git "${GITC[@]}" -C "$WORK/root-market" commit -qm v0.1.0
git clone -q --bare "$WORK/root-market" "$WORK/srv/root-market.git"
claude plugin marketplace add "http://127.0.0.1:$PORT/root-market.git" | tail -n 1
claude plugin install deplab@deplab-root | tail -n 1
echo "  installed root: $(ls -A "$CLAUDE_CONFIG_DIR/plugins/cache/deplab-root/deplab/0.1.0" | tr '\n' ' ')"
session

say "data dirs (CLAUDE_PLUGIN_DATA) created:"
find "$CLAUDE_CONFIG_DIR/plugins/data" -mindepth 1 -maxdepth 1 2>/dev/null | short
echo "  any node_modules under plugins/data? $(find "$CLAUDE_CONFIG_DIR/plugins/data" -name node_modules 2>/dev/null | grep -q . && echo yes || echo no)"
say "installed versions kept in the cache:"
find "$CLAUDE_CONFIG_DIR/plugins/cache" -mindepth 3 -maxdepth 3 -type d | sort | short
