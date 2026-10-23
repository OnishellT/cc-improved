import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Manifest } from "../lib/types.ts";

const entry = fileURLToPath(new URL("../bin/wf-setup-finish.mjs", import.meta.url));
const skill = fileURLToPath(new URL("../skills/setup/SKILL.md", import.meta.url));

/** Files a complete /setup leaves behind. */
const COMPLETE: Record<string, string> = {
  "CLAUDE.md": "# Shop\n\nSee .claude/skills/domain-billing.\n",
  "GLOSSARY.md": "# Glossary\n\n- **Refund**: money returned to a customer.\n",
  "docs/adr/0001-use-postgres.md": "# Use Postgres\n\nContext. Decision. Consequences.\n",
  ".claude/skills/domain-billing/SKILL.md": "---\nname: domain-billing\ndescription: Billing vocabulary and invariants. Use when touching invoices.\n---\n\nBody.\n",
  ".claude/skills/verify-app/SKILL.md": "---\nname: verify-app\ndescription: How to run the app and see a change working.\n---\n\nBody.\n",
  ".claude/rules/api.md": "---\npaths:\n  - \"src/api/**\"\n---\n\nValidate inputs.\n",
};

async function project(files: Record<string, string> = COMPLETE): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "wf-setup-"));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
  return dir;
}

function run(root: string, args: string[], PATH = process.env.PATH): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--experimental-strip-types", entry, ...args], { env: { PATH, CLAUDE_PROJECT_DIR: root } }, (err, stdout) => {
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out: stdout });
    });
  });
}

const manifest = async (root: string) => JSON.parse(await readFile(path.join(root, ".claude/workflow.json"), "utf8")) as Manifest;
const without = (file: string) => Object.fromEntries(Object.entries(COMPLETE).filter(([f]) => f !== file));

