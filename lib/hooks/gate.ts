// Shared pieces of the Stop and SubagentStop gates: manifest, per-session state with its resets, agent roles,
// the verify run and the texts the model reads. No handler lives here.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { manifestPath, WORKFLOW_DIR, type Env } from "../paths.ts";
import type { BackgroundTask, Manifest, ReviewRecord, RiskLevel, SessionState, StopFields, Task, Verdict } from "../types.ts";
import { diffBase } from "../risk.ts";
import { formatVerify, isPolicyFailure, runVerify } from "../verify.ts";
import type { HookContext } from "./dispatch.ts";

/** Plugin name: plugin agents arrive as `cc-improved:<agent>`. */
export const PLUGIN = "cc-improved";
/**
 * Verify failures of one implementer/fixer: the 1st blocks once (fix, with the diagnosis method and leave to end with
 * FAILED), the 2nd releases it. The orchestrator escalates to the fixer on its 2nd. D-009.
 */
export const RELEASE_AFTER = 2;
/** Contract blocks of one subagent before it is released as failed. */
export const MAX_CONTRACT_BLOCKS = 3;
/** Orchestrator Stop blocks per user prompt (contract, verify, review together), well below the harness cap of 8. */
export const MAX_RETRIES = 5;
/** Paid diff reviews per task. */
export const MAX_REVIEWS = 1;
/** Characters of verify output the model reads per failing step. */
export const REPORT_CHARS = 3000;
/** Time kept free at the end of the hook budget so the output is still printed. */
const MARGIN_MS = 15_000;

/** Reads `.claude/workflow.json`; `undefined` when missing or not a manifest. */
export async function readManifest(root: string): Promise<Manifest | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath(root), "utf8"));
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const m = value as Partial<Manifest>;
  if (typeof m.setup !== "string") return undefined;
  const verify = Array.isArray(m.verify) ? m.verify.filter((s): s is string => typeof s === "string" && s.trim() !== "") : [];
  return { ...(m as Manifest), verify, connectors: Array.isArray(m.connectors) ? m.connectors : [] };
}

/** Role of one of this plugin's agents: `cc-improved:reviewer-sonnet` → `reviewer`; another plugin's agent → "". */
export function role(agentType: string | undefined): string {
  const parts = (agentType ?? "").split(":");
  if (parts.length > 2 || (parts.length === 2 && parts[0] !== PLUGIN)) return "";
  return (parts.at(-1) ?? "").replace(/-sonnet$/, "");
}

/**
 * Agent (and `model` override) to launch for a strong role, following the `strong_model` user config, which reaches
 * hooks as `CLAUDE_PLUGIN_OPTION_STRONG_MODEL` (spike 0.4: two variants per role, `model:` cannot use the option).
 * The reviewer and the plan check run on the `-sonnet` variant unless `strong` (high risk, `review.always`); the
 * configured strong model is what `strong` escalates to. The fixer only runs after failures and always uses it.
 */
export function strongAgentChoice(name: "reviewer" | "fixer" | "plan-check", env: Env, opts: { strong?: boolean } = {}): { agent: string; model?: string } {
  const model = (env.CLAUDE_PLUGIN_OPTION_STRONG_MODEL ?? "").trim();
  if (/sonnet/i.test(model) || (name !== "fixer" && !opts.strong)) return { agent: `${PLUGIN}:${name}-sonnet` };
  if (!model || /^opus$/i.test(model) || model.includes("${")) return { agent: `${PLUGIN}:${name}` };
  return { agent: `${PLUGIN}:${name}`, model };
}

/** `strongAgentChoice` as text for the model. */
export function strongAgent(name: "reviewer" | "fixer" | "plan-check", env: Env, opts: { strong?: boolean } = {}): string {
  const { agent, model } = strongAgentChoice(name, env, opts);
  return model ? `\`${agent}\` with \`model: "${model}"\`` : `\`${agent}\``;
}

