// ExitPlanMode gate (issue #19). PreToolUse validates the ```wf-plan block, checks the interface names against the
// ticket evidence, sends unsettled decisions back to the user and asks once per task for the strong-model plan check;
// PostToolUse marks the approved task as implementing.
//
// Plan check, option B (implemented here): the first ExitPlanMode that passes the static checks is denied with
// "launch cc-improved:plan-check with this brief and apply its verdict"; `recordPlanCheckVerdict` (to be called from
// SubagentStop) stores the agent's verdict. Option A (an `agent` hook with a strong model on PreToolUse(ExitPlanMode)
// in hooks/hooks.json, spike 0.2) is left to the integration issue: it lives in hooks/hooks.json, not in lib/.
//
// Hook payloads (spike 0.1): PreToolUse carries `tool_input.plan` and `tool_input.planFilePath`; PostToolUse carries an
// empty `tool_input`, the approved plan in `tool_response.plan` and its path in `tool_response.filePath`. Claude Code
// prefixes the deny reason with "PreToolUse:ExitPlanMode hook error: ", so every reason stands on its own.
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { missingNames } from "../contract.ts";
import { buildPlanBrief, evidenceFor, parsePlanVerdict, readMcpText, siblings, type PlanCheckStatus } from "../evidence.ts";
import { manifestPath, pluginDataDir, sessionStatePath, type Env } from "../paths.ts";
import { parsePlan } from "../plan.ts";
import type { Decision, Manifest, Plan, PreToolUseOutput, SubagentStopInput, Task } from "../types.ts";
import type { HookContext, HookModule } from "./dispatch.ts";

const TOOL = "ExitPlanMode";
/** Plan-check requests per task: one strong-model read, never a loop. */
export const MAX_PLAN_CHECKS = 1;
/** Agent names whose SubagentStop carries a plan-check verdict, with or without the plugin prefix. */
const PLAN_CHECK_AGENT = /(^|:)plan-check(-sonnet)?$/;
const ADR_DIR = "docs/adr";

/** Verdict of the plan-check agent for one task, stored per session. */
export interface PlanCheckVerdict {
  taskId: string;
  status: PlanCheckStatus;
  report: string;
  agentId?: string;
  /** ISO 8601 time it was recorded. */
  at: string;
}

const exists = (file: string) => stat(file).then(() => true, () => false);

/** Absolute path of a repo-relative path, or `undefined` when it escapes the repo. */
function inRepo(root: string, rel: string): string | undefined {
  const abs = path.resolve(root, rel);
  return abs === path.resolve(root) || abs.startsWith(path.resolve(root) + path.sep) ? abs : undefined;
}

/** Whether a repo-relative file is covered by the plan's `files` (exact entry or a directory entry ending in `/`). */
const inFiles = (plan: Plan, file: string) => plan.files.some((f) => (f.endsWith("/") ? file.startsWith(f) : f === file));

/** The gate is active once the project has a manifest the user did not decline. */
async function gateActive(root: string): Promise<Manifest | undefined> {
  try {
    const manifest = JSON.parse(await readFile(manifestPath(root), "utf8")) as Manifest;
    return manifest && manifest.setup !== "declined" ? manifest : undefined;
  } catch {
    return undefined;
  }
}

/** The draft task a plan describes; keeps the id of the task being planned when the plan is resubmitted. */
export function taskFor(plan: Plan, current: Task | undefined, planFilePath: string | undefined, now = new Date()): { task: Task; isNew: boolean } {
  const same = current && current.status !== "done" && (current.status === "planning" || current.title === plan.title);
  const task: Task = {
    id: same ? current.id : `t-${now.getTime().toString(36)}`,
    title: plan.title,
    status: "planning",
    plan,
    allowedExtra: same ? current.allowedExtra : [],
    startedAt: same ? current.startedAt : now.toISOString(),
  };
  if (plan.ticket) task.ticket = plan.ticket;
  if (planFilePath) task.planFilePath = planFilePath;
  return { task, isNew: !same };
}

/**
 * Problems that keep a parsed plan from reaching the user, each written for the model as an instruction.
 * Checks: seams and interface present, seam test files listed in `files`, spec files exist, every interface name
 * appears in the evidence or in a decision's answer, every decision cites a source that exists (an ADR, a spec, the
 * ticket or a repo file) or an ADR still to be written: a `docs/adr/` path listed in `files`, with the user's answer.
 */
