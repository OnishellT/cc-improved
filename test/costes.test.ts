// docs/costes/apply-global.mjs on a temporary home, docs/costes/usage-report.mjs on a temporary transcript tree, and the
// frontmatter of the global implementer agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const apply = fileURLToPath(new URL("../docs/costes/apply-global.mjs", import.meta.url));
const report = fileURLToPath(new URL("../docs/costes/usage-report.mjs", import.meta.url));
const agent = fileURLToPath(new URL("../docs/costes/global/issue-implementer.md", import.meta.url));

function run(script: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) =>
    execFile(process.execPath, ["--experimental-strip-types", script, ...args], (error, stdout) =>
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout }),
    ),
  );
}

const SETTINGS = {
  model: "sonnet",
  hooks: { PreToolUse: [{ matcher: "Bash" }] },
  modelSettings: { "claude-sonnet-5-5": { effortLevel: "xhigh" } },
};

async function home(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "costes-home-"));
  await writeFile(path.join(dir, "settings.json"), JSON.stringify(SETTINGS, null, 2), { mode: 0o600 });
  await writeFile(path.join(dir, "CLAUDE.md"), "@RTK.md\n");
  return dir;
}

test("apply-global merges the settings without losing keys, and a second run changes nothing", async () => {
  const dir = await home();
  const original = await readFile(path.join(dir, "settings.json"), "utf8");
  assert.equal((await run(apply, ["--home", dir])).code, 0);

  const settings = JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8"));
  assert.equal(settings.model, "sonnet");
  assert.deepEqual(settings.hooks, SETTINGS.hooks);
  assert.equal(settings.modelSettings["claude-sonnet-5-5"].effortLevel, "medium");
  assert.equal(settings.modelSettings["claude-opus-5-5"].effortLevel, "medium");
  assert.equal(settings.autoCompactWindow, 200000);
  assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, "sonnet");
  assert.equal(await readFile(path.join(dir, "settings.json.pre-cost-controls"), "utf8"), original);
  assert.equal((await stat(path.join(dir, "settings.json"))).mode & 0o777, 0o600);
  assert.equal(await readFile(path.join(dir, "CLAUDE.md"), "utf8"), "@RTK.md\n@cost-hygiene.md\n");
  assert.equal(await readFile(path.join(dir, "agents/issue-implementer.md"), "utf8"), await readFile(agent, "utf8"));

  const again = await run(apply, ["--home", dir]);
  assert.deepEqual(
    again.stdout.trim().split("\n").map((line) => line.split(/\s+/)[0]),
    ["unchanged", "unchanged", "unchanged", "unchanged"],
  );
  assert.equal(await readFile(path.join(dir, "CLAUDE.md"), "utf8"), "@RTK.md\n@cost-hygiene.md\n");
});

test("apply-global --dry-run says what it would do and writes nothing", async () => {
  const dir = await home();
  const result = await run(apply, ["--dry-run", "--home", dir]);
  assert.match(result.stdout, /^would updated +\S+settings\.json$/m);
  assert.equal(await readFile(path.join(dir, "settings.json"), "utf8"), JSON.stringify(SETTINGS, null, 2));
  assert.equal(await readFile(path.join(dir, "CLAUDE.md"), "utf8"), "@RTK.md\n");
  await assert.rejects(stat(path.join(dir, "cost-hygiene.md")));
  await assert.rejects(stat(path.join(dir, "settings.json.pre-cost-controls")));
});

test("the global implementer agent runs on sonnet with a one-hour prompt cache", async () => {
  const text = await readFile(agent, "utf8");
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
  assert.match(frontmatter, /^name: issue-implementer$/m);
  assert.match(frontmatter, /^model: sonnet$/m);
  assert.match(frontmatter, /^effort: medium$/m);
  // the key is read only inside the `experimental` map (not at the top level of the frontmatter)
  assert.match(frontmatter, /^experimental:\n {2}cacheTtl: 1h$/m);
});

type Usage = { output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };

const assistant = (id: string, ts: string, usage: Usage, content: object[] = [], model = "claude-sonnet-5-5") =>
  JSON.stringify({ type: "assistant", uuid: `u-${id}`, timestamp: ts, message: { id, model, usage, content } });

test("usage-report prices each message once, finds the cold rebuild and names the subagent type", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "costes-root-"));
  const project = path.join(root, "-proj");
  await mkdir(path.join(project, "s1", "subagents"), { recursive: true });
  const launch = { type: "tool_use", id: "t1", name: "Agent", input: { subagent_type: "issue-implementer" } };
  const launched = JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "agentId: abc123" }] }] },
  });
  await writeFile(
    path.join(project, "s1.jsonl"),
    [
      // Sonnet: 1M output ($10) + 10M cache read ($1.17). The same message appears twice while streaming: counted once.
      assistant("m1", "2026-10-21T10:00:00Z", { output_tokens: 10, cache_read_input_tokens: 10_000_000 }, [launch]),
      assistant("m1", "2026-10-21T10:00:00Z", { output_tokens: 1_000_000, cache_read_input_tokens: 10_000_000 }),
      launched,
      // Ten idle minutes later the whole 100k context is written again: $0.2246, of which $0.2129 over a warm read.
      assistant("m2", "2026-10-21T10:10:00Z", { cache_creation_input_tokens: 100_000 }),
      assistant("m3", "2026-10-21T10:11:00Z", { output_tokens: 1000 }, [], "<synthetic>"),
    ].join("\n"),
  );
  // The subagent: 100k output on Sonnet is $1.00.
  await writeFile(
    path.join(project, "s1", "subagents", "agent-abc123.jsonl"),
    assistant("a1", "2026-10-21T10:02:00Z", { output_tokens: 100_000 }),
  );

  const all = (await run(report, ["--root", root])).stdout;
  assert.match(all, /^3 assistant turns .* estimated \$12\.39 at list price$/m);
  assert.match(all, /^ +\$ +11\.39 .* sonnet-5-5 main$/m); // $11.17 + the $0.2246 rebuild
  assert.match(all, /^ +\$ +1\.00 .* sonnet-5-5 sub$/m);
  assert.match(all, /^ +main: +\$ +0\.21 +events=1$/m);
  assert.match(all, /^ +sub +: +\$ +0\.00 +events=0$/m);
  assert.match(all, /== subagents: 1 agents, \$1\.00 /);
  assert.match(all, /agents= +1 +avg=\$1\.00 +issue-implementer$/m);

  const none = (await run(report, ["--root", root, "--since", "2026-10-22"])).stdout;
  assert.match(none, /^0 assistant turns .* estimated \$0\.00 at list price$/m);
});
