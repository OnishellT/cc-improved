# hooks/

Configuración de hooks del plugin (`hooks.json`). Todos los eventos usan el mismo comando, `node --experimental-strip-types "${CLAUDE_PLUGIN_ROOT}/bin/wf-hook.mjs"`, que despacha a `lib/hooks/` (ver `lib/hooks/README.md`). Todo hook declara `timeout` y nunca lanza.

| Evento | Matcher | Timeout | Para qué |
|---|---|---|---|
| `SessionStart` | (todos) | 15 s | aviso de setup y resumen de la tarea abierta |
| `PreToolUse` | `ExitPlanMode` | 15 s | validación del plan, nombres verificados, decisiones, petición del chequeo del plan (solo riesgo alto o `review.plan: true`) |
| `PreToolUse` | `Edit\|Write\|MultiEdit\|NotebookEdit\|Bash` | 15 s | guards de la implementación (fuera del plan, dependencias, migraciones, agentlint) |
| `PostToolUse` | `ExitPlanMode` | 15 s | plan aprobado: la tarea pasa a `implementing` |
| `PostToolUse` | `mcp__.*` | 15 s | texto del ticket como evidencia |
| `SubagentStart` | (todos) | 15 s | telemetría |
| `SubagentStop` | `(^\|:)(implementer\|reviewer\|plan-check\|fixer)(-sonnet)?$` | 600 s | gate del implementer/fixer (contrato, verify) y veredictos |
| `Stop` | (todos) | 600 s | empuje de `/setup` y gate del orquestador (contrato, verify, revisión solo con riesgo alto o `review.minLevel: low`) |

Notas:

- Los timeouts superan el presupuesto interno del despacho (`lib/hooks/registry.ts`): 8 s para los eventos rápidos y 570 s para `Stop` y `SubagentStop`, que corren verify.
- Matchers en Claude Code 2.1.309: una lista simple de nombres (`a|b`, también con `-` en eventos de subagente) se compara **exacta**; cualquier otra cosa es una expresión regular sin anclar. Los agentes del plugin llegan como `cc-improved:<nombre>`, así que el matcher de `SubagentStop` es una regex: `implementer|reviewer|...` como lista no casaría nunca con `cc-improved:implementer`.
- El matcher de `PreToolUse` ya deja fuera `Read`, `Grep` y el resto. `if` (regla de permisos, por ejemplo `Bash(git *)`) no reduce más ejecuciones aquí: el guard necesita ver todos los comandos de `Bash` y todas las escrituras.
- El chequeo del plan usa la opción B. La opción A (hook `agent`) está en `docs/plan-check-option-a.md`, sin activar.

## Reintentos del gate (D-009)

- `SubagentStop` (implementer/fixer): un bloqueo por verify fallido (arreglar, con el método de diagnóstico y permiso para terminar con `FAILED`); al segundo fallo sale con `FAILED` (`RELEASE_AFTER` en `lib/hooks/gate.ts`).
- `Stop` (orquestador): arreglar, luego el `fixer`; al tercer fallo decide la persona. Máximo 2 bloqueos por verify y por mensaje.
- Motivo: menos intentos baratos del mismo modelo antes de escalar o preguntar.
