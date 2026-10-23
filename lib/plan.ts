// Parser and validator for the ```wf-plan block of a plan-mode file.
import { readFileSync } from "node:fs";
import type { Plan } from "./types.ts";

export type ParsePlanResult = { plan: Plan } | { errors: string[] };

interface SchemaNode {
  type?: string;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  additionalProperties?: boolean;
  items?: SchemaNode;
  minItems?: number;
  minLength?: number;
  errorMessage?: string;
}

const schema = JSON.parse(
  readFileSync(new URL("./plan.schema.json", import.meta.url), "utf8"),
) as SchemaNode;

const OPEN = /^[ \t]*(`{3,})[ \t]*wf-plan[ \t]*$/;

function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function typeOk(type: string, v: unknown): boolean {
  return type === "array" ? Array.isArray(v) : type === "object" ? kindOf(v) === "object" : typeof v === type;
}

/** Validate against the small schema subset; returns one readable message per problem. */
function validate(node: SchemaNode, value: unknown, path: string, out: string[]): void {
  const hint = node.errorMessage ? ` ${node.errorMessage}` : "";
  const at = path || "(root)";
  if (node.type && !typeOk(node.type, value)) {
    out.push(`${at}: expected ${node.type}, found ${kindOf(value)}.${hint}`);
    return;
  }
  if (typeof value === "string") {
    if (node.minLength !== undefined && value.length < node.minLength) {
      out.push(`${at}: must not be empty.${hint}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) {
      out.push(`${at}: needs at least ${node.minItems} item(s), found ${value.length}.${hint}`);
    }
    if (node.items) value.forEach((v, i) => validate(node.items!, v, `${path}[${i}]`, out));
    return;
  }
  if (kindOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    const missing = (node.required ?? []).filter((k) => !(k in obj));
    if (missing.length) out.push(`${at}: missing required field(s) ${missing.join(", ")}.${hint}`);
    const props = node.properties ?? {};
    for (const [k, v] of Object.entries(obj)) {
      const child = path ? `${path}.${k}` : k;
      if (props[k]) validate(props[k], v, child, out);
      else if (node.additionalProperties === false) {
        out.push(`${child}: unknown field. Allowed fields here: ${Object.keys(props).join(", ")}. Remove it.`);
      }
    }
  }
}

/**
 * Extract the ```wf-plan block from the plan Markdown and validate it.
 * Exactly one block is accepted: with several, which one counts is ambiguous, so it fails.
 */
export function parsePlan(markdown: string): ParsePlanResult {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const blocks: string[] = [];
  let unclosed = false;
  for (let i = 0; i < lines.length; i++) {
    const open = OPEN.exec(lines[i] ?? "");
    if (!open) continue;
    const close = new RegExp(`^[ \\t]*${open[1] ?? "```"}\`*[ \\t]*$`);
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j] ?? "")) j++;
    if (j >= lines.length) {
      unclosed = true;
      break;
    }
    blocks.push(lines.slice(i + 1, j).join("\n"));
    i = j;
  }
  if (unclosed) {
    return { errors: ["The ```wf-plan block is not closed. End it with a line containing only ```."] };
  }
  if (blocks.length === 0) {
    return {
      errors: [
        "No ```wf-plan block found in the plan. Add a fenced block starting with ```wf-plan containing one JSON object with title, spec, files, interface, seams and decisions, then call ExitPlanMode again.",
      ],
    };
  }
  if (blocks.length > 1) {
    return {
      errors: [
        `Found ${blocks.length} \`\`\`wf-plan blocks; there must be exactly one. Merge them into a single block (or delete the stale ones) and call ExitPlanMode again.`,
      ],
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(blocks[0] ?? "");
  } catch (e) {
    return {
      errors: [
        `The \`\`\`wf-plan block is not valid JSON (${(e as Error).message}). Write strict JSON: double-quoted keys and strings, no comments, no trailing commas.`,
      ],
    };
  }
  const errors: string[] = [];
  validate(schema, data, "", errors);
  return errors.length ? { errors } : { plan: data as Plan };
}

/** Plain-text rendering of a plan for briefs and approval dialogs. */
export function planText(plan: Plan): string {
  return [
    plan.title,
    ...(plan.ticket ? [`Ticket: ${plan.ticket}`] : []),
    "",
    "Files:",
    ...plan.files.map((f) => `- ${f}`),
    ...(plan.interface.length
      ? ["", "Interface:", ...plan.interface.map((i) => `- ${i.file}: ${[...i.exports, ...(i.signatures ?? [])].join(", ")}${i.source ? ` (${i.source})` : ""}`)]
      : []),
    ...(plan.seams.length
      ? ["", "Seams:", ...plan.seams.map((s) => `- ${s.name} -> ${s.testFile}: ${s.catches}${s.misses ? ` (not covered: ${s.misses})` : ""}`)]
      : []),
    ...(plan.decisions.length
      ? ["", "Decisions:", ...plan.decisions.map((d) => `- ${d.question} -> ${d.answer ?? `see ${d.source}`}`)]
      : []),
  ].join("\n");
}
