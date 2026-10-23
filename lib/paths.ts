// Where the workflow keeps its state. Pure path math: nothing here touches the disk.
import * as path from "node:path";

/** Environment the paths read; defaults to `process.env`. Tests pass their own. */
export type Env = Record<string, string | undefined>;

/** Project manifest, committed. Relative to the project root. */
export const MANIFEST_PATH = ".claude/workflow.json";
/** Folder for workflow files inside the project. */
export const WORKFLOW_DIR = ".claude/workflow";
/** Active task, local to the working copy (gitignored). */
export const TASK_PATH = `${WORKFLOW_DIR}/task.json`;
/** Closed tasks, one JSON per line, committed so related tasks travel with the repo. */
export const TASKS_LOG_PATH = `${WORKFLOW_DIR}/tasks.jsonl`;

/**
 * Project root: `CLAUDE_PROJECT_DIR` when Claude Code set it, else `fallback`.
 * Hooks pass the event's `cwd` as fallback; scripts get `process.cwd()`.
 */
export function projectDir(env: Env = process.env, fallback: string = process.cwd()): string {
  return path.resolve(env.CLAUDE_PROJECT_DIR || fallback);
}

export const manifestPath = (root: string) => path.join(root, MANIFEST_PATH);
export const taskPath = (root: string) => path.join(root, TASK_PATH);
export const tasksLogPath = (root: string) => path.join(root, TASKS_LOG_PATH);

/**
 * The plugin's persistent data folder (`CLAUDE_PLUGIN_DATA`), set by Claude Code for hooks and plugin commands.
 * Throws when it is missing: state written elsewhere would be silently lost.
 */
export function pluginDataDir(env: Env = process.env): string {
  const dir = env.CLAUDE_PLUGIN_DATA;
  if (!dir) throw new Error("CLAUDE_PLUGIN_DATA is not set: run this from a Claude Code hook or plugin command.");
  return path.resolve(dir);
}

/** Folder for per-session state files. */
export const sessionsDir = (env: Env = process.env) => path.join(pluginDataDir(env), "sessions");

const SESSION_ID = /^[A-Za-z0-9_-]+$/;

/** `${CLAUDE_PLUGIN_DATA}/sessions/<session_id>.json`. Rejects ids that could escape the folder. */
export function sessionStatePath(sessionId: string, env: Env = process.env): string {
  if (!SESSION_ID.test(sessionId)) throw new Error(`Invalid session_id: ${JSON.stringify(sessionId)}`);
  return path.join(sessionsDir(env), `${sessionId}.json`);
}

/** Folder where hooks log their errors instead of throwing. */
export const logDir = (env: Env = process.env) => path.join(pluginDataDir(env), "log");
