import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { logDir, manifestPath, pluginDataDir, projectDir, sessionStatePath, taskPath, tasksLogPath } from "../lib/paths.ts";

test("projectDir prefers CLAUDE_PROJECT_DIR and falls back to the given cwd", () => {
  assert.equal(projectDir({ CLAUDE_PROJECT_DIR: "/repo" }, "/elsewhere"), "/repo");
  assert.equal(projectDir({}, "/elsewhere"), "/elsewhere");
  assert.equal(projectDir({ CLAUDE_PROJECT_DIR: "" }, "/elsewhere"), "/elsewhere");
});

test("project state lives under .claude/", () => {
  assert.equal(manifestPath("/repo"), path.join("/repo", ".claude", "workflow.json"));
  assert.equal(taskPath("/repo"), path.join("/repo", ".claude", "workflow", "task.json"));
  assert.equal(tasksLogPath("/repo"), path.join("/repo", ".claude", "workflow", "tasks.jsonl"));
});

test("session state and logs live under CLAUDE_PLUGIN_DATA", () => {
  const env = { CLAUDE_PLUGIN_DATA: "/data/cc-improved" };
  assert.equal(pluginDataDir(env), "/data/cc-improved");
  assert.equal(sessionStatePath("185b8104-065e-43cc-a5b6-8b821bdffbb9", env), "/data/cc-improved/sessions/185b8104-065e-43cc-a5b6-8b821bdffbb9.json");
  assert.equal(logDir(env), "/data/cc-improved/log");
});

test("a missing CLAUDE_PLUGIN_DATA is an error, not a silent default", () => {
  assert.throws(() => pluginDataDir({}), /CLAUDE_PLUGIN_DATA/);
  assert.throws(() => sessionStatePath("abc", {}), /CLAUDE_PLUGIN_DATA/);
});

test("session ids that could escape the sessions folder are rejected", () => {
  const env = { CLAUDE_PLUGIN_DATA: "/data" };
  for (const id of ["../x", "a/b", "", "a.json"]) assert.throws(() => sessionStatePath(id, env), /Invalid session_id/, id);
});
