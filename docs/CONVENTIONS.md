# Convenciones

- Un issue por PR; la rama se llama `issue-<n>-<slug>`; el PR empieza con `Closes #<n>`.
- Squash merge, historia lineal, rama borrada al mergear. Nadie pushea a `main`.
- La revisión de cada PR es local (ver `docs/DECISIONS.md`, D-001): un subagente revisor independiente, de solo lectura, comenta en la PR; el orquestador publica el estado `claude-review` en el commit solo si el veredicto es LGTM. Antes de pedir revisión, `npm test`, `npm run typecheck` y `claude plugin validate .` pasan en local.
- Cada commit termina con `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- `lib/` no importa nada del harness: solo Node y sus propios módulos. Lo que depende de Claude Code vive en `bin/`, `hooks/`, `skills/`, `agents/`, `mod/`.
- Agnóstico de lenguaje: ningún comando de verificación fijo; todo sale de `.claude/workflow.json`. Lo que el código comprueba lo hace sobre texto plano.
- Un hook nunca lanza: error → log en `${CLAUDE_PLUGIN_DATA}/log/` y salida vacía con exit 0. Cada hook declara `timeout`.
- Los hooks disparan en todas las sesiones del proyecto: el estado va por `session_id` y se ignora el ajeno.
- Tests obligatorios: `node --test` para `lib/` y para cada hook con fixtures JSON reales (`test/fixtures/hooks/`). Lo que cuesta dinero (`claude -p`) va en `npm run e2e`, fuera de CI.
- Un subagente implementador trabaja solo en los archivos que su issue nombra; si necesita tocar otro, lo dice en el PR y para.
- Español en docs y mensajes a la persona; inglés en código, prompts a modelos y commits.
