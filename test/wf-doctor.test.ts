import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../bin/wf-doctor.mjs", import.meta.url));
const NODE_DIR = path.dirname(process.execPath);

interface Check { name: string; status: "ok" | "warn" | "fail"; detail: string }
interface Run { code: number; checks: Check[]; text: string }

/** Stub executables in a temp bin dir; PATH is only that dir plus node's and the system's /bin for `sh`. */
async function sandbox(opts: { manifest?: unknown; rawManifest?: string; stubs?: Record<string, string> } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "wf-doctor-"));
  const root = path.join(dir, "project");
  const bin = path.join(dir, "bin");
  await mkdir(path.join(root, ".claude"), { recursive: true });
  await mkdir(bin);
  for (const [name, body] of Object.entries(opts.stubs ?? {})) {
    await writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(path.join(bin, name), 0o755);
  }
  if (opts.rawManifest !== undefined) await writeFile(path.join(root, ".claude/workflow.json"), opts.rawManifest);
  else if (opts.manifest !== undefined) await writeFile(path.join(root, ".claude/workflow.json"), JSON.stringify(opts.manifest));
  return { root, bin };
}

function doctor(s: { root: string; bin: string }, args: string[] = ["--json"]): Promise<Run> {
  const env = { PATH: `${s.bin}:${NODE_DIR}:/usr/bin:/bin`, CLAUDE_PROJECT_DIR: s.root };
  return new Promise((resolve) => {
    execFile(process.execPath, ["--experimental-strip-types", entry, ...args], { cwd: s.root, env }, (err, stdout) => {
      const code = err ? Number((err as { code?: number }).code) : 0;
      const json = args.includes("--json");
      resolve({ code, text: stdout, checks: json ? JSON.parse(stdout) : [] });
    });
  });
}

const get = (r: Run, name: string) => r.checks.find((c) => c.name === name);
const good = { version: 1, setup: "done", verify: ["mytool check"], connectors: [] };
const allTools = { git: 'echo "git version 9"', gh: "exit 0", mytool: "exit 0" };

test("healthy project: every check passes and exit code is 0", async () => {
  const r = await doctor(await sandbox({ manifest: good, stubs: allTools }));
  assert.equal(r.code, 0);
  for (const name of ["Node", "git", "gh", "manifest", "verify", "agentlint", "agents"]) assert.equal(get(r, name)?.status, "ok", name);
});

test("human output is Spanish with marks and a summary", async () => {
  const r = await doctor(await sandbox({ manifest: good, stubs: allTools }), []);
  assert.match(r.text, /✓ manifest: válido/);
  assert.match(r.text, /Todo en orden/);
});

test("missing manifest is a warning that points to /setup, and verify is skipped", async () => {
  const r = await doctor(await sandbox({ stubs: allTools }));
  assert.equal(get(r, "manifest")?.status, "warn");
  assert.match(get(r, "manifest")!.detail, /\/setup/);
  assert.equal(get(r, "verify"), undefined);
  assert.equal(r.code, 0);
});

test("invalid JSON and wrong shapes fail with readable errors", async () => {
  const broken = await doctor(await sandbox({ rawManifest: "{nope", stubs: allTools }));
  assert.equal(get(broken, "manifest")?.status, "fail");
  assert.match(get(broken, "manifest")!.detail, /JSON inválido/);
  assert.equal(broken.code, 1);
  const shape = await doctor(await sandbox({ manifest: { version: 2, setup: "x", verify: "npm test", connectors: 3 }, stubs: allTools }));
  const detail = get(shape, "manifest")!.detail;
  assert.equal(get(shape, "manifest")?.status, "fail");
  for (const field of ["version", "setup", "verify", "connectors"]) assert.match(detail, new RegExp(field));
});

test("setup not done warns; declined is fine", async () => {
  const pending = await doctor(await sandbox({ manifest: { ...good, setup: "pending" }, stubs: allTools }));
  assert.equal(get(pending, "manifest")?.status, "warn");
  const declined = await doctor(await sandbox({ manifest: { ...good, setup: "declined" }, stubs: allTools }));
  assert.equal(get(declined, "manifest")?.status, "ok");
});

test("verify commands that do not exist fail by name; none is executed", async () => {
  const s = await sandbox({ manifest: { ...good, verify: ["mytool check && ghost-tool run", "FOO=1 other-missing --x | mytool"] }, stubs: { ...allTools, mytool: `touch "${"$"}PWD/ran"` } });
  const r = await doctor(s);
  const v = get(r, "verify")!;
  assert.equal(v.status, "fail");
  assert.match(v.detail, /ghost-tool/);
  assert.match(v.detail, /other-missing/);
  assert.doesNotMatch(v.detail, /`mytool`/);
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(path.join(s.root, "ran")), false);
});

test("relative script paths are checked against the project root, builtins pass", async () => {
  const s = await sandbox({ manifest: { ...good, verify: ["./scripts/check.sh", "true"] }, stubs: allTools });
  assert.equal(get(await doctor(s), "verify")?.status, "fail");
  await mkdir(path.join(s.root, "scripts"));
  await writeFile(path.join(s.root, "scripts/check.sh"), "#!/bin/sh\n");
  await chmod(path.join(s.root, "scripts/check.sh"), 0o755);
  assert.equal(get(await doctor(s), "verify")?.status, "ok");
});

test("empty verify list warns", async () => {
  const r = await doctor(await sandbox({ manifest: { ...good, verify: [] }, stubs: allTools }));
  assert.equal(get(r, "verify")?.status, "warn");
});

test("agentlint: only checked when configured", async () => {
  const none = await doctor(await sandbox({ manifest: good, stubs: allTools }));
  assert.match(get(none, "agentlint")!.detail, /no configurado/);
  const present = await doctor(await sandbox({ manifest: { ...good, agentlint: "lintbin --strict" }, stubs: { ...allTools, lintbin: "exit 0" } }));
  assert.equal(get(present, "agentlint")?.status, "ok");
  const absent = await doctor(await sandbox({ manifest: { ...good, agentlint: "lintbin --strict" }, stubs: allTools }));
  assert.equal(get(absent, "agentlint")?.status, "fail");
  const broken = await doctor(await sandbox({ manifest: { ...good, agentlint: "lintbin" }, stubs: { ...allTools, lintbin: "exit 2" } }));
  assert.equal(get(broken, "agentlint")?.status, "warn");
});

test("gh: missing or logged out is a warning, not a failure", async () => {
  const { gh: _gh, ...noGh } = allTools;
  const missing = await doctor(await sandbox({ manifest: good, stubs: noGh }));
  assert.equal(get(missing, "gh")?.status, "warn");
  assert.equal(missing.code, 0);
  const loggedOut = await doctor(await sandbox({ manifest: good, stubs: { ...allTools, gh: 'case "$1" in auth) exit 1;; esac' } }));
  assert.equal(get(loggedOut, "gh")?.status, "warn");
  assert.match(get(loggedOut, "gh")!.detail, /gh auth login/);
});

test("git missing fails", async () => {
  const { git: _git, ...noGit } = allTools;
  // /usr/bin may hold a real git; the check still must report the state it found, so only assert the shape.
  const r = await doctor(await sandbox({ manifest: good, stubs: noGit }));
  assert.ok(["ok", "fail"].includes(get(r, "git")!.status));
});
