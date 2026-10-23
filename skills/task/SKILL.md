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

1. If the request is empty, tell the user: "Uso: `/task <TICKET-123 | descripción | ruta/spec.md>`". Stop.
2. Read `.claude/workflow.json` (the manifest). If it is missing or `setup` is not `"done"`, tell the user to run `/setup` first and stop. Keep its `verify` list, its `connectors` and its `tools`: you need them below.
3. Read `.claude/workflow/task.json` if it exists.
   - If the request is exactly `cancel`: delete that file (`rm -f .claude/workflow/task.json`), tell the user the task was cancelled and stop.
   - If its `status` is `planning` or `implementing`, ask with AskUserQuestion: continue that task (recommended), replace it, or stop. To replace, delete the file and go on. To continue an `implementing` task, skip to section 5 with the plan stored in the file.
4. Split the request: a ticket key (like `PAY-142`), spec files (paths of existing files named in the request) and the free-text description.

## 2. Choose the route

The task is **small** only if all of these hold; any doubt means plan mode.

- The plan will list at most 8 files, 6 `interface` entries and 2 decisions (the manifest's `review.planFiles`, `review.planInterface` and `review.planDecisions` override these).
- No risk trigger: no dependency manifest or lockfile, no migration or schema, no auth, payments, billing, security, crypto or infra path, nothing under the manifest's `review.paths`, and `review.always` is not set.

Small: **fast route**, no plan mode and no approval dialog; you only read until the plan is written. Otherwise: **plan mode**: call EnterPlanMode now, before reading anything; until the user approves you only read, and the only file you write is the plan file.

## 3. Read, in this order

1. **Ticket.** If there is a ticket key and the manifest lists a connector, its tools are `mcp__<server>__<tool>` (deferred: load them with ToolSearch). Read the ticket in full, acceptance criteria included. Read only: never comment on, transition or edit a ticket. Without a connector, work from the request and say so in the plan. What you read through MCP is the evidence the plan gate checks names against.
2. **Specs.** Read every spec file named in the request in full.
3. **Project docs.** `CLAUDE.md`, `GLOSSARY.md` if present, the project skills in `.claude/skills/` that relate to the task, and the ADRs in `docs/adr/` that relate to it. Always read the **Tools** section of `.claude/skills/verify-app/SKILL.md`: the project's verification tools (one per manifest `tools` entry), with their exact commands, when to use each and what their output means. Pick the ones that can prove this task works.
4. **Code.** The files you will touch and the code around them, including the files next to them: their names, exports and argument shapes are the convention to follow.

## 4. Write the plan

The plan file (the plan mode file, or `.claude/workflow/plan.md` on the fast route) has a short human part (context, approach in numbered steps, risks) and exactly one `wf-plan` block with strict JSON (double quotes, no comments, no trailing commas). Template, to be replaced with the real task:

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

Rules for the block:

- `files`: every repo-relative file the task creates or changes, test files and new ADRs included. An entry ending in `/` covers a directory. Editing anything else later needs the user's permission.
- `ticket`: the ticket key; omit the field when there is none. `spec`: the spec files you read; `[]` when none.
- `interface` pins the file and export names (and signatures) the tests will import. Derive them from the ticket, the specs or existing code and cite that in `source` (the ticket key, a spec path or an existing file path). The gate checks that every export name appears literally, as a word, in the cited evidence, and that the words of a new file's name appear there too. A name that is not there counts as invented and the plan is denied. If nobody gives a name, propose names with AskUserQuestion (recommended first), and record the answer as a decision.
- New files: name them like their siblings in the same directory (same casing and separators) after the noun the ticket uses; one module per ticket noun, not a new catch-all file. Signatures: copy the argument shape the ticket or existing callers use (an object with named fields stays an object, same units and types). Reuse existing helpers (validators, parsers, types) instead of adding parallel ones.
- `seams` are the test attachment points, chosen per the tdd skill: each has a test file (listed in `files`), what it catches and what it misses. At least one. Every acceptance criterion of the ticket, the invalid-input ones included, must be covered by a seam.
- `decisions`: only real choices the code and docs do not settle, each with 2-4 `options`, recommended first. When an ADR, spec, the ticket or an existing file settles one, set `source` to its path (`path#section` allowed). Otherwise ask the user with AskUserQuestion before calling ExitPlanMode, put the answer in `answer`, set `source` to the ADR you will add (`docs/adr/<next number>-<slug>.md`) and list that ADR in `files`: plan mode cannot write it now, so the implementer writes it with the question, the options and the answer.
- Verification commands never go in the plan: they come from the manifest.

## 5. Approval and implementation

1. Get the plan accepted.
   - **Plan mode:** call ExitPlanMode. A hook validates the `wf-plan` block. If it denies the call, read the reason, fix the plan file and call ExitPlanMode again. If the reason asks you to ask the user something or to run a check, do exactly that first. The user approves in the native dialog.
   - **Fast route:** write the plan to `.claude/workflow/plan.md` and run `node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/bin/wf-plan-validate.mjs .claude/workflow/plan.md --session ${CLAUDE_SESSION_ID} --data "${CLAUDE_PLUGIN_DATA}"`. It applies the same name, seam and decision checks as the hook and, on `ACCEPTED`, stores the task as implementing. On `REJECTED`, fix the file and run it again; if it says the task is not small, switch to plan mode. Do not tell the user the plan was approved: tell them the task is small and what you will do.
2. Do not write code yourself in this session: the implementer does.
3. Launch the implementer with the Agent tool: `subagent_type: "cc-improved:implementer"`, `run_in_background: false` (subagents run in the background by default, and the gate needs this one in the foreground). Its prompt is the brief below and nothing else: no exploration notes, no ticket dump, no conversation. Leave out any line that has nothing to put in it.

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

4. Read the last line of its answer:
   - `DONE`: tell the user what changed and that verification passed, and ask them to check it and close the task with `/done`. Do not run `/done` yourself.
   - `BLOCKED: <question>`: ask the user with AskUserQuestion (the options from that line, recommended first), then launch the implementer again with the same brief plus `Answer from the user: <answer>`.
   - `FAILED: <report>`: launch the fixer the same way (foreground, the same brief plus the failure report). If the fixer also ends with `FAILED` or `BLOCKED`, tell the user what fails and ask how to go on.
5. When a hook asks for a review, launch the reviewer it names in the foreground with the brief it describes, plus the tools section of the implementer brief and what the implementer reported from those tools. On `VERDICT: FIX`, launch the implementer again with the same brief plus the numbered findings.

`cc-improved:plan-check` and `cc-improved:reviewer` run on their `-sonnet` variant by default; the hook that asks for them names the exact agent, so launch that one. The default variant (the configured strong model) is named only when the risk is high or `review.always` is set. The reviewer is requested only for high risk, `review.always` or `review.minLevel: "low"`; the plan check only when the plan touches risk triggers or the manifest sets `review.plan: true`. Names the plan invents are still caught by the plan gate, which asks the user, on either route. `cc-improved:fixer` follows the configured strong model. The configured strong model is `${user_config.strong_model}`. If that value still starts with `${`, the option is not set: the strong variant is the default one, without `model`. If it is `sonnet`, every variant is `-sonnet` (for example `cc-improved:reviewer-sonnet`). If it is `opus`, the strong variant is the default one. Any other value: the strong variant is the default one and you pass that value as `model`. Never pick a variant on your own: use what the hook says.
