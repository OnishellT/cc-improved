#!/usr/bin/env node
// Repository scan for /setup: prints one JSON object to stdout. It only detects and proposes; it never writes.
// Language agnostic on purpose: every candidate command comes from a file in the repo (scripts, task runners, CI),
// never from a guess about the stack. Run as: node "${CLAUDE_PLUGIN_ROOT}/bin/wf-scan.mjs" [root]
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FILE = 256 * 1024;

/** Marker file (or regex on a file name) → stack id. Informative only: nothing below branches on the stack. */
const STACK_MARKERS = [
  ["package.json", "node"],
  ["deno.json", "deno"],
  ["deno.jsonc", "deno"],
  ["tsconfig.json", "typescript"],
  ["pyproject.toml", "python"],
  ["setup.py", "python"],
  ["setup.cfg", "python"],
  ["requirements.txt", "python"],
  ["Pipfile", "python"],
  ["go.mod", "go"],
  ["Cargo.toml", "rust"],
  ["pom.xml", "java"],
  ["build.gradle", "jvm"],
  ["build.gradle.kts", "jvm"],
  ["build.sbt", "scala"],
  ["Gemfile", "ruby"],
  ["composer.json", "php"],
  ["mix.exs", "elixir"],
  ["Package.swift", "swift"],
  ["pubspec.yaml", "dart"],
  ["CMakeLists.txt", "cmake"],
  ["meson.build", "meson"],
  ["build.zig", "zig"],
  ["stack.yaml", "haskell"],
  ["dune-project", "ocaml"],
  [/\.(csproj|fsproj|sln)$/, "dotnet"],
  [/\.cabal$/, "haskell"],
  [/\.nimble$/, "nim"],
];

/** Lockfile or wrapper → package manager or build tool, with the ecosystem it belongs to. */
const PACKAGE_MANAGERS = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["deno.lock", "deno"],
  ["uv.lock", "uv"],
  ["poetry.lock", "poetry"],
  ["pdm.lock", "pdm"],
  ["Pipfile.lock", "pipenv"],
  ["Cargo.lock", "cargo"],
  ["go.sum", "go"],
  ["Gemfile.lock", "bundler"],
  ["composer.lock", "composer"],
  ["mix.lock", "mix"],
  ["gradlew", "gradle-wrapper"],
  ["mvnw", "maven-wrapper"],
  ["pubspec.lock", "pub"],
];

/** Commands a node package manager uses to run a package.json script. */
const SCRIPT_RUNNER = { npm: "npm run", pnpm: "pnpm run", yarn: "yarn run", bun: "bun run" };

const CI_FILES = [".gitlab-ci.yml", "bitbucket-pipelines.yml", ".circleci/config.yml", "azure-pipelines.yml", "Jenkinsfile", ".travis.yml", ".buildkite/pipeline.yml", ".drone.yml", ".woodpecker.yml", "appveyor.yml"];
const DOC_FILES = ["README.md", "README.rst", "README", "CONTRIBUTING.md", "ARCHITECTURE.md", "DEVELOPMENT.md", "HACKING.md", "GLOSSARY.md", "CHANGELOG.md", "docs", "doc", "docs/adr", "doc/adr", "adr", "docs/decisions", "docs/agents"];
const AGENT_FILES = ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", "AGENTS.md", ".cursorrules", ".cursor/rules", ".github/copilot-instructions.md", ".windsurfrules", ".mcp.json"];

