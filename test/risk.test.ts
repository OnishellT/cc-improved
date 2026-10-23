import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assessRisk, diffBase, gitHead, withBaseCommit } from "../lib/risk.ts";
import type { Decision, Manifest, Plan, Task } from "../lib/types.ts";

const base: Manifest = { version: 1, setup: "done", verify: [], connectors: [] };
const plan: Plan = { title: "T", spec: [], files: [], interface: [], seams: [], decisions: [] };
const task: Task = { id: "t", title: "T", status: "implementing", allowedExtra: [], startedAt: "", plan };
const { plan: _omit, ...noPlan } = task;

/** A temp git repo with one commit; `tracked` files exist at HEAD, `changed` rewrites them with n lines, `untracked` adds new files. */
function repo(opts: { changed?: [string, number][]; untracked?: string[] } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "risk-"));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  const write = (file: string, n: number, tag: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), Array.from({ length: n }, (_, i) => `${tag} ${i}`).join("\n") + "\n");
  };
  run("init", "-q");
  run("config", "user.email", "t@t");
  run("config", "user.name", "t");
  run("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(root, "README.md"), "x\n");
  for (const [f] of opts.changed ?? []) write(f, 1, "old");
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  for (const [f, n] of opts.changed ?? []) write(f, n, "new");
  for (const f of opts.untracked ?? []) write(f, 1, "u");
  return root;
}

const risk = (changed: [string, number][], t: Task | null = task, m: Manifest = base, untracked: string[] = []) =>
  assessRisk(repo({ changed, untracked }), t ?? undefined, m);

test("a small ordinary diff with a plan is low risk", async () => {
  assert.deepEqual(await risk([["src/a.ts", 10], ["src/b.ts", 5]]), { review: false, level: "none", reasons: [] });
});

test("size thresholds: > 200 lines or > 6 files", async () => {
  assert.match((await risk([["src/a.ts", 201]])).reasons[0] ?? "", /líneas cambiadas/);
  assert.equal((await risk([["src/a.ts", 100]])).review, false);
  const seven = Array.from({ length: 7 }, (_, i) => [`src/f${i}.ts`, 2] as [string, number]);
  assert.match((await risk(seven)).reasons[0] ?? "", /7 archivos/);
  assert.equal((await risk(seven.slice(0, 6))).review, false);
});

test("untracked files count towards the diff", async () => {
  assert.match((await risk([], task, base, ["a", "b", "c", "d", "e", "f", "g"])).reasons[0] ?? "", /7 archivos/);
});

test("workflow state files are ignored", async () => {
  assert.equal((await risk([], task, base, [".claude/workflow/task.json"])).review, false);
});

