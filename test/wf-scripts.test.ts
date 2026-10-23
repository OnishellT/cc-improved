// bin/wf-related.mjs and bin/wf-done.mjs run as /task and /done run them: a child node process, the project in
// CLAUDE_PROJECT_DIR, plain text on stdout, exit 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { appendRecord, buildRecord, readRecords, RETRO_EVERY } from "../lib/learn.ts";
import { taskPath } from "../lib/paths.ts";
import type { Task } from "../lib/types.ts";

const bin = (name: string) => fileURLToPath(new URL(`../bin/${name}`, import.meta.url));

function run(script: string, root: string, args: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
    execFile(process.execPath, ["--experimental-strip-types", bin(script), ...args], { env, cwd: root }, (error, stdout, stderr) =>
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

function git(root: string, ...args: string[]): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], (e) => (e ? reject(e) : resolve())),
  );
}

const project = () => mkdtemp(path.join(tmpdir(), "wf-scripts-"));

const task = (over: Partial<Task> = {}): Task => ({
  id: "t1",
  title: "Refund partial payments",
  ticket: "PAY-9",
  status: "implementing",
  allowedExtra: [],
  startedAt: "2026-10-20T10:00:00Z",
  plan: {
    title: "Refund partial payments",
    ticket: "PAY-9",
    spec: [],
    files: ["src/"],
    interface: [{ file: "src/refund.ts", exports: ["refund"] }],
    seams: [{ name: "refund", testFile: "src/refund.test.ts", catches: "partial refunds" }],
    decisions: [{ question: "Round how?", options: ["half-even"], answer: "half-even", source: "docs/adr/0001-rounding.md" }],
  },
  ...over,
});

async function writeTask(root: string, value: unknown) {
  await mkdir(path.dirname(taskPath(root)), { recursive: true });
  await writeFile(taskPath(root), JSON.stringify(value));
}

const past = (id: string, title: string): Task => ({ ...task({ id, title, ticket: id, status: "done", completedAt: "2026-10-01T00:00:00Z" }) });

test("wf-related prints the related past tasks as a bullet list", async () => {
  const root = await project();
  await appendRecord(root, buildRecord(past("PAY-1", "Refund card payments"), ["src/refund.ts"]));
  await appendRecord(root, buildRecord(past("UI-2", "Login button colour"), []));
  const { code, stdout } = await run("wf-related.mjs", root, ["PAY-9", "refund", "payments"]);
  assert.equal(code, 0);
  assert.match(stdout, /^- \[PAY-1\] Refund card payments \(2026-10-01\)/);
  assert.doesNotMatch(stdout, /UI-2/);
});

test("wf-related says so when nothing is related, with no history, or with odd arguments", async () => {
  const root = await project();
  assert.equal((await run("wf-related.mjs", root, ["refund"])).stdout, "No related past tasks.\n");
  assert.equal((await run("wf-related.mjs", root)).stdout, "No related past tasks.\n");
  await appendRecord(root, buildRecord(past("PAY-1", "Refund card payments"), []));
  const odd = await run("wf-related.mjs", root, ["añadir sub(a,b) a \"pagos\"; it's $HOME"]);
  assert.equal(odd.code, 0);
  assert.equal(odd.stdout, "No related past tasks.\n");
});

test("wf-done closes an implementing task: record in tasks.jsonl, task.json done, sessionId kept", async () => {
  const root = await project();
  await git(root, "init", "-q");
  // src/ is tracked, so `git status` lists the new file itself rather than an untracked directory.
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/index.ts"), "x\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "init");
  await writeFile(path.join(root, "src/refund.ts"), "export const refund = 1;\n");
  await writeFile(path.join(root, "notes.txt"), "outside the plan\n");
  await writeTask(root, { ...task(), sessionId: "s-1" });

  const { code, stdout } = await run("wf-done.mjs", root);
  assert.equal(code, 0);
  assert.match(stdout, /^CLOSED: \[PAY-9\] Refund partial payments \(t1\)\./);
  assert.match(stdout, /\(1 task recorded\)/);
  assert.match(stdout, /Files: src\/refund\.ts\./);
  assert.doesNotMatch(stdout, /RETRO DUE/);

  const records = await readRecords(root);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0]?.files, ["src/refund.ts"]);
  assert.equal(records[0]?.decisions[0]?.answer, "half-even");
  const stored = JSON.parse(await readFile(taskPath(root), "utf8"));
  assert.equal(stored.status, "done");
  assert.equal(stored.sessionId, "s-1");
  assert.ok(!Number.isNaN(Date.parse(stored.completedAt)));

  const again = await run("wf-done.mjs", root);
  assert.match(again.stdout, /^NOT CLOSED: the task "Refund partial payments" was already closed/);
  assert.equal((await readRecords(root)).length, 1);
});

