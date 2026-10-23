# Skills de método vendorizadas

Skills que el modelo carga por su cuenta (`user-invocable: false`: no aparecen en `/`). Los agents las nombran en `skills:` (por ejemplo `tdd`, `blast-radius`). El texto de cada `SKILL.md` está en inglés porque es un prompt para el modelo.

- mattpocock/skills @ 5beb35b040e3 (MIT, ver `LICENSE-mattpocock`): grilling, domain-modeling, tdd, diagnosing-bugs, retro.
- pstack (MIT, Lauren Tan, ver `LICENSE-pstack`): technical-writing, create-verification-skill, maintain-verification-skill, blast-radius (sin el prefijo `pstack-`).

Agnósticas de lenguaje: ninguna fija un comando de verificación; se remiten a los comandos de verify del manifest (`.claude/workflow.json`).

Para actualizarlas, vuelve a copiarlas del origen y reaplica las adaptaciones a Claude Code.
