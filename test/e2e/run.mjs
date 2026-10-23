#!/usr/bin/env node
// End-to-end run of the whole task flow against real Claude Code, on a COPY of a throwaway test repo.
// Costs money: it is `npm run e2e`, never part of `npm test` or CI.
//
// Usage: E2E_WORK=<empty or throwaway dir> npm run e2e
//   E2E_BUDGET   total cap in USD for all claude calls (default 1). Each call gets --max-budget-usd of what is left.
//   E2E_MODEL    session model (default claude-haiku-5-5). Not the `haiku` alias: in plan mode Claude Code 2.1.309
//                upgrades the alias `haiku` to sonnet ("haiku plan upgrade"), and the full id is not upgraded.
//   E2E_STRONG   strong_model plugin option (default sonnet: the -sonnet variants, cheaper than opus).
//   E2E_REQUEST  the /task prompt (default below).
//
// Flow under test (PLAN-claude-code.md, phase 2): plan denied for an invented name → fixed → plan check → approval →
// implementer blocked by verify → fixed → review by risk → /done writes the record.
// Plan mode needs a permission host in `-p` (spike 0.1: without --permission-prompt-tool stdio, ExitPlanMode does
// not exist), so phase 1 runs claude under `host`, which plays the person: it approves every permission request,
// the plan included, and answers each AskUserQuestion with its first (recommended) option.
// Output: <work>/run-<stamp>/ with the repo, the stream (phase1.jsonl), host.log, done.json and report.json.
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WORK = process.env.E2E_WORK;
const BUDGET = Number(process.env.E2E_BUDGET ?? "1");
const MODEL = process.env.E2E_MODEL ?? "claude-haiku-5-5";
const STRONG = process.env.E2E_STRONG ?? "sonnet";
const PHASE1_TIMEOUT_MS = 25 * 60_000;
// The person names the export in the request; the spec does not. The request text is not evidence for the plan
// gate, so a plan that uses the name without asking is denied as an invented name.
const REQUEST = process.env.E2E_REQUEST ?? "/cc-improved:task SLUG-1: post URLs need a slug built from the post title; export it as makeSlug. Spec: docs/specs/slug.md";

