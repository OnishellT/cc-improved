#!/usr/bin/env node
// Estimates what the local Claude Code transcripts cost at API list price, and where it goes, so two periods can be
// compared (docs/costes/README.md). It is not an invoice: subscription limits are not published.
// Run as: node docs/costes/usage-report.mjs [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--root ~/.claude/projects]
// Reads every transcript under --root (main sessions and their subagents) and counts each assistant message once.
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";

// Effective $/MTok: input, output, cache read, cache write. Fitted to the `costUSD` of the transcripts' own
// `cost-state` lines (R^2 ~ 1.0 for sonnet, opus and fable). Update them when prices change.
const RATES = {
  "claude-sonnet-5-5": [2, 10, 0.117, 2.246],
  "claude-opus-5-5": [4, 20, 0.199, 7.695],
  "claude-fable-5-1": [10, 50, 0.27, 17.84],
  "claude-haiku-5-5": [0.1, 0.5, 0.02, 0.13],
};
const COLD_GAP_MS = 5 * 60 * 1000; // a subagent's prompt cache lives 5 minutes

const { values } = parseArgs({
  options: {
    since: { type: "string", default: "0000-00-00" },
    until: { type: "string", default: "9999-99-99" },
    root: { type: "string", default: path.join(homedir(), ".claude", "projects") },
  },
});

const num = (n) => (typeof n === "number" ? n : 0);

async function transcripts(root) {
  const entries = await readdir(root, { recursive: true });
  return entries.filter((e) => e.endsWith(".jsonl")).map((e) => path.join(root, e));
}

/** Each message once (a message can span several lines: keep the largest counts), plus agent id -> subagent type. */
async function scan(root) {
  const messages = new Map();
  const skipped = new Map(); // model with no rate -> ids of its messages in the window
  const agentCalls = new Map();
  const agentType = new Map();
  for (const file of (await transcripts(root)).sort()) {
    const sub = file.includes(`${path.sep}subagents${path.sep}`);
    for (const line of (await readFile(file, "utf8")).split("\n")) {
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const content = d?.message?.content;
      if (d?.type === "assistant") {
        for (const b of Array.isArray(content) ? content : []) {
          if (b?.type === "tool_use" && b.name === "Agent") agentCalls.set(b.id, b.input?.subagent_type ?? "general-purpose");
        }
        const u = d.message.usage;
        const model = d.message.model;
        if (!u || typeof d.timestamp !== "string") continue;
        const key = d.message.id ?? d.uuid;
        if (!(model in RATES)) {
          // Left out of the total, so say so: a new model must not make the total silently low. `<synthetic>` is no model.
          const day = d.timestamp.slice(0, 10);
          if (typeof model === "string" && !model.startsWith("<") && day >= values.since && day <= values.until) {
            skipped.set(model, (skipped.get(model) ?? new Set()).add(key));
          }
          continue;
        }
        const r = messages.get(key) ?? { ts: d.timestamp, model, sub, file, inp: 0, out: 0, cr: 0, cw: 0, think: 0 };
        r.inp = Math.max(r.inp, num(u.input_tokens));
        r.out = Math.max(r.out, num(u.output_tokens));
        r.cr = Math.max(r.cr, num(u.cache_read_input_tokens));
        r.cw = Math.max(r.cw, num(u.cache_creation_input_tokens));
        r.think = Math.max(r.think, num(u.output_tokens_details?.thinking_tokens));
        messages.set(key, r);
      } else if (d?.type === "user" && Array.isArray(content)) {
        for (const b of content) {
          if (b?.type !== "tool_result" || !agentCalls.has(b.tool_use_id)) continue;
          const text = Array.isArray(b.content) ? b.content.map((x) => x?.text ?? "").join("") : String(b.content);
          const id = /agentId: (\w+)/.exec(text)?.[1];
          if (id) agentType.set(id, agentCalls.get(b.tool_use_id));
        }
      }
    }
  }
  return { messages: [...messages.values()], agentType, skipped };
}

const usd = (n, width = 9) => `$${n.toFixed(2).padStart(width)}`;

function group(rows, keyOf) {
  const g = new Map();
  for (const m of rows) {
    const k = keyOf(m);
    const [n, c] = g.get(k) ?? [0, 0];
    g.set(k, [n + 1, c + m.cost]);
  }
  return [...g].sort((a, b) => b[1][1] - a[1][1]);
}

const { messages, agentType, skipped } = await scan(values.root);
const rows = messages
  .filter((m) => m.ts.slice(0, 10) >= values.since && m.ts.slice(0, 10) <= values.until)
  .sort((a, b) => (a.file === b.file ? a.ts.localeCompare(b.ts) : a.file.localeCompare(b.file)));
