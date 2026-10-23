# Vendored method skills

Skills the model loads on its own (`user-invocable: false`; they do not show in `/`). Agents name them in `skills:` (for example `tdd`, `blast-radius`).

- mattpocock/skills @ 5beb35b040e3 (MIT, see `LICENSE-mattpocock`): grilling, domain-modeling, tdd, diagnosing-bugs, retro
- pstack (MIT, Lauren Tan, see `LICENSE-pstack`): technical-writing, create-verification-skill, maintain-verification-skill, blast-radius (renamed without the `pstack-` prefix)

Language-agnostic: no skill hardcodes a verification command; they refer to the verify commands of the manifest (`.claude/workflow.json`).
Update by re-copying from the source and re-applying the Claude Code adaptations.