/** `VERDICT: OK|FIX` from a checker's final answer; the last one wins. */
export function parseVerdict(text: string): Verdict | undefined {
  const all = [...text.matchAll(/^[\s>*_`#-]*VERDICT\s*:\s*\**\s*(OK|FIX)\b/gim)];
  const last = all.at(-1)?.[1];
  return last ? (last.toUpperCase() as Verdict) : undefined;
}

/** Last non-empty line of an answer starts with `BLOCKED:`: the agent needs a decision from the person. */
export const endsBlocked = (text: string) => /^\s*`?BLOCKED:/.test(text.trim().split("\n").filter((l) => l.trim()).at(-1) ?? "");

/** A subagent launched in the background is still running: the work is not finished, so nothing to gate yet. */
export const subagentRunning = (tasks: BackgroundTask[] | undefined) => (tasks ?? []).some((t) => t.type === "subagent" && t.status === "running");

/**
 * Loads this session's state and applies the resets: a new `prompt_id` clears the per-prompt counters, another task
 * clears the per-task ones. Returns a full state the handler mutates and stores with `store`.
 */
export async function loadGateState(ctx: HookContext, input: StopFields): Promise<SessionState> {
  const s = await ctx.session.load();
  if (input.prompt_id && s.promptId !== input.prompt_id) {
    Object.assign(s, { promptId: input.prompt_id, retries: 0, failures: 0, setupNudges: 0, lastBlock: undefined });
  }
  const taskId = ctx.task?.id;
  if (taskId && s.taskId !== taskId) {
    if (s.taskId !== undefined) {
      Object.assign(s, { reviews: 0, planChecks: 0, failures: 0, agents: undefined, review: undefined, planVerdict: undefined, reviewVerdict: undefined, verifiedFingerprint: undefined, lastBlock: undefined });
    }
    s.taskId = taskId;
  }
  return s;
}

/** Writes the whole state back (the store stamps `updatedAt`). */
export async function store(ctx: HookContext, s: SessionState): Promise<void> {
  const { sessionId: _id, updatedAt: _at, ...rest } = s;
  await ctx.session.save(rest);
}

export interface VerifyOutcome {
  ok: boolean;
  /** Bounded report for the model. */
  report: string;
  /** The failing step is an agentlint gate. */
  policy: boolean;
}

/** Runs the manifest's verify commands, bounded by the hook budget. */
export async function verify(ctx: HookContext, steps: string[]): Promise<VerifyOutcome> {
  const timeoutMs = Math.max(1_000, Math.min(10 * 60_000, ctx.deadline - Date.now() - MARGIN_MS));
  const result = await runVerify(steps, ctx.root, { timeoutMs, maxReport: REPORT_CHARS });
  return { ok: result.ok, report: formatVerify(result), policy: !result.ok && isPolicyFailure(result) };
}

const git = (root: string, args: string[]): Promise<string> =>
  new Promise((resolve) => execFile("git", ["-C", root, ...args], { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }, (err, out) => resolve(err ? "" : out)));

/** Fingerprint of the working copy (diff against the task's base, status, untracked sizes and times); empty when it is not a git repo. */
export async function fingerprint(root: string, task?: Pick<Task, "baseCommit">): Promise<string> {
  const [status, diff, others] = await Promise.all([
    git(root, ["status", "--porcelain"]),
    git(root, ["diff", await diffBase(root, task)]),
    git(root, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  if (!status && !diff && !others && !(await git(root, ["rev-parse", "--git-dir"]))) return "";
  const hash = createHash("sha1").update(status).update("\0").update(diff);
  for (const file of others.split("\n")) {
    if (!file || file.startsWith(`${WORKFLOW_DIR}/`)) continue;
    const st = await stat(path.join(root, file)).catch(() => undefined);
    hash.update(`\0${file}:${st?.size ?? "-"}:${st?.mtimeMs ?? "-"}`);
  }
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Texts the model reads (English, self-contained)
// ---------------------------------------------------------------------------

/** `risk` as the record kept in the session state. */
export const reviewRecord = (risk: { review: boolean; level: RiskLevel; reasons: string[] }): ReviewRecord => ({ level: risk.level, reasons: risk.reasons, requested: risk.review });

export const DIAGNOSE_METHOD = [
  "Diagnose before changing more code:",
  "1. Reproduce: run the failing command above and read the whole error.",
  "2. Isolate: find the smallest input, test or file that still fails.",
  "3. Hypothesis: write down one cause that explains every symptom, and check it by reading the code or adding a temporary print.",
  "4. Fix the cause, not the symptom. Do not weaken, skip or delete tests to make them pass.",
].join("\n");

export const POLICY_NOTE =
  "The failing step is an agentlint rule. Fix the code if the finding is right. If the rule needs an exception, do not work around it: stop and end your answer with `BLOCKED: <the exception you need and why>` so the person decides.";
