import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../bin/wf-contract-check.mjs", import.meta.url));
const skillFile = fileURLToPath(new URL("../skills/contract-first/SKILL.md", import.meta.url));

/** A project with `files`; a git repo with one commit unless `git` is false. */
async function project(files: Record<string, string>, git = true): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "wf-contract-"));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  if (git) {
    const g = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
    g("init", "-q");
    g("add", "-A");
    g("commit", "-qm", "init", "--allow-empty");
  }
  return root;
}

const contract = (root: string, c: unknown) => writeFile(path.join(root, ".claude/workflow/contract.json"), typeof c === "string" ? c : JSON.stringify(c)).catch(async () => {
  await mkdir(path.join(root, ".claude/workflow"), { recursive: true });
  await writeFile(path.join(root, ".claude/workflow/contract.json"), typeof c === "string" ? c : JSON.stringify(c));
});

function run(root: string, args: string[] = [], bin = entry): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--experimental-strip-types", bin, ...args], { env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: root } }, (err, stdout) => {
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out: stdout });
    });
  });
}

// One tiny project per stack: the check reads text only, so the language is irrelevant.
const STACKS: Array<[string, string, string, string]> = [
  ["javascript", "src/slug.js", "export function slugify(text) { return text; }\n", "slugify"],
  ["python", "app/slug.py", "def slugify(text):\n    return text\n", "slugify"],
  ["go", "pkg/slug/slug.go", "package slug\n\nfunc Slugify(s string) string { return s }\n", "Slugify"],
  ["rust", "src/slug.rs", "pub fn slugify(s: &str) -> String { s.to_string() }\n", "slugify"],
  ["ruby", "lib/slug.rb", "module Slug\n  def self.slugify(s) = s\nend\n", "slugify"],
];

for (const [stack, file, code, name] of STACKS) {
  test(`${stack}: a new file with the name passes; a missing name fails and says which`, async () => {
    const root = await project({ "README.md": "# demo\n" });
    await mkdir(path.join(root, path.dirname(file)), { recursive: true });
    await writeFile(path.join(root, file), code);
    await contract(root, { files: [file], names: [name], notes: "assumed: sibling style" });
    const ok = await run(root);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /^CONTRACT OK: 1 file\(s\) exist, 1 name\(s\) found/);
    assert.match(ok.out, /Assumptions on record: assumed: sibling style/);

    await contract(root, { files: [file], names: [name, "notThere"] });
    const bad = await run(root);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /^CONTRACT NOT MET:/);
    assert.match(bad.out, /names not found .*: notThere/);
  });
}

test("a missing file is reported by path; a name inside a changed file that is not in the contract still counts", async () => {
  const root = await project({ "src/a.js": "export const a = 1;\n" });
  await writeFile(path.join(root, "src/a.js"), "export const a = 1;\nexport function extra() {}\n");
  await contract(root, { files: ["src/new.js"], names: ["extra"] });
  const r = await run(root);
  assert.equal(r.code, 1);
  assert.match(r.out, /- src\/new\.js: the file does not exist/);
  assert.doesNotMatch(r.out, /names not found/, "extra is in a changed file");
});

test("names match whole words only", async () => {
  const root = await project({ "src/a.js": "export const slugifyAll = 1;\n" });
  await contract(root, { files: ["src/a.js"], names: ["slugify"] });
  const r = await run(root);
  assert.equal(r.code, 1);
  assert.match(r.out, /names not found .*: slugify/);
});

test("a committed change is found through the task's baseCommit", async () => {
  const root = await project({ "src/a.js": "export const a = 1;\n" });
  const g = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
  const base = g("rev-parse", "HEAD");
  await writeFile(path.join(root, "src/b.js"), "export function brandNew() {}\n");
  g("add", "-A");
  g("commit", "-qm", "work");
  await contract(root, { files: [], names: ["brandNew"] });
  assert.equal((await run(root)).code, 1, "no files declared and nothing uncommitted: the name cannot be found");
  await writeFile(path.join(root, ".claude/workflow/task.json"), JSON.stringify({ id: "t", title: "t", status: "implementing", allowedExtra: [], startedAt: "x", baseCommit: base }));
  const r = await run(root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /searched 1 changed file\(s\)/);
});

test("without git the contract's own files are searched", async () => {
  const root = await project({ "src/slug.js": "export function slugify() {}\n" }, false);
  await contract(root, { files: ["src/slug.js"], names: ["slugify"] });
  const r = await run(root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /contract files only/);
  await contract(root, { files: ["src/slug.js"], names: ["other"] });
  assert.equal((await run(root)).code, 1);
});

