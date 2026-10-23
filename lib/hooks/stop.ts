// Stop gate of the orchestrator while the task is `implementing`: interface contract and the manifest's verify again
// (defense in depth after the implementer), then risk gating of the paid diff review. One review round per task;
// the fixes it asks for are checked by verify, not by a second review. When everything passes the turn ends with a
// summary for the person.
import { checkContract, formatContract } from "../contract.ts";
import { assessRisk } from "../risk.ts";
import type { AgentGateState, Manifest, SessionState, StopInput, StopOutput } from "../types.ts";
import type { HookContext, HookModule } from "./dispatch.ts";
import {
  DIAGNOSE_AT,
  DIAGNOSE_METHOD,
  fingerprint,
  loadGateState,
  MAX_RETRIES,
  MAX_REVIEWS,
  POLICY_NOTE,
  readManifest,
  RELEASE_AFTER,
  store,
  strongAgent,
  subagentRunning,
  verify,
} from "./gate.ts";

type Level = "fix" | "diagnose" | "escalate" | "person";

const ran = (s: SessionState, r: string) => Object.values(s.agents ?? {}).filter((a: AgentGateState) => a.role === r);

async function gate(input: StopInput, ctx: HookContext, manifest: Manifest): Promise<StopOutput | undefined> {
  const task = ctx.task!;
  const s = await loadGateState(ctx, input);

  const blockWith = async (kind: string, reason: string): Promise<StopOutput> => {
    s.retries++;
    s.lastBlock = kind;
    await store(ctx, s);
    return { decision: "block", reason };
  };
  const letOut = async (message: string): Promise<StopOutput> => {
    const repeat = s.lastBlock === "released";
    s.lastBlock = "released";
    await store(ctx, s);
    return repeat ? {} : { systemMessage: message };
  };

  if (s.retries >= MAX_RETRIES) return letOut(`cc-improved: el gate dejó terminar tras ${s.retries} reintentos en este mensaje; revisa el estado de la tarea "${task.title}".`);

  if (task.plan) {
    const problems = await checkContract(ctx.root, task.plan);
    if (problems.length) {
      return blockWith("contract", `${formatContract(problems)}\n\nExpose exactly these names in these files, as the plan's interface says (relaunch the implementer with this report if it wrote them), then finish.`);
    }
  }

  const print = await fingerprint(ctx.root);
  const cached = print !== "" && print === s.verifiedFingerprint;
  if (!cached && manifest.verify.length) {
    const result = await verify(ctx, manifest.verify);
    if (!result.ok) {
      s.verifiedFingerprint = undefined;
      return verifyFailed(ctx, s, result.report, result.policy, blockWith, letOut);
    }
  }
  s.failures = 0;
  s.verifiedFingerprint = print || undefined;

  // Risk gating: one review per task, paid only when the diff is risky.
  let reviewNote: string;
  if (s.reviewVerdict || s.reviews >= MAX_REVIEWS) {
    reviewNote = s.reviewVerdict === "FIX" ? "revisión: FIX (hallazgos aplicados, comprobados por verify; sin segunda ronda)" : `revisión: ${s.reviewVerdict ?? "hecha"}`;
  } else {
    const risk = await assessRisk(ctx.root, task, manifest);
    if (risk.review && s.lastBlock !== "review") {
      return blockWith(
        "review",
        [
          `The diff needs a review before this task can finish (risk: ${risk.reasons.join("; ")}).`,
          `Launch the ${strongAgent("reviewer", ctx.env)} agent in the foreground (run_in_background: false) with the review brief: the plan (files, interface, seams, decisions), the full diff from \`git diff HEAD\` and every new file in full.`,
          "Then fix each blocking finding it lists after `VERDICT: FIX` and finish. There is one review round: your fixes are checked by verify, not by a second review.",
        ].join("\n"),
      );
    }
    if (risk.review) reviewNote = "revisión pedida y no hecha";
    else {
      s.reviews++;
      reviewNote = `revisión omitida (bajo riesgo${risk.reasons.length ? `: ${risk.reasons.join("; ")}` : ""})`;
    }
  }

  const fresh = !cached || s.lastBlock !== undefined;
  s.lastBlock = undefined;
  await store(ctx, s);
  if (!fresh) return undefined;
  const verified = manifest.verify.length ? `verify OK (${manifest.verify.length} pasos)` : "sin pasos de verify en el manifest";
  const contract = task.plan?.interface.length ? "contrato de interfaz OK" : "sin contrato de interfaz";
  return { systemMessage: `cc-improved: "${task.title}": ${contract}; ${verified}; ${reviewNote}. Comprueba el resultado y cierra con /done.` };
}

async function verifyFailed(
  ctx: HookContext,
  s: SessionState,
  report: string,
  policy: boolean,
  blockWith: (kind: string, reason: string) => Promise<StopOutput>,
  letOut: (message: string) => Promise<StopOutput>,
): Promise<StopOutput> {
  if (!policy) s.failures++;
  const fixerFailed = ran(s, "fixer").some((a) => a.outcome === "failed");
  const implementerFailed = ran(s, "implementer").some((a) => a.outcome === "failed");

  // Order: fix → diagnose → stronger model (fixer) → the person. At most 3 verify blocks per prompt.
  let level: Level;
  if (policy) level = s.lastBlock === "policy" ? "person" : "fix";
  else if (fixerFailed || s.lastBlock === "escalate" || s.failures > RELEASE_AFTER) level = "person";
  else if (implementerFailed || s.failures === RELEASE_AFTER) level = "escalate";
  else if (s.failures === DIAGNOSE_AT) level = "diagnose";
  else level = "fix";

  switch (level) {
    case "fix":
      return policy
        ? blockWith("policy", `${report}\n\n${POLICY_NOTE}`)
        : blockWith("fix", `${report}\n\nVerification fails. Fix the cause (yourself, or by relaunching the implementer with this report), then finish.`);
    case "diagnose":
      return blockWith("diagnose", `${report}\n\nVerification failed ${s.failures} times in a row.\n${DIAGNOSE_METHOD}\n\nThen finish.`);
    case "escalate":
      return blockWith(
        "escalate",
        `${report}\n\nVerification still fails after the implementer's attempts. Launch the ${strongAgent("fixer", ctx.env)} agent in the foreground (run_in_background: false) with the implementer's brief (plan, interface, seams, ADRs, verification commands) plus this report and what was tried. Do not fix it yourself. Then finish.`,
      );
    case "person":
      return letOut(
        policy
          ? "cc-improved: una regla de agentlint sigue fallando y necesita tu decisión (arreglo o excepción). Ejecuta /verify para ver el informe."
          : "cc-improved: verify sigue fallando tras arreglar, diagnosticar y escalar al fixer. Decide tú cómo seguir; /verify muestra el informe.",
      );
  }
}

export default {
  async Stop(input, ctx) {
    if (ctx.task?.status !== "implementing") return undefined;
    // The implementer may be running in the background: the work is not finished, so there is nothing to gate yet.
    if (subagentRunning(input.background_tasks)) return undefined;
    const manifest = await readManifest(ctx.root);
    if (manifest?.setup !== "done") return undefined;
    return gate(input, ctx, manifest);
  },
} satisfies HookModule;
