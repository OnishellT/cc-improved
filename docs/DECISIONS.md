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

## D-008: recorte de costes A: revisión por nivel de riesgo, variante `-sonnet` por defecto y chequeo del plan solo si compensa

- **Contexto:** la eval (`docs/EVAL.md`) mostró que el gate pidió revisión en 10 de 10 tareas y que el modelo fuerte se usó en todas, sin que ese gasto se tradujera en tests.
- **Decisión:**
  - `assessRisk` devuelve `level` (`none|low|high`) con razones. `none`: sin revisión. `low`: revisión con `reviewer-sonnet`. `high`: revisión con el modelo fuerte (`reviewer`).
  - `high`: dependencias, migraciones, `review.paths`, zonas sensibles, o un diff de más de 600 líneas o 15 archivos. `low`: más de 200 líneas o 6 archivos, sin plan, o decisiones nuevas del usuario. Todo lo demás es `none`. Ante la duda se sube de nivel, nunca se baja. Los umbrales son configurables en `review` (`maxLines`, `maxFiles`, `highLines`, `highFiles`); `high` nunca queda por debajo de `low`.
  - `review.always` sigue ganando a `review.never` (D-007): nivel `high`. `review.never` da `none`.
  - `plan-check` y `reviewer` usan `-sonnet` salvo nivel `high` o `review.always`; entonces usan el modelo fuerte configurado (`strong_model`). Si `strong_model` es `sonnet`, todo va en sonnet. El `fixer` no cambia: solo corre tras fallos y sigue el modelo configurado. `strong_model` por defecto (`opus` en `plugin.json`) pasa a significar "a qué escalar", no "qué usar siempre".
  - El chequeo del plan solo se pide si el plan tiene más de 5 archivos, más de 3 entradas en `interface` o más de 1 decisión (`review.planFiles`, `planInterface`, `planDecisions`), con variante `-sonnet`; o si sus `files` tocan dependencias, migraciones, `review.paths` o zonas sensibles, o hay `review.always`, con el modelo fuerte. `review.plan: false` lo sigue desactivando.
- **Porqué esos umbrales:** los de tamaño de `none`/`low` son los que ya había (200 líneas, 6 archivos), así que un cambio pequeño sin triggers sigue sin revisión; lo nuevo es que el tramo medio ya no paga el modelo fuerte. Los de `high` (3 veces el tamaño de `low` en líneas, algo más de 2 veces en archivos) reservan el modelo fuerte a diffs que un revisor barato difícilmente cubre. Los del plan siguen el tamaño de los planes de la eval (2 a 4 archivos, 1 interfaz, 0 o 1 decisiones), que no necesitaban chequeo fuerte.
- **Consecuencia:** menos gasto en el modelo fuerte sin quitar revisión donde hay riesgo real. Los defaults son conservadores y se ajustan por proyecto en `review`. Pendiente fuera de este cambio: la descripción de `strong_model` en `.claude-plugin/plugin.json` sigue diciendo que es el modelo de los tres roles.

## D-009: recorte de costes B: ruta rápida sin plan mode, 2 bloqueos por verify y brief más corto

- **Contexto:** la eval mostró que plan mode con el alias `haiku` se factura como sonnet y que el gate reintentaba hasta 3 veces por verify. Para una tarea pequeña, plan mode y el diálogo de aprobación cuestan más que el plan.
- **Decisión:**
  - **Ruta rápida.** `skills/task/SKILL.md` decide si la tarea es pequeña: como mucho 5 archivos, 3 entradas de `interface` y 1 decisión, sin triggers de riesgo (dependencias, migraciones, zonas sensibles, `review.paths`, `review.always`) y con todos los nombres salidos del ticket, la spec o el código. El modelo escribe el plan en `.claude/workflow/plan.md` y `bin/wf-plan-validate.mjs` lo valida con las mismas puertas que el hook de `ExitPlanMode`: ambos llaman a `checkPlan` de `lib/plan-gate.ts` (parse, seams, specs, nombres contra la evidencia, decisiones), y el script añade el tamaño con `planCheckLevel`, los mismos umbrales que piden el chequeo del plan. Si pasa, guarda `task.json` en `implementing`; si no, devuelve los errores y, para planes grandes o de riesgo, manda a plan mode. No hay aprobación de la persona en esta ruta: es el precio de no abrir plan mode, y por eso el límite es estricto.
  - **Dos bloqueos, no tres.** El implementer/fixer se bloquea una vez por verify (arreglar, con el método de diagnóstico y permiso para terminar con `FAILED`) y sale con `FAILED` al segundo fallo (`RELEASE_AFTER = 2`). El orquestador (`Stop`) bloquea con "arreglar" y después con el `fixer`; al tercer fallo decide la persona. Se fusiona el paso de diagnóstico con el primer bloqueo: el `fixer` ya trae la skill `diagnosing-bugs`, así que un tercer intento barato del mismo modelo aportaba poco.
  - **Brief más corto.** Sin la línea `Task:` (el título está en el JSON), sin la sección de decisiones (están en `wf-plan` con su `answer`), `wf-plan` en una línea, sin el párrafo final (ya está en `agents/implementer.md`) y secciones vacías fuera.
