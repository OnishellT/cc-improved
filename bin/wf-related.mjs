#!/usr/bin/env node
// /task injection: past tasks related to the request, as plain text for the model. Logic lives in lib/learn.ts.
// Run as: node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/bin/wf-related.mjs "<request>"  (from skills/task)
// Always exits 0: a failure must not keep /task from loading, so it prints a line saying the lookup is unavailable.

const NONE = "No related past tasks.";

let out;
try {
  const { projectDir } = await import("../lib/paths.ts");
  const { relatedTasksText } = await import("../lib/learn.ts");
  const query = process.argv.slice(2).join(" ");
  out = (await relatedTasksText(projectDir(), query)) || NONE;
} catch (err) {
  out = `Related past tasks unavailable (${err instanceof Error ? err.message : String(err)}).`;
}
await new Promise((resolve) => process.stdout.write(`${out}\n`, resolve));
