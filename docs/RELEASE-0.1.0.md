# Release 0.1.0 (pre-release): instalación limpia, evals de skills y seguimiento

Issue #31. Claude Code 2.1.309, Node 22.23.2, Linux, 2026-10-23. La release es un **pre-release**: el orquestador crea el tag `v0.1.0` y la release de GitHub tras el merge; esta PR no los crea.

## Instalación limpia (marketplace git local)

Script: [`clean-install.sh`](clean-install.sh). `CC_CREDENTIALS=<.credentials.json> docs/clean-install.sh <carpeta vacía>`.

- **Montaje.** `CLAUDE_CONFIG_DIR` vacío (0 entradas al empezar) dentro del scratchpad. El `HEAD` de la rama `issue-31-release` se sirve por git smart-HTTP local, igual que en el spike 0.6 (`marketplace add` rechaza `file://`), así que `marketplace add` usa el mismo camino de git que un repo de GitHub. Para las sesiones con modelo se copió `.credentials.json` a la config aislada (solo credenciales: sin ajustes, plugins ni historial) y se borró al terminar.
- **Instalación (sin modelo, $0).** `claude plugin marketplace add http://127.0.0.1:8767/cc-improved.git` y `claude plugin install cc-improved@cc-improved` terminaron bien. `claude plugin list`: `cc-improved@cc-improved`, versión `0.1.0`, scope user, habilitado. La caché `plugins/cache/cc-improved/cc-improved/0.1.0/` tiene el repo completo (`agents`, `bin`, `hooks`, `lib`, `mod`, `skills`, `test`, `docs`, `evals`...) y un `node_modules` con `typescript` (las `devDependencies` se instalan, como dice el spike 0.6). `claude plugin validate` sobre la copia instalada: pasa. El instalador avisó: `1 userConfig option not yet set` (`strong_model`); sin configurarlo usa el valor por defecto.
- **Hooks (sin modelo).** `SessionStart` ejecutado con la copia instalada en un repo sin manifiesto devuelve el aviso «This project has no workflow manifest... offer to run /setup first».
- **Sesión con modelo** (`claude -p --model claude-haiku-5-5`, sin `--plugin-dir`): `/cc-improved:wf-doctor` carga y corre desde la caché: Node 22.23.2, git, `gh`, 7 agents cargados, y avisa de que falta el manifiesto. Coste $0.003.
- **Flujo corto, `/task` y `/done`** (`test/e2e/run.mjs` con tres cambios: sin `--plugin-dir`, `--setting-sources user,project` y la ruta de datos de la config aislada; el modelo de la sesión es haiku y `strong_model` es `sonnet`). El stream confirma que el plugin se cargó desde `config/plugins/cache/cc-improved/cc-improved/0.1.0`. Resultado: 11 de 13 comprobaciones OK. Se vio de verdad el chequeo del plan solicitado por el hook, `plan-check` lanzado y su veredicto registrado, plan aprobado y tarea en `implementing`, `implementer` lanzado y que pasó el gate, revisión pedida por riesgo, `reviewer` lanzado y su veredicto registrado, y `/done` escribió la ficha en `tasks.jsonl`. Coste $0.094.
- **Las dos comprobaciones que fallan no son fallos del plugin:** «plan denied for an invented name» y «implementer blocked by the gate» esperan que el modelo barato cometa un error (inventar un nombre, entregar código que no pasa verify). Esta vez no lo cometió, así que no había nada que bloquear. El e2e las cuenta como MISS porque quiere ver ese camino de bloqueo; esa parte sigue cubierta por los tests con fixtures y por la eval M3.
- **Coste total de esta PR:** unos $0.105 (instalación y flujo $0.097, primera corrida de las evals de skills $0.008). Tope previsto $0.50.

## Evals de skills

`evals/` tiene 3 casos (`claude plugin eval`, ver `evals/README.md`) con graders gratuitos. Primera corrida (`--ablation none`, una ejecución por caso, haiku): **3 de 3 casos con puntuación 1.0, coste $0.0079, 26 s**. Los casos y los graders se escribieron antes de correrlos y no se ajustaron después. Una sola ejecución por caso no mide estabilidad: `--runs 3` la mide, a un coste de unos $0.02.

## Lo que NO se pudo probar

- **Marketplace remoto `OnishellT/cc-improved`.** Solo puede probarse tras el merge (el repo remoto aún no tiene esta rama en `main`). Queda para el orquestador: `CLAUDE_CONFIG_DIR=<vacío> claude plugin marketplace add OnishellT/cc-improved` y `claude plugin install cc-improved@cc-improved`, y repetir los pasos 3 a 6 del script.
- **La TUI interactiva:** el diálogo `/plugin`, `/plugin configure`, el prompt de `strong_model` al instalar, plan mode con aprobación a mano y el mod (`/wf`, línea de estado). Todo se probó con `claude -p` y un host de permisos.
- **`/setup` completo.** Su coste (unos $2 en la eval anterior) excede el tope. Los e2e parten de un manifiesto escrito a mano.
- **Una máquina distinta, macOS, Windows**, y la instalación sin red o sin `npm` en el PATH.
- **Estabilidad de las evals de skills** (una sola ejecución) y el brazo sin plugin (`--ablation with-without`).

## Seguimiento pendiente (issues sin abrir)

1. **Fallos de D1 en `docs/EVAL.md`.** La lista «Para M2» sigue abierta: nombres que el ticket no da (el modelo barato elige la opción recomendada y puede equivocarse), forma de argumentos y de retorno, robustez ante entradas inválidas (un seam por cada criterio «se rechaza»), política de revisión (`always` cuesta en 10 de 10 tareas), archivo destino cuando el ticket no lo nombra. La eval ciega no cumple el criterio.
2. **`maintain-verification-skill` debería editar `tools`.** La skill propone parches a la skill de verificación y a `verify`, pero no al campo `tools` de `.claude/workflow.json` ni a los scripts de `tools/verify/`.
3. **Descripción de `wf-doctor` sin el check nuevo.** El `description` de `skills/wf-doctor/SKILL.md` lista Node, git, gh, manifest, verify, agentlint y agents, pero no el chequeo de herramientas de verificación que añadió `/setup`.
4. **El reviewer no ejecuta herramientas.** Solo tiene `Read`, `Grep` y `Glob`: confía en lo que `verify` y las herramientas reportaron en su brief. Hay que decidir si debe poder correrlas.
5. **`devDependencies` en el usuario final.** Quien instala descarga `typescript` y `@types/node` (spike 0.6, «Fuera de alcance»).
6. **`package.json` sigue en `0.0.0`.** La versión del plugin es la de `.claude-plugin/plugin.json` (`0.1.0`); `package.json` es privado y no se tocó para no salirse del alcance de esta PR.
7. **Verificación en la TUI** y en una segunda máquina (ver arriba).
