#!/usr/bin/env node
// /done: the user closes the active task. Writes its record to .claude/workflow/tasks.jsonl, marks task.json done
// and says when a retro is due. Record, lookup and cadence live in lib/learn.ts; this file only reads and writes.
// Run as: node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/bin/wf-done.mjs  (from skills/done)
// Prints plain text for the model and always exits 0, so /done loads even when nothing could be closed.
import { readFile, rename, writeFile } from "node:fs/promises";

async function close() {
  const { projectDir, taskPath, TASK_PATH, TASKS_LOG_PATH } = await import("../lib/paths.ts");
  const { appendRecord, buildRecord, changedFiles, readRecords, retroDue, RETRO_EVERY } = await import("../lib/learn.ts");
  const root = projectDir();
  const file = taskPath(root);

  let stored;
  try {
    stored = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return "NOT CLOSED: there is no active task. Start one with /task.";
    return `NOT CLOSED: ${TASK_PATH} is unreadable (${err instanceof Error ? err.message : String(err)}). Fix or delete it.`;
  }
  // `sessionId` (and any field this script does not know) is kept as stored.
  const { sessionId, ...task } = stored ?? {};
  if (!task.id || !task.title) return `NOT CLOSED: ${TASK_PATH} has no task id or title. Fix or delete it.`;
  if (task.status === "done") return `NOT CLOSED: the task "${task.title}" was already closed on ${task.completedAt ?? "an earlier run"}.`;
  if (task.status !== "implementing") {
    return `NOT CLOSED: the task "${task.title}" is still ${task.status ?? "unknown"}: its plan was never approved, so there is nothing to record. Finish it with /task, or cancel it with /task cancel.`;
  }

  task.status = "done";
  task.completedAt = new Date().toISOString();
  const record = buildRecord(task, await changedFiles(root));
  // A run that recorded the task but failed before marking it done must not record it twice.
  const records = await readRecords(root);
  const count = records.some((r) => r.id === record.id) ? records.length : await appendRecord(root, record);

  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(sessionId === undefined ? task : { ...task, sessionId }, null, 2)}\n`);
  await rename(tmp, file);

  return [
    `CLOSED: ${task.ticket ? `[${task.ticket}] ` : ""}${task.title} (${task.id}).`,
    `Record written to ${TASKS_LOG_PATH} (${count} task${count === 1 ? "" : "s"} recorded). Commit it with the change: related tasks travel with the repo.`,
    `Files: ${record.files.length ? record.files.join(", ") : "(none)"}.`,
    ...(retroDue(count) ? [`RETRO DUE: ${count} tasks recorded; a retro runs every ${RETRO_EVERY}.`] : []),
  ].join("\n");
}

let out;
try {
  out = await close();
} catch (err) {
  out = `NOT CLOSED: ${err instanceof Error ? err.message : String(err)}`;
}
await new Promise((resolve) => process.stdout.write(`${out}\n`, resolve));
