#!/usr/bin/env node
// Start or finish /setup. Validates what the model wrote, runs verify and writes `.claude/workflow.json`.
// Run as: node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/bin/wf-setup-finish.mjs" [--start] [options]
//
//   --start                 mark `setup: "running"` (keeps existing fields); hooks keep pushing until `done`
//   --pause                 mark `setup: "pending"` (keeps `startedAt`, so the next /setup resumes); pushing stops
//   --step "<command>"      a verify step, repeatable, in run order (fastest first); default: the manifest's verify
//   --mode <direct|flow>    default way of working, recorded in the manifest (default: keep the current one, else direct)
//   --language <lang>       language of questions and docs
//   --connector <id[:server]>  enabled connector, repeatable; `server` is its key in `.mcp.json`
//   --agentlint "<prefix>"  agentlint command prefix when the project enforces agentlint rules
//   --tool <runtime>:<path> a verification tool written for this project, repeatable; runtime is python or nix
//                           (nix: a flake.nix or shell.nix next to the script pins its dependencies)
//   --accept-failing-verify finish even though verify fails (only when the user chose so)
//
// Exit 0: done (or started). Exit 1: problems or verify failed; the report says what to fix. Exit 2: bad usage.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { formatVerify, runVerify } from "../lib/verify.ts";
import { MANIFEST_PATH, TASKS_LOG_PATH, WORKFLOW_DIR, manifestPath, projectDir } from "../lib/paths.ts";

/** CLAUDE.md is loaded into every session: keep it a map, details go to skills and rules. */
export const CLAUDE_MD_MAX_LINES = 200;
const SETUP_STATUSES = ["pending", "running", "done", "declined"];
/** Values of `mode` in the manifest (`WorkflowMode` in lib/types.ts). */
export const WORKFLOW_MODES = ["direct", "flow"];
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ADR_NAME = /^\d{4}-[a-z0-9][a-z0-9-]*\.md$/;
/** Lines `.gitignore` needs: local workflow state ignored, the closed-task log committed. */
const IGNORE_LINES = [`${WORKFLOW_DIR}/*`, `!${TASKS_LOG_PATH}`];

/** Runtimes a project verification tool may declare (`VerifyTool` in lib/types.ts). */
export const TOOL_RUNTIMES = ["python", "nix"];
/** Env files that pin a nix tool's dependencies, looked up next to the script, in this order. */
const NIX_ENVS = ["flake.nix", "shell.nix"];
/** `--help` budget per runtime: a nix env may have to be built the first time. */
const HELP_TIMEOUT_MS = { python: 30_000, nix: 10 * 60_000 };
/** Lists the top-level imports of a python file that are neither stdlib nor files next to it. Needs Python >= 3.10. */
const STDLIB_CHECK = `
import ast, json, os, sys
p = sys.argv[1]
d = os.path.dirname(os.path.abspath(p))
std = getattr(sys, "stdlib_module_names", None)
names = set()
for n in ast.walk(ast.parse(open(p, encoding="utf-8").read(), p)):
    if isinstance(n, ast.Import):
        names.update(a.name.split(".")[0] for a in n.names)
    elif isinstance(n, ast.ImportFrom) and not n.level and n.module:
        names.add(n.module.split(".")[0])
local = lambda m: os.path.exists(os.path.join(d, m + ".py")) or os.path.isdir(os.path.join(d, m))
print(json.dumps([] if std is None else sorted(m for m in names if m not in std and m != "__future__" and not local(m))))
`;

class Usage extends Error {}

/** Repo-relative POSIX path, or undefined when it is absolute or leaves the repo. */
function repoPath(file) {
  const norm = path.posix.normalize(file.replaceAll("\\", "/")).replace(/^(\.\/)+/, "");
  return !norm || norm === "." || path.posix.isAbsolute(norm) || norm === ".." || norm.startsWith("../") ? undefined : norm;
}

