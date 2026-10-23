// SubagentStart: light telemetry. One JSON line per started subagent in
// `${CLAUDE_PLUGIN_DATA}/telemetry/<session_id>.jsonl` (a subagent carries its parent's session_id).
// Never blocks and never adds context: a failure is logged and the subagent starts as usual.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginDataDir, sessionStatePath, type Env } from "../paths.ts";
import type { SubagentStartInput } from "../types.ts";
import type { HookContext, HookModule } from "./dispatch.ts";

/** One telemetry line. `model` is the `model:` of the plugin agent's frontmatter; absent for other agents. */
export interface SubagentStartRecord {
  at: string;
  event: "SubagentStart";
  agent_id: string;
  agent_type: string;
  model?: string;
  prompt_id?: string;
}

const AGENTS_DIR = fileURLToPath(new URL("../../agents/", import.meta.url));
const AGENT_NAME = /^[A-Za-z0-9_-]+$/;

/** `${CLAUDE_PLUGIN_DATA}/telemetry/<session_id>.jsonl`. Rejects ids that could escape the folder. */
export function telemetryPath(sessionId: string, env: Env = process.env): string {
  const id = path.basename(sessionStatePath(sessionId, env), ".json");
  return path.join(pluginDataDir(env), "telemetry", `${id}.jsonl`);
}

/** `model:` of `agents/<name>.md` for a plugin agent (`cc-improved:fixer-sonnet` → `sonnet`); `undefined` otherwise. */
export async function agentModel(agentType: string, agentsDir: string = AGENTS_DIR): Promise<string | undefined> {
  const name = agentType.slice(agentType.lastIndexOf(":") + 1);
  if (!AGENT_NAME.test(name)) return undefined;
  const text = await readFile(path.join(agentsDir, `${name}.md`), "utf8").catch(() => "");
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  return front ? /^model:\s*["']?([^"'\s]+)/m.exec(front)?.[1] : undefined;
}

/** Appends the record of one started subagent to its session's telemetry. */
export async function recordSubagentStart(input: SubagentStartInput, env: Env, at: Date = new Date(), agentsDir?: string): Promise<SubagentStartRecord> {
  const model = await agentModel(input.agent_type, agentsDir);
  const record: SubagentStartRecord = {
    at: at.toISOString(),
    event: "SubagentStart",
    agent_id: input.agent_id,
    agent_type: input.agent_type,
    ...(model ? { model } : {}),
    ...(input.prompt_id ? { prompt_id: input.prompt_id } : {}),
  };
  const file = telemetryPath(input.session_id, env);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`);
  return record;
}

export default {
  async SubagentStart(input, ctx: HookContext) {
    try {
      await recordSubagentStart(input, ctx.env);
    } catch (err) {
      await ctx.log(`subagent telemetry not recorded: ${err instanceof Error ? err.message : String(err)}`);
    }
    return undefined;
  },
} satisfies HookModule;
