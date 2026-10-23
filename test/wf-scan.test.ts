import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const entry = fileURLToPath(new URL("../bin/wf-scan.mjs", import.meta.url));

interface Candidate {
  command?: string;
  source: string;
  kind: string;
  script?: string;
  unresolved?: string;
}
interface Scan {
  root: string;
  git: boolean;
  stacks: { id: string; evidence: string }[];
  subprojects: { path: string; stacks: string[] }[];
  packageManagers: { id: string; evidence: string }[];
  ci: string[];
  candidates: Candidate[];
  tools: { tool: string; evidence: string }[];
  docs: string[];
  agentFiles: string[];
  adrs: string[];
  glossary: boolean;
  remotes: { name: string; url: string; host?: string; repo?: string }[];
  ticketKeys: { prefix: string; count: number; examples: string[] }[];
  connectors: { id: string; evidence: string }[];
  agentlint: { config: boolean; dependency: boolean };
  manifest: unknown;
  gitignoreHasWorkflow: boolean;
}

/** A temporary repo with the given files (path → content). */
async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "wf-scan-"));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
  return dir;
}

async function scan(root: string, env: NodeJS.ProcessEnv = {}): Promise<Scan> {
  const { stdout } = await promisify(execFile)(process.execPath, [entry, root], { env: { PATH: process.env.PATH, ...env } });
  return JSON.parse(stdout) as Scan;
}

const commands = (s: Scan) => s.candidates.flatMap((c) => (c.command ? [c.command] : []));
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
/** Commands the scan must never invent: anything from these tools must come from a file of the repo. */
const FOREIGN = /\b(npm|npx|pnpm|yarn|tsc|eslint|prettier)\b/;

function gitInit(dir: string, commits: string[], remote?: string) {
  const g = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  g("init", "-q", "-b", "main");
  for (const msg of commits) g("commit", "-q", "--allow-empty", "-m", msg);
  if (remote) g("remote", "add", "origin", remote);
}

test("node with pnpm: scripts become commands run by the repo's own package manager, fastest first", async () => {
  const root = await repo({
    "package.json": JSON.stringify({ scripts: { test: "vitest run", lint: "eslint .", typecheck: "tsc -p .", dev: "vite", build: "vite build" }, devDependencies: { typescript: "5", eslint: "9" } }),
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
    "tsconfig.json": "{}",
    "eslint.config.js": "export default []\n",
  });
  const s = await scan(root);
  assert.deepEqual(ids(s.stacks), ["node", "typescript"]);
  assert.deepEqual(ids(s.packageManagers), ["pnpm"]);
  assert.deepEqual(commands(s), ["pnpm run lint", "pnpm run typecheck", "pnpm run build", "pnpm run test"]);
  assert.ok(!commands(s).includes("pnpm run dev"), "non-check scripts are not proposed");
  assert.ok(s.tools.some((t) => t.tool === "eslint" && t.evidence === "eslint.config.js"));
  assert.equal(s.git, false);
  assert.equal(s.manifest, null);
});

test("node without a lockfile: the script is reported but no package manager is assumed", async () => {
  const root = await repo({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }) });
  const s = await scan(root);
  assert.deepEqual(s.packageManagers, []);
  const [c] = s.candidates;
  assert.equal(c?.command, undefined);
  assert.equal(c?.script, "node --test");
  assert.match(c?.unresolved ?? "", /package manager/);
});

test("the packageManager field picks the runner", async () => {
  const root = await repo({ "package.json": JSON.stringify({ packageManager: "yarn@4.1.0", scripts: { test: "jest" } }) });
  const s = await scan(root);
  assert.deepEqual(commands(s), ["yarn run test"]);
});

test("python: commands come from tox, Makefile and CI; tool sections are evidence, not commands", async () => {
  const root = await repo({
    "pyproject.toml": "[project]\nname = 'x'\n\n[tool.ruff]\nline-length = 100\n\n[tool.pytest.ini_options]\naddopts = '-q'\n",
    "uv.lock": "",
    "tox.ini": "[tox]\nenv_list = py312, lint\n",
    Makefile: "install:\n\tuv sync\nlint:\n\truff check .\ntest:\n\tpytest\nVAR := 1\n",
    ".github/workflows/ci.yml": "jobs:\n  t:\n    steps:\n      - uses: actions/checkout@v4\n      - run: uv sync\n      - run: uv run pytest -q\n",
  });
  const s = await scan(root);
  assert.deepEqual(ids(s.stacks), ["python"]);
  assert.deepEqual(ids(s.packageManagers), ["uv"]);
  const cmds = commands(s);
  for (const c of ["make lint", "make test", "tox -e py312", "tox -e lint", "uv run pytest -q", "uv sync"]) assert.ok(cmds.includes(c), c);
  assert.ok(!cmds.includes("make install"), "install targets are not check names");
  assert.ok(cmds.indexOf("make lint") < cmds.indexOf("make test"), "lint before tests");
  assert.equal(cmds.at(-1), "uv sync", "install steps go last");
  assert.ok(!cmds.some((c) => /^ruff|^mypy/.test(c)), "no command is built from a tool section");
  assert.ok(s.tools.some((t) => t.tool === "ruff" && /pyproject/.test(t.evidence)));
  assert.ok(!cmds.some((c) => FOREIGN.test(c)));
});