/** Tool config files: evidence of what the repo already uses. Reported as found, never turned into commands. */
const TOOL_CONFIGS = [
  [/^eslint\.config\.[cm]?[jt]s$|^\.eslintrc(\.\w+)?$/, "eslint"],
  [/^biome\.jsonc?$/, "biome"],
  [/^\.prettierrc(\.\w+)?$|^prettier\.config\.[cm]?js$/, "prettier"],
  [/^tsconfig\.json$/, "tsc"],
  [/^(vitest|jest|playwright)\.config\.[cm]?[jt]s$/, null],
  [/^ruff\.toml$|^\.ruff\.toml$/, "ruff"],
  [/^mypy\.ini$|^\.mypy\.ini$/, "mypy"],
  [/^pytest\.ini$|^conftest\.py$/, "pytest"],
  [/^tox\.ini$/, "tox"],
  [/^noxfile\.py$/, "nox"],
  [/^\.golangci\.ya?ml$/, "golangci-lint"],
  [/^clippy\.toml$|^\.clippy\.toml$/, "clippy"],
  [/^rustfmt\.toml$|^\.rustfmt\.toml$/, "rustfmt"],
  [/^\.rubocop\.yml$/, "rubocop"],
  [/^phpunit\.xml(\.dist)?$/, "phpunit"],
  [/^phpstan\.neon(\.dist)?$/, "phpstan"],
  [/^\.pre-commit-config\.yaml$/, "pre-commit"],
  [/^\.editorconfig$/, "editorconfig"],
];
const PYPROJECT_TOOLS = ["ruff", "mypy", "pytest", "black", "isort", "pyright", "pylint", "coverage", "hatch", "poetry", "pdm", "uv", "poe"];

/** Script or target names that usually check something. Others are listed but not proposed. */
const CHECK_NAME = /^(verify|check|ci|test|tests|unit|spec|lint|typecheck|type-check|types|tsc|fmt|format|format-check|fmt-check|vet|clippy|build|compile|validate|e2e|integration)([:_-][\w:-]+)?$/i;
/** Kind of a command, guessed from its words; used only to order candidates fastest first. */
const KINDS = [
  ["install", /^\S+(\s+\S+)?\s+(install|ci|sync|restore|bootstrap|download|fetch|get)\b/i],
  ["verify", /\bverify\b|^(ci|check|checks)$/i],
  ["format", /\b(fmt|format|prettier|black|rustfmt|gofmt)\b/i],
  ["lint", /\b(lint|eslint|ruff|clippy|vet|rubocop|golangci|pylint|biome|phpstan|credo)\b/i],
  ["typecheck", /\b(typecheck|type-check|types|tsc|mypy|pyright|check)\b/i],
  ["build", /\b(build|compile|bundle|assemble)\b/i],
  ["test", /\b(test|tests|spec|pytest|jest|vitest|unit|e2e|integration|ctest)\b/i],
];
const KIND_ORDER = ["verify", "format", "lint", "typecheck", "build", "test", "other", "install"];
const kindOf = (text) => KINDS.find(([, re]) => re.test(text))?.[0] ?? "other";

/** Uppercase words before a dash and digits that are not ticket keys. */
const NOT_TICKETS = new Set(["UTF", "SHA", "ISO", "RFC", "CVE", "MD", "HTTP", "TLS", "SSL", "ES", "AES", "RSA", "IPV", "X", "WIP", "GPL", "LGPL", "BSD", "MIT", "CC", "PEP", "ECMA", "ANSI", "ASCII", "UTC", "GMT", "COVID", "CWE", "GHSA", "PR", "V"]);

/** Vetted read-only connectors /setup may enable. `mcp` is the remote MCP server written to `.mcp.json`. */
const CONNECTORS = [
  { id: "github", name: "GitHub", purpose: "issues, pull requests and reviews", mcp: { type: "http", url: "https://api.githubcopilot.com/mcp/" } },
  { id: "gitlab", name: "GitLab", purpose: "issues and merge requests" },
  { id: "jira", name: "Jira", purpose: "tickets, epics and acceptance criteria", mcp: { type: "http", url: "https://mcp.atlassian.com/v1/mcp" } },
  { id: "linear", name: "Linear", purpose: "issues and project plans", mcp: { type: "http", url: "https://mcp.linear.app/mcp" } },
  { id: "slack", name: "Slack", purpose: "team discussions and decisions" },
];

// ---------------------------------------------------------------------------

