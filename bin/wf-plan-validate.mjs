#!/usr/bin/env node
// /task fast route: validates the ```wf-plan block of a small task without plan mode and, when it passes, stores
// task.json as `implementing`. The checks are the ExitPlanMode hook's (lib/plan-gate.ts); this file only reads and writes.
// Run as: node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/bin/wf-plan-validate.mjs <plan file> [--session <id>] [--data <dir>]
// Prints plain text for the model (ACCEPTED or REJECTED, with one line per problem) and always exits 0.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";

async function validate(args) {
  const { projectDir, taskPath, TASK_PATH } = await import("../lib/paths.ts");
  const { checkPlan, gateActive, planCheckLevel } = await import("../lib/plan-gate.ts");
  const { readMcpText } = await import("../lib/evidence.ts");
  const { highRiskReasons } = await import("../lib/risk.ts");

  const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const session = opt("--session");
  const env = { ...process.env, ...(opt("--data") ? { CLAUDE_PLUGIN_DATA: opt("--data") } : {}) };
  const file = args.find((a, i) => !a.startsWith("--") && !["--session", "--data"].includes(args[i - 1]));
  if (!file) return "REJECTED: pass the plan file: wf-plan-validate.mjs <file>.";

  const root = projectDir();
  const manifest = await gateActive(root);
  if (!manifest) return "REJECTED: this project has no workflow manifest (or setup was declined). Run /setup first.";
  let markdown;
  try {
    markdown = await readFile(path.resolve(root, file), "utf8");
  } catch {
    return `REJECTED: cannot read ${file}. Write the plan there first.`;
  }
  let current;
  try {
    current = JSON.parse(await readFile(taskPath(root), "utf8"));
  } catch {}
  let mcp = "";
  try {
    if (session) mcp = await readMcpText(session, env);
  } catch {}

  const checked = await checkPlan(root, markdown, current, path.resolve(root, file), mcp);
  if ("errors" in checked) {
    return ["REJECTED: fix these problems in the plan file and run the script again (the plan was not saved).", ...checked.errors.map((e) => `- ${e}`)].join("\n");
  }
  const { plan, task } = checked;
  const big = planCheckLevel(plan, manifest.review);
  if (big) {
    const why = manifest.review?.always ? ["review.always"] : highRiskReasons(plan.files, manifest.review);
    return `REJECTED: this task is not small${why.length ? ` (${why.join("; ")})` : " (too many files, interface entries or decisions)"}. Use plan mode: call EnterPlanMode and follow the full route.`;
  }

  const next = { ...task, status: "implementing", ...(session ? { sessionId: session } : {}) };
  const out = taskPath(root);
  await mkdir(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await rename(tmp, out);
  const decided = plan.decisions.filter((d) => d.answer).map((d) => `- ${d.question} -> ${d.answer} (${d.source})`);
  return [`ACCEPTED: "${plan.title}" is saved in ${TASK_PATH} as implementing. Launch the implementer now.`, ...(decided.length ? ["Decisions already made by the user:", ...decided] : [])].join("\n");
}

let out;
try {
  out = await validate(process.argv.slice(2));
} catch (err) {
  out = `REJECTED: the validator failed (${err instanceof Error ? err.message : String(err)}). Use plan mode instead.`;
}
await new Promise((resolve) => process.stdout.write(`${out}\n`, resolve));