test("go: Makefile targets and a multi-line CI run block, nothing assumed", async () => {
  const root = await repo({
    "go.mod": "module example.com/x\n\ngo 1.22\n",
    "go.sum": "",
    Makefile: ".PHONY: test\nvet:\n\tgo vet ./...\ntest: vet\n\tgo test ./...\n",
    ".golangci.yml": "linters: {}\n",
    ".github/workflows/go.yml": "jobs:\n  b:\n    steps:\n      - name: test\n        run: |\n          go build ./...\n          go test -race ./...\n",
  });
  const s = await scan(root);
  assert.deepEqual(ids(s.stacks), ["go"]);
  assert.deepEqual(ids(s.packageManagers), ["go"]);
  assert.deepEqual(s.ci, [".github/workflows/go.yml"]);
  const cmds = commands(s);
  for (const c of ["make vet", "make test", "go build ./...", "go test -race ./..."]) assert.ok(cmds.includes(c), c);
  assert.ok(!cmds.some((c) => FOREIGN.test(c)));
  assert.ok(s.tools.some((t) => t.tool === "golangci-lint"));
});

test("rust: justfile recipes and GitLab script lists", async () => {
  const root = await repo({
    "Cargo.toml": "[package]\nname = 'x'\n",
    "Cargo.lock": "",
    justfile: "check:\n    cargo check\nclippy:\n    cargo clippy -- -D warnings\ntest *args:\n    cargo test {{args}}\nrelease:\n    cargo build --release\n",
    ".gitlab-ci.yml": "test:\n  script:\n    - cargo fmt --check\n    - cargo test --all\n",
  });
  const s = await scan(root);
  assert.deepEqual(ids(s.stacks), ["rust"]);
  const cmds = commands(s);
  for (const c of ["just check", "just clippy", "just test", "cargo fmt --check", "cargo test --all"]) assert.ok(cmds.includes(c), c);
  assert.ok(!cmds.includes("just release"));
  assert.ok(cmds.indexOf("cargo fmt --check") < cmds.indexOf("cargo test --all"), "format before tests");
  assert.ok(!cmds.some((c) => FOREIGN.test(c)));
});

test("no manifest at all: no stack, no candidates, docs still found", async () => {
  const root = await repo({ "README.md": "# Notes\n", "notes/a.txt": "x" });
  const s = await scan(root);
  assert.deepEqual(s.stacks, []);
  assert.deepEqual(s.packageManagers, []);
  assert.deepEqual(s.candidates, []);
  assert.deepEqual(s.docs, ["README.md"]);
  assert.deepEqual(s.connectors, []);
});

test("monorepo subprojects, docs, ADRs, agentlint and an existing manifest are reported", async () => {
  const root = await repo({
    "services/api/go.mod": "module api\n",
    "packages/web/package.json": "{}",
    "docs/adr/0001-use-postgres.md": "# Use Postgres\n",
    "GLOSSARY.md": "# Glossary\n",
    "AGENTS.md": "rules\n",
    ".agentlint/config.ts": "export default {}\n",
    ".claude/workflow.json": JSON.stringify({ version: 1, setup: "running", verify: [], connectors: [] }),
    ".gitignore": "node_modules/\n.claude/workflow/\n",
  });
  const s = await scan(root);
  assert.deepEqual(s.subprojects.map((p) => p.path).sort(), ["packages/web", "services/api"]);
  assert.deepEqual(s.adrs, ["docs/adr/0001-use-postgres.md"]);
  assert.equal(s.glossary, true);
  assert.ok(s.agentFiles.includes("AGENTS.md"));
  assert.equal(s.agentlint.config, true);
  assert.equal((s.manifest as { setup: string }).setup, "running");
  assert.equal(s.gitignoreHasWorkflow, true);
});

test("an invalid manifest is reported, not thrown", async () => {
  const root = await repo({ ".claude/workflow.json": "{ nope" });
  const s = await scan(root);
  assert.match((s.manifest as { invalid: string }).invalid, /not valid JSON/);
});

test("git remotes, ticket keys and connectors come from the repo history", async () => {
  const root = await repo({ "README.md": "Tickets live in https://acme.atlassian.net\n" });
  gitInit(root, ["PAY-142 add refunds", "PAY-150: fix totals", "Bump UTF-8 handling and SHA-256", "OPS-7 deploy"], "git@github.com:acme/shop.git");
  const s = await scan(root);
  assert.equal(s.git, true);
  assert.deepEqual(s.remotes, [{ name: "origin", url: "git@github.com:acme/shop.git", host: "github.com", repo: "acme/shop" }]);
  assert.deepEqual(s.ticketKeys.map((k) => [k.prefix, k.count]), [["PAY", 2], ["OPS", 1]]);
  assert.deepEqual(ids(s.connectors).sort(), ["github", "jira"]);
});

test("credentials in a remote URL are not printed", async () => {
  const root = await repo({});
  gitInit(root, [], "https://user:secret@gitlab.example.com/team/app.git");
  const s = await scan(root);
  assert.equal(s.remotes[0]?.url, "https://gitlab.example.com/team/app.git");
  assert.equal(s.remotes[0]?.host, "gitlab.example.com");
  assert.deepEqual(ids(s.connectors), ["gitlab"]);
});

test("with no argument it scans CLAUDE_PROJECT_DIR", async () => {
  const root = await repo({ "go.mod": "module x\n" });
  const { stdout } = await promisify(execFile)(process.execPath, [entry], { env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: root } });
  assert.equal((JSON.parse(stdout) as Scan).root, root);
});
