---
name: verify
description: Ejecuta a mano los comandos de verificación del proyecto, los de .claude/workflow.json, en orden y sin arreglar nada, y resume el resultado.
---

# Run the project's verification

1. Read `.claude/workflow.json`. Its `verify` list is the only source of verification commands. If the file is missing or `verify` is empty, tell the user (in Spanish) that the project has no verification steps and that `/setup` sets them up. Stop.
2. Run each command with Bash from the project root, in the listed order, one call per command, verbatim, with a 600000 ms timeout. Never add, drop, reorder or rewrite a command, and never substitute one of your own.
3. Stop at the first command that exits non-zero or times out.
4. Do not edit any file and do not try to fix a failure: this only reports.
5. Report to the user in Spanish: one line per command run, `✓` or `✗` followed by the command. For the failing one, add its exit code (or that it timed out) and the last lines of its output that show the error, at most 40 lines.
