---
name: create-verification-skill
user-invocable: false
description: "Generate a project-local verification skill that drives your app the way a user does — any language, framework, or platform. Use for \"make a control skill for this repo\", or when a project has no scripted way to prove UI/CLI/service behavior."
---

# Create a verification skill

Every serious project needs a scripted way to drive the real app and prove behavior: launch it, exercise a feature the way a user would, and capture evidence. This skill generates that as a project-local skill (`.claude/skills/verify-<app>/`) tailored to the repo. You write the generator's output for the next agent, not for a human: it will be read cold, mid-task, by an agent that has never seen the app.

## 1. Interview the repo, not the user

Answer these from the codebase and only ask the user what you cannot observe:

- **Surface:** what does a user actually touch? A web UI, a CLI/TUI, a desktop app, an API, a mobile app, a library? A repo can have several; pick the primary one and note the rest.
- **Run:** how does the app start locally? Prefer the repo's own documented dev command (package scripts, Makefile, README quickstart). Note ports, env vars, seed data, auth.
- **Drive:** how can an agent interact with it programmatically? Existing harnesses first — Playwright/Cypress specs, expect scripts, PTY helpers, curl-able endpoints, a debug port. Only then pick a generic recipe: browser/CDP for web and Electron, a tmux/PTY harness for CLI/TUI, plain HTTP for services.
- **Observe:** what evidence can be captured? Screenshots, terminal transcripts, response bodies, logs, exit codes, DB state.
- **Isolate:** can two instances run side by side (ports, data dirs, profiles)? If not, say so in the generated skill: refusing to double-drive a shared instance beats corrupting the user's session.

If the checkout doesn't build or start as-is, report that precisely and propose a separately authorized product fix before generating; a skill written against a broken base teaches wrong steps. When an irrelevant missing asset blocks startup (a static dir the API never serves, a sample config), the generated skill may create it, clearly marked as verification scaffolding, and remove it in cleanup.

## 2. Generate the skill

Write `.claude/skills/verify-<app>/SKILL.md` with YAML frontmatter (`name: verify-<app>` and a `description` that names the app, the surface, and when to reach for it — without frontmatter the skill never registers) and these sections, each grounded in what the interview actually found (no placeholders left):

- **Launch:** the exact command that starts the app for verification, and how to tell it's ready (a log line, a port answering, a prompt). Include teardown. For a short-lived CLI or TUI there is no server to keep alive: launch means build the binary (or install deps) once, then start each drive in its own isolated PTY or tmux session.
- **Doctor:** one read-only check that answers "is this instance worth driving?" — process up, right version/build, port owned by us, auth valid. An agent runs this first whenever anything looks off.
- **Drive:** the harness recipe with real selectors/commands from this repo, not examples. Prefer stable handles (ARIA labels, data attributes, prompt strings, route paths) over coordinates and tab order.
- **Evidence:** what to capture for a proof and where it goes. State the proof standards: exercise the real user path, not internal setters or test-only endpoints; capture the action and the resulting state, not just the final screen; verify side effects (files written, rows inserted, messages sent) alongside what's visible; mocks only where a production boundary already isolates the external system. When the safe path is a dry-run or test mode, verify what it actually skips by observing (files, network, git refs) rather than trusting its name: some dry-runs still touch the network or open a browser.
- **Cleanup:** how to tear down instances the run created. Never kill by process name; kill what you started. Cleanup removes instances and scratch state, never the evidence: proof artifacts survive the teardown, in a location the skill names.
- **Helpers:** any script the skill ships is executable and its invocation is shown in the skill body. A helper the reader has to reverse-engineer is not a helper.
- **Tools:** the project's verification tools (section 2b), one entry each: name, exact command, when to use it, what its output means.

## 2b. Write the project's verification tools

The skill tells an agent *how* to check; a tool lets it check in one command. Subagents (implementer, fixer) cannot ask anyone and get only a short brief, so every repeatable check that proves "it works" here (the app starts, an endpoint answers, a page renders, a row lands, the build artifact is sane) becomes a small tool inside the repo. The plugin ships no tools and assumes no stack: you design each one with the user, from what the interview found, in the folder you agree on (default `tools/verify/`).

Every tool meets this contract:

- **One purpose.** It proves one thing; its file name says what (`check_health.py`, `ui-smoke.sh`).
- **`--help`.** States the purpose, the arguments, the output format, the exit codes and its side effects. `--help` itself does nothing else: setup runs it to validate the tool.
- **Bounded, structured output.** Exit 0 pass, 1 fail, 2 bad usage. Stdout is one JSON object (`{"tool", "ok", "checks": [{"name", "ok", "detail"}]}`) or a few short lines; cap details (a few hundred characters each) so a failure fits in an agent's context. No progress bars, no full logs: point to a file under `.claude/workflow/` instead.
- **No dangerous effects.** Read-only by default. Anything that writes (seeding data, starting an instance) only touches a test environment the tool creates and cleans itself, never the user's data, shared services or production; say so in `--help`.
- **Declared, portable runtime.** Exactly one of:
  - `python`: a Python 3 script that imports only the standard library (no pip, no virtualenv), started as `python3 <path>`. Template: [`references/verify-tools/python-tool.py`](references/verify-tools/python-tool.py).
  - `nix`: a script plus a `shell.nix` (pinned nixpkgs) or `flake.nix` (with its `flake.lock`) in the same folder that pins every binary it calls. Use it only when the check needs system binaries. Templates: [`references/verify-tools/nix/`](references/verify-tools/nix/). A flake's files must be committed for other machines.
  No implicit global dependency: a tool never relies on something installed on this machine that its runtime does not provide.
- **Executable.** `chmod +x`, with a shebang.

Use the project's own commands inside a tool when they exist; the templates' probes are EXAMPLES to replace, not checks to keep. Run each tool once against the real app (pass and fail) before registering it.

Register every tool in three places:

1. `wf-setup-finish.mjs --tool <python|nix>:<path>` (one per tool). It checks the file exists, is executable, has its nix env, imports only the stdlib (python), answers `--help`, and is named in the verify-app skill; it prints the exact command for each tool. A runtime missing on this machine is only a warning: the user installs it, never you.
2. The verify-app skill (`.claude/skills/verify-app/SKILL.md`), section **Tools**: for each tool its name, the exact command `wf-setup-finish.mjs` printed (python: `python3 <path> <args>`; shell.nix: `nix-shell <env> --run '<path> <args>'`; flake: `nix --extra-experimental-features 'nix-command flakes' develop path:./<dir> --command <path> <args>`), when to use it, what its output means and what it needs running first. Repeat the tool in the `.claude/skills/domain-*` skill of the area it checks, when there is one.
3. `.claude/workflow.json` `verify` (`--step`), only for a tool that runs green headlessly from a clean checkout (it starts and stops whatever it needs). A tool that needs an app the user starts stays out of `verify`: agents run it from the skill.

## 3. Seed the feature map

Create `.claude/skills/verify-<app>/features/README.md` plus one file per user-facing feature you can identify (aim for the top 3-5 to start, from routes, commands, menus, or docs). Follow the shape in [`references/feature-map-example/`](references/feature-map-example/), with a README index and one file per feature. Each file answers, from the user's point of view: what the feature is, how to reach it, how to drive it with the harness, and what observable end state proves it works. The four H2s are `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>`, and `Gotchas`. The map is the repo's maintained verification source; a proof that drives one convenient entry point is incomplete when the map lists others.

## 4. Prove the generated skill before handing it over

Run its own instructions end to end once: launch, doctor, drive ONE mapped feature (one is enough; the map exists so later runs can cover the rest), capture evidence, clean up. After cleanup, confirm the evidence still exists at the named location — a cleanup that eats the proof fails this step. Fix what fails, and run the generated cleanup after every failed iteration too, so broken attempts don't strand processes and ports. A generated skill that was never executed is a draft, not a deliverable.

## 5. Offer the maintenance loop

Point the user at `the maintain-verification-skill skill` for keeping the map honest as the app changes. Suggest a cadence only if they ask.

## Agent integration boundary

Use only tools available in the current agent. Resolve bundled references relative to this skill. Use approved native delegation only when authorized; otherwise work sequentially and report the lack of independent review. Never invent tools or permissions. This skill is guidance, not an enforcement layer.

Project privacy preflight and source grants apply before private evidence collection, external research or retention. This skill grants no permissions and is not an enforcement layer. Preserve user files. Only persist reports within an authorized write scope; request authorization rather than overwrite user content. Publication, commits and PRs need explicit authorization. Keep research read-only and live driving in the main session. Retain behavior evidence as authorized local files outside scratch; report fidelity, incomplete coverage and cleanup. Expected product behavior changes require an approved requirement change, not a silently rewritten baseline.
