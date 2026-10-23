# test/

Tests con `node --test`. Fixtures de hooks en `test/fixtures/hooks/`.

- `flow.test.ts`: el flujo completo de una tarea a nivel de hook (plan rechazado por nombre inventado → corregido → chequeo del plan → aprobación → implementer bloqueado por verify → arreglado → revisión por riesgo → `/done`), con los comandos y matchers de `hooks/hooks.json`. Determinista y gratis; entra en `npm test`.
- `e2e/run.mjs`: el mismo flujo con Claude Code real (`npm run e2e`). Cuesta dinero, nunca entra en `npm test` ni en CI. Necesita `E2E_WORK=<carpeta desechable>`; trabaja sobre una copia de un repo de prueba que crea ahí. Ver la cabecera del script.
