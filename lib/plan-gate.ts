// Plan gate shared by the ExitPlanMode hook and bin/wf-plan-validate.mjs (the fast route): the same checks, in one place.
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { missingNames } from "./contract.ts";
import { evidenceFor } from "./evidence.ts";
import { manifestPath } from "./paths.ts";
import { parsePlan } from "./plan.ts";
import { highRiskReasons } from "./risk.ts";
import type { Decision, Manifest, Plan, ReviewPolicy, Task } from "./types.ts";

const ADR_DIR = "docs/adr";

const exists = (file: string) => stat(file).then(() => true, () => false);

/** Absolute path of a repo-relative path, or `undefined` when it escapes the repo. */
function inRepo(root: string, rel: string): string | undefined {
  const abs = path.resolve(root, rel);
  return abs === path.resolve(root) || abs.startsWith(path.resolve(root) + path.sep) ? abs : undefined;
}

/** Whether a repo-relative file is covered by the plan's `files` (exact entry or a directory entry ending in `/`). */
const inFiles = (plan: Plan, file: string) => plan.files.some((f) => (f.endsWith("/") ? file.startsWith(f) : f === file));

/** The gate is active once the project has a manifest the user did not decline. */
export async function gateActive(root: string): Promise<Manifest | undefined> {
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

// Plan size above which a task is not small and, with `review.plan: true`, the plan is checked (`review.planFiles/...` override).
const PLAN_FILES = 8;
const PLAN_INTERFACE = 6;
const PLAN_DECISIONS = 2;

const over = (n: number, limit: number | undefined, fallback: number) => n > (typeof limit === "number" && Number.isFinite(limit) && limit >= 0 ? limit : fallback);

/** Why a plan is not small enough for the fast route: risk triggers first, then size. Empty: it is small. */
export function notSmallReasons(plan: Plan, rule: ReviewPolicy | undefined): string[] {
  const reasons = rule?.always ? ["review.always"] : highRiskReasons(plan.files, rule);
  if (over(plan.files.length, rule?.planFiles, PLAN_FILES)) reasons.push(`${plan.files.length} files`);
  if (over(plan.interface.length, rule?.planInterface, PLAN_INTERFACE)) reasons.push(`${plan.interface.length} interface entries`);
  if (over(plan.decisions.length, rule?.planDecisions, PLAN_DECISIONS)) reasons.push(`${plan.decisions.length} decisions`);
  return reasons;
}

/**
 * Whether the model plan check is requested. Off by default: `strong` only when the plan touches risk triggers (or
 * `review.always`); `review.plan: true` also gives big plans a `cheap` one; `review.plan: false` never. The
 * deterministic name and contract checks (`checkPlan`) always run.
 */
export function planCheckLevel(plan: Plan, rule: ReviewPolicy | undefined): "strong" | "cheap" | undefined {
  if (rule?.plan === false) return undefined;
  if (rule?.always || highRiskReasons(plan.files, rule).length) return "strong";
  if (rule?.plan !== true) return undefined;
  return notSmallReasons(plan, rule).length ? "cheap" : undefined;
}

/** Result of the checks every plan goes through before it can be implemented. */
export type PlanCheck = { stage: "parse" | "problems"; errors: string[] } | { plan: Plan; task: Task; isNew: boolean; evidence: string };

/**
 * Parse the ```wf-plan block, build the draft task and run the name, seam, spec and decision checks.
 * `errors` are instructions for the model; the caller decides how to deliver them.
 */
export async function checkPlan(root: string, markdown: string, current: Task | undefined, planFilePath: string | undefined, mcpText: string): Promise<PlanCheck> {
  const parsed = parsePlan(markdown);
  if ("errors" in parsed) return { stage: "parse", errors: parsed.errors };
  const { task, isNew } = taskFor(parsed.plan, current, planFilePath);
  const evidence = await evidenceFor(root, task, mcpText);
  const problems = await planProblems(root, parsed.plan, evidence);
  return problems.length ? { stage: "problems", errors: problems } : { plan: parsed.plan, task, isNew, evidence };
}
