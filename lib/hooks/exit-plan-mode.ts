// ExitPlanMode gate (issue #19). PreToolUse validates the ```wf-plan block, checks the interface names against the
// ticket evidence, sends unsettled decisions back to the user and asks once per task for the strong-model plan check;
// PostToolUse marks the approved task as implementing.
//
// Plan check, option B (active): the first ExitPlanMode that passes the static checks is denied with "launch
// cc-improved:plan-check in the foreground with this brief and apply its verdict"; `recordPlanCheckVerdict` (called
// from SubagentStop) stores the agent's verdict. Option A (an `agent` hook with a strong model on
// PreToolUse(ExitPlanMode), spike 0.2) is documented in docs/plan-check-option-a.md and not enabled.
//
// Hook payloads (spike 0.1): PreToolUse carries `tool_input.plan` and `tool_input.planFilePath`; PostToolUse carries an
// empty `tool_input`, the approved plan in `tool_response.plan` and its path in `tool_response.filePath`. Claude Code
// prefixes the deny reason with "PreToolUse:ExitPlanMode hook error: ", so every reason stands on its own.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { buildPlanBrief, parsePlanVerdict, readMcpText, siblings, type PlanCheckStatus } from "../evidence.ts";
import { pluginDataDir, sessionStatePath, type Env } from "../paths.ts";
import { checkPlan, gateActive, planCheckLevel } from "../plan-gate.ts";
import { parsePlan } from "../plan.ts";
import { withBaseCommit } from "../risk.ts";
import type { PreToolUseOutput, SubagentStopInput, Task } from "../types.ts";
import type { HookContext, HookModule } from "./dispatch.ts";
import { strongAgentChoice } from "./gate.ts";

// The plan checks live in lib/plan-gate.ts (shared with bin/wf-plan-validate.mjs); re-exported for existing callers.
export { planCheckLevel, planProblems, taskFor } from "../plan-gate.ts";

const TOOL = "ExitPlanMode";
/** Plan-check requests per task: one strong-model read, never a loop. */
export const MAX_PLAN_CHECKS = 1;
/** Agent names whose SubagentStop carries a plan-check verdict, with or without the plugin prefix. */
const PLAN_CHECK_AGENT = /(^|:)plan-check(-sonnet)?$/;

/** Verdict of the plan-check agent for one task, stored per session. */
export interface PlanCheckVerdict {
  taskId: string;
  status: PlanCheckStatus;
  report: string;
  agentId?: string;
  /** ISO 8601 time it was recorded. */
  at: string;
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

function planCheckRequest(brief: string, env: Env, strong: boolean): string {
  // Subagents run in the background by default (spike 0.5): without the verdict in hand, the orchestrator would call
  // ExitPlanMode again before the check ends and the check would be wasted.
  const { agent, model } = strongAgentChoice("plan-check", env, { strong });
  const call = `subagent_type "${agent}"${model ? `, model "${model}"` : ""}, run_in_background: false`;
  return [
    `${header} One strong-model plan check is required before the user reviews it (it runs once per task).`,
    `Launch the ${agent} agent with the Agent tool in the foreground (${call}) and pass it the brief below, verbatim, as its prompt. Wait for its answer.`,
    "When it answers: on VERDICT: FIX, apply each numbered fix to the plan file, or add a line to the plan saying why a fix does not apply; on VERDICT: OK, change nothing. Then call ExitPlanMode again; it will not ask for the check a second time.",
    "",
    `----- BRIEF FOR ${agent} -----`,
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
    const planFilePath = typeof input.tool_input.planFilePath === "string" ? input.tool_input.planFilePath : undefined;
    const checked = await checkPlan(ctx.root, markdown, ctx.task, planFilePath, await readMcpText(input.session_id, ctx.env));
    if ("errors" in checked) {
      return deny(checked.stage === "parse" ? [header, ...checked.errors.map((e) => `- ${e}`), retry].join("\n") : [header, "Fix these problems:", ...checked.errors.map((p) => `- ${p}`), retry].join("\n"));
    }
    const { plan, evidence, isNew } = checked;
    // The base commit is fixed when the task enters planning and survives resubmissions of the plan.
    const task = await withBaseCommit(ctx.root, checked.task, ctx.task);

    await ctx.saveTask(task);
    const state = isNew ? await ctx.session.save({ planChecks: 0 }) : await ctx.session.load();
    if (state.planChecks < MAX_PLAN_CHECKS) {
      const level = planCheckLevel(plan, manifest.review);
      if (!level) return;
      await ctx.session.save({ planChecks: state.planChecks + 1 });
      return deny(planCheckRequest(buildPlanBrief(task, plan, evidence, await siblings(ctx.root, plan)), ctx.env, level === "strong"));
    }
    const verdict = await readPlanCheckVerdict(input.session_id, ctx.env);
    return { systemMessage: verdictNotice(verdict?.taskId === task.id ? verdict : undefined), hookSpecificOutput: { hookEventName: "PreToolUse" } };
  },

  async PostToolUse(input, ctx) {
    if (input.tool_name !== TOOL || input.agent_id) return;
    const task = ctx.task;
    if (!task || task.status !== "planning") return;
    const response = (input.tool_response ?? {}) as { plan?: unknown; filePath?: unknown };
    // A task planned without git (or before this field existed) gets its base now, as late as it can be.
    const next: Task = await withBaseCommit(ctx.root, { ...task, status: "implementing" }, task);
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
