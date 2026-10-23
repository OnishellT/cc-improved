# Decisiones

Registro corto de decisiones de proceso del repo. Una entrada por decisión, con su porqué.

## D-001: la revisión de cada PR es local, sin token

- **Contexto:** no hay secreto `CLAUDE_CODE_OAUTH_TOKEN`, así que una GitHub Action de revisión (`claude-code-action`) no puede correr.
- **Decisión:** la revisión la hace un subagente revisor independiente, de solo lectura, que comenta en la PR. El orquestador publica el estado `claude-review` en el commit solo si el veredicto es LGTM, con `gh api repos/{owner}/{repo}/statuses/{sha}`.
- **Alcance de la garantía:** es una garantía de proceso, no criptográfica. Quien tenga permisos de escritura en el repo puede publicar ese estado.
- **Consecuencia:** se elimina `.github/workflows/claude-review.yml`. El estado `claude-review` sigue siendo obligatorio en la protección de `main`.

## D-002: protección de `main` con `strict: false`

- **Contexto:** las PRs paralelas tocan archivos disjuntos (ver `docs/CONVENTIONS.md`), así que exigir que cada rama esté al día con `main` obligaría a rebasar sin necesidad.
- **Decisión:** la protección de `main` usa `strict: false` en los checks obligatorios. El job `test` corre también en `push` a `main`, de modo que una integración rota se detecta justo después del merge.
