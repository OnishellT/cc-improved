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
4. **Coste de la revisión.** El gate pidió revisión en 10 de 10 tareas, mientras que C+ la omitió por bajo riesgo en 4 de 10. Revisar la política de riesgo (`lib/risk.ts`): con `verify` en verde y un diff pequeño, D1 paga sonnet dos veces por tarea, y ese gasto no se tradujo en tests. _Seguimiento (#67, D-008): la revisión pasa a niveles `none|low|high`, `plan-check` y `reviewer` usan `-sonnet` salvo riesgo alto, y el chequeo del plan solo se pide en planes grandes o de riesgo. No se midió de nuevo; falta repetir la eval para confirmar el ahorro._
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

---

# Eval v2: D0s y D1v2, con setup hecho una vez por opus (issue #73)

Fecha: 2026-10-23. Coste total: **$7.32** (tope duro: $9): setups $4.94, D0s $0.26, D1v2 $2.12. Plugin medido: `cc-improved` en `origin/main` **`ed78bbc9ba45a10833ce712240f9269d89e337c9`** (con #67, #68 y #69), sin cambios durante la eval. Reutiliza los datos de la eval anterior (D0 y D1 de arriba): no se repitieron ni A ni C+. Mismas 10 celdas, mismo grader (`grade2.sh` y `shim.py`) y mismos tickets y pistas.

**Hay una sola ejecución por celda (n=1).** Diferencias de unos pocos tests, o de unos centavos, están dentro del ruido. Además, las ejecuciones de v2 se lanzaron de 4 a 8 a la vez para ahorrar reloj; el tiempo de pared no es comparable con el de v1.

## Resumen

| Brazo | Setup | Tareas | Tests ocultos | Coste ejecución | Coste con setup/10 | Tiempo medio |
|---|---|---|---|---|---|---|
| D0 (v1: haiku, sin plugin, sin setup) | no | 10 | 322 | $0.26 | $0.26 | 99 s |
| D0s (haiku, sin plugin, con setup) | sí | 10 | 343 | $0.26 | $0.75 | 93 s |
| D1 (v1: plugin, sin setup, sin recortes) | no | 10 | 337 | $2.41 | $2.41 | 285 s |
| D1v2 (plugin actual, con setup) | sí | 10 | 333 | $2.12 | $2.61 | 294 s |

"Coste con setup/10" suma a cada tarea la décima parte del coste de los 7 setups ($4.94 / 10 = $0.49). Con 20 tareas por proyecto serían $0.25 por tarea: D0s $0.51 y D1v2 $2.37 por 10 celdas. Los tests ocultos suman las 10 celdas (ciega 5 + con pista 5); el total posible es 436.

Por variante:

| Brazo | Ciega: tests | Ciega: coste | Con pista: tests | Con pista: coste |
|---|---|---|---|---|
| D0 (v1) | 160/204 | $0.15 | 162/232 | $0.11 |
| D0s | 160/204 | $0.15 | 183/232 | $0.11 |
| D1 (v1) | 144/204 | $1.35 | 193/232 | $1.06 |
| D1v2 | 147/204 | $1.31 | 186/232 | $0.81 |

## Detalle por celda

Tests ocultos que pasan / total, coste y tiempo. "base" son los tests que pasan sin tocar nada. Los valores de D0 y D1 son los de la eval anterior.

### Ciega

| Tarea | base | D0 (v1) | D0s | D1 (v1) | D1v2 |
|---|---|---|---|---|---|
| pr58 (#6) | 0/20 | 0/20, $0.03 | 3/20, $0.02, 85 s | 0/20, $0.27 | 1/20, $0.13, 268 s |
| pr53 (#52) | 10/11 | 10/11, $0.03 | 10/11, $0.03, 107 s | 10/11, $0.23 | 10/11, $0.24, 378 s |
| pr198 (#192) | 69/72 | 69/72, $0.04 | 70/72, $0.04, 145 s | 69/72, $0.32 | 69/72, $0.38, 446 s |
| pr84 (#8) | 0/23 | 9/23, $0.02 | 10/23, $0.02, 70 s | 4/23, $0.21 | 6/23, $0.22, 288 s |
| pr223 (#222) | 61/78 | 72/78, $0.03 | 67/78, $0.04, 141 s | 61/78, $0.31 | 61/78, $0.34, 380 s |

### Con pista

| Tarea | base | D0 (v1) | D0s | D1 (v1) | D1v2 |
|---|---|---|---|---|---|
| pr58 (#6) | 0/20 | 20/20, $0.02 | 20/20, $0.02, 62 s | 20/20, $0.19 | 20/20, $0.12, 197 s |
| pr84 (#8) | 0/23 | 14/23, $0.02 | 14/23, $0.02, 55 s | 16/23, $0.19 | 17/23, $0.11, 177 s |
| pr223 (#222) | 61/78 | 70/78, $0.04 | 70/78, $0.04, 111 s | 70/78, $0.30 | 70/78, $0.29, 328 s |
| pr51 (#5) | 0/85 | 38/85, $0.02 | 59/85, $0.02, 75 s | 70/85, $0.19 (límite de sesión) | 61/85, $0.19, 300 s |
| pr64 (#7) | 0/26 | 20/26, $0.02 | 20/26, $0.02, 71 s | 17/26, $0.19 | 18/26, $0.11, 172 s |

## Coste del setup

Se corrió `/cc-improved:setup` (modelo `claude-opus-5-5`, por el `model: opus` de la skill) una vez en una copia de cada commit base de la eval. Son 7 copias, no 5: el repo es siempre `thereelcapital`, pero cada tarea parte de un commit base distinto, y un `CLAUDE.md` o unas skills escritos sobre código posterior habrían filtrado el futuro a las tareas viejas.

| Copia (base de) | Coste | Turnos | Tiempo | Celdas que la usan |
|---|---|---|---|---|
| pr58 | **$0.98** ($0.61 + $0.37 de reanudación) | 14 + 7 | 90 s + 37 s | ciega y pista |
| pr53 | $0.59 | 15 | 97 s | ciega |
| pr198 | $0.77 | 18 | 108 s | ciega |
| pr84 | $0.68 | 15 | 101 s | ciega y pista |
| pr223 | $0.71 | 14 | 111 s | ciega y pista |
| pr51 | $0.52 | 13 | 85 s | pista |
| pr64 | $0.69 | 16 | 104 s | pista |
| **Total** | **$4.94** (media $0.71, de $0.52 a $0.98) | | | |

Todo el gasto es de `claude-opus-5-5`; ninguno superó el máximo de $3. Amortizado: $0.49 por tarea con 10 tareas y $0.25 con 20.

### Piloto y proyección

El piloto (pr58) costó $0.61 y quedó a medias (ver más abajo): $0.98 al reanudarlo. Con eso se proyectó para 5 setups unos $4.9, más D0s (~$0.04 por celda) y D1v2 (~$0.25 por celda, por la eval v1), unos $7.5 con 10 celdas: cabía bajo $9. Se hicieron primero los 4 setups restantes de la variante ciega y las 8 celdas que cubren; con $5.8 gastados quedaban $3.2, y se vio que cabían los setups de pr51 y pr64 ($1.2) y sus 4 ejecuciones ($0.5), hasta $7.3.

### Cómo se resolvió el setup en `-p`

- **Sin entrevista.** El prompt (`/cc-improved:setup MODO NO INTERACTIVO ...`) dice que no hay interlocutor, prohíbe `AskUserQuestion` y da las respuestas: idioma Español, sin conectores, sin agentlint, `verify = bun test`, una sola herramienta python en `tools/verify/` con `--help`, como mucho 3 skills de dominio, glosario corto y terminar el paso 9 sin pedir confirmación. El dominio lo deduce del código y de `docs/`, y lo no resuelto queda anotado en `CLAUDE.md`. Texto en el scratchpad (`eval-v2/tools/setup-prompt.txt`).
- **Permisos.** Con `--permission-mode acceptEdits`, la primera ejecución no pudo escribir en `.claude/skills/` (Claude Code protege `.claude/`, aunque `Write` estuviera permitido en `--settings`). Dejó el setup en `pending`, lo dijo con claridad y no intentó saltarse el bloqueo. Se reanudó con `--permission-mode bypassPermissions` y terminó en `setup: done`. Los otros seis setups se hicieron directamente con `bypassPermissions`, que es lo que hace falta para correr `/setup` en `-p`.
- **Qué generó** en cada copia (el repo ya traía `CLAUDE.md` y 4 skills): `CLAUDE.md` ampliado (de 56 a 64-98 líneas), `verify-app`, 1 skill `domain-*` (4 en pr198), de 1 a 3 ADR sacados del código, `GLOSSARY.md` (en algunas copias), una herramienta python estándar (`tools/verify/unit_tests.py`; `run_tests.py` en pr51), y `.claude/workflow.json` con `setup: done`, `verify: ["bun test"]` (en pr198, `bun test ./src/lib ./scripts`) y la herramienta. No se usaron herramientas `nix` (el repo no tiene nada que lo pida). No hay lint, typecheck ni build en estas bases, así que la herramienta solo envuelve `bun test` y resume el resultado en una línea JSON. Los documentos salieron en inglés, no en español: el `CLAUDE.md` del repo exige docs en inglés y el modelo lo antepuso.

## Revisión, ruta rápida y plan mode en D1v2

| Celda | Camino | plan-check | Revisión pedida |
|---|---|---|---|
| ciega pr58 | `wf-plan-validate` y después plan mode | no | `reviewer-sonnet` |
| ciega pr53, pr198, pr223, pr84 | plan mode | `plan-check-sonnet` | `reviewer-sonnet` |
| pista pr223, pr51 | plan mode | `plan-check-sonnet` | `reviewer-sonnet` |
| pista pr84 | plan mode | no | `reviewer-sonnet` |
| pista pr58, pr64 | **ruta rápida** (`wf-plan-validate`, sin plan mode) | no | `reviewer-sonnet` |

- **Revisión:** se pidió en 10 de 10 tareas, siempre con la variante `-sonnet`. No se registró el nivel (`none|low|high`) en el stream, y con `strong_model: sonnet` los niveles `low` y `high` usan el mismo agent, así que lo único seguro es que ninguna fue `none`. D-008 podía omitirla en cambios pequeños y no lo hizo en ninguna; en pr58 y pr53 el implementer dejó commits y el diff de trabajo que mide `assessRisk` quedó vacío (ver "Bugs"), así que la revisión se pidió por otra razón (por ejemplo, la falta de un plan validado por el hook o las decisiones nuevas), que no se registró.
- **plan-check:** 6 de 10 (antes, 10 de 10). Eran todas `-sonnet`.
- **Ruta rápida:** solo en 2 de 10 (pista pr58 y pr64). En ciega pr58 el modelo la intentó y pasó a plan mode. En el resto el ticket no da todos los nombres y la ruta no aplica, que es lo esperado de D-009.
- **Modelos:** D1v2 gastó $0.80 + $0.53 = $1.33 en `claude-sonnet-5-5` y $0.79 en `claude-haiku-5-5` (ciega $0.80 y $0.51, pista $0.53 y $0.29). Sonnet es el 63 % del coste. Con `strong_model: sonnet`, el modelo "fuerte" es siempre sonnet y nunca llega a opus; el coste de opus en D1v2 es 0 (solo el setup).

## Fallos de D1v2

| Celda | Resultado | Clase | Qué pasó |
|---|---|---|---|
| ciega pr58 | 1/20 | nombres + forma de argumentos | Igual que en v1: `canReserveSlot` y compañía devuelven una forma distinta de la esperada (un objeto, no un booleano) y los códigos de rechazo no coinciden. El setup no ayudó: ninguna de sus skills lo dice. |
| ciega pr84 | 6/23 | nombres | Faltan `activateTrailing`, `validate*Pct` y `DEFAULT_*` en los archivos que importan los tests (el ticket no los nombra). |
| ciega pr223 | 61/78 (= base) | nombres | Falta `renameClient`: el modelo preguntó por el nombre y el host eligió la primera opción, `updateClientName (Recommended)`, que era la equivocada. D0 y D0s, sin preguntar, lo acertaron (72 y 67 de 78). |
| ciega pr198 | 69/72 (= base) | nombre / forma | Falla el test que espera la configuración y los límites fijos en el detalle del cliente (`updateClientSettings`). Igual que D0 y D1 en v1. |
| ciega pr53 | 10/11 (= base) | requisito no explícito | Festivos NYSE 2026/2027, igual que en los cuatro brazos de v1. |
| pista pr84 | 17/23 | verify / revisión (robustez) | `activateTrailing` no lanza `RangeError` con valores fuera de rango. El ticket lo pide; ni los tests propios ni el reviewer lo cubrieron. |
| pista pr223 | 70/78 | verify / revisión (robustez) | `renameClient` no rechaza el nombre con salto de línea ni los casos de concurrencia. Igual que D0, D0s y D1. |
| pista pr51 | 61/85 | verify / revisión (robustez) | `validateSizeChange` no lanza `RangeError` ante dinero inválido. Se perdieron 9 tests respecto de D1 v1, pero aquella ejecución terminó por un límite de sesión justo después de lanzar el reviewer, así que no es comparable. |
| pista pr64 | 18/26 | lógica / robustez | Falla el redondeo al incremento de equities tras restar fills parciales (y hay fallos en la validación de incrementos). |

Recuento: nombres o forma, 4 celdas (todas ciegas); robustez de entradas inválidas que ni los tests propios ni el reviewer cubren, 4; requisito no explícito, 1. No hubo fallos del plugin ni del host. Las 10 ejecuciones de D1v2 y las 10 de D0s terminaron con `subtype: success`, sin límite de coste ni de sesión.

## Qué se recortó

- **Setups:** 7 (uno por commit base), no 5. No se recortó ninguno; ver arriba por qué no es uno por repo.
- **Celdas:** ninguna: las 10 celdas de v1 corrieron en D0s y D1v2. Solo se recortó lo ya declarado en v1 (sin A ni C+, sin pista en pr53 y pr198).
- **Revisión y plan-check de D1v2:** `strong_model: sonnet`, igual que en D1 (v1), para que la comparación sea limpia. Con `opus` el coste de las revisiones de nivel alto habría sido mayor y no se midió.
- **Qué no se midió:** el desglose por componente (orquestador, implementer, plan-check, reviewer) que pide el issue, solo se tiene por modelo (`modelUsage`): el stream de `-p` trae el coste total y el de cada modelo, pero no el de cada subagente. Tampoco se midió D1v2 sin setup, así que el efecto de los recortes (#67, #68, #69) y el del setup se ven mezclados al comparar D1 con D1v2.

## Conclusión

- **Calidad.** Con setup o sin él, los tests ocultos son casi iguales: D0 322, D0s 343, D1 337, D1v2 333 sobre 436. Con n=1 por celda, las diferencias de 10 tests o menos son ruido. La única mejora clara es D0s con pista (183 contra 162), casi toda de pr51 (59 contra 38) y de un solo ticket, así que tampoco es concluyente. En la variante ciega, el setup no movió a D0 (160 y 160), y D1v2 (147) sigue por debajo de D0s: los fallos son de nombres y de robustez, y el setup no los corrige.
- **Coste.** D1v2 costó $2.12 contra $2.41 de D1 (-12 %), con un número de tests casi idéntico (333 y 337). Es un ahorro modesto, no el recorte que esperaban #67, #68 y #69: la revisión sigue pidiéndose en el 100 % de las tareas (aunque ya en `-sonnet`) y plan mode sigue en el 80 %. D1v2 sigue costando 8 veces más que D0s ($2.12 contra $0.26) sin dar más tests.
- **Setup.** Cuesta unos $0.71 por commit base (2.7 veces lo que cuestan las 10 tareas de D0s). Con 10 tareas por proyecto añade $0.49 por tarea y con 20, $0.25. Se amortiza solo si las tareas son muchas o si su efecto en calidad es real; en esta eval no se vio un efecto en la variante ciega y solo uno incierto en la de pista.
- **Respuesta honesta.** Con estos datos, **el flujo no baja costes manteniendo la calidad**: la calidad se mantiene (lo que está dentro del ruido), pero el coste con el plugin sigue siendo unas 8 veces el de Claude Code sin plugin con el mismo setup, y el setup no se paga en 10 ni 20 tareas. El flujo sí aporta lo que esta eval no mide: bloqueos por verify, contrato y nombres, y una revisión. Quien las valore pagará ese sobrecoste; quien mida solo tests ocultos por dólar, no. Habría que repetir con varias ejecuciones por celda antes de afirmar nada más fino.

## Bugs y observaciones (sin cambios de código en esta PR)

1. **`/setup` en `-p` con `acceptEdits` no puede terminar.** Escribir en `.claude/skills/` se deniega y el setup queda en `pending`. No es un bug del plugin, pero la skill y el README no lo dicen: para automatizar `/setup` hay que usar `bypassPermissions` o una regla `allow` específica para `.claude/`.
2. **El diff del brief del reviewer queda vacío cuando el implementer hace commits.** En ciega pr58 y pr53 el implementer creó una rama y commits (lo pide el `CONTRIBUTING.md` del repo) y `git diff HEAD` salió vacío (`changedFiles` 0 en ambas). En pr58 el orquestador tuvo que guardar el diff de la rama en `/tmp` a mano y el brief llevó un marcador de posición; el reviewer leyó los archivos directamente. `lib/risk.ts` mide con `git diff HEAD --numstat` y `lib/hooks/stop.ts` manda al reviewer el diff de `git diff HEAD`: con commits, ambos ven un cambio vacío y subestiman el tamaño. Habría que medir contra la base de la rama.
3. **La ruta rápida solo se usó en 2 de 10 tareas.** Sirve cuando el ticket (o la pista) da todos los nombres; en la variante ciega nunca se aplicó con éxito. D-009 acierta en el diseño, pero el ahorro de plan mode llega a pocas tareas reales.
4. **No se registra el nivel de revisión.** Ni el stream ni el estado guardan `none|low|high`, así que no se puede medir qué parte de las revisiones fueron de nivel alto. Conviene escribirlo en `tasks.jsonl` o en el brief.
5. **Idioma.** Con `language: Español`, el setup escribió los docs en inglés porque el `CLAUDE.md` del repo lo exige. Es razonable, pero la skill debería decir cuál gana.

## Reproducir

Todo está en el scratchpad de la sesión (`eval-v2/`), fuera del repo: `tools/setup.sh <pr>` (setup con opus en un clon del commit base), `tools/run2.sh <D0s|D1v2> <b|h> <pr>` (clona la copia congelada, añade el ticket y corre y corrige), más `host.mjs`, `cost.py`, `grade2.sh` y `shim.py` de v1. Los resultados crudos no se suben.

# Eval v3: D0 y D0s con n=3 por celda (issue #79)

Fecha: 2026-10-23. Coste total gastado: **$0.99** (tope duro: $2; $0.30 por ejecución con `--max-budget-usd`). Sin plugin. Mismas 10 celdas, mismos tickets, pistas y grader (`grade2.sh` y `shim.py`) que v1 y v2.

## Montaje

- Se añaden **2 repeticiones por celda** a D0 (haiku, sin setup) y a D0s (haiku, con el setup de opus de v2 congelado): 40 ejecuciones nuevas. Con la ejecución que ya existía (D0 de v1, D0s de v2) cada celda y brazo tiene n=3.
- Comando: `env -u CLAUDECODE claude -p --model claude-haiku-5-5 --permission-mode acceptEdits --max-budget-usd 0.30 --output-format json --setting-sources project --strict-mcp-config --settings '{"permissions":{"allow":[...]}}'`, con el mismo prompt que en v1 y v2.
- Cada ejecución parte de una copia limpia: D0 del commit base (más el ticket), D0s de la copia congelada de v2 (más el ticket). Hasta 6 a la vez; el tiempo de pared no es comparable con v1.
- Salvedad: la primera ejecución de D0 viene de v1 (con `--max-budget-usd 1` y su propio montaje). Las nuevas repeticiones de D0 usan el montaje de v3, igual al de D0s menos el setup.
- Proyección de coste tras las 4 primeras ejecuciones: unos $0.02 por ejecución, 40 en total, unos $1; por debajo del tope, sin ajustes.

## Resultados por celda

Tests ocultos que pasan en las tres ejecuciones (v1/v2, r1, r2), con media, mínimo y máximo.

| Celda | Total | D0: ejecuciones | D0: media (mín–máx) | D0s: ejecuciones | D0s: media (mín–máx) |
|---|---|---|---|---|---|
| ciega pr58 | 20 | 0, 2, 2 | 1,3 (0–2) | 3, 1, 0 | 1,3 (0–3) |
| ciega pr53 | 11 | 10, 10, 10 | 10,0 (10–10) | 10, 10, 10 | 10,0 (10–10) |
| ciega pr198 | 72 | 69, 70, 70 | 69,7 (69–70) | 70, 70, 70 | 70,0 (70–70) |
| ciega pr84 | 23 | 9, 5, 5 | 6,3 (5–9) | 10, 11, 2 | 7,7 (2–11) |
| ciega pr223 | 78 | 72, 67, 67 | 68,7 (67–72) | 67, 61, 61 | 63,0 (61–67) |
| pista pr58 | 20 | 20, 20, 20 | 20,0 (20–20) | 20, 20, 20 | 20,0 (20–20) |
| pista pr84 | 23 | 14, 14, 14 | 14,0 (14–14) | 14, 15, 14 | 14,3 (14–15) |
| pista pr223 | 78 | 70, 70, 70 | 70,0 (70–70) | 70, 73, 71 | 71,3 (70–73) |
| pista pr51 | 85 | 38, 63, 39 | 46,7 (38–63) | 59, 52, 57 | 56,0 (52–59) |
| pista pr64 | 26 | 20, 24, 22 | 22,0 (20–24) | 20, 24, 24 | 22,7 (20–24) |

## Totales por brazo (las 10 celdas, máximo 436)

Se suma cada ejecución n.º 1, 2 y 3 sobre las 10 celdas, y se da la media y el rango de esas tres sumas.

| Brazo | Sumas por repetición | Media ± rango | Ciega (media, de 204) | Con pista (media, de 232) | Coste de las 20 ejecuciones nuevas | Tiempo medio (nuevas) |
|---|---|---|---|---|---|---|
| D0 (sin setup) | 322, 345, 319 | **328,7** (319–345) | 156,0 | 172,7 | $0.50 | 90 s |
| D0s (con setup) | 343, 337, 329 | **336,3** (329–343) | 152,0 | 184,3 | $0.50 | 89 s |

Coste de las 40 ejecuciones nuevas: $0.99. El coste del setup ($4.94 por los 7 setups) no cambia respecto a v2.

## Conclusión

**El setup no mejora la calidad más allá del ruido.** D0s suma 7,7 tests más de media (336,3 contra 328,7, un 2 % del total), pero los rangos se solapan por completo (329–343 contra 319–345) y la variación entre repeticiones de un mismo brazo (hasta 26 tests en D0) es mayor que esa diferencia. Con n=3 no hay base para afirmar ningún efecto.

- La ventaja de v2 (343 contra 322) no se sostiene: con más repeticiones, D0 sube a 345 en una y D0s baja a 329 en otra.
- Ciega: el setup no ayuda; D0s queda por debajo en media (152,0 contra 156,0), sobre todo por pr223 (63,0 contra 68,7). Es una diferencia dentro del ruido, no un daño demostrado.
- Con pista: D0s queda por encima (184,3 contra 172,7), pero casi todo viene de una celda, pista pr51 (56,0 contra 46,7), donde D0 oscila de 38 a 63 entre repeticiones. Sin pr51 las dos medias son prácticamente iguales (más o menos 1 test por celda). Es la única celda con una señal sugerente y con n=3 no se puede separar del ruido.
- En 8 de las 10 celdas la diferencia de medias entre brazos es de 1,3 tests o menos.
- El coste de ejecución es idéntico ($0.025 por ejecución) y el setup añade unos $0.49 por tarea (o $0.25 con 20 tareas por proyecto). Con esta evidencia no se justifica el gasto por la calidad; si se quiere defender el setup habría que hacerlo por otra razón (convenciones del repo, no por tests ocultos) o medirlo con más repeticiones y más repos.

## Fuera de alcance

- Un segundo repo (queda para otra issue).
- Repetir D1 / D1v2 (con plugin): no se pidió.
- Más de 3 repeticiones por celda.

## Reproducir

Scratchpad de la sesión (`eval-v3/`), fuera del repo: `tools/run3.sh <D0|D0s> <b|h> <pr> <rep>` (copia limpia, ejecuta y corrige con `grade2.sh`), `tools/agg.py` (tabla), reutilizando `data/`, `src-repo/` y `setup/` (copias congeladas) de `eval-v2/`. Los resultados crudos no se suben.

---

# Eval v4: modo directo con contract-first (D0s+c) y D1 sin revisión (issue #89)

Fecha: 2026-10-24. Coste total gastado: **$1.92** (tope duro: $4; $0.30 por ejecución con `--max-budget-usd`, salvo el setup real, tope $1.50): setup real $0.63, D0s+c $0.79, D1v2 sin revisión $0.51. Plugin medido: `cc-improved` en `origin/main` **`e89daf0ff0980d69732a9b241cd6eeb0928ffb81`** (con #87), sin cambios durante la eval. Mismas 10 celdas, mismos tickets, pistas, prompt de tarea y grader (`grade2.sh` y `shim.py`) que v1, v2 y v3. Las ejecuciones de D0 y D0s de v3 (n=3) son los brazos de comparación; no se repitieron.

**Criterio fijado antes de ejecutar (issue #89, no se cambió):** adoptar si el coste es ≤ D0s × 1,3 y la suma de tests no cae más de ~12 pp; el efecto en validación y nombres se reporta como indicativo (n bajo).

## Brazos

| Brazo | Qué es | n por celda |
|---|---|---|
| D0 (v3) | haiku, sin plugin, sin setup | 3 |
| D0s (v3) | haiku, sin plugin, con el setup de opus de v2 | 3 |
| **D0s+c** | D0s + las dos secciones nuevas en `CLAUDE.md` + `--plugin-dir` del plugin actual (skills y script; con `disableAllHooks`, sin hooks de `/task`) | 3 |
| **D1v2 sin revisión** (`D1n` en las tablas) | `/cc-improved:task` con el plugin actual y el manifest de v2 (sin `review`: revisión y plan-check apagados por defecto); `strong_model: sonnet` como en D1v2 | 1 |

Todos con `--model claude-haiku-5-5 --permission-mode acceptEdits --max-budget-usd 0.30`. Cada ejecución parte de una copia limpia de la copia congelada de v2 (más el ticket); hasta 6 a la vez (D0s+c) y 5 a la vez (D1v2 sin revisión), así que el tiempo de pared no es comparable con v1. D1v2 sin revisión usa el host de permisos de v2 (`host.mjs`), que contesta `AskUserQuestion` con la primera opción.

## Paso 1: setup real del plugin nuevo

Se corrió `/cc-improved:setup` (`claude-opus-5-5`, por el `model: opus` de la skill) en una copia limpia del commit base de pr223: `env -uCLAUDECODE claude -p --plugin-dir <worktree> --output-format json --permission-mode bypassPermissions --max-budget-usd 1.5`, con el mismo prompt no interactivo de v2 (idioma Español, sin conectores, sin agentlint, `verify` = `bun test`, una herramienta python; sin entrevista). Como en v2, `acceptEdits` no deja escribir en `.claude/skills/`; se usó `bypassPermissions` solo en esa copia (un clon en el scratchpad, nunca un repo real).

- **Coste real: $0.626**, 12 turnos, 90 s, todo `claude-opus-5-5`. `setup: done`, `mode: "direct"` en `.claude/workflow.json`.
- **Generó** (además de lo habitual): `CLAUDE.md` 110 líneas (+19), `verify-app`, 2 skills `domain-*`, `tools/verify/unit_tests.py`, `GLOSSARY.md` (25 términos), 1 ADR y `.claude/workflow.json`. Para que el `verify` pasara usó `bun test ./src/lib ./scripts` (534 tests, 0 fallos).
- **Las dos secciones salieron bien:** «Antes de dar una tarea por terminada» (3 viñetas) y «Contrato primero» (4 viñetas: seguir la skill `contract-first`, `contract.json`, lista de entradas inválidas, `wf-contract-check.mjs`, y cuándo usar `/task`). Son **12 líneas** con los títulos y las líneas en blanco (≤15). Las escribió en español (idioma del setup). El `CLAUDE.md` añade además una tercera sección corta de enlaces a las skills de dominio y el glosario (unas 5 líneas), que no es parte de las dos secciones. La skill `contract-first` se nombra en la sección y el modelo la ve en la lista de skills (su descripción aparece en el contexto de los transcripts revisados de D0s+c); no hay un enlace de archivo como tal.
- Es una sola copia (n=1): no mide la variación del setup.

## Paso 2: D0s+c

Las 12 líneas de las dos secciones, tal como las generó el paso 1, se añadieron al final del `CLAUDE.md` de cada copia congelada de v2 (en lugar de pagar 7 setups nuevos, ~$4.9). La skill `contract-first` y `bin/wf-contract-check.mjs` quedan disponibles por `--plugin-dir`; los hooks, apagados. Proyección tras 4 ejecuciones: $0.117, unos $0.029 por ejecución, ~$0.88 para 30; el total real fue $0.79.

## Resultados por celda

Tests ocultos que pasan en cada repetición, con la media. Las celdas ruidosas (las que más mueven entre repeticiones por un nombre o por validación: pista pr51, ciega pr223, ciega pr84) se marcan con `*`.

| Celda | Total | D0 (v3) | D0s (v3) | D0s+c | D1v2 sin revisión |
|---|---|---|---|---|---|
| ciega pr58 | 20 | 0, 2, 2 (1,3) | 3, 1, 0 (1,3) | 3, 1, 3 (2,3) | 1 |
| ciega pr53 | 11 | 10, 10, 10 | 10, 10, 10 | 10, 10, 10 | 10 |
| ciega pr198 | 72 | 69, 70, 70 (69,7) | 70, 70, 70 | 69, 70, 69 (69,3) | 69 |
| ciega pr84 `*` | 23 | 9, 5, 5 (6,3) | 10, 11, 2 (7,7) | 14, 10, 11 (11,7) | 0 |
| ciega pr223 `*` | 78 | 72, 67, 67 (68,7) | 67, 61, 61 (63,0) | 61, 67, 72 (66,7) | 61 |
| pista pr58 | 20 | 20, 20, 20 | 20, 20, 20 | 20, 20, 20 | 20 |
| pista pr84 | 23 | 14, 14, 14 | 14, 15, 14 (14,3) | 14, 14, 14 | 14 |
| pista pr223 | 78 | 70, 70, 70 | 70, 73, 71 (71,3) | 70, 70, 75 (71,7) | 70 |
| pista pr51 `*` | 85 | 38, 63, 39 (46,7) | 59, 52, 57 (56,0) | 57, 60, 57 (58,0) | 65 |
| pista pr64 | 26 | 20, 24, 22 (22,0) | 20, 24, 24 (22,7) | 25, 25, 19 (23,0) | 19 |

## Totales por brazo (las 10 celdas, máximo 436)

Suma de cada repetición n.º 1, 2 y 3 sobre las celdas; media y rango de las tres sumas.

| Brazo | Sumas por repetición | Media (rango) | 7 celdas tranquilas (de 250) | 3 celdas ruidosas (de 186) | Ciega (de 204) | Con pista (de 232) | Coste por pasada de 10 celdas | Tiempo medio | Turnos medios |
|---|---|---|---|---|---|---|---|---|---|
| D0 | 322, 345, 319 | **328,7** (319–345) | 207,0 (203–210) | 121,7 (111–135) | 156,0 | 172,7 | $0.248 | 90 s | 18,1 |
| D0s | 343, 337, 329 | **336,3** (329–343) | 209,7 (207–213) | 126,7 (120–136) | 152,0 | 184,3 | $0.252 | 90 s | 18,7 |
| **D0s+c** | 343, 347, 350 | **346,7** (343–350) | 210,3 (210–211) | 136,3 (132–140) | 160,0 | 186,7 | **$0.264** | 101 s | 19,8 |
| **D1v2 sin revisión** | 329 (n=1) | 329 | 203 | 126 | 141 | 188 | **$0.506** | 208 s | 18,4 |

Coste por pasada: media de las ejecuciones nuevas por 10 (D0: 20 ejecuciones; D0s: 30; D0s+c: 30; D1v2 sin revisión: 10). El setup real ($0.63) no entra; con el setup amortizado el coste por tarea sube en todos los brazos con setup igual que en v2.

## Criterio aplicado

| Comparación con D0s | Coste | Suma de tests | Veredicto |
|---|---|---|---|
| **D0s+c** | $0.264 contra $0.252: **×1,05** (límite ×1,3: se cumple) | 346,7 contra 336,3: **+10,4** (+2,4 pp de 436; no cae: se cumple) | **Se cumple el criterio.** |
| **D1v2 sin revisión** | $0.506 contra $0.252: **×2,0** (límite ×1,3: **no** se cumple) | 329 contra 336,3: −7,3 (−1,7 pp; dentro de −12 pp) | **No se cumple** (falla el coste). |

Lectura honesta:

- **D0s+c cumple el criterio, pero su ventaja en tests no es demostrable.** La media sube 10,4 tests, los rangos de las sumas casi no se tocan (343–350 contra 329–343; solo coinciden en 343) y n=3 es poco. Casi todo viene de las celdas ruidosas (+9,6 de los 10,4: ciega pr84 11,7 contra 7,7 y ciega pr223 66,7 contra 63,0); en las 7 tranquilas la diferencia es de +0,7 tests (210,3 contra 209,7). Los efectos de v3 ya enseñaron que estas tres celdas se mueven por una decisión de nombre, no por el brazo.
- **No se puede atribuir la mejora a contract-first** (ver «Uso real»): el modelo no invocó la skill ni una vez en 30 ejecuciones. Lo que cambió respecto de D0s fueron las 12 líneas de `CLAUDE.md` y, a lo sumo, que el modelo escribió `contract.json` en 8 de 30 por esas líneas. Habría que comparar con un brazo que lleve solo las dos secciones sin plugin para separar ambas cosas (no se hizo).
- **D1v2 sin revisión** costó la mitad que D1v2 con revisión (v2: $2.12; ahora $0.51 por pasada), pero sigue en el doble de D0s y no da más tests (329; ciega 141, la más baja de todos los brazos: pr84 0/23 y pr223 61/78 por nombres). Es n=1 por celda, así que solo es un orden de magnitud de coste, no una medida de calidad.

## Clases de fallo

Tests ocultos que fallan, sumados sobre todas las ejecuciones y divididos por las pasadas (media por pasada de 10 celdas; D1v2 sin revisión: la pasada única). Clasificación automática del texto del fallo, igual que en el análisis propio de datos (`nombres`: módulo o export ausente; `validación`: debía lanzar y no lanzó, o caso «rechaza/inválido»; `forma de argumentos`: `TypeError`/«is not a function»; `otros`: valor o lógica). Solo cuenta los tests que cargan: los de un archivo que no carga por un nombre ausente no entran.

| Brazo | Nombres | Validación de entradas | Forma de argumentos | Otros | Total clasificado |
|---|---|---|---|---|---|
| D0 | 18,7 | 44,7 | 4,7 | 35,3 | 103,3 |
| D0s | 25,7 | 40,3 | 9,3 | 20,3 | 95,7 |
| D0s+c | 15,7 | 43,3 | 0,0 | 26,3 | 85,3 |
| D1v2 sin revisión | 36,0 | 30,0 | 14,0 | 23,0 | 103,0 |

- **Validación de entradas no baja con contract-first**: 43,3 por pasada contra 40,3 (D0s) y 44,7 (D0). Es la clase dominante en todos los brazos (la mitad de los fallos). Los fallos típicos siguen siendo «debe lanzar `RangeError` ante dinero o incremento inválido» (pista pr51 y pr64, pista pr84). La lista de validación de la skill no se vio en estos resultados; con n=3 y sin que el modelo la leyera, no es sorprendente.
- **Nombres y forma de argumentos bajan algo** en D0s+c (15,7 y 0,0 contra 25,7 y 9,3 de D0s), pero es indicativo: son sobre todo las celdas ciegas pr84 y pr58 y sus exportaciones, que cambian de una repetición a otra.
- **D1v2 sin revisión** acumula más fallos de nombres (36,0): en ciega pr223 el host contestó la primera opción de `AskUserQuestion` (`updateClientName`, la equivocada), igual que en v2.
- Los tests visibles no avisan: **en 30 de 30 ejecuciones de D0s+c el último resumen visible de `bun test` fue verde (0 fallos), y en 27 de ellas fallaban tests ocultos** (en D1v2 sin revisión, 9 de 10 verdes con fallos ocultos en 8). Los tests visibles no sirven como señal de escalado.

## Uso real de contract-first

Medido en los transcripts de D0s+c (30) y en el stream de D1v2 sin revisión (10):

| Señal | D0s+c (30) | D1v2 sin revisión (10) |
|---|---|---|
| Invocó la skill `contract-first` (herramienta `Skill`) | **0** | 0 |
| Escribió `.claude/workflow/contract.json` | 8 (pr58 ciega ×3, pr198 ciega ×1, pr223 pista ×1, pr58 pista ×1, pr64 pista ×1, pr84 pista ×1) | 0 (el flujo `/task` tiene su propia puerta de contrato) |
| Ejecutó `wf-contract-check` | **1** | 0 por el modelo (la puerta lo hace en el hook de parada) |
| Resultado de esa ejecución | `CONTRACT MISSING`: había buscado el script con `find /` y lo llamó por ruta absoluta del worktree, antes de escribir el contrato; no volvió a correrlo | — |

Es decir: la skill y el script casi no se usaron. Las 8 veces que el modelo escribió `contract.json` fueron, con toda probabilidad, por las viñetas de `CLAUDE.md` (no se cargó la skill), y el script apenas se ejecutó. En dos transcripts el modelo buscó el script con `find` porque no lo encontró en el `PATH` de `Bash` (la skill y el setup dicen que está en el `PATH`; en ninguna ejecución se vio que `wf-contract-check.mjs` se pudiera llamar sin ruta). En D1v2 sin revisión, `/task` es lo que impone el contrato (gates), no la skill.

## Desglose por modelo y subagente

- **D0s+c:** todo `claude-haiku-5-5` ($0.79); no hay subagentes.
- **D1v2 sin revisión:** todo `claude-haiku-5-5` ($0.51 en 10 ejecuciones): orquestador e implementer (11 llamadas a `cc-improved:implementer`, ninguna a `reviewer`, `plan-check` ni `fixer`). **Confirmado: sin revisión ni plan-check de modelo** por defecto; no hay coste de sonnet ni de opus (en v2 sonnet era el 63 %). El stream de `-p` no trae el coste por subagente; solo por modelo (`modelUsage`).
- **Nivel de revisión:** no se registra (limitación ya conocida de v2); aquí fue `off` por defecto en las 10 ejecuciones de D1v2 sin revisión.

## Limitaciones

- **n bajo.** n=3 en D0, D0s y D0s+c, y n=1 en D1v2 sin revisión. La variación entre repeticiones de un mismo brazo (hasta 26 tests en D0) es mayor que las diferencias entre brazos. Las diferencias de la tabla de clases son indicativas, no concluyentes.
- **Un solo repo** (`thereelcapital`, con 7 commits base). No se puede extrapolar.
- **Secciones inyectadas en vez de setup completo en D0s+c:** el `CLAUDE.md` de las copias es el de v2 más las 12 líneas del setup de pr223 (que habla de `bun test ./src/lib ./scripts` y de las skills de esa copia, no de las de cada una). No se midió un setup nuevo por copia. El setup real se corrió una sola vez.
- **La mejora no se puede atribuir a la skill** (0 invocaciones). No se midió un brazo «solo las secciones, sin plugin».
- Misma configuración de v3 (`--setting-sources project`, `--strict-mcp-config`); no se verificó qué instrucciones de usuario llegan al modelo, igual que en v3.
- D1v2 sin revisión usó `strong_model: sonnet` (sin efecto aquí porque no se pidió ninguna revisión) y el host que contesta la primera opción.
- El «último test visible» se extrae del transcript (último resumen de `bun test` con tests que pasan), y la clasificación de fallos es automática por texto.

## Bugs y observaciones del plugin (sin cambios de código en esta PR)

1. **`wf-contract-check.mjs` no está en el `PATH` de `Bash` con `--plugin-dir` en `-p`** (o al menos el modelo no lo encontró). Dos ejecuciones lo buscaron con `find /`. La skill `contract-first` y el setup dicen que está en el `PATH`; si no lo está, hay que dar la ruta completa. El texto de la sección de `CLAUDE.md` que escribe el setup («ejecuta `wf-contract-check.mjs`») no lleva comando completo.
2. **La puerta de contrato de `/task` comprueba nombres compuestos como texto literal.** En ciega pr223 (D1v2 sin revisión) el contrato pedía `actions.updateName` (clave de objeto en `+page.server.ts`); la puerta buscó el texto literal `actions.updateName` como palabra y rechazó dos formas válidas de código (literal inline y constante), así que el modelo acabó añadiendo un comentario con ese texto para que pasara. La puerta debería aceptar el último segmento del nombre o la forma de clave.
3. **El setup añadió un ADR solo porque `wf-setup-finish` rechazaba sin `docs/adr/`.** El resumen del setup lo dice así: el modelo creó un ADR para pasar la comprobación, aunque el código lo justificaba. Se puede considerar un efecto secundario del chequeo.
4. **`/setup` en `-p` sigue necesitando `bypassPermissions`** (sin cambios desde v2).
5. **El modelo no carga `contract-first` aunque su descripción está visible.** El `CLAUDE.md` la nombra («sigue la skill»), pero el modelo hizo las acciones de las viñetas sin cargarla. Si se quiere medir su lista de validación hay que ponerla en el `CLAUDE.md` o en un hook de contexto.

## Fuera de alcance

- Un segundo repo.
- Repetir D1v2 sin revisión con n>1.
- Un brazo con solo las dos secciones y sin plugin (para separar el efecto de las secciones del de la skill).
- Cambiar el plugin: los bugs de arriba solo se describen.

## Reproducir

Scratchpad de la sesión (`eval-v4/`), fuera del repo: `tools/run4.sh <D0sc|D1n> <b|h> <pr> <rep>` (copia limpia de `setup/pr<N>` de v2, añade las secciones en D0sc, corre y corrige con `grade2.sh`), `tools/agg4.py` (tabla), `tools/classify4.py` (clases de fallo), `tools/use.py` (uso de la skill) y `tools/setup-prompt4.txt` (setup real). Reutiliza `data/`, `src-repo/` y `setup/` de `eval-v2/`. Los resultados crudos no se suben.