const rel = (root, file) => path.relative(root, file).split(path.sep).join("/");
const exists = (file) => fs.existsSync(file);
function readText(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return "";
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(stat.size, MAX_FILE));
      fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}
function readJson(file) {
  const text = readText(file);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
function list(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
function git(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4 * 1024 * 1024 });
  } catch {
    return "";
  }
}

/** Stacks whose marker sits in `dir`. */
function stacksIn(dir) {
  const names = list(dir).filter((e) => e.isFile()).map((e) => e.name);
  const found = [];
  for (const [marker, id] of STACK_MARKERS) {
    const hit = typeof marker === "string" ? names.find((n) => n === marker) : names.find((n) => marker.test(n));
    if (hit) found.push({ id, evidence: hit });
  }
  return found;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "target", "dist", "build", "vendor", ".venv", "venv", "__pycache__", ".next", "out", "coverage"]);

function detectStacks(root) {
  const stacks = stacksIn(root);
  // Monorepos: markers one and two levels down (packages/*, apps/*, services/*).
  const subprojects = [];
  const visit = (dir, depth) => {
    for (const e of list(dir)) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const sub = path.join(dir, e.name);
      const found = stacksIn(sub);
      if (found.length) subprojects.push({ path: rel(root, sub), stacks: [...new Set(found.map((s) => s.id))] });
      else if (depth < 2) visit(sub, depth + 1);
    }
  };
  visit(root, 1);
  return { stacks, subprojects: subprojects.slice(0, 30) };
}

function detectPackageManagers(root, pkg) {
  const found = PACKAGE_MANAGERS.filter(([file]) => exists(path.join(root, file))).map(([file, id]) => ({ id, evidence: file }));
  const declared = typeof pkg?.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
  if (declared && !found.some((m) => m.id === declared)) found.unshift({ id: declared, evidence: "package.json#packageManager" });
  return found;
}

/** Runner for package.json scripts, only when the repo says which manager it uses. */
function nodeRunner(root, pkg, managers) {
  const declared = typeof pkg?.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
  if (declared && SCRIPT_RUNNER[declared]) return SCRIPT_RUNNER[declared];
  const ids = [...new Set(managers.map((m) => m.id).filter((id) => SCRIPT_RUNNER[id]))];
  return ids.length === 1 ? SCRIPT_RUNNER[ids[0]] : undefined;
}

function scriptCandidates(root, pkg, managers) {
  const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts ? pkg.scripts : {};
  const runner = nodeRunner(root, pkg, managers);
  const out = [];
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== "string" || !CHECK_NAME.test(name)) continue;
    const candidate = { source: `package.json#scripts.${name}`, kind: kindOf(name), script: body };
    if (runner) candidate.command = `${runner} ${name}`;
    else candidate.unresolved = "no lockfile or packageManager field says which package manager runs this script";
    out.push(candidate);
  }
  const deno = readJson(path.join(root, "deno.json")) ?? readJson(path.join(root, "deno.jsonc"));
  for (const [name, body] of Object.entries(deno?.tasks ?? {})) {
    if (CHECK_NAME.test(name)) out.push({ command: `deno task ${name}`, source: `deno.json#tasks.${name}`, kind: kindOf(name), script: typeof body === "string" ? body : JSON.stringify(body) });
  }
  return out;
}

