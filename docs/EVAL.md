# Eval M3: A / C+ / D0 / D1 (issue #28)

Fecha: 2026-10-23. Coste total: **$7.61** (tope duro: $9). Plugin medido: `cc-improved` en `origin/main` **`eb40650a3e459d73c3945e251db1bc0c5a3ea45a`**, sin cambios durante la eval. pi-improved medido: HEAD **`05c4d25`** (copia de solo lectura).

## Resumen

| Brazo | Variante | Tareas | Tests ocultos | Ganancia sobre la base | Coste | Tiempo medio |
|---|---|---|---|---|---|---|
| A (pi + gpt-6-astra, sin extensiones) | ciega | 1 (pr58) | 4/20 | +4 | $0.62 | 168 s |
| C+ (pi-improved HEAD, luna + astra) | ciega | 5 | 151/204 | +11 | $2.57 | 258 s |
| D0 (Claude Code sin plugin, haiku) | ciega | 5 | 160/204 | +20 | $0.15 | 118 s |
| D1 (Claude Code + cc-improved, haiku + sonnet) | ciega | 5 | 144/204 | +4 | $1.35 | 306 s |
| C+ | con pista | 5 | 182/232 | +121 | $1.74 | 201 s |
| D0 | con pista | 5 | 162/232 | +101 | $0.11 | 80 s |
| D1 | con pista | 5 | 193/232 | +132 | $1.06 | 263 s |

"Ganancia sobre la base": tests ocultos que pasan menos los que ya pasaban en el commit base sin tocar nada. En pr53, pr198 y pr223, la mayoría de los tests ocultos ya pasan en la base (140 de los 204 de la variante ciega), así que la columna de tests sola exagera lo que hace cada brazo.

**Veredicto contra el criterio** (D1 ≥ C+ en tests, con coste ≤ 1.5× C+):

- **Con pista: se cumple.** 193 contra 182 tests y $1.06 contra $1.74 (0.61×).
- **Ciega: no se cumple.** 144 contra 151 tests. El coste sí cumple: $1.35 contra $2.57 (0.53×).
- **Agregado: se cumple por muy poco.** 337 contra 333 tests y $2.41 contra $4.31 (0.56×).

Hay una sola ejecución por celda, así que diferencias de unos pocos tests están dentro del ruido. El resultado incómodo: **en la variante ciega, Claude Code sin plugin (D0) gana a D1 y a C+**, y cuesta unas 9 veces menos que D1. Con pista, D1 supera a D0 en 31 tests. Casi toda esa diferencia sale de pr51, y esa ejecución de D1 terminó por un límite de la cuenta (ver más abajo). Los fallos de D1 de la variante ciega vuelven a M2 (lista al final).

## Detalle por tarea

Columnas: tests ocultos que pasan / total, coste y tiempo. "base" son los tests que pasan sin cambios.

### Ciega

