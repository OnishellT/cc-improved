// The optional mod's pure part (mod/status.ts). The engine half (mod/register.tsx) runs under `claude plugin test`
// with mod/register.test.tsx; see mod/README.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TASK_PATH } from "../lib/paths.ts";
import type { SessionState, Task } from "../lib/types.ts";
import {
  MOD_TASK_PATH,
  addTokens,
  formatCount,
  isForeign,
  paneRows,
  paneText,
  parseSession,
  parseTask,
  phaseLabel,
  statusLine,
  toTokens,
  zeroTokens,
  type WfSnapshot,
} from "../mod/status.ts";

const task = (over: Partial<Task> = {}): Task => ({
  id: "t1",
  title: "Add search",
  status: "implementing",
  allowedExtra: [],
  startedAt: "2026-10-01T00:00:00.000Z",
  plan: { title: "Search by title", spec: [], files: ["src/a.ts", "src/b.ts"], interface: [], seams: [], decisions: [] },
  ...over,
});

const session = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: "s1",
  retries: 0,
  reviews: 0,
  failures: 0,
  planChecks: 0,
  updatedAt: "2026-10-01T00:00:00.000Z",
  taskId: "t1",
  ...over,
});

const rows = (snap: WfSnapshot) => Object.fromEntries(paneRows(snap));

test("the mod reads task.json where lib/paths.ts puts it", () => {
  assert.equal(MOD_TASK_PATH, TASK_PATH);
});

test("phase follows the task status, and a task of another session is not shown", () => {
  assert.equal(phaseLabel({}), "sin tarea");
  assert.equal(phaseLabel({ task: task({ status: "planning" }) }), "plan");
  assert.equal(phaseLabel({ task: task() }), "implementación");
  assert.equal(phaseLabel({ task: task({ status: "done" }) }), "hecha");
  const foreign: WfSnapshot = { task: task({ sessionId: "other" }), sessionId: "s1" };
  assert.ok(isForeign(foreign));
  assert.equal(phaseLabel(foreign), "tarea de otra sesión");
  assert.equal(rows(foreign).plan, "—");
  // No sessionId on the task means any session's, as in the dispatcher.
  assert.ok(!isForeign({ task: task(), sessionId: "s1" }));
});

test("status line carries the phase and the last turn's tokens", () => {
  assert.equal(statusLine({ task: task() }), "wf: implementación");
  const lastTurn = toTokens({ input_tokens: 200, cache_read_input_tokens: 12_000, cache_creation_input_tokens: 100, output_tokens: 800 });
  assert.equal(statusLine({ task: task(), lastTurn }), "wf: implementación · turno 12.3k in / 800 out");
});

test("pane rows: plan, verify, review and cost from task.json and the gate counters", () => {
  const snap: WfSnapshot = {
    task: task(),
    session: session({ planVerdict: "OK", verifiedFingerprint: "abc", reviews: 1, reviewVerdict: "FIX" }),
    sessionId: "s1",
    costUsd: 0.4567,
  };
  const r = rows(snap);
  assert.equal(r.fase, "implementación");
  assert.equal(r.tarea, "Add search");
  assert.equal(r.plan, "Search by title (2 archivos, chequeo OK)");
  assert.equal(r.verify, "pasa");
  assert.equal(r["revisión"], "FIX");
  assert.equal(r["coste acumulado"], "$0.457");
  assert.match(paneText(snap), /^fase: implementación\n/);
});

test("verify and review read as pending, failing or unknown", () => {
  assert.equal(rows({ task: task(), session: session({ failures: 2 }) }).verify, "falla (2 seguidas)");
  assert.equal(rows({ task: task(), session: session() }).verify, "sin ejecutar");
  assert.equal(rows({ task: task(), session: session() })["revisión"], "pendiente");
  assert.equal(rows({ task: task(), session: session({ reviews: 1 }) })["revisión"], "omitida o sin veredicto");
  assert.equal(rows({ task: task() }).verify, "sin datos");
  // Counters of another task (the gates reset them on the next write) are not this task's.
  assert.equal(rows({ task: task(), session: session({ taskId: "t0", failures: 3 }) }).verify, "sin datos");
  const { plan: _plan, ...unplanned } = task({ status: "planning" });
  assert.equal(rows({ task: unplanned }).plan, "en redacción");
});

test("parsers degrade to undefined and tolerate missing counters", () => {
  assert.equal(parseTask("not json"), undefined);
  assert.equal(parseTask("[]"), undefined);
  assert.equal(parseTask('{"title":"x"}'), undefined);
  assert.equal(parseTask('{"id":"t1","status":"planning"}')?.title, "t1");
  assert.equal(parseSession("{}"), undefined);
  const s = parseSession('{"sessionId":"s1","failures":"x"}');
  assert.equal(s?.failures, 0);
  assert.equal(s?.reviews, 0);
});

test("token counts are summed defensively and printed short", () => {
  assert.deepEqual(toTokens(undefined), zeroTokens());
  assert.deepEqual(toTokens({ input_tokens: -1, output_tokens: Number.NaN }), zeroTokens());
  const sum = addTokens(toTokens({ input_tokens: 1, output_tokens: 2 }), toTokens({ input_tokens: 3, output_tokens: 4 }));
  assert.equal(sum.input_tokens, 4);
  assert.equal(sum.output_tokens, 6);
  assert.equal(formatCount(950), "950");
  assert.equal(formatCount(2_500_000), "2.5M");
});