test("--start marks setup running and keeps existing fields", async () => {
  const root = await project({ ".claude/workflow.json": JSON.stringify({ version: 1, setup: "pending", verify: ["make test"], connectors: [], review: { plan: false } }) });
  const r = await run(root, ["--start", "--language", "English"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /setup: running/);
  const m = await manifest(root);
  assert.equal(m.setup, "running");
  assert.equal(m.language, "English");
  assert.deepEqual(m.verify, ["make test"]);
  assert.deepEqual(m.review, { plan: false });
  assert.ok(m.startedAt);
  const again = await run(root, ["--start"]);
  assert.equal(again.code, 0);
  assert.equal((await manifest(root)).startedAt, m.startedAt, "startedAt survives a resume");
});

test("--pause sets pending so nothing pushes the model", async () => {
  const root = await project({});
  await run(root, ["--start"]);
  const r = await run(root, ["--pause"]);
  assert.equal(r.code, 0, r.out);
  const m = await manifest(root);
  assert.equal(m.setup, "pending");
  assert.ok(m.startedAt);
});

test("a complete setup with green verify writes setup done and the gitignore lines", async () => {
  const root = await project({ ...COMPLETE, ".gitignore": "node_modules/" });
  await run(root, ["--start", "--language", "Español"]);
  const r = await run(root, ["--step", "node -e \"process.exit(0)\"", "--step", "true"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /verify passed/);
  assert.match(r.out, /setup: done/);
  const m = await manifest(root);
  assert.equal(m.setup, "done");
  assert.deepEqual(m.verify, ["node -e \"process.exit(0)\"", "true"]);
  assert.equal(m.language, "Español");
  assert.ok(m.completedAt);
  assert.equal(await readFile(path.join(root, ".gitignore"), "utf8"), "node_modules/\n.claude/workflow/*\n!.claude/workflow/tasks.jsonl\n");
});

test("an existing .claude/workflow/ ignore line is left alone", async () => {
  const root = await project({ ...COMPLETE, ".gitignore": ".claude/workflow/\n" });
  const r = await run(root, ["--step", "true"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(await readFile(path.join(root, ".gitignore"), "utf8"), ".claude/workflow/\n");
});

test("missing outputs are listed and setup is not marked done", async () => {
  const root = await project({});
  await run(root, ["--start"]);
  const r = await run(root, []);
  assert.equal(r.code, 1);
  for (const re of [/CLAUDE\.md is missing/, /GLOSSARY\.md is missing/, /No domain skill/, /verify-app\/SKILL\.md is missing/, /docs\/adr\/ is missing/, /No verify steps/]) assert.match(r.out, re);
  assert.equal((await manifest(root)).setup, "running");
});

test("malformed skills, ADRs and rules are reported", async () => {
  const root = await project({
    ...COMPLETE,
    ".claude/skills/domain-orders/SKILL.md": "No frontmatter.\n",
    ".claude/skills/domain-stock/SKILL.md": "---\nname: stock\ndescription: x\n---\n",
    "docs/adr/use-redis.md": "# Use Redis\n",
    "docs/adr/0002-untitled.md": "no title\n",
    ".claude/rules/db.md": "Always use migrations.\n",
  });
  const r = await run(root, ["--step", "true"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /domain-orders\/SKILL\.md needs frontmatter/);
  assert.match(r.out, /name "stock" must match its folder "domain-stock"/);
  assert.match(r.out, /use-redis\.md: name it NNNN/);
  assert.match(r.out, /0002-untitled\.md needs a "# " title/);
  assert.match(r.out, /rules\/db\.md needs frontmatter with "paths:"/);
});

test("CLAUDE.md over the line budget is rejected", async () => {
  const root = await project({ ...COMPLETE, "CLAUDE.md": "line\n".repeat(250) });
  const r = await run(root, ["--step", "true"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /CLAUDE\.md has more than 200 lines/);
});

test("a connector with a server needs it in .mcp.json", async () => {
  const root = await project(COMPLETE);
  const missing = await run(root, ["--step", "true", "--connector", "jira:jira"]);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /\.mcp\.json is missing/);
  await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } } }));
  const wrong = await run(root, ["--step", "true", "--connector", "jira:jira"]);
  assert.match(wrong.out, /no mcpServers\.jira/);
  await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { jira: { type: "http", url: "https://mcp.atlassian.com/v1/mcp" } } }));
  const ok = await run(root, ["--step", "true", "--connector", "jira:jira", "--connector", "slack"]);
  assert.equal(ok.code, 0, ok.out);
  assert.deepEqual((await manifest(root)).connectors, [{ id: "jira", server: "jira" }, { id: "slack" }]);
});

test("failing verify keeps setup running with the steps saved; the report names the step", async () => {
  const root = await project(COMPLETE);
  await run(root, ["--start"]);
  const r = await run(root, ["--step", "true", "--step", "node -e \"console.error('boom');process.exit(4)\""]);
  assert.equal(r.code, 1);
  assert.match(r.out, /verify FAILED/);
  assert.match(r.out, /exit code 4/);
  assert.match(r.out, /boom/);
  const m = await manifest(root);
  assert.equal(m.setup, "running");
  assert.equal(m.verify.length, 2);
  const resumed = await run(root, ["--accept-failing-verify"]);
  assert.equal(resumed.code, 0, resumed.out);
  assert.match(resumed.out, /verify still fails/);
  assert.equal((await manifest(root)).setup, "done");
});

test("agentlint adds its check as the last verify step and needs its config", async () => {
  const root = await project(COMPLETE);
  const missing = await run(root, ["--step", "true", "--agentlint", "node agentlint.mjs"]);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /agentlint is not configured/);
  await mkdir(path.join(root, ".agentlint"));
  await writeFile(path.join(root, ".agentlint/config.ts"), "export default {}\n");
  await writeFile(path.join(root, "agentlint.mjs"), "console.log(process.argv.slice(2).join(' ') === 'rules test' ? 'No matching rules' : 'ok'); process.exit(process.argv[2] === 'rules' ? 1 : 0);\n");
  const r = await run(root, ["--step", "true", "--agentlint", "node agentlint.mjs"]);
  assert.equal(r.code, 0, r.out);
  const m = await manifest(root);
  assert.deepEqual(m.verify, ["true", "node agentlint.mjs check --all"]);
  assert.equal(m.agentlint, "node agentlint.mjs");
});