/** Targets of Makefile, justfile and Taskfile. */
function taskRunnerCandidates(root) {
  const out = [];
  const all = [];
  for (const [file, tool] of [["Makefile", "make"], ["GNUmakefile", "make"], ["makefile", "make"], ["justfile", "just"], ["Justfile", "just"], [".justfile", "just"]]) {
    const text = readText(path.join(root, file));
    if (!text) continue;
    const re = tool === "make" ? /^([A-Za-z][\w.-]*)\s*:(?!=)/gm : /^@?([A-Za-z][\w-]*)(?:\s+[^:\n=]*)?:(?!=)/gm;
    const targets = [...new Set([...text.matchAll(re)].map((m) => m[1]))];
    all.push({ file, tool, targets });
    for (const t of targets) if (CHECK_NAME.test(t)) out.push({ command: `${tool} ${t}`, source: file, kind: kindOf(t) });
    break;
  }
  for (const file of ["Taskfile.yml", "Taskfile.yaml", "taskfile.yml"]) {
    const text = readText(path.join(root, file));
    if (!text) continue;
    const block = text.split(/^tasks:\s*$/m)[1] ?? "";
    const targets = [...block.matchAll(/^ {2}([A-Za-z][\w:-]*):/gm)].map((m) => m[1]);
    all.push({ file, tool: "task", targets });
    for (const t of targets) if (CHECK_NAME.test(t)) out.push({ command: `task ${t}`, source: file, kind: kindOf(t) });
    break;
  }
  // Python task definitions that name their own commands.
  const pyproject = readText(path.join(root, "pyproject.toml"));
  for (const [section, tool] of [["tool.poe.tasks", "poe"], ["tool.pdm.scripts", "pdm run"]]) {
    const body = tomlSection(pyproject, section);
    const names = [...body.matchAll(/^([A-Za-z][\w-]*)\s*=/gm)].map((m) => m[1]);
    if (names.length) all.push({ file: `pyproject.toml [${section}]`, tool, targets: names });
    for (const n of names) if (CHECK_NAME.test(n)) out.push({ command: `${tool} ${n}`, source: `pyproject.toml [${section}]`, kind: kindOf(n) });
  }
  const tox = readText(path.join(root, "tox.ini"));
  const envs = /^\s*env_?list\s*=\s*(.+(?:\n[ \t]+.+)*)/m.exec(tox)?.[1];
  if (envs) {
    const names = envs.split(/[\s,]+/).filter(Boolean);
    all.push({ file: "tox.ini", tool: "tox", targets: names });
    for (const n of names) out.push({ command: `tox -e ${n}`, source: "tox.ini", kind: kindOf(n) === "other" ? "test" : kindOf(n) });
  }
  const nox = readText(path.join(root, "noxfile.py"));
  const sessions = [...nox.matchAll(/@nox\.session[^\n]*\n\s*def\s+(\w+)/g)].map((m) => m[1]);
  if (sessions.length) {
    all.push({ file: "noxfile.py", tool: "nox", targets: sessions });
    for (const s of sessions) if (CHECK_NAME.test(s)) out.push({ command: `nox -s ${s}`, source: "noxfile.py", kind: kindOf(s) });
  }
  return { candidates: out, taskRunners: all };
}

