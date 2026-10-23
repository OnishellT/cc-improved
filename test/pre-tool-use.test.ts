import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { dispatch } from "../lib/hooks/dispatch.ts";
import mod, { agentRole, guarded } from "../lib/hooks/pre-tool-use.ts";
import { taskPath } from "../lib/paths.ts";
import type { PreToolUseInput, PreToolUseOutput, Task } from "../lib/types.ts";

const fixture = (name: string) => readFile(fileURLToPath(new URL(`fixtures/hooks/${name}`, import.meta.url)), "utf8").then((t) => JSON.parse(t) as PreToolUseInput);
const MAIN = await fixture("pre-tool-use.main.json");
const SUB = await fixture("pre-tool-use.subagent.json");

const registry = { PreToolUse: { modules: [async () => mod], budgetMs: 2_000 } };

async function sandbox(task?: Partial<Task> & { sessionId?: string }) {
  const dir = await mkdtemp(path.join(tmpdir(), "wf-pre-"));
  const env = { CLAUDE_PROJECT_DIR: path.join(dir, "project"), CLAUDE_PLUGIN_DATA: path.join(dir, "data") };
  await mkdir(env.CLAUDE_PROJECT_DIR, { recursive: true });
  if (task) {
    const full = { id: "t1", title: "Add sub", status: "implementing", allowedExtra: [], startedAt: "2026-10-23T00:00:00Z", ...task };
    await mkdir(path.dirname(taskPath(env.CLAUDE_PROJECT_DIR)), { recursive: true });
    await writeFile(taskPath(env.CLAUDE_PROJECT_DIR), JSON.stringify(full));
  }
  return { env, root: env.CLAUDE_PROJECT_DIR };
}

const plan = { title: "Add sub", spec: [], files: ["src/math.ts", "test/"], interface: [], seams: [], decisions: [] };

/** Runs the real fixture with another tool call (and optionally another agent) through the dispatcher. */
async function run(env: Record<string, string>, base: PreToolUseInput, tool_name: string, tool_input: Record<string, unknown>, extra: Partial<PreToolUseInput> = {}) {
  const out = await dispatch(JSON.stringify({ ...base, tool_name, tool_input, ...extra }), { env, registry });
  return out ? (JSON.parse(out) as PreToolUseOutput).hookSpecificOutput : undefined;
}

const implementer = { agent_id: "a39442af906249e9f", agent_type: "wf:implementer" };

test("agentRole strips the plugin prefix and the model variant", () => {
  assert.equal(agentRole("wf:implementer"), "implementer");
  assert.equal(agentRole("cc-improved:fixer-sonnet"), "fixer");
  assert.equal(agentRole("plan-check"), "plan-check");
  assert.equal(agentRole(undefined), undefined);
});

test("guarded: implementer and fixer always, reviewer and plan-check never, the rest only while implementing", () => {
  const implementing = { status: "implementing" } as Task;
  const planning = { status: "planning" } as Task;
  assert.equal(guarded({ agent_type: "wf:implementer" }, undefined), true);
  assert.equal(guarded({ agent_type: "fixer-sonnet" }, planning), true);
  assert.equal(guarded({ agent_type: "wf:reviewer" }, implementing), false);
  assert.equal(guarded({ agent_type: "plan-check-sonnet" }, implementing), false);
  assert.equal(guarded({}, implementing), true);
  assert.equal(guarded({}, planning), false);
  assert.equal(guarded({}, undefined), false);
  assert.equal(guarded({ agent_type: "echoer" }, implementing), true);
});

test("real fixtures as they are: a harmless Bash call gets no opinion outside a task", async () => {
  const { env } = await sandbox();
  for (const base of [MAIN, SUB]) assert.equal(await dispatch(JSON.stringify(base), { env, registry }), "");
});