function parseTool(spec) {
  const i = spec.indexOf(":");
  const runtime = spec.slice(0, i);
  const file = repoPath(spec.slice(i + 1));
  if (i < 1 || !TOOL_RUNTIMES.includes(runtime)) throw new Usage(`--tool needs "<${TOOL_RUNTIMES.join("|")}>:<path>", got "${spec}"`);
  if (!file) throw new Usage(`--tool ${spec}: the path must be relative and inside the repo`);
  return { path: file, runtime };
}

function parseArgs(argv) {
  const opts = { start: false, pause: false, steps: [], connectors: [], tools: [], acceptFailing: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Usage(`${arg} needs a value`);
      return v;
    };
    if (arg === "--start") opts.start = true;
    else if (arg === "--pause") opts.pause = true;
    else if (arg === "--step") opts.steps.push(value());
    else if (arg === "--language") opts.language = value();
    else if (arg === "--mode") {
      opts.mode = value();
      if (!WORKFLOW_MODES.includes(opts.mode)) throw new Usage(`--mode must be one of ${WORKFLOW_MODES.join(", ")}, got "${opts.mode}"`);
    } else if (arg === "--agentlint") opts.agentlint = value();
    else if (arg === "--tool") opts.tools.push(parseTool(value()));
    else if (arg === "--connector") {
      const [id, server] = value().split(":");
      if (!id) throw new Usage("--connector needs an id");
      opts.connectors.push(server ? { id, server } : { id });
    } else if (arg === "--accept-failing-verify") opts.acceptFailing = true;
    else throw new Usage(`unknown argument ${arg}`);
  }
  return opts;
}

const read = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};
const isDir = (file) => {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
};
const listDir = (dir) => {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
};

/** Shape problems of a manifest object; empty when it matches `Manifest` in lib/types.ts. */
export function manifestProblems(m) {
  const p = [];
  if (!m || typeof m !== "object" || Array.isArray(m)) return [`${MANIFEST_PATH} must be a JSON object.`];
  if (m.version !== 1) p.push(`${MANIFEST_PATH}: "version" must be 1.`);
  if (!SETUP_STATUSES.includes(m.setup)) p.push(`${MANIFEST_PATH}: "setup" must be one of ${SETUP_STATUSES.join(", ")}.`);
  if (!Array.isArray(m.verify) || m.verify.some((s) => typeof s !== "string" || !s.trim())) p.push(`${MANIFEST_PATH}: "verify" must be a list of non-empty commands.`);
  if (!Array.isArray(m.connectors) || m.connectors.some((c) => !c || typeof c.id !== "string" || (c.server !== undefined && typeof c.server !== "string"))) {
    p.push(`${MANIFEST_PATH}: "connectors" must be a list of {"id", "server"?}.`);
  }
  if (m.mode !== undefined && !WORKFLOW_MODES.includes(m.mode)) p.push(`${MANIFEST_PATH}: "mode" must be one of ${WORKFLOW_MODES.join(", ")}.`);
  for (const key of ["language", "startedAt", "completedAt", "agentlint"]) if (m[key] !== undefined && typeof m[key] !== "string") p.push(`${MANIFEST_PATH}: "${key}" must be a string.`);
  if (m.review !== undefined && (typeof m.review !== "object" || Array.isArray(m.review))) p.push(`${MANIFEST_PATH}: "review" must be an object.`);
  const badTool = (t) => !t || typeof t.path !== "string" || !repoPath(t.path) || !TOOL_RUNTIMES.includes(t.runtime) || (t.env !== undefined && (typeof t.env !== "string" || !repoPath(t.env)));
  if (m.tools !== undefined && (!Array.isArray(m.tools) || m.tools.some(badTool))) p.push(`${MANIFEST_PATH}: "tools" must be a list of {"path", "runtime": ${TOOL_RUNTIMES.map((r) => `"${r}"`).join(" | ")}, "env"?} with repo-relative paths.`);
  return p;
}

