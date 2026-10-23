#!/usr/bin/env node
// Lab hook for spike 0.7: appends the raw stdin JSON of every hook call to $SPIKE_LOG
// (one line per call) together with the event label passed as argv[2]. Never fails, prints nothing.
import { appendFileSync, readFileSync } from 'node:fs';

const label = process.argv[2] ?? 'unknown';
const log = process.env.SPIKE_LOG;
try {
  const raw = readFileSync(0, 'utf8');
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    input = { unparsed: raw };
  }
  if (log) appendFileSync(log, `${JSON.stringify({ label, stdinBytes: Buffer.byteLength(raw), input })}\n`);
} catch {
  // a lab hook must never break the session
}
process.exit(0);
