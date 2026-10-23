import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { WORKFLOW_DIR } from "./paths.ts";
import type { Manifest, ReviewPolicy, RiskLevel, Task } from "./types.ts";

// Defaults of the size thresholds; `review.maxLines/maxFiles/highLines/highFiles` override them.
const MAX_LINES = 200;
const MAX_FILES = 6;
const HIGH_LINES = 600;
const HIGH_FILES = 15;
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
// Same patterns as lib/triggers.ts (#12); inlined so this module has no dependency on it yet.
const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|Cargo\.toml)$/;
const MIGRATION = /(^|\/)(migrations?\/|db\/migrate\/|alembic\/versions\/)|(^|\/)schema\.prisma$|\.sql$/;
const DEPENDENCIES = /(^|\/)(pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|package-lock\.json|Gemfile(\.lock)?)$/;
const SENSITIVE = /(^|\/)(auth\w*|payments?|billing|security|crypto\w*|migrations?|infra(structure)?)\//i;

const globRegex = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/|\*\*/g, (m) => (m.endsWith("/") ? "\u0000" : "\u0001")).replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, "(?:.*/)?").replace(/\u0001/g, ".*")}$`);

/** A `review.paths` entry: a prefix ending in `/`, or an exact path or glob. */
const pathMatcher = (entry: string): ((file: string) => boolean) => {
  if (entry.endsWith("/")) return (file) => file.startsWith(entry);
  const re = globRegex(entry);
  return (file) => re.test(file);
};

/** Stdout of a git command in `root`; empty when git is missing, fails or times out. */
const git = (root: string, args: string[]): Promise<string> =>
  new Promise((resolve) => {
    execFile("git", args, { cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }, (err, stdout) => resolve(err ? "" : stdout));
  });

/** Current HEAD commit, or `undefined` when there is no git, no repo or no commit yet. */
export async function gitHead(root: string): Promise<string | undefined> {
  const out = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"])).trim();
  return /^[0-9a-f]{7,64}$/.test(out) ? out : undefined;
}

/**
 * `task` with `baseCommit` set: kept when the same task already has one, else the current HEAD. Without git the task
 * is returned unchanged and every diff measure falls back to HEAD.
 */
export async function withBaseCommit(root: string, task: Task, previous?: Task): Promise<Task> {
  const kept = previous && previous.id === task.id ? previous.baseCommit : undefined;
  const base = kept ?? (await gitHead(root));
  return base ? { ...task, baseCommit: base } : task;
}

/** The ref diffs are measured against: the task's `baseCommit` when it still resolves, else `HEAD` (current behavior). */
export async function diffBase(root: string, task: Pick<Task, "baseCommit"> | undefined): Promise<string> {
  const base = task?.baseCommit;
  if (!base || !/^[0-9a-f]{7,64}$/.test(base)) return "HEAD";
  return (await git(root, ["rev-parse", "--verify", "-q", `${base}^{commit}`])).trim() ? base : "HEAD";
}

const threshold = (value: number | undefined, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback);

/** Reasons that make `files` high risk whatever their size: dependencies, migrations, `review.paths`, sensitive zones. */
export function highRiskReasons(files: string[], rule: ReviewPolicy | undefined): string[] {
  const reasons: string[] = [];
  const pick = (test: (f: string) => boolean) => files.filter(test).slice(0, 3).join(", ");
  const deps = pick((f) => MANIFEST.test(f) || DEPENDENCIES.test(f));
  if (deps) reasons.push(`dependencias (${deps})`);
  const migrations = pick((f) => MIGRATION.test(f));
  if (migrations) reasons.push(`migración (${migrations})`);
  const matchers = (rule?.paths ?? []).map(pathMatcher);
  const matched = pick((f) => matchers.some((m) => m(f)));
  if (matched) reasons.push(`review.paths (${matched})`);
  const sensitive = pick((f) => SENSITIVE.test(f));
  if (sensitive) reasons.push(`zona sensible (${sensitive})`);
  return reasons;
}

/** What `assessRisk` decided; `review` is whether a review is requested. */
export interface RiskAssessment {
  review: boolean;
  level: RiskLevel;
  reasons: string[];
}

/**
 * How much review the diff needs. `none`: skip it. `low`: recorded, reviewed only when `review.minLevel` is `low`.
 * `high`: the strong-model review.
 * Cheap: git and regexes, no LLM. Doubt goes up a level, never down.
 */
export async function assessRisk(root: string, task: Task | undefined, manifest: Manifest): Promise<RiskAssessment> {
  const rule = manifest.review;
  // `always` wins over `never` (see ReviewPolicy in types.ts).
  if (rule?.always) return { review: true, level: "high", reasons: ["review.always"] };
  if (rule?.never) return { review: false, level: "none", reasons: ["review.never"] };

  const lines = new Map<string, number>();
  for (const row of (await git(root, ["diff", await diffBase(root, task), "--numstat"])).split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(row);
    if (m) lines.set(m[3]!, (m[1] === "-" ? 0 : Number(m[1])) + (m[2] === "-" ? 0 : Number(m[2])));
  }
  for (const file of (await git(root, ["ls-files", "--others", "--exclude-standard"])).split("\n")) {
    if (!file || file.startsWith(`${WORKFLOW_DIR}/`)) continue;
    const text = await fs.readFile(path.join(root, file), "utf8").catch(() => "");
    lines.set(file, text ? text.split("\n").length : 1);
  }
  const files = [...lines.keys()];
  const total = [...lines.values()].reduce((a, b) => a + b, 0);

  const reasons: string[] = [];
  let level: RiskLevel = "none";
  const raise = (to: RiskLevel, reason: string) => {
    reasons.push(reason);
    if (to === "high" || level === "none") level = to;
  };
  const [maxLines, maxFiles] = [threshold(rule?.maxLines, MAX_LINES), threshold(rule?.maxFiles, MAX_FILES)];
  const [highLines, highFiles] = [Math.max(maxLines, threshold(rule?.highLines, HIGH_LINES)), Math.max(maxFiles, threshold(rule?.highFiles, HIGH_FILES))];
  if (total > maxLines) raise(total > highLines ? "high" : "low", `${total} líneas cambiadas`);
  if (files.length > maxFiles) raise(files.length > highFiles ? "high" : "low", `${files.length} archivos`);
  for (const reason of highRiskReasons(files, rule)) raise("high", reason);
  if (!task?.plan) raise("low", "sin plan");
  // A decision with an `answer` was put to the user; one with only a `source` was already settled in the repo.
  else if (task.plan.decisions.some((d) => d.answer !== undefined)) raise("low", "decisiones nuevas del usuario");
  const final = level as RiskLevel; // `raise` assigns it in a closure, which narrowing does not see
  return { review: rule?.minLevel === "low" ? final !== "none" : final === "high", level: final, reasons };
}