/** The manifest on disk, or a fresh pending one. Throws when the file exists but is not valid JSON. */
function loadManifest(root) {
  const text = read(manifestPath(root));
  if (text === undefined) return { version: 1, setup: "pending", verify: [], connectors: [] };
  try {
    return { verify: [], connectors: [], ...JSON.parse(text) };
  } catch (err) {
    throw new Error(`${MANIFEST_PATH} is not valid JSON (${err.message}). Fix or delete it and run again.`);
  }
}

function saveManifest(root, manifest) {
  const file = manifestPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  // Keys in the order of `Manifest` (lib/types.ts), then anything else the file already had.
  const order = ["version", "setup", "mode", "language", "startedAt", "completedAt", "verify", "tools", "review", "connectors", "agentlint"];
  const sorted = Object.fromEntries([...order.filter((k) => k in manifest).map((k) => [k, manifest[k]]), ...Object.entries(manifest).filter(([k]) => !order.includes(k))]);
  fs.writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Frontmatter keys of a Markdown file (`key: value` lines only), or undefined when there is none. */
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!m) return undefined;
  const keys = {};
  let last;
  for (const line of m[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (pair) keys[(last = pair[1])] = pair[2].trim();
    else if (last && /^\s+(-\s+)?\S/.test(line)) keys[last] = `${keys[last]} ${line.trim()}`.trim();
  }
  return keys;
}

/** What is missing or malformed in the files /setup writes. Empty means complete. */
export function checkOutputs(root, manifest) {
  const p = [];
  const claude = read(path.join(root, "CLAUDE.md"));
  if (claude === undefined || !claude.trim()) p.push("CLAUDE.md is missing or empty.");
  else if (claude.split("\n").length > CLAUDE_MD_MAX_LINES) p.push(`CLAUDE.md has more than ${CLAUDE_MD_MAX_LINES} lines. Move details into .claude/skills/domain-* or .claude/rules/.`);

  const glossary = read(path.join(root, "GLOSSARY.md"));
  if (glossary === undefined || !glossary.trim()) p.push("GLOSSARY.md is missing or empty.");

  const skillsDir = path.join(root, ".claude/skills");
  let domain = 0;
  for (const dir of listDir(skillsDir)) {
    if (!isDir(path.join(skillsDir, dir))) continue;
    const where = `.claude/skills/${dir}/SKILL.md`;
    const text = read(path.join(skillsDir, dir, "SKILL.md"));
    if (text === undefined) {
      p.push(`${where} is missing.`);
      continue;
    }
    const fm = frontmatter(text);
    if (!fm?.name || !fm.description) p.push(`${where} needs frontmatter with "name" and "description".`);
    else if (!SKILL_NAME.test(fm.name)) p.push(`${where}: name "${fm.name}" must use lowercase letters, digits and hyphens.`);
    else if (fm.name !== dir) p.push(`${where}: name "${fm.name}" must match its folder "${dir}".`);
    else if (dir.startsWith("domain-")) domain++;
  }
  if (!domain) p.push("No domain skill: write at least one .claude/skills/domain-<area>/SKILL.md.");
  if (read(path.join(skillsDir, "verify-app", "SKILL.md")) === undefined) p.push(".claude/skills/verify-app/SKILL.md is missing.");

  const adrDir = path.join(root, "docs/adr");
  if (!isDir(adrDir)) p.push("docs/adr/ is missing. Record at least the decisions the code shows or the user confirmed.");
  else {
    const adrs = listDir(adrDir).filter((f) => f.endsWith(".md") && !/^(README|index|template)/i.test(f));
    if (!adrs.length) p.push("docs/adr/ has no ADR. Write docs/adr/NNNN-<title>.md for each decision the code shows or the user confirmed.");
    for (const f of adrs) {
      if (!ADR_NAME.test(f)) p.push(`docs/adr/${f}: name it NNNN-<kebab-title>.md.`);
      else if (!/^#\s+\S/m.test(read(path.join(adrDir, f)) ?? "")) p.push(`docs/adr/${f} needs a "# " title.`);
    }
  }

  const rulesDir = path.join(root, ".claude/rules");
  for (const f of listDir(rulesDir).filter((f) => f.endsWith(".md"))) {
    const fm = frontmatter(read(path.join(rulesDir, f)) ?? "");
    if (!fm?.paths) p.push(`.claude/rules/${f} needs frontmatter with "paths:" (the globs it applies to).`);
  }

  const withServer = manifest.connectors.filter((c) => c.server);
  if (withServer.length) {
    const text = read(path.join(root, ".mcp.json"));
    let servers;
    try {
      servers = text === undefined ? undefined : JSON.parse(text)?.mcpServers;
    } catch {
      p.push(".mcp.json is not valid JSON.");
    }
    if (text === undefined) p.push(".mcp.json is missing but connectors name MCP servers.");
    else for (const c of withServer) if (servers?.[c.server] === undefined) p.push(`.mcp.json has no mcpServers.${c.server} for connector ${c.id}.`);
  }

  if (!manifest.verify.length) p.push("No verify steps. Pass at least one --step that checks the project.");
  return [...new Set(p)];
}

/** Runs a file with args from `cwd`; resolves { code, out }. Never rejects; code is null when it could not start or timed out. */
function exec(file, args, cwd, timeout) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { cwd, timeout, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
      resolve({ code, out: `${stdout ?? ""}${stderr ?? ""}`.trim() });
    });
    child.stdin?.end();
  });
}

