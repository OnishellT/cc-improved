#!/bin/sh
# Checks the optional mod apart from the repo's own gates: `npm test` and `npm run typecheck` cover mod/status.ts,
# but not the engine half (mod/register.tsx, mod/register.test.tsx), which needs the engine's types and test kit.
#
#   sh mod/check.sh                 # tests under `claude plugin test`, and tsc if the engine types are found
#   CC_TYPES=/path/claude-code.d.ts sh mod/check.sh
#
# `claude plugin test .` at the repo root would also try test/*.test.ts (node:test, not loadable by the engine),
# so the mod is copied to a temporary plugin folder with only what it imports.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/.claude-plugin" "$work/hooks" "$work/lib"
cp "$repo/.claude-plugin/plugin.json" "$work/.claude-plugin/"
printf '{ "modules": ["../mod/register.tsx"] }\n' > "$work/hooks/hooks.json"
cp -R "$repo/mod" "$work/mod"
cp "$repo/lib/types.ts" "$work/lib/"

claude plugin validate "$work"
claude plugin test "$work"

# Engine types: CC_TYPES, else the copy the engine lays beside a loaded --plugin-dir, else none.
types=${CC_TYPES:-}
if [ -z "$types" ] && [ -f "$repo/.claude-plugin/types/claude-code/index.d.ts" ]; then
  types="$repo/.claude-plugin/types/claude-code/index.d.ts"
fi
if [ -z "$types" ]; then
  echo "mod/check.sh: engine types not found; set CC_TYPES to claude-code.d.ts (see mod/README.md). tsc skipped." >&2
  exit 0
fi
cat > "$work/tsconfig.json" <<EOF
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [],
    "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true,
    "allowImportingTsExtensions": true, "noEmit": true, "skipLibCheck": true,
    "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment"
  },
  "files": ["$types", "mod/register.tsx", "mod/register.test.tsx", "mod/status.ts"]
}
EOF
"$repo/node_modules/.bin/tsc" -p "$work/tsconfig.json"
echo "mod/check.sh: validate, plugin test and tsc passed."
