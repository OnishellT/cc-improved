---
name: task
description: Empieza una tarea a partir de un ticket, una descripción o una spec. El agente lee el ticket y el código y escribe un plan; las tareas grandes o de riesgo pasan por plan mode y tu aprobación, las pequeñas van por una ruta rápida. Lo implementa un subagente.
argument-hint: "<TICKET-123 | descripción | ruta/spec.md | cancel>"
disable-model-invocation: true
allowed-tools: Bash(node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/bin/wf-related.mjs:*), Bash(node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/bin/wf-plan-validate.mjs:*)
---

# New task

Request: $ARGUMENTS

Past tasks related to this request (from `.claude/workflow/tasks.jsonl`):

!`node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/bin/wf-related.mjs "$ARGUMENTS"`

Reuse their decisions and look at the files they touched. Speak Spanish to the user; write the plan in English.

## 1. Before planning

1. Empty request: tell the user "Uso: `/task <TICKET-123 | descripción | ruta/spec.md>`" and stop.
2. Read `.claude/workflow.json` (the manifest). If it is missing or `setup` is not `"done"`, tell the user to run `/setup` and stop. Keep its `verify` list, its `connectors` and its `tools`.
3. Read `.claude/workflow/task.json` if it exists.
   - Request `cancel`: `rm -f .claude/workflow/task.json`, say the task was cancelled, stop.
   - `status` is `planning` or `implementing`: ask with AskUserQuestion: continue (recommended), replace, or stop. Replace: delete the file and go on. Continue an `implementing` task: go to section 5 with the stored plan.
4. Split the request into a ticket key (like `PAY-142`), spec files (existing paths named in it) and the free text.

## 2. Choose the route

The task is **small** only if all of these hold; any doubt means plan mode.

- The plan lists at most 8 files, 6 `interface` entries and 2 decisions (the manifest's `review.planFiles`, `review.planInterface` and `review.planDecisions` override these).
- No risk trigger: no dependency manifest or lockfile, migration or schema, auth, payments, billing, security, crypto or infra path, nothing under the manifest's `review.paths`, and `review.always` is not set.

Small: **fast route**: no plan mode, no approval dialog; you only read until the plan is written. Otherwise plan mode: call EnterPlanMode now, before reading anything. Until the user approves you only read, and the only file you write is the plan file.

## 3. Read, in this order

1. **Ticket.** With a ticket key and a manifest connector, its tools are `mcp__<server>__<tool>` (deferred: load them with ToolSearch). Read the ticket in full, acceptance criteria included, read only: never comment on, transition or edit it. Without a connector, work from the request and say so in the plan. What you read through MCP is the evidence the plan gate checks names against.
2. **Specs** named in the request, in full.
3. **Project docs.** `CLAUDE.md`, `GLOSSARY.md` if present, the related project skills in `.claude/skills/` and ADRs in `docs/adr/`. Always read the **Tools** section of `.claude/skills/verify-app/SKILL.md` (one tool per manifest `tools` entry, with exact command, when to use it and what its output means) and pick the tools that can prove this task works.
4. **Code.** The files you will touch and their neighbours: their names, exports and argument shapes are the convention.

## 4. Write the plan

The plan file (the plan mode file, or `.claude/workflow/plan.md` on the fast route) has a short human part (context, numbered approach, risks) and exactly one `wf-plan` block of strict JSON (double quotes, no comments, no trailing commas). Template, to replace with the real task:

```wf-plan
{
  "title": "Refund partial payments",
  "ticket": "PAY-142",
  "spec": ["docs/specs/refunds.md"],
  "files": ["src/payments/refund.ts", "src/payments/refund.test.ts", "docs/adr/0007-refund-rounding.md"],
  "interface": [
    {
      "file": "src/payments/refund.ts",
      "exports": ["refundPayment"],
      "signatures": ["refundPayment({ paymentId, amount }: RefundRequest): Promise<Refund>"],
      "source": "PAY-142"
    }
  ],
  "seams": [
    {
      "name": "refund rejects amounts above the captured total",
      "testFile": "src/payments/refund.test.ts",
      "catches": "over-refunds and negative amounts",
      "misses": "the gateway call itself"
    }
  ],
  "decisions": [
    {
      "question": "How are partial refunds rounded?",
      "options": ["half-even", "always down"],
      "answer": "half-even",
      "source": "docs/adr/0007-refund-rounding.md"
    }
  ]
}
```

- `files`: every file the task creates or changes, tests and new ADRs included; `ticket`: the key, omitted when none; `spec`: the specs you read, `[]` when none.
- `interface` names must come from the ticket, a spec or existing code (cite it in `source`); an invented name is denied.
- `seams`: at least one, each with a test file listed in `files`; every acceptance criterion needs one.
- `decisions`: only real choices the code and docs do not settle; ask the user with AskUserQuestion when nothing settles one.
- Verification commands never go in the plan: they come from the manifest.

For new files, missing names, signatures or decisions that need an ADR, read [`references/plan-rules.md`](references/plan-rules.md) first.

## 5. Approval and implementation

1. Get the plan accepted.
   - **Plan mode:** call ExitPlanMode. A hook validates the `wf-plan` block. If it denies the call, read the reason, fix the plan file and call it again; if the reason asks you to ask the user or run a check, do that first. The user approves in the native dialog.
   - **Fast route:** write `.claude/workflow/plan.md` and run `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/bin/wf-plan-validate.mjs .claude/workflow/plan.md --session ${CLAUDE_SESSION_ID} --data "${CLAUDE_PLUGIN_DATA}"`. It runs the hook's checks and, on `ACCEPTED`, stores the task as implementing. On `REJECTED`, fix the file and run it again; if it says the task is not small, switch to plan mode. Do not tell the user the plan was approved: say the task is small and what you will do.
2. Do not write code in this session: the implementer does.
3. Launch the implementer with the Agent tool: `subagent_type: "cc-improved:implementer"`, `run_in_background: false` (the gate needs it in the foreground). Its prompt is the brief below and nothing else: no exploration notes, no ticket dump, no conversation. Leave out any line with nothing to put in it.

   ```
   Plan:
   <the numbered approach steps>

   wf-plan: <the accepted wf-plan JSON, verbatim, on one line>

   ADRs to read: <docs/adr/ paths the decisions cite>

   Verify (repo root, in order):
   - <each manifest verify command, verbatim>

   Tools (verify-app skill):
   - <name>: `<exact command>` - <when to use it; what its output means; what must run first>
   ```

   The agents read no skill on their own: copy each relevant tool's command verbatim from the verify-app skill. With no `tools` in the manifest, omit the Tools section.

4. Read the last line of its answer. `DONE`: tell the user what changed and that verification passed, and ask them to check it and close with `/done`; do not run `/done` yourself. `BLOCKED` or `FAILED`, or a hook asking for a review: read [`references/after-implementer.md`](references/after-implementer.md).

Agent variants: the hook that asks for `cc-improved:plan-check` or `cc-improved:reviewer` names the exact agent (`-sonnet` by default; the default variant only for high risk or `review.always`). Launch exactly that one and never pick a variant yourself. `cc-improved:fixer` follows the configured strong model, `${user_config.strong_model}`: if it still starts with `${`, the option is not set and the strong variant is the default one, without `model`. `sonnet`: every variant is `-sonnet` (for example `cc-improved:reviewer-sonnet`). `opus`: the strong variant is the default one. Any other value: the default one with that value as `model`.
