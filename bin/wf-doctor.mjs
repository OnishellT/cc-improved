#!/usr/bin/env node
// /wf-doctor: checks what this plugin needs and Claude Code's own /doctor does not cover.
// Everything project-specific comes from .claude/workflow.json; no language or tool is hardcoded.
// Run as: node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/bin/wf-doctor.mjs" [--json] (the flag is a no-op on Node >= 22.18).
// Output for the person is Spanish. Verify commands are looked up, never executed.
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST_PATH, manifestPath, projectDir } from "../lib/paths.ts";
import { TOOL_RUNTIMES, toolEnv, toolRuntimeBin } from "./wf-setup-finish.mjs";

const MIN_NODE = [22, 0];
const SETUP = ["pending", "running", "done", "declined"];
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ok = (name, detail) => ({ name, status: "ok", detail });
const warn = (name, detail) => ({ name, status: "warn", detail });
const fail = (name, detail) => ({ name, status: "fail", detail });

/** Runs a file with args; resolves { code, out }. Never rejects; code is null when it could not start. */
function run(file, args, cwd, timeout = 15_000) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

export const nodeOk = (version) => {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
};

/** First word of each simple command in a shell line. Skips env assignments, subshells and expansions. */
export function commandWords(line) {
  const words = [];
  let afterCd = false;
  for (const segment of line.split(/&&|\|\||;|\||\n/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
    const word = tokens[0];
    if (!word || /^[($`{!]|^\$/.test(word) || /^["']/.test(word)) continue;
    // After a `cd` the relative paths no longer point at the project root, so they cannot be checked from here.
    if (!(afterCd && word.includes("/") && !path.isAbsolute(word))) words.push(word);
    if (word === "cd") afterCd = true;
  }
  return words;
}

/** True when `sh` finds `word` as a builtin, a PATH executable or an executable file relative to `cwd`. */
async function resolves(word, cwd) {
  return (await run("sh", ["-c", 'command -v -- "$1"', "_", word], cwd)).code === 0;
}

async function checkNode(version) {
  const min = MIN_NODE[0];
  return nodeOk(version) ? ok("Node", version) : fail("Node", `${version}: se necesita Node >= ${min}. Actualízalo (nvm install ${min}).`);
}

async function checkGit(cwd) {
  const r = await run("git", ["--version"], cwd);
  return r.code === 0 ? ok("git", r.out) : fail("git", "no está instalado o no corre: el flujo lo necesita para el diff y las ramas.");
}

async function checkGh(cwd) {
  const v = await run("gh", ["--version"], cwd);
  if (v.code !== 0) return warn("gh", "no está instalado: solo /pr lo necesita (https://cli.github.com).");
  const auth = await run("gh", ["auth", "status"], cwd);
  return auth.code === 0 ? ok("gh", "instalado y con sesión") : warn("gh", "instalado pero sin sesión: corre `gh auth login` antes de /pr.");
}

/** Reads and validates the manifest by hand: lib/ has no schema for it, and the error text is for the person. */
async function readManifest(root) {
  let text;
  try {
    text = await readFile(manifestPath(root), "utf8");
  } catch {
    return { missing: true };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { errors: [`JSON inválido: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const errors = [];
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { errors: ["debe ser un objeto JSON"] };
  if (data.version !== 1) errors.push("`version` debe ser 1");
  if (!SETUP.includes(data.setup)) errors.push(`\`setup\` debe ser uno de ${SETUP.join(", ")}`);
  if (!Array.isArray(data.verify) || data.verify.some((s) => typeof s !== "string" || !s.trim())) errors.push("`verify` debe ser una lista de comandos (texto no vacío)");
  if (!Array.isArray(data.connectors) || data.connectors.some((c) => typeof c?.id !== "string")) errors.push("`connectors` debe ser una lista de objetos con `id`");
  if (data.agentlint !== undefined && (typeof data.agentlint !== "string" || !data.agentlint.trim())) errors.push("`agentlint` debe ser texto no vacío");
  if (data.review !== undefined && (typeof data.review !== "object" || data.review === null || Array.isArray(data.review))) errors.push("`review` debe ser un objeto");
  if (data.tools !== undefined && (!Array.isArray(data.tools) || data.tools.some((t) => typeof t?.path !== "string" || !TOOL_RUNTIMES.includes(t?.runtime)))) {
    errors.push(`\`tools\` debe ser una lista de objetos con \`path\` y \`runtime\` (${TOOL_RUNTIMES.join(" o ")})`);
  }
  return errors.length ? { errors } : { manifest: data };
}

function checkManifest(read) {
  if (read.missing) return warn("manifest", `no existe ${MANIFEST_PATH}: corre /setup.`);
  if (read.errors) return fail("manifest", `${MANIFEST_PATH} no es válido: ${read.errors.join("; ")}.`);
  const { setup } = read.manifest;
  if (setup === "declined") return ok("manifest", "válido (setup rechazado: los hooks quedan en silencio)");
  if (setup !== "done") return warn("manifest", `válido pero setup está en "${setup}": termina /setup.`);
  return ok("manifest", "válido");
}

async function checkVerify(manifest, root) {
  if (manifest.verify.length === 0) return warn("verify", "la lista está vacía: nada comprobará el trabajo. Corre /setup.");
  const missing = [];
  for (const step of manifest.verify) {
    for (const word of commandWords(step)) if (!(await resolves(word, root))) missing.push(`\`${word}\` (en "${step}")`);
  }
  return missing.length
    ? fail("verify", `no se encuentra: ${missing.join(", ")}. Instálalo o corrige el comando en ${MANIFEST_PATH}.`)
    : ok("verify", `${manifest.verify.length} comando(s) presentes (no se ejecutan aquí)`);
}

async function checkAgentlint(manifest, root) {
  if (!manifest.agentlint) return ok("agentlint", "no configurado (opcional)");
  const [word] = commandWords(manifest.agentlint);
  if (!word || !(await resolves(word, root))) return fail("agentlint", `\`${manifest.agentlint}\`: no se encuentra \`${word ?? ""}\`.`);
  const r = await run("sh", ["-c", `${manifest.agentlint} --help`], root);
  return r.code === 0 ? ok("agentlint", manifest.agentlint) : warn("agentlint", `\`${manifest.agentlint} --help\` falló (código ${r.code}): revisa la instalación.`);
}

const INSTALL = { python: "instala Python 3 (python3)", nix: "instala nix (https://nixos.org/download)" };

/** The project's verification tools: each file exists and is executable, and its runtime (python3, nix-shell or nix) is installed. */
async function checkTools(manifest, root) {
  const tools = manifest.tools ?? [];
  if (!tools.length) return ok("herramientas", "ninguna registrada (opcional; /setup las crea)");
  const problems = [];
  const runtimes = new Set();
  for (const declared of tools) {
    const tool = { ...declared, env: toolEnv(root, declared) };
    const info = await stat(path.join(root, tool.path)).catch(() => undefined);
    if (!info?.isFile()) problems.push(`no existe \`${tool.path}\``);
    else if (!(info.mode & 0o111)) problems.push(`\`${tool.path}\` no es ejecutable (chmod +x)`);
    if (tool.runtime === "nix" && !tool.env) problems.push(`\`${tool.path}\` no tiene flake.nix ni shell.nix al lado`);
    else if (tool.env && !(await stat(path.join(root, tool.env)).catch(() => undefined))) problems.push(`no existe \`${tool.env}\` (entorno nix de \`${tool.path}\`)`);
    const bin = toolRuntimeBin(tool);
    if (!(await resolves(bin, root))) problems.push(`\`${tool.path}\` necesita \`${bin}\`: ${INSTALL[tool.runtime]}`);
    else runtimes.add(bin);
  }
  return problems.length
    ? fail("herramientas", `${problems.join("; ")}. Los subagentes no podrán usarlas hasta que lo corrijas.`)
    : ok("herramientas", `${tools.length} registrada(s); runtime disponible: ${[...runtimes].sort().join(", ")} (no se ejecutan aquí)`);
}

/** The plugin's own agents: each file needs frontmatter with a name that matches the file and a description. */
async function checkAgents(dir) {
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".md")).sort();
  if (!files.length) return fail("agents", `no hay agents en ${dir}: reinstala el plugin.`);
  const bad = [];
  for (const file of files) {
    const text = await readFile(path.join(dir, file), "utf8").catch(() => "");
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
    const name = /^name:\s*(.+?)\s*$/m.exec(front)?.[1];
    if (name !== file.slice(0, -3) || !/^description:\s*\S/m.test(front)) bad.push(file);
  }
  return bad.length ? fail("agents", `frontmatter inválido en: ${bad.join(", ")}.`) : ok("agents", `${files.length} cargados`);
}

/** Runs every check. Never throws: a check that blows up is reported as a failure. */
export async function runDoctor({ root = projectDir(), version = process.versions.node, agentsDir = path.join(pluginRoot, "agents") } = {}) {
  const safe = async (name, fn) => {
    try {
      return await fn();
    } catch (err) {
      return fail(name, `error inesperado: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const checks = [await safe("Node", () => checkNode(version)), await safe("git", () => checkGit(root)), await safe("gh", () => checkGh(root))];
  const read = await safe("manifest", () => readManifest(root));
  checks.push(read.status ? read : checkManifest(read));
  if (read.manifest) {
    checks.push(await safe("verify", () => checkVerify(read.manifest, root)));
    checks.push(await safe("agentlint", () => checkAgentlint(read.manifest, root)));
    checks.push(await safe("herramientas", () => checkTools(read.manifest, root)));
  }
  checks.push(await safe("agents", () => checkAgents(agentsDir)));
  return checks;
}

const MARK = { ok: "✓", warn: "!", fail: "✗" };
export const formatDoctor = (checks) => checks.map((c) => `${MARK[c.status]} ${c.name}: ${c.detail}`).join("\n");

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const checks = await runDoctor();
  const bad = checks.filter((c) => c.status === "fail");
  process.stdout.write(`${process.argv.includes("--json") ? JSON.stringify(checks) : formatDoctor(checks)}\n`);
  if (!process.argv.includes("--json")) {
    process.stdout.write(bad.length ? `\n${bad.length} problema(s) a resolver.\n` : "\nTodo en orden.\n");
  }
  process.exit(bad.length ? 1 : 0);
}
