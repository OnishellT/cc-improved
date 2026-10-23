// The whole task flow at hook level: the sequence of events Claude Code sends during /task → /done, chained against
// the real entry (the `command` of hooks/hooks.json, run through a shell) in a temporary git repo. Deterministic and
// free: it stands in for what `npm run e2e` cannot force a real model to do. Each event is only sent when the
// matchers of hooks/hooks.json would route it to the plugin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_BUDGET_MS, QUICK_BUDGET_MS, REGISTRY } from "../lib/hooks/registry.ts";
import type { HookEventName, Manifest, Plan, Task } from "../lib/types.ts";

const PLUGIN_ROOT = fileURLToPath(new URL("../", import.meta.url));
const fixturesDir = fileURLToPath(new URL("fixtures/hooks/", import.meta.url));
const SESSION = "e7119218-ed8d-4fd7-85e4-a2bb49b7547a";
const OTHER_SESSION = "185b8104-065e-43cc-a5b6-8b821bdffbb9";
const PROMPT = "de175abb-b3ca-45e6-95aa-61d11f6c438d";

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}
type HooksJson = { hooks: Partial<Record<HookEventName, HookGroup[]>> };

const hooksJson = async () => JSON.parse(await readFile(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8")) as HooksJson;

// Claude Code 2.1.309 matcher rules (read from the binary): "*" or empty matches all; a plain list of names
// (letters, digits, `_`, `|`, plus `-`, `,` and spaces for the tool, session and subagent events) is compared
// exactly, name by name; anything else is an unanchored regular expression.
const LISTED = new Set(["PreToolUse", "PostToolUse", "SessionStart", "SubagentStart", "SubagentStop"]);
function matches(event: HookEventName, matcher: string | undefined, value: string): boolean {
  if (!matcher || matcher === "*") return true;
  const plain = LISTED.has(event) ? /^[a-zA-Z0-9_|, -]+$/ : /^[a-zA-Z0-9_|]+$/;
  if (plain.test(matcher)) return matcher.split(LISTED.has(event) ? /[|,]/ : "|").map((s) => s.trim()).includes(value);
  return new RegExp(matcher).test(value);
}

/** The commands Claude Code would run for this event and value (tool name or agent type). */
function commandsFor(config: HooksJson, event: HookEventName, value = ""): HookCommand[] {
  return (config.hooks[event] ?? []).filter((g) => matches(event, g.matcher, value)).flatMap((g) => g.hooks);
}

const sh = (command: string, stdin: string, env: NodeJS.ProcessEnv) =>
  new Promise<{ code: number; stdout: string }>((resolve) => {
    const child = execFile("sh", ["-c", command], { env, timeout: 60_000 }, (err, stdout) => resolve({ code: err ? Number((err as { code?: unknown }).code ?? 1) : 0, stdout }));
    child.stdin!.end(stdin);
  });

const fixture = async (name: string) => JSON.parse(await readFile(path.join(fixturesDir, `${name}.json`), "utf8")) as Record<string, unknown>;

const planBlock = (plan: Plan) => `# Plan: URL slugs\n\n1. Add the module and its test.\n\n\`\`\`wf-plan\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n`;

const SLUG_JS_UNDOCUMENTED = 'export function slugify(text) {\n  if (typeof text !== "string") throw new TypeError("text");\n  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");\n}\n';
const SLUG_JS = `/** Slug for a post title. */\n${SLUG_JS_UNDOCUMENTED}`;

test("the full task flow, event by event, through the hooks.json commands", async () => {
  const config = await hooksJson();
  const dir = await mkdtemp(path.join(tmpdir(), "wf-flow-"));
  const root = path.join(dir, "repo");
  const data = path.join(dir, "data");
  const plans = path.join(dir, "plans");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "docs", "specs"), { recursive: true });
  await mkdir(plans, { recursive: true });
  const manifest: Manifest = { version: 1, setup: "done", verify: ["node check-jsdoc.mjs"], review: { paths: ["src/"] }, connectors: [] };
  await mkdir(path.join(root, ".claude"), { recursive: true });
  await writeFile(path.join(root, ".claude", "workflow.json"), JSON.stringify(manifest));
  await writeFile(path.join(root, ".gitignore"), ".claude/workflow/task.json\n");
  await writeFile(path.join(root, "docs", "specs", "slug.md"), "# SLUG-1\n\nPost URLs need a slug built from the post title, in a new module src/slug.js.\n");
  await writeFile(path.join(root, "src", "title-case.js"), "/** Title Case. */\nexport function titleCase(t) { return t; }\n");
  // The project's verify step: every exported function has a JSDoc block right above it.
  await writeFile(
    path.join(root, "check-jsdoc.mjs"),
    'import { readFileSync, readdirSync } from "node:fs";\nconst bad = [];\nfor (const f of readdirSync("src")) { const l = readFileSync("src/" + f, "utf8").split("\\n"); l.forEach((x, i) => { if (/^export function/.test(x) && !/\\*\\/\\s*$/.test(l[i - 1] ?? "")) bad.push(f + ":" + (i + 1)); }); }\nif (bad.length) { console.error("missing JSDoc: " + bad.join(", ")); process.exit(1); }\n',
  );
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");

  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_OPTION_STRONG_MODEL: "sonnet" };

  /** Sends one event the way Claude Code would: every matching command of hooks.json, stdin JSON, exit 0. */
  async function send(event: HookEventName, base: string, patch: Record<string, unknown>, value = ""): Promise<Record<string, any> | undefined> {
    const commands = commandsFor(config, event, value);
    assert.equal(commands.length, 1, `${event} ${value}: hooks.json routes it to exactly one command`);
    const input = { ...(await fixture(base)), cwd: root, session_id: SESSION, prompt_id: PROMPT, ...patch };
    const { code, stdout } = await sh(commands[0]!.command, JSON.stringify(input), env);
    assert.equal(code, 0, `${event} ${value}: exit code`);
    return stdout.trim() ? JSON.parse(stdout) : undefined;
  }
  const reason = (out: Record<string, any> | undefined) => String(out?.hookSpecificOutput?.permissionDecisionReason ?? "");
  const decision = (out: Record<string, any> | undefined) => out?.hookSpecificOutput?.permissionDecision;
  const task = async () => JSON.parse(await readFile(path.join(root, ".claude", "workflow", "task.json"), "utf8")) as Task;
  const exitPlan = (plan: Plan) => send("PreToolUse", "pre-tool-use.exit-plan-mode", { permission_mode: "plan", tool_input: { plan: planBlock(plan), planFilePath: path.join(plans, "plan-slug.md") } }, "ExitPlanMode");

  // 0. Session start on a project with a finished setup and no task: nothing to say.
  assert.equal(await send("SessionStart", "session-start", {}, "startup"), undefined);

  // 1. First plan: `slugify` is in no evidence (spec, title, ticket) → denied as an invented name.
  const invented: Plan = {
    title: "URL slugs for posts",
    ticket: "SLUG-1",
    spec: ["docs/specs/slug.md"],
    files: ["src/slug.js", "src/slug.test.js"],
    interface: [{ file: "src/slug.js", exports: ["slugify"], source: "docs/specs/slug.md" }],
    seams: [{ name: "slug rules", testFile: "src/slug.test.js", catches: "accents, repeated separators, non-string input" }],
    decisions: [],
  };
  const denied = await exitPlan(invented);
  assert.equal(decision(denied), "deny");
  assert.match(reason(denied), /appear in no evidence/);
  assert.match(reason(denied), /src\/slug\.js: slugify/);
  assert.match(reason(denied), /AskUserQuestion/);

  // 2. Fixed: the user accepted the name through AskUserQuestion; the decision cites the ADR the implementer writes.
  const adr = "docs/adr/0001-slug-name.md";
  const fixed: Plan = {
    ...invented,
    files: [...invented.files, adr],
    decisions: [{ question: "Interface names", options: ["slugify", "toSlug"], answer: "slugify", source: adr }],
  };
  const check = await exitPlan(fixed);
  assert.equal(decision(check), "deny", "the first valid plan asks for the strong-model plan check");
  assert.match(reason(check), /strong-model plan check is required/);
  assert.match(reason(check), /subagent_type "cc-improved:plan-check-sonnet", run_in_background: false/, "foreground, and the variant of strong_model");
  assert.match(reason(check), /----- BRIEF FOR cc-improved:plan-check-sonnet -----\n# Plan check: URL slugs for posts/);
  const planning = await task();
  assert.equal(planning.status, "planning");
  assert.equal(planning.sessionId, SESSION);

  // 3. The orchestrator launches plan-check; its stop records the verdict.
  assert.equal(await send("SubagentStart", "subagent-start", { agent_id: "aplancheck", agent_type: "cc-improved:plan-check-sonnet" }, "cc-improved:plan-check-sonnet"), undefined);
  const verdict = await send(
    "SubagentStop",
    "subagent-stop",
    { agent_id: "aplancheck", agent_type: "cc-improved:plan-check-sonnet", last_assistant_message: "Names match the ADR.\nVERDICT: OK", background_tasks: [] },
    "cc-improved:plan-check-sonnet",
  );
  assert.match(String(verdict?.systemMessage), /chequeo del plan: OK/);

  // 4. ExitPlanMode again: no second check; the user sees the plan with the verdict.
  const shown = await exitPlan(fixed);
  assert.equal(decision(shown), undefined, "not denied: the native dialog opens");
  assert.match(String(shown?.systemMessage), /Chequeo del plan \(cc-improved:plan-check\): OK/);

  // 5. The user approves: PostToolUse marks the task implementing and repeats the decisions.
  const approved = await send(
    "PostToolUse",
    "post-tool-use.exit-plan-mode",
    { tool_input: {}, tool_response: { plan: planBlock(fixed), isAgent: false, filePath: path.join(plans, "plan-slug.md") } },
    "ExitPlanMode",
  );
  assert.match(String(approved?.hookSpecificOutput?.additionalContext), /now implementing[\s\S]*Interface names -> slugify/);
  assert.equal((await task()).status, "implementing");

  // 6. Inside the implementer: a planned file gets the plan files as context; an unplanned one asks the person.
  const impl = { agent_id: "aimpl1", agent_type: "cc-improved:implementer" };
  const first = await send("PreToolUse", "pre-tool-use.subagent", { ...impl, tool_name: "Write", tool_input: { file_path: path.join(root, "src", "slug.js"), content: SLUG_JS_UNDOCUMENTED } }, "Write");
  assert.equal(decision(first), undefined);
  assert.match(String(first?.hookSpecificOutput?.additionalContext), /Approved plan files[\s\S]*- src\/slug\.js/);
  const outside = await send("PreToolUse", "pre-tool-use.subagent", { ...impl, tool_name: "Edit", tool_input: { file_path: path.join(root, "src", "title-case.js"), old_string: "t;", new_string: "t ;" } }, "Edit");
  assert.equal(decision(outside), "ask");
  assert.match(reason(outside), /Outside the approved plan: src\/title-case\.js/);
  const install = await send("PreToolUse", "pre-tool-use.subagent", { ...impl, tool_name: "Bash", tool_input: { command: "npm install slugify" } }, "Bash");
  assert.equal(decision(install), "ask");
  assert.match(reason(install), /New dependency/);
  // Read and Grep never reach the plugin.
  assert.equal(commandsFor(config, "PreToolUse", "Read").length, 0);
  assert.equal(commandsFor(config, "PreToolUse", "Grep").length, 0);

  // 7. The implementer writes the code without JSDoc and stops: verify fails → blocked with the report.
  await writeFile(path.join(root, "src", "slug.js"), SLUG_JS_UNDOCUMENTED);
  await writeFile(path.join(root, "src", "slug.test.js"), 'import { slugify } from "./slug.js";\n');
  await mkdir(path.join(root, "docs", "adr"), { recursive: true });
  await writeFile(path.join(root, adr), "# 1. Slug export name\n\nQuestion: Interface names. Options: slugify, toSlug. Answer: slugify.\n");
  const stopImpl = (message: string) =>
    send("SubagentStop", "subagent-stop", { ...impl, last_assistant_message: message, stop_hook_active: false, background_tasks: [] }, "cc-improved:implementer");
  const blocked = await stopImpl("Implemented slugify.\nDONE");
  assert.equal(blocked?.decision, "block");
  assert.match(String(blocked?.reason), /missing JSDoc: slug\.js:1/);
  assert.match(String(blocked?.reason), /Fix the cause of this failure/);

  // 8. Fixed: the gate lets the implementer out.
  await writeFile(path.join(root, "src", "slug.js"), SLUG_JS);
  assert.equal(await stopImpl("Added the JSDoc block.\nDONE"), undefined);

  // 9. The orchestrator stops: contract and verify pass, the diff touches review.paths → review requested once.
  const stop = (message: string, sessionId = SESSION) => send("Stop", "stop", { session_id: sessionId, last_assistant_message: message, stop_hook_active: false, background_tasks: [] });
  const review = await stop("The implementer finished.");
  assert.equal(review?.decision, "block");
  assert.match(String(review?.reason), /needs a review before this task can finish \(risk: [^)]*review\.paths/);
  assert.match(String(review?.reason), /`cc-improved:reviewer-sonnet` agent in the foreground/);

  // 10. A Stop of another session open on the same project is ignored (task.json belongs to SESSION).
  assert.equal(await stop("unrelated", OTHER_SESSION), undefined);

  // 11. The reviewer answers; the next Stop ends the turn with the summary for the person.
  const reviewed = await send(
    "SubagentStop",
    "subagent-stop",
    { agent_id: "areview", agent_type: "cc-improved:reviewer-sonnet", last_assistant_message: "No blocking findings.\nVERDICT: OK", background_tasks: [] },
    "cc-improved:reviewer-sonnet",
  );
  assert.match(String(reviewed?.systemMessage), /revisión del diff: OK/);
  const summary = await stop("Review OK.");
  assert.equal(summary?.decision, undefined);
  assert.match(String(summary?.systemMessage), /contrato de interfaz OK; verify OK \(1 pasos\); revisión: OK\. Comprueba el resultado y cierra con \/done/);

  // 12. /done (the skill's injected command): the record lands in tasks.jsonl and the task is closed.
  const done = await sh(`node --experimental-strip-types "${path.join(PLUGIN_ROOT, "bin", "wf-done.mjs")}"`, "", env);
  assert.match(done.stdout, /^CLOSED: \[SLUG-1\] URL slugs for posts/);
  const records = (await readFile(path.join(root, ".claude", "workflow", "tasks.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(records.length, 1);
  assert.deepEqual([...records[0].files].sort(), ["docs/adr/0001-slug-name.md", "src/slug.js", "src/slug.test.js"]);
  assert.deepEqual(records[0].decisions, [{ question: "Interface names", answer: "slugify", source: adr }]);
  assert.equal((await task()).status, "done");

  // 13. After /done the gates are quiet.
  assert.equal(await stop("Closed."), undefined);
});

test("hooks.json: every routed event has one command, the shared entry, and a timeout above its dispatcher budget", async () => {
  const config = await hooksJson();
  const expected: Partial<Record<HookEventName, number>> = { SessionStart: QUICK_BUDGET_MS, PreToolUse: QUICK_BUDGET_MS, PostToolUse: QUICK_BUDGET_MS, SubagentStart: QUICK_BUDGET_MS, SubagentStop: GATE_BUDGET_MS, Stop: GATE_BUDGET_MS };
  assert.deepEqual(Object.keys(config.hooks).sort(), Object.keys(expected).sort());
  for (const [event, groups] of Object.entries(config.hooks) as [HookEventName, HookGroup[]][]) {
    assert.equal(REGISTRY[event].budgetMs, expected[event], event);
    for (const g of groups) {
      for (const h of g.hooks) {
        assert.equal(h.type, "command");
        assert.equal(h.command, 'node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/bin/wf-hook.mjs"');
        assert.ok((h.timeout ?? 0) * 1000 > REGISTRY[event].budgetMs, `${event} ${g.matcher ?? ""}: timeout ${h.timeout}s`);
      }
    }
  }
});

test("hooks.json matchers: which tools and agents reach the plugin", async () => {
  const config = await hooksJson();
  const routed = (event: HookEventName, value: string) => commandsFor(config, event, value).length > 0;
  for (const tool of ["ExitPlanMode", "Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]) assert.ok(routed("PreToolUse", tool), tool);
  for (const tool of ["Read", "Grep", "Glob", "Agent", "AskUserQuestion", "mcp__github__get_issue"]) assert.ok(!routed("PreToolUse", tool), tool);
  for (const tool of ["ExitPlanMode", "mcp__github__get_issue", "mcp__claude_ai_Claude_Docs__read"]) assert.ok(routed("PostToolUse", tool), tool);
  for (const tool of ["Edit", "Write", "Bash", "Read"]) assert.ok(!routed("PostToolUse", tool), tool);
  // Plugin agents arrive as `cc-improved:<name>` (spike 0.4); a plain list matcher would compare them exactly and miss them.
  for (const agent of ["cc-improved:implementer", "cc-improved:fixer", "cc-improved:fixer-sonnet", "cc-improved:reviewer", "cc-improved:reviewer-sonnet", "cc-improved:plan-check", "cc-improved:plan-check-sonnet", "implementer"]) {
    assert.ok(routed("SubagentStop", agent), agent);
  }
  for (const agent of ["general-purpose", "Explore", "cc-improved:implementer-x", "reviewers"]) assert.ok(!routed("SubagentStop", agent), agent);
});
