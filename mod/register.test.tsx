// Engine half of the optional mod, run by `claude plugin test` (see mod/README.md), never by `npm test`.
// Nothing sits beneath the plugin: each `on` here stands for the engine.
import { expect, test, type TestBody } from "claude-code/testing";


const ROOT = "/repo";
const SESSION = "s1";
const DATA = "/home/u/.claude/plugins/data";

const TASK = JSON.stringify({
  id: "t1",
  title: "Add search",
  status: "implementing",
  allowedExtra: [],
  startedAt: "2026-10-01T00:00:00.000Z",
  sessionId: SESSION,
  plan: { title: "Search by title", spec: [], files: ["src/a.ts"], interface: [], seams: [], decisions: [] },
});
const STATE = JSON.stringify({
  sessionId: SESSION,
  taskId: "t1",
  retries: 0,
  reviews: 1,
  failures: 0,
  planChecks: 1,
  planVerdict: "OK",
  reviewVerdict: "OK",
  verifiedFingerprint: "f",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

const PANE = {
  plugin: "cc-improved",
  component: "Pane",
  requestId: "wf",
  props: {
    title: "cc-improved",
    isFocused: false,
    bodyColumns: 60,
    placement: "dock",
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const;

/** An engine with a task, the hooks' session state and a cost; `statuses` collects every status line drawn. */
function engine(on: Parameters<TestBody>[1], statuses: Array<string | undefined>) {
  const files: Record<string, string> = {
    [`${ROOT}/.claude/workflow/task.json`]: TASK,
    [`${DATA}/cc-improved-inline/sessions/${SESSION}.json`]: STATE,
  };
  on("session.root", () => ({ value: ROOT }));
  on("session.id", () => ({ value: SESSION }));
  on("session.usage", () => ({ value: { startedAt: 0, context: {} as never, rateLimits: [], cost: { usd: 0.25 } } }));
  on("env.get", (_, e) => ({ value: e.name === "HOME" ? "/home/u" : undefined }));
  on("fs.list", (_, e) =>
    e.path === DATA ? { value: [{ name: "cc-improved-inline", kind: "dir", size: 0, mtimeMs: 0, isLink: false }] } : { value: [] },
  );
  on("fs.exists", (_, e) => ({ value: e.path in files }));
  on("fs.read", (_, e) => {
    const text = files[e.path];
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`);
    return { value: text };
  });
  on("ui.status", (_, e) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  on("ui.invalidate", () => ({ value: undefined }));
  on("command.register", () => ({ value: { command: "wf" } }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("turn.complete", (_, e) => ({ text: e.answer }));
}


test("status line shows the phase, then the last turn's tokens", async ($, on) => {
  const statuses: Array<string | undefined> = [];
  engine(on, statuses);
  await $.session.start({ cwd: ROOT, surface: "terminal", isInteractive: true });
  expect(statuses.at(-1)).toBe("wf: implementación");

  const done = await $.turn.complete({
    answer: "ok",
    durationMs: 1,
    isAborted: false,
    turnId: "turn-1",
    reason: "answer",
    usage: { model: "m", input_tokens: 100, cache_read_input_tokens: 1_200, cache_creation_input_tokens: 0, output_tokens: 50 },
  });
  // The mod never changes the turn's result.
  expect(done.text).toBe("ok");
  expect(statuses.at(-1)).toBe("wf: implementación · turno 1.3k in / 50 out");
});

test("the pane draws plan, verify, review and cost, on every surface", async ($, on) => {
  engine(on, []);
  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    expect((await ui.find({ type: "Text", text: /plan: Search by title \(1 archivo, chequeo OK\)/ }))).toBeTruthy();
    expect((await ui.find({ type: "Text", text: /verify: pasa/ }))).toBeTruthy();
    expect((await ui.find({ type: "Text", text: /revisión: OK/ }))).toBeTruthy();
    expect((await ui.find({ type: "Text", text: /coste acumulado: \$0\.250/ }))).toBeTruthy();
    await ui.unmount();
  }
});

test("/wf answers with the rows when no pane can be placed", async ($, on) => {
  engine(on, []);
  on("ui.open", () => ({ value: { isPlaced: false, reason: "no-surface" } as never }));
  const ran = await $.command.run({ command: "wf", args: "" } as never);
  expect(ran.text ?? "").toMatch(/fase: implementación/);
  expect(ran.text ?? "").toMatch(/revisión: OK/);
});

test("with nothing to read the mod degrades and never breaks the session", async ($, on) => {
  const statuses: Array<string | undefined> = [];
  on("ui.status", (_, e) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("turn.complete", (_, e) => ({ text: e.answer }));
  // No root, no files, no env, no command registry: every engine call is left unanswered.
  const started = await $.session.start({ cwd: ROOT, surface: "terminal", isInteractive: true });
  expect(started.cwd).toBe(ROOT);
  const done = await $.turn.complete({ answer: "ok", durationMs: 1, isAborted: false, turnId: "turn-1", reason: "answer" });
  expect(done.text).toBe("ok");
  expect(statuses.at(-1)).toBe("wf: sin tarea");
});