| Tarea (issue) | base | A | C+ | D0 | D1 |
|---|---|---|---|---|---|
| pr58 (#6 order guards) | 0/20 | 4/20, $0.62, 168 s | 3/20, $0.61, 207 s | 0/20, $0.03, 98 s | 0/20, $0.27, 301 s |
| pr53 (#52 calendario con librería) | 10/11 | (10/11, $1.27)* | 10/11, $0.47, 247 s | 10/11, $0.03, 87 s | 10/11, $0.23, 378 s |
| pr198 (#192 SIZE por la regla de dominio) | 69/72 | n/m | 71/72, $0.28, 303 s | 69/72, $0.04, 203 s | 69/72, $0.32, 275 s |
| pr84 (#8 stop y trailing) | 0/23 | (10/23, $0.80)* | 6/23, $0.61, 292 s | 9/23, $0.02, 87 s | 4/23, $0.21, 285 s |
| pr223 (#222 renombrar cliente) | 61/78 | n/m | 61/78, $0.60, 243 s | 72/78, $0.03, 114 s | 61/78, $0.31, 290 s |

\* Dato histórico del brazo A en la eval anterior de pi-improved (2026-10-21): mismo ticket, mismo commit base y mismo `grade2.sh`. No entra en el coste de esta eval. n/m: no medido.

### Con pista de interfaz

| Tarea (issue) | base | C+ | D0 | D1 |
|---|---|---|---|---|
| pr58 (#6) | 0/20 | 20/20, $0.24, 159 s | 20/20, $0.02, 70 s | 20/20, $0.19, 228 s |
| pr84 (#8) | 0/23 | 16/23, $0.16, 153 s | 14/23, $0.02, 54 s | 16/23, $0.19, 216 s |
| pr223 (#222) | 61/78 | 69/78, $0.52, 251 s | 70/78, $0.04, 144 s | 70/78, $0.30, 311 s |
| pr51 (#5 tamaño de entrada) | 0/85 | 54/85, $0.69, 247 s | 38/85, $0.02, 57 s | 70/85, $0.19, 297 s (límite de sesión) |
| pr64 (#7 scale-out) | 0/26 | 23/26, $0.13, 197 s | 20/26, $0.02, 76 s | 17/26, $0.19, 263 s |

## Montaje

- **Repo:** clon de `OnishellT/thereelcapital` en el scratchpad de la sesión, sin remote. Cada brazo, variante y tarea tiene su propio clon en el commit base del PR, más un commit "eval setup" con el ticket en `docs/tickets/issue-<n>.md` (en la variante con pista, también la pista) y el manifiesto del brazo. Nunca se tocó el repo real.
- **Corrección:** `grade2.sh` y `shim.py` de la eval anterior, sin cambios. Se copian los tests del PR mergeado. Un módulo con otro nombre en el mismo directorio se re-exporta con un shim, y cada export que falta se convierte en un stub que falla solo los tests que lo usan.
- **Variante con pista:** al ticket se le añade un bloque "Interface (hint)" con los archivos, exports y firmas que importan los tests ocultos y que no existían en la base. Incluye los tipos que esas firmas usan y no los valores de las constantes largas. Se generó a partir del merge (`hint.py`). En pr53 y pr198 no hay nombres nuevos, así que la pista sería idéntica al ticket y no se ejecutaron.
- **Brazos:**
  - **A:** `pi -p --mode json --no-session --no-extensions --no-skills --no-prompt-templates --provider openai --model gpt-6-astra`, con el ticket en el prompt.
  - **C+:** pi-improved en `05c4d25`, en un directorio de agente limpio. La sesión corre con `gpt-6-luna`; el chequeo del plan, la revisión y el escalado con `gpt-6-astra`. Se dirige con el mismo driver RPC de la eval anterior: `/task Ticket #n: <título>. La especificación completa está en docs/tickets/issue-n.md`. El manifiesto es `.pi/workflow.json` con `setup: done` y `verify: ["bun test"]`.
  - **D0:** `env -u CLAUDECODE claude -p --model claude-haiku-5-5 --permission-mode acceptEdits --max-budget-usd 1 --output-format json --setting-sources project --strict-mcp-config --settings '{"permissions":{"allow":["Bash","Read","Edit","Write","Glob","Grep"]}}'`, con el mismo prompt que A.
  - **D1:** los mismos flags, más `--plugin-dir <worktree>` y `strong_model: sonnet`, con el prompt `/cc-improved:task Ticket #n: <título>. Spec: docs/tickets/issue-n.md`. El manifiesto es `.claude/workflow.json` con `setup: done` y `verify: ["bun test"]`.
- **D1 y plan mode en `-p`:** D1 corre bajo el host de permisos de `test/e2e/run.mjs` (spike 0.1), porque sin `--permission-prompt-tool stdio` no existe `ExitPlanMode`. El host aprueba todo y responde cada `AskUserQuestion` con la primera opción (la recomendada).
- **Sin `/setup`:** ni C+ ni D1 ejecutaron `/setup` (costaba $2.33 en la eval anterior). Los dos parten solo del manifiesto y del `CLAUDE.md` del repo, en igualdad de condiciones. Por eso C+ no es directamente comparable con el "C 19/121" anterior, que sí tenía AGENTS.md, glosario y ADRs.
- **Coste:**
  - **A:** suma de `usage.cost` de cada mensaje.
  - **C+:** fases + chequeo del plan + revisiones de `.pi/metrics`, que incluyen los subagentes de astra.
  - **D0 y D1:** `total_cost_usd`, que incluye los subagentes.
  - Los costes de OpenAI y Anthropic son nominales, equivalentes a API: las dos cuentas son de suscripción.
- **Tiempo:** reloj de pared de la ejecución, sin contar la corrección.

## Qué se recortó y por qué

El piloto (pr58, ciega, los cuatro brazos) costó $1.53: A $0.62, C+ $0.61, D0 $0.03 y D1 $0.27. A ese ritmo, 10 tareas × 2 variantes × 4 brazos salen unos $30, muy por encima del tope de $8 a $9. Recortes:

1. **De 10 tareas a 7, y de 20 celdas a 10 por brazo:** 5 tareas en la variante ciega (pr58, pr53, pr198, pr84, pr223) y 5 con pista (pr58, pr84, pr223, pr51, pr64).
2. **Brazo A solo en el piloto.** Es el brazo más caro, a unos $0.62-1.27 por tarea, y no entra en el criterio. Para pr53 y pr84 se citan los resultados históricos, marcados con *.
3. **Sin pista en pr53 ni pr198:** no tienen nombres nuevos y la pista sería idéntica al ticket.
4. **El criterio de selección no se pudo cumplir al pie de la letra.** De los PRs de thereelcapital con tests que corre `bun` y que fallan en la base, solo 3 (pr53, pr58 y pr198) usan nombres que el ticket da o que ya existen. pr58 cuenta solo si se ignoran los nombres de tipos, que en runtime no cuentan. El resto importa nombres que el ticket no da: `parseMicros`, `availableQty`, `renameClient`, `validateStopPct`, etc. Los PRs del engine usan Vitest con workers y quedaron fuera. Por eso la variante con pista es la que cumple el requisito "solo nombres que el ticket da": la pista los da.

## Fallos de D1, clasificados

| Celda | Resultado | Clase | Qué pasó |
|---|---|---|---|
| ciega pr58 | 0/20 | nombres + forma de argumentos | Los códigos de rechazo no están en el ticket (`NOT_SIM` en vez de `MODE_NOT_SIM`). `mode` va en `context` y no en `request`, y las cuentas van como lista en vez del objeto `account`. `canReserveEntry` y `canReserveSlot` devuelven `GuardResult` en vez de `boolean`. El chequeo del plan (sonnet) no lo detectó: los códigos no son exports, así que el gate de nombres no los ve. |
| ciega pr84 | 4/23 | nombres (archivo y exports) | `nextTrailing` y `trailingEligible` van a un `trailing.ts` nuevo, pero los tests los importan de `stop.ts` (el ticket no nombra el archivo). `validate*Pct`, `activateTrailing` y `DEFAULT_*` no están en el ticket. |
| ciega pr223 | 61/78 (= base) | nombres | El gate funcionó: el plan no tenía fuente para los nombres y D1 preguntó con `AskUserQuestion`. Su opción recomendada (`updateClientName` y `validateClientName`) era la equivocada; la segunda (`renameClient`) era la buena. El host elige la primera. D0, sin preguntar, acertó `normalizeClientName` y `renameClient` (72/78). |
| ciega pr198 | 69/72 (= base) | nombres / forma | No pasa el SIZE mínimo desde el `load` (`minSizeUsd` en `ClientDetail`), aunque el ticket lo pide sin dar el nombre. C+ sí lo hizo (71/72). |
| ciega pr53 | 10/11 (= base) | requisito no explícito | El test de festivos NYSE 2026/2027 falla igual en los cuatro brazos. Además, el implementer creó una rama y commits (lo pide el CONTRIBUTING del repo); no afecta a la nota. |
| con pista pr84 | 16/23 | verify / revisión (robustez) | Los validadores no rechazan valores fraccionarios ni fuera de rango, y `stopLevel` y `shouldExit` no lanzan con entradas inválidas. El ticket lo pide ("Out-of-set … are rejected"). Los tests propios no lo cubren y el reviewer no lo marcó. |
| con pista pr223 | 70/78 | verify / revisión (robustez) | `normalizeClientName` no recorta; no rechaza el nombre vacío, solo espacios, demasiado largo o con salto de línea. No es un no-op sin auditoría cuando el nombre no cambia, y no falla ante un cambio concurrente. C+ y D0 fallan casi lo mismo. |
| con pista pr51 | 70/85 | plugin/harness + decisión | La ejecución terminó con `is_error: true` y "You've hit your session limit" (límite de la cuenta de Claude, no del plugin), después de lanzar el reviewer. Fallan además `formatUsd` (la persona simulada eligió "2 decimales siempre"), el rechazo de dinero inválido y `BELOW_MINIMUM`. |
| con pista pr64 | 17/26 | lógica / robustez | Los pasos pendientes no cuentan en el ledger, `done_zero` falla, el redondeo al incremento de equities es incorrecto y no valida el índice. C+ hizo 23/26 con la misma pista. |

Recuento: nombres o forma de argumentos, 4 celdas, todas en la variante ciega. Verify/revisión (robustez de entradas inválidas que ni los tests propios ni el reviewer cubren), 3. Plugin/harness, 1 (límite de sesión). Requisito no explícito, 1.

### Lo que hizo el plugin en las 10 ejecuciones de D1

En las 10, sin excepción:

- El primer `ExitPlanMode` se denegó para exigir el chequeo del plan (opción B), y después corrieron `plan-check-sonnet`, el `implementer` y `reviewer-sonnet`.
- Ningún bloqueo de verify ni de contrato: el implementer siempre terminó con `bun test` en verde.
- El gate de nombres no denegó ningún plan. En los casos sin nombres en el ticket, el modelo preguntó antes, por su cuenta.

## Para M2 (lo que vuelve a la fase 2)

1. **Nombres que el ticket no da (ciega).** Cuando no hay fuente, el gate pregunta, pero la opción recomendada la elige el modelo barato, y en pr223 recomendó la equivocada. Ideas: que el chequeo del plan con el modelo fuerte proponga y ordene los nombres antes de preguntar, o que los valores literales que el código expone (códigos de error, uniones de strings) entren en `interface` y pasen por el mismo gate.
2. **Forma de argumentos y de retorno (pr58).** El chequeo del plan no comparó la forma con los callers ni con las docs del dominio (`docs/domain-rules.md`). El brief no le pide la forma de retorno.
3. **Robustez de entradas inválidas (pr84, pr223, pr51).** Los seams del plan no exigen un test por cada criterio de "se rechaza" del ticket, aunque `skills/task` lo dice. Ni el `SubagentStop` ni el reviewer lo comprueban. Candidato: un chequeo en código que exija un seam que cite cada línea de aceptación con "rejected", "throws" o "invalid".
4. **Coste de la revisión.** El gate pidió revisión en 10 de 10 tareas, mientras que C+ la omitió por bajo riesgo en 4 de 10. Revisar la política de riesgo (`lib/risk.ts`): con `verify` en verde y un diff pequeño, D1 paga sonnet dos veces por tarea, y ese gasto no se tradujo en tests.
5. **Archivo destino (pr84).** Cuando el ticket no nombra el archivo, la regla "un módulo por sustantivo del ticket" llevó a crear `trailing.ts` en vez de ampliar `stop.ts`.

## Bugs y notas del plugin (sin cambios en esta PR)

- Ningún bug bloqueante: el flujo completo (plan → chequeo → aprobación → implementer → verify → revisión) funcionó en las 10 ejecuciones de D1 en `-p` con el host.
- **El gate no ve los valores.** Los códigos de rechazo y otros valores literales que importan los tests no son exports, así que nunca pasan por la verificación de nombres. Es un hueco de diseño, no un bug.
- **Decisiones fuera de ADR.** En pr223 las decisiones citaron `docs/decisions.md`, un archivo del repo que D1 también modificó, en vez de una ADR nueva. La fuente de un nombre puede ser un archivo que el propio plan escribe.
- **Estado residual.** El estado de sesión de las ejecuciones queda en `~/.claude/plugins/data/cc-improved-inline/`, igual que con `npm run e2e`.

## Reproducir

Los scripts quedaron en el scratchpad de la sesión (`eval-run/tools/`), no en el repo; el issue no pide scripts bajo `evals/`:

- `find-tasks.py` y `measure.sh`: selección de tareas.
- `hint.py`: genera la pista.
- `prep.sh`: crea cada copia.
- `run.sh`: ejecuta un brazo, una variante y una tarea, y corrige.
- `host.mjs`: host de permisos.
- `cost.py`: coste de cada ejecución.
- `grade2.sh` y `shim.py`: copiados de la eval anterior.

Los resultados crudos (streams, logs, notas por celda) no se suben.
