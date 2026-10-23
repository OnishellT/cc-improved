// Stop while `/setup` is running: a cheap model often stops halfway through the setup steps. Push it back to them
// at most twice per user prompt; after that the turn ends and the person decides. Registered before stop.ts.
import type { HookModule } from "./dispatch.ts";
import { loadGateState, readManifest, store, subagentRunning } from "./gate.ts";

/** Pushes per user prompt. */
export const MAX_NUDGES = 2;

export const NUDGE =
  "Setup is not finished: `.claude/workflow.json` still says `setup: running`. If you need a decision from the user, ask it with AskUserQuestion. Otherwise continue with the next step of the /setup skill and finish by running its final check (`wf-setup-finish.mjs`), which marks the setup as done.";

export default {
  async Stop(input, ctx) {
    if (subagentRunning(input.background_tasks)) return undefined;
    if ((await readManifest(ctx.root))?.setup !== "running") return undefined;
    const s = await loadGateState(ctx, input);
    const nudges = s.setupNudges ?? 0;
    if (nudges >= MAX_NUDGES) return undefined;
    s.setupNudges = nudges + 1;
    await store(ctx, s);
    return { decision: "block", reason: NUDGE };
  },
} satisfies HookModule;
