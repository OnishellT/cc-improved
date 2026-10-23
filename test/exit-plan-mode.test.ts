import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { dispatch, type HookContext } from "../lib/hooks/dispatch.ts";
import mod, { readPlanCheckVerdict, recordPlanCheckVerdict } from "../lib/hooks/exit-plan-mode.ts";
import { captureMcpText } from "../lib/evidence.ts";
import { sessionStatePath, taskPath } from "../lib/paths.ts";
import type { Manifest, Plan, SubagentStopInput, Task } from "../lib/types.ts";

const fixture = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/hooks/${name}.json`, import.meta.url), "utf8"));
const SESSION = "e7119218-ed8d-4fd7-85e4-a2bb49b7547a";

const goodPlan = (over: Partial<Plan> = {}): Plan => ({
  title: "Add sub to a.js",
  spec: ["docs/spec.md"],
  files: ["a.js", "test/a.test.js"],
  interface: [{ file: "a.js", exports: ["sub"], source: "docs/spec.md" }],
  seams: [{ name: "sub subtracts", testFile: "test/a.test.js", catches: "wrong sign" }],
  decisions: [{ question: "Export style?", options: ["named", "default"], answer: "named", source: "docs/spec.md" }],
  ...over,
});
const markdown = (plan: unknown) => `# Plan\n\nSome prose.\n\n\`\`\`wf-plan\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n`;

/** A project with a manifest, a.js and a spec that names `sub`, plus a plugin data dir. */
async function project(manifest: Partial<Manifest> | null = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "exit-plan-"));
  const env = { CLAUDE_PROJECT_DIR: path.join(dir, "project"), CLAUDE_PLUGIN_DATA: path.join(dir, "data") };
  const root = env.CLAUDE_PROJECT_DIR;
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(path.join(root, ".claude"), { recursive: true });
  await writeFile(path.join(root, "a.js"), "export function add(a,b){return a+b}\n");
  await writeFile(path.join(root, "docs/spec.md"), "Add `sub(a, b)` next to add. Use named exports.\n");
  if (manifest) await writeFile(path.join(root, ".claude/workflow.json"), JSON.stringify({ version: 1, setup: "done", verify: [], connectors: [], ...manifest }));
  return { env, root };
}

async function pre(env: Record<string, string>, plan: unknown, over: Record<string, unknown> = {}) {
  const raw = await fixture("pre-tool-use.exit-plan-mode");
  raw.tool_input.plan = typeof plan === "string" ? plan : markdown(plan);
  const out = await dispatch(JSON.stringify({ ...raw, ...over }), { env });
  return out ? JSON.parse(out) : undefined;
}
const reasonOf = (out: any): string => out?.hookSpecificOutput?.permissionDecisionReason ?? "";
const readTask = async (root: string) => JSON.parse(await readFile(taskPath(root), "utf8")) as Task & { sessionId?: string };
const planChecks = async (env: Record<string, string>) =>
  (JSON.parse(await readFile(sessionStatePath(SESSION, env), "utf8").catch(() => "{}")) as { planChecks?: number }).planChecks ?? 0;

function ctxFor(env: Record<string, string>, root: string, task: Task | undefined): HookContext {
  return {
    env,
    root,
    task,
    async saveTask() {},
    session: { load: async () => ({ sessionId: SESSION, retries: 0, reviews: 0, failures: 0, planChecks: 0, updatedAt: "" }), save: async () => ({ sessionId: SESSION, retries: 0, reviews: 0, failures: 0, planChecks: 0, updatedAt: "" }) },
    signal: new AbortController().signal,
    deadline: Date.now() + 1000,
    log: async () => {},
  };
}