test("an invalid manifest or bad arguments fail without writing", async () => {
  const root = await project({ ...COMPLETE, ".claude/workflow.json": "{ nope" });
  const r = await run(root, ["--step", "true"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /not valid JSON/);
  assert.equal(await readFile(path.join(root, ".claude/workflow.json"), "utf8"), "{ nope");
  const bad = await run(root, ["--bogus"]);
  assert.equal(bad.code, 2);
  assert.match(bad.out, /unknown argument --bogus/);
  assert.equal((await run(root, ["--step"])).code, 2);
});

test("a manifest with the wrong shape is reported", async () => {
  const root = await project({ ...COMPLETE, ".claude/workflow.json": JSON.stringify({ version: 2, setup: "maybe", verify: "npm test", connectors: [] }) });
  const r = await run(root, []);
  assert.equal(r.code, 1);
  assert.match(r.out, /"version" must be 1/);
  assert.match(r.out, /"setup" must be one of/);
  assert.match(r.out, /"verify" must be a list/);
});

test("the setup skill injects the scan and ends with wf-setup-finish", async () => {
  const text = await readFile(skill, "utf8");
  assert.match(text, /^---\nname: setup\ndescription: \S/);
  assert.match(text, /disable-model-invocation: true/);
  assert.ok(text.includes("!`node ${CLAUDE_PLUGIN_ROOT}/bin/wf-scan.mjs`"));
  assert.ok(text.includes("${CLAUDE_PLUGIN_ROOT}/bin/wf-setup-finish.mjs"));
  assert.match(text, /AskUserQuestion/);
  for (const out of ["CLAUDE.md", "GLOSSARY.md", "docs/adr/", ".claude/skills/domain-", ".claude/skills/verify-app", ".claude/rules/", "paths:", ".mcp.json", "agentlint"]) assert.ok(text.includes(out), out);
});

// ---------------------------------------------------------------------------
// Verification tools: generated inside the project (python stdlib or nix), validated, never shipped by the plugin.
// ---------------------------------------------------------------------------

const templates = fileURLToPath(new URL("../skills/create-verification-skill/references/verify-tools/", import.meta.url));
const SH = execFileSync("sh", ["-c", "command -v sh"], { encoding: "utf8" }).trim();
const hasPython = (() => {
  try {
    execFileSync("python3", ["-c", "import sys; assert sys.version_info >= (3, 10)"]);
    return true;
  } catch {
    return false;
  }
})();

const skillNaming = (...commands: string[]) =>
  `---\nname: verify-app\ndescription: How to run the app and see a change working.\n---\n\n## Tools\n\n${commands.map((c) => `- \`${c}\`: when to use it, what its output means.`).join("\n")}\n`;

async function addFile(root: string, file: string, content: string, mode = 0o755) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
  await chmod(path.join(root, file), mode);
}

/** A bin dir holding only `sh` (and the given stubs), so no python3, nix or nix-shell is found unless stubbed. */
async function bareBin(stubs: Record<string, string> = {}): Promise<string> {
  const bin = await mkdtemp(path.join(tmpdir(), "wf-setup-bin-"));
  await symlink(SH, path.join(bin, "sh"));
  for (const [name, body] of Object.entries(stubs)) await addFile(bin, name, `#!${SH}\n${body}\n`);
  return bin;
}

/** Stubs for nix-shell (`<env> --run "<cmd>"`) and nix (`... --command <cmd...>`): they run the inner command as is. */
const NIX_STUBS = {
  "nix-shell": 'test -f "$1" || exit 9; [ "$2" = "--run" ] || exit 8; exec sh -c "$3"',
  nix: 'while [ $# -gt 0 ] && [ "$1" != "--command" ]; do shift; done; shift; exec "$@"',
};

