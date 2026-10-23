---
name: setup
description: Prepare this repository for the workflow. Scans the repo, interviews the user, writes CLAUDE.md, GLOSSARY.md, ADRs, domain skills, the verify-app skill, portable verification tools, path rules and connectors, then validates everything and records the verify commands and tools in .claude/workflow.json.
model: opus
disable-model-invocation: true
argument-hint: "[notes for the setup]"
allowed-tools: Bash(node *), Read, Grep, Glob, Write, Edit, AskUserQuestion
---

# Project setup

You are setting up this repository so future agents can work on it with little context. Work through the steps in order. Do not stop until step 9 reports `setup: done`, unless the user asks you to pause.

User notes: $ARGUMENTS

## What the scan found

The scan only detects and proposes. Every command under `candidates` was found in a file of this repo (its `source`); nothing was guessed from the stack. A candidate with `unresolved` has no runnable command yet: ask the user how it runs. `manifest` is the current `.claude/workflow.json`, or null.

```json
!`node ${CLAUDE_PLUGIN_ROOT}/bin/wf-scan.mjs`
```

## Steps

1. **Start.**
   - **Already done?** If `manifest.setup` is `"done"`, do this before anything else: tell the user, in their language, that the setup was already done, that it runs on the large model (opus) and costs far more than a normal task, and that its results (CLAUDE.md, skills, verification tools, manifest) are reused by every task, so repeating it is rarely needed. Ask with `AskUserQuestion` whether to repeat it (first option: no, keep the current setup). If the user does not confirm, stop here: change nothing and do not run `--start`.
   - Ask the user, with `AskUserQuestion`, which language to use for questions and docs (offer the language of the existing docs first). Then run:
     `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/bin/wf-setup-finish.mjs" --start --language "<language>"`
   This sets `setup: "running"` in `.claude/workflow.json`. While it is `running`, the Stop hook may send you back to finish; step 9 sets it to `done` and the pushing stops. If `manifest.setup` was already `running`, you are resuming: keep what is already written and finish the rest. If it was `done` and the user confirmed, update the existing files instead of starting from scratch.

2. **Read.** Read the docs and agent files the scan listed (`docs`, `agentFiles`, `adrs`, `skills`, `rules`). Then explore the code: entry points, main modules, data flow, tests. Use the `subprojects` list for monorepos.

3. **Connectors.** For each entry in `connectors`, ask the user with `AskUserQuestion` whether to connect it (say what you saw: its `evidence`, and what it is for: its `purpose` in `connectorCatalog`). Also offer the other catalog entries once. Connectors are read-only. For every accepted connector with an `mcp` entry in the catalog, add it to the project's `.mcp.json` under `mcpServers.<id>` (keep the servers already there) and tell the user to sign in with `/mcp`. A connector without `mcp` is configured by the user by hand; record it without a server. If a connector is available now, read recent context from it (tickets, issues). Never create or change anything there.

4. **Interview.** List what you could not determine and any contradiction between the code, the docs and the connectors. Follow the grilling skill if it is available. Ask ONE question at a time with `AskUserQuestion`, 2-4 options, recommended option first, until the domain and the main workflows are clear (about 12 questions at most). Do not ask what the code already answers. Use `ticketKeys` to confirm how tickets are named.

5. **Glossary and decisions.** Follow the domain-modeling skill if it is available.
   - `GLOSSARY.md` at the repo root: one entry per domain term, with its meaning in this project. If it exists, extend it.
   - `docs/adr/NNNN-<kebab-title>.md` (four digits, starting at the next free number): one ADR per architecture decision the code shows or the user confirmed, each with a `# ` title, context, decision and consequences. Reuse existing ADRs; never duplicate them.

6. **Agent docs.** Follow the technical-writing skill if it is available: short sentences, one idea per line.
   - `CLAUDE.md` at the repo root, at most 200 lines: purpose, stack, commands, architecture map, conventions, hard rules (MUST / NEVER) and a link to each skill. Import long docs with `@docs/...` instead of copying them. If it exists, update it and keep the user's content. If an `AGENTS.md` exists, import it with `@AGENTS.md` instead of repeating it.
   - `.claude/skills/domain-<area>/SKILL.md`, one per business area. Frontmatter with `name` (equal to the folder name: lowercase letters, digits, hyphens) and `description` (when to use it), then the vocabulary, invariants, key files and pitfalls.
   - `.claude/rules/<topic>.md` for rules that apply only to some folders. Each starts with frontmatter whose `paths:` lists the globs it applies to, for example:
     ```
     ---
     paths:
       - "src/api/**"
     ---
     ```