test("no contract file: exit 1 with an example of what to write", async () => {
  const root = await project({ "a.txt": "x\n" });
  const r = await run(root);
  assert.equal(r.code, 1);
  assert.match(r.out, /^CONTRACT MISSING:/);
  assert.match(r.out, /"files"/);
});

test("malformed contracts exit 1 with the reason", async () => {
  const root = await project({ "a.txt": "x\n" });
  const cases: Array<[unknown, RegExp]> = [
    ["{nope", /not valid JSON/],
    ["[]", /must be a JSON object/],
    [{ files: "a.txt", names: [] }, /"files" must be a list/],
    [{ files: [], names: [1] }, /"names" must be a list/],
    [{ files: ["a.txt"], names: [""] }, /"names" must be a list of non-empty/],
    [{ files: [], names: [] }, /nothing to check/],
    [{ files: ["a.txt"], names: [], notes: 3 }, /"notes" must be a string/],
    [{ names: ["x"] }, /"files" must be a list/],
  ];
  for (const [c, re] of cases) {
    await contract(root, c);
    const r = await run(root);
    assert.equal(r.code, 1, JSON.stringify(c));
    assert.match(r.out, /^CONTRACT MALFORMED/, JSON.stringify(c));
    assert.match(r.out, re, JSON.stringify(c));
  }
});

test("a file path that escapes the project is refused, not read", async () => {
  const root = await project({ "a.txt": "x\n" });
  await contract(root, { files: ["../outside.txt"], names: [] });
  const r = await run(root);
  assert.equal(r.code, 1);
  assert.match(r.out, /outside the project/);
});

test("an explicit contract path argument is honored", async () => {
  const root = await project({ "a.py": "def thing(): pass\n", "other.json": JSON.stringify({ files: ["a.py"], names: ["thing"] }) });
  const r = await run(root, ["other.json"]);
  assert.equal(r.code, 0, r.out);
});

test("it is executable and runs through a symlink (the plugin's bin/ is added to PATH)", async () => {
  assert.ok(((await stat(entry)).mode & 0o111) !== 0, "chmod +x");
  assert.match((await readFile(entry, "utf8")).split("\n")[0]!, /^#!.*node/);
  const root = await project({ "a.py": "def thing(): pass\n" });
  await contract(root, { files: ["a.py"], names: ["thing"] });
  const dir = await mkdtemp(path.join(tmpdir(), "wf-contract-bin-"));
  const link = path.join(dir, "wf-contract-check.mjs");
  await symlink(entry, link);
  await chmod(entry, 0o755);
  const r = await new Promise<{ code: number; out: string }>((resolve) => {
    execFile(link, [], { env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, CLAUDE_PROJECT_DIR: root } }, (err, stdout) =>
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out: stdout }),
    );
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^CONTRACT OK/);
});

test("the contract-first skill is a short method skill with the validation checklist", async () => {
  const text = await readFile(skillFile, "utf8");
  assert.match(text, /^---\nname: contract-first\nuser-invocable: false\ndescription: /);
  for (const item of [/Wrong type/, /null \/ undefined/, /Empty/, /Out of range/, /Duplicates/]) assert.match(text, item);
  assert.match(text, /sibling/i);
  assert.match(text, /assum/i);
  assert.match(text, /\.claude\/workflow\/contract\.json/);
  // Unquoted, so a skill's allowed-tools pattern still matches it (quotes break it).
  assert.ok(text.includes("node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/bin/wf-contract-check.mjs"));
  assert.ok(text.split("\n").length <= 60, "short: it is read in context");
});

test("setup keeps the two CLAUDE.md sections short and task uses contract-first", async () => {
  const setup = await readFile(fileURLToPath(new URL("../skills/setup/SKILL.md", import.meta.url)), "utf8");
  assert.match(setup, /10-15 lines/);
  assert.match(setup, /## Before calling a task done/);
  assert.match(setup, /## Contract first/);
  assert.match(setup, /`contract-first` skill/);
  assert.match(setup, /wf-contract-check/);
  const task = await readFile(fileURLToPath(new URL("../skills/task/SKILL.md", import.meta.url)), "utf8");
  assert.match(task, /`contract-first` skill/);
  assert.match(task, /do not write a `contract\.json`/);
});
