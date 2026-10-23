// bin/wf-pr.mjs (the /pr injection) on temporary repos, and the frontmatter of the pr skill.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/wf-pr.mjs", import.meta.url));
const skill = fileURLToPath(new URL("../skills/pr/SKILL.md", import.meta.url));

function run(root: string, args: string[] = []): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
    execFile(process.execPath, ["--experimental-strip-types", bin, ...args], { env, cwd: root }, (error, stdout) =>
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout }),
    );
  });
}

const git = (root: string, ...args: string[]) =>
  new Promise<void>((resolve, reject) =>
    execFile("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], (e) => (e ? reject(e) : resolve())),
  );

async function put(root: string, file: string, text: string) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}

async function repo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "wf-pr-"));
  await git(root, "init", "-q", "-b", "main");
  await put(root, "README.md", "hi\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "init");
  return root;
}

test("wf-pr reports branch, commits, new ADRs, template, verify commands and risk", async () => {
  const root = await repo();
  await put(root, ".github/pull_request_template.md", "Closes #\n\n## Fuera de alcance\n");
  await put(root, ".claude/workflow.json", JSON.stringify({ version: 1, setup: "done", verify: ["make check"], connectors: [] }));
  await put(root, ".claude/workflow/task.json", JSON.stringify({ id: "t1", title: "Refund payments", ticket: "PAY-9", status: "implementing", allowedExtra: [], startedAt: "x" }));
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "setup");
  await git(root, "switch", "-qc", "task/PAY-9");
  await put(root, "src/refund.py", "x = 1\n");
  await put(root, "docs/adr/0001-rounding.md", "# Rounding\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "Add refund");
  await put(root, "docs/adr/0002-later.md", "# Later\n");

  const { code, stdout } = await run(root);
  assert.equal(code, 0);
  assert.match(stdout, /Current branch: task\/PAY-9\n/);
  assert.match(stdout, /Base: main/);
  assert.match(stdout, /\[PAY-9\] Refund payments/);
  assert.match(stdout, /[0-9a-f]+ Add refund/);
  assert.match(stdout, /## New ADRs\n- docs\/adr\/0001-rounding\.md\n- docs\/adr\/0002-later\.md \(uncommitted\)/);
  assert.match(stdout, /## PR template \(\.github\/pull_request_template\.md\)\nCloses #/);
  assert.match(stdout, /Verify commands \(from the manifest\)\n- make check/);
  assert.match(stdout, /## Risk\n/);
  assert.match(stdout, /gh installed: (yes|no)/);
});

test("wf-pr suggests task/<ticket> on the base branch and takes an explicit base", async () => {
  const root = await repo();
  await put(root, ".claude/workflow/task.json", JSON.stringify({ id: "t1", title: "T", ticket: "PAY-9", status: "implementing", allowedExtra: [], startedAt: "x" }));
  const { stdout } = await run(root);
  assert.match(stdout, /\(this is the base branch/);
  assert.match(stdout, /Suggested branch name: task\/PAY-9/);
  assert.match(stdout, /## PR template\n\(none in the repo/);
  assert.match(stdout, /missing or unreadable/);
  assert.match((await run(root, ["nope"])).stdout, /Base: main/);
});

test("wf-pr never fails: outside a git repo it says NOT READY and exits 0", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wf-pr-nogit-"));
  const { code, stdout } = await run(root);
  assert.equal(code, 0);
  assert.match(stdout, /^NOT READY: /);
});

test("skill pr: user-only, injected script covered by allowed-tools, no fixed verify command, never pushes unasked", async () => {
  const text = await readFile(skill, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(m);
  const meta = Object.fromEntries((m[1] ?? "").split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
  const body = m[2] ?? "";
  assert.equal(meta["name"], "pr");
  assert.equal(meta["disable-model-invocation"], "true");
  const prefix = "node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/bin/wf-pr.mjs";
  assert.equal(meta["allowed-tools"], `Bash(${prefix}:*)`);
  const injected = [...body.matchAll(/^!`([^`]+)`$/gm)].map((x) => x[1] ?? "");
  assert.equal(injected.length, 1);
  assert.ok(injected[0]?.startsWith(`${prefix} `));
  assert.doesNotMatch(body, /\b(tsc|eslint|jest|vitest|pytest|cargo test|go test|npm (test|run)|pnpm|yarn)\b/);
  assert.match(body, /\.claude\/workflow\.json/);
  assert.match(body, /never run `git push` or `gh pr create` until the user has confirmed/i);
  assert.match(body, /AskUserQuestion/);
  assert.match(body, /gh installed: yes/);
});
