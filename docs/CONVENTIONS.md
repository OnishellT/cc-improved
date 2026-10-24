# Conventions

- One issue per PR; the branch is named `issue-<n>-<slug>`; the PR starts with `Closes #<n>`.
- Squash merge, linear history, branch deleted on merge. Nobody pushes to `main`.
- Every PR is reviewed locally (see `docs/DECISIONS.md`, D-001): an independent, read-only reviewer subagent comments on the PR; the orchestrator posts the `claude-review` status on the commit only if the verdict is LGTM. Before asking for review, `npm test`, `npm run typecheck` and `claude plugin validate .` pass locally.
- Every commit ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- `lib/` imports nothing from the harness: only Node and its own modules. Anything that depends on Claude Code lives in `bin/`, `hooks/`, `skills/`, `agents/`, `mod/`.
- Language-agnostic: no fixed verification commands; everything comes from `.claude/workflow.json`. What the code checks, it checks on plain text.
- A hook never throws: on error, log to `${CLAUDE_PLUGIN_DATA}/log/` and emit empty output with exit 0. Every hook declares a `timeout`.
- Hooks fire in every session of the project: state is keyed by `session_id` and other sessions' state is ignored.
- Tests are mandatory: `node --test` for `lib/` and for each hook, with real JSON fixtures (`test/fixtures/hooks/`). Anything that costs money (`claude -p`) goes in `npm run e2e`, outside CI.
- An implementer subagent works only on the files its issue names; if it needs to touch another, it says so in the PR and stops.
- English for docs, messages to the person, code, model prompts and commits (changed from Spanish-for-docs on 2026-10-24 by the user). Older docs still in Spanish are translated when touched.
