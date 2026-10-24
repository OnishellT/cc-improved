#!/usr/bin/env node
// Installs the global cost controls into ~/.claude (docs/costes/README.md). Idempotent; --dry-run only prints.
//   1. merges global/settings.fragment.json into settings.json (the original is kept once, as settings.json.pre-cost-controls)
//   2. copies global/cost-hygiene.md and imports it from CLAUDE.md
//   3. copies global/issue-implementer.md to agents/
// Run as: node docs/costes/apply-global.mjs [--dry-run] [--home ~/.claude]
// Roll back: restore settings.json.pre-cost-controls, delete the import line in CLAUDE.md, cost-hygiene.md and
// agents/issue-implementer.md.
import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
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

/** Atomic and mode-preserving: the settings file is 0600. */
async function write(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  const old = await stat(file).catch(() => undefined);
  if (old) await chmod(tmp, old.mode & 0o777);
  await rename(tmp, file);
}

async function install(src, dst) {
  const text = await readFile(src, "utf8");
  const old = await read(dst);
  const state = old === text ? "unchanged" : old === undefined ? "created" : "updated";
  if (state !== "unchanged" && !dryRun) {
    await mkdir(path.dirname(dst), { recursive: true });
    await write(dst, text);
  }
  say(dst, state);
}

// 1. settings.json
const settingsFile = path.join(home, "settings.json");
const settings = JSON.parse(await readFile(settingsFile, "utf8"));
const before = JSON.stringify(settings);
const fragment = JSON.parse(await readFile(path.join(here, "global/settings.fragment.json"), "utf8"));
const changed = JSON.stringify(merge(settings, fragment)) !== before;
if (changed && !dryRun) {
  const backup = `${settingsFile}.pre-cost-controls`;
  if (!(await stat(backup).catch(() => undefined))) await copyFile(settingsFile, backup);
  await write(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
}
say(settingsFile, changed ? "updated" : "unchanged");

// 2. hygiene rules and the import line
await install(path.join(here, "global/cost-hygiene.md"), path.join(home, "cost-hygiene.md"));
const claudeMd = path.join(home, "CLAUDE.md");
const text = (await read(claudeMd)) ?? "";
if (text.split(/\s+/).includes("@cost-hygiene.md")) {
  say(claudeMd, "unchanged");
} else {
  if (!dryRun) await write(claudeMd, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}@cost-hygiene.md\n`);
  say(claudeMd, "updated");
}

// 3. the implementer agent
await install(path.join(here, "global/issue-implementer.md"), path.join(home, "agents/issue-implementer.md"));