test("wf-done announces the retro every RETRO_EVERY tasks and never records a task twice", async () => {
  const root = await project();
  for (let i = 1; i < RETRO_EVERY; i++) await appendRecord(root, buildRecord(past(`P-${i}`, `Task ${i}`), []));
  await writeTask(root, task());
  const { stdout } = await run("wf-done.mjs", root);
  assert.match(stdout, new RegExp(`\\(${RETRO_EVERY} tasks recorded\\)`));
  assert.match(stdout, new RegExp(`^RETRO DUE: ${RETRO_EVERY} tasks recorded`, "m"));

  // A previous run wrote the record but not task.json: closing again keeps one record.
  await writeTask(root, task());
  await run("wf-done.mjs", root);
  assert.equal((await readRecords(root)).filter((r) => r.id === "t1").length, 1);
});

test("wf-done refuses what it cannot close and says why", async () => {
  const root = await project();
  assert.match((await run("wf-done.mjs", root)).stdout, /^NOT CLOSED: there is no active task\. Start one with \/task\./);

  await writeTask(root, task({ status: "planning" }));
  const planning = await run("wf-done.mjs", root);
  assert.equal(planning.code, 0);
  assert.match(planning.stdout, /^NOT CLOSED: .* is still planning/);
  assert.equal((await readRecords(root)).length, 0);

  await mkdir(path.dirname(taskPath(root)), { recursive: true });
  await writeFile(taskPath(root), "{ not json");
  assert.match((await run("wf-done.mjs", root)).stdout, /^NOT CLOSED: \.claude\/workflow\/task\.json is unreadable/);
});

// ---------------------------------------------------------------------------
// wf-plan-validate: the fast route applies the ExitPlanMode gates
// ---------------------------------------------------------------------------

const wfPlan = (over: Record<string, unknown> = {}) => ({
  title: "Add sub to math",
  spec: ["docs/spec.md"],
  files: ["src/math.js", "src/math.test.js"],
  interface: [{ file: "src/math.js", exports: ["sub"], source: "docs/spec.md" }],
  seams: [{ name: "sub subtracts", testFile: "src/math.test.js", catches: "wrong sign" }],
  decisions: [],
  ...over,
});
const planMd = (plan: unknown) => `# Plan\n\n\`\`\`wf-plan\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n`;

async function fastProject(manifest: Record<string, unknown> = {}) {
  const root = await project();
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, ".claude/workflow"), { recursive: true });
  await writeFile(path.join(root, "docs/spec.md"), "Add `sub(a, b)` to the math module.\n");
  await writeFile(path.join(root, "src/math.js"), "export const add = (a, b) => a + b;\n");
  await writeFile(path.join(root, ".claude/workflow.json"), JSON.stringify({ version: 1, setup: "done", verify: [], connectors: [], ...manifest }));
  return root;
}
const validate = async (root: string, plan: unknown, extra: string[] = []) => {
  await writeFile(path.join(root, ".claude/workflow/plan.md"), typeof plan === "string" ? plan : planMd(plan));
  return run("wf-plan-validate.mjs", root, [".claude/workflow/plan.md", ...extra]);
};

test("wf-plan-validate accepts a small valid plan and stores task.json as implementing", async () => {
  const root = await fastProject();
  const { code, stdout } = await validate(root, wfPlan(), ["--session", "s-1"]);
  assert.equal(code, 0);
  assert.match(stdout, /^ACCEPTED: "Add sub to math"/);
  const stored = JSON.parse(await readFile(taskPath(root), "utf8"));
  assert.equal(stored.status, "implementing");
  assert.equal(stored.sessionId, "s-1");
  assert.deepEqual(stored.plan.interface[0].exports, ["sub"]);
  assert.match(stored.planFilePath, /plan\.md$/);
});

test("wf-plan-validate keeps a valid session id but drops a literal or empty one, and the gates still run on the task", async () => {
  const { dispatch } = await import("../lib/hooks/dispatch.ts");
  for (const bad of ["${CLAUDE_SESSION_ID}", "$CLAUDE_SESSION_ID", ""]) {
    const root = await fastProject();
    const { code, stdout, stderr } = await validate(root, wfPlan(), ["--session", bad]);
    assert.equal(code, 0);
    assert.match(stdout, /^ACCEPTED/);
    assert.match(stderr, /not a session id/);
    const stored = JSON.parse(await readFile(taskPath(root), "utf8"));
    assert.ok(!("sessionId" in stored), `no sessionId for ${JSON.stringify(bad)}`);
    // The dispatcher treats the task as any session's: the Stop gate runs and blocks on the missing contract.
    const env = { CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_DATA: path.join(root, "data") };
    const stop = { session_id: "real-session", transcript_path: "/x", cwd: root, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "done", background_tasks: [] };
    const out = JSON.parse((await dispatch(JSON.stringify(stop), { env })) || "{}");
    assert.equal(out.decision, "block", "gate ran");
    assert.match(out.reason, /missing sub|does not exist/);
  }
  const root = await fastProject();
  await validate(root, wfPlan(), ["--session", "abc-123_X"]);
  assert.equal(JSON.parse(await readFile(taskPath(root), "utf8")).sessionId, "abc-123_X");
});

