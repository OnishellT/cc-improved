// What the optional mod shows, as pure functions over the workflow's files. No engine and no Node imports here: the
// mod's environment has neither, and `npm test` / `npm run typecheck` cover this file through test/mod-status.test.ts.
// The gates live in the classic hooks (hooks/hooks.json → lib/hooks/); this file only describes their state.
import type { SessionState, Task } from "../lib/types.ts";

/**
 * Same value as `TASK_PATH` in lib/paths.ts, which cannot be imported here (it loads `node:path`, and the mod has no
 * Node). test/mod-status.test.ts fails if the two drift apart.
 */
export const MOD_TASK_PATH = ".claude/workflow/task.json";
/** Plugin name; its data folder under `plugins/data/` starts with it (`cc-improved-<marketplace>`). */
export const MOD_PLUGIN = "cc-improved";
/** Id of the pane and name of the slash command. */
export const MOD_PANE = "wf";

/** Token counts of one turn, as `turn.complete` reports them (`ModelUsage`). */
export interface TurnTokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** Everything one drawing needs, read fresh from disk and from the engine. */
export interface WfSnapshot {
  /** task.json, `undefined` when there is none or it does not parse. */
  task?: Task | undefined;
  /** This session's gate counters, `undefined` when the hooks have not written them (or they could not be found). */
  session?: SessionState | undefined;
  /** This session's id, to tell a task owned by another session. */
  sessionId?: string | undefined;
  /** Tokens of the last main-loop turn. */
  lastTurn?: TurnTokens | undefined;
  /** Tokens summed over the turns this load of the mod saw (main loop and subagents). */
  totals?: TurnTokens | undefined;
  /** What the session has cost so far, as /cost totals it. */
  costUsd?: number | undefined;
}

export const zeroTokens = (): TurnTokens => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** Reads a usage object defensively: any field missing or not a number counts as 0. */
export function toTokens(usage: unknown): TurnTokens {
  const u = (usage && typeof usage === "object" ? usage : {}) as Record<string, unknown>;
  return {
    input_tokens: count(u.input_tokens),
    output_tokens: count(u.output_tokens),
    cache_read_input_tokens: count(u.cache_read_input_tokens),
    cache_creation_input_tokens: count(u.cache_creation_input_tokens),
  };
}

export function addTokens(a: TurnTokens, b: TurnTokens): TurnTokens {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  };
}

/** Input side of a turn: fresh, cache read and cache write together. */
export const inputSide = (t: TurnTokens) => t.input_tokens + t.cache_read_input_tokens + t.cache_creation_input_tokens;

/** 950 → "950", 12_345 → "12.3k", 2_500_000 → "2.5M". */
export function formatCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export const formatTokens = (t: TurnTokens) => `${formatCount(inputSide(t))} in / ${formatCount(t.output_tokens)} out`;

export const formatUsd = (usd: number) => `$${usd.toFixed(usd < 1 ? 3 : 2)}`;

/** Parses task.json text; `undefined` for anything that is not a task. */
export function parseTask(text: string): Task | undefined {
  try {
    const v: unknown = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const t = v as Partial<Task>;
    if (typeof t.id !== "string" || typeof t.status !== "string") return undefined;
    return { ...(t as Task), title: typeof t.title === "string" ? t.title : t.id };
  } catch {
    return undefined;
  }
}

/** Parses a session state file; `undefined` for anything that is not one. */
export function parseSession(text: string): SessionState | undefined {
  try {
    const v: unknown = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const s = v as Partial<SessionState>;
    if (typeof s.sessionId !== "string") return undefined;
    return {
      ...(s as SessionState),
      retries: count(s.retries),
      reviews: count(s.reviews),
      failures: count(s.failures),
      planChecks: count(s.planChecks),
      updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : "",
    };
  } catch {
    return undefined;
  }
}

/** True when task.json belongs to another session open on the project (the hooks ignore it here too). */
export const isForeign = (snap: WfSnapshot) => !!snap.task?.sessionId && !!snap.sessionId && snap.task.sessionId !== snap.sessionId;

/** Session counters that belong to the current task (the gates reset them on another task). */
function ownSession(snap: WfSnapshot): SessionState | undefined {
  const s = snap.session;
  if (!s || !snap.task) return undefined;
  if (s.taskId !== undefined && s.taskId !== snap.task.id) return undefined;
  return s;
}

/** The phase in one word, in Spanish, as the person reads it. */
export function phaseLabel(snap: WfSnapshot): string {
  const t = snap.task;
  if (!t) return "sin tarea";
  if (isForeign(snap)) return "tarea de otra sesión";
  switch (t.status) {
    case "planning":
      return "plan";
    case "implementing":
      return "implementación";
    case "done":
      return "hecha";
    default:
      return String(t.status);
  }
}

/** Plan line: title and how many files it may touch. */
export function planLabel(snap: WfSnapshot): string {
  const t = snap.task;
  if (!t || isForeign(snap)) return "—";
  if (!t.plan) return t.status === "planning" ? "en redacción" : "sin plan";
  const files = t.plan.files.length + (t.allowedExtra?.length ?? 0);
  const verdict = ownSession(snap)?.planVerdict;
  return `${t.plan.title} (${files} archivo${files === 1 ? "" : "s"}${verdict ? `, chequeo ${verdict}` : ""})`;
}

/** Verify line, from the Stop/SubagentStop gate counters. */
export function verifyLabel(snap: WfSnapshot): string {
  if (!snap.task || isForeign(snap)) return "—";
  const s = ownSession(snap);
  if (!s) return "sin datos";
  if (s.failures > 0) return `falla (${s.failures} seguida${s.failures === 1 ? "" : "s"})`;
  if (s.verifiedFingerprint) return "pasa";
  return "sin ejecutar";
}

/** Review line: the strong-model diff review, at most one round per task. */
export function reviewLabel(snap: WfSnapshot): string {
  if (!snap.task || isForeign(snap)) return "—";
  const s = ownSession(snap);
  if (!s) return "sin datos";
  if (s.reviewVerdict) return s.reviewVerdict;
  if (s.reviews > 0) return "omitida o sin veredicto";
  return "pendiente";
}

/** The status line under the prompt: `wf: implementación · turno 12.3k in / 800 out`. */
export function statusLine(snap: WfSnapshot): string {
  const parts = [`wf: ${phaseLabel(snap)}`];
  if (snap.lastTurn) parts.push(`turno ${formatTokens(snap.lastTurn)}`);
  return parts.join(" · ");
}

/** The pane's rows as label/value pairs, in order. */
export function paneRows(snap: WfSnapshot): Array<[label: string, value: string]> {
  const rows: Array<[string, string]> = [
    ["fase", phaseLabel(snap)],
    ["tarea", snap.task && !isForeign(snap) ? snap.task.title : "—"],
    ["plan", planLabel(snap)],
    ["verify", verifyLabel(snap)],
    ["revisión", reviewLabel(snap)],
    ["último turno", snap.lastTurn ? formatTokens(snap.lastTurn) : "—"],
    ["tokens (sesión)", snap.totals ? formatTokens(snap.totals) : "—"],
    ["coste acumulado", snap.costUsd === undefined ? "—" : formatUsd(snap.costUsd)],
  ];
  return rows;
}

/** The same rows as plain text, for the `/wf` command's answer. */
export const paneText = (snap: WfSnapshot) => paneRows(snap).map(([k, v]) => `${k}: ${v}`).join("\n");
