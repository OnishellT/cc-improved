# Decisiones

Registro corto de decisiones de proceso del repo. Una entrada por decisión, con su porqué.

## D-001: la revisión de cada PR es local, sin token

- **Contexto:** no hay secreto `CLAUDE_CODE_OAUTH_TOKEN`, así que una GitHub Action de revisión (`claude-code-action`) no puede correr.
- **Decisión:** la revisión la hace un subagente revisor independiente, de solo lectura, que comenta en la PR. El orquestador publica el estado `claude-review` en el commit solo si el veredicto es LGTM, con `gh api repos/{owner}/{repo}/statuses/{sha}`.
- **Alcance de la garantía:** es una garantía de proceso, no criptográfica. Quien tenga permisos de escritura en el repo puede publicar ese estado.
- **Consecuencia:** se elimina `.github/workflows/claude-review.yml`. El estado `claude-review` sigue siendo obligatorio en la protección de `main`.

## D-002: protección de `main` con `strict: false`

- **Contexto:** las PRs paralelas tocan archivos disjuntos (ver `docs/CONVENTIONS.md`), así que exigir que cada rama esté al día con `main` obligaría a rebasar sin necesidad.
- **Decisión:** la protección de `main` usa `strict: false` en los checks obligatorios. El job `test` corre también en `push` a `main`, de modo que una integración rota se detecta justo después del merge.

## D-003: `required_conversation_resolution` desactivado en `main`

- **Contexto:** la revisión obligatoria es la local (D-001). Los hilos de CodeRabbit son automáticos y a veces ruidosos, y exigir resolverlos todos bloqueaba merges con revisión local en LGTM.
- **Decisión:** se desactiva `required_conversation_resolution` en la protección de `main`. La puerta es el revisor local; los hilos de CodeRabbit son orientativos.
- **Consecuencia:** un hilo abierto no bloquea el merge. Quien mergea lee los hilos de CodeRabbit y decide; lo que se descarta se anota en la PR.

## D-004: `hooks/hooks.json` lo crea #27; chequeo del plan con la opción B activa

- **Contexto:** los módulos de hooks se registran en `lib/hooks/registry.ts`, pero el manifiesto `hooks/hooks.json` que hace que Claude Code los llame necesitaba un único dueño para no chocar entre PRs paralelas.
- **Decisión:** `hooks/hooks.json` lo crea #27. Para el chequeo del plan con el modelo fuerte, la opción B está activa y la A queda documentada como alternativa.
- **Consecuencia:** ninguna otra PR toca `hooks/hooks.json`; si un módulo nuevo necesita un evento o un `timeout`, se pide en #27 o en un issue de seguimiento. Cambiar de B a A es un cambio de configuración documentado, no de arquitectura.

## D-005: agents con variante `-sonnet` y prefijo `cc-improved:`

- **Contexto:** el spike 0.4 (`docs/spikes/0.4-user-config.md`) mostró que `${user_config.*}` no se sustituye en el `model:` del frontmatter de un agent, así que el modelo no puede venir de la configuración del usuario.
- **Decisión:** cada agent que depende del modelo tiene una variante `-sonnet` con el modelo escrito en el frontmatter (`fixer-sonnet`, `plan-check-sonnet`, `reviewer-sonnet`). Los agents del plugin se invocan con el prefijo `cc-improved:`.
- **Consecuencia:** hay dos archivos por agent que deben mantenerse a la par. Los hooks reconocen el rol quitando el prefijo y el sufijo de modelo (ver `AgentGateState.role`).

## D-006: excepciones de alcance aceptadas

- **Contexto:** `docs/CONVENTIONS.md` limita a cada implementador a los archivos que su issue nombra. Dos PRs se salieron y se aceptaron tras revisarlas.
- **Decisión:** se aceptan #57 (modificó un test existente) y #59 (correcciones surgidas del e2e). No sientan precedente: cada salida de alcance se dice en la PR y la acepta el revisor.
- **Consecuencia:** las próximas salidas de alcance siguen la regla de siempre (parar y avisar); estas dos no se revierten.

## D-007: en la política de revisión, `always` gana a `never`

- **Contexto:** `ReviewPolicy` (`lib/types.ts`) admite `always` y `never`, y un manifiesto puede traer ambos.
- **Decisión:** si los dos están activos, `always` gana: se revisa cada tarea. Es la opción que gasta más pero no omite una revisión pedida de forma explícita.
- **Consecuencia:** `never: true` solo tiene efecto sin `always`. El comentario del campo `always` en `lib/types.ts` lo indica.

## D-010: `/setup` lo ejecuta una sola vez el modelo grande (opus)

- **Contexto:** el setup produce los artefactos que reutilizan todas las tareas (CLAUDE.md, herramientas de verificación, skills del proyecto, manifest); conviene que lo haga el modelo grande y una sola vez. `${user_config.*}` no se sustituye en `model:` (spike 0.4), así que el modelo no puede venir de la configuración.
- **Decisión:** `skills/setup/SKILL.md` lleva `model: opus` literal. Comprobado con `claude -p --plugin-dir . --model claude-haiku-5-5 --output-format json` (2.1.309): con `/cc-improved:setup` el `modelUsage` solo trae `claude-opus-5-5` (0,129 USD); un prompt de control sin la skill solo trae `claude-haiku-5-5` (0,002 USD). El `model` de la skill se respeta y el turno se factura a opus aunque la sesión sea haiku. La skill sigue en el hilo principal, así que `AskUserQuestion` funciona; no hace falta el fallback de un agent (los agents no pueden preguntar). Con `setup: "done"`, `/setup` avisa del coste y pide confirmación antes de repetir; `SessionStart` ya no lo ofrece en ese estado.
- **Consecuencia:** el override de la skill dura el turno en que se invoca; el modelo de la sesión vuelve después. Un setup repetido cuesta tokens de opus y exige confirmación. Si un cambio de Claude Code dejara de respetar `model` en skills, el test de frontmatter no lo detecta: hay que repetir la comprobación.
