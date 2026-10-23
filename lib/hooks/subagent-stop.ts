// SubagentStop gate.
// implementer / fixer: interface contract, then the manifest's verify. Ladder per agent_id: 1st failure → fix,
// 2nd → fix with the diagnosis method, 3rd → let it out with FAILED so the orchestrator escalates (implementer →
// fixer, fixer → the person). reviewer / plan-check: store the `VERDICT:` of the final answer.
// `stop_hook_active` is true on every continuation (spike 0.3), so the counts live in the session state instead.
import { checkContract, formatContract } from "../contract.ts";
import type { AgentGateState, SessionState, StopOutput, SubagentStopInput } from "../types.ts";
import type { HookContext, HookModule } from "./dispatch.ts";
import { recordPlanCheckVerdict } from "./exit-plan-mode.ts";
import {
  DIAGNOSE_AT,
  DIAGNOSE_METHOD,
  loadGateState,
  MAX_CONTRACT_BLOCKS,
  parseVerdict,
  POLICY_NOTE,
  readManifest,
  RELEASE_AFTER,
  role,
  store,
  strongAgent,
  endsBlocked,
  verify,
} from "./gate.ts";

const block = (reason: string): StopOutput => ({ decision: "block", reason });

async function implementerGate(input: SubagentStopInput, ctx: HookContext, name: string): Promise<StopOutput | undefined> {
  const task = ctx.task;
  if (task?.status !== "implementing") return undefined;
  const manifest = await readManifest(ctx.root);
  if (manifest && manifest.setup !== "done") return undefined;
  // The agent asks for a decision only the person can take: let it out, the orchestrator asks.
  if (endsBlocked(input.last_assistant_message)) return undefined;

  const s = await loadGateState(ctx, input);
  const agents = { ...(s.agents ?? {}) };
  const gate: AgentGateState = agents[input.agent_id] ?? { role: name, contractBlocks: 0, failures: 0, policyBlocks: 0 };
  agents[input.agent_id] = gate;
  s.agents = agents;
  // Already let out as failed: a stray stop after the release must not start the ladder again.
  if (gate.outcome === "failed") return undefined;

  // Escalation order: fix → diagnose → stronger model (fixer) → the person.
  const next = name === "fixer" ? "the orchestrator asks the person how to continue" : `the orchestrator escalates to ${strongAgent("fixer", ctx.env)}`;
  const release = async (what: string): Promise<StopOutput> => {
    gate.outcome = "failed";
    await store(ctx, s);
    const then = name === "fixer" ? "el orquestador te preguntará cómo seguir" : "el orquestador escala al fixer";
    return { systemMessage: `cc-improved: ${name} sale con FAILED (${what}); ${then}.` };
  };

  if (task.plan) {
    const problems = await checkContract(ctx.root, task.plan);
    if (problems.length) {
      if (gate.contractBlocks >= MAX_CONTRACT_BLOCKS) return release("el contrato de interfaz sigue sin cumplirse");
      gate.contractBlocks++;
      await store(ctx, s);
      return block(`${formatContract(problems)}\n\nExpose exactly these names in these files, as the plan's interface says, then stop again. A gate checks this every time you stop.`);
    }
  }

  const steps = manifest?.verify ?? [];
  if (!steps.length) return pass(ctx, s, gate);
  const result = await verify(ctx, steps);
  if (result.ok) return pass(ctx, s, gate);

  if (result.policy) {
    if (gate.policyBlocks >= 1) return release("una regla de agentlint necesita tu decisión");
    gate.policyBlocks++;
    await store(ctx, s);
    return block(`${result.report}\n\n${POLICY_NOTE}`);
  }

  gate.failures++;
  if (gate.failures >= RELEASE_AFTER) return release(`verify falló ${gate.failures} veces seguidas`);
  await store(ctx, s);
  if (gate.failures === DIAGNOSE_AT) {
    return block(
      [
        result.report,
        "",
        `Verification failed ${gate.failures} times in a row.`,
        DIAGNOSE_METHOD,
        "",
        "Before you stop, run the verification commands yourself. If they still fail, end your answer with `FAILED: <what still fails, the cause as far as you got, and what you tried>` instead of DONE: the gate will let you out and " +
          `${next}.`,
      ].join("\n"),
    );
  }
  return block(`${result.report}\n\nFix the cause of this failure, run the verification commands again, then stop. A gate runs them every time you stop.`);
}

async function pass(ctx: HookContext, s: SessionState, gate: AgentGateState): Promise<undefined> {
  gate.failures = 0;
  gate.outcome = "passed";
  await store(ctx, s);
  return undefined;
}

async function verdictGate(input: SubagentStopInput, ctx: HookContext, name: "reviewer" | "plan-check"): Promise<StopOutput | undefined> {
  if ((await readManifest(ctx.root))?.setup !== "done") return undefined;
  const s = await loadGateState(ctx, input);
  const verdict = parseVerdict(input.last_assistant_message);
  if (name === "reviewer") {
    s.reviews++;
    s.reviewVerdict = verdict;
  } else {
    s.planChecks++;
    s.planVerdict = verdict;
    // The ExitPlanMode gate reads its own copy of the verdict; it parses the same answer.
    await recordPlanCheckVerdict(input, ctx);
  }
  await store(ctx, s);
  const label = name === "reviewer" ? "revisión del diff" : "chequeo del plan";
  return { systemMessage: `cc-improved: ${label}: ${verdict ?? "sin línea VERDICT"}.` };
}

export default {
  async SubagentStop(input, ctx) {
    const name = role(input.agent_type);
    if (name === "implementer" || name === "fixer") return implementerGate(input, ctx, name);
    if (name === "reviewer" || name === "plan-check") return verdictGate(input, ctx, name);
    return undefined;
  },
} satisfies HookModule;
