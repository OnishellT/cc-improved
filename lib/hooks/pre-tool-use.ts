// PreToolUse guards for the implementation phase: files outside the plan, new dependencies, migrations and agentlint.
// The hook never approves anything (`allow` would skip Claude Code's own permissions): it asks, denies or stays quiet.
// When the person rejects an `ask`, the agent only sees the rejection, not this reason (spike 0.5). What to do next
// lives in the implementer prompt; the reason must make sense alone, because headless runs turn `ask` into a denial
// and the agent reads it verbatim.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { sessionStatePath } from "../paths.ts";
import type { PreToolUseInput, PreToolUseOutput, Task } from "../types.ts";
import {
  applyEdits,
  dependencyNames,
  IGNORED,
  inScope,
  installersIn,
  isAgentlintAccept,
  isInteractiveAgentlint,
  isManifest,
  isMigration,
  newDependencies,
  toRelative,
} from "../triggers.ts";
import type { HookContext, HookModule } from "./dispatch.ts";

/** Tools this module inspects; every other tool gets no opinion. */
export const GUARDED_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"] as const;

/** Agents that implement the plan: guarded whatever the task status. */
const IMPLEMENTERS = new Set(["implementer", "fixer"]);
/** Read-only agents: never guarded. */
const READ_ONLY = new Set(["reviewer", "plan-check"]);

/** Agent name without the plugin prefix (`wf:implementer`) or the model variant suffix (`fixer-sonnet`). */
export function agentRole(agentType: string | undefined): string | undefined {
  if (!agentType) return undefined;
  return agentType.slice(agentType.lastIndexOf(":") + 1).replace(/-sonnet$/, "");
}

/**
 * Whether the plan guards apply to this call: always inside `implementer`/`fixer`, never inside
 * `reviewer`/`plan-check`, and elsewhere (main session or another subagent) only while the task is `implementing`.
 */
export function guarded(input: Pick<PreToolUseInput, "agent_type">, task: Task | undefined): boolean {
  const role = agentRole(input.agent_type);
  if (role && READ_ONLY.has(role)) return false;
  if (role && IMPLEMENTERS.has(role)) return true;
  return task?.status === "implementing";
}

const ask = (reasons: string[], additionalContext?: string): PreToolUseOutput => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "ask",
    permissionDecisionReason: reasons.join(" "),
    ...(additionalContext ? { additionalContext } : {}),
  },
});

const deny = (reason: string): PreToolUseOutput => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});

const INTERACTIVE_REASON =
  "This agentlint command opens an interactive UI for a person and would hang. Use `agentlint rules scan` or `agentlint next --format json` instead.";
const ACCEPT_REASON = (command: string) =>
  `Recording an agentlint exception is the user's decision (\`${command.trim()}\`). Approve only if the finding is wrong or accepted on purpose; otherwise the agent must fix the code so the finding no longer applies.`;

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Path the tool writes, or `undefined` when the input carries none. */
function targetPath(input: PreToolUseInput): string | undefined {
  const p = input.tool_name === "NotebookEdit" ? input.tool_input.notebook_path : input.tool_input.file_path;
  return typeof p === "string" && p ? p : undefined;
}

interface Replacement {
  oldText: string;
  newText: string;
  all: boolean;
}

function replacements(input: PreToolUseInput): Replacement[] {
  const one = (e: Record<string, unknown>): Replacement => ({ oldText: str(e.old_string), newText: str(e.new_string), all: e.replace_all === true });
  if (input.tool_name === "Edit") return [one(input.tool_input)];
  const edits = input.tool_input.edits;
  return Array.isArray(edits) ? edits.filter((e): e is Record<string, unknown> => !!e && typeof e === "object").map(one) : [];
}

/** Text after the edits, or `undefined` when an edit does not apply cleanly. */
function edited(original: string, edits: Replacement[]): string | undefined {
  let text: string | undefined = original;
  for (const e of edits) {
    if (text === undefined) return undefined;
    if (!e.all) text = applyEdits(text, [e]);
    else text = e.oldText && text.includes(e.oldText) ? text.split(e.oldText).join(e.newText) : undefined;
  }
  return text;
}

async function readOr(file: string, fallback: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return fallback;
    throw err;
  }
}

