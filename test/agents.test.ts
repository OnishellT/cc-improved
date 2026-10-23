import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const agentsDir = new URL("../agents/", import.meta.url);

type Frontmatter = Record<string, string | string[]>;
interface Agent {
  file: string;
  meta: Frontmatter;
  body: string;
}

/** Parses the YAML subset the agents use: `key: scalar`, `key: a, b` and `key:` followed by `  - item` lines. */
function parseAgent(file: string, text: string): Agent {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(match, `${file}: missing frontmatter`);
  const [, head = "", body = ""] = match;
  const meta: Frontmatter = {};
  let listKey: string | undefined;
  for (const line of head.split("\n")) {
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (item && listKey) {
      (meta[listKey] as string[]).push(item[1]!.trim());
      continue;
    }
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    assert.ok(pair, `${file}: unparsed frontmatter line ${JSON.stringify(line)}`);
    const [, key = "", value = ""] = pair;
    assert.ok(!(key in meta), `${file}: duplicate key ${key}`);
    if (value === "") {
      meta[key] = [];
      listKey = key;
    } else {
      meta[key] = value.trim();
      listKey = undefined;
    }
  }
  return { file, meta, body };
}

const list = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : v.split(",").map((s) => s.trim()));
const scalar = (a: Agent, key: string) => {
  const v = a.meta[key];
  assert.equal(typeof v, "string", `${a.file}: ${key} must be a scalar`);
  return v as string;
};

const READ_ONLY = ["Read", "Grep", "Glob"];
const WRITER = ["Read", "Edit", "Write", "Bash", "Grep", "Glob"];

// The full set: spike 0.4 forbids `${user_config.*}` in `model:`, so each strong role ships an opus and a sonnet variant
// and /task picks one through the Agent tool's `model` parameter.
const expected: Record<string, { model: string; tools: string[]; skills: string[]; verdict?: true; blocked?: true }> = {
  "plan-check": { model: "opus", tools: READ_ONLY, skills: [], verdict: true },
  "plan-check-sonnet": { model: "sonnet", tools: READ_ONLY, skills: [], verdict: true },
  reviewer: { model: "opus", tools: READ_ONLY, skills: ["blast-radius"], verdict: true },
  "reviewer-sonnet": { model: "sonnet", tools: READ_ONLY, skills: ["blast-radius"], verdict: true },
  implementer: { model: "inherit", tools: WRITER, skills: ["tdd"], blocked: true },
  fixer: { model: "opus", tools: WRITER, skills: ["diagnosing-bugs", "tdd"], blocked: true },
  "fixer-sonnet": { model: "sonnet", tools: WRITER, skills: ["diagnosing-bugs", "tdd"], blocked: true },
};

async function loadAgents(): Promise<Map<string, Agent>> {
  const files = (await readdir(agentsDir)).filter((f) => f.endsWith(".md")).sort();
  const agents = new Map<string, Agent>();
  for (const file of files) agents.set(file.slice(0, -3), parseAgent(file, await readFile(new URL(file, agentsDir), "utf8")));
  return agents;
}

test("agents/ holds exactly the expected agents, each named after its file", async () => {
  const agents = await loadAgents();
  assert.deepEqual([...agents.keys()].sort(), Object.keys(expected).sort());
  for (const [id, a] of agents) {
    assert.equal(scalar(a, "name"), id, `${a.file}: name must match the file name`);
    assert.ok(scalar(a, "description").length > 20, `${a.file}: description too short`);
    assert.ok(a.body.trim().length > 0, `${a.file}: empty prompt`);
  }
});

test("each agent has a literal model and minimal tools", async () => {
  for (const [id, a] of await loadAgents()) {
    const want = expected[id]!;
    const model = scalar(a, "model");
    assert.ok(!model.includes("${"), `${a.file}: model must be literal (spike 0.4)`);
    assert.equal(model, want.model, `${a.file}: model`);
    const tools = list(a.meta.tools);
    assert.deepEqual(tools, want.tools, `${a.file}: tools`);
    for (const banned of ["AskUserQuestion", "Agent", "Task", "WebFetch", "WebSearch"]) assert.ok(!tools.includes(banned), `${a.file}: must not have ${banned}`);
    assert.deepEqual(list(a.meta.skills), want.skills, `${a.file}: skills`);
    assert.ok(!("background" in a.meta), `${a.file}: background would keep /task from running it in the foreground (spike 0.5)`);
  }
});

test("read-only agents are bounded by maxTurns", async () => {
  for (const [, a] of await loadAgents()) {
    const readOnly = list(a.meta.tools).every((t) => READ_ONLY.includes(t));
    if (!readOnly) continue;
    const turns = Number(scalar(a, "maxTurns"));
    assert.ok(Number.isInteger(turns) && turns > 0, `${a.file}: maxTurns must be a positive integer`);
  }
});

test("prompts carry their output protocol and no fixed verification command", async () => {
  for (const [id, a] of await loadAgents()) {
    const want = expected[id]!;
    if (want.verdict) {
      assert.match(a.body, /`VERDICT: OK`/, `${a.file}: verdict OK`);
      assert.match(a.body, /`VERDICT: FIX`/, `${a.file}: verdict FIX`);
    }
    if (want.blocked) {
      assert.match(a.body, /`BLOCKED: </, `${a.file}: BLOCKED protocol`);
      assert.match(a.body, /`DONE`/, `${a.file}: DONE line`);
      assert.match(a.body, /`FAILED: </, `${a.file}: FAILED line`);
    }
    assert.doesNotMatch(a.body, /\b(npm|pnpm|yarn|npx|pytest|cargo|go test|tsc|eslint|mvn|gradle)\b/, `${a.file}: verification commands come from the brief`);
  }
});

test("each sonnet variant differs from its opus agent only in name, description and model", async () => {
  const agents = await loadAgents();
  for (const id of Object.keys(expected).filter((k) => k.endsWith("-sonnet"))) {
    const variant = agents.get(id)!;
    const base = agents.get(id.slice(0, -"-sonnet".length))!;
    assert.equal(variant.body, base.body, `${variant.file}: prompt must match ${base.file}`);
    const rest = (a: Agent) => Object.fromEntries(Object.entries(a.meta).filter(([k]) => !["name", "description", "model"].includes(k)));
    assert.deepEqual(rest(variant), rest(base), `${variant.file}: frontmatter must match ${base.file}`);
  }
});