test("dependency manifests, lockfiles and migrations", async () => {
  for (const f of ["package.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "requirements-dev.txt", "pyproject.toml", "go.mod", "Cargo.toml", "Gemfile"]) {
    assert.match((await risk([[f, 2]])).reasons.join(), /dependencias/, f);
  }
  assert.match((await risk([["db/migrate/001_x.rb", 2]])).reasons.join(), /migración/);
});

test("sensitive directories", async () => {
  for (const f of ["src/auth/login.ts", "app/payments/charge.ts", "billing/x.py", "lib/crypto/aes.ts", "infra/main.tf", "security/policy.ts"]) {
    assert.match((await risk([[f, 2]])).reasons.join(), /zona sensible/, f);
  }
  assert.equal((await risk([["src/author.ts", 2]])).review, false);
});

test("review.paths: globs, exact paths and directory prefixes", async () => {
  const m = { ...base, review: { paths: ["src/core/**", "*.sql", "config/app.yml", "ops/"] } };
  assert.match((await risk([["src/core/deep/x.ts", 2]], task, m)).reasons.join(), /review\.paths/);
  assert.match((await risk([["config/app.yml", 2]], task, m)).reasons.join(), /review\.paths/);
  assert.match((await risk([["ops/run.sh", 2]], task, m)).reasons.join(), /review\.paths/);
  assert.equal((await risk([["src/other/x.ts", 2]], task, m)).review, false);
});

test("plan: missing plan or decisions answered by the user", async () => {
  assert.deepEqual((await risk([["a.ts", 2]], noPlan)).reasons, ["sin plan"]);
  assert.deepEqual((await risk([["a.ts", 2]], null)).reasons, ["sin plan"]);
  const asked: Decision = { question: "?", options: [], answer: "x", source: "docs/adr/0001.md" };
  assert.equal((await risk([["a.ts", 2]], { ...task, plan: { ...plan, decisions: [asked] } })).review, true);
  const settled: Decision = { question: "?", options: [], source: "docs/adr/0001.md" };
  assert.equal((await risk([["a.ts", 2]], { ...task, plan: { ...plan, decisions: [settled] } })).review, false);
});

test("always forces and never disables", async () => {
  assert.equal((await risk([], task, { ...base, review: { always: true } })).review, true);
  assert.equal((await risk([["package.json", 900]], task, { ...base, review: { never: true } })).review, false);
});

test("always wins over never", async () => {
  assert.deepEqual(await risk([], task, { ...base, review: { always: true, never: true } }), { review: true, level: "high", reasons: ["review.always"] });
});

test("git failures degrade to no diff", async () => {
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "risk-nogit-"));
  assert.equal((await assessRisk(notRepo, task, base)).review, false);
  assert.equal((await assessRisk(path.join(notRepo, "missing"), task, base)).review, false);
});

const lvl = async (...a: Parameters<typeof risk>) => (await risk(...a)).level;

test("levels: none for small clean diffs, low for medium size or doubt, high for triggers and huge diffs", async () => {
  assert.equal(await lvl([["src/a.ts", 10]]), "none");
  assert.equal(await lvl([["src/a.ts", 201]]), "low");
  assert.equal(await lvl([["src/a.ts", 599]]), "low");
  assert.equal(await lvl([["src/a.ts", 600]]), "high");
  const files = (n: number) => Array.from({ length: n }, (_, i) => [`src/f${i}.ts`, 1] as [string, number]);
  assert.equal(await lvl(files(7)), "low");
  assert.equal(await lvl(files(15)), "low");
  assert.equal(await lvl(files(16)), "high");
  assert.equal(await lvl([["a.ts", 2]], null), "low", "no plan: low");
  const asked: Decision = { question: "?", options: [], answer: "x", source: "docs/adr/0001.md" };
  assert.equal(await lvl([["a.ts", 2]], { ...task, plan: { ...plan, decisions: [asked] } }), "low");
});

test("levels: every strong trigger is high, and it wins over low reasons", async () => {
  for (const f of ["package.json", "yarn.lock", "db/migrate/001_x.rb", "src/auth/login.ts"]) assert.equal(await lvl([[f, 2]]), "high", f);
  assert.equal(await lvl([["src/core/x.ts", 2]], task, { ...base, review: { paths: ["src/core/"] } }), "high");
  assert.equal(await lvl([["package.json", 2]], null), "high");
  assert.equal((await risk([["src/a.ts", 300], ["package.json", 1]])).reasons.length, 2);
});

test("levels: thresholds come from review and never fall below the low ones", async () => {
  const m = (review: NonNullable<Manifest["review"]>): Manifest => ({ ...base, review });
  assert.equal(await lvl([["src/a.ts", 50]], task, m({ maxLines: 40 })), "low");
  assert.equal(await lvl([["src/a.ts", 300]], task, m({ maxLines: 400 })), "none");
  assert.equal(await lvl([["src/a.ts", 300]], task, m({ highLines: 250 })), "high");
  assert.equal(await lvl([["src/a.ts", 300]], task, m({ maxLines: 400, highLines: 100 })), "none", "high threshold is clamped to the low one");
  assert.equal(await lvl([["a.ts", 1], ["b.ts", 1]], task, m({ maxFiles: 1 })), "low");
  assert.equal(await lvl([["a.ts", 1], ["b.ts", 1]], task, m({ maxFiles: 0, highFiles: 1 })), "high");
  assert.equal(await lvl([["src/a.ts", 300]], task, m({ maxLines: Number.NaN })), "low", "invalid values fall back to the defaults");
});

