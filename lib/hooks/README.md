# lib/hooks/

Manejadores de hooks, un módulo por área. Todos entran por `bin/wf-hook.mjs`, que lee el JSON de stdin, llama a `dispatch()` (`dispatch.ts`) e imprime lo que devuelve. Siempre sale con código 0.

Comando de `hooks/hooks.json` para cualquier evento:

```
node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/bin/wf-hook.mjs"
```

El flag no hace nada desde Node 22.18, pero las 22.x anteriores lo necesitan para cargar `.ts`.

## Cómo se añade un manejador

1. Busca tu módulo en `REGISTRY` (`registry.ts`). Los módulos previstos ya están registrados. Mientras no exista el archivo, se omite sin ruido:

   | Evento | Módulos, en orden | Issue |
   |---|---|---|
   | `SessionStart` | `session-start.ts` (contexto de la tarea y del setup) | #21 |
   | `UserPromptSubmit` | `user-prompt-submit.ts` | sin issue |
   | `PreToolUse` | `exit-plan-mode.ts`, `pre-tool-use.ts` | #19, #18 |
   | `PostToolUse` | `exit-plan-mode.ts`, `mcp-evidence.ts` (guarda el texto MCP como evidencia) | #19, #21 |
   | `SubagentStart` | `subagent-start.ts` (contexto para el subagente) | #21 |
   | `SubagentStop` | `subagent-stop.ts` | #20 (y el veredicto de `plan-check` de #19) |
   | `Stop` | `setup-nudge.ts`, `stop.ts` | #20 (el empujón de `/setup` en curso) |
   | `SessionEnd` | `session-end.ts` | sin issue |

   Si necesitas otro módulo o cambiar el orden, edita `REGISTRY` y dilo en la PR.

   Los gates de revisión (D-008): `stop.ts` pide la revisión según `assessRisk().level` (`none` y `low` no; `low` solo con `review.minLevel: "low"`, con `reviewer-sonnet`; `high` con el fuerte) y `exit-plan-mode.ts` pide `plan-check` solo con riesgo alto en el plan, o en planes grandes con `review.plan: true` (`planCheckLevel`, D-012). La ruta rápida de `/task` usa `notSmallReasons`. La variante la decide `strongAgentChoice(name, env, { strong })` en `gate.ts`.

2. Crea `lib/hooks/<módulo>.ts` con un export por defecto de tipo `HookModule`: un manejador por cada evento que atiendas.

   ```ts
   import type { HookModule } from "./dispatch.ts";

   export default {
     PreToolUse(input, ctx) {
       if (input.tool_name !== "ExitPlanMode") return; // no es para mí: sin opinión
       return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "..." } };
     },
   } satisfies HookModule;
   ```

3. Prueba el módulo con las fixtures de `test/fixtures/hooks/`: llama a `dispatch(raw, { env, registry: { PreToolUse: { modules: [async () => mod], budgetMs: 2000 } } })` con un `CLAUDE_PROJECT_DIR` y un `CLAUDE_PLUGIN_DATA` temporales, o llama directamente al manejador con un `HookContext` propio. Hay ejemplos en `test/wf-hook.test.ts`.

## Reglas del despacho

- **El primero con salida gana.** Los módulos de un evento se prueban en orden. Si un manejador devuelve `undefined` o `{}`, no opina y se pasa al siguiente. Si devuelve un objeto no vacío, se serializa y los demás no se ejecutan. Cada manejador filtra lo suyo (`tool_name`, `agent_type`, ...) y devuelve `undefined` para lo demás.
- **Nunca lanza.** Una excepción, una entrada que no es un evento conocido o un módulo que existe pero no carga (un import roto dentro) se anotan en `${CLAUDE_PLUGIN_DATA}/log/wf-hook-<fecha>.log` y no producen salida. Lanzar desde un manejador es seguro, pero lo normal es devolver `undefined`.
- **Presupuesto.** Cada evento tiene un `budgetMs` en `REGISTRY` (`QUICK_BUDGET_MS` = 8 s, `GATE_BUDGET_MS` = 570 s para `Stop` y `SubagentStop`, que corren verify). Al agotarse se aborta `ctx.signal` (pásalo a los procesos hijos), se anota en el log y la salida se descarta. El `timeout` del evento en `hooks/hooks.json` debe ser mayor: 10 s o más para los rápidos y 600 s para los gates.
- **Sesiones ajenas.** Los hooks disparan en todas las sesiones del proyecto. Si `task.json` tiene un `sessionId` distinto del `session_id` del evento, no se ejecuta ningún manejador. Una tarea sin `sessionId` cuenta como propia de cualquier sesión. Los subagentes llevan el `session_id` del orquestador. El campo es `Task.sessionId` (`lib/types.ts`); el despacho lo quita de `ctx.task` y `saveTask` lo pone.

## `HookContext`

| Campo | Qué es |
|---|---|
| `root` | Raíz del proyecto: `CLAUDE_PROJECT_DIR`, o el `cwd` del evento si no está definido. |
| `task` | `task.json` leído al empezar, sin el `sessionId`. `undefined` si no existe o no se puede leer. |
| `saveTask(task)` | Escribe `task.json` de forma atómica con el `sessionId` de esta sesión. |
| `session.load()` / `session.save(patch)` | `SessionState` de este `session_id` en `${CLAUDE_PLUGIN_DATA}/sessions/`. Sin archivo, los contadores valen 0. `save` mezcla el parche, pone `updatedAt` y escribe de forma atómica. |
| `signal`, `deadline` | Aborto y hora límite (ms epoch) del presupuesto. |
| `log(msg)` | Añade una línea al log de hooks. Nunca lanza. |
| `env` | Entorno del proceso. En los tests es el que se pasa. |