if (!WORK) {
  console.error("E2E_WORK is not set: point it at a throwaway directory (never a real repo).");
  process.exit(2);
}
const work = path.resolve(WORK);
mkdirSync(work, { recursive: true });
const insideGit = (() => {
  try {
    execFileSync("git", ["-C", work, "rev-parse", "--show-toplevel"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();
if (insideGit) {
  console.error(`${work} is inside a git repo; use a throwaway directory outside any repo.`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Test repo: a tiny ESM project with a sibling module, a spec that does not name the export, and two verify steps.
// ---------------------------------------------------------------------------

const FILES = {
  "package.json": JSON.stringify({ name: "blog-e2e", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  ".gitignore": ".claude/workflow/task.json\nnode_modules/\n",
  "CLAUDE.md": [
    "# blog-e2e",
    "",
    "Plain ESM JavaScript, no dependencies. Tests use node:test and live next to the module (`<name>.test.js`).",
    "",
  ].join("\n"),
  "src/strings/title-case.js": [
    "/** Title Case for headings: first letter of each word upper case, the rest unchanged. */",
    "export function titleCase(text) {",
    '  if (typeof text !== "string") throw new TypeError("titleCase: text must be a string");',
    "  return text.replace(/(^|\\s)(\\S)/g, (_, space, ch) => space + ch.toUpperCase());",
    "}",
    "",
  ].join("\n"),
  "src/strings/title-case.test.js": [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { titleCase } from "./title-case.js";',
    "",
    'test("titleCase upper-cases the first letter of each word", () => {',
    '  assert.equal(titleCase("hello big world"), "Hello Big World");',
    "});",
    "",
  ].join("\n"),
  "scripts/check-jsdoc.mjs": [
    "// Verify step: every exported function in src/ (tests excluded) has a JSDoc block right above it.",
    'import { readdirSync, readFileSync, statSync } from "node:fs";',
    'import { join } from "node:path";',
    "const bad = [];",
    "const walk = (dir) => {",
    "  for (const name of readdirSync(dir)) {",
    "    const file = join(dir, name);",
    "    if (statSync(file).isDirectory()) walk(file);",
    '    else if (name.endsWith(".js") && !name.endsWith(".test.js")) {',
    '      const lines = readFileSync(file, "utf8").split("\\n");',
    "      lines.forEach((line, i) => {",
    "        if (/^export (async )?function /.test(line) && !/\\*\\/\\s*$/.test(lines[i - 1] ?? \"\")) bad.push(`${file}:${i + 1}: ${line.trim()}`);",
    "      });",
    "    }",
    "  }",
    "};",
    'walk("src");',
    "if (bad.length) {",
    '  console.error("Exported functions without a JSDoc block (/** ... */) on the line right above:\\n" + bad.join("\\n"));',
    "  process.exit(1);",
    "}",
    'console.log("jsdoc: ok");',
    "",
  ].join("\n"),
  "docs/specs/slug.md": [
    "# SLUG-1: URL slugs for posts",
    "",
    "Post URLs need a slug built from the post title. Add a new module `src/strings/slug.js`, next to `title-case.js`.",
    "",
    "Acceptance criteria:",
    "",
    "1. Lower case; only ASCII letters and digits are kept, accents are removed (`é` becomes `e`).",
    "2. Any run of other characters becomes a single hyphen; no leading or trailing hyphen.",
    "3. An optional maximum length cuts the slug at the last hyphen at or before the limit.",
    "4. Input that is not a string throws a `TypeError`.",
    "",
  ].join("\n"),
  ".claude/workflow.json": JSON.stringify(
    { version: 1, setup: "done", verify: ["npm test", "node scripts/check-jsdoc.mjs"], review: { paths: ["src/"] }, connectors: [] },
    null,
    2,
  ) + "\n",
};

function writeTemplate(dir) {
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-qm", "test repo");
}

// ---------------------------------------------------------------------------
// claude runs
// ---------------------------------------------------------------------------

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.join(work, `run-${stamp}`);
const template = path.join(runDir, "template");
const repo = path.join(runDir, "repo");
mkdirSync(runDir, { recursive: true });
writeTemplate(template);
cpSync(template, repo, { recursive: true });

const settings = JSON.stringify({ pluginConfigs: { "cc-improved@inline": { options: { strong_model: STRONG } } } });
const common = (budget) => [
  "--plugin-dir", PLUGIN_ROOT,
  "--model", MODEL,
  "--setting-sources", "project",
  "--strict-mcp-config",
  "--settings", settings,
  "--max-budget-usd", budget.toFixed(2),
];
const env = { ...process.env };
delete env.CLAUDECODE;

let spent = 0;
const costs = [];

/** Phase 1 under a permission host that plays the person. Resolves with the last `result` message. */
function hostedRun(prompt, budget) {
  const out = path.join(runDir, "phase1.jsonl");
  const hostLog = path.join(runDir, "host.log");
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-hook-events", "--permission-prompt-tool", "stdio", ...common(budget)];
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd: repo, env, stdio: ["pipe", "pipe", "pipe"] });
    const send = (obj) => child.stdin.writable && child.stdin.write(JSON.stringify(obj) + "\n");
    child.stderr.on("data", (d) => appendFileSync(path.join(runDir, "phase1.err"), d));
    const timer = setTimeout(() => {
      appendFileSync(hostLog, JSON.stringify({ abort: `timeout after ${PHASE1_TIMEOUT_MS} ms` }) + "\n");
      child.kill("SIGTERM");
    }, PHASE1_TIMEOUT_MS);
    send({ type: "control_request", request_id: "init_1", request: { subtype: "initialize" } });
    send({ type: "user", message: { role: "user", content: prompt } });
    let buf = "";
    let last;
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        appendFileSync(out, line + "\n");
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === "control_request" && msg.request?.subtype === "can_use_tool") {
          const req = msg.request;
          let input = req.input;
          if (req.tool_name === "AskUserQuestion" && Array.isArray(input?.questions)) {
            // The person picks the first (recommended) option of every question.
            const answers = Object.fromEntries(input.questions.map((q) => [q.question, q.options?.[0]?.label ?? "yes"]));
            input = { ...input, answers };
          }
          appendFileSync(hostLog, JSON.stringify({ tool: req.tool_name, agent_id: req.agent_id, reason: req.decision_reason, answers: input?.answers }) + "\n");
          send({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { behavior: "allow", updatedInput: input } } });
        }
        if (msg.type === "result") {
          last = msg;
          child.stdin.end();
        }
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(last);
    });
  });
}

/** A plain `-p` call (no host). Resolves with the parsed JSON result. */
function plainRun(prompt, budget, file) {
  return new Promise((resolve) => {
    const child = spawn("claude", ["-p", "--output-format", "json", ...common(budget), prompt], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => appendFileSync(path.join(runDir, `${file}.err`), d));
    child.on("exit", () => {
      writeFileSync(path.join(runDir, file), stdout);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(undefined);
      }
    });
  });
}