- **Medición (brief tipo de 3 archivos, 1 interfaz, 1 seam, 1 decisión, 3 comandos de verify, 1 herramienta; tokens estimados como caracteres/4):** brief 1986 → 1217 caracteres (~497 → ~304 tokens, -39 %); brief + prompt del implementer 4205 → 3335 (~1051 → ~834, -21 %). El cuerpo de `/task` crece un 7 % (la ruta nueva), una vez por tarea.
- **Consecuencia:** una tarea pequeña no paga plan mode ni plan-check; un verify roto cuesta un bloqueo menos. Quien quiera la aprobación explícita siempre puede pedir plan mode. La ruta rápida depende de que `${CLAUDE_SESSION_ID}` y `${CLAUDE_PLUGIN_DATA}` se sustituyan en la skill para leer el texto del ticket capturado; si no, los nombres del ticket se rechazan y la tarea pasa a plan mode (falla hacia el lado seguro).

## D-010: `/setup` lo ejecuta una sola vez el modelo grande (opus)

- **Contexto:** el setup produce los artefactos que reutilizan todas las tareas (CLAUDE.md, herramientas de verificación, skills del proyecto, manifest); conviene que lo haga el modelo grande y una sola vez. `${user_config.*}` no se sustituye en `model:` (spike 0.4), así que el modelo no puede venir de la configuración.
- **Decisión:** `skills/setup/SKILL.md` lleva `model: opus` literal. Comprobado con `claude -p --plugin-dir . --model claude-haiku-5-5 --output-format json` (2.1.309): con `/cc-improved:setup` el `modelUsage` solo trae `claude-opus-5-5` (0,129 USD); un prompt de control sin la skill solo trae `claude-haiku-5-5` (0,002 USD). El `model` de la skill se respeta y el turno se factura a opus aunque la sesión sea haiku. La skill sigue en el hilo principal, así que `AskUserQuestion` funciona; no hace falta el fallback de un agent (los agents no pueden preguntar). Con `setup: "done"`, `/setup` avisa del coste y pide confirmación antes de repetir; `SessionStart` ya no lo ofrece en ese estado.
- **Consecuencia:** el override de la skill dura el turno en que se invoca; el modelo de la sesión vuelve después. Un setup repetido cuesta tokens de opus y exige confirmación. Si un cambio de Claude Code dejara de respetar `model` en skills, el test de frontmatter no lo detecta: hay que repetir la comprobación.

## D-011: el riesgo se mide contra el commit base de la tarea y se registra la decisión

- **Contexto:** la eval v2 (`docs/EVAL.md`) mostró que `assessRisk` y el gate medían con `git diff HEAD`: si el implementer dejaba commits, el diff salía vacío y el riesgo se subestimaba (pr58, pr53). Tampoco se guardaba el nivel ni las razones, así que no se sabía por qué se pedía revisión.
- **Decisión:**
  - `Task.baseCommit` (opcional, aditivo) guarda `git rev-parse HEAD` cuando la tarea entra en `planning` (hook de `ExitPlanMode`) o `implementing` (`bin/wf-plan-validate.mjs`), con la función compartida `withBaseCommit` de `lib/risk.ts`. Se conserva al reenviar el plan y al aprobarlo; si no había git entonces, se intenta de nuevo al aprobar.
  - `assessRisk`, la huella del working copy del gate (`fingerprint`), el brief de la revisión y los archivos que `/done` registra miden contra ese commit: commits + cambios sin commitear (`git diff <base>`) + archivos nuevos sin seguimiento (`ls-files --others`, uno por archivo aunque estén en carpetas nuevas).
  - Sin `baseCommit`, sin git, o si el commit ya no existe (`diffBase`), se mide contra `HEAD` como antes. El valor se valida como hash antes de pasarlo a git.
  - El gate de `Stop` guarda `review: { level, reasons, requested }` en el estado de sesión cada vez que evalúa el riesgo (se reinicia al cambiar de tarea) y lo añade al resumen final.