/** Reasons to ask about a dependency manifest change; empty when no dependency is added. */
async function manifestReasons(input: PreToolUseInput, abs: string, file: string): Promise<string[]> {
  const original = await readOr(abs, "");
  const before = dependencyNames(file, original);
  let next: string | undefined;
  if (input.tool_name === "Write") next = str(input.tool_input.content);
  else if (input.tool_name === "Edit" || input.tool_name === "MultiEdit") next = edited(original, replacements(input));
  const added = newDependencies(before, next === undefined ? undefined : dependencyNames(file, next));
  if (added === undefined) return [`New dependency check: this ${input.tool_name} changes the dependency manifest ${file} and the added dependencies could not be determined.`];
  if (added.length === 0) return [];
  return [`New dependency: this ${input.tool_name} adds ${added.join(", ")} to ${file}. A new dependency is the user's decision and needs an ADR in docs/adr/.`];
}

async function fileReasons(input: PreToolUseInput, ctx: HookContext): Promise<string[]> {
  const target = targetPath(input);
  if (!target) return [];
  const abs = path.resolve(ctx.root, target);
  const file = toRelative(ctx.root, abs);
  // Outside the project (scratch files, the plan-mode file) the diff is untouched: not ours to guard.
  if (file === "" || file === ".." || file.startsWith("../") || path.isAbsolute(file)) return [];
  if (IGNORED.some((d) => file.startsWith(d))) return [];

  const reasons: string[] = [];
  const plan = ctx.task?.plan;
  if (plan && !inScope(plan, file, ctx.task?.allowedExtra ?? [])) {
    reasons.push(`Outside the approved plan: ${file} is not in the plan's files list. Approve only if the task really needs it.`);
  }
  if (isManifest(file)) reasons.push(...(await manifestReasons(input, abs, file)));
  if (isMigration(file)) reasons.push(`Schema or migration change: ${file}. Migrations need the user's approval.`);
  return reasons;
}

function bashReasons(command: string): string[] {
  const names = installersIn(command);
  return names.length ? [`New dependency: this command installs ${names.join(", ")}. A new dependency is the user's decision and needs an ADR in docs/adr/.`] : [];
}

// ---------------------------------------------------------------------------
// "Plan files" context, given once per agent and task: `${CLAUDE_PLUGIN_DATA}/sessions/<session_id>.pre-tool-use.json`
// ---------------------------------------------------------------------------

interface Notified {
  /** `<task id> <agent id or "main">` keys that already got the plan files list. */
  seen: string[];
}

const notifiedPath = (sessionId: string, env: HookContext["env"]) => sessionStatePath(sessionId, env).replace(/\.json$/, ".pre-tool-use.json");

/** The plan files list the first time this agent hits a guarded tool on this task; `undefined` afterwards. */
async function planContext(input: PreToolUseInput, ctx: HookContext): Promise<string | undefined> {
  const task = ctx.task;
  if (!task?.plan) return undefined;
  const key = `${task.id} ${input.agent_id ?? "main"}`;
  let file: string;
  try {
    file = notifiedPath(input.session_id, ctx.env);
  } catch (err) {
    await ctx.log(`pre-tool-use: no plan context (${err instanceof Error ? err.message : String(err)})`);
    return undefined;
  }
  let state: Notified = { seen: [] };
  try {
    const parsed = JSON.parse(await readOr(file, '{"seen":[]}')) as Partial<Notified>;
    if (Array.isArray(parsed.seen)) state = { seen: parsed.seen.filter((s): s is string => typeof s === "string") };
  } catch {
    await ctx.log(`pre-tool-use: unreadable ${file}; starting over`);
  }
  if (state.seen.includes(key)) return undefined;
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ seen: [...state.seen, key] }, null, 2)}\n`);
  await rename(tmp, file);
  const files = [...task.plan.files, ...task.allowedExtra];
  return [
    `Approved plan files for "${task.title}" (entries ending in / cover a directory):`,
    ...files.map((f) => `- ${f}`),
    "Edits outside this list, new dependencies and migrations need the user's approval; a rejected call is not retried.",
  ].join("\n");
}

export default {
  async PreToolUse(input, ctx) {
    if (!(GUARDED_TOOLS as readonly string[]).includes(input.tool_name)) return;
    const command = input.tool_name === "Bash" ? str(input.tool_input.command) : "";
    // An interactive agentlint run hangs in any context, guarded or not.
    if (command && isInteractiveAgentlint(command)) return deny(INTERACTIVE_REASON);
    if (!guarded(input, ctx.task)) return;

    const reasons = command ? bashReasons(command) : await fileReasons(input, ctx);
    if (command && isAgentlintAccept(command)) reasons.push(ACCEPT_REASON(command));
    const context = await planContext(input, ctx);
    if (reasons.length) return ask(reasons, context);
    if (context) return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: context } };
  },
} satisfies HookModule;
