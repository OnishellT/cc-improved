# Cost hygiene

Every turn re-reads the whole context, so whatever stays in context is paid for again on every later turn.

- Subagents: Sonnet for work, Haiku for lookups, polling and formatting. Opus or Fable only when I ask. Ask them to report in at most 10 lines.
- In a subagent (5-minute prompt cache), keep each blocking command under about 4 minutes: use bounded waits and call them again instead of sleep loops.
- Read big files with `grep -n` and `sed -n`, and cap command output (`| head -c 4000`).
- Read PDFs, images and screenshots in a subagent that reports in text.
- When the task changes, or the context passes about 150k tokens, say so and suggest `/clear` or `/compact` before continuing.
