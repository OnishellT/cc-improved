# Chequeo del plan: opción A (hook `agent`), documentada y no activada

El chequeo del plan con modelo fuerte usa la **opción B**: el hook `command` de `PreToolUse(ExitPlanMode)` (`lib/hooks/exit-plan-mode.ts`) deniega la primera llamada válida con "lanza `cc-improved:plan-check` en primer plano con este brief", y `SubagentStop` guarda el veredicto. Este documento describe la **opción A** por si algún día conviene cambiar, y por qué hoy no se activa.

## Qué sería la opción A

Un segundo hook en el mismo grupo de `hooks/hooks.json`, de tipo `agent`, con modelo fuerte. El arnés lanza el agente con el JSON de la llamada en `$ARGUMENTS`, el agente lee lo que necesite con sus herramientas y devuelve `{ok, reason}`. Con `ok: false` la herramienta se bloquea y el modelo principal recibe `PreToolUse:ExitPlanMode hook error: Agent hook condition was not met: <reason>`.

```json
{
  "matcher": "ExitPlanMode",
  "hooks": [
    { "type": "command", "command": "node --experimental-strip-types \"${CLAUDE_PLUGIN_ROOT}/bin/wf-hook.mjs\"", "timeout": 15 },
    {
      "type": "agent",
      "model": "opus",
      "timeout": 240,
      "prompt": "You are a read-only plan checker running as a PreToolUse hook. The pending ExitPlanMode call is this JSON: $ARGUMENTS\nRead only (never run Bash, never edit). tool_input.plan holds the plan with a ```wf-plan block. Check it against the ticket and spec files it cites and the files next to each planned file: (1) file and export names follow the siblings and the ticket; (2) an existing helper should be reused; (3) the seams cover the acceptance criteria, invalid input included; (4) a file is missing from or wrongly in `files`. Answer ok=true when nothing blocks. Otherwise ok=false with a reason that starts with \"PLAN CHECK:\" and lists numbered fixes."
    }
  ]
}
```

## Qué respalda el spike 0.2 y qué no

- **Respalda:** un hook `agent` con `model: "opus"` y `timeout: 240` en `PreToolUse` lee archivos del proyecto, bloquea con `ok: false` y el modelo corrige según la razón. Coste por invocación entre $0.027 y $0.040, latencia entre 5.6 y 20.9 s. Se probó con matcher `Write`.
- **No respalda todavía:** el matcher `ExitPlanMode`. En el spike 0.2 no existía la herramienta en `-p`. El spike 0.1 mostró después que sí existe con `--permission-prompt-tool stdio` y un host, y que `PreToolUse(ExitPlanMode)` decide antes del diálogo, así que es plausible que el hook `agent` funcione igual. No se ha ejecutado.
- **Tampoco comprobado:** qué pasa si el hook `agent` falla o agota el `timeout` (si bloquea o deja pasar).

## Por qué no se activa

1. **Paga aunque el plan sea inválido.** Los hooks de un mismo evento corren en paralelo. El hook `agent` pagaría una llamada al modelo fuerte en cada `ExitPlanMode`, también en los que el hook `command` deniega por un bloque `wf-plan` roto o por nombres inventados. En la opción B el chequeo solo se pide cuando el plan ya pasó las comprobaciones de código.
2. **No hay "una vez por tarea".** El hook `agent` no tiene estado: correría en cada intento, también después de un OK. Filtrarlo dentro del prompt también cuesta una invocación (spike 0.2). La opción B lleva el contador `planChecks` por sesión y tarea.
3. **No ve la evidencia del ticket.** El brief de la opción B (`buildPlanBrief`) incluye el texto del ticket capturado por `PostToolUse(mcp__*)`, que vive en `${CLAUDE_PLUGIN_DATA}`. El agente del hook solo tiene `$ARGUMENTS` y el repo.
4. **No sigue `strong_model`.** El campo `model` de un hook es literal. La opción B elige `cc-improved:plan-check` o `cc-improved:plan-check-sonnet` según `CLAUDE_PLUGIN_OPTION_STRONG_MODEL`.
5. **No es de solo lectura por construcción.** En el spike 0.2 el agente del hook usó `Bash` sin diálogo de permiso. El agente `plan-check` de la opción B tiene `tools: Read, Grep, Glob`.

## Cuándo reconsiderarla

Si Claude Code permite encadenar hooks (que el `agent` solo corra cuando el `command` no deniega) o darles estado, y una prueba con matcher `ExitPlanMode` confirma el comportamiento del spike 0.2. Para activarla habría que añadir el hook `agent` al grupo `ExitPlanMode` de `hooks/hooks.json` y poner `review.plan: false` en el manifest del proyecto, para que la opción B no pida un segundo chequeo.
