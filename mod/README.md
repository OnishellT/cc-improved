# mod/

Mod opcional del plugin: un hooks module (`register.tsx`) que **solo dibuja** el estado del flujo. Lo carga `hooks/hooks.json` (`"modules": ["../mod/register.tsx"]`), junto a los hooks clásicos.

| Qué | Dónde |
|---|---|
| Línea de estado (`$.ui.status`): `wf: <fase> · turno <in> / <out>` | se redibuja en `session.start` y en cada `turn.complete` |
| Panel `wf` (`$.ui.open` + `ui.render` de `Pane`): fase, tarea, plan, verify, revisión, tokens, coste acumulado | se abre con `/wf` |
| Comando `/wf` | abre el panel; donde no hay panel (`claude -p`, terminal estrecha) responde con las mismas filas en texto |

De dónde sale cada dato:

- **Fase, tarea y plan:** `.claude/workflow/task.json` (`MOD_TASK_PATH`, igual que `TASK_PATH` de `lib/paths.ts`; un test falla si se separan). Una tarea con `sessionId` de otra sesión se muestra como «tarea de otra sesión», igual que la ignora el despacho.
- **Verify y revisión:** el `SessionState` que escriben los gates en `${CLAUDE_PLUGIN_DATA}/sessions/<session_id>.json`. El motor no da al mod la carpeta de datos del plugin, así que la busca: `CLAUDE_PLUGIN_DATA` si el proceso la tiene; si no, las carpetas `cc-improved*` de `<CLAUDE_CONFIG_DIR o ~/.claude>/plugins/data/` que tengan un archivo con el id de esta sesión. Si no la encuentra, muestra «sin datos».
- **Tokens:** `usage` de `turn.complete` (entrada = fresca + caché leída + caché escrita). La línea de estado muestra el último turno del bucle principal; el panel suma también los de subagentes, desde que se cargó el mod (una recarga empieza de cero).
- **Coste acumulado:** `$.session.usage().cost.usd`, el mismo total que `/cost`.

## Opcional y aislado

- Ningún gate vive aquí ni lee nada de aquí: los gates son los hooks clásicos (`hooks/hooks.json` → `bin/wf-hook.mjs` → `lib/hooks/`). El mod no escribe archivos ni variables de entorno (`claude plugin validate .` lo lista: `env writes: nothing`).
- Cada hook llama primero a `next(e)` y después dibuja; los errores propios se tragan (`try/catch`), y `/wf` lleva además `.catch`. Lo peor que puede pasar es una línea de estado vacía o desfasada.
- Si el módulo no carga, el motor lo anota en el log de depuración y sigue: comprobado con un `register.tsx` que lanza al cargar, los hooks clásicos `SessionStart` y `Stop` corrieron igual.
- `mod/status.ts` es puro (sin motor ni Node) y lo cubren `npm test` (`test/mod-status.test.ts`) y `npm run typecheck`.

## Riesgo: API en early access

La API de mods (function hooks) es early access y cambia entre versiones sin aviso; el archivo de tipos del motor es la autoridad. Probado con Claude Code 2.1.309. Si una versión futura cambia `$.ui.status`, `$.ui.open`, `ui.render`, `command.run` o `turn.complete`, lo que se rompe es este panel, no el flujo. Para quitar el mod basta con borrar la clave `modules` de `hooks/hooks.json`.

## Cómo se comprueba

`npm test` y `npm run typecheck` no ven `register.tsx` ni `register.test.tsx`: necesitan los tipos del motor y su kit de tests (`claude-code`, `claude-code/testing`), que no son dependencias del repo. Se comprueban aparte:

```sh
CC_TYPES=/ruta/a/claude-code.d.ts sh mod/check.sh
```

`check.sh` copia el mod a una carpeta temporal (porque `claude plugin test .` en la raíz intentaría cargar también `test/*.test.ts`, que usan `node:test`) y ejecuta `claude plugin validate`, `claude plugin test` y `tsc` con las opciones que recomienda el motor. Los tipos del motor (`claude-code.d.ts`) los escribe Claude Code: la skill `plugin-authoring` da su ruta al cargarse, y en una sesión interactiva con `--plugin-dir` el motor los deja en `.claude-plugin/types/claude-code/index.d.ts`, que `check.sh` usa si existe. Sin tipos, `check.sh` se salta `tsc` y lo dice.
