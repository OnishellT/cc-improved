import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { dispatch } from "../lib/hooks/dispatch.ts";
import mod, { agentModel, recordSubagentStart, telemetryPath, type SubagentStartRecord } from "../lib/hooks/subagent-start.ts";
import type { SubagentStartInput } from "../lib/types.ts";

const RAW = await readFile(fileURLToPath(new URL("fixtures/hooks/subagent-start.json", import.meta.url)), "utf8");
const INPUT = JSON.parse(RAW) as SubagentStartInput;
const registry = { SubagentStart: { modules: [async () => mod], budgetMs: 2_000 } };

async function sandbox() {
  const dir = await mkdtemp(path.join(tmpdir(), "wf-subagent-start-"));
  const env = { CLAUDE_PROJECT_DIR: path.join(dir, "project"), CLAUDE_PLUGIN_DATA: path.join(dir, "data") };
  await mkdir(env.CLAUDE_PROJECT_DIR, { recursive: true });
  return env;
}

const lines = async (file: string) =>
  (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as SubagentStartRecord);

test("real fixture: no output, one telemetry line under the session id with agent id and type", async () => {
  const env = await sandbox();
  assert.equal(await dispatch(RAW, { env, registry }), "");
  const file = telemetryPath(INPUT.session_id, env);
  assert.equal(file, path.join(env.CLAUDE_PLUGIN_DATA, "telemetry", `${INPUT.session_id}.jsonl`));
  const [rec, ...rest] = await lines(file);
  assert.equal(rest.length, 0);
  assert.equal(rec?.event, "SubagentStart");
  assert.equal(rec?.agent_id, "aa61205ac84a406de");
  assert.equal(rec?.agent_type, "echoer");
  assert.equal(rec?.prompt_id, INPUT.prompt_id);
  assert.equal(rec?.model, undefined); // not a plugin agent
  assert.ok(!Number.isNaN(Date.parse(rec?.at ?? "")));
});

test("plugin agents get the model of their frontmatter, with or without the plugin prefix", async () => {
  assert.equal(await agentModel("cc-improved:fixer-sonnet"), "sonnet");
  assert.equal(await agentModel("implementer"), "inherit");
  assert.equal(await agentModel("echoer"), undefined);
  assert.equal(await agentModel("../package"), undefined);
  const dir = await mkdtemp(path.join(tmpdir(), "wf-agents-"));
  await writeFile(path.join(dir, "quoted.md"), '---\nname: quoted\nmodel: "opus"\n---\nbody\nmodel: haiku\n');
  await writeFile(path.join(dir, "bare.md"), "no frontmatter\nmodel: haiku\n");
  assert.equal(await agentModel("quoted", dir), "opus");
  assert.equal(await agentModel("bare", dir), undefined);
});

test("several subagents of one session append in order; another session writes its own file", async () => {
  const env = await sandbox();
  await dispatch(RAW, { env, registry });
  await dispatch(JSON.stringify({ ...INPUT, agent_id: "a2", agent_type: "cc-improved:fixer-sonnet" }), { env, registry });
  await dispatch(JSON.stringify({ ...INPUT, session_id: "other-session", agent_id: "a3" }), { env, registry });
  const mine = await lines(telemetryPath(INPUT.session_id, env));
  assert.deepEqual(mine.map((r) => [r.agent_id, r.model]), [["aa61205ac84a406de", undefined], ["a2", "sonnet"]]);
  assert.deepEqual((await lines(telemetryPath("other-session", env))).map((r) => r.agent_id), ["a3"]);
});

test("never blocks: an unwritable data dir is logged and the output stays empty", async () => {
  const env = await sandbox();
  await mkdir(env.CLAUDE_PLUGIN_DATA, { recursive: true });
  await writeFile(path.join(env.CLAUDE_PLUGIN_DATA, "telemetry"), "a file where the folder should be");
  assert.equal(await dispatch(RAW, { env, registry }), "");
  const logs = await readdir(path.join(env.CLAUDE_PLUGIN_DATA, "log"));
  const text = await readFile(path.join(env.CLAUDE_PLUGIN_DATA, "log", logs[0]!), "utf8");
  assert.match(text, /SubagentStart session=.* subagent telemetry not recorded/);
});

test("recordSubagentStart rejects a session id that could escape the data folder", async () => {
  const env = await sandbox();
  await assert.rejects(recordSubagentStart({ ...INPUT, session_id: "../x" }, env), /Invalid session_id/);
});