test("levels: always is high, never is none, always wins", async () => {
  assert.equal(await lvl([], task, { ...base, review: { always: true } }), "high");
  assert.equal(await lvl([["package.json", 900]], task, { ...base, review: { never: true } }), "none");
  assert.equal(await lvl([], task, { ...base, review: { always: true, never: true } }), "high");
});

// ---------------------------------------------------------------------------
// baseCommit: the diff is measured from the commit the task started at
// ---------------------------------------------------------------------------

const sh = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
const lines = (n: number, tag = "l") => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join("\n") + "\n";

/** A repo whose implementer committed `committed` lines, then left `uncommitted` lines and `fresh` new files behind. */
async function implemented(opts: { committed?: number; uncommitted?: number; fresh?: string[] } = {}) {
  const root = repo();
  const baseCommit = await gitHead(root);
  if (opts.committed) {
    fs.writeFileSync(path.join(root, "big.ts"), lines(opts.committed));
    sh(root, "add", "-A");
    sh(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "impl");
  }
  if (opts.uncommitted) fs.writeFileSync(path.join(root, "README.md"), lines(opts.uncommitted, "r"));
  for (const f of opts.fresh ?? []) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), "x\n");
  }
  return { root, withBase: { ...task, ...(baseCommit ? { baseCommit } : {}) } as Task };
}

test("committed work: HEAD sees nothing, baseCommit sees the whole diff", async () => {
  const { root, withBase } = await implemented({ committed: 250 });
  assert.equal((await assessRisk(root, task, base)).level, "none", "no base: current behavior, the diff against HEAD is empty");
  const r = await assessRisk(root, withBase, base);
  assert.equal(r.level, "low");
  assert.match(r.reasons[0]!, /250 líneas/);
});

test("baseCommit adds commits, uncommitted changes and new files in new folders", async () => {
  const { root, withBase } = await implemented({ committed: 150, uncommitted: 60, fresh: ["new/dir/a.ts", "new/dir/b.ts"] });
  const r = await assessRisk(root, withBase, base);
  assert.equal(r.level, "low");
  assert.match(r.reasons[0]!, /215 líneas/, "150 committed + 61 (+60 -1) uncommitted + 2 per new file");
});

test("a risk trigger in a committed file is found through baseCommit", async () => {
  const root = repo();
  const baseCommit = await gitHead(root);
  fs.mkdirSync(path.join(root, "db/migrate"), { recursive: true });
  fs.writeFileSync(path.join(root, "db/migrate/001.rb"), "x\n");
  sh(root, "add", "-A");
  sh(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "m");
  assert.equal((await assessRisk(root, task, base)).level, "none");
  const r = await assessRisk(root, { ...task, ...(baseCommit ? { baseCommit } : {}) }, base);
  assert.equal(r.level, "high");
  assert.match(r.reasons.join(), /migración/);
});

test("an unknown baseCommit falls back to HEAD; withBaseCommit keeps the first base and degrades without git", async () => {
  const { root } = await implemented({ committed: 250 });
  assert.equal(await diffBase(root, { baseCommit: "deadbeefdeadbeef" }), "HEAD");
  assert.equal(await diffBase(root, { baseCommit: "--output=x" }), "HEAD", "not a hash: never passed to git");
  assert.equal(await diffBase(root, undefined), "HEAD");
  const first = await withBaseCommit(root, task);
  assert.equal(first.baseCommit, await gitHead(root));
  sh(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", "later");
  assert.equal((await withBaseCommit(root, task, first)).baseCommit, first.baseCommit, "same task: base kept");
  assert.notEqual((await withBaseCommit(root, { ...task, id: "other" }, first)).baseCommit, first.baseCommit, "another task: new base");
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "risk-nogit-"));
  assert.deepEqual(await withBaseCommit(notRepo, task), task);
  assert.equal(await gitHead(notRepo), undefined);
});
