import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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

function run(root: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--experimental-strip-types", entry, ...args], { env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: root } }, (err, stdout) => {
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
