import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { RETRO_EVERY, appendRecord, buildRecord, readRecords, relatedTasks, relatedTasksText, retroDue } from "../lib/learn.ts";
import { tasksLogPath } from "../lib/paths.ts";
import type { Task } from "../lib/types.ts";

const tempProject = () => fs.mkdtemp(path.join(os.tmpdir(), "cc-improved-"));

const task = (id: string, title: string, files: string[], answer?: string): Task => ({
  id, title, ticket: id, status: "done", allowedExtra: [], startedAt: "", completedAt: "2026-10-20T10:00:00Z",
  plan: {
    title, spec: [], files, interface: [], seams: [],
    decisions: answer ? [{ question: "Rounding mode?", options: [], answer, source: "docs/adr/1.md" }] : [],
  },
});

test("builds a record from the working copy, keeps only task files, and ranks related tasks", async () => {
  const root = await tempProject();
  // AGENTS.md changed too, but it is outside the task's plan, so the record leaves it out.
  const changed = ["src/pay.ts", "AGENTS.md", "src/new.ts"];
  await appendRecord(root, buildRecord(task("PAY-142", "Fix rounding of pagos", ["src/"], "half-even"), changed));
  await appendRecord(root, buildRecord(task("UI-7", "Botón de login", ["login.css"])));
  const lines = (await fs.readFile(tasksLogPath(root), "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0] ?? "").files, ["src/pay.ts", "src/new.ts"]);
  const top = (await relatedTasks(root, "REDONDEÓ pagos"))[0] ?? "";
  assert.match(top, /^\[PAY-142\] Fix rounding of pagos \(2026-10-20\)/);
  assert.match(top, /Rounding mode\? → half-even/);
  assert.ok(top.length <= 400);
  assert.equal((await relatedTasks(root, "zzz")).length, 0);
  assert.match(await relatedTasksText(root, "pagos"), /^- \[PAY-142\]/);
  assert.equal(await relatedTasksText(root, "zzz"), "");
});

test("falls back to plan files when nothing changed is in scope; stores metrics", async () => {
  const root = await tempProject();
  const record = buildRecord(task("A-1", "T", ["a.ts"]), [], { verifyRuns: 2 });
  await appendRecord(root, record);
  assert.match(await fs.readFile(tasksLogPath(root), "utf8"), /"files":\["a.ts"\]/);
  assert.deepEqual((await readRecords(root))[0]?.metrics, { verifyRuns: 2 });
});

test("empty store returns [] and broken lines are skipped", async () => {
  const root = await tempProject();
  assert.deepEqual(await relatedTasks(root, "anything"), []);
  await fs.mkdir(path.dirname(tasksLogPath(root)), { recursive: true });
  await fs.writeFile(tasksLogPath(root), `not json\n${JSON.stringify(buildRecord(task("B-1", "Ok", [])))}\n`);
  assert.equal((await readRecords(root)).length, 1);
});

test("retro is due on every 5th record", async () => {
  const root = await tempProject();
  const due: boolean[] = [];
  for (let i = 1; i <= 10; i++) due.push(retroDue(await appendRecord(root, buildRecord(task(`T-${i}`, "T", ["a.ts"])))));
  assert.equal(RETRO_EVERY, 5);
  assert.deepEqual(due.map((d, i) => d && i + 1), [false, false, false, false, 5, false, false, false, false, 10]);
  assert.equal(retroDue(0), false);
});