test("main session, implementing: an edit outside the plan asks with a self-contained reason and the plan files once", async () => {
  const { env, root } = await sandbox({ plan });
  const out = await run(env, MAIN, "Edit", { file_path: path.join(root, "src/other.ts"), old_string: "a", new_string: "b" });
  assert.equal(out?.permissionDecision, "ask");
  assert.match(out?.permissionDecisionReason ?? "", /Outside the approved plan: src\/other\.ts is not in the plan's files list/);
  assert.match(out?.additionalContext ?? "", /- src\/math\.ts\n- test\//);

  const again = await run(env, MAIN, "Write", { file_path: "src/other.ts", content: "x" });
  assert.equal(again?.permissionDecision, "ask");
  assert.equal(again?.additionalContext, undefined);
});

test("main session, implementing: the first in-plan edit only adds the plan files; later ones get no opinion", async () => {
  const { env, root } = await sandbox({ plan });
  const first = await run(env, MAIN, "Write", { file_path: path.join(root, "src/math.ts"), content: "x" });
  assert.deepEqual(Object.keys(first ?? {}).sort(), ["additionalContext", "hookEventName"]);
  assert.equal(await run(env, MAIN, "Write", { file_path: path.join(root, "test/math.test.ts"), content: "x" }), undefined);
});

test("allowedExtra, .claude/, docs/adr/ and files outside the project are not out of plan", async () => {
  const { env, root } = await sandbox({ plan, allowedExtra: ["README.md"] });
  await run(env, MAIN, "Write", { file_path: "src/math.ts", content: "x" }); // spend the one-time context
  for (const file_path of [path.join(root, "README.md"), path.join(root, ".claude/notes.md"), "docs/adr/0001-x.md", path.join(path.dirname(root), "scratch.txt")]) {
    assert.equal(await run(env, MAIN, "Write", { file_path, content: "x" }), undefined, file_path);
  }
  const nb = await run(env, MAIN, "NotebookEdit", { notebook_path: path.join(root, "nb/a.ipynb"), new_source: "x" });
  assert.equal(nb?.permissionDecision, "ask");
});

test("main session outside implementing: no guard at all", async () => {
  for (const status of ["planning", "done"] as const) {
    const { env, root } = await sandbox({ plan, status });
    assert.equal(await run(env, MAIN, "Write", { file_path: path.join(root, "src/other.ts"), content: "x" }), undefined, status);
    assert.equal(await run(env, MAIN, "Bash", { command: "npm i left-pad" }), undefined, status);
  }
});

test("subagent fixture as implementer: guards apply even before the task is implementing; reviewer is never guarded", async () => {
  const { env, root } = await sandbox({ plan, status: "planning" });
  const out = await run(env, SUB, "Edit", { file_path: path.join(root, "a.js"), old_string: "a", new_string: "b" }, implementer);
  assert.equal(out?.permissionDecision, "ask");
  assert.match(out?.permissionDecisionReason ?? "", /a\.js is not in the plan's files list/);

  const reviewer = await run(env, SUB, "Bash", { command: "npm install zod" }, { agent_type: "wf:reviewer" });
  assert.equal(reviewer, undefined);
});

test("plan files context is given once per agent: the implementer gets it even after the main session did", async () => {
  const { env } = await sandbox({ plan });
  assert.ok((await run(env, MAIN, "Write", { file_path: "src/math.ts", content: "x" }))?.additionalContext);
  assert.ok((await run(env, SUB, "Write", { file_path: "src/math.ts", content: "x" }, implementer))?.additionalContext);
  assert.equal(await run(env, SUB, "Write", { file_path: "src/math.ts", content: "x" }, implementer), undefined);
});

test("installers in Bash ask; plain commands do not", async () => {
  const { env } = await sandbox({ plan });
  await run(env, SUB, "Bash", { command: "ls" }, implementer);
  const out = await run(env, SUB, "Bash", { command: "cd app && pnpm add lodash zod@3" }, implementer);
  assert.equal(out?.permissionDecision, "ask");
  assert.match(out?.permissionDecisionReason ?? "", /installs lodash, zod/);
  assert.equal(await run(env, SUB, "Bash", { command: "npm test" }, implementer), undefined);
});

test("manifest edits ask only when they add a dependency (Write, Edit, MultiEdit)", async () => {
  const { env, root } = await sandbox({ plan: { ...plan, files: ["package.json", "requirements.txt", "Gemfile"] } });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "x", dependencies: { a: "1" } }, null, 2));
  await run(env, MAIN, "Bash", { command: "true" });

  const write = await run(env, MAIN, "Write", { file_path: "package.json", content: JSON.stringify({ dependencies: { a: "1", b: "2" } }) });
  assert.match(write?.permissionDecisionReason ?? "", /adds b to package\.json/);

  const bump = await run(env, MAIN, "Edit", { file_path: "package.json", old_string: '"a": "1"', new_string: '"a": "2"' });
  assert.equal(bump, undefined);

  const multi = await run(env, MAIN, "MultiEdit", { file_path: "package.json", edits: [{ old_string: '"a": "1"', new_string: '"a": "1",\n    "c": "3"' }] });
  assert.match(multi?.permissionDecisionReason ?? "", /adds c to package\.json/);

  const all = await run(env, MAIN, "Edit", { file_path: "package.json", old_string: '"a"', new_string: '"d"', replace_all: true });
  assert.match(all?.permissionDecisionReason ?? "", /adds d to package\.json/);

  const created = await run(env, MAIN, "Write", { file_path: "requirements.txt", content: "requests==2\n" });
  assert.match(created?.permissionDecisionReason ?? "", /adds requests to requirements\.txt/);

  const unknown = await run(env, MAIN, "Write", { file_path: "Gemfile", content: "gem 'rails'\n" });
  assert.match(unknown?.permissionDecisionReason ?? "", /could not be determined/);

  const stale = await run(env, MAIN, "Edit", { file_path: "package.json", old_string: "not there", new_string: "x" });
  assert.match(stale?.permissionDecisionReason ?? "", /could not be determined/);
});

