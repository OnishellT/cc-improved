import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import type { Decision, HookEventName, HookInput, HookInputOf, InterfaceEntry, Plan, Seam } from "../lib/types.ts";

const here = new URL(".", import.meta.url);
const fixturesDir = new URL("fixtures/hooks/", here);

// Key maps checked by the compiler: each must list exactly the keys of its type, and mark which are required.
// The runtime tests below then hold the real JSON (fixtures, schema) to these maps, so type and data cannot drift.
type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
type KeyMap<T> = { [K in keyof T]-?: K extends RequiredKeys<T> ? "required" : "optional" };

const base = { session_id: "required", transcript_path: "required", cwd: "required" } as const;
const turn = { prompt_id: "required", permission_mode: "required" } as const;
const child = { agent_id: "optional", agent_type: "optional" } as const;
const stop = { ...turn, effort: "optional", stop_hook_active: "required", last_assistant_message: "required", background_tasks: "optional", session_crons: "optional" } as const;
const tool = { ...base, ...turn, ...child, effort: "optional", tool_name: "required", tool_input: "required", tool_use_id: "required" } as const;

const hookKeys: { [E in HookEventName]: KeyMap<HookInputOf<E>> } = {
  SessionStart: { ...base, hook_event_name: "required", source: "required" },
  UserPromptSubmit: { ...base, ...turn, hook_event_name: "required", prompt: "required" },
  PreToolUse: { ...tool, hook_event_name: "required" },
  PostToolUse: { ...tool, hook_event_name: "required", tool_response: "required", duration_ms: "optional" },
  SubagentStart: { ...base, hook_event_name: "required", prompt_id: "optional", agent_id: "required", agent_type: "required" },
  SubagentStop: { ...base, ...stop, hook_event_name: "required", agent_id: "required", agent_type: "required", agent_transcript_path: "required" },
  Stop: { ...base, ...stop, hook_event_name: "required" },
  SessionEnd: { ...base, hook_event_name: "required", prompt_id: "optional", reason: "required" },
};

const planKeys: KeyMap<Plan> = { title: "required", ticket: "optional", spec: "required", files: "required", interface: "required", seams: "required", decisions: "required" };
const interfaceKeys: KeyMap<InterfaceEntry> = { file: "required", exports: "required", signatures: "optional", source: "optional" };
const seamKeys: KeyMap<Seam> = { name: "required", testFile: "required", catches: "required", misses: "optional" };
const decisionKeys: KeyMap<Decision> = { question: "required", options: "required", answer: "optional", source: "required" };

/** Problems of `value` against a key map: missing required keys and keys the type does not declare. */
function keyProblems(value: Record<string, unknown>, keys: Record<string, "required" | "optional">): string[] {
  const missing = Object.entries(keys).filter(([k, r]) => r === "required" && !(k in value)).map(([k]) => `missing ${k}`);
  const unknown = Object.keys(value).filter((k) => !(k in keys)).map((k) => `undeclared ${k}`);
  return [...missing, ...unknown];
}

const isEvent = (name: unknown): name is HookEventName => typeof name === "string" && name in hookKeys;

async function loadFixtures(): Promise<Map<string, HookInput>> {
  const files = (await readdir(fixturesDir)).filter((f) => f.endsWith(".json")).sort();
  const out = new Map<string, HookInput>();
  for (const file of files) out.set(file, JSON.parse(await readFile(new URL(file, fixturesDir), "utf8")));
  return out;
}

test("every hook fixture matches its HookInput variant", async () => {
  const fixtures = await loadFixtures();
  assert.ok(fixtures.size > 0, "no fixtures found");
  for (const [file, input] of fixtures) {
    assert.ok(isEvent(input.hook_event_name), `${file}: unknown hook_event_name ${String(input.hook_event_name)}`);
    assert.deepEqual(keyProblems(input as unknown as Record<string, unknown>, hookKeys[input.hook_event_name]), [], file);
  }
});

test("the fixtures cover every event the issue lists", async () => {
  const fixtures = [...(await loadFixtures()).values()];
  for (const event of Object.keys(hookKeys)) assert.ok(fixtures.some((f) => f.hook_event_name === event), `no fixture for ${event}`);
  const pre = fixtures.filter((f) => f.hook_event_name === "PreToolUse");
  assert.ok(pre.some((f) => f.agent_type === undefined), "no PreToolUse from the main session");
  assert.ok(pre.some((f) => f.agent_type !== undefined && f.agent_id !== undefined), "no PreToolUse from a subagent");
  const stops = fixtures.filter((f) => f.hook_event_name === "Stop");
  assert.ok(stops.some((f) => !f.stop_hook_active), "no Stop with stop_hook_active false");
  assert.ok(stops.some((f) => f.stop_hook_active), "no Stop with stop_hook_active true");
});

test("narrowing on hook_event_name reaches each variant's fields", async () => {
  // Compile-time check as much as runtime: a non-exhaustive switch fails `npm run typecheck`.
  const describe = (input: HookInput): string => {
    switch (input.hook_event_name) {
      case "SessionStart":
        return input.source;
      case "UserPromptSubmit":
        return input.prompt;
      case "PreToolUse":
      case "PostToolUse":
        return `${input.tool_name}:${input.agent_type ?? "main"}`;
      case "SubagentStart":
        return input.agent_type;
      case "SubagentStop":
        return `${input.agent_type}:${input.stop_hook_active}`;
      case "Stop":
        return String(input.stop_hook_active);
      case "SessionEnd":
        return input.reason;
      default: {
        const never: never = input;
        return never;
      }
    }
  };
  const fixtures = await loadFixtures();
  assert.equal(describe(fixtures.get("pre-tool-use.subagent.json")!), "Bash:echoer");
  assert.equal(describe(fixtures.get("stop.active.json")!), "true");
});

type Schema = { type?: string; required?: string[]; properties?: Record<string, Schema>; items?: Schema; additionalProperties?: boolean; errorMessage?: string };

test("plan.schema.json declares exactly the Plan type's fields", async () => {
  const schema: Schema = JSON.parse(await readFile(new URL("../lib/plan.schema.json", here), "utf8"));
  const check = (node: Schema | undefined, keys: Record<string, "required" | "optional">, where: string) => {
    assert.ok(node?.properties, `${where}: no properties`);
    assert.equal(node.additionalProperties, false, `${where}: additionalProperties must be false`);
    assert.deepEqual(Object.keys(node.properties).sort(), Object.keys(keys).sort(), `${where}: properties`);
    const required = Object.entries(keys).filter(([, r]) => r === "required").map(([k]) => k);
    assert.deepEqual([...(node.required ?? [])].sort(), required.sort(), `${where}: required`);
  };
  check(schema, planKeys, "plan");
  check(schema.properties?.interface?.items, interfaceKeys, "interface[]");
  check(schema.properties?.seams?.items, seamKeys, "seams[]");
  check(schema.properties?.decisions?.items, decisionKeys, "decisions[]");
});

test("every object and property in plan.schema.json carries an errorMessage for the model", async () => {
  const schema: Schema = JSON.parse(await readFile(new URL("../lib/plan.schema.json", here), "utf8"));
  const walk = (node: Schema, where: string) => {
    if (node.type === "object" || where.includes(".")) assert.ok(node.errorMessage?.length, `${where}: no errorMessage`);
    for (const [k, child] of Object.entries(node.properties ?? {})) walk(child, `${where}.${k}`);
    if (node.items?.type === "object") walk(node.items, `${where}[]`);
  };
  walk(schema, "plan");
});
