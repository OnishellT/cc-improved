# Plan rules in detail

Read this when you write the plan and the task creates files, needs a decision or has no named interface.

- `files`: every repo-relative file the task creates or changes, tests and new ADRs included. An entry ending in `/` covers a directory. Editing anything else later needs the user's permission.
- `interface` pins the file and export names (and signatures) the tests import. Cite where each comes from in `source`: the ticket key, a spec path or an existing file path. The gate checks that every export name appears literally, as a word, in the cited evidence, and that the words of a new file's name appear there too. A name that is not there counts as invented and the plan is denied. If nobody gives a name, propose names with AskUserQuestion (recommended first) and record the answer as a decision.
- New files: name them like their siblings (same casing and separators) after the noun the ticket uses. One module per ticket noun, not a new catch-all file.
- Signatures: copy the argument shape the ticket or the existing callers use (an object with named fields stays an object; same units and types). Reuse existing helpers (validators, parsers, types) instead of adding parallel ones.
- `seams`: test attachment points, chosen per the tdd skill. Each has a test file (listed in `files`), what it catches and what it misses. At least one. Every acceptance criterion of the ticket, the invalid-input ones included, needs a seam.
- `decisions`: only real choices the code and docs do not settle, each with 2-4 `options`, recommended first. When an ADR, a spec, the ticket or an existing file settles one, set `source` to its path (`path#section` allowed). Otherwise ask the user with AskUserQuestion before ExitPlanMode, put the answer in `answer`, set `source` to the ADR you will add (`docs/adr/<next number>-<slug>.md`) and list that ADR in `files`. Plan mode cannot write it now, so the implementer writes it with the question, the options and the answer.
