// Hook dispatch: raw stdin → handler module for the event → stdout text. Never throws: every failure is logged
// under `${CLAUDE_PLUGIN_DATA}/log/` and turns into empty output, which Claude Code reads as "no opinion".
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { logDir, projectDir, sessionStatePath, taskPath, type Env } from "../paths.ts";
import type { HookEventName, HookInput, HookInputOf, HookOutputMap, SessionState, Task } from "../types.ts";
import { REGISTRY, type EventRoute } from "./registry.ts";

/** Per-session counters of the event's own `session_id` (a subagent's events carry the parent's id). */
export interface SessionStore {
  /** Current state; all counters zero when the session has no file yet. */
  load(): Promise<SessionState>;
  /** Merges `patch` into the stored state, stamps `updatedAt` and writes it atomically. Returns the new state. */
  save(patch: Partial<Omit<SessionState, "sessionId" | "updatedAt">>): Promise<SessionState>;
}

/** What a handler gets besides its input. */
export interface HookContext {
  env: Env;
  /** Project root: `CLAUDE_PROJECT_DIR`, else the event's `cwd`. */
  root: string;
  /** Active task of this working copy, owned by this session (or by none); `undefined` when there is none. */
  task: Task | undefined;
  /** Writes `task.json` atomically, owned by this session. */
  saveTask(task: Task): Promise<void>;
  session: SessionStore;
  /** Aborted when the event's budget runs out; pass it to child processes. */
  signal: AbortSignal;
  /** Epoch ms after which the output is discarded. */
  deadline: number;
  /** Appends a line to the hook log. Never throws. */
  log(message: string): Promise<void>;
}

/** Handler for one event. Returning `undefined` (or `{}`) means "no opinion" and lets the next module answer. */
export type HookHandler<E extends HookEventName> = (
  input: HookInputOf<E>,
  ctx: HookContext,
) => HookOutputMap[E] | undefined | void | Promise<HookOutputMap[E] | undefined | void>;

/** Shape of the default export of a `lib/hooks/<module>.ts`: one handler per event it cares about. */
export type HookModule = { [E in HookEventName]?: HookHandler<E> };

export interface DispatchOptions {
  env?: Env;
  /** Overrides the routes, for tests. */
  registry?: Partial<Record<HookEventName, EventRoute>>;
  now?: () => Date;
}

/** Runs the handlers for one raw hook input and returns what to print (empty string for nothing). Never throws. */
export async function dispatch(raw: string, options: DispatchOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  let input: HookInput | undefined;
  const log = (message: string) => writeLog(env, now(), input, message);
  try {
    input = parseInput(raw);
    if (!input) {
      await log(`ignored input that is not a hook event: ${raw.slice(0, 200)}`);
      return "";
    }
    const route = (options.registry ?? REGISTRY)[input.hook_event_name];
    if (!route || route.modules.length === 0) return "";
    return await withDeadline(route.budgetMs, (signal, deadline) => run(input!, route, env, signal, deadline, log), log);
  } catch (err) {
    await log(errorText(err));
    return "";
  }
}

async function run(input: HookInput, route: EventRoute, env: Env, signal: AbortSignal, deadline: number, log: HookContext["log"]): Promise<string> {
  const root = projectDir(env, input.cwd);
  const stored = await readTask(root, log);
  // Ownership: task.json carries the `sessionId` of the session that wrote it (`Task.sessionId`); a task without it
  // counts as owned by every session.
  if (stored && typeof stored.sessionId === "string" && stored.sessionId !== input.session_id) return "";

  const ctx: HookContext = {
    env,
    root,
    task: stored?.task,
    async saveTask(task) {
      await writeJsonAtomic(taskPath(root), { ...task, sessionId: input.session_id });
      ctx.task = task;
    },
    session: sessionStore(input.session_id, env),
    signal,
    deadline,
    log,
  };

  for (const load of route.modules) {
    const mod = await load();
    const handler = mod?.[input.hook_event_name] as HookHandler<HookEventName> | undefined;
    if (!handler) continue;
    const out = await handler(input as HookInputOf<HookEventName>, ctx);
    if (signal.aborted) return "";
    if (out === undefined || out === null) continue;
    if (typeof out !== "object" || Array.isArray(out)) throw new Error(`${input.hook_event_name} handler returned a non-object output`);
    if (Object.keys(out).length === 0) continue;
    return JSON.stringify(out);
  }
  return "";
}

/** Validates the fields every handler relies on; `undefined` for anything that is not a hook event. */
export function parseInput(raw: string): HookInput | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.hook_event_name !== "string" || typeof v.session_id !== "string" || typeof v.cwd !== "string") return undefined;
  if (!(v.hook_event_name in REGISTRY)) return undefined;
  return v as unknown as HookInput;
}

async function withDeadline(budgetMs: number, work: (signal: AbortSignal, deadline: number) => Promise<string>, log: HookContext["log"]): Promise<string> {
  const controller = new AbortController();
  const deadline = Date.now() + budgetMs;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`hook budget of ${budgetMs} ms exhausted`));
      resolve(log(`timed out after ${budgetMs} ms; output discarded`).then(() => ""));
    }, budgetMs);
    timer.unref();
  });
  try {
    return await Promise.race([work(controller.signal, deadline), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface StoredTask {
  task: Task;
  sessionId: unknown;
}

async function readTask(root: string, log: HookContext["log"]): Promise<StoredTask | undefined> {
  let text: string;
  try {
    text = await readFile(taskPath(root), "utf8");
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    const { sessionId, ...task } = JSON.parse(text) as Task & { sessionId?: unknown };
    return { task: task as Task, sessionId };
  } catch {
    await log(`unreadable ${taskPath(root)}; treated as no active task`);
    return undefined;
  }
}

function sessionStore(sessionId: string, env: Env): SessionStore {
  const empty = (): SessionState => ({ sessionId, retries: 0, reviews: 0, failures: 0, planChecks: 0, updatedAt: new Date(0).toISOString() });
  const load = async (): Promise<SessionState> => {
    try {
      const stored = JSON.parse(await readFile(sessionStatePath(sessionId, env), "utf8")) as Partial<SessionState>;
      return { ...empty(), ...stored, sessionId };
    } catch (err) {
      if ((err as { code?: unknown }).code === "ENOENT") return empty();
      throw err;
    }
  };
  return {
    load,
    async save(patch) {
      const next: SessionState = { ...(await load()), ...patch, sessionId, updatedAt: new Date().toISOString() };
      await writeJsonAtomic(sessionStatePath(sessionId, env), next);
      return next;
    },
  };
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, file);
}

async function writeLog(env: Env, at: Date, input: HookInput | undefined, message: string): Promise<void> {
  try {
    const dir = logDir(env);
    await mkdir(dir, { recursive: true });
    const where = input ? `${input.hook_event_name} session=${input.session_id}` : "-";
    await appendFile(path.join(dir, `wf-hook-${at.toISOString().slice(0, 10)}.log`), `${at.toISOString()} ${where} ${message}\n`);
  } catch {
    // No data dir or an unwritable log: there is nowhere left to report; stay silent.
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}