/** Body of a `[section]` table in a TOML file, up to the next table header. */
function tomlSection(text, section) {
  const start = text.indexOf(`[${section}]`);
  if (start < 0) return "";
  const rest = text.slice(start + section.length + 2);
  const next = rest.search(/^\[/m);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Shell lines CI runs: `run:` in GitHub/Gitea/Forgejo workflows, `script:` lists elsewhere. */
function ciCommands(text) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^(\s*)(?:-\s+)?(run|script|command|commands|before_script|after_script|cmd):\s*(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const value = m[3].trim();
    const take = (s) => {
      const cmd = s.replace(/^-\s+/, "").replace(/^["']|["']$/g, "").trim();
      if (cmd && !cmd.startsWith("#") && !/^\$\{\{.*\}\}$/.test(cmd)) out.push(cmd);
    };
    if (value && !/^[|>][-+]?$/.test(value)) {
      if (value.startsWith("[")) value.slice(1, -1).split(",").forEach(take);
      else take(value);
      continue;
    }
    // Block scalar or list on the following, more indented lines.
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (!next.trim()) continue;
      const nextIndent = next.length - next.trimStart().length;
      if (nextIndent <= indent) break;
      take(next.trim());
      i = j;
    }
  }
  return out;
}

function detectCi(root) {
  const files = [];
  for (const dir of [".github/workflows", ".gitea/workflows", ".forgejo/workflows"]) {
    for (const e of list(path.join(root, dir))) if (e.isFile() && /\.ya?ml$/.test(e.name)) files.push(`${dir}/${e.name}`);
  }
  for (const f of CI_FILES) if (exists(path.join(root, f))) files.push(f);
  const candidates = [];
  const seen = new Set();
  for (const file of files) {
    for (const command of ciCommands(readText(path.join(root, file)))) {
      if (command.length > 300 || seen.has(command)) continue;
      seen.add(command);
      candidates.push({ command, source: file, kind: kindOf(command) });
    }
  }
  return { ci: files, candidates };
}

function detectTools(root, pkg) {
  const tools = [];
  const names = list(root).filter((e) => e.isFile()).map((e) => e.name);
  for (const [re, tool] of TOOL_CONFIGS) {
    for (const n of names) if (re.test(n)) tools.push({ tool: tool ?? n.split(".")[0], evidence: n });
  }
  const pyproject = readText(path.join(root, "pyproject.toml"));
  for (const tool of PYPROJECT_TOOLS) if (pyproject.includes(`[tool.${tool}`)) tools.push({ tool, evidence: `pyproject.toml [tool.${tool}]` });
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  for (const name of Object.keys(deps)) {
    if (/^(typescript|eslint|prettier|@biomejs\/biome|vitest|jest|mocha|ava|@playwright\/test|cypress|oxlint)$/.test(name)) tools.push({ tool: name, evidence: "package.json dependencies" });
  }
  return tools;
}

function detectDocs(root) {
  const docs = DOC_FILES.filter((f) => exists(path.join(root, f)));
  const agentFiles = AGENT_FILES.filter((f) => exists(path.join(root, f)));
  const adrDir = ["docs/adr", "doc/adr", "adr", "docs/decisions"].find((d) => exists(path.join(root, d)));
  const adrs = adrDir ? list(path.join(root, adrDir)).filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => `${adrDir}/${e.name}`).sort() : [];
  const skills = list(path.join(root, ".claude/skills")).filter((e) => e.isDirectory()).map((e) => `.claude/skills/${e.name}`).sort();
  const rules = list(path.join(root, ".claude/rules")).filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => `.claude/rules/${e.name}`).sort();
  return { docs, agentFiles, adrs, skills, rules, glossary: exists(path.join(root, "GLOSSARY.md")) };
}

function parseRemotes(text) {
  const remotes = new Map();
  for (const line of text.split("\n")) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(line);
    if (!m) continue;
    const url = m[2];
    const host = /^[\w+.-]+:\/\/(?:[^@/]+@)?([^/:]+)/.exec(url)?.[1] ?? /^(?:[^@]+@)?([^:/]+):/.exec(url)?.[1];
    const slug = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1];
    remotes.set(m[1], { name: m[1], url: url.replace(/\/\/[^@/]+@/, "//"), ...(host ? { host } : {}), ...(slug ? { repo: slug } : {}) });
  }
  return [...remotes.values()];
}

/** Ticket keys like PAY-142 in commit subjects and branch names, grouped by prefix. */
function ticketKeys(text) {
  const byPrefix = new Map();
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g)) {
    const prefix = m[1];
    if (NOT_TICKETS.has(prefix) || /^[A-Z]\d/.test(prefix)) continue;
    const entry = byPrefix.get(prefix) ?? { prefix, count: 0, examples: [] };
    entry.count++;
    if (entry.examples.length < 3 && !entry.examples.includes(m[0])) entry.examples.push(m[0]);
    byPrefix.set(prefix, entry);
  }
  return [...byPrefix.values()].sort((a, b) => b.count - a.count).slice(0, 10);
}

