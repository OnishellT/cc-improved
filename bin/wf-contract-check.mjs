#!/usr/bin/env -S node --experimental-strip-types
// Contract check, run by the model itself at the end of direct work (skill contract-first). Never a hook, never a gate.
// Reads `.claude/workflow/contract.json` ({"files": [], "names": [], "notes"?: ""}) and reports, as plain text, whether
// every file exists and every name appears as a whole word in the changed or new files (git diff against the task's
// `baseCommit` when there is one, else HEAD) or in the contract's own files. Text only: no parsing, any language.
// Run as: wf-contract-check.mjs [contract file]   or   node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/bin/wf-contract-check.mjs"
// Exit 0: contract met. Exit 1: not met, missing or malformed contract.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { hasName } from "../lib/contract.ts";
import { changedFiles } from "../lib/learn.ts";
import { WORKFLOW_DIR, projectDir, taskPath } from "../lib/paths.ts";
import { diffBase } from "../lib/risk.ts";

const CONTRACT_PATH = `${WORKFLOW_DIR}/contract.json`;
const MAX_BYTES = 2 * 1024 * 1024;
const EXAMPLE = '{"files": ["src/slug.js"], "names": ["slugify"], "notes": "assumed: named export, throws TypeError on non-string"}';

/** Problems with the shape of a parsed contract; empty when it is usable. */
export function contractProblems(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return ["the contract must be a JSON object"];
  const p = [];
  for (const key of ["files", "names"]) {
    if (!Array.isArray(c[key]) || c[key].some((v) => typeof v !== "string" || !v.trim())) p.push(`"${key}" must be a list of non-empty strings`);
  }
  if (c.notes !== undefined && typeof c.notes !== "string") p.push('"notes" must be a string');
  if (!p.length && !c.files.length && !c.names.length) p.push('"files" and "names" are both empty: a contract with nothing to check');
  return p;
}

/** Repo-relative path inside `root`, or undefined when it points outside. */
const inside = (root, file) => {
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? abs : undefined;
};

async function text(abs) {
  try {
    const info = await fs.stat(abs);
    if (!info.isFile() || info.size > MAX_BYTES) return "";
    return await fs.readFile(abs, "utf8");
  } catch {
    return "";
  }
}

/** Runs the check; returns { code, text }. */
export async function check(root, contractFile = CONTRACT_PATH) {
  const file = path.resolve(root, contractFile);
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { code: 1, text: `CONTRACT MISSING: ${path.relative(root, file) || contractFile} does not exist. Write it before editing, for example:\n${EXAMPLE}` };
  }
  let contract;
  try {
    contract = JSON.parse(raw);
  } catch (err) {
    return { code: 1, text: `CONTRACT MALFORMED: ${contractFile} is not valid JSON (${err.message}). Example:\n${EXAMPLE}` };
  }
  const shape = contractProblems(contract);
  if (shape.length) return { code: 1, text: ["CONTRACT MALFORMED:", ...shape.map((s) => `- ${s}`), `Example:\n${EXAMPLE}`].join("\n") };

  const problems = [];
  for (const f of contract.files) {
    const abs = inside(root, f);
    if (!abs) problems.push(`${f}: outside the project`);
    else if (!(await fs.stat(abs).catch(() => undefined))) problems.push(`${f}: the file does not exist`);
  }

  // Where names are looked up: files changed since the task's base (or HEAD) plus the files the contract declares.
  const task = await fs.readFile(taskPath(root), "utf8").then((t) => JSON.parse(t), () => undefined);
  const changed = await changedFiles(root, await diffBase(root, task));
  const scope = [...new Set([...changed, ...contract.files])];
  const texts = [];
  for (const f of scope) {
    const abs = inside(root, f);
    if (abs) texts.push(await text(abs));
  }
  const missing = contract.names.filter((n) => !texts.some((t) => hasName(t, n)));
  if (missing.length) problems.push(`names not found in ${changed.length ? "the changed files or " : ""}the contract files: ${missing.join(", ")}`);

  const where = changed.length ? `${changed.length} changed file(s)` : "contract files only (no git changes found)";
  if (problems.length) {
    return { code: 1, text: ["CONTRACT NOT MET:", ...problems.map((p) => `- ${p}`), "Fix the code or, if the contract was a wrong guess, fix the contract and say why. Do not report the task as done."].join("\n") };
  }
  const notes = typeof contract.notes === "string" && contract.notes.trim() ? `\nAssumptions on record: ${contract.notes.trim()}` : "";
  return { code: 0, text: `CONTRACT OK: ${contract.files.length} file(s) exist, ${contract.names.length} name(s) found (searched ${where}).${notes}` };
}

if (process.argv[1] && (await fs.realpath(path.resolve(process.argv[1]))) === (await fs.realpath(fileURLToPath(import.meta.url)))) {
  let result;
  try {
    result = await check(projectDir(), process.argv[2]);
  } catch (err) {
    result = { code: 1, text: `CONTRACT CHECK FAILED: ${err instanceof Error ? err.message : String(err)}` };
  }
  await new Promise((resolve) => process.stdout.write(`${result.text}\n`, resolve));
  process.exit(result.code);
}
