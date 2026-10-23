import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { dispatch } from "../lib/hooks/dispatch.ts";
import mod, { capturesEvidence } from "../lib/hooks/mcp-evidence.ts";
import { readMcpText } from "../lib/evidence.ts";
import { taskPath } from "../lib/paths.ts";
import type { PostToolUseInput, Task } from "../lib/types.ts";

const raw = (dir: string, name: string) => readFile(fileURLToPath(new URL(`fixtures/${dir}/${name}.json`, import.meta.url)), "utf8");
const evidence = async (name: string) => JSON.parse(await raw("evidence", name)) as PostToolUseInput;
const registry = { PostToolUse: { modules: [async () => mod], budgetMs: 2_000 } };

async function sandbox(task?: Partial<Task> & { sessionId?: string }) {
  const dir = await mkdtemp(path.join(tmpdir(), "wf-mcp-evidence-"));
  const env = { CLAUDE_PROJECT_DIR: path.join(dir, "project"), CLAUDE_PLUGIN_DATA: path.join(dir, "data") };
  await mkdir(path.join(env.CLAUDE_PROJECT_DIR, ".claude/workflow"), { recursive: true });
  if (task) {
    const full = { id: "t1", title: "Export invoices", status: "planning", allowedExtra: [], startedAt: "2026-10-23T00:00:00Z", ...task };
    await writeFile(taskPath(env.CLAUDE_PROJECT_DIR), JSON.stringify(full));
  }
  return { env, dir };
}

const send = (env: Record<string, string>, input: PostToolUseInput) => dispatch(JSON.stringify(input), { env, registry });

test("capturesEvidence: only mcp__ tools, and not while implementing", () => {
  assert.equal(capturesEvidence({ tool_name: "mcp__lab-tickets__get_ticket" }, undefined), true);
  assert.equal(capturesEvidence({ tool_name: "mcp__lab-tickets__get_ticket" }, { status: "planning" } as Task), true);
  assert.equal(capturesEvidence({ tool_name: "mcp__lab-tickets__get_ticket" }, { status: "done" } as Task), true);
  assert.equal(capturesEvidence({ tool_name: "mcp__lab-tickets__get_ticket" }, { status: "implementing" } as Task), false);
  assert.equal(capturesEvidence({ tool_name: "Bash" }, undefined), false);
  assert.equal(capturesEvidence({ tool_name: "ToolSearch" }, undefined), false);
});

test("real payloads before any task: text blocks, several blocks, image notes dropped, structuredContent kept; silent", async () => {
  const { env } = await sandbox();
  const session = (await evidence("post-tool-use.text")).session_id;
  for (const name of ["post-tool-use.text", "post-tool-use.two-blocks", "post-tool-use.text-image", "post-tool-use.structured"]) {
    assert.equal(await send(env, await evidence(name)), "", name);
  }
  const text = await readMcpText(session, env);
  assert.match(text, /^TICKET LAB-142: Export invoices as CSV\n.*exportInvoicesCsv\(invoices\).*EVIDENCE-MARKER-7f3a\n/s);
  assert.match(text, /TICKET LAB-146: Archive invoices\nAcceptance: archiveInvoices\(before\).*TWO-BLOCKS-MARKER-4d21/);
  assert.match(text, /MIXED-MARKER-8a6f\n\{"id":"LAB-143","title":"Import invoices"\}$/);
  assert.doesNotMatch(text, /\[Image: source:|iVBORw0KGgo/);
});

test("a subagent's read lands in the parent session's evidence", async () => {
  const { env } = await sandbox({ status: "planning" });
  const sub = await evidence("post-tool-use.subagent");
  assert.equal(await send(env, sub), "");
  assert.match(await readMcpText(sub.session_id, env), /EVIDENCE-MARKER-7f3a/);
});

test("the saved-to-file notice is replaced by the saved file's text", async () => {
  const { env, dir } = await sandbox();
  const file = path.join(dir, "mcp-lab-tickets-get_ticket_big-1.txt");
  await writeFile(file, "BIG TICKET importInvoices END-MARKER");
  const p = await evidence("post-tool-use.saved-to-file");
  const notice = (p.tool_response as string).replace(/Output has been saved to [^\n]*?\.txt\./, `Output has been saved to ${file}.`);
  assert.equal(await send(env, { ...p, tool_response: notice }), "");
  assert.equal(await readMcpText(p.session_id, env), "BIG TICKET importInvoices END-MARKER");
});

test("an unreadable saved file keeps the notice and logs the case; nothing is thrown", async () => {
  const { env } = await sandbox();
  const p = await evidence("post-tool-use.saved-to-file");
  assert.equal(await send(env, p), "");
  assert.equal(await readMcpText(p.session_id, env), p.tool_response);
  const logDir = path.join(env.CLAUDE_PLUGIN_DATA, "log");
  const log = await readFile(path.join(logDir, (await readdir(logDir))[0]!), "utf8");
  assert.match(log, /mcp__lab-tickets__get_ticket_big: the saved-to-file result could not be read/);
});

test("nothing is captured while implementing, for non-MCP tools, or for a task of another session", async () => {
  const text = await evidence("post-tool-use.text");
  const implementing = await sandbox({ status: "implementing" });
  assert.equal(await send(implementing.env, text), "");
  assert.equal(await readMcpText(text.session_id, implementing.env), "");

  const bash = JSON.parse(await raw("hooks", "post-tool-use")) as PostToolUseInput;
  const plain = await sandbox();
  assert.equal(await send(plain.env, bash), "");
  assert.equal(await readMcpText(bash.session_id, plain.env), "");

  const foreign = await sandbox({ status: "planning", sessionId: "other-session" });
  assert.equal(await send(foreign.env, text), "");
  assert.equal(await readMcpText(text.session_id, foreign.env), "");
});
