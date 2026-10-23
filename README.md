# cc-improved

pi-improved para Claude Code: un modelo barato implementa dentro de un flujo gobernado por código, y el modelo fuerte entra solo donde paga (chequeo del plan, revisión con riesgo, escalado). Es un plugin de Claude Code que usa lo nativo: plan mode, subagentes con modelo propio, skills, hooks, permisos, MCP y coste.

**Versión 0.1.0, pre-release.** Funciona de punta a punta en modo headless (`claude -p`); la interfaz interactiva (TUI) no está verificada. Ver [Limitaciones conocidas](#limitaciones-conocidas).

## Requisitos

- Claude Code (probado con 2.1.309).
- Node >= 22 (los hooks y scripts corren con `node --experimental-strip-types`).
- git.
- `gh` solo para `/pr`.

El plugin es agnóstico de lenguaje: no trae comandos de verificación fijos (nada de `tsc` ni `eslint` por defecto). Todo sale de `.claude/workflow.json` del proyecto.

## Instalación

```
/plugin marketplace add OnishellT/cc-improved
/plugin install cc-improved@cc-improved
```

Al instalar, Claude Code pide `strong_model`, el modelo del chequeo del plan, la revisión y el escalado (`opus` por defecto; `sonnet` usa las variantes `-sonnet` de los agents, más baratas).

Notas de la instalación (spike 0.6, `docs/spikes/0.6-plugin-deps.md`): el plugin no tiene dependencias de runtime, pero Claude Code también instala las `devDependencies` del repo (`typescript`, `@types/node`) en la caché del plugin. Es un coste conocido, no un fallo.

## Flujo

```
/cc-improved:setup  →  /cc-improved:task <ticket|descripción|spec>  →  /cc-improved:done  →  /cc-improved:pr
```

(Los comandos se pueden escribir sin el prefijo si no chocan con otros.)

1. **`/setup`** (una vez por repo, con el mejor modelo disponible). Escanea el repo en código, te entrevista y deja `CLAUDE.md`, `GLOSSARY.md`, ADRs, skills de dominio, la skill `verify-app` y las herramientas de verificación. Termina con `.claude/workflow.json` (`setup: "done"`, `verify`, `tools`, `connectors`).
2. **`/task`** lee el ticket (por MCP si hay conector), la spec, los docs y el código, y propone un plan en plan mode con un bloque `wf-plan`: archivos, interfaz (nombres y firmas con su fuente), seams de prueba y decisiones. Antes de que lo apruebes, un hook comprueba el plan en código (nombres verificados contra su fuente, siempre) y, solo si el plan toca dependencias, migraciones o zonas sensibles (o el manifest pone `review.plan: true`), pide el chequeo del plan al modelo (`plan-check`, de solo lectura). Una tarea pequeña (hasta 8 archivos, 6 entradas de interfaz y 2 decisiones, sin riesgo) va por la ruta rápida, sin plan mode. Al aprobar, un subagente `implementer` (modelo de la sesión) implementa con contexto recortado.
3. **Gates en código.** Cuando el implementer o la sesión dan la tarea por terminada, los hooks `SubagentStop` y `Stop` no le creen: comprueban el contrato de interfaz, corren `verify` y, si el diff es de riesgo alto (o `review.always`), piden una revisión del modelo fuerte (`reviewer`); el riesgo bajo se registra en el resumen y no se revisa salvo `review.minLevel: "low"`. Un fallo reiterado escala al `fixer` con el modelo fuerte. Los guards de `PreToolUse` piden confirmación si el agente sale del plan, añade dependencias o crea migraciones.
4. **`/done`** cierra la tarea, guarda su ficha en `.claude/workflow/tasks.jsonl` (esa ficha va en el commit) y cada 5 tareas propone una retro.
5. **`/pr`** corre `verify`, rellena la plantilla de PR del repo con el informe, el riesgo y las ADRs nuevas, y solo hace `git push` y `gh pr create` cuando lo confirmas.

Otros comandos: `/verify` (corre a mano los comandos de `verify`), `/wf-doctor` (comprueba requisitos del plugin; no sustituye al `/doctor` nativo), `/wf` (panel de estado del mod opcional).

El detalle de las 10 etapas del flujo y de qué cubre cada una está en [`docs/WORKFLOW.md`](docs/WORKFLOW.md).

## Herramientas de verificación portables

`/setup` diseña contigo pequeñas herramientas de verificación dentro del repo (por defecto `tools/verify/`): cada una hace una sola cosa, tiene `--help` y devuelve código de salida más una salida corta. Declaran su runtime: `python` (Python 3 solo con biblioteca estándar) o `nix` (script más `shell.nix` o `flake.nix` que fija sus dependencias). El plugin no trae ninguna propia. Se registran en `.claude/workflow.json` (`tools`) y se documentan en la sección **Tools** de `.claude/skills/verify-app/SKILL.md`, para que el implementer, el fixer y el planificador las usen.

## Modelos por fase

| Fase | Quién | Modelo |
|---|---|---|
| `/setup`, `/task`, `/done`, `/pr` | sesión principal | el de la sesión (usa el más fuerte para `/setup`) |
| Implementación | agent `implementer` | el de la sesión (`inherit`) |
| Chequeo del plan | `plan-check` | `strong_model` (opus por defecto; `plan-check-sonnet` si es `sonnet`) |
| Revisión con riesgo | `reviewer` | `strong_model` |
| Escalado tras fallos | `fixer` | `strong_model` |

El modelo del frontmatter de un agent no admite `${user_config.*}` (spike 0.4), por eso hay una variante `-sonnet` de cada agent (D-005).

## Limitaciones conocidas

- **Probado en headless, TUI sin verificar.** Todo el flujo se ejecutó con `claude -p` y un host de permisos (`test/e2e/run.mjs`), no a mano en la interfaz interactiva. El diálogo `/plugin` tampoco se probó.
- **Plan mode en `-p`** no expone `ExitPlanMode` sin `--permission-prompt-tool stdio` (spike 0.1): la eval usa un host que aprueba y responde a las preguntas con la primera opción.
- **Dependencias.** Con `--plugin-dir` o un marketplace de carpeta local no se instalan `node_modules` (no hace falta: no hay dependencias de runtime). Con el marketplace de GitHub sí se instalan las `devDependencies`.
- **El mod (`/wf`, línea de estado) es opcional y early access**: la API cambia entre versiones. Si falla, el flujo no se entera (`mod/README.md`).
- **El reviewer no ejecuta herramientas.** Solo lee (`Read`, `Grep`, `Glob`) y recibe en el brief lo que `verify` y las herramientas ya reportaron.
- Solo Linux probado. No se probó macOS ni Windows.
- Seguimiento pendiente: ver [`docs/RELEASE-0.1.0.md`](docs/RELEASE-0.1.0.md).

## Resultados de la eval

Detalle y matices en [`docs/EVAL.md`](docs/EVAL.md) (issue #28, 5 tareas de un repo real, una ejecución por celda). Resumen: Claude Code con cc-improved (D1) frente a Claude Code sin plugin (D0) y frente a pi-improved (C+).

| | Tests ocultos (ciega) | Tests ocultos (con pista de interfaz) | Coste (ciega / con pista) |
|---|---|---|---|
| D0, sin plugin | 160/204 | 162/232 | $0.15 / $0.11 |
| C+, pi-improved | 151/204 | 182/232 | $2.57 / $1.74 |
| D1, cc-improved | 144/204 | 193/232 | $1.35 / $1.06 |

Lo que hay que leer con cuidado:

- **Con pista de interfaz D1 gana; ciega, no.** En la variante ciega, Claude Code sin plugin (D0) supera a D1 y a C+, y cuesta unas 9 veces menos que D1. Con pista, D1 supera a D0 en 31 tests, y casi toda esa diferencia sale de una tarea cuya ejecución terminó por un límite de sesión de la cuenta.
- **Una sola ejecución por celda:** diferencias de unos pocos tests están dentro del ruido.
- La mayoría de los tests ocultos de varias tareas ya pasan sin tocar nada (140 de 204 en la variante ciega); la ganancia sobre la base es más honesta: ciega D0 +20, C+ +11, D1 +4; con pista D1 +132, C+ +121, D0 +101.
- El criterio acordado (D1 >= C+ en tests con coste <= 1.5x) se cumple con pista y en el agregado (por muy poco), y no se cumple en la ciega. Los fallos de D1 son sobre todo nombres que el ticket no da y robustez ante entradas inválidas.
- Costes nominales (equivalentes a API; las cuentas son de suscripción).

## Desarrollo

```
npm ci && npm test && npm run typecheck && claude plugin validate .
claude --plugin-dir .    # carga el plugin en esta sesión
npm run e2e              # cuesta dinero (claude -p): fuera de CI
```

Evals de skills (cuestan unos centavos, fuera de CI): `evals/README.md`. Convenciones de trabajo: `docs/CONVENTIONS.md`; decisiones: `docs/DECISIONS.md`. Los hooks están en `hooks/README.md` y el mod en `mod/README.md`.

El plan completo, con las equivalencias nativas y las fases, está en el repo [pi-improved](https://github.com/OnishellT/pi-improved) (`docs/PLAN-claude-code.md`).

## Licencia

MIT. Las skills de método de `skills/` son vendorizadas (origen y licencias en `skills/README.md` y `skills/LICENSE-*`).
