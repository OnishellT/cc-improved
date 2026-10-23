#!/usr/bin/env node
// Single entry for every hook of the plugin: stdin JSON → lib/hooks/dispatch.ts → stdout JSON, always exit 0.
// Run as: node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/bin/wf-hook.mjs" (the flag is a no-op on Node >= 22.18).

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

let out = "";
try {
  const { dispatch } = await import("../lib/hooks/dispatch.ts");
  out = await dispatch(await readStdin());
} catch (err) {
  // dispatch never throws; this is only reached when the module itself cannot load. stderr with exit 0 is not
  // shown to the model, so the hook is skipped in silence.
  process.stderr.write(`wf-hook: ${err instanceof Error ? err.message : String(err)}\n`);
}
if (out) await new Promise((resolve) => process.stdout.write(`${out}\n`, resolve));
// Exit now: a handler cut off by its budget may still hold timers or child processes.
process.exit(0);
