// Task records (tasks.jsonl), related-task lookup (tf-idf) and retro cadence. No harness imports.
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tasksLogPath } from "./paths.ts";
import type { Task } from "./types.ts";

/** A retro is due every this many closed tasks. */
export const RETRO_EVERY = 5;

const STOP = new Set(
  "el la los las un una unos unas de del al y o u en con por para que se su sus es son fue como mas pero sin sobre este esta esto ese esa the a an of to in on for and or with is are be by at as it this that from not".split(" "),
);

/** One closed task as stored, one JSON per line. */
export interface TaskRecord {
  id: string;
  title: string;
  ticket?: string | undefined;
  date: string;
  summary: string;
  files: string[];
  decisions: { question: string; answer?: string | undefined; source?: string | undefined }[];
  keywords: string[];
  /** Opaque cost/verify numbers collected elsewhere; stored as given. */
  metrics?: unknown;
}

function tokenize(text: string): string[] {
  const words = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().split(/[^a-z0-9]+/);
  return words.filter((w) => w.length > 2 && !STOP.has(w));
}

/** True when `file` is in the plan or was allowed later. Plan entries ending in `/` cover a directory. */
function inScope(task: Task, file: string): boolean {
  const allowed = [...(task.plan?.files ?? []), ...task.allowedExtra];
  return allowed.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));
}

function git(root: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", ["-C", root, ...args], { timeout: 10_000, maxBuffer: 1 << 20 }, (error, stdout) =>
      resolve(error ? undefined : stdout),
    );
  });
}

/** Files changed since `base` (default HEAD: commits since `base`, uncommitted and untracked), excluding the workflow's own state. */
export async function changedFiles(root: string, base = "HEAD"): Promise<string[]> {
  const files = new Set<string>();
  const diff = await git(root, ["diff", "--name-only", base]);
  for (const line of (diff ?? "").split("\n")) if (line.trim()) files.add(line.trim());
  // `-uall`: a new file in a new directory is listed by its own path, not as the directory.
  const status = await git(root, ["status", "--porcelain", "--untracked-files=all"]);
  for (const line of (status ?? "").split("\n")) if (line.startsWith("??")) files.add(line.slice(3).trim());
  return [...files].filter((f) => !f.startsWith(".claude/workflow/"));
}

/** Build the record of a finished task. `changed` is the working-copy file list (see `changedFiles`). */
export function buildRecord(task: Task, changed: string[] = [], metrics?: unknown): TaskRecord {
  const plan = task.plan;
  // The working copy may also hold unrelated changes: keep the task's own files.
  let files = changed.filter((f) => inScope(task, f));
  if (!files.length) files = plan?.files ?? [];
  const decisions = (plan?.decisions ?? []).map((d) => ({ question: d.question, answer: d.answer, source: d.source }));
  const summary = "";
  const text = [task.title, task.ticket, summary, ...files, ...decisions.flatMap((d) => [d.question, d.answer])].join(" ");
  const record: TaskRecord = {
    id: task.id,
    title: task.title,
    ticket: task.ticket,
    date: (task.completedAt ?? new Date().toISOString()).slice(0, 10),
    summary,
    files,
    decisions,
    keywords: [...new Set(tokenize(text))],
  };
  if (metrics) record.metrics = metrics;
  return record;
}

/** All records in `.claude/workflow/tasks.jsonl`; a missing file or a broken line is skipped. */
export async function readRecords(root: string): Promise<TaskRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(tasksLogPath(root), "utf8");
  } catch {
    return [];
  }
  const out: TaskRecord[] = [];
  for (const line of raw.split("\n")) {
    try {
      if (line.trim()) out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/** Append one record; returns how many records the file now holds. */
export async function appendRecord(root: string, record: TaskRecord): Promise<number> {
  const file = tasksLogPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(record)}\n`);
  return (await readRecords(root)).length;
}

/** True when `count` records were just reached and a retro should run. */
export function retroDue(count: number): boolean {
  return count > 0 && count % RETRO_EVERY === 0;
}

function format(r: TaskRecord): string {
  const head = `[${r.ticket ?? r.id}] ${r.title} (${r.date})`;
  const parts = [r.summary ? `${head}: ${r.summary}.` : `${head}.`];
  if (r.files.length) parts.push(`Files: ${r.files.slice(0, 5).join(", ")}.`);
  const decisions = r.decisions.filter((d) => d.answer).map((d) => `${d.question} → ${d.answer}`);
  if (decisions.length) parts.push(`Decisions: ${decisions.slice(0, 3).join("; ")}`);
  const text = parts.join(" ").replace(/\.\.$/, ".");
  return text.length > 400 ? `${text.slice(0, 397)}...` : text;
}

/** Compact summaries of past tasks most related to `query`, best first. */
export async function relatedTasks(root: string, query: string, limit = 3): Promise<string[]> {
  const records = await readRecords(root);
  const terms = new Set(tokenize(query));
  if (!records.length || !terms.size) return [];
  const docs = records.map((r) => new Set(r.keywords ?? tokenize(`${r.title} ${r.summary}`)));
  const has = (i: number, t: string) => docs[i]?.has(t) ?? false;
  const idf = (t: string) => Math.log(1 + records.length / (1 + docs.filter((d) => d.has(t)).length));
  return records
    .map((r, i) => ({ r, i, score: [...terms].reduce((s, t) => s + (has(i, t) ? idf(t) : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.i - a.i)
    .slice(0, limit)
    .map((x) => format(x.r));
}

/** Plain-text bullet list of related tasks for dynamic injection into a skill; empty when none. */
export async function relatedTasksText(root: string, query: string, limit = 3): Promise<string> {
  return (await relatedTasks(root, query, limit)).map((line) => `- ${line}`).join("\n");
}