test("wf-plan-validate rejects an invented name, the same gate as ExitPlanMode, and saves nothing", async () => {
  const root = await fastProject();
  const { code, stdout } = await validate(root, wfPlan({ interface: [{ file: "src/math.js", exports: ["sub", "powerOfTwo"], source: "docs/spec.md" }] }));
  assert.equal(code, 0);
  assert.match(stdout, /^REJECTED/);
  assert.match(stdout, /src\/math\.js: powerOfTwo/);
  await assert.rejects(readFile(taskPath(root), "utf8"));
});

test("wf-plan-validate rejects a seam test file outside files, a missing spec and a bad block", async () => {
  const root = await fastProject();
  const seam = await validate(root, wfPlan({ files: ["src/math.js"] }));
  assert.match(seam.stdout, /testFile src\/math\.test\.js is not in files/);
  const spec = await validate(root, wfPlan({ spec: ["docs/nope.md"] }));
  assert.match(spec.stdout, /spec docs\/nope\.md does not exist/);
  const bad = await validate(root, "# Plan without a block\n");
  assert.match(bad.stdout, /^REJECTED[\s\S]*No ```wf-plan block/);
});

test("wf-plan-validate sends big or risky plans to plan mode", async () => {
  const root = await fastProject();
  const files = ["src/math.js", "src/math.test.js", "a.js", "b.js", "c.js", "d.js", "e.js", "f.js", "g.js"];
  assert.match((await validate(root, wfPlan({ files }))).stdout, /^REJECTED: this task is not small \(9 files\)[\s\S]*plan mode/);
  const risky = await validate(root, wfPlan({ files: ["src/math.js", "src/math.test.js", "package.json"] }));
  assert.match(risky.stdout, /^REJECTED: this task is not small \(dependencias/);
  assert.match((await validate(await fastProject({ review: { always: true } }), wfPlan())).stdout, /review\.always/);
  await assert.rejects(readFile(taskPath(root), "utf8"));
});

test("wf-plan-validate accepts up to 8 files on the fast route (D-012) and review.planFiles tightens it", async () => {
  const files = ["src/math.js", "src/math.test.js", "a.js", "b.js", "c.js", "d.js", "e.js", "f.js"];
  assert.match((await validate(await fastProject(), wfPlan({ files }))).stdout, /^ACCEPTED/);
  assert.match((await validate(await fastProject({ review: { planFiles: 3 } }), wfPlan({ files }))).stdout, /^REJECTED: this task is not small \(8 files\)/);
});

test("wf-plan-validate refuses without a manifest and reports an unreadable file", async () => {
  const root = await project();
  assert.match((await run("wf-plan-validate.mjs", root, ["x.md"])).stdout, /^REJECTED: .*\/setup/);
  const withManifest = await fastProject();
  assert.match((await run("wf-plan-validate.mjs", withManifest, ["missing.md"])).stdout, /^REJECTED: cannot read missing\.md/);
  assert.match((await run("wf-plan-validate.mjs", withManifest)).stdout, /^REJECTED: pass the plan file/);
});

test("wf-plan-validate reads the ticket text captured for the session, like the hook", async () => {
  const root = await fastProject();
  const data = path.join(root, "data");
  const plan = wfPlan({ ticket: "PAY-1", spec: [], interface: [{ file: "src/math.js", exports: ["sub"], source: "PAY-1" }] });
  assert.match((await validate(root, plan, ["--session", "s-1", "--data", data])).stdout, /^REJECTED[\s\S]*src\/math\.js: sub/);
  await mkdir(path.join(data, "evidence"), { recursive: true });
  await writeFile(path.join(data, "evidence", "s-1.txt"), "PAY-1: add sub(a, b) to math");
  assert.match((await validate(root, plan, ["--session", "s-1", "--data", data])).stdout, /^ACCEPTED/);
});

test("wf-plan-validate stores baseCommit (HEAD) in a git repo and omits it without git", async () => {
  const root = await fastProject();
  assert.equal(JSON.parse(await readFile(taskPath(root), "utf8").catch(() => "{}")).baseCommit, undefined);
  assert.match((await validate(root, wfPlan())).stdout, /^ACCEPTED/);
  assert.equal(JSON.parse(await readFile(taskPath(root), "utf8")).baseCommit, undefined, "no git: no base, behavior unchanged");

  const repoRoot = await fastProject();
  await git(repoRoot, "init", "-q");
  await git(repoRoot, "add", "-A");
  await git(repoRoot, "commit", "-qm", "init");
  const head = (await promisify(execFile)("git", ["-C", repoRoot, "rev-parse", "HEAD"])).stdout.trim();
  assert.match((await validate(repoRoot, wfPlan())).stdout, /^ACCEPTED/);
  assert.equal(JSON.parse(await readFile(taskPath(repoRoot), "utf8")).baseCommit, head);
});

test("wf-done measures the task's files from its baseCommit, so committed work is recorded", async () => {
  const root = await project();
  await git(root, "init", "-q");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/index.ts"), "x\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "init");
  const baseCommit = (await promisify(execFile)("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  await writeFile(path.join(root, "src/refund.ts"), "export const refund = 1;\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "implementer");
  await writeTask(root, task({ baseCommit }));
  assert.match((await run("wf-done.mjs", root)).stdout, /Files: src\/refund\.ts\./);
});
