// The workflow skills the user types: /task, /done and /verify. Frontmatter, injected commands and the plan template.
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parsePlan } from "../lib/plan.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

interface Skill {
  name: string;
  meta: Record<string, string>;
  body: string;
}

/** Parses the frontmatter subset these skills use: one `key: value` per line, values optionally double-quoted. */
async function load(name: string): Promise<Skill> {
  const text = await readFile(`${root}skills/${name}/SKILL.md`, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(match, `${name}: missing frontmatter`);
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const pair = /^([a-z][\w-]*):\s*(.*)$/.exec(line);
    assert.ok(pair, `${name}: unparsed frontmatter line ${JSON.stringify(line)}`);
    const [, key = "", raw = ""] = pair;
    assert.ok(!(key in meta), `${name}: duplicate key ${key}`);
    meta[key] = raw.trim().replace(/^"(.*)"$/, "$1");
  }
  return { name, meta, body: match[2] ?? "" };
}

const KNOWN = new Set(["name", "description", "argument-hint", "disable-model-invocation", "allowed-tools", "user-invocable", "model"]);
// Who may invoke each skill: /task and /done are the user's act (start and close a task); /verify only reports.
const expected: Record<string, { userOnly: boolean; scripts: string[] }> = {
  task: { userOnly: true, scripts: ["wf-related.mjs"] },
  done: { userOnly: true, scripts: ["wf-done.mjs"] },
  verify: { userOnly: false, scripts: [] },
};

for (const [name, want] of Object.entries(expected)) {
  test(`skill ${name}: frontmatter`, async () => {
    const s = await load(name);
    for (const key of Object.keys(s.meta)) assert.ok(KNOWN.has(key), `${name}: unknown frontmatter key ${key}`);
    assert.equal(s.meta.name, name);
    assert.ok((s.meta.description ?? "").length > 40, `${name}: description too short`);
    assert.equal(s.meta["disable-model-invocation"], want.userOnly ? "true" : undefined);
    assert.notEqual(s.meta["user-invocable"], "false", `${name}: the user types this skill`);
    assert.ok(s.body.trim().length > 0);
  });

  test(`skill ${name}: injected commands run the plugin's own scripts, and allowed-tools covers each`, async () => {
    const s = await load(name);
    const injected = [...s.body.matchAll(/^!`([^`]+)`$/gm)].map((m) => m[1] ?? "");
    assert.equal(injected.length, want.scripts.length, `${name}: injected commands`);
    for (const [i, script] of want.scripts.entries()) {
      const command = injected[i] ?? "";
      const prefix = `node --experimental-strip-types \${CLAUDE_PLUGIN_ROOT}/bin/${script}`;
      // Permission matching is literal: a quoted script path does not match the rule and the injection is refused.
      assert.ok(command === prefix || command.startsWith(`${prefix} `), `${name}: ${command} must start with ${prefix}`);
      assert.ok((s.meta["allowed-tools"] ?? "").split(", ").includes(`Bash(${prefix}:*)`), `${name}: allowed-tools covers ${script}`);
      await access(`${root}bin/${script}`);
    }
    if (!want.scripts.length) assert.equal(s.meta["allowed-tools"], undefined);
  });

  test(`skill ${name}: no fixed verification command (they come from the manifest)`, async () => {
    const s = await load(name);
    assert.doesNotMatch(s.body, /\b(tsc|eslint|jest|vitest|pytest|cargo test|go test|npm (test|run)|pnpm|yarn)\b/);
    if (name !== "done") assert.match(s.body, /\.claude\/workflow\.json/);
  });
}

test("skill task: the wf-plan template is a single block that parses and validates", async () => {
  const s = await load("task");
  const result = parsePlan(s.body);
  assert.ok("plan" in result, "errors" in result ? result.errors.join("\n") : "");
  const { plan } = result;
  for (const seam of plan.seams) assert.ok(plan.files.includes(seam.testFile), `seam test file ${seam.testFile} not in files`);
  for (const d of plan.decisions) if (d.source.startsWith("docs/adr/")) assert.ok(plan.files.includes(d.source));
});

test("skill task: related tasks get the request, plan mode is entered and the implementer runs in the foreground", async () => {
  const { body } = await load("task");
  assert.match(body, /wf-related\.mjs "\$ARGUMENTS"`$/m);
  assert.match(body, /EnterPlanMode/);
  assert.match(body, /ExitPlanMode/);
  assert.match(body, /AskUserQuestion/);
  assert.match(body, /subagent_type: "cc-improved:implementer"/);
  assert.match(body, /run_in_background: false/);
  // Each named agent exists, so the prefix and the -sonnet variants stay in step with agents/.
  const agents = new Set((await readdir(`${root}agents`)).map((f) => f.replace(/\.md$/, "")));
  for (const [, agent] of body.matchAll(/cc-improved:([a-z-]+)/g)) assert.ok(agents.has(agent ?? ""), `unknown agent ${agent}`);
  for (const strong of ["plan-check", "reviewer", "fixer"]) assert.ok(agents.has(`${strong}-sonnet`));
  assert.match(body, /\$\{user_config\.strong_model\}/);
});

