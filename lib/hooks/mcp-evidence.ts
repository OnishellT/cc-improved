// PostToolUse of `mcp__*` tools: keeps the text of the result as ticket evidence for the plan's verified names.
// Captured while the task is being planned (no task yet, or `planning`); during implementation it is not needed.
// Stored per `session_id` by lib/evidence.ts, so a subagent's reads land in the orchestrator's evidence.
// Silent: it never adds context nor blocks the tool result.
import { captureMcpText } from "../evidence.ts";
import type { PostToolUseInput, Task } from "../types.ts";
import type { HookContext, HookModule } from "./dispatch.ts";

// Claude Code's notice for results saved to a file (spike 0.7); used only to log when that file was not readable.
const SAVED_NOTICE = /^Error: result \(.*\) exceeds maximum allowed tokens\. Output has been saved to /;

/** Whether this tool call is an MCP tool whose result counts as evidence for the current task. */
export function capturesEvidence(input: Pick<PostToolUseInput, "tool_name">, task: Task | undefined): boolean {
  if (!input.tool_name.startsWith("mcp__")) return false;
  return task?.status !== "implementing";
}

export default {
  async PostToolUse(input, ctx: HookContext) {
    if (!capturesEvidence(input, ctx.task)) return undefined;
    const response = input.tool_response;
    const total = await captureMcpText(input.session_id, response, ctx.env);
    if (typeof response === "string" && SAVED_NOTICE.test(response) && total.includes(response)) {
      await ctx.log(`${input.tool_name}: the saved-to-file result could not be read; kept the notice as evidence`);
    }
    return undefined;
  },
} satisfies HookModule;
