#!/usr/bin/env node
// /pr injection: everything the model needs to write a pull request, as plain text. It only reads; it never
// commits, pushes or calls `gh pr create`. Risk comes from lib/risk.ts, the verify commands from the manifest.
// Run as: node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/bin/wf-pr.mjs [base-branch]  (from skills/pr)
// Always exits 0: a failure must not keep /pr from loading.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

const run = (cmd, args, cwd) =>
  new Promise((resolve) =>
    execFile(cmd, args, { cwd, timeout: 30_000, maxBuffer: 16 << 20 }, (err, stdout) => resolve(err ? undefined : stdout)),
  );
const read = (file) => readFile(file, "utf8").catch(() => undefined);
const lines = (text) => (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
const section = (title, body) => `## ${title}\n${body}`;

const TEMPLATES = [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md", "pull_request_template.md"];

async function baseRef(root, wanted) {
  const candidates = [wanted, "origin/HEAD", "origin/main", "origin/master", "main", "master"].filter(Boolean);
  for (const ref of candidates) if ((await run("git", ["rev-parse", "--verify", "-q", ref], root)) !== undefined) return ref;
  return undefined;
}

async function gather() {
  const { projectDir, manifestPath, taskPath, TASK_PATH, MANIFEST_PATH } = await import("../lib/paths.ts");
  const { assessRisk } = await import("../lib/risk.ts");
  const { readRecords } = await import("../lib/learn.ts");
  const root = projectDir();
  if ((await run("git", ["rev-parse", "--git-dir"], root)) === undefined) return "NOT READY: this folder is not a git repository.";

  const parts = [];
  const branch = (await run("git", ["branch", "--show-current"], root))?.trim() || "(detached HEAD)";
  const base = await baseRef(root, process.argv[2]?.trim());
  const upstream = (await run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root))?.trim();
  const gh = (await run("gh", ["--version"], root)) !== undefined;
  const origin = (await run("git", ["remote", "get-url", "origin"], root))?.trim();

  let task;
  const stored = await read(taskPath(root));
  if (stored) {
    try {
      task = JSON.parse(stored);
    } catch {
      parts.push(section("Task", `${TASK_PATH} is unreadable; ignore it.`));
    }
  }
  const baseName = base ? base.replace(/^origin\//, "") : undefined;
  const onBase = baseName === branch;
  const key = task?.ticket || task?.id;
  parts.push(
    section(
      "Git",
      [
        `Current branch: ${branch}${onBase ? " (this is the base branch: a task branch is needed before any PR)" : ""}`,
        `Base: ${base ?? "(none found: ask the user which branch to target)"}`,
        `Upstream: ${upstream || "(none: the branch was never pushed)"}`,
        `Remote origin: ${origin || "(none)"}`,
        `gh installed: ${gh ? "yes" : "no"}`,
        ...(onBase && key ? [`Suggested branch name: task/${key}`] : []),
      ].join("\n"),
    ),
  );

  if (task) {
    const plan = task.plan;
    parts.push(
      section(
        "Task",
        [
          `${task.ticket ? `[${task.ticket}] ` : ""}${task.title ?? "(untitled)"} (${task.id ?? "?"}), status ${task.status ?? "unknown"}`,
          ...(plan ? [`Plan files: ${plan.files?.join(", ") || "(none)"}`] : []),
          ...(plan?.seams?.length ? ["Seams:", ...plan.seams.map((s) => `- ${s.name}: catches ${s.catches}${s.misses ? `; misses ${s.misses}` : ""}`)] : []),
          ...(plan?.decisions?.length ? ["Decisions:", ...plan.decisions.map((d) => `- ${d.question} -> ${d.answer ?? "(settled in " + (d.source ?? "the repo") + ")"}`)] : []),
        ].join("\n"),
      ),
    );
  } else if (!stored) {
    const last = (await readRecords(root).catch(() => [])).at(-1);
    parts.push(section("Task", last ? `No active task. Last closed task: ${last.ticket ? `[${last.ticket}] ` : ""}${last.title} (${last.date}). ${last.summary}` : "No active task and no closed tasks recorded."));
  }

  let diffFiles = [];
  if (base) {
    const stat = (await run("git", ["diff", "--stat", `${base}...HEAD`], root))?.trim();
    const names = lines(await run("git", ["diff", "--name-status", `${base}...HEAD`], root));
    const commits = lines(await run("git", ["log", "--format=%h %s", `${base}..HEAD`], root));
    diffFiles = names;
    parts.push(section(`Commits ahead of ${base}`, commits.length ? commits.join("\n") : "(none)"));
    parts.push(section(`Committed diff against ${base}`, stat || "(empty)"));
  }
  const dirty = lines(await run("git", ["status", "--porcelain"], root)).filter((l) => !l.slice(3).startsWith(".claude/workflow/"));
  parts.push(section("Uncommitted changes", dirty.length ? `${dirty.join("\n")}\nThese are not in the PR until they are committed.` : "(none)"));

  const adrs = new Set();
  for (const row of diffFiles) {
    const [status, ...rest] = row.split(/\s+/);
    const file = rest.at(-1) ?? "";
    if (status?.startsWith("A") && file.startsWith("docs/adr/")) adrs.add(file);
  }
  for (const row of dirty) if (row.startsWith("??") && row.slice(3).startsWith("docs/adr/")) adrs.add(`${row.slice(3)} (uncommitted)`);
  parts.push(section("New ADRs", adrs.size ? [...adrs].map((f) => `- ${f}`).join("\n") : "(none)"));

  const manifestText = await read(manifestPath(root));
  let manifest;
  try {
    manifest = manifestText ? JSON.parse(manifestText) : undefined;
  } catch {
    manifest = undefined;
  }
  if (manifest) {
    const risk = await assessRisk(root, task, manifest);
    parts.push(
      section(
        "Risk",
        [
          risk.review ? `Risky: ${risk.reasons.join("; ")}.` : "Low risk: no reason found.",
          dirty.length ? "" : "Computed over the working copy against HEAD; the diff is committed, so judge the risk from the committed diff above.",
        ].filter(Boolean).join("\n"),
      ),
    );
    const verify = Array.isArray(manifest.verify) ? manifest.verify : [];
    parts.push(section("Verify commands (from the manifest)", verify.length ? verify.map((c) => `- ${c}`).join("\n") : `(none in ${MANIFEST_PATH})`));
  } else {
    parts.push(section("Risk and verify", `${MANIFEST_PATH} is missing or unreadable: no risk and no verify commands. /setup creates it.`));
  }

  const evidence = await read(path.join(root, ".claude/skills/verify-app/SKILL.md"));
  parts.push(section("App verification skill", evidence ? ".claude/skills/verify-app/SKILL.md exists: its evidence (screenshots, logs, output) belongs in the PR." : "(no .claude/skills/verify-app/SKILL.md)"));

  let template;
  for (const rel of TEMPLATES) {
    template = await read(path.join(root, rel));
    if (template !== undefined) {
      parts.push(section(`PR template (${rel})`, template.trimEnd()));
      break;
    }
  }
  if (template === undefined) parts.push(section("PR template", "(none in the repo: use summary, how it was verified, risk, new ADRs, out of scope)"));

  return parts.join("\n\n");
}

let out;
try {
  out = await gather();
} catch (err) {
  out = `NOT READY: ${err instanceof Error ? err.message : String(err)}`;
}
await new Promise((resolve) => process.stdout.write(`${out}\n`, resolve));
