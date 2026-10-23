import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlan, planText } from "../lib/plan.ts";

const valid = {
  title: "Charge cards",
  ticket: "PAY-142",
  spec: [],
  files: ["src/pay.ts", "test/pay.test.ts"],
  interface: [{ file: "src/pay.ts", exports: ["chargeCard"], source: "PAY-142" }],
  seams: [{ name: "rejects expired", testFile: "test/pay.test.ts", catches: "expired cards", misses: "network" }],
  decisions: [{ question: "Retry?", options: ["yes", "no"], answer: "no", source: "docs/adr/001.md" }],
};
const block = (o: unknown) => "```wf-plan\n" + JSON.stringify(o, null, 2) + "\n```";
const errs = (md: string) => {
  const r = parsePlan(md);
  assert.ok("errors" in r, "expected errors");
  return r.errors.join("\n");
};

test("valid block returns the plan, with surrounding prose", () => {
  const r = parsePlan("# Plan\n\ntext\n\n" + block(valid) + "\n\nmore");
  assert.deepEqual(r, { plan: valid });
});

test("tolerates indentation, CRLF and spaces around the info string", () => {
  const md = ("  ```  wf-plan  \n" + JSON.stringify(valid) + "\n  ```  \n").replace(/\n/g, "\r\n");
  assert.deepEqual(parsePlan(md), { plan: valid });
});

test("a longer fence can contain a nested ``` line", () => {
  const md = "````wf-plan\n" + JSON.stringify({ ...valid, title: "a" }) + "\n````";
  assert.ok("plan" in parsePlan(md));
});

test("no block", () => {
  assert.match(errs("# Plan\nnothing"), /No ```wf-plan block found/);
});

test("unclosed block", () => {
  assert.match(errs("```wf-plan\n{}"), /not closed/);
});

test("broken JSON", () => {
  assert.match(errs("```wf-plan\n{ title: 1, }\n```"), /not valid JSON/);
});

test("two blocks fail (ambiguous), not silently the last", () => {
  assert.match(errs(block(valid) + "\n\n" + block(valid)), /Found 2 .*exactly one/);
});

test("missing fields are named with a fix", () => {
  const { interface: _i, seams: _s, ...rest } = valid;
  const m = errs(block(rest));
  assert.match(m, /missing required field\(s\) interface, seams/);
  assert.match(m, /call ExitPlanMode again/);
});

test("empty interface and seams are rejected", () => {
  const m = errs(block({ ...valid, interface: [], seams: [] }));
  assert.match(m, /interface: needs at least 1/);
  assert.match(m, /seams: needs at least 1/);
});

test("decision without source lists the path and how to settle it", () => {
  const m = errs(block({ ...valid, decisions: [{ question: "Q?", options: [] }] }));
  assert.match(m, /decisions\[0\]: missing required field\(s\) source/);
  assert.match(m, /AskUserQuestion/);
});

test("decision without answer is fine when it has a source", () => {
  const d = [{ question: "Q?", options: ["a"], source: "docs/adr/2.md" }];
  assert.ok("plan" in parsePlan(block({ ...valid, decisions: d })));
});

test("wrong types and unknown fields", () => {
  const m = errs(block({ ...valid, files: "src/a.ts", extra: 1, title: "" }));
  assert.match(m, /files: expected array, found string/);
  assert.match(m, /extra: unknown field/);
  assert.match(m, /title: must not be empty/);
});

test("root that is not an object", () => {
  assert.match(errs("```wf-plan\n[1]\n```"), /\(root\): expected object, found array/);
});

test("planText renders the sections", () => {
  const t = planText(valid);
  assert.match(t, /^Charge cards\nTicket: PAY-142/);
  assert.match(t, /- src\/pay.ts: chargeCard \(PAY-142\)/);
  assert.match(t, /- rejects expired -> test\/pay.test.ts: expired cards \(not covered: network\)/);
  assert.match(t, /- Retry\? -> no/);
});
