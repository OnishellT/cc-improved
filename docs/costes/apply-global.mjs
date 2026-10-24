#!/usr/bin/env node
// Installs the global cost controls and the git attribution rule into ~/.claude (docs/costes/README.md). Idempotent;
// --dry-run only prints.
//   1. merges global/settings.fragment.json into settings.json (the original is kept once, as settings.json.pre-cost-controls)
//   2. copies the rule files global/cost-hygiene.md and global/git-attribution.md and imports them from CLAUDE.md
//   3. copies global/issue-implementer.md to agents/
// A missing settings.json is created. A target that is a symlink is written through, not replaced. The rule files and
// agents/issue-implementer.md are overwritten when they differ (they come from this repo); the first copy of a file that
// gets replaced is kept as <file>.pre-cost-controls.
// Run as: node docs/costes/apply-global.mjs [--dry-run] [--home ~/.claude]
// Roll back: restore the *.pre-cost-controls copies that hold your own files (after a later update of this repo's files,
// a copy may hold an earlier install instead: check it), delete the import lines in CLAUDE.md and delete the installed
// files that had no original (the rule files, agents/issue-implementer.md).
import { chmod, copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    home: { type: "string", default: path.join(homedir(), ".claude") },
  },
});
const dryRun = values["dry-run"];
const home = values.home;
const here = path.dirname(fileURLToPath(import.meta.url));
const RULES = ["cost-hygiene.md", "git-attribution.md"]; // rule files that CLAUDE.md imports

const say = (what, state) => console.log(`${dryRun && state !== "unchanged" ? "would " : ""}${state.padEnd(10)} ${what}`);
const read = (file) => readFile(file, "utf8").catch((e) => (e.code === "ENOENT" ? undefined : Promise.reject(e)));

function merge(dst, src) {
  for (const [key, value] of Object.entries(src)) {
    const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
    if (plain(value) && plain(dst[key])) merge(dst[key], value);
    else dst[key] = value;
  }
  return dst;
}

/** Atomic, mode-preserving (settings.json is 0600) and written through a symlink instead of replacing it. */
async function write(file, text, newMode = 0o644) {
  const target = await realpath(file).catch(() => file);
  const tmp = `${target}.${process.pid}.tmp`;
  const old = await stat(target).catch(() => undefined);
  const mode = old ? old.mode & 0o777 : newMode;
  await writeFile(tmp, text, { mode }); // never created wider than the target will be
  await chmod(tmp, mode); // writeFile applies the umask; the target keeps its exact mode
  await rename(tmp, target);
}

/** Keeps the first copy of a file that is about to be replaced, so a roll back can restore it. */
async function keep(file) {
  const backup = `${file}.pre-cost-controls`;
  if (!(await stat(backup).catch(() => undefined))) await copyFile(file, backup);
}

async function install(src, dst) {
  const text = await readFile(src, "utf8");
  const old = await read(dst);
  const state = old === text ? "unchanged" : old === undefined ? "created" : "updated";
  if (state !== "unchanged" && !dryRun) {
    await mkdir(path.dirname(dst), { recursive: true });
    if (old !== undefined) await keep(dst);
    await write(dst, text);
  }
  say(dst, state);
}

// 1. settings.json
const settingsFile = path.join(home, "settings.json");
const original = await read(settingsFile);
const settings = original === undefined ? {} : JSON.parse(original);
const before = JSON.stringify(settings);
const fragment = JSON.parse(await readFile(path.join(here, "global/settings.fragment.json"), "utf8"));
const changed = JSON.stringify(merge(settings, fragment)) !== before;
if (changed && !dryRun) {
  if (original !== undefined) await keep(settingsFile);
  await mkdir(home, { recursive: true });
  await write(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 0o600);
}
say(settingsFile, !changed ? "unchanged" : original === undefined ? "created" : "updated");

// 2. the rule files and their import lines
for (const rule of RULES) await install(path.join(here, "global", rule), path.join(home, rule));
const claudeMd = path.join(home, "CLAUDE.md");
const text = (await read(claudeMd)) ?? "";
const imported = text.split(/\s+/);
const missing = RULES.filter((rule) => !imported.includes(`@${rule}`));
if (missing.length === 0) {
  say(claudeMd, "unchanged");
} else {
  const lines = missing.map((rule) => `@${rule}\n`).join("");
  if (!dryRun) await write(claudeMd, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${lines}`);
  say(claudeMd, "updated");
}

// 3. the implementer agent
await install(path.join(here, "global/issue-implementer.md"), path.join(home, "agents/issue-implementer.md"));
