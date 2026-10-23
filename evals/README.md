# evals/

Evaluaciones de skills con `claude plugin eval` (3 casos, `evals/*/case.yaml`). Sirven para medir que un cambio en una skill no rompe lo que hace: cada caso carga una skill del plugin y comprueba con graders gratuitos (`tool_used`, `regex`; sin juez LLM) que se invoca y que la respuesta sigue su método.

| Caso | Skill | Qué comprueba |
|---|---|---|
| `verify-sin-manifiesto` | `verify` | sin `.claude/workflow.json` no corre comandos (cero `Bash`) y remite a `/setup` |
| `tdd-primer-test` | `tdd` | el plan empieza por un test que falla y no escribe archivos |
| `diagnosing-bugs-reproducir` | `diagnosing-bugs` | el primer paso es reproducir el fallo y no edita nada |

## Cómo correrlas

Cuestan dinero (modelo `claude-haiku-5-5`, una ejecución por caso, 6 turnos como máximo) y **no entran en CI**. Con `--ablation none` no se ejecuta el brazo sin plugin, que duplicaría el coste:

```
claude plugin eval . --ablation none --max-cost-usd 0.30 --no-publish --trust-plugin
claude plugin eval . --case 'tdd-*' --ablation none --max-cost-usd 0.10 --no-publish   # un caso
```

El resultado queda en `evals/results/<fecha>/` (ignorado por git). Resultado de la primera corrida y coste real: `docs/RELEASE-0.1.0.md`.

Límites: no existe tope de coste por caso, solo `--max-cost-usd` global, que se comprueba antes de cada ejecución. Los graders de `tool_used` sobre `Skill` dependen de que el modelo decida cargar la skill; el prompt la nombra para que el caso mida la skill y no la decisión de cargarla.