export async function planProblems(root: string, plan: Plan, evidence: string): Promise<string[]> {
  const problems: string[] = [];
  if (!plan.interface.length) problems.push("interface is empty: pin, per file, the exported names the implementation will expose and cite their source.");
  if (!plan.seams.length) problems.push("seams is empty: name at least one place where a test attaches, its testFile and what it catches.");
  for (const seam of plan.seams) {
    if (!inFiles(plan, seam.testFile)) problems.push(`seams "${seam.name}": its testFile ${seam.testFile} is not in files. Add it to files (the task may only change listed files).`);
  }
  for (const spec of plan.spec) {
    const abs = inRepo(root, spec);
    if (!abs || !(await exists(abs))) problems.push(`spec ${spec} does not exist in the repo. List only spec files that exist (repo-relative), or remove the entry.`);
  }

  // Names the user accepted through AskUserQuestion live in the decisions' answers.
  const named = [evidence, ...plan.decisions.filter((d) => d.answer).map((d) => `${d.question}\n${d.answer}`)].join("\n");
  const invented: string[] = [];
  for (const entry of plan.interface) {
    const abs = inRepo(root, entry.file);
    const isNew = !abs || !(await exists(abs));
    const missing = missingNames(entry, named, isNew);
    if (missing.length) invented.push(`${entry.file}: ${missing.join(", ")}`);
  }
  if (invented.length) {
    problems.push(
      [
        "These interface names appear in no evidence (ticket text read through its MCP tool, the spec files, the files cited as interface[].source, or a decision's answer):",
        ...invented.map((line) => `  - ${line}`),
        `  If the ticket or an existing file defines them, read it (the ticket through its MCP tool) and cite it in interface[].source. Otherwise nobody defined them: ask the user with AskUserQuestion whether to accept these names (offer your proposal first and let them rename), then add a decision {"question": "Interface names", "options": [...], "answer": "<the accepted names, written out>", "source": "${ADR_DIR}/<next number>-<slug>.md"} and list that ADR path in files (plan mode cannot write it; the implementer writes it).`,
      ].join("\n"),
    );
  }

  for (const d of plan.decisions) {
    if (await decisionSettled(root, plan, d)) continue;
    problems.push(
      `decision "${d.question}": its source "${d.source}" is not the ticket key, a file in the repo, nor a new ADR under ${ADR_DIR}/ listed in files with the user's answer, so the decision is not settled. If a spec, the ticket or an existing file settles it, cite that in source. Otherwise ask the user this question with AskUserQuestion (options: ${d.options.length ? d.options.join(" | ") : "your proposal"}), put the user's answer in answer, set source to the ADR to be added (${ADR_DIR}/<next number>-<slug>.md) and list that same path in files: plan mode cannot write the ADR now, so the implementer writes it with the question, the options and the answer.`,
    );
  }
  return problems;
}

/**
 * A decision is settled when its source is the plan's ticket key, an existing repo file (an `#anchor` is ignored), or
 * an ADR still to be written: a path under `docs/adr/` listed in `files`, with the user's answer in `answer`.
 */
async function decisionSettled(root: string, plan: Plan, d: Decision): Promise<boolean> {
  if (plan.ticket && d.source.trim().toLowerCase() === plan.ticket.toLowerCase()) return true;
  const file = d.source.split("#")[0]?.trim();
  if (!file) return false;
  const abs = inRepo(root, file);
  if (!abs || abs === path.resolve(root)) return false;
  if (await exists(abs)) return true;
  const rel = path.relative(root, abs).split(path.sep).join("/");
  return rel.startsWith(`${ADR_DIR}/`) && inFiles(plan, rel) && !!d.answer;
}

const deny = (reason: string): PreToolUseOutput => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});

const header = "cc-improved plan gate: the plan was NOT shown to the user.";
const retry = "Edit the plan file (keep exactly one ```wf-plan JSON block), then call ExitPlanMode again.";

// ---------------------------------------------------------------------------
// Plan-check verdict store: `${CLAUDE_PLUGIN_DATA}/plan-check/<session_id>.json`
// ---------------------------------------------------------------------------

function verdictPath(sessionId: string, env: Env): string {
  const id = path.basename(sessionStatePath(sessionId, env), ".json");
  return path.join(pluginDataDir(env), "plan-check", `${id}.json`);
}

/** The verdict recorded for this session, if any. */
export async function readPlanCheckVerdict(sessionId: string, env: Env = process.env): Promise<PlanCheckVerdict | undefined> {
  try {
    return JSON.parse(await readFile(verdictPath(sessionId, env), "utf8")) as PlanCheckVerdict;
  } catch {
    return undefined;
  }
}