7. **Verification.** Follow the create-verification-skill skill if it is available.
   - Write `.claude/skills/verify-app/SKILL.md` (frontmatter with `name: verify-app` and `description`): how to drive the app and see a change working, with a runnable script when the app can be driven headlessly. Its evidence and scratch files live inside the repo under `.claude/workflow/`, never elsewhere.
   - **Verification tools.** From what the interview found "it works" means here (the app starts, endpoints answer, the UI renders, data lands, the build is sane), design with the user, via `AskUserQuestion`, the small tools that let the implementer, the fixer and the reviewer check their work in one command, and write them inside the repo (default folder `tools/verify/`, or the one the user picks). Follow the tool contract in section 2b of the create-verification-skill skill: one purpose, `--help`, exit code plus short bounded output (JSON or a few lines), read-only unless it works on a test environment it creates, and a declared runtime: `python` (Python 3 standard library only, no pip) or `nix` (a script plus a `shell.nix` or `flake.nix` next to it that pins its dependencies, only when it needs system binaries). Start from its templates; their probes are examples to replace with this project's checks. The plugin brings no tool of its own.
   - In the verify-app skill, add a **Tools** section: for each tool its name, the exact command (the one `wf-setup-finish.mjs` prints), when to use it, what its output means and what must be running first. Name a tool in the `.claude/skills/domain-*` skill of the area it checks, when there is one.
   - Choose the verify steps from `candidates`. A verification tool is a verify step only when it runs green headlessly from a clean checkout. Prefer a single `verify` entry point when the repo has one. Otherwise order the steps fastest first: format and lint, then type check or compile, then build, then tests, so the agent gets static feedback before behavior feedback. Skip `install` candidates. Fix a candidate that is wrong. If the repo has no check at all, ask the user what proves the project works; do not invent tool commands the repo does not use. Add the verify-app command only if it runs green.
   - Do not change application code and do not install dependencies without asking.

8. **agentlint (optional).** Only when the scan shows `agentlint.config` or `agentlint.dependency`, or the user asks: offer with `AskUserQuestion` to turn the most important MUST / NEVER rules of `CLAUDE.md` into agentlint rules (at most 3 to start, the user picks). Record its command prefix with `--agentlint "<prefix>"` in step 9; its `check --all` runs as the last verify step.

9. **Review and finish.** Show the user what you wrote (the list of files and a 3-8 line summary, including what is still unresolved) and ask with `AskUserQuestion` whether to finish or what to change. Apply the feedback. Then run, with one `--step` per verify command in order, one `--connector` per enabled connector (`<id>:<server>` when it has an `.mcp.json` server) and one `--tool` per verification tool (`<python|nix>:<repo-relative path>`):
   ```
   node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/bin/wf-setup-finish.mjs" --step "<command>" --step "<command>" --connector "<id>:<server>" --tool "python:tools/verify/<name>.py"
   ```
   It checks the files above and each tool (exists, executable, pinned runtime, answers `--help`, named in the verify-app skill; a runtime missing on this machine is only a warning for the user), prints the exact command of each tool (copy it into the verify-app skill if it differs), runs verify and, when everything passes, writes `.claude/workflow.json` with `setup: "done"` and adds `.claude/workflow/` to `.gitignore` (keeping `tasks.jsonl` committed). If it exits non-zero, read the report, fix the cause (or the steps, if they are wrong) and run it again. After three verify failures in a row, ask the user whether to keep trying, finish anyway (add `--accept-failing-verify`) or pause (run it with `--pause` instead and stop; the next `/setup` resumes).

If the user asks to pause at any point, run `wf-setup-finish.mjs --pause` and stop: it sets `setup: "pending"` so nothing pushes you to continue.

When step 9 prints `setup: done`, stop.
