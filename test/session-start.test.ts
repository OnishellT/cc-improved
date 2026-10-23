import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { dispatch } from "../lib/hooks/dispatch.ts";
import mod, { MODES_NOTE, setupNote, setupState, taskSummary } from "../lib/hooks/session-start.ts";
import { manifestPath, taskPath } from "../lib/paths.ts";
import type { ContextOutput, Task } from "../lib/types.ts";

const RAW = await readFile(fileURLToPath(new URL("fixtures/hooks/session-start.json", import.meta.url)), "utf8");
const SESSION = (JSON.parse(RAW) as { session_id: string }).session_id;
const registry = { SessionStart: { modules: [async () => mod], budgetMs: 2_000 } };

async function sandbox(opts: { manifest?: string | object; task?: Partial<Task> & { sessionId?: string } } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "wf-session-start-"));
  const env = { CLAUDE_PROJECT_DIR: path.join(dir, "project"), CLAUDE_PLUGIN_DATA: path.join(dir, "data") };
  const root = env.CLAUDE_PROJECT_DIR;
  await mkdir(path.join(root, ".claude/workflow"), { recursive: true });
  if (opts.manifest !== undefined) {
    await writeFile(manifestPath(root), typeof opts.manifest === "string" ? opts.manifest : JSON.stringify(opts.manifest));
  }
  if (opts.task) {
    const task = { id: "t1", title: "Export invoices", status: "implementing", allowedExtra: [], startedAt: "2026-10-23T00:00:00Z", ...opts.task };
    await writeFile(taskPath(root), JSON.stringify(task));
  }
  return { env, root };
}

const manifest = (setup: string) => ({ version: 1, setup, verify: [], connectors: [] });

async function context(env: Record<string, string>): Promise<string | undefined> {
  const out = await dispatch(RAW, { env, registry });
  if (!out) return undefined;
  const parsed = JSON.parse(out) as ContextOutput;
  assert.equal(parsed.hookSpecificOutput?.hookEventName, "SessionStart");
  return parsed.hookSpecificOutput?.additionalContext;
}

test("setupState reads the manifest: missing, each status, and unreadable for bad JSON or an unknown status", async () => {
  assert.equal(await setupState((await sandbox()).root), "missing");
  for (const s of ["pending", "running", "done", "declined"]) assert.equal(await setupState((await sandbox({ manifest: manifest(s) })).root), s);
  assert.equal(await setupState((await sandbox({ manifest: "{not json" })).root), "unreadable");
  assert.equal(await setupState((await sandbox({ manifest: manifest("later") })).root), "unreadable");
  assert.equal(await setupState((await sandbox({ manifest: "null" })).root), "unreadable");
});

test("setupNote: one line with both modes when done, quiet when declined; otherwise offers /setup without running it", () => {
  assert.equal(setupNote("done"), MODES_NOTE);
  assert.ok(!MODES_NOTE.includes("\n") && MODES_NOTE.length < 300);
  assert.match(MODES_NOTE, /\/setup.*\/task/);
  assert.equal(setupNote("declined"), undefined);
  for (const s of ["missing", "pending", "running", "unreadable"] as const) assert.match(setupNote(s) ?? "", /\/setup/);
  assert.match(setupNote("missing") ?? "", /\.claude\/workflow\.json/);
});

test("real fixture, no manifest: short additionalContext offering /setup", async () => {
  const { env } = await sandbox();
  const ctx = await context(env);
  assert.match(ctx ?? "", /no workflow manifest \(\.claude\/workflow\.json\).*offer to run \/setup/);
  assert.ok((ctx ?? "").length < 300);
});

test("real fixture, setup pending or running: offers /setup", async () => {
  assert.match((await context((await sandbox({ manifest: manifest("pending") })).env)) ?? "", /pending.*\/setup/);
  assert.match((await context((await sandbox({ manifest: manifest("running") })).env)) ?? "", /not finished.*\/setup/);
});

test("real fixture, setup done and no task: only the modes line; declined: no output", async () => {
  assert.equal(await context((await sandbox({ manifest: manifest("done") })).env), MODES_NOTE);
  assert.equal(await dispatch(RAW, { env: (await sandbox({ manifest: manifest("declined") })).env, registry }), "");
});

test("an open task is summarized; a closed one is not", async () => {
  const plan = { title: "Export", spec: [], files: ["src/csv.ts", "test/"], interface: [], seams: [], decisions: [] };
  const implementing = await context((await sandbox({ manifest: manifest("done"), task: { ticket: "LAB-142", plan } })).env);
  assert.equal(
    implementing,
    MODES_NOTE + "\n" +
      'Open workflow task: "Export invoices" (LAB-142), status implementing. Plan files: src/csv.ts, test/. Change only the plan files; verification runs automatically when you stop. The user closes the task with /done.',
  );
  const planning = await context((await sandbox({ manifest: manifest("done"), task: { status: "planning", planFilePath: "/tmp/plan.md" } })).env);
  assert.match(planning ?? "", /status planning\. Plan: \/tmp\/plan\.md\. The plan is waiting for the user's approval\./);
  assert.equal(await context((await sandbox({ manifest: manifest("done"), task: { status: "done" } })).env), MODES_NOTE);
  assert.equal(taskSummary(undefined), undefined);
});

test("setup note and task summary together; declined keeps only the task", async () => {
  const both = await context((await sandbox({ manifest: manifest("pending"), task: {} })).env);
  assert.match(both ?? "", /\/setup.*\nOpen workflow task/s);
  const declined = await context((await sandbox({ manifest: manifest("declined"), task: {} })).env);
  assert.match(declined ?? "", /^Open workflow task/);
  assert.doesNotMatch(declined ?? "", /setup/);
});

test("a task owned by another session: no task summary", async () => {
  const { env } = await sandbox({ task: { sessionId: "other-session" } });
  assert.doesNotMatch((await context(env)) ?? "", /Open workflow task/);
  const own = await sandbox({ manifest: manifest("done"), task: { sessionId: SESSION } });
  assert.match((await context(own.env)) ?? "", /\nOpen workflow task/);
});