test("a python stdlib tool from the template passes and is recorded with its exact command", { skip: !hasPython && "python3 >= 3.10 is not installed" }, async () => {
  const root = await project({ ...COMPLETE, ".claude/skills/verify-app/SKILL.md": skillNaming("python3 tools/verify/check_http.py --url <url>") });
  await addFile(root, "tools/verify/check_http.py", await readFile(path.join(templates, "python-tool.py"), "utf8"));
  const r = await run(root, ["--step", "true", "--tool", "python:./tools/verify/check_http.py"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Verification tools/);
  assert.ok(r.out.includes("- python3 tools/verify/check_http.py"), r.out);
  assert.match(r.out, /setup: done/);
  assert.deepEqual((await manifest(root)).tools, [{ path: "tools/verify/check_http.py", runtime: "python" }]);
  // A later run without --tool validates the recorded tools again.
  await chmod(path.join(root, "tools/verify/check_http.py"), 0o644);
  const again = await run(root, ["--step", "true"]);
  assert.equal(again.code, 1);
  assert.match(again.out, /is not executable: chmod \+x tools\/verify\/check_http\.py/);
});

test("a python tool that is missing, unnamed, not stdlib-only or fails --help is rejected", { skip: !hasPython && "python3 >= 3.10 is not installed" }, async () => {
  const root = await project({ ...COMPLETE, ".claude/skills/verify-app/SKILL.md": skillNaming("python3 tools/verify/deps.py", "python3 tools/verify/broken.py") });
  await addFile(root, "tools/verify/deps.py", "#!/usr/bin/env python3\nimport json\nimport requests\nfrom helper import x\nprint('help')\n");
  await addFile(root, "tools/verify/helper.py", "x = 1\n", 0o644);
  await addFile(root, "tools/verify/broken.py", "#!/usr/bin/env python3\nimport sys\nsys.exit(3)\n");
  await addFile(root, "tools/verify/unnamed.py", "#!/usr/bin/env python3\nprint('usage: unnamed')\n");
  const r = await run(root, ["--step", "true", ...["deps.py", "broken.py", "unnamed.py", "ghost.py"].flatMap((f) => ["--tool", `python:tools/verify/${f}`])]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /deps\.py imports modules outside the Python standard library \(requests\)/);
  assert.doesNotMatch(r.out, /helper/, "a module next to the tool is local, not a dependency");
  assert.match(r.out, /`python3 tools\/verify\/broken\.py --help` exited 3/);
  assert.match(r.out, /verify-app\/SKILL\.md does not name tool tools\/verify\/unnamed\.py: add its exact command \(python3 tools\/verify\/unnamed\.py\)/);
  assert.match(r.out, /tool tools\/verify\/ghost\.py does not exist/);
  assert.notEqual((await manifest(root).catch(() => ({ setup: "absent" }))).setup, "done");
});

test("a nix tool degrades to a warning when nix is not installed, and setup still finishes", async () => {
  const root = await project({ ...COMPLETE, ".claude/skills/verify-app/SKILL.md": skillNaming("nix-shell tools/ui/shell.nix --run 'tools/ui/smoke.sh --url <url>'") });
  await addFile(root, "tools/ui/smoke.sh", await readFile(path.join(templates, "nix/check-tool.sh"), "utf8"));
  await addFile(root, "tools/ui/shell.nix", await readFile(path.join(templates, "nix/shell.nix"), "utf8"), 0o644);
  const r = await run(root, ["--step", "true", "--tool", "nix:tools/ui/smoke.sh"], await bareBin());
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /! tool tools\/ui\/smoke\.sh: `nix-shell` is not installed here, so --help was not checked/);
  assert.match(r.out, /setup: done/);
  assert.deepEqual((await manifest(root)).tools, [{ path: "tools/ui/smoke.sh", runtime: "nix", env: "tools/ui/shell.nix" }]);
});

