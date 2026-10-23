import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { dispatch, type HookModule } from "../lib/hooks/dispatch.ts";
import { moduleFile, REGISTRY, type EventRoute } from "../lib/hooks/registry.ts";
import type { HookEventName, HookOutputMap, Task } from "../lib/types.ts";

const fixturesDir = fileURLToPath(new URL("fixtures/hooks/", import.meta.url));
const entry = fileURLToPath(new URL("../bin/wf-hook.mjs", import.meta.url));

async function fixtures(): Promise<Array<[string, string]>> {
  const files = (await readdir(fixturesDir)).filter((f) => f.endsWith(".json")).sort();
  return Promise.all(files.map(async (f) => [f, await readFile(path.join(fixturesDir, f), "utf8")] as [string, string]));
}

/** A fresh project dir and plugin data dir. */
async function sandbox() {
  const dir = await mkdtemp(path.join(tmpdir(), "wf-hook-"));
  const env = { CLAUDE_PROJECT_DIR: path.join(dir, "project"), CLAUDE_PLUGIN_DATA: path.join(dir, "data") };
  await mkdir(env.CLAUDE_PROJECT_DIR, { recursive: true });
  return env;
}

async function logText(env: { CLAUDE_PLUGIN_DATA: string }): Promise<string> {
  const dir = path.join(env.CLAUDE_PLUGIN_DATA, "log");
  const files = await readdir(dir).catch(() => [] as string[]);
  return (await Promise.all(files.map((f) => readFile(path.join(dir, f), "utf8")))).join("");
}

const route = (...mods: HookModule[]): EventRoute => ({ modules: mods.map((m) => async () => m), budgetMs: 2_000 });
const allEvents = Object.keys(REGISTRY) as HookEventName[];
const everyEvent = (mod: HookModule) => Object.fromEntries(allEvents.map((e) => [e, route(mod)])) as Record<HookEventName, EventRoute>;

/** One stub output per event, shaped like what the real handler would print. */
const expected: { [E in HookEventName]: HookOutputMap[E] } = {
  SessionStart: { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "setup pending" } },
  UserPromptSubmit: { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "ctx" } },
  PreToolUse: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "outside the plan" } },
  PostToolUse: { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "noted" } },
  SubagentStart: { hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: "brief" } },
  SubagentStop: { decision: "block", reason: "verify failed" },
  Stop: { decision: "block", reason: "launch the reviewer" },
  SessionEnd: { systemMessage: "bye" },
};
const stub: HookModule = Object.fromEntries(allEvents.map((e) => [e, () => expected[e]]));

test("every fixture is dispatched to its event's handler and the output is serialized as JSON", async () => {
  const env = await sandbox();
  const all = await fixtures();
  assert.ok(all.length > 0);
  for (const [file, raw] of all) {
    const event = JSON.parse(raw).hook_event_name as HookEventName;
    const out = await dispatch(raw, { env, registry: everyEvent(stub) });
    assert.deepEqual(JSON.parse(out), expected[event], file);
  }
});

test("bin/wf-hook.mjs: every fixture exits 0 with empty or JSON output", async () => {
  const env = await sandbox();
  for (const [file, raw] of await fixtures()) {
    const { code, stdout } = await runEntry(raw, env);
    assert.equal(code, 0, file);
    if (stdout.trim()) assert.doesNotThrow(() => JSON.parse(stdout), file);
  }
});

test("bin/wf-hook.mjs: garbage on stdin and a missing CLAUDE_PLUGIN_DATA still exit 0 with no output", async () => {
  const env = await sandbox();
  for (const [stdin, e] of [["not json", env], ["{}", env], ['{"hook_event_name":"Nope","session_id":"s","cwd":"/"}', env], [(await fixtures())[0]![1], {}]] as const) {
    const { code, stdout } = await runEntry(stdin, e);
    assert.equal(code, 0);
    assert.equal(stdout, "");
  }
});

test("a handler that throws produces no output and logs the error", async () => {
  const env = await sandbox();
  const [, raw] = (await fixtures()).find(([f]) => f === "stop.json")!;
  const out = await dispatch(raw, { env, registry: { Stop: route({ Stop: () => { throw new Error("boom in stop"); } }) } });
  assert.equal(out, "");
  const log = await logText(env);
  assert.match(log, /Stop session=185b8104-065e-43cc-a5b6-8b821bdffbb9 Error: boom in stop/);
});

test("a handler over its budget is cut off: no output, logged, signal aborted", async () => {
  const env = await sandbox();
  const [, raw] = (await fixtures()).find(([f]) => f === "stop.json")!;
  let signal: AbortSignal | undefined;
  const slow: HookModule = { Stop: (_i, ctx) => { signal = ctx.signal; return new Promise((r) => setTimeout(() => r({ decision: "block", reason: "late" }), 500)); } };
  const out = await dispatch(raw, { env, registry: { Stop: { modules: [async () => slow], budgetMs: 50 } } });
  assert.equal(out, "");
  assert.equal(signal?.aborted, true);
  assert.match(await logText(env), /timed out after 50 ms/);
});

