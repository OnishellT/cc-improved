# Forma de trabajo con cc-improved

cc-improved existe para una idea: **el modelo barato implementa; el modelo fuerte y la persona entran solo donde aportan.** Por defecto, `/setup` una vez y trabajo directo; para tareas de riesgo, un flujo opcional (`/task`) donde el código decide cuándo puede avanzar (ver [Modos de uso](#modos-de-uso)). Este documento describe el flujo completo de un proyecto, de la primera sesión al deploy, y qué parte cubre el plugin sobre Claude Code. Es la adaptación a Claude Code del WORKFLOW de [pi-improved](https://github.com/OnishellT/pi-improved).

Regla transversal: todo lo que hace el plugin es **agnóstico de lenguaje y framework**. No trae gates para un stack concreto; los comandos de verificación salen del propio proyecto y se guardan en `.claude/workflow.json`. Lo que el código comprueba por su cuenta lo hace sobre texto plano (nombres, archivos, diffs), nunca parseando un lenguaje.

## El flujo de un vistazo

| # | Etapa | Quién | Con qué | En cc-improved |
|---|-------|-------|---------|----------------|
| 1 | Setup inicial: docs, skills, reglas | Sesión (el mejor modelo) + persona | `/setup`, skills `grilling`, `domain-modeling`, `create-verification-skill` | Cubierto |
| 2 | Planificación | Sesión + chequeo del modelo fuerte | `/task`, plan mode, bloque `wf-plan`, nombres verificados, `plan-check` | Cubierto |
| 3 | Implementación con contexto específico | Subagente `implementer` (modelo de la sesión) | Plan aprobado, skill `tdd`, guards de `PreToolUse` | Cubierto |
| 4 | Verificación real en el entorno esperado | Código (`verify`) | Herramientas del setup (`tools`), `verify-app`, compilador, linter, tests | Cubierto |
| 5 | Reglas de la persona (agentlint) | Código (`verify`) | `.agentlint/config.ts` si el proyecto lo usa | Parcial: los guards reconocen agentlint; el plugin no lo instala |
| 6 | Corrección de errores | `implementer`; tras fallos, `fixer` (modelo fuerte) | Gate de verify, skill `diagnosing-bugs`, `reviewer` por riesgo | Cubierto |
| 7 | Creación de la PR con verificaciones estáticas | Sesión + persona | `/pr`, `gh`, plantilla del repo | Cubierto |
| 8 | Revisión de la PR en CI | CI del proyecto | Los mismos comandos de `verify` | Fuera del plugin |
| 9 | Deploy | CI/CD del proyecto | Pipeline del proyecto | Fuera del plugin |
| 10 | Verificación manual | Persona | Entorno desplegado | Fuera del plugin |

"Cubierto" significa que el código del plugin lo ejecuta (hooks) y lo bloquea cuando falla. "Fuera del plugin" es trabajo del proyecto y de la persona que el plugin prepara, pero no ejecuta.

## 1. Setup inicial

Se hace una vez por repositorio, con el modelo más fuerte que haya: su salida es el contexto que después consumen los modelos baratos, así que aquí no se ahorra. `/setup`:

1. **Escaneo en código, sin modelo** (`bin/wf-scan.mjs`): stack, gestor de paquetes, CI, docs existentes, comandos de verificación candidatos, conectores por el remote de git y las claves de tickets en los commits.
2. **Entrevista** con la skill `grilling`: una pregunta cada vez con `AskUserQuestion`, la opción recomendada primero, nada que el código ya responda.
3. **Documentos:** `CLAUDE.md`, `GLOSSARY.md`, `docs/adr/` y una skill `.claude/skills/domain-<área>/` por área de negocio.
4. **Skill `verify-app` y herramientas de verificación.** Pequeñas herramientas dentro del repo (por defecto `tools/verify/`), una por propósito, con `--help`, código de salida y salida corta, con runtime `python` (solo biblioteca estándar) o `nix` (con su `shell.nix`). La sección **Tools** de `verify-app` dice cuándo usar cada una y qué significa su salida.
5. **`verify`.** La lista de comandos ordenada de más rápida a más lenta. `bin/wf-setup-finish.mjs` comprueba en código que los archivos existen y tienen el formato correcto, corre `verify` y deja `.claude/workflow.json` con `setup: "done"`, `verify`, `tools` y `connectors`. Se versiona.

Un `SessionStart` ofrece `/setup` si el repo no lo tiene, y el `Stop` empuja a terminarlo.

## 2. Planificación

`/task <descripción | PAY-142 | ruta/a/spec.md>` arranca una tarea. La sesión entra en plan mode y solo lee: el ticket por MCP si hay conector (solo lectura), las specs, `CLAUDE.md`, `GLOSSARY.md`, las skills y ADRs relacionadas, las tareas pasadas parecidas de `.claude/workflow/tasks.jsonl` y el código que va a tocar con sus archivos hermanos.

El plan es un archivo con una parte humana corta y un único bloque `wf-plan` (JSON estricto) con `files`, `interface` (archivo, exports y firmas con su fuente), `seams` (puntos de prueba según la skill `tdd`; cada criterio de aceptación, incluidos los de entrada inválida, debe tener uno) y `decisions` (solo lo que ningún documento resuelve).

Al llamar a `ExitPlanMode`, el hook `PreToolUse` hace dos comprobaciones antes de que la persona vea el plan:

- **Nombres verificados** (`lib/contract.ts`): cada nombre de `interface` debe aparecer literalmente, como palabra, en la fuente que cita. Lo que no aparece cuenta como inventado y se pregunta. Es texto plano: sirve en cualquier lenguaje.
- **Chequeo del plan** (opción B, `docs/DECISIONS.md` D-004; apagado por defecto, D-012 y D-015): solo si el manifest lo activa (`review.always`, `review.minLevel: low|high` o `review.plan: true`) y entonces, con el plan en riesgo alto (dependencias, migraciones, `review.paths`, zonas sensibles) o `review.always`, con el modelo fuerte; `review.plan: true` también lo pide, con el modelo barato, para planes grandes (más de 8 archivos, 6 entradas de interfaz o 2 decisiones); `review.plan: false` lo apaga siempre. La puerta determinista de nombres, seams y decisiones corre siempre. Cuando se pide, la primera llamada se deniega y pide lanzar `plan-check` (modelo fuerte, solo lectura), que devuelve `VERDICT: OK` o una lista de arreglos. Una vez por tarea. La opción A queda en `docs/plan-check-option-a.md`, sin activar.

La persona aprueba el plan una vez y la tarea pasa a `implementing`.

## 3. Implementación con contexto específico

Implementa un **subagente `implementer`** que recibe solo lo que necesita: el plan aprobado, la interfaz, los seams, las ADRs que tocan y la skill `tdd`. Nada de la conversación de planificación. Cuanto menos contexto arrastra el modelo barato, mejor sigue el plan. No puede preguntar a la persona: si se atasca, termina con `BLOCKED:` y la sesión principal pregunta.

Mientras implementa, los guards de `PreToolUse` piden confirmación (`ask`) cuando el agente:

- toca archivos fuera de `files` del plan;
- añade dependencias, por comando o editando `package.json`, `pyproject.toml`, `go.mod`, etc.;
- crea migraciones o cambia esquemas.

## 4. Verificación real en el entorno esperado

Cuando el implementer termina, el código no le cree. El hook `SubagentStop` (y `Stop` para la sesión principal):

1. **Contrato de interfaz.** Cada export del plan debe aparecer en su archivo. Si falta, vuelve al agente sin gastar verify ni revisión.
2. **`verify`.** Ejecuta en orden los comandos de `.claude/workflow.json`: primero los rápidos, después los tests, después las herramientas de `verify-app` que ejercitan la funcionalidad en el entorno real. El agente no puede cerrar la tarea con `verify` en rojo.

Los comandos vienen del proyecto, no del plugin: el mismo flujo sirve para TypeScript, Python, Go o lo que haya.

## 5. Reglas de la persona (agentlint)

Si el proyecto usa agentlint, `agentlint check --all` es un paso más de `verify` y los guards de `PreToolUse` bloquean sus comandos interactivos y las aprobaciones sin actor humano. Ante un bloqueo repetido, se pregunta a la persona y se registra la excepción. cc-improved no instala agentlint; `/wf-doctor` lo comprueba si está en el manifiesto.

## 6. Corrección de errores

El informe de `verify` vuelve al agente, y la presión sube con cada fallo: el primero, "arréglalo" con el método de diagnóstico; el segundo, se lanza el `fixer` con el modelo fuerte; después, decide la persona (D-009).

Por defecto no se pide revisión con modelo (D-015). Con `review.always`, o con `review.minLevel: "high"` y un diff de riesgo alto (más de 600 líneas o 15 archivos, dependencias, migraciones, `review.paths`, rutas sensibles) (`lib/risk.ts`), el `reviewer` (modelo fuerte, solo lectura) revisa el diff contra el plan, la interfaz, las ADRs y `CLAUDE.md` siguiendo `blast-radius`. El nivel de riesgo (bajo: más de 200 líneas o 6 archivos, sin plan, decisiones nuevas del usuario) se registra siempre en el resumen; `review.minLevel: "low"` pide revisión también para el riesgo bajo, `"off"` o ausente no la pide; `review.never` la apaga y `review.always` gana a `never`. Una ronda: si pide cambios, los hace el modelo barato y los comprueba `verify`, no otra revisión pagada. El reviewer no ejecuta herramientas; recibe en su brief lo que `verify` y las herramientas ya reportaron.

`/done` cierra la tarea cuando la persona la comprobó: guarda su ficha en `.claude/workflow/tasks.jsonl` y cada 5 tareas propone una retro (`retro` y `maintain-verification-skill`), con las ediciones como opciones que la persona aprueba.

## 7. Creación de la PR con verificaciones estáticas

`/pr` reúne los hechos con `bin/wf-pr.mjs`, corre `verify` tal cual está en el manifiesto, rellena la plantilla de PR del repo (resumen, informe de verify, riesgo, ADRs nuevas, evidencias de `verify-app`) y enseña título y cuerpo. **Nada se pushea sin confirmación expresa de la persona** (`AskUserQuestion`); nunca hace force-push ni merge.

## 8. Revisión de la PR en CI

Fuera del plugin, pero el setup lo prepara: los mismos comandos de `verify` deben correr en el CI del proyecto. Lo que pasa en local tiene que pasar en CI con la misma lista.

## 9. Deploy

Fuera del plugin. Lo hace el pipeline del proyecto cuando la PR se aprueba.

## 10. Verificación manual

Fuera del plugin y a propósito. La última palabra sobre la funcionalidad la tiene una persona en el entorno desplegado. Las herramientas de verificación y sus evidencias existen para que esa comprobación sea corta y dirigida, no para sustituirla.

## Modos de uso

El modo por defecto es el **directo**; el flujo completo es opcional y se elige por riesgo. `mode` en `.claude/workflow.json` (`"direct"` | `"flow"`, opcional y aditivo; sin él vale `direct`) lo registra, y `wf-setup-finish` escribe `direct`.

- **Modo directo (por defecto): `/setup` y trabajo directo.** Etapa 1 una vez, con el modelo más fuerte, y después trabajar con el modelo barato usando `CLAUDE.md`, las skills del proyecto y las herramientas de verificación que dejó el setup. El `CLAUDE.md` que genera `/setup` incluye una sección corta de verificación antes de dar una tarea por terminada (correr los comandos de `verify` del manifest y las herramientas de `tools/verify/` de `verify-app`, y no darla por terminada si fallan) y una sección «contrato primero» que remite a la skill `contract-first` y al script `wf-contract-check.mjs` (contrato en `.claude/workflow/contract.json`, lista de validación de entradas, comprobación al final), con la regla de cuándo usar `/task`. No hay plan mode, gates ni revisión.
- **Modo con gates (opcional, por riesgo): `/task`.** Etapas 2 a 7. Para cambios que tocan dependencias, migraciones, rutas de `review.paths`, o grandes: el código bloquea por nombres, contrato y `verify`, y el modelo fuerte revisa si el manifest lo activa (`review`). Con `mode: "flow"`, es la ruta recomendada del proyecto.

**Gates sin tarea (D-014).** Las puertas (`PreToolUse` de plan y guards, `SubagentStop`, `Stop`) siguen activas solo con una tarea abierta. No se añaden hooks que corran en toda sesión para vigilar el trabajo directo: costarían latencia y falsos bloqueos en cada sesión, y la eval no mostró que el flujo completo mejore la calidad. En modo directo la verificación depende de lo que `CLAUDE.md` pide al modelo, no de un bloqueo en código. Quien necesite que `verify` sea obligatorio sin abrir tarea debe ponerlo en el CI del proyecto (etapa 8).

SessionStart dice una línea según el modo: con `setup` pendiente ofrece `/setup`; con `done` y `direct`, que se trabaja directo y que `/task` está disponible para riesgo; con `flow`, que se usa `/task`.

Evidencia (eval v2, `docs/EVAL.md`, **n=1 por celda y un solo repo**; diferencias pequeñas son ruido):

| Brazo | Qué es | Tests ocultos (de 436) | Coste de ejecución (10 celdas) | Coste con el setup repartido |
|---|---|---|---|---|
| D0 | modelo barato, sin plugin ni setup | 322 | $0.26 | $0.26 |
| D0s | modelo barato, sin plugin, con `/setup` | 343 | $0.26 | $0.75 |
| D1 | plugin completo, sin setup | 337 | $2.41 | $2.41 |
| D1v2 | plugin completo, con `/setup` | 333 | $2.12 | $2.61 |

Cómo leerlo: **n=1 por celda y un solo repositorio** (`thereelcapital`, 5 tareas, variantes ciega y con pista), así que diferencias de unos pocos tests o de unos centavos están dentro del ruido. Lo medido es solo "tests ocultos por dólar"; no mide lo que aportan los gates, la revisión o los bloqueos. El coste con setup reparte los 7 setups ($4.94 en total) entre 10 tareas. Detalle en [`docs/EVAL.md`](EVAL.md) (eval v2, issue #73).

Eval v3 (issue #79): D0 y D0s repetidos con n=3 por celda dieron 328,7 (rango 319–345) y 336,3 (329–343) tests de media: **el setup no mejora la calidad más allá del ruido** y la ventaja de v2 no se sostuvo. No se repitió D1 / D1v2 (con plugin).

Lectura honesta: en tests ocultos los brazos quedan en un rango parecido (322 a 343 de 436), y el flujo completo cuesta unas 8 veces más en ejecución que D0s. La eval no mide lo que el flujo aporta además de los tests (bloqueos, revisión), así que no demuestra que el modo con gates sobre; tampoco que el modo directo baste para tareas de riesgo. Por eso el directo es el defecto (coste y simplicidad), no porque se haya probado mejor.

## Cómo funciona por dentro

**Estado.** `.claude/workflow.json` es el estado del proyecto (versionado). `.claude/workflow/task.json` es la tarea activa (local, ignorada por git) con `status` (`planning` | `implementing` | `done`), `plan` y `sessionId`. El estado de gates va por `session_id` en `${CLAUDE_PLUGIN_DATA}/sessions/`; los hooks disparan en todas las sesiones del proyecto e ignoran el estado ajeno.

**Modelos por fase.** La sesión y el `implementer` usan el modelo de la sesión. `plan-check`, `reviewer` y `fixer` usan `strong_model` (opción de usuario del plugin; `opus` por defecto, `sonnet` selecciona las variantes `-sonnet`). El modelo fuerte se usa en el chequeo del plan, en la revisión cuando hay riesgo y en el segundo intento de corrección (D-009).

**Skills por fase.** Las skills de método viven en `skills/` y los agents las nombran en su frontmatter (`tdd` para el implementer, `blast-radius` para el reviewer, `diagnosing-bugs` para el fixer): el modelo no elige una skill de método. `/setup` carga `grilling`, `domain-modeling`, `technical-writing` y `create-verification-skill`; `contract-first` la nombran el `CLAUDE.md` generado y `/task`; `/done` carga `retro` y `maintain-verification-skill`.

**Gates.** Todo lo que bloquea es código en hooks (`hooks/hooks.json` → `bin/wf-hook.mjs` → `lib/hooks/`): `PreToolUse` (plan, guards), `PostToolUse` (aprobación del plan, texto de MCP como evidencia), `SubagentStop` y `Stop` (contrato, verify, revisión). Un hook nunca lanza: ante un error, log y salida vacía. Detalle en `hooks/README.md`.

**Portabilidad.** `/plugin marketplace add OnishellT/cc-improved` y `/plugin install cc-improved@cc-improved` bastan. Requisitos que no se pueden empaquetar: Node >= 22, git y `gh` para `/pr`. `/wf-doctor` los comprueba.

## Qué cambia respecto a pi-improved

- Plan mode nativo con `ExitPlanMode` como aprobación, en lugar de la herramienta `task_plan`.
- El implementer es un subagente nativo con gates por `SubagentStop`.
- Sin tmux, sin pi-subagent, sin agentlint obligatorio.
- Modelo fuerte solo en los agents; el resto usa el de la sesión.
- Núcleo en `lib/` sin importar nada del harness, reutilizable si el harness cambia.

## Pendiente

Ver `docs/RELEASE-0.1.0.md`: seguimiento de la eval, ajustes de skills y verificación en la TUI.
