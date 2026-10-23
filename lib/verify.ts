// Runs the manifest's verify commands. Nothing here knows any language or tool: commands come from the manifest.
import { spawn } from "node:child_process";

export interface VerifyOptions {
  /** Per-step timeout; the whole process group is killed. Default 10 minutes. */
  timeoutMs?: number;
  /** Max characters of output kept per step (the tail). Default 4000. */
  maxReport?: number;
}

export interface StepResult {
  step: string;
  ok: boolean;
  /** Exit code; null when the step was killed by timeout or could not start. */
  code: number | null;
  timedOut: boolean;
  /** Tail of stdout+stderr, bounded by `maxReport`. */
  output: string;
  /** The step is an agentlint gate: it needs a fix or a recorded decision, not a smarter model. */
  policy: boolean;
}

export interface VerifyResult {
  ok: boolean;
  results: StepResult[];
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_REPORT = 4000;
const POLICY = /\bagentlint\b|gate closed|unresolved findings/i;

const tail = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text);

interface Run {
  code: number | null;
  timedOut: boolean;
  output: string;
}

// The step runs through `sh -c` because a manifest step is a shell command line; it is passed as one argument, untouched.
function runStep(step: string, cwd: string, timeoutMs: number, keep: number): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", step], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    let settled = false;
    // Only the tail is retained, so chatty commands cannot exhaust memory.
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > keep * 2) output = output.slice(-keep * 2);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, timedOut, output });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (err) => {
      output += `\n${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/** Runs verify steps in order from `cwd` and stops at the first failure. */
export async function runVerify(steps: string[], cwd: string, options: VerifyOptions = {}): Promise<VerifyResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxReport = options.maxReport ?? DEFAULT_MAX_REPORT;
  const results: StepResult[] = [];
  for (const step of steps) {
    const run = await runStep(step, cwd, timeoutMs, maxReport);
    const ok = run.code === 0 && !run.timedOut;
    const output = tail(run.output.trim(), maxReport);
    results.push({ step, ok, code: run.code, timedOut: run.timedOut, output, policy: !ok && POLICY.test(`${step}\n${output}`) });
    if (!ok) break;
  }
  return { ok: results.length === steps.length && results.every((r) => r.ok), results };
}

/** True when the failing step is an agentlint gate. */
export const isPolicyFailure = ({ results }: VerifyResult) => results.some((r) => r.policy);

export function formatVerify({ ok, results }: VerifyResult): string {
  const lines = results.map((r) => `${r.ok ? "✓" : "✗"} ${r.step}`);
  const failed = results.find((r) => !r.ok);
  const detail = failed ? ["", failed.timedOut ? `timed out: ${failed.step}` : `exit code ${failed.code}: ${failed.step}`, failed.output] : [];
  return [ok ? "verify passed" : "verify FAILED", ...lines, ...detail].join("\n");
}
