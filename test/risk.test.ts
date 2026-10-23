import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { assessRisk } from "../lib/risk.ts";
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
  assert.deepEqual(await risk([["src/a.ts", 10], ["src/b.ts", 5]]), { review: false, reasons: [] });
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

test("git failures degrade to no diff", async () => {
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "risk-nogit-"));
  assert.equal((await assessRisk(notRepo, task, base)).review, false);
  assert.equal((await assessRisk(path.join(notRepo, "missing"), task, base)).review, false);
});