async function writeVerdict(sessionId: string, verdict: PlanCheckVerdict, env: Env): Promise<void> {
  const file = verdictPath(sessionId, env);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(verdict, null, 2)}\n`);
  await rename(tmp, file);
}

/**
 * SubagentStop of a plan-check agent: stores its verdict (from `last_assistant_message`) for the active task.
 * Returns the stored verdict, or `undefined` when the event is not a plan check or there is no task. Never blocks.
 */
export async function recordPlanCheckVerdict(input: SubagentStopInput, ctx: HookContext): Promise<PlanCheckVerdict | undefined> {
  if (!PLAN_CHECK_AGENT.test(input.agent_type ?? "") || !ctx.task) return undefined;
  const parsed = parsePlanVerdict(input.last_assistant_message ?? "") ?? { status: "skipped" as const, report: "The plan check gave no VERDICT line." };
  const verdict: PlanCheckVerdict = { taskId: ctx.task.id, status: parsed.status, report: parsed.report, agentId: input.agent_id, at: new Date().toISOString() };
  await writeVerdict(input.session_id, verdict, ctx.env);
  return verdict;
}

function planCheckRequest(brief: string): string {
  return [
    `${header} One strong-model plan check is required before the user reviews it (it runs once per task).`,
    'Launch the cc-improved:plan-check agent with the Agent tool (subagent_type "cc-improved:plan-check") and pass it the brief below, verbatim, as its prompt.',
    "When it answers: on VERDICT: FIX, apply each numbered fix to the plan file, or add a line to the plan saying why a fix does not apply; on VERDICT: OK, change nothing. Then call ExitPlanMode again; it will not ask for the check a second time.",
    "",
    "----- BRIEF FOR cc-improved:plan-check -----",
    brief,
    "----- END OF BRIEF -----",
  ].join("\n");
}

function verdictNotice(verdict: PlanCheckVerdict | undefined): string {
  if (!verdict) return "Chequeo del plan: no se registró veredicto de cc-improved:plan-check.";
  if (verdict.status === "ok") return "Chequeo del plan (cc-improved:plan-check): OK.";
  if (verdict.status === "fix") return "Chequeo del plan (cc-improved:plan-check): pidió cambios; comprueba que el plan los recoge.";
  return "Chequeo del plan (cc-improved:plan-check): sin veredicto.";
}

/** Plan Markdown from `tool_input.plan`, else from the plan file. */
async function planMarkdown(input: Record<string, unknown>): Promise<string | undefined> {
  if (typeof input.plan === "string") return input.plan;
  if (typeof input.planFilePath === "string") return readFile(input.planFilePath, "utf8").catch(() => undefined);
  return undefined;
}

export default {
  async PreToolUse(input, ctx) {
    if (input.tool_name !== TOOL || input.agent_id) return;
    const manifest = await gateActive(ctx.root);
    if (!manifest) return;
    const markdown = await planMarkdown(input.tool_input ?? {});
    if (markdown === undefined) {
      await ctx.log("ExitPlanMode without a plan in tool_input nor a readable planFilePath; no opinion");
      return;
    }
    const parsed = parsePlan(markdown);
    if ("errors" in parsed) return deny([header, ...parsed.errors.map((e) => `- ${e}`), retry].join("\n"));
    const plan = parsed.plan;

    const planFilePath = typeof input.tool_input.planFilePath === "string" ? input.tool_input.planFilePath : undefined;
    const { task, isNew } = taskFor(plan, ctx.task, planFilePath);
    const evidence = await evidenceFor(ctx.root, task, await readMcpText(input.session_id, ctx.env));
    const problems = await planProblems(ctx.root, plan, evidence);
    if (problems.length) return deny([header, "Fix these problems:", ...problems.map((p) => `- ${p}`), retry].join("\n"));

    await ctx.saveTask(task);
    const state = isNew ? await ctx.session.save({ planChecks: 0 }) : await ctx.session.load();
    if (manifest.review?.plan === false) return;
    if (state.planChecks < MAX_PLAN_CHECKS) {
      await ctx.session.save({ planChecks: state.planChecks + 1 });
      return deny(planCheckRequest(buildPlanBrief(task, plan, evidence, await siblings(ctx.root, plan))));
    }
    const verdict = await readPlanCheckVerdict(input.session_id, ctx.env);
    return { systemMessage: verdictNotice(verdict?.taskId === task.id ? verdict : undefined), hookSpecificOutput: { hookEventName: "PreToolUse" } };
  },

  async PostToolUse(input, ctx) {
    if (input.tool_name !== TOOL || input.agent_id) return;
    const task = ctx.task;
    if (!task || task.status !== "planning") return;
    const response = (input.tool_response ?? {}) as { plan?: unknown; filePath?: unknown };
    const next: Task = { ...task, status: "implementing" };
    if (typeof response.plan === "string") {
      const parsed = parsePlan(response.plan);
      if ("plan" in parsed) next.plan = parsed.plan;
      else await ctx.log(`approved plan has no valid wf-plan block; kept the stored plan: ${parsed.errors.join(" ")}`);
    }
    if (typeof response.filePath === "string") next.planFilePath = response.filePath;
    await ctx.saveTask(next);
    const decided = (next.plan?.decisions ?? []).filter((d) => d.answer).map((d) => `- ${d.question} -> ${d.answer} (${d.source})`);
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: [
          `cc-improved: the user approved the plan; task "${next.title}" is now implementing. Change only the files the plan lists and use its interface names.`,
          ...(decided.length ? ["Decisions already made by the user (do not ask again):", ...decided] : []),
        ].join("\n"),
      },
    };
  },
} satisfies HookModule;
