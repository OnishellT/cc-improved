import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { dispatch } from "../lib/hooks/dispatch.ts";
import { endsBlocked, parseVerdict, role, strongAgent } from "../lib/hooks/gate.ts";
import type { Manifest, Plan, SessionState, StopOutput, Task } from "../lib/types.ts";

const fixturesDir = fileURLToPath(new URL("fixtures/hooks/", import.meta.url));
const fixture = async (name: string) => JSON.parse(await readFile(path.join(fixturesDir, name), "utf8")) as Record<string, unknown>;
const SESSION = "185b8104-065e-43cc-a5b6-8b821bdffbb9";

const plan: Plan = {
  title: "Add sub",
  spec: [],
  files: ["src/"],
  interface: [{ file: "src/math.js", exports: ["sub"] }],
  seams: [{ name: "sub", testFile: "src/math.test.js", catches: "wrong sign" }],
  decisions: [],
};
const task: Task = { id: "t1", title: "Add sub", status: "implementing", plan, allowedExtra: [], startedAt: "2026-10-23T00:00:00.000Z" };

interface Lab {
  root: string;
  env: Record<string, string>;
  /** File outside the repo where verify steps append one line per run. */
  runs: string;
}

/** A git repo with a committed manifest and task, plus a plugin data dir. Verify passes while `ok` exists. */
async function lab(manifest: Partial<Manifest> = {}, t: Task | null = task, extraEnv: Record<string, string> = {}): Promise<Lab> {
  const dir = await mkdtemp(path.join(tmpdir(), "stop-gate-"));
  const root = path.join(dir, "project");
  const runs = path.join(dir, "runs.txt");
  await mkdir(path.join(root, "src"), { recursive: true });
  const m: Manifest = { version: 1, setup: "done", verify: [`echo run >> "${runs}"`, "test -f ok"], connectors: [], ...manifest };
  await mkdir(path.join(root, ".claude", "workflow"), { recursive: true });
  await writeFile(path.join(root, ".claude", "workflow.json"), JSON.stringify(m));
  await writeFile(path.join(root, ".gitignore"), ".claude/workflow/\nok\n");
  await writeFile(path.join(root, "src", "math.js"), "export const add = (a, b) => a + b;\n");
  if (t) await writeFile(path.join(root, ".claude", "workflow", "task.json"), JSON.stringify(t));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return { root, runs, env: { CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_DATA: path.join(dir, "data"), ...extraEnv } };
}

