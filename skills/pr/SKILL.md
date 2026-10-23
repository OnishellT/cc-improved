---
name: pr
description: Prepara la rama y el cuerpo del PR de la tarea (resumen, informe de verify, riesgo, ADRs nuevas, evidencias). Solo hace push y crea el PR con gh cuando tú lo confirmas.
argument-hint: "[rama-base]"
disable-model-invocation: true
allowed-tools: Bash(node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/bin/wf-pr.mjs:*)
---

# Open a pull request

The user asked for a pull request. The plugin already gathered the facts; its output:

!`node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/bin/wf-pr.mjs "$ARGUMENTS"`

Speak Spanish to the user. Write the PR title and body in the language the repo's PR template or recent PRs use (Spanish if there is none).

Hard rule: never run `git push` or `gh pr create` until the user has confirmed it explicitly with AskUserQuestion in this very session (step 5). Never push to the base branch, never force-push, never merge.

1. If the output starts with `NOT READY`, tell the user the reason and stop.
2. **Verify.** Read `.claude/workflow.json`. Its `verify` list is the only source of verification commands. Run each one with Bash from the project root, in order, verbatim, with a 600000 ms timeout, and keep a one-line result per command (and the tail of the output of a failing one). Never add, drop or rewrite a command. If one fails, stop and tell the user: a PR with a failing verify is not opened unless they say so. If the list is empty, say in the body that the project has no verification steps.
3. **Branch.** If the current branch is the base branch, propose the suggested `task/<ticket>` name (or a short slug of the task title) and ask with AskUserQuestion before creating it with `git switch -c`. Work that is uncommitted stays out of the PR: offer to commit it (a concise English message, one logical change, ending with a blank line and the attribution line the session instructs) and wait for the answer. Never `git add` the files under `.claude/workflow/` except `tasks.jsonl`, which belongs in the commit with the change.
4. **Body.** Fill the repo's PR template section by section when the output shows one; keep its headings and checkboxes, and tick a box only for what you actually ran. Without a template, use: summary, how it was verified, risk, new ADRs, out of scope. Include:
   - the summary from the task plan and the commits, and the issue or ticket it closes (`Closes #<n>` when the branch or task names an issue);
   - the verify report from step 2;
   - the risk reasons from the output and whether a review ran;
   - the new ADRs, linked by path;
   - the evidence that the project's own `.claude/skills/verify-app/SKILL.md` describes, when that file exists (the output says so).
   Show the title and the full body to the user.
5. **Confirm.** Ask with AskUserQuestion: push `<branch>` to `origin` and open the PR against `<base>` (offer "only show the body" as the other option). Anything but a clear yes means stop here and leave the body on screen.
6. **Open.** Only after a yes, and only if the output says `gh installed: yes`: `git push -u origin <branch>`, then `gh pr create --base <base> --title "<title>" --body-file <file>` using a temporary body file outside the repo. Print the PR URL. If `gh` is not installed, or the remote is missing, push nothing you were not told to and give the user the title, the body and the commands to run themselves.
7. Do not run `/done`, do not merge and do not delete branches.