const onPath = async (bin, cwd) => (await exec("sh", ["-c", 'command -v -- "$1"', "_", bin], cwd, 10_000)).code === 0;
const forceQuote = (word) => `'${word.replaceAll("'", "'\\''")}'`;
const quote = (word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : forceQuote(word));

/** The nix env file of a tool: the declared one, else the first of NIX_ENVS next to the script that exists. */
export function toolEnv(root, tool) {
  if (tool.runtime !== "nix") return undefined;
  if (tool.env) return tool.env;
  const dir = path.posix.dirname(tool.path);
  return NIX_ENVS.map((f) => (dir === "." ? f : `${dir}/${f}`)).find((f) => fs.existsSync(path.join(root, f)));
}

/** The binary that runs a tool: python3, or nix / nix-shell for a flake / shell.nix env. */
export const toolRuntimeBin = (tool) => (tool.runtime === "python" ? "python3" : path.posix.basename(tool.env ?? "") === "flake.nix" ? "nix" : "nix-shell");

/**
 * How to run a tool with `args`, from the repo root: `{ file, args, display }`. `display` is the exact command line
 * the verify-app skill and the /task brief give the agents.
 */
export function toolCommand(tool, args = []) {
  const script = tool.path.includes("/") ? tool.path : `./${tool.path}`;
  if (tool.runtime === "python") {
    const argv = [tool.path, ...args];
    return { file: "python3", args: argv, display: ["python3", ...argv].map(quote).join(" ") };
  }
  if (toolRuntimeBin(tool) === "nix") {
    const dir = path.posix.dirname(tool.env);
    const argv = ["--extra-experimental-features", "nix-command flakes", "develop", `path:./${dir === "." ? "" : dir}`, "--command", script, ...args];
    return { file: "nix", args: argv, display: ["nix", ...argv].map(quote).join(" ") };
  }
  const inner = [script, ...args].map(quote).join(" ");
  return { file: "nix-shell", args: [tool.env, "--run", inner], display: `nix-shell ${quote(tool.env)} --run ${forceQuote(inner)}` };
}

/**
 * Checks each verification tool: inside the repo, executable, pinned (nix env, python stdlib only), answering `--help`
 * with exit 0, and named in the verify-app skill. `--help` must not have side effects, so nothing else is run.
 * A runtime missing on this machine is a warning: the person installs it (`/wf-doctor` reports it), the plugin never does.
 */