test("skill done: reports the script's outcome and runs the retro only when it is due", async () => {
  const { body } = await load("done");
  for (const marker of ["CLOSED", "NOT CLOSED", "RETRO DUE"]) assert.ok(body.includes(`\`${marker}\``), marker);
  assert.match(body, /retro/);
  assert.match(body, /maintain-verification-skill/);
  assert.match(body, /Never write them without the user's approval/);
});

test("skill task: the implementer brief lists the project's verification tools from the verify-app skill", async () => {
  const { body } = await load("task");
  assert.match(body, /Keep its `verify` list, its `connectors` and its `tools`/);
  assert.match(body, /\*\*Tools\*\* section of `\.claude\/skills\/verify-app\/SKILL\.md`/);
  const brief = /```\n\s*Plan:[\s\S]*?```/.exec(body)?.[0] ?? "";
  assert.match(brief, /Tools \(verify-app skill\)/);
  assert.match(brief, /`<exact command>`/);
  assert.match(brief, /wf-plan: <the accepted wf-plan JSON/);
  assert.match(brief, /Verify \(repo root, in order\)/);
});

test("skill setup: runs on the large model, a literal `opus` (user_config is not substituted in `model:`, D-010)", async () => {
  const s = await load("setup");
  assert.equal(s.meta.model, "opus");
  assert.equal(s.meta["disable-model-invocation"], "true");
  assert.match(s.meta["allowed-tools"] ?? "", /AskUserQuestion/, "setup asks in the main thread");
});

test("skill setup: with setup done it warns about the cost and asks before repeating", async () => {
  const { body } = await load("setup");
  const start = body.slice(body.indexOf("1. **Start.**"), body.indexOf("2. **Read.**"));
  assert.match(start, /`manifest\.setup` is `"done"`/);
  assert.match(start, /costs far more/);
  assert.match(start, /do not run `--start`/);
  assert.ok(start.indexOf('"done"') < start.indexOf("--start --language"), "the confirmation comes before --start");
});

test("skill task: small tasks take the fast route through wf-plan-validate; big or risky ones keep plan mode (D-009)", async () => {
  const { meta, body } = await load("task");
  assert.match(meta["allowed-tools"] ?? "", /bin\/wf-plan-validate\.mjs/);
  assert.match(body, /\*\*fast route\*\*/);
  assert.match(body, /wf-plan-validate\.mjs \.claude\/workflow\/plan\.md/);
  assert.match(body, /ACCEPTED/);
  assert.match(body, /REJECTED/);
  assert.match(body, /at most 5 files, 3 `interface` entries and 1 decision/);
  assert.match(body, /any doubt means plan mode/);
});