- **Consecuencia:** un diff commiteado por el implementer ya cuenta. El registro vive en el estado de sesión, no en `task.json`: así no se reescribe la tarea en cada Stop. `/done` no lo muestra todavía.


## D-012: defaults baratos: plan-check apagado, revisión solo con riesgo alto, ruta rápida más amplia

- **Contexto:** la eval v2 (`docs/EVAL.md`) mostró la revisión pedida en 10/10 tareas (siempre `-sonnet`) y el chequeo del plan en 6/10, sin que ninguno evitara los fallos de nombres y argumentos; sonnet fue el 63 % del coste de D1v2 ($1.33 de $2.12). Lo que sí atrapa esos fallos es la puerta determinista (nombres, seams, decisiones, contrato), que no cuesta tokens.
- **Decisión:**
  - `review.plan` pasa a apagado por defecto: el chequeo del plan con modelo solo se pide si el plan toca riesgo alto (`highRiskReasons`) o `review.always`; `review.plan: true` añade los planes grandes (chequeo barato); `review.plan: false` lo apaga siempre. La puerta determinista corre siempre.
  - `review.minLevel` (`low|high`, default `high`, aditivo): la revisión con modelo se pide solo con nivel `high` o `review.always`. El nivel `low` se registra (`review` del estado de sesión y resumen del gate) pero no pide revisión salvo `minLevel: "low"`. `always` gana a `never`, como antes.
  - Ruta rápida de `/task`: pequeña = como mucho 8 archivos, 6 entradas de interfaz y 2 decisiones, sin disparadores de riesgo ni `review.always` (antes 5/3/1, y además exigía que ningún nombre fuera nuevo). Los nombres nuevos ya los frena la puerta determinista, que pregunta a la persona en ambas rutas. `review.planFiles/planInterface/planDecisions` ajustan los umbrales.
- **Umbrales:** 8 archivos queda por debajo de `highFiles` (15) y cubre tareas de una funcionalidad con sus tests; 6 entradas de interfaz permite un módulo con varias funciones; 2 decisiones permite una decisión resuelta por fuente más una respondida por la persona. El riesgo (dependencias, migraciones, `review.paths`, zonas sensibles) sigue sacando la tarea de la ruta rápida sea cual sea su tamaño.
- **Consecuencia:** menos llamadas de sonnet por tarea; un diff mediano sin disparadores ya no se revisa con modelo (lo cubren contrato y verify). Quien prefiera el comportamiento anterior pone `review.minLevel: "low"` y `review.plan: true`.

## D-013: dieta de contexto: `/task` carga el detalle bajo demanda y los textos de los hooks van al grano

- **Contexto:** la eval v2 (`docs/EVAL.md`) mostró que el trabajo en haiku de D1v2 cuesta 3x el de D0s ($0.79 vs $0.26, ~18.8M tokens de caché leídos): el contexto se relee en cada turno, así que cada token fijo de una skill cargada se paga en todos los turnos siguientes. Medido con caracteres/4: `/task` (2606 tokens) era con diferencia lo más grande que se carga en cada tarea; los textos de los hooks y los prompts de los agents ya eran cortos (60-200 y 340-470 tokens).
- **Decisión:** `skills/task/SKILL.md` conserva lo que toda tarea usa (rutas, lectura, plantilla `wf-plan`, aprobación, brief, variantes de agent) con frases más cortas. Lo que solo hace falta a veces va a `skills/task/references/` y se lee al llegar a ese punto: `plan-rules.md` (nombres, firmas, seams y decisiones con ADR) y `after-implementer.md` (`BLOCKED`, `FAILED`, revisión). Las razones de bloqueo de los hooks (Stop, SubagentStop, SessionStart) y `DIAGNOSE_METHOD` pierden palabras, no información: cada mensaje sigue bastando para un subagente que no puede preguntar. La lista de archivos del plan sigue inyectándose una sola vez por agente y tarea.
- **Medición (tokens estimados como caracteres/4):** `/task` 2606 → 1856 (-29 %); las referencias (207 y 499) solo se leen cuando hacen falta. Razones de hooks: Stop verify 139 → 119, SubagentStop verify 199 → 175, SessionStart 108 → 98.
- **Consecuencia:** una tarea que necesita crear archivos o decidir paga un `Read` más (un turno) para leer `plan-rules.md`; una tarea simple con `DONE` no lo paga. Ninguna puerta ni formato cambia. `setup` (opus, una vez) y los mensajes de `lib/plan-gate.ts` quedan sin tocar.