export async function checkTools(root, tools) {
  const problems = [];
  const warnings = [];
  const ready = [];
  const skill = read(path.join(root, ".claude/skills/verify-app/SKILL.md")) ?? "";
  const seen = new Set();
  for (const declared of tools) {
    const where = `tool ${declared.path}`;
    if (seen.has(declared.path)) {
      problems.push(`${where} is registered twice.`);
      continue;
    }
    seen.add(declared.path);
    const file = path.join(root, declared.path);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      problems.push(`${where} does not exist. Write it or drop its --tool.`);
      continue;
    }
    if (!stat.isFile()) {
      problems.push(`${where} is not a file.`);
      continue;
    }
    if (!(stat.mode & 0o111)) problems.push(`${where} is not executable: chmod +x ${declared.path}.`);
    const tool = { ...declared };
    if (tool.runtime === "nix") {
      tool.env = toolEnv(root, tool);
      if (!tool.env) {
        problems.push(`${where} declares runtime nix but has no ${NIX_ENVS.join(" or ")} next to it that pins its dependencies.`);
        continue;
      }
      if (!fs.existsSync(path.join(root, tool.env))) {
        problems.push(`${where}: its nix env ${tool.env} does not exist.`);
        continue;
      }
    }
    const { display } = toolCommand(tool);
    if (!skill.includes(tool.path)) problems.push(`.claude/skills/verify-app/SKILL.md does not name ${where}: add its exact command (${display}), when to use it and what its output means.`);
    const bin = toolRuntimeBin(tool);
    if (!(await onPath(bin, root))) {
      warnings.push(`${where}: \`${bin}\` is not installed here, so --help was not checked. Install ${tool.runtime === "python" ? "Python 3" : "nix"} and run /wf-doctor.`);
      ready.push({ tool, display });
      continue;
    }
    if (tool.runtime === "python") {
      const r = await exec("python3", ["-c", STDLIB_CHECK, tool.path], root, 30_000);
      if (r.code !== 0) problems.push(`${where} does not parse as Python 3:\n${r.out.slice(-1000)}`);
      else {
        let extra = [];
        try {
          extra = JSON.parse(r.out.split("\n").pop() ?? "[]");
        } catch {}
        if (extra.length) problems.push(`${where} imports modules outside the Python standard library (${extra.join(", ")}). Use the stdlib only, or make it a nix tool that pins them.`);
      }
    }
    const { file: runFile, args } = toolCommand(tool, ["--help"]);
    const help = await exec(runFile, args, root, HELP_TIMEOUT_MS[tool.runtime]);
    if (help.code !== 0) problems.push(`\`${toolCommand(tool, ["--help"]).display}\` ${help.code === null ? "did not finish (timeout or could not start)" : `exited ${help.code}`}:\n${help.out.slice(-1000)}`);
    else if (!help.out) problems.push(`\`${toolCommand(tool, ["--help"]).display}\` printed nothing: --help must state the purpose, the arguments and the output.`);
    ready.push({ tool, display });
  }
  return { problems, warnings, tools: ready };
}

