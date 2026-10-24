# Costes del uso real

Cómo se midió el consumo de Claude Code en el uso diario (no en las evals de `docs/EVAL.md`), qué lo causó y qué se instaló para bajarlo. Decisión: D-016.

Las cifras son estimaciones a precio de lista de API calculadas con las transcripciones locales (`usage-report.mjs`), no una factura: las cuentas son de suscripción y sus límites no son públicos. Sirven para comparar periodos.

## Línea base (2026-10-21 a 2026-10-23, días completos)

$654,77 en tres días, unos $218 al día. Por modelo: Fable 29 %, Opus 33 %, Sonnet 37 %. Un turno de sesión principal costó $0,22 en Fable, $0,105 en Opus y $0,053 en Sonnet.

Qué lo causó, de mayor a menor:

1. **Sesiones largas.** Un 45 % del gasto fue en turnos con más de 200k tokens de contexto. Cada turno relee todo el contexto, así que el coste crece con el cuadrado de la longitud de la sesión. Una sesión llegó a 553 turnos y 946k tokens y gastó $82 de sus $85 por encima de 200k. En total hubo 10 compactaciones.
2. **Modelo.** Las sesiones principales arrancaron en Opus (el defecto de la suscripción); cuatro pasaron a mano a Fable (limpieza de configuración, alta de un repo, diseño).
3. **Subagentes: el 40 % del gasto.** 242 agentes `general-purpose` costaron $271 (mediana $0,28; los de «Implement issue» costaron $5–7 con 80–119 turnos).
4. **Reconstrucciones de caché en frío: $108.** Los subagentes cachean 5 minutos (las sesiones principales, 1 hora). Un agente que espera a CI o a una revisión más de 5 minutos reescribe todo su contexto en el turno siguiente: $65 en 247 eventos. Volver tras horas a una sesión de 400k cuesta lo mismo: $43 en 29 eventos. 25 agentes con 4 o más esperas largas pagaron $49,66.
5. **Esfuerzo.** Los cuatro días corrieron en `medium` (Fable en `high`); `xhigh` se fijó como defecto el 2026-10-24, lo que solo puede sumar.

## Qué se instaló

| Dónde | Qué | Efecto |
|---|---|---|
| `~/.claude/settings.json` | `autoCompactWindow: 200000`; `effortLevel: medium` para Sonnet 5.5 y Opus 5.5 (`modelSettings`); `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` | contexto topado en torno a 200k; sin `xhigh`; los subagentes sin modelo propio usan Sonnet |
| `~/.claude/cost-hygiene.md` | reglas cortas, importadas desde `~/.claude/CLAUDE.md` | modelos de subagentes, esperas acotadas, salida acotada, relevo pasados ≈150k tokens |
| `~/.claude/agents/issue-implementer.md` | Sonnet, `medium`, `experimental.cacheTtl: 1h` | los implementadores aguantan esperas de hasta una hora sin reconstruir la caché |

Los tres vienen de `global/` y los instala `apply-global.mjs` (idempotente; `--dry-run` para ver qué haría). Guarda la configuración original como `~/.claude/settings.json.pre-cost-controls`. `/setup` no toca la configuración global: la instalación es manual.

Notas:

- `effortLevel` de primer nivel no se aplica a Opus 5.5; por eso va en `modelSettings`.
- `CLAUDE_CODE_SUBAGENT_MODEL` no pisa un `model` pasado al lanzar el agente ni el del frontmatter, y `Explore` y `Plan` lo ignoran salvo con `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`.
- La caché de 1 hora va solo en el implementador. Aplicada a todos los subagentes (`subagentPromptCacheTtl`) ahorra la mitad: los 221 agentes que nunca esperan pagarían escrituras más caras para nada. Claude Code ignora `1h` mientras la suscripción usa créditos de uso.
- Un agente definido por archivo recibe solo su cuerpo como prompt de sistema: el contexto base baja de unos 30k a unos 16k tokens, pero pierde el prompt por defecto de Claude Code. Probarlo con un issue antes de usarlo en todos.
- Verificado con una sesión `claude -p`: el subagente escribe la caché con TTL de 1 hora (15 896 tokens, ninguno de 5 minutos), con Sonnet y esfuerzo `medium`. **No** se verificó en vivo el compactado a 200k ni `CLAUDE_CODE_SUBAGENT_MODEL`.

## Medir el efecto

```
node docs/costes/usage-report.mjs --since 2026-10-25
```

Compara el total diario con los ≈$218 de la línea base. Estimaciones sobre los datos de la línea base, cada una por separado: compactar a 200k ahorra un 16 %; Fable a Opus, un 13 %; subagentes de Opus a Sonnet, un 5 %; ninguna espera de subagente de más de 5 minutos, un 9 %; ninguna reconstrucción en frío en sesiones principales, un 6 %. Combinadas sin contar dos veces: un 41 % (tope de 200k, Fable a Opus, subagentes de Opus a Sonnet, sin esperas largas) a un 47 % (con tope de 150k y sin reconstrucciones en sesiones principales). Suponen el mismo número de turnos; un modelo más barato puede necesitar más.

## Hábitos que la configuración no impone

- `/clear` entre tareas distintas (no cuesta nada). `/compact` antes de dejar una sesión grande parada una hora: compactar tras una espera larga relee todo sin caché.
- Cambiar de modelo al empezar la sesión; un cambio a mitad pierde la caché.
- Fable solo a propósito.

## Aplicado a thereelcapital

`patches/thereelcapital-pr-status.patch` hace que `scripts/pr-status.sh --wait` vuelva a los 4 minutos (`PR_STATUS_WAIT_MAX`) con el estado hasta ese momento, y actualiza `CLAUDE.md`, `CONTRIBUTING.md` y `docs/runbook.md`. **No está aplicado**: en ese repo un cambio de código exige PR con la puerta de revisión local, y el nombre de la rama necesita un número de issue. Aplicarlo desde un checkout actualizado de `main` de thereelcapital: `git apply <ruta>/thereelcapital-pr-status.patch`.

Cubre las esperas de CI; las de revisión (hasta 90 minutos) las cubre la caché de 1 hora del implementador. Se probó con un `gh` falso: el tope salta justo al agotar el presupuesto y un error real de `gh` sigue propagándose.
