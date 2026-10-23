# After the implementer answers

Read this when the last line of its answer is not `DONE`, or when a hook asks for a review.

- `BLOCKED: <question>`: ask the user with AskUserQuestion (the options from that line, recommended first). Launch the implementer again with the same brief plus `Answer from the user: <answer>`.
- `FAILED: <report>`: launch the fixer the same way (foreground, the same brief plus the failure report). If the fixer also ends with `FAILED` or `BLOCKED`, tell the user what fails and ask how to go on.
- A hook asks for a review: launch the reviewer it names in the foreground with the brief it describes, plus the Tools section of the implementer brief and what the implementer reported from those tools. On `VERDICT: FIX`, launch the implementer again with the same brief plus the numbered findings.