test("migrations ask, and every reason is joined into one question", async () => {
  const { env } = await sandbox({ plan });
  await run(env, MAIN, "Bash", { command: "true" });
  const inPlan = await sandbox({ plan: { ...plan, files: ["db/migrate/"] } });
  await run(inPlan.env, MAIN, "Bash", { command: "true" });
  const one = await run(inPlan.env, MAIN, "Write", { file_path: "db/migrate/001_users.rb", content: "x" });
  assert.equal(one?.permissionDecision, "ask");
  assert.match(one?.permissionDecisionReason ?? "", /^Schema or migration change: db\/migrate\/001_users\.rb/);

  const both = await run(env, MAIN, "Write", { file_path: "sql/002.sql", content: "x" });
  assert.match(both?.permissionDecisionReason ?? "", /Outside the approved plan: sql\/002\.sql.* Schema or migration change: sql\/002\.sql/);
});

test("interactive agentlint is denied everywhere; agentlint accept asks when guarded", async () => {
  const { env } = await sandbox();
  for (const command of ["pnpm agentlint review", "npx agentlint -- review", "agentlint check --wizard"]) {
    const out = await run(env, MAIN, "Bash", { command });
    assert.equal(out?.permissionDecision, "deny", command);
    assert.match(out?.permissionDecisionReason ?? "", /would hang/);
  }
  assert.equal(await run(env, MAIN, "Bash", { command: "agentlint accept rule-1" }), undefined);

  const out = await run(env, SUB, "Bash", { command: "pnpm agentlint accept no-any --reason x" }, implementer);
  assert.equal(out?.permissionDecision, "ask");
  assert.match(out?.permissionDecisionReason ?? "", /agentlint exception is the user's decision/);
});

test("a task owned by another session is ignored", async () => {
  const { env, root } = await sandbox({ plan, sessionId: "someone-else" });
  assert.equal(await run(env, MAIN, "Write", { file_path: path.join(root, "src/other.ts"), content: "x" }), undefined);
  assert.equal(await run(env, MAIN, "Bash", { command: "agentlint review" }), undefined);
});

test("tools outside the guarded list and inputs without a path get no opinion", async () => {
  const { env } = await sandbox({ plan });
  await run(env, MAIN, "Bash", { command: "true" });
  assert.equal(await run(env, MAIN, "Read", { file_path: "src/other.ts" }), undefined);
  assert.equal(await run(env, MAIN, "Grep", { pattern: "x" }), undefined);
  assert.equal(await run(env, MAIN, "Write", { content: "x" }), undefined);
  assert.equal(await run(env, MAIN, "Bash", {}), undefined);
});

test("never allows: no output ever carries permissionDecision allow", async () => {
  const { env, root } = await sandbox({ plan });
  for (const [tool, input] of [["Write", { file_path: path.join(root, "src/math.ts"), content: "x" }], ["Bash", { command: "npm test" }]] as const) {
    const out = await run(env, MAIN, tool, input);
    assert.notEqual(out?.permissionDecision, "allow");
  }
});
