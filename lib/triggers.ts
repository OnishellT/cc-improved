// Pure detection helpers for the implementation guards: new packages, migrations, scope, agentlint.
import * as path from "node:path";
import type { Plan } from "./types.ts";

/** Paths the workflow itself writes; never subject to the plan scope. */
export const IGNORED = [".claude/", "docs/adr/"];
const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|Cargo\.toml|Gemfile|composer\.json)$/;
const MIGRATION = /(^|\/)(migrations?\/|db\/migrate\/|alembic\/versions\/)|(^|\/)schema\.prisma$|\.sql$/;
const INSTALLERS = /^(?:sudo\s+)?(?:(?:npm|pnpm|yarn|bun)\s+(?:add|install|i)|(?:python3?\s+-m\s+)?pip3?\s+install|uv\s+(?:pip\s+install|add)|poetry\s+add|go\s+get|cargo\s+add|gem\s+install|composer\s+require)\s+(.+)$/;

export const toRelative = (cwd: string, p: string) => path.relative(cwd, path.resolve(cwd, p)).split(path.sep).join("/");
export const isMigration = (p: string) => MIGRATION.test(p);
export const isManifest = (p: string) => MANIFEST.test(p);

/** Package names a shell command installs; bare installs and `-r`/`-e` installs yield none. */
export function installersIn(command: string): string[] {
  const names: string[] = [];
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const args = INSTALLERS.exec(segment.trim())?.[1]?.split(/\s+/);
    if (!args || args.some((a) => /^(-r|-e|--requirement|--editable)$/.test(a))) continue;
    for (const a of args) {
      if (!a || a.startsWith("-") || /^[./~]/.test(a) || a.includes("=") && !/[<>~!]=/.test(a) && !a.includes("==")) continue;
      names.push(a.replace(/^(@?[^@=<>~!\[]+).*$/, "$1"));
    }
  }
  return [...new Set(names)];
}

const quoted = (line: string) => [...line.matchAll(/["']([A-Za-z0-9_.-]+)[^"']*["']/g)].map((m) => m[1]!.toLowerCase());

function tomlNames(content: string, python: boolean) {
  const names = new Set<string>();
  let section = "";
  let inArray = false;
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const header = /^\[+([^\]]+)\]+$/.exec(line);
    if (header) {
      section = header[1]!.trim();
      inArray = false;
      const sub = /dependencies\.([\w.-]+)$/.exec(section);
      if (sub) names.add(sub[1]!);
      continue;
    }
    const depSection = /(^|[.-])dependencies$/.test(section) || section === "dependency-groups";
    if (inArray || (python && /^(dependencies|[\w.-]+)\s*=\s*\[/.test(line) && (depSection || /^dependencies\s*=/.test(line)))) {
      quoted(line.replace(/^[\w.-]+\s*=\s*/, "")).forEach((n) => names.add(n));
      inArray = !line.includes("]");
    } else if (depSection) {
      const key = /^([\w.-]+)\s*=/.exec(line)?.[1];
      if (key && key !== "python") names.add(key);
    }
  }
  return names;
}

/** Dependency names declared in a manifest, or undefined when it can't be parsed. */
export function dependencyNames(file: string, content: string): Set<string> | undefined {
  const base = path.posix.basename(file);
  if (base === "package.json") {
    try {
      const json = JSON.parse(content || "{}");
      return new Set(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((k) => Object.keys(json[k] ?? {})));
    } catch {
      return undefined;
    }
  }
  if (base.endsWith(".txt")) return new Set(content.split("\n").map((l) => /^([A-Za-z0-9_.-]+)/.exec(l.trim())?.[1]?.toLowerCase()).filter(Boolean) as string[]);
  if (base === "go.mod") return new Set([...content.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/[^\s]+)\s+v[\w.+-]+/gm)].map((m) => m[1]!));
  if (base === "Cargo.toml") return tomlNames(content, false);
  if (base === "pyproject.toml") return tomlNames(content, true);
}

/** Applies edit-tool entries to the original text; undefined if any oldText is not unique. */
export function applyEdits(original: string, edits: { oldText: string; newText: string }[]) {
  let result = original;
  for (const { oldText, newText } of edits) {
    if (!oldText || original.split(oldText).length !== 2) return undefined;
    result = result.replace(oldText, () => newText);
  }
  return result;
}

/** Names present in `after` and missing from `before`; undefined when either side could not be parsed. */
export function newDependencies(before: Set<string> | undefined, after: Set<string> | undefined): string[] | undefined {
  if (!before || !after) return undefined;
  return [...after].filter((n) => !before.has(n));
}

/** True when `file` is in the plan or was allowed later. Entries ending in `/` cover a directory. */
export function inScope(plan: Pick<Plan, "files"> | undefined, file: string, allowedExtra: string[] = []): boolean {
  return [...(plan?.files ?? []), ...allowedExtra].some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));
}

// The `review` subcommand right after the binary (optionally after `--`), or the UI flags anywhere.
const INTERACTIVE_AGENTLINT = /\bagentlint(?:\s+--)?\s+review\b|\bagentlint\b[^;&|\n]*\s--(?:review|wizard)\b/;
/** Recording an exception to a rule is a decision for the user. */
const AGENTLINT_ACCEPT = /\bagentlint(?:\s+--)?\s+(?:accept|approve)\b/;

/** agentlint commands that open a browser UI and wait for a person. */
export const isInteractiveAgentlint = (command: string) => INTERACTIVE_AGENTLINT.test(command);
/** agentlint commands that record an exception. */
export const isAgentlintAccept = (command: string) => AGENTLINT_ACCEPT.test(command);
