// Optional mod (function hooks, early access API): draws the workflow's state, never decides anything.
// The gates are the classic hooks in hooks/hooks.json; nothing there reads what this module does, so the plugin
// behaves the same when the mod is absent, refused or failing. Every hook here calls `next(e)` first and then
// draws, swallowing its own errors: the worst case is a missing or stale status line.
import type { EngineInterface, Register } from "claude-code";

import {
  MOD_PANE,
  MOD_PLUGIN,
  MOD_TASK_PATH,
  addTokens,
  paneRows,
  paneText,
  parseSession,
  parseTask,
  statusLine,
  toTokens,
  zeroTokens,
  type TurnTokens,
  type WfSnapshot,
} from "./status.ts";

const SESSION_ID = /^[A-Za-z0-9_-]+$/;

// Module state starts over on every reload; it only feeds the drawing.
let lastTurn: TurnTokens | undefined;
let totals: TurnTokens | undefined;
/** Session state file found for this session, so the plugin data folder is searched once. */
let sessionFile: string | undefined;

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path);
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `${CLAUDE_PLUGIN_DATA}/sessions/<id>.json`, written by the classic hooks. The engine gives a mod no data folder, so
 * it is looked up: `CLAUDE_PLUGIN_DATA` if this process has it, else the `cc-improved*` folders under
 * `<config>/plugins/data/` that hold a file for this session id (unique, so another install cannot be picked).
 */
async function findSessionFile($: EngineInterface, sessionId: string): Promise<string | undefined> {
  if (!SESSION_ID.test(sessionId)) return undefined;
  if (sessionFile?.endsWith(`/${sessionId}.json`)) return sessionFile;
  const candidates: string[] = [];
  const data = await $.env.get("CLAUDE_PLUGIN_DATA");
  if (data) candidates.push(data);
  const config = (await $.env.get("CLAUDE_CONFIG_DIR")) || `${(await $.env.get("HOME")) ?? ""}/.claude`;
  const root = `${config}/plugins/data`;
  try {
    for (const entry of await $.fs.list(root)) {
      if (entry.kind === "dir" && entry.name.startsWith(MOD_PLUGIN)) candidates.push(`${root}/${entry.name}`);
    }
  } catch {
    // No plugin data yet: the hooks have not run in this configuration.
  }
  for (const dir of candidates) {
    const file = `${dir}/sessions/${sessionId}.json`;
    if (await $.fs.exists(file).catch(() => false)) return (sessionFile = file);
  }
  return undefined;
}

/** Reads everything one drawing shows. Never rejects: what cannot be read is left out. */
async function snapshot($: EngineInterface): Promise<WfSnapshot> {
  const snap: WfSnapshot = { lastTurn, totals };
  try {
    const root = await $.session.root();
    const taskText = await readText($, `${root}/${MOD_TASK_PATH}`);
    snap.task = taskText === undefined ? undefined : parseTask(taskText);
  } catch {
    // Left out.
  }
  try {
    snap.sessionId = await $.session.id();
    const file = await findSessionFile($, snap.sessionId);
    const text = file === undefined ? undefined : await readText($, file);
    snap.session = text === undefined ? undefined : parseSession(text);
  } catch {
    // Left out.
  }
  try {
    snap.costUsd = (await $.session.usage()).cost?.usd;
  } catch {
    // Left out.
  }
  return snap;
}

/** Redraws the status line and an open pane. Never rejects. */
async function refresh($: EngineInterface): Promise<void> {
  try {
    $.ui.status(statusLine(await snapshot($)));
    $.ui.invalidate("ui.render");
  } catch {
    // A display that fails stays as it was.
  }
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const started = await next(e);
    try {
      await $.command.register({ name: MOD_PANE, description: "Estado de la tarea del flujo (fase, plan, verify, revisión, coste)" });
    } catch {
      // Without the command the status line still works.
    }
    await refresh($);
    return started;
  });

  on("command.run", { command: "wf" }, async ($) => {
    try {
      const snap = await snapshot($);
      $.ui.status(statusLine(snap));
      const opened = await $.ui.open({ id: MOD_PANE, title: "cc-improved" }).catch(() => undefined);
      // Where no pane is drawn (`claude -p`, a narrow terminal) the text answer carries the same rows.
      return { text: opened?.isPlaced ? "Panel wf abierto." : paneText(snap) };
    } catch {
      return { text: "wf: no se pudo leer el estado." };
    }
  }).catch(() => ({ text: "wf: no se pudo leer el estado." }));

  on("turn.complete", async ($, e, next) => {
    const done = await next(e);
    try {
      const usage = e.usage ?? done.usage;
      if (usage) {
        const tokens = toTokens(usage);
        totals = addTokens(totals ?? zeroTokens(), tokens);
        if (e.agentId === undefined) lastTurn = tokens;
      }
    } catch {
      // Counting is best effort.
    }
    // Phase changes come from the classic hooks writing task.json during the turn. refresh() never rejects and
    // costs a few file reads; awaiting it keeps headless runs from exiting before the redraw.
    await refresh($);
    return done;
  });

  on("ui.render", { component: "Pane", requestId: "wf" }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    let rows: Array<[string, string]>;
    try {
      rows = paneRows(await snapshot($));
    } catch {
      rows = [["wf", "no se pudo leer el estado"]];
    }
    return (
      <Box flexDirection="column">
        {rows.map(([label, value]) => (
          <Text>
            <Text dimColor>{label}: </Text>
            {value}
          </Text>
        ))}
      </Box>
    );
  });
};