test("fixtures: PreToolUse carries plan and planFilePath, PostToolUse an empty tool_input and the plan in tool_response", async () => {
  const p = await fixture("pre-tool-use.exit-plan-mode");
  assert.equal(p.tool_name, "ExitPlanMode");
  assert.equal(typeof p.tool_input.plan, "string");
  assert.match(p.tool_input.planFilePath, /\.claude\/plans\/.+\.md$/);
  const q = await fixture("post-tool-use.exit-plan-mode");
  assert.deepEqual(q.tool_input, {});
  assert.equal(typeof q.tool_response.plan, "string");
  assert.match(q.tool_response.filePath, /\.claude\/plans\/.+\.md$/);
});

test("no manifest or a declined setup: the gate stays quiet", async () => {
  for (const manifest of [null, { setup: "declined" as const }]) {
    const { env } = await project(manifest);
    assert.equal(await pre(env, (await fixture("pre-tool-use.exit-plan-mode")).tool_input.plan), undefined);
  }
});

test("the real spike plan has no wf-plan block: deny with a self-contained reason", async () => {
  const { env, root } = await project();
  const out = await pre(env, (await fixture("pre-tool-use.exit-plan-mode")).tool_input.plan);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(reasonOf(out), /No ```wf-plan block found/);
  assert.match(reasonOf(out), /call ExitPlanMode again/);
  await assert.rejects(readFile(taskPath(root)));
});

test("interface names nowhere in the evidence: deny, ask with AskUserQuestion and record an ADR in docs/adr/", async () => {
  const { env } = await project();
  const out = await pre(env, goodPlan({ interface: [{ file: "src/minus.ts", exports: ["minusOp"], source: "docs/spec.md" }], files: ["src/minus.ts", "test/a.test.js"] }));
  const reason = reasonOf(out);
  assert.match(reason, /src\/minus\.ts: minusOp, minus\.ts/);
  assert.match(reason, /AskUserQuestion/);
  assert.match(reason, /docs\/adr\//);
});

test("names captured from the ticket through MCP count as evidence", async () => {
  const { env } = await project();
  await captureMcpText(SESSION, [{ type: "text", text: "PAY-9: expose minusOp from src/minus.ts" }], env);
  const out = await pre(env, goodPlan({ ticket: "PAY-9", interface: [{ file: "src/minus.ts", exports: ["minusOp"], source: "PAY-9" }], files: ["src/minus.ts", "test/a.test.js"] }));
  assert.doesNotMatch(reasonOf(out), /appear in no evidence/);
  assert.match(reasonOf(out), /cc-improved:plan-check/);
});

test("a decision whose source does not exist is sent back to the user; the ticket key settles it", async () => {
  const { env } = await project();
  const out = await pre(env, goodPlan({ decisions: [{ question: "Round or truncate?", options: ["round", "truncate"], source: "docs/adr/0009-rounding.md" }] }));
  const reason = reasonOf(out);
  assert.match(reason, /decision "Round or truncate\?"/);
  assert.match(reason, /AskUserQuestion \(options: round \| truncate\)/);
  assert.match(reason, /set source to the ADR to be added \(docs\/adr\/<next number>-<slug>\.md\) and list that same path in files/);
  assert.doesNotMatch(reason, /write the answer as an ADR/);
  const ok = await pre(env, goodPlan({ ticket: "PAY-1", decisions: [{ question: "Round?", options: [], source: "pay-1" }] }));
  assert.doesNotMatch(reasonOf(ok), /decision "/);
});

test("a decision citing an ADR still to be written passes only when the ADR is listed in files and has an answer", async () => {
  const { env, root } = await project();
  const adr = "docs/adr/0007-rounding.md";
  const decision = { question: "Round how?", options: ["half-even", "half-up"], answer: "half-even", source: adr };
  const listed = await pre(env, goodPlan({ files: [...goodPlan().files, adr], decisions: [decision] }));
  assert.doesNotMatch(reasonOf(listed), /decision "/);
  assert.match(reasonOf(listed), /cc-improved:plan-check/);
  assert.equal((await readTask(root)).plan?.decisions[0]?.source, adr);
  const dirEntry = await pre(env, goodPlan({ files: [...goodPlan().files, "docs/adr/"], decisions: [decision] }));
  assert.doesNotMatch(reasonOf(dirEntry), /decision "/);
  const unlisted = await pre(env, goodPlan({ decisions: [decision] }));
  assert.match(reasonOf(unlisted), /decision "Round how\?"/);
  const { answer: _, ...unanswered } = decision;
  const noAnswer = await pre(env, goodPlan({ files: [...goodPlan().files, adr], decisions: [unanswered] }));
  assert.match(reasonOf(noAnswer), /decision "Round how\?"/);
  const outside = await pre(env, goodPlan({ files: [...goodPlan().files, "docs/notes/rounding.md"], decisions: [{ ...decision, source: "docs/notes/rounding.md" }] }));
  assert.match(reasonOf(outside), /decision "Round how\?"/);
});

test("interface names the user accepted in a decision's answer count as evidence", async () => {
  const { env } = await project();
  const adr = "docs/adr/0008-interface-names.md";
  const plan = goodPlan({
    files: ["src/minus.ts", "test/a.test.js", adr],
    interface: [{ file: "src/minus.ts", exports: ["minusOp"], source: adr }],
    decisions: [{ question: "Interface names", options: ["minusOp in src/minus.ts"], answer: "minusOp in src/minus.ts", source: adr }],
  });
  const out = await pre(env, plan);
  assert.doesNotMatch(reasonOf(out), /appear in no evidence/);
  assert.match(reasonOf(out), /cc-improved:plan-check/);
});

test("structure: seam test files must be listed in files, spec files must exist", async () => {
  const { env } = await project();
  const out = await pre(env, goodPlan({ spec: ["docs/spec.md", "docs/missing.md"], seams: [{ name: "x", testFile: "test/other.test.js", catches: "y" }] }));
  assert.match(reasonOf(out), /testFile test\/other\.test\.js is not in files/);
  assert.match(reasonOf(out), /spec docs\/missing\.md does not exist/);
  const empty = await pre(env, { ...goodPlan(), seams: [] });
  assert.match(reasonOf(empty), /seams: needs at least 1 item/);
});

test("a valid plan is saved as planning, then the plan check is requested once per task", async () => {
  const { env, root } = await project();
  const first = await pre(env, goodPlan());
  const reason = reasonOf(first);
  assert.equal(first.hookSpecificOutput.permissionDecision, "deny");
  assert.match(reason, /subagent_type "cc-improved:plan-check"/);
  assert.match(reason, /----- BRIEF FOR cc-improved:plan-check -----\n# Plan check: Add sub to a\.js/);
  assert.match(reason, /VERDICT: OK/);
  const task = await readTask(root);
  assert.equal(task.status, "planning");
  assert.equal(task.sessionId, SESSION);
  assert.equal(task.planFilePath, "/home/dev/.claude/plans/plan-how-to-add-whimsical-puppy.md");
  assert.deepEqual(task.plan, goodPlan());
  assert.equal(await planChecks(env), 1);

  // The plan-check agent stops: its verdict is stored for this task.
  const stop = { ...(await fixture("subagent-stop")), session_id: SESSION, agent_type: "cc-improved:plan-check", last_assistant_message: "Looks fine.\nVERDICT: OK" } as SubagentStopInput;
  const verdict = await recordPlanCheckVerdict(stop, ctxFor(env, root, task));
  assert.equal(verdict?.status, "ok");
  assert.equal((await readPlanCheckVerdict(SESSION, env))?.taskId, task.id);

  // Resubmitted (even changed): no second check, the user sees the verdict, the task keeps its id.
  const second = await pre(env, goodPlan({ seams: [...goodPlan().seams, { name: "zero", testFile: "test/a.test.js", catches: "0 - 0" }] }));
  assert.equal(second.hookSpecificOutput.permissionDecision, undefined);
  assert.match(second.systemMessage, /OK/);
  assert.equal((await readTask(root)).id, task.id);
  assert.equal((await readTask(root)).plan?.seams.length, 2);
  assert.equal(await planChecks(env), 1);
});

test("review.plan false: a valid plan passes without the plan check", async () => {
  const { env, root } = await project({ review: { plan: false } });
  assert.equal(await pre(env, goodPlan()), undefined);
  assert.equal((await readTask(root)).status, "planning");
});

test("a new task after an implementing one gets its own plan check", async () => {
  const { env, root } = await project();
  await pre(env, goodPlan());
  await writeFile(taskPath(root), JSON.stringify({ ...(await readTask(root)), status: "implementing" }));
  const out = await pre(env, goodPlan({ title: "Another task" }));
  assert.match(reasonOf(out), /cc-improved:plan-check/);
  assert.equal(await planChecks(env), 1);
});

test("ExitPlanMode from a subagent and other tools are ignored", async () => {
  const { env } = await project();
  assert.equal(await pre(env, goodPlan(), { agent_id: "a1", agent_type: "implementer" }), undefined);
  assert.equal(await pre(env, goodPlan(), { tool_name: "Write" }), undefined);
});

test("recordPlanCheckVerdict: other agents and no task are ignored; FIX keeps the findings", async () => {
  const { env, root } = await project();
  const task: Task = { id: "t1", title: "x", status: "planning", allowedExtra: [], startedAt: "now" };
  const base = { ...(await fixture("subagent-stop")), session_id: SESSION } as SubagentStopInput;
  assert.equal(await recordPlanCheckVerdict(base, ctxFor(env, root, task)), undefined);
  assert.equal(await recordPlanCheckVerdict({ ...base, agent_type: "plan-check" }, ctxFor(env, root, undefined)), undefined);
  const fix = await recordPlanCheckVerdict({ ...base, agent_type: "plan-check-sonnet", last_assistant_message: "Notes\nVERDICT: FIX\n1. Rename minusOp to sub." }, ctxFor(env, root, task));
  assert.deepEqual([fix?.status, fix?.report], ["fix", "VERDICT: FIX\n1. Rename minusOp to sub."]);
  const none = await recordPlanCheckVerdict({ ...base, agent_type: "plan-check", last_assistant_message: "I could not finish." }, ctxFor(env, root, task));
  assert.equal(none?.status, "skipped");
});

test("PostToolUse (real payload): the planning task becomes implementing with the approved plan and its file", async () => {
  const { env, root } = await project();
  await pre(env, goodPlan());
  const raw = await fixture("post-tool-use.exit-plan-mode");
  raw.tool_response.plan = markdown(goodPlan({ title: "Add sub to a.js", files: ["a.js", "test/a.test.js", "README.md"] }));
  const out = JSON.parse(await dispatch(JSON.stringify(raw), { env }));
  const task = await readTask(root);
  assert.equal(task.status, "implementing");
  assert.deepEqual(task.plan?.files, ["a.js", "test/a.test.js", "README.md"]);
  assert.equal(task.planFilePath, raw.tool_response.filePath);
  assert.match(out.hookSpecificOutput.additionalContext, /now implementing/);
  assert.match(out.hookSpecificOutput.additionalContext, /Export style\? -> named/);
});

test("PostToolUse: no planning task means no opinion; an unparsable approved plan keeps the stored one", async () => {
  const { env, root } = await project();
  const raw = await fixture("post-tool-use.exit-plan-mode");
  assert.equal(await dispatch(JSON.stringify(raw), { env }), "");
  await pre(env, goodPlan());
  await dispatch(JSON.stringify(raw), { env }); // the spike plan has no wf-plan block
  const task = await readTask(root);
  assert.equal(task.status, "implementing");
  assert.deepEqual(task.plan, goodPlan());
});

test("module shape: one handler per event it serves", () => {
  assert.deepEqual(Object.keys(mod).sort(), ["PostToolUse", "PreToolUse"]);
});
