import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_BRIEF_EVIDENCE, MAX_MCP_TEXT, buildPlanBrief, captureMcpText, evidenceFor, mcpResponseText, parsePlanVerdict, readMcpText, siblings } from "../lib/evidence.ts";
import type { Plan, Task } from "../lib/types.ts";

const fixture = async (name: string) => JSON.parse(await fs.readFile(new URL(`./fixtures/evidence/${name}.json`, import.meta.url), "utf8"));
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "evidence-"));

const plan: Plan = {
  title: "Stop levels",
  spec: [],
  files: ["src/domain/protection.ts", "src/domain/protection.test.ts"],
  interface: [{ file: "src/domain/protection.ts", exports: ["stopLevel"], signatures: ["stopLevel(price: number): number"], source: "ticket" }],
  seams: [{ name: "stop math", testFile: "src/domain/protection.test.ts", catches: "levels", misses: "rounding" }],
  decisions: [{ question: "Units?", options: [], source: "docs/adr/0001.md" }],
};
const task: Task = { id: "t1", title: "Stop levels", ticket: "PAY-1", status: "planning", allowedExtra: [], startedAt: "now" };

test("text blocks: one block, several blocks in order, image blocks and their note ignored", async () => {
  const one = await fixture("post-tool-use.text");
  assert.match(await mcpResponseText(one.tool_response), /^TICKET LAB-142.*EVIDENCE-MARKER-7f3a$/s);
  const two = await fixture("post-tool-use.two-blocks");
  assert.equal(await mcpResponseText(two.tool_response), "TICKET LAB-146: Archive invoices\nAcceptance: archiveInvoices(before) moves old invoices. Marker: TWO-BLOCKS-MARKER-4d21");
  const mixed = await fixture("post-tool-use.text-image");
  assert.equal(await mcpResponseText(mixed.tool_response), "TICKET LAB-147: Invoice logo. Marker: MIXED-MARKER-8a6f");
  assert.equal((await fixture("post-tool-use.subagent")).agent_type, "ticket-reader");
});

test("structuredContent arrives as a serialized string and is kept as is", async () => {
  const p = await fixture("post-tool-use.structured");
  assert.equal(await mcpResponseText(p.tool_response), '{"id":"LAB-143","title":"Import invoices"}');
});

test("the saved-to-file notice is replaced by the file's content", async () => {
  const dir = await tmp();
  const file = path.join(dir, "mcp-lab-tickets-get_ticket_big-1.txt");
  await fs.writeFile(file, "BIG TICKET importInvoices END-MARKER");
  const p = await fixture("post-tool-use.saved-to-file");
  const notice = (p.tool_response as string).replace(/Output has been saved to [^\n]*?\.txt\./, `Output has been saved to ${file}.`);
  assert.equal(await mcpResponseText(notice), "BIG TICKET importInvoices END-MARKER");
});

test("an unreadable file, an unknown shape or a missing response never throws", async () => {
  const p = await fixture("post-tool-use.saved-to-file");
  assert.equal(await mcpResponseText(p.tool_response), p.tool_response);
  assert.equal(await mcpResponseText(undefined), "");
  assert.equal(await mcpResponseText({ foo: 1 }), "");
  assert.equal(await mcpResponseText([null, { type: "text" }, 3]), "");
});

test("captureMcpText accumulates per session under CLAUDE_PLUGIN_DATA and caps the total", async () => {
  const env = { CLAUDE_PLUGIN_DATA: await tmp() };
  assert.equal(await readMcpText("s1", env), "");
  await captureMcpText("s1", (await fixture("post-tool-use.text")).tool_response, env);
  const total = await captureMcpText("s1", (await fixture("post-tool-use.structured")).tool_response, env);
  assert.match(total, /EVIDENCE-MARKER-7f3a\n\{"id":"LAB-143"/);
  assert.equal(await readMcpText("s1", env), total);
  assert.equal(await readMcpText("s2", env), "");
  await captureMcpText("s3", [{ type: "text", text: "x".repeat(MAX_MCP_TEXT + 10) }], env);
  assert.equal((await readMcpText("s3", env)).length, MAX_MCP_TEXT);
  await assert.rejects(captureMcpText("../x", "t", env), /Invalid session_id/);
});

test("evidenceFor joins title, ticket, MCP text, specs and cited files; ignores unreadable and out-of-repo paths", async () => {
  const root = await tmp();
  await fs.mkdir(path.join(root, "docs"));
  await fs.writeFile(path.join(root, "docs/spec.md"), "SPEC exportInvoicesCsv");
  await fs.writeFile(path.join(root, "docs/cited.md"), "CITED helperName");
  const t: Task = { ...task, plan: { ...plan, spec: ["docs/spec.md", "docs/missing.md", "../outside.md"], interface: [{ file: "a.ts", exports: ["a"], source: "docs/cited.md" }, { file: "b.ts", exports: ["b"], source: "ticket" }] } };
  const text = await evidenceFor(root, t, "MCP stopLevel");
  for (const part of ["Stop levels", "PAY-1", "MCP stopLevel", "SPEC exportInvoicesCsv", "CITED helperName"]) assert.ok(text.includes(part), part);
  assert.equal(await evidenceFor(root, { ...task, ticket: undefined as never }, ""), "Stop levels");
});

test("brief carries the evidence, the plan and the sibling files; evidence is truncated to a fixed size", async () => {
  const root = await tmp();
  await fs.mkdir(path.join(root, "src/domain"), { recursive: true });
  for (const n of ["money.ts", "calendar.ts", ".hidden"]) await fs.writeFile(path.join(root, "src/domain", n), "");
  const sib = await siblings(root, plan);
  assert.deepEqual(sib, ["- src/domain/: calendar.ts, money.ts"]);
  const brief = buildPlanBrief(task, plan, "## Scope\n- `stopLevel(price)`", sib);
  assert.match(brief, /Plan check: Stop levels[\s\S]*stopLevel\(price\)[\s\S]*protection\.ts: stopLevel, stopLevel\(price: number\)[\s\S]*not covered: rounding[\s\S]*calendar\.ts, money\.ts/);
  assert.match(brief, /VERDICT: OK/);
  const big = buildPlanBrief(task, plan, "x".repeat(30_000), []);
  assert.match(big, /truncated/);
  assert.ok(big.length < MAX_BRIEF_EVIDENCE + 5_000);
  assert.match(buildPlanBrief(task, plan, "", []), /\(only the title\)[\s\S]*\(new directories\)/);
});

test("parsePlanVerdict: last verdict wins; FIX keeps the findings", () => {
  assert.equal(parsePlanVerdict("thinking\nVERDICT: FIX\nno wait\nVERDICT: OK\n")?.status, "ok");
  const fix = parsePlanVerdict("analysis here\nVERDICT: FIX\n1. rename protection.ts to stop.ts (siblings are nouns)\n");
  assert.equal(fix?.status, "fix");
  assert.match(fix!.report, /^VERDICT: FIX\n1\. rename/);
  assert.equal(parsePlanVerdict("no verdict"), undefined);
});