test("python and nix tools (shell.nix and flake) pass together when their runtimes answer --help", async () => {
  const root = await project({
    ...COMPLETE,
    ".claude/skills/verify-app/SKILL.md": skillNaming("python3 tools/verify/check.py", "nix-shell tools/ui/shell.nix --run 'tools/ui/smoke.sh'", "nix ... --command tools/cli/run.sh"),
  });
  await addFile(root, "tools/verify/check.py", "#!/usr/bin/env python3\nimport sys\nprint('usage: check.py')\n");
  await addFile(root, "tools/ui/smoke.sh", await readFile(path.join(templates, "nix/check-tool.sh"), "utf8"));
  await addFile(root, "tools/ui/shell.nix", await readFile(path.join(templates, "nix/shell.nix"), "utf8"), 0o644);
  await addFile(root, "tools/cli/run.sh", `#!${SH}\necho "usage: run.sh"\n`);
  await addFile(root, "tools/cli/flake.nix", await readFile(path.join(templates, "nix/flake.nix"), "utf8"), 0o644);
  // Stubbed nix binaries in front of the real PATH: bash runs the template, python3 stays whatever the machine has.
  const bin = await bareBin(NIX_STUBS);
  const r = await run(root, ["--step", "true", "--tool", "python:tools/verify/check.py", "--tool", "nix:tools/ui/smoke.sh", "--tool", "nix:tools/cli/run.sh"], `${bin}:${process.env.PATH}`);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes("- nix-shell tools/ui/shell.nix --run 'tools/ui/smoke.sh'"), r.out);
  assert.ok(r.out.includes("- nix --extra-experimental-features 'nix-command flakes' develop path:./tools/cli --command tools/cli/run.sh"), r.out);
  assert.deepEqual((await manifest(root)).tools?.map((t) => t.env), [undefined, "tools/ui/shell.nix", "tools/cli/flake.nix"]);
});

test("a nix tool without a pinned env, or whose --help fails, is rejected", async () => {
  const root = await project({ ...COMPLETE, ".claude/skills/verify-app/SKILL.md": skillNaming("tools/a/loose.sh", "tools/b/bad.sh") });
  await addFile(root, "tools/a/loose.sh", `#!${SH}\necho usage\n`);
  await addFile(root, "tools/b/bad.sh", `#!${SH}\nexit 5\n`);
  await addFile(root, "tools/b/shell.nix", "{ }\n", 0o644);
  const r = await run(root, ["--step", "true", "--tool", "nix:tools/a/loose.sh", "--tool", "nix:tools/b/bad.sh"], await bareBin(NIX_STUBS));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /tools\/a\/loose\.sh declares runtime nix but has no flake\.nix or shell\.nix next to it/);
  assert.match(r.out, /`nix-shell tools\/b\/shell\.nix --run 'tools\/b\/bad\.sh --help'` exited 5/);
});

test("--tool needs a known runtime and a path inside the repo", async () => {
  const root = await project(COMPLETE);
  for (const spec of ["ruby:tools/x.rb", "tools/x.py", "python:../outside.py", "python:/abs/x.py", "python:"]) {
    const r = await run(root, ["--step", "true", "--tool", spec]);
    assert.equal(r.code, 2, `${spec}: ${r.out}`);
    assert.match(r.out, /--tool/);
  }
});

test("a manifest with malformed tools is reported", async () => {
  const root = await project({ ...COMPLETE, ".claude/workflow.json": JSON.stringify({ version: 1, setup: "running", verify: ["true"], connectors: [], tools: [{ path: "x.rb", runtime: "ruby" }] }) });
  const r = await run(root, []);
  assert.equal(r.code, 1);
  assert.match(r.out, /"tools" must be a list/);
});

test("the setup and verification skills explain the tool contract without shipping a tool", async () => {
  const setup = await readFile(skill, "utf8");
  for (const s of ["--tool", "python", "nix", "--help", "tools/verify/", "Tools"]) assert.ok(setup.includes(s), s);
  const method = await readFile(fileURLToPath(new URL("../skills/create-verification-skill/SKILL.md", import.meta.url)), "utf8");
  for (const s of ["--help", "standard library", "shell.nix", "flake.nix", "references/verify-tools/python-tool.py", "--tool <python|nix>:<path>", "EXAMPLES"]) assert.ok(method.includes(s), s);
  for (const file of ["python-tool.py", "nix/check-tool.sh", "nix/shell.nix", "nix/flake.nix"]) assert.match(await readFile(path.join(templates, file), "utf8"), /TEMPLATE/, file);
});