const implement = (l: Lab) => writeFile(path.join(l.root, "src", "math.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
const pass = (l: Lab) => writeFile(path.join(l.root, "ok"), "");
const fail = (l: Lab) => rm(path.join(l.root, "ok"), { force: true });
const runCount = async (l: Lab) => (await readFile(l.runs, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
const state = async (l: Lab) => JSON.parse(await readFile(path.join(l.env.CLAUDE_PLUGIN_DATA!, "sessions", `${SESSION}.json`), "utf8")) as SessionState;

async function run(l: Lab, base: Record<string, unknown>, patch: Record<string, unknown> = {}): Promise<StopOutput | undefined> {
  const out = await dispatch(JSON.stringify({ ...base, cwd: l.root, ...patch }), { env: l.env });
  return out ? (JSON.parse(out) as StopOutput) : undefined;
}
const subagent = async (agentType: string, agentId = "impl-1", patch: Record<string, unknown> = {}) => ({
  ...(await fixture("subagent-stop.json")),
  agent_type: agentType,
  agent_id: agentId,
  background_tasks: [],
  ...patch,
});
const stop = async (patch: Record<string, unknown> = {}) => ({ ...(await fixture("stop.active.json")), ...patch });

test("real fixtures: a background subagent still running and a foreign agent type get no opinion", async () => {
  const l = await lab();
  assert.equal(await run(l, await fixture("stop.json")), undefined, "stop.json lists a running background subagent");
  assert.equal(await run(l, await fixture("subagent-stop.json")), undefined, "echoer is not one of the plugin's agents");
  assert.equal(await run(l, await subagent("other-plugin:implementer")), undefined);
  assert.equal(await runCount(l), 0, "verify never ran");
});

test("implementer ladder: fix, then diagnose, then let out with FAILED; never more than 3 verify runs", async () => {
  const l = await lab({}, task, { CLAUDE_PLUGIN_OPTION_STRONG_MODEL: "sonnet" });
  await implement(l);
  const input = await subagent("cc-improved:implementer");

  const first = await run(l, input);
  assert.equal(first?.decision, "block");
  assert.match(first!.reason!, /verify FAILED/);
  assert.match(first!.reason!, /test -f ok/);
  assert.doesNotMatch(first!.reason!, /Diagnose/);

  // stop_hook_active is true on every continuation (spike 0.3): the count comes from the session state.
  const second = await run(l, input, { stop_hook_active: true });
  assert.equal(second?.decision, "block");
  assert.match(second!.reason!, /Diagnose before changing more code/);
  assert.match(second!.reason!, /FAILED:/);
  assert.match(second!.reason!, /cc-improved:fixer-sonnet/, "the fixer variant follows the strong_model config");

  const third = await run(l, input, { stop_hook_active: true });
  assert.equal(third?.decision, undefined, "the third failure lets the agent out");
  assert.match(third!.systemMessage!, /FAILED/);

  assert.equal(await run(l, input, { stop_hook_active: true }), undefined, "a stop after the release is quiet");
  assert.equal(await runCount(l), 3);
  const s = await state(l);
  assert.deepEqual(s.agents?.["impl-1"], { role: "implementer", contractBlocks: 0, failures: 3, policyBlocks: 0, outcome: "failed" });
});

test("counters are per agent_id: a second implementer starts its own ladder", async () => {
  const l = await lab();
  await implement(l);
  await run(l, await subagent("cc-improved:implementer", "impl-1"));
  await run(l, await subagent("cc-improved:implementer", "impl-1"));
  const other = await run(l, await subagent("cc-improved:implementer", "impl-2"));
  assert.doesNotMatch(other!.reason!, /Diagnose/);
  const s = await state(l);
  assert.equal(s.agents?.["impl-1"]?.failures, 2);
  assert.equal(s.agents?.["impl-2"]?.failures, 1);
});

test("contract first: a missing export blocks without running verify; once exposed, a passing verify lets the agent out", async () => {
  const l = await lab();
  const input = await subagent("implementer");
  const out = await run(l, input);
  assert.equal(out?.decision, "block");
  assert.match(out!.reason!, /src\/math\.js: missing sub/);
  assert.equal(await runCount(l), 0);

  await implement(l);
  await pass(l);
  assert.equal(await run(l, input, { stop_hook_active: true }), undefined);
  assert.equal(await runCount(l), 1);
  assert.equal((await state(l)).agents?.["impl-1"]?.outcome, "passed");
});

test("a missing contract is released as FAILED after 3 blocks", async () => {
  const l = await lab();
  const input = await subagent("cc-improved:fixer", "fix-1");
  for (let i = 0; i < 3; i++) assert.equal((await run(l, input))?.decision, "block");
  const out = await run(l, input);
  assert.equal(out?.decision, undefined);
  assert.match(out!.systemMessage!, /fixer sale con FAILED/);
});

test("an agent ending with BLOCKED: is let out for the person, without verify", async () => {
  const l = await lab();
  await implement(l);
  const out = await run(l, await subagent("cc-improved:implementer", "impl-1", { last_assistant_message: "Need a decision.\n\nBLOCKED: add a dependency? (a) yes (b) no; I recommend (b)" }));
  assert.equal(out, undefined);
  assert.equal(await runCount(l), 0);
});

test("the gates stay quiet without an implementing task or with setup not done", async () => {
  for (const [manifest, t] of [[{}, null], [{}, { ...task, status: "planning" }], [{ setup: "declined" }, task]] as const) {
    const l = await lab(manifest as Partial<Manifest>, t as Task | null);
    assert.equal(await run(l, await subagent("cc-improved:implementer")), undefined);
    assert.equal(await run(l, await stop()), undefined);
    assert.equal(await runCount(l), 0);
  }
});

test("orchestrator Stop: implementer FAILED → escalate to the fixer; fixer FAILED → the person decides", async () => {
  const l = await lab();
  await implement(l);
  const impl = await subagent("cc-improved:implementer", "impl-1");
  for (let i = 0; i < 3; i++) await run(l, impl);

  const escalate = await run(l, await stop());
  assert.equal(escalate?.decision, "block");
  assert.match(escalate!.reason!, /Launch the `cc-improved:fixer` agent/);

  const fixer = await subagent("cc-improved:fixer", "fix-1");
  for (let i = 0; i < 3; i++) await run(l, fixer);

  const person = await run(l, await stop());
  assert.equal(person?.decision, undefined);
  assert.match(person!.systemMessage!, /decide tú/i);
  assert.equal(await run(l, await stop()), undefined, "the release message is not repeated");
});

test("orchestrator Stop alone: fix → diagnose → escalate → person, at most 3 verify blocks per prompt", async () => {
  const l = await lab();
  await implement(l);
  const kinds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const out = await run(l, await stop());
    kinds.push(out?.decision === "block" ? (/Diagnose/.test(out.reason!) ? "diagnose" : /fixer/.test(out.reason!) ? "escalate" : "fix") : out?.systemMessage ? "person" : "quiet");
  }
  assert.deepEqual(kinds, ["fix", "diagnose", "escalate", "person", "quiet"]);

  // A new user prompt resets the per-prompt counters: the ladder starts again.
  const fresh = await run(l, await stop({ prompt_id: "another-prompt" }));
  assert.equal(fresh?.decision, "block");
  assert.doesNotMatch(fresh!.reason!, /Diagnose|fixer/);
});

test("risky diff: Stop asks for the reviewer once; its verdict is stored; no second paid round", async () => {
  const l = await lab({ review: { always: true } }, task, { CLAUDE_PLUGIN_OPTION_STRONG_MODEL: "opus" });
  await implement(l);
  await pass(l);

  const ask = await run(l, await stop());
  assert.equal(ask?.decision, "block");
  assert.match(ask!.reason!, /Launch the `cc-improved:reviewer` agent/);
  assert.match(ask!.reason!, /review\.always/);

  const verdict = await run(l, await subagent("cc-improved:reviewer", "rev-1", { last_assistant_message: "1. src/math.js: fine.\n\nVERDICT: FIX\n1. src/math.js: sub swaps operands." }));
  assert.match(verdict!.systemMessage!, /FIX/);
  let s = await state(l);
  assert.equal(s.reviewVerdict, "FIX");
  assert.equal(s.reviews, 1);

  // The orchestrator applies the finding; verify passes and the turn ends with the summary.
  await writeFile(path.join(l.root, "src", "math.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b; // fixed\n");
  const done = await run(l, await stop());
  assert.equal(done?.decision, undefined);
  assert.match(done!.systemMessage!, /verify OK/);
  assert.match(done!.systemMessage!, /sin segunda ronda/);

  // Another change in a new prompt: verify again, still no second review.
  await writeFile(path.join(l.root, "src", "extra.js"), "export const x = 1;\n");
  const later = await run(l, await stop({ prompt_id: "p2" }));
  assert.equal(later?.decision, undefined);
  s = await state(l);
  assert.equal(s.reviews, 1);
});

test("a reviewer variant with a full model id is launched with that model", () => {
  assert.equal(strongAgent("reviewer", { CLAUDE_PLUGIN_OPTION_STRONG_MODEL: "claude-opus-5-5" }), '`cc-improved:reviewer` with `model: "claude-opus-5-5"`');
  assert.equal(strongAgent("reviewer", {}), "`cc-improved:reviewer`");
  assert.equal(strongAgent("plan-check", { CLAUDE_PLUGIN_OPTION_STRONG_MODEL: "Sonnet" }), "`cc-improved:plan-check-sonnet`");
});

test("low-risk diff: no review is paid, the summary says so, and an unchanged tree does not rerun verify", async () => {
  const l = await lab();
  await implement(l);
  await pass(l);
  const out = await run(l, await stop());
  assert.equal(out?.decision, undefined);
  assert.match(out!.systemMessage!, /revisión omitida \(bajo riesgo/);
  assert.equal((await state(l)).reviews, 1);
  assert.equal(await runCount(l), 1);

  assert.equal(await run(l, await stop()), undefined, "same working copy: verify is not run again and nothing is printed");
  assert.equal(await runCount(l), 1);
});

test("orchestrator contract check runs before verify", async () => {
  const l = await lab();
  const out = await run(l, await stop());
  assert.equal(out?.decision, "block");
  assert.match(out!.reason!, /missing sub/);
  assert.equal(await runCount(l), 0);
});

test("plan-check verdict is stored with its count", async () => {
  const l = await lab({}, { ...task, status: "planning" });
  const out = await run(l, await subagent("cc-improved:plan-check-sonnet", "pc-1", { last_assistant_message: "Looks right.\n\nVERDICT: OK" }));
  assert.match(out!.systemMessage!, /chequeo del plan: OK/);
  const s = await state(l);
  assert.equal(s.planVerdict, "OK");
  assert.equal(s.planChecks, 1);
});

test("setup running: Stop pushes back at most twice per user prompt", async () => {
  const l = await lab({ setup: "running" }, null);
  const first = await run(l, await stop());
  assert.equal(first?.decision, "block");
  assert.match(first!.reason!, /Setup is not finished/);
  assert.equal((await run(l, await stop()))?.decision, "block");
  assert.equal(await run(l, await stop()), undefined);
  assert.equal(await run(l, await fixture("stop.json")), undefined, "a running background subagent is not pushed");
  assert.equal((await run(l, await stop({ prompt_id: "next" })))?.decision, "block", "a new prompt allows two more");
});

test("helpers: role, verdict and BLOCKED parsing", () => {
  assert.equal(role("cc-improved:reviewer-sonnet"), "reviewer");
  assert.equal(role("implementer"), "implementer");
  assert.equal(role("echoer"), "echoer");
  assert.equal(role("x:implementer"), "");
  assert.equal(parseVerdict("**VERDICT: OK**"), "OK");
  assert.equal(parseVerdict("VERDICT: OK\nlater\nVERDICT: FIX\n1. x"), "FIX");
  assert.equal(parseVerdict("no verdict here, VERDICT: OK inline"), undefined);
  assert.equal(endsBlocked("text\nBLOCKED: which one?\n"), true);
  assert.equal(endsBlocked("BLOCKED: early\nDONE"), false);
});
