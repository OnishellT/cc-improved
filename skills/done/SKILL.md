---
name: done
description: Cierra la tarea activa cuando ya la comprobaste. Guarda su ficha en .claude/workflow/tasks.jsonl para futuras tareas relacionadas y, cada 5 tareas, propone una retro.
disable-model-invocation: true
allowed-tools: Bash(node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/bin/wf-done.mjs:*)
---

# Close the active task

The user checked the task and closed it. The plugin already ran the closing script; its output:

!`node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/bin/wf-done.mjs`

Speak Spanish to the user.

- `CLOSED`: confirm it in one or two lines (task, files recorded). Remind the user that `.claude/workflow/tasks.jsonl` belongs in the commit with the change. Do not commit, push or open a PR yourself.
- `NOT CLOSED`: tell the user the reason from the output and what to do next. Do not edit `.claude/workflow/task.json` or `tasks.jsonl` by hand.

If the output has a `RETRO DUE` line, run the retro now:

1. Load the `retro` and `maintain-verification-skill` skills of this plugin.
2. Read the last 5 records of `.claude/workflow/tasks.jsonl`. Summarise: decisions that were missing from the plans, rules that repeated, verification failures by cause, and review findings.
3. Propose concrete edits to `CLAUDE.md`, `docs/adr/` or `.claude/skills/` as AskUserQuestion options. Never write them without the user's approval.
4. Check the project's verification skill and the `verify` list of `.claude/workflow.json` following `maintain-verification-skill`, and propose changes the same way.