function detectConnectors({ remotes, keys, issueRefs, docText }) {
  const found = new Map();
  const note = (id, evidence) => found.has(id) || found.set(id, evidence);
  for (const r of remotes) {
    if (r.host === "github.com") note("github", `git remote ${r.name} is on github.com`);
    else if (/gitlab/i.test(r.host ?? "")) note("gitlab", `git remote ${r.name} is on ${r.host}`);
  }
  if (/linear\.app/i.test(docText)) note("linear", "docs mention linear.app");
  if (/atlassian\.net|\bjira\b/i.test(docText)) note("jira", "docs mention Jira or atlassian.net");
  // PREFIX-123 keys are used by both Jira and Linear: offer Jira unless Linear is already evident.
  if (keys.length && !found.has("linear")) note("jira", `commits or branches reference tickets like ${keys[0].examples[0]}`);
  if (/slack\.com|hooks\.slack/i.test(docText)) note("slack", "docs mention Slack");
  if (issueRefs > 0 && found.has("github")) found.set("github", `${found.get("github")}; ${issueRefs} commit subjects reference #issues`);
  return [...found].map(([id, evidence]) => ({ id, evidence }));
}

function readManifest(root) {
  const file = path.join(root, ".claude/workflow.json");
  if (!exists(file)) return null;
  const text = readText(file);
  try {
    return JSON.parse(text);
  } catch (err) {
    return { invalid: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function sortCandidates(candidates) {
  const seen = new Set();
  const unique = candidates.filter((c) => {
    const key = c.command ?? c.source;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique
    .map((c, i) => ({ c, i }))
    .sort((a, b) => KIND_ORDER.indexOf(a.c.kind) - KIND_ORDER.indexOf(b.c.kind) || a.i - b.i)
    .map(({ c }) => c);
}

/** Deterministic scan of `root`. No model, no writes, no network. */
export function scan(root) {
  root = path.resolve(root);
  const pkg = readJson(path.join(root, "package.json"));
  const { stacks, subprojects } = detectStacks(root);
  const packageManagers = detectPackageManagers(root, pkg);
  const runners = taskRunnerCandidates(root);
  const ci = detectCi(root);
  const docs = detectDocs(root);

  const isGit = git(root, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  const remotes = isGit ? parseRemotes(git(root, ["remote", "-v"])) : [];
  const history = isGit ? `${git(root, ["log", "-300", "--format=%s"])}\n${git(root, ["for-each-ref", "--count=300", "--format=%(refname:short)", "refs/heads", "refs/remotes"])}` : "";
  const keys = ticketKeys(history);
  const issueRefs = (history.match(/(^|\s)\(?#\d+\b/gm) ?? []).length;
  const docText = ["README.md", "CONTRIBUTING.md", "CLAUDE.md", "AGENTS.md", "package.json"].map((f) => readText(path.join(root, f))).join("\n");

  const agentlintConfig = list(path.join(root, ".agentlint")).some((e) => /^config\.[cm]?[jt]s$/.test(e.name));
  const gitignore = readText(path.join(root, ".gitignore"));

  return {
    root,
    git: isGit,
    stacks,
    subprojects,
    packageManagers,
    ci: ci.ci,
    // Fastest first: verify > format > lint > typecheck > build > test > other > install.
    candidates: sortCandidates([...scriptCandidates(root, pkg, packageManagers), ...runners.candidates, ...ci.candidates]),
    taskRunners: runners.taskRunners,
    tools: detectTools(root, pkg),
    ...docs,
    remotes,
    ticketKeys: keys,
    connectors: detectConnectors({ remotes, keys, issueRefs, docText }),
    connectorCatalog: CONNECTORS,
    agentlint: { config: agentlintConfig, dependency: Boolean(pkg?.devDependencies?.["@aurelienbbn/agentlint"] ?? pkg?.dependencies?.["@aurelienbbn/agentlint"]) },
    gitignoreHasWorkflow: /^\/?\.claude\/workflow(\/|\/\*)?\s*$/m.test(gitignore),
    manifest: readManifest(root),
  };
}

const isMain = process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const root = process.argv[2] || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let out;
  try {
    out = scan(root);
  } catch (err) {
    out = { root: path.resolve(root), error: err instanceof Error ? err.message : String(err) };
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}
