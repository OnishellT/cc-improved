import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { WORKFLOW_DIR } from "./paths.ts";
import type { Manifest, Task } from "./types.ts";

const MAX_LINES = 200;
const MAX_FILES = 6;
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

/** Whether the diff needs the paid strong-model review. Cheap: git and regexes, no LLM. */
export async function assessRisk(root: string, task: Task | undefined, manifest: Manifest): Promise<{ review: boolean; reasons: string[] }> {
  const rule = manifest.review;
  if (rule?.never) return { review: false, reasons: ["review.never"] };
  if (rule?.always) return { review: true, reasons: ["review.always"] };

  const lines = new Map<string, number>();
  for (const row of (await git(root, ["diff", "HEAD", "--numstat"])).split("\n")) {
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
  if (total > MAX_LINES) reasons.push(`${total} líneas cambiadas`);
  if (files.length > MAX_FILES) reasons.push(`${files.length} archivos`);
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
  if (!task?.plan) reasons.push("sin plan");
  // A decision with an `answer` was put to the user; one with only a `source` was already settled in the repo.
  else if (task.plan.decisions.some((d) => d.answer !== undefined)) reasons.push("decisiones nuevas del usuario");
  return { review: reasons.length > 0, reasons };
}