test("the first module with an output wins; empty outputs and missing modules fall through", async () => {
  const env = await sandbox();
  const [, raw] = (await fixtures()).find(([f]) => f === "pre-tool-use.main.json")!;
  const calls: string[] = [];
  const quiet: HookModule = { PreToolUse: () => { calls.push("quiet"); return {} as HookOutputMap["PreToolUse"]; } };
  const answers: HookModule = { PreToolUse: () => { calls.push("answers"); return expected.PreToolUse; } };
  const never: HookModule = { PreToolUse: () => { calls.push("never"); return undefined; } };
  const missing = moduleFile("./does-not-exist.ts");
  const registry = { PreToolUse: { modules: [missing, async () => quiet, async () => answers, async () => never], budgetMs: 2_000 } };
  assert.deepEqual(JSON.parse(await dispatch(raw, { env, registry })), expected.PreToolUse);
  assert.deepEqual(calls, ["quiet", "answers"]);
  assert.equal(await logText(env), "");
});

test("a module that exists but fails to load is logged, not skipped in silence", async () => {
  const env = await sandbox();
  const dir = path.dirname(fileURLToPath(new URL("../lib/hooks/registry.ts", import.meta.url)));
  const broken = path.join(await mkdtemp(path.join(tmpdir(), "wf-broken-")), "broken.ts");
  await writeFile(broken, 'import "./nowhere.ts";\nexport default {};\n');
  const [, raw] = (await fixtures()).find(([f]) => f === "session-start.json")!;
  const registry = { SessionStart: { modules: [moduleFile(path.relative(dir, broken))], budgetMs: 2_000 } };
  assert.equal(await dispatch(raw, { env, registry }), "");
  assert.match(await logText(env), /nowhere\.ts/);
});

test("the real registry stays quiet for every fixture when setup was declined and there is no task", async () => {
  const env = await sandbox();
  // SessionStart offers /setup when the manifest is missing; a declined setup keeps it quiet.
  await mkdir(path.join(env.CLAUDE_PROJECT_DIR, ".claude"), { recursive: true });
  await writeFile(path.join(env.CLAUDE_PROJECT_DIR, ".claude/workflow.json"), JSON.stringify({ version: 1, setup: "declined", verify: [], connectors: [] }));
  for (const [file, raw] of await fixtures()) assert.equal(await dispatch(raw, { env }), "", file);
});

const task: Task = { id: "t1", title: "Add sub", status: "implementing", allowedExtra: [], startedAt: "2026-10-23T00:00:00.000Z" };

test("a task owned by another session silences every handler; an unowned or own task does not", async () => {
  const env = await sandbox();
  const [, raw] = (await fixtures()).find(([f]) => f === "stop.json")!;
  const file = path.join(env.CLAUDE_PROJECT_DIR, ".claude", "workflow", "task.json");
  await mkdir(path.dirname(file), { recursive: true });
  let seen: Task | undefined;
  const registry = { Stop: route({ Stop: (_i, ctx) => { seen = ctx.task; return expected.Stop; } }) };

  await writeFile(file, JSON.stringify({ ...task, sessionId: "other-session" }));
  assert.equal(await dispatch(raw, { env, registry }), "");
  assert.equal(seen, undefined);

  await writeFile(file, JSON.stringify(task));
  assert.notEqual(await dispatch(raw, { env, registry }), "");
  assert.deepEqual(seen, task);

  seen = undefined;
  await writeFile(file, JSON.stringify({ ...task, sessionId: "185b8104-065e-43cc-a5b6-8b821bdffbb9" }));
  assert.notEqual(await dispatch(raw, { env, registry }), "");
  assert.deepEqual(seen, task, "the owner stamp is not part of the Task handlers see");
});

test("saveTask writes task.json stamped with the session that owns it", async () => {
  const env = await sandbox();
  const [, raw] = (await fixtures()).find(([f]) => f === "pre-tool-use.main.json")!;
  await dispatch(raw, { env, registry: { PreToolUse: route({ PreToolUse: async (_i, ctx) => { await ctx.saveTask(task); } }) } });
  const stored = JSON.parse(await readFile(path.join(env.CLAUDE_PROJECT_DIR, ".claude", "workflow", "task.json"), "utf8"));
  assert.deepEqual(stored, { ...task, sessionId: "185b8104-065e-43cc-a5b6-8b821bdffbb9" });
});

test("session state is kept per session_id and starts at zero", async () => {
  const env = await sandbox();
  const [, raw] = (await fixtures()).find(([f]) => f === "subagent-stop.json")!;
  const other = JSON.stringify({ ...JSON.parse(raw), session_id: "second-session" });
  const bump: HookModule = { SubagentStop: async (_i, ctx) => { const s = await ctx.session.load(); await ctx.session.save({ failures: s.failures + 1 }); } };
  const registry = { SubagentStop: route(bump) };
  await dispatch(raw, { env, registry });
  await dispatch(raw, { env, registry });
  await dispatch(other, { env, registry });
  const read = async (id: string) => JSON.parse(await readFile(path.join(env.CLAUDE_PLUGIN_DATA, "sessions", `${id}.json`), "utf8"));
  const mine = await read("185b8104-065e-43cc-a5b6-8b821bdffbb9");
  assert.equal(mine.failures, 2);
  assert.equal(mine.retries, 0);
  assert.equal(mine.sessionId, "185b8104-065e-43cc-a5b6-8b821bdffbb9");
  assert.equal((await read("second-session")).failures, 1);
});

function runEntry(stdin: string, env: Record<string, string | undefined>): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const base = { PATH: process.env.PATH };
    const child = execFile(process.execPath, ["--experimental-strip-types", "--no-warnings", entry], { env: { ...base, ...env } }, (err, stdout) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout });
    });
    child.stdin!.end(stdin);
  });
}
