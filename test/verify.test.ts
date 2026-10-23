import { test } from "node:test";
import assert from "node:assert/strict";
import { formatVerify, isPolicyFailure, runVerify } from "../lib/verify.ts";

const cwd = process.cwd();
const at = (r: Awaited<ReturnType<typeof runVerify>>, i: number) => r.results[i]!;

test("passing steps run in order", async () => {
  const r = await runVerify(["true", "node -e \"console.log('two')\""], cwd);
  assert.equal(r.ok, true);
  assert.deepEqual(r.results.map((x) => x.step), ["true", "node -e \"console.log('two')\""]);
  assert.equal(at(r, 1).output, "two");
});

test("stops at the first failure and reports command and exit code", async () => {
  const r = await runVerify(["true", "node -e \"console.error('boom');process.exit(3)\"", "true"], cwd);
  assert.equal(r.ok, false);
  assert.equal(r.results.length, 2);
  assert.equal(at(r, 1).code, 3);
  assert.match(at(r, 1).output, /boom/);
  const text = formatVerify(r);
  assert.match(text, /verify FAILED/);
  assert.match(text, /exit code 3/);
  assert.match(text, /✗ node -e/);
});

test("false fails", async () => {
  const r = await runVerify(["false"], cwd);
  assert.equal(r.ok, false);
  assert.equal(at(r, 0).code, 1);
});

test("long output keeps a bounded tail", async () => {
  const r = await runVerify(["node -e \"process.stdout.write('x'.repeat(100000)+'END')\" && false"], cwd, { maxReport: 50 });
  assert.equal(r.ok, false);
  assert.ok(at(r, 0).output.length <= 51);
  assert.ok(at(r, 0).output.endsWith("END"));
  assert.ok(at(r, 0).output.startsWith("…"));
});

test("a step that exceeds the timeout fails and is killed", async () => {
  const started = Date.now();
  const r = await runVerify(["node -e \"setTimeout(()=>{},60000)\""], cwd, { timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.equal(at(r, 0).timedOut, true);
  assert.match(formatVerify(r), /timed out/);
  assert.ok(Date.now() - started < 10_000);
});

test("steps run from the given cwd", async () => {
  const r = await runVerify(["node -e \"console.log(process.cwd())\""], "/");
  assert.equal(at(r, 0).output, "/");
});

test("an agentlint failure is flagged as policy", async () => {
  const r = await runVerify(["node -e \"console.log('agentlint: unresolved findings');process.exit(1)\""], cwd);
  assert.equal(at(r, 0).policy, true);
  assert.equal(isPolicyFailure(r), true);
  const other = await runVerify(["false"], cwd);
  assert.equal(isPolicyFailure(other), false);
});

test("a passing agentlint step is not a policy failure", async () => {
  const r = await runVerify(["node -e \"console.log('agentlint ok')\""], cwd);
  assert.equal(at(r, 0).policy, false);
  assert.equal(isPolicyFailure(r), false);
});
