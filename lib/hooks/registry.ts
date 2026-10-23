// Which modules handle each hook event, and how long the entry waits for them.
// A module listed here but not written yet is skipped in silence, so the per-event issues only add their file.
import { fileURLToPath } from "node:url";
import type { HookEventName } from "../types.ts";
import type { HookModule } from "./dispatch.ts";

/** Loads one handler module; `undefined` when the module does not exist yet. */
export type ModuleLoader = () => Promise<HookModule | undefined>;

export interface EventRoute {
  /** Tried in order; the first handler that returns an output wins and the rest are not run. */
  modules: ModuleLoader[];
  /** Internal deadline in ms. It must stay below the `timeout` (seconds) of the event in `hooks/hooks.json`. */
  budgetMs: number;
}

/** Budget for events that only read state or add context; their `hooks.json` timeout is 10 s or more. */
export const QUICK_BUDGET_MS = 8_000;
/** Budget for events that may run the manifest's verify commands; their `hooks.json` timeout is 600 s. */
export const GATE_BUDGET_MS = 570_000;

/**
 * Loader for `lib/hooks/<file>`. A missing file means "not implemented yet" and loads as `undefined`;
 * any other failure (syntax error, a missing import inside the module) propagates and is logged.
 */
export function moduleFile(file: string): ModuleLoader {
  const url = new URL(file, import.meta.url);
  return async () => {
    try {
      const mod = (await import(url.href)) as { default?: HookModule };
      return mod.default;
    } catch (err) {
      if (isMissing(err, url)) return undefined;
      throw err;
    }
  };
}

function isMissing(err: unknown, url: URL): boolean {
  const e = err as { code?: unknown; url?: unknown; message?: unknown };
  if (e?.code !== "ERR_MODULE_NOT_FOUND") return false;
  // Only the module itself being absent counts; a missing import inside it is a real error.
  return e.url === url.href || (typeof e.message === "string" && e.message.startsWith(`Cannot find module '${fileURLToPath(url)}'`));
}

/** Event → handler modules. Order matters only when two modules answer the same input. */
export const REGISTRY: Record<HookEventName, EventRoute> = {
  SessionStart: { modules: [moduleFile("./session-start.ts")], budgetMs: QUICK_BUDGET_MS },
  UserPromptSubmit: { modules: [moduleFile("./user-prompt-submit.ts")], budgetMs: QUICK_BUDGET_MS },
  PreToolUse: { modules: [moduleFile("./exit-plan-mode.ts"), moduleFile("./pre-tool-use.ts")], budgetMs: QUICK_BUDGET_MS },
  PostToolUse: { modules: [moduleFile("./exit-plan-mode.ts"), moduleFile("./mcp-evidence.ts")], budgetMs: QUICK_BUDGET_MS },
  SubagentStart: { modules: [moduleFile("./subagent-start.ts")], budgetMs: QUICK_BUDGET_MS },
  SubagentStop: { modules: [moduleFile("./subagent-stop.ts")], budgetMs: GATE_BUDGET_MS },
  Stop: { modules: [moduleFile("./stop.ts")], budgetMs: GATE_BUDGET_MS },
  SessionEnd: { modules: [moduleFile("./session-end.ts")], budgetMs: QUICK_BUDGET_MS },
};