/** Adds the workflow lines to `.gitignore` unless the folder is already covered. */
function ensureIgnored(root) {
  const file = path.join(root, ".gitignore");
  const current = read(file) ?? "";
  const lines = current.split("\n").map((l) => l.trim());
  if (lines.some((l) => [`${WORKFLOW_DIR}`, `${WORKFLOW_DIR}/`, `/${WORKFLOW_DIR}/`].includes(l))) return false;
  const missing = IGNORE_LINES.filter((l) => !lines.includes(l));
  if (!missing.length) return false;
  fs.writeFileSync(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  return true;
}

const hasAgentlintConfig = (root) => listDir(path.join(root, ".agentlint")).some((f) => /^config\.[cm]?[jt]s$/.test(f));

export async function main(argv, env = process.env, cwd = process.cwd()) {
  const out = [];
  const say = (line) => out.push(line);
  let code = 0;
  try {
    const opts = parseArgs(argv);
    const root = projectDir(env, cwd);
    const manifest = loadManifest(root);
    if (opts.language) manifest.language = opts.language;
    if (opts.mode) manifest.mode = opts.mode;
    if (opts.connectors.length) manifest.connectors = opts.connectors;
    if (opts.agentlint) manifest.agentlint = opts.agentlint;
    if (opts.steps.length) manifest.verify = opts.steps;
    if (opts.tools.length) manifest.tools = opts.tools;

    if (opts.start && opts.pause) throw new Usage("--start and --pause exclude each other");
    if (opts.start || opts.pause) {
      manifest.setup = opts.start ? "running" : "pending";
      if (opts.start) manifest.startedAt ??= new Date().toISOString();
      const shape = manifestProblems(manifest);
      if (shape.length) throw new Error(shape.join("\n"));
      saveManifest(root, manifest);
      say(opts.start ? `setup: running (${MANIFEST_PATH}). Finish with wf-setup-finish.mjs and the verify steps.` : `setup: pending (paused; ${MANIFEST_PATH} keeps what is done). Stop here.`);
      return { code, text: out.join("\n") };
    }

    const problems = manifestProblems({ ...manifest, setup: manifest.setup ?? "pending" });
    problems.push(...checkOutputs(root, manifest));
    const toolsValid = Array.isArray(manifest.tools) && !manifestProblems({ ...manifest, setup: "pending" }).some((l) => l.includes('"tools"'));
    const tools = toolsValid ? await checkTools(root, manifest.tools) : { problems: [], warnings: [], tools: [] };
    problems.push(...tools.problems);
    const toolReport = () => {
      if (!tools.tools.length && !tools.warnings.length) return;
      say("Verification tools (give agents these exact commands):");
      for (const { display } of tools.tools) say(`- ${display}`);
      for (const line of tools.warnings) say(`! ${line}`);
      say("");
    };
    let verify = manifest.verify;
    if (manifest.agentlint) {
      if (!hasAgentlintConfig(root)) problems.push(`agentlint is not configured: run \`${manifest.agentlint} init\` and add the rules the user selected.`);
      else {
        const tests = await runVerify([`${manifest.agentlint} rules test`], root);
        // A config with zero rules is a valid choice; agentlint reports it as "No matching rules".
        if (!tests.ok && !tests.results.some((r) => /No matching rules/.test(r.output))) problems.push(`agentlint rule fixtures fail:\n${formatVerify(tests)}`);
      }
      if (!verify.some((s) => /\bagentlint\b/.test(s))) verify = [...verify, `${manifest.agentlint} check --all`];
    }
    if (problems.length) {
      toolReport();
      say("Setup incomplete:");
      for (const line of problems) say(`- ${line}`);
      say("\nFix these and run wf-setup-finish.mjs again.");
      return { code: 1, text: out.join("\n") };
    }

    if (tools.tools.length) manifest.tools = tools.tools.map(({ tool }) => tool);
    toolReport();
    const result = await runVerify(verify, root);
    say(formatVerify(result));
    manifest.verify = verify;
    if (!result.ok && !opts.acceptFailing) {
      // Keep the steps so a resumed setup starts from them; setup stays running.
      if (manifest.setup !== "done") manifest.setup = "running";
      saveManifest(root, manifest);
      say("\nFix the cause (or the verify steps, if they are wrong) and run wf-setup-finish.mjs again.");
      return { code: 1, text: out.join("\n") };
    }

    if (ensureIgnored(root)) say(`.gitignore: added ${IGNORE_LINES.join(", ")}`);
    manifest.setup = "done";
    manifest.mode ??= "direct";
    manifest.completedAt = new Date().toISOString();
    saveManifest(root, manifest);
    say(`\nsetup: done${result.ok ? "" : " (verify still fails: the user accepted it)"}. Wrote ${MANIFEST_PATH}. Stop here.`);
  } catch (err) {
    code = err instanceof Usage ? 2 : 1;
    say(`wf-setup-finish: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { code, text: out.join("\n") };
}

const self = fs.realpathSync(fileURLToPath(import.meta.url));
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === self) {
  const { code, text } = await main(process.argv.slice(2));
  await new Promise((resolve) => process.stdout.write(`${text}\n`, resolve));
  process.exit(code);
}
