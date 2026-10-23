// Ticket evidence: MCP text captured by PostToolUse, specs and cited files, plus the plan-check brief.
// Plain text only: nothing here knows the project's language.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pluginDataDir, sessionStatePath } from "./paths.ts";
import type { Env } from "./paths.ts";
import type { Plan, Task } from "./types.ts";

/** Cap on the MCP text kept per session. */
export const MAX_MCP_TEXT = 300_000;
/** Cap on the evidence quoted in the plan-check brief. */
export const MAX_BRIEF_EVIDENCE = 20_000;
const MAX_SIBLINGS = 40;

// Claude Code's notice for results over the token limit (spike 0.7). Internal format: if it changes we keep the raw string.
const SAVED_TO_FILE = /^Error: result \(.*\) exceeds maximum allowed tokens\. Output has been saved to (.+?)\.\n/;
const IMAGE_NOTE = "[Image: source: ";

const readText = (file: string) => fs.readFile(file, "utf8").catch(() => undefined);

/**
 * Text of one MCP `tool_response` (spike 0.7): an array of blocks (`type: "text"` only), a string (serialized
 * `structuredContent`) or the "saved to <path>" notice, whose file is read. Never throws.
 */
export async function mcpResponseText(toolResponse: unknown): Promise<string> {
  if (Array.isArray(toolResponse)) {
    return toolResponse
      .filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string" && !b.text.startsWith(IMAGE_NOTE))
      .map((b) => b.text)
      .join("\n");
  }
  if (typeof toolResponse !== "string") return "";
  const saved = SAVED_TO_FILE.exec(toolResponse)?.[1];
  if (!saved) return toolResponse;
  const file = saved.startsWith("~/") ? path.join(os.homedir(), saved.slice(2)) : saved;
  return (await readText(file)) ?? toolResponse;
}

/** `${CLAUDE_PLUGIN_DATA}/evidence/<session_id>.txt`: hooks are separate processes, so the text goes to disk. */
function evidencePath(session: string, env: Env): string {
  const id = path.basename(sessionStatePath(session, env), ".json");
  return path.join(pluginDataDir(env), "evidence", `${id}.txt`);
}

/** Text captured so far for a session ("" when none). */
export async function readMcpText(session: string, env: Env = process.env): Promise<string> {
  return (await readText(evidencePath(session, env))) ?? "";
}

/** Appends the text of an MCP result to the session's evidence, capped at MAX_MCP_TEXT. Returns the stored total. */
export async function captureMcpText(session: string, toolResponse: unknown, env: Env = process.env): Promise<string> {
  const text = await mcpResponseText(toolResponse);
  if (!text) return readMcpText(session, env);
  const file = evidencePath(session, env);
  const current = (await readText(file)) ?? "";
  if (current.length >= MAX_MCP_TEXT) return current;
  const total = (current ? `${current}\n${text}` : text).slice(0, MAX_MCP_TEXT);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, total);
  return total;
}

const inside = (root: string, rel: string) => {
  const abs = path.resolve(root, rel);
  return abs.startsWith(path.resolve(root) + path.sep) ? abs : undefined;
};

/**
 * Everything the interface names can be checked against: ticket key, MCP text, spec files and the
 * existing files cited as `source` by the plan. Unreadable or out-of-repo files count as empty.
 * The title is not evidence: the model writes it, so a name invented there would pass the names gate.
 */
export async function evidenceFor(root: string, task: Task, mcpText = ""): Promise<string> {
  const parts = [...(task.ticket ? [task.ticket] : []), mcpText];
  const plan = task.plan;
  const cited = (plan?.interface ?? []).map((i) => i.source).filter((s): s is string => !!s);
  for (const rel of new Set([...(plan?.spec ?? []), ...cited])) {
    const abs = inside(root, rel);
    if (abs) parts.push((await readText(abs)) ?? "");
  }
  return parts.filter(Boolean).join("\n");
}