const charge = (phase, result) => {
  const usd = Number(result?.total_cost_usd ?? 0);
  spent += usd;
  costs.push({ phase, total_cost_usd: usd, modelUsage: Object.fromEntries(Object.entries(result?.modelUsage ?? {}).map(([m, u]) => [m, u.costUSD])) });
  console.log(`${phase}: total_cost_usd ${usd.toFixed(4)} (running total ${spent.toFixed(4)} of ${BUDGET})`);
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log(`repo copy: ${repo}`);
const phase1Budget = BUDGET * 0.85;
const result1 = await hostedRun(REQUEST, phase1Budget);
charge("phase1 /task", result1);
const sessionId = result1?.session_id;
const taskFile = path.join(repo, ".claude/workflow/task.json");
const taskAfterPhase1 = existsSync(taskFile) ? JSON.parse(readFileSync(taskFile, "utf8")) : undefined;

let result2;
if (BUDGET - spent > 0.03) {
  result2 = await plainRun("/cc-improved:done", Math.min(0.1, BUDGET - spent), "done.json");
  charge("phase2 /done", result2);
} else console.log("phase2 /done skipped: budget spent");

// ---------------------------------------------------------------------------
// What happened, step by step (from the stream, the plugin data dir and the repo)
// ---------------------------------------------------------------------------

const stream = readFileSync(path.join(runDir, "phase1.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => {
  try {
    return JSON.parse(l);
  } catch {
    return {};
  }
});
const hookOutputs = stream
  .filter((m) => m.type === "system" && m.subtype === "hook_response" && (m.output ?? "").trim())
  .map((m) => ({ hook: m.hook_name, output: (m.output ?? "").trim() }));
const toolUses = stream.flatMap((m) => (m.type === "assistant" ? (m.message?.content ?? []) : [])).filter((c) => c.type === "tool_use");
const agentCalls = toolUses.filter((c) => c.name === "Agent" || c.name === "Task").map((c) => ({ subagent_type: c.input?.subagent_type, run_in_background: c.input?.run_in_background }));
const pluginData = path.join(os.homedir(), ".claude/plugins/data/cc-improved-inline");
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};
const session = sessionId ? readJson(path.join(pluginData, "sessions", `${sessionId}.json`)) : undefined;
const planVerdict = sessionId ? readJson(path.join(pluginData, "plan-check", `${sessionId}.json`)) : undefined;
const tasksLog = path.join(repo, ".claude/workflow/tasks.jsonl");
const records = existsSync(tasksLog) ? readFileSync(tasksLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const has = (re) => hookOutputs.some((h) => re.test(h.output));
const agents = Object.values(session?.agents ?? {});

const steps = [
  ["plan denied for an invented name", has(/appear in no evidence/)],
  ["plan corrected and resubmitted (a later ExitPlanMode passed the static checks)", has(/strong-model plan check is required/) || taskAfterPhase1?.status !== undefined],
  ["plan check requested by the hook", has(/strong-model plan check is required/)],
  ["plan-check agent launched", agentCalls.some((a) => /plan-check/.test(a.subagent_type ?? ""))],
  ["plan-check verdict recorded", !!planVerdict],
  ["plan approved: task implementing after phase 1", taskAfterPhase1?.status === "implementing" || records.length > 0],
  ["implementer launched", agentCalls.some((a) => /implementer/.test(a.subagent_type ?? ""))],
  ["implementer blocked by the SubagentStop gate (verify or contract)", agents.some((a) => a.role === "implementer" && (a.failures > 0 || a.contractBlocks > 0 || a.policyBlocks > 0)) || has(/Verification fail|Fix the cause of this failure|Interface contract not met/)],
  ["implementer passed the gate", agents.some((a) => a.role === "implementer" && a.outcome === "passed")],
  ["review requested by the Stop gate (risk)", has(/needs a review before this task can finish/)],
  ["reviewer launched", agentCalls.some((a) => /reviewer/.test(a.subagent_type ?? ""))],
  ["review verdict recorded", !!session?.reviewVerdict],
  ["/done wrote the record to tasks.jsonl", records.length > 0],
];

const report = {
  repo,
  sessionId,
  costs,
  total_cost_usd: Number(spent.toFixed(4)),
  steps: steps.map(([step, ok]) => ({ step, ok })),
  agentCalls,
  hookOutputs: hookOutputs.map((h) => ({ hook: h.hook, output: h.output.slice(0, 400) })),
  gateState: session,
  planVerdict: planVerdict && { status: planVerdict.status },
  task: taskAfterPhase1 && { status: taskAfterPhase1.status, title: taskAfterPhase1.title, files: taskAfterPhase1.plan?.files, interface: taskAfterPhase1.plan?.interface },
  records,
  phase1Result: result1 && { subtype: result1.subtype, is_error: result1.is_error, num_turns: result1.num_turns, result: (result1.result ?? "").slice(0, 600) },
  doneResult: result2 && { result: (result2.result ?? "").slice(0, 600) },
  repoFiles: readdirSync(path.join(repo, "src/strings")),
};
writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log("");
for (const { step, ok } of report.steps) console.log(`${ok ? "OK  " : "MISS"} ${step}`);
console.log(`\ntotal_cost_usd: ${report.total_cost_usd}\nreport: ${path.join(runDir, "report.json")}`);
process.exit(report.steps.every((s) => s.ok) ? 0 : 1);