for (const m of rows) {
  const [i, o, cr, cw] = RATES[m.model];
  m.ctx = m.inp + m.cr + m.cw;
  m.cost = (m.inp * i + m.out * o + m.cr * cr + m.cw * cw) / 1e6;
}
const sum = rows.reduce((s, m) => s + m.cost, 0);
const total = sum || 1; // the divisor for the percentages
const pct = (c) => `${((c / total) * 100).toFixed(1).padStart(5)}%`;
const out = [];
const table = (title, groups, limit = 10) => {
  out.push("", `== ${title} ==`);
  for (const [k, [n, c]] of groups.slice(0, limit)) out.push(`  ${usd(c)} ${pct(c)}  turns=${String(n).padStart(5)}  ${k}`);
};

out.push(`${rows.length} assistant turns from ${values.since} to ${values.until}: estimated $${sum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} at list price`);
table("by day (UTC)", group(rows, (m) => m.ts.slice(0, 10)).sort((a, b) => (a[0] < b[0] ? -1 : 1)), Infinity);
table("by model, main vs subagent", group(rows, (m) => `${m.model.replace("claude-", "")} ${m.sub ? "sub" : "main"}`));

out.push("", "== by context size of the turn ==");
for (const [lo, hi] of [[0, 50e3], [50e3, 100e3], [100e3, 200e3], [200e3, 400e3], [400e3, 2e6]]) {
  const sel = rows.filter((m) => m.ctx >= lo && m.ctx < hi);
  const c = sel.reduce((s, m) => s + m.cost, 0);
  out.push(`  ${String(lo / 1e3).padStart(4)}-${String(hi / 1e3).padStart(4)}K: ${usd(c)} ${pct(c)}  turns=${sel.length}`);
}

// Cold-cache rebuild: a turn that re-writes most of its context after 5+ idle minutes. The premium is what writing cost
// over reading the same tokens from a warm cache.
const premium = { main: 0, sub: 0 };
const events = { main: 0, sub: 0 };
for (let i = 1; i < rows.length; i++) {
  const prev = rows[i - 1];
  const m = rows[i];
  if (m.file !== prev.file || m.ctx <= 30000 || m.cw <= 0.5 * m.ctx) continue;
  if (Date.parse(m.ts) - Date.parse(prev.ts) < COLD_GAP_MS) continue;
  const who = m.sub ? "sub" : "main";
  premium[who] += (m.cw * (RATES[m.model][3] - RATES[m.model][2])) / 1e6;
  events[who]++;
}
out.push("", "== cold-cache rebuilds after 5+ idle minutes (premium over a warm read) ==");
for (const who of ["main", "sub"]) out.push(`  ${who.padEnd(4)}: ${usd(premium[who])}  events=${events[who]}`);

// Subagents by type.
const agentCost = new Map();
for (const m of rows) {
  if (!m.sub) continue;
  const id = path.basename(m.file).replace(/^agent-/, "").replace(/\.jsonl$/, "");
  agentCost.set(id, (agentCost.get(id) ?? 0) + m.cost);
}
const byType = new Map();
for (const [id, c] of agentCost) {
  const type = agentType.get(id) ?? "unknown";
  const [n, s] = byType.get(type) ?? [0, 0];
  byType.set(type, [n + 1, s + c]);
}
const subTotal = [...agentCost.values()].reduce((s, c) => s + c, 0);
out.push("", `== subagents: ${agentCost.size} agents, $${subTotal.toFixed(2)} (${((subTotal / total) * 100).toFixed(0)}% of total) ==`);
for (const [type, [n, c]] of [...byType].sort((a, b) => b[1][1] - a[1][1]).slice(0, 6)) {
  out.push(`  ${usd(c)}  agents=${String(n).padStart(4)}  avg=$${(c / n).toFixed(2)}  ${type}`);
}
if (agentCost.size) {
  const sorted = [...agentCost.values()].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  out.push(`  median agent $${median.toFixed(2)}, most expensive $${sorted[sorted.length - 1].toFixed(2)}`);
}

const outTokens = rows.reduce((s, m) => s + m.out, 0);
const thinking = rows.reduce((s, m) => s + m.think, 0);
out.push("", `thinking tokens: ${(thinking / 1e6).toFixed(2)}M of ${(outTokens / 1e6).toFixed(2)}M output (${((thinking / Math.max(outTokens, 1)) * 100).toFixed(0)}%)`);
if (skipped.size) {
  const list = [...skipped].map(([model, ids]) => `${model} (${ids.size} turns)`).join(", ");
  out.push("", `warning: no rate for ${list}; those turns are left out, so the total is a lower bound`);
}
console.log(out.join("\n"));
