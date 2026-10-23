// SessionStart: a short note for the model when the project has no finished setup, and the open task's summary.
// `setup: "declined"` means the user opted out: no setup note. Nothing here blocks; it only adds context.
import { readFile } from "node:fs/promises";
import { MANIFEST_PATH, manifestPath } from "../paths.ts";
import type { ContextOutput, SetupStatus, Task } from "../types.ts";
import type { HookContext, HookModule } from "./dispatch.ts";

/** What the manifest says about setup: `missing` without a file, `unreadable` when it is not a JSON object. */
export type SetupState = SetupStatus | "missing" | "unreadable";

/** Reads `setup` from `.claude/workflow.json`. Never throws. */
export async function setupState(root: string): Promise<SetupState> {
  let text: string;
  try {
    text = await readFile(manifestPath(root), "utf8");
  } catch (err) {
    return (err as { code?: unknown }).code === "ENOENT" ? "missing" : "unreadable";
  }
  try {
    const value = JSON.parse(text) as { setup?: unknown };
    const setup = value && typeof value === "object" ? value.setup : undefined;
    return setup === "pending" || setup === "running" || setup === "done" || setup === "declined" ? setup : "unreadable";
  } catch {
    return "unreadable";
  }
}

/** The one-line note when setup is done: both ways of working, without pushing either. */
export const MODES_NOTE =
  "Work directly with what /setup produced (CLAUDE.md, skills, verification tools), or use /task for gated work. Mention this to the user, in Spanish, only if relevant.";

/** The setup note for the model: the modes line when done, `undefined` when declined. */
export function setupNote(state: SetupState): string | undefined {
  switch (state) {
    case "done":
      return MODES_NOTE;
    case "declined":
      return undefined;
    case "missing":
      return `This project has no workflow manifest (${MANIFEST_PATH}). If the user starts a task, offer to run /setup first; do not run it unasked.`;
    case "unreadable":
      return `The workflow manifest (${MANIFEST_PATH}) is not valid. Tell the user and offer to run /setup to repair it; do not edit it unasked.`;
    case "running":
      return "The workflow setup of this project was started but not finished. Offer the user to resume it with /setup.";
    case "pending":
      return "The workflow setup of this project is pending. If the user starts a task, offer to run /setup first; do not run it unasked.";
  }
}

/** One-paragraph summary of an open task, or `undefined` when there is none or it is closed. */
export function taskSummary(task: Task | undefined): string | undefined {
  if (!task || task.status === "done") return undefined;
  const head = `Open workflow task: "${task.title}"${task.ticket ? ` (${task.ticket})` : ""}, status ${task.status}.`;
  const files = task.plan?.files.length ? ` Plan files: ${task.plan.files.join(", ")}.` : "";
  const planFile = task.planFilePath ? ` Plan: ${task.planFilePath}.` : "";
  const next =
    task.status === "planning"
      ? " The plan is waiting for the user's approval."
      : " Change only the plan files; verification runs automatically when you stop. The user closes the task with /done.";
  return head + files + planFile + next;
}

export default {
  async SessionStart(_input, ctx: HookContext): Promise<ContextOutput | undefined> {
    const parts = [setupNote(await setupState(ctx.root)), taskSummary(ctx.task)].filter((p): p is string => !!p);
    if (!parts.length) return undefined;
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: parts.join("\n") } };
  },
} satisfies HookModule;
