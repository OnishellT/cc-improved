# cc-improved

pi-improved para Claude Code: un modelo barato implementa dentro de un flujo gobernado por código, y el modelo fuerte entra solo donde paga (chequeo del plan, revisión con riesgo, escalado). Plugin de Claude Code que usa lo nativo: plan mode, subagentes con modelo propio, skills, hooks, permisos, MCP, worktrees y coste.

Estado: en construcción. El plan completo, con las equivalencias nativas y las fases, está en el repo [pi-improved](https://github.com/OnishellT/pi-improved) (`docs/PLAN-claude-code.md`); los issues de este repo lo dividen en trabajo paralelizable.

## Instalación (cuando haya release)

```
/plugin marketplace add OnishellT/cc-improved
/plugin install cc-improved@cc-improved
```

## Desarrollo

```
npm ci && npm test && claude plugin validate .
claude --plugin-dir .    # carga el plugin en esta sesión
```

Convenciones de trabajo: `docs/CONVENTIONS.md`.