/** Files next to each planned file: the naming convention the new names must follow. */
export async function siblings(root: string, plan: Plan): Promise<string[]> {
  const dirs = [...new Set(plan.files.map((f) => (f.endsWith("/") ? f.slice(0, -1) : path.posix.dirname(f))))];
  const lines: string[] = [];
  for (const dir of dirs) {
    const names = (await fs.readdir(path.join(root, dir)).catch(() => [] as string[])).filter((n) => !n.startsWith(".")).sort();
    if (!names.length) continue;
    lines.push(`- ${dir}/: ${names.slice(0, MAX_SIBLINGS).join(", ")}${names.length > MAX_SIBLINGS ? ", …" : ""}`);
  }
  return lines;
}

/** The plan as plain text for the brief. */
function planBrief(plan: Plan): string {
  return [
    plan.title,
    "",
    "Files:",
    ...plan.files.map((f) => `- ${f}`),
    ...(plan.interface.length
      ? ["", "Interface:", ...plan.interface.map((i) => `- ${i.file}: ${[...i.exports, ...(i.signatures ?? [])].join(", ")}${i.source ? ` (${i.source})` : ""}`)]
      : []),
    ...(plan.seams.length ? ["", "Seams:", ...plan.seams.map((s) => `- ${s.name} -> ${s.testFile}: ${s.catches}${s.misses ? ` (not covered: ${s.misses})` : ""}`)] : []),
    ...(plan.decisions.length ? ["", "Decisions:", ...plan.decisions.map((d) => `- ${d.question} -> ${d.answer ?? `see ${d.source}`}`)] : []),
  ].join("\n");
}

/** Prompt for the strong-model plan check; the evidence is cut to MAX_BRIEF_EVIDENCE characters. */
export function buildPlanBrief(task: Task, plan: Plan, evidence: string, siblingLines: string[]): string {
  const text = evidence.length > MAX_BRIEF_EVIDENCE ? `${evidence.slice(0, MAX_BRIEF_EVIDENCE)}\n…(truncated)` : evidence;
  return [
    `# Plan check: ${task.title}`,
    "You are a senior engineer checking a plan BEFORE any code is written. The plan was made by a cheaper model; a cheap model will implement it literally, so what is wrong here is wrong in the code.",
    "Check only these, against the ticket, the existing code (read it with your tools) and the sibling files:",
    "1. Interface: file names follow the naming convention of their sibling files; export names and argument shapes match what the ticket, docs or existing callers use (objects vs positional, units, types). Flag names the ticket never gives and a sibling module already defines differently.",
    "2. Reuse: an existing helper (validator, parser, formatter, type) in the repo that the plan should use instead of writing a new one.",
    "3. Robustness the ticket implies: invalid inputs rejected, boundaries from the ticket's acceptance criteria covered by the seams.",
    "4. Scope: a file the plan must touch and does not list, or lists and must not.",
    "Do not comment on style, wording or things you are not sure about. Keep it under 250 words.",
    "Finish with `VERDICT: OK` or `VERDICT: FIX` followed by a numbered list of concrete fixes (what to rename/change and why, with the file or ticket line that decides it).",
    "## Ticket evidence",
    text || "(only the title)",
    "## Plan",
    planBrief(plan),
    "## Sibling files",
    ...(siblingLines.length ? siblingLines : ["- (new directories)"]),
    "",
  ].join("\n");
}

export type PlanCheckStatus = "ok" | "fix" | "skipped";
export interface PlanCheckResult {
  status: PlanCheckStatus;
  report: string;
}

/** Reads the plan-check output: the last `VERDICT:` line wins; FIX keeps the findings from that line on. */
export function parsePlanVerdict(output: string): PlanCheckResult | undefined {
  const last = [...output.matchAll(/^\W*VERDICT:\s*(OK|FIX)\b/gim)].at(-1);
  if (!last) return undefined;
  const body = output.trim();
  if (last[1]?.toUpperCase() === "OK") return { status: "ok", report: body };
  const text = output.split("\n").slice(output.slice(0, last.index).split("\n").length - 1).join("\n");
  return { status: "fix", report: text.trim() || body };
}
