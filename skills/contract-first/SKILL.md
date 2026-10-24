---
name: contract-first
user-invocable: false
description: "Pin the contract before editing code: exact names, files, signatures, argument and return shapes, and what happens on invalid input. Use at the start of any feature or fix that adds or changes an interface, and again before calling the work done."
---

# Contract first

Hidden tests fail on three things far more often than on logic: wrong names, wrong argument shapes, and unchecked input. Decide them first, then write code.

## 1. Before editing: write the contract

Derive it from the ticket, the spec and the code. For each thing you will add or change, fix:

- **File and exact name** of every function, class, command or endpoint. Use the ticket's spelling letter for letter.
- **Signature**: parameters in order, whether they are positional or one options object, defaults, and the return value (type, shape, sync or async).
- **Behavior on invalid input** (list below).

If the ticket gives no name or shape, do not invent freely:

1. Open the sibling files (same folder, same layer, their tests) and copy their conventions: naming case, file naming, export style, positional vs options object, error type, how they return failure.
2. State each guess as an assumption in `notes`. Never present a guess as a requirement.

Save it as `.claude/workflow/contract.json` (plain JSON, any language):

```json
{"files": ["src/slug.js", "src/slug.test.js"], "names": ["slugify"], "notes": "assumed: named export like title-case.js; throws TypeError on non-string"}
```

`files` are the paths you will create or change, `names` the exact identifiers that must exist. Keep it small: only what a caller or test would depend on.

## 2. Input validation checklist

For every public entry point, decide what each case does, implement it, and write a test for it. A case you skip is a case you decided on by accident.

- **Wrong type**: string where a number is expected, object where a list is expected.
- **null / undefined / None / nil**: missing argument, explicit null, null inside a collection.
- **Empty**: empty string, empty list or map, whitespace only.
- **Out of range**: zero, negative, above a maximum, NaN or infinity, off-by-one at both ends, very large input.
- **Duplicates**: repeated items, repeated keys, calling twice with the same input (idempotence).

Per case choose one: reject (throw or return the error the sibling code uses), normalize (and say how), or accept as valid. Follow the siblings' choice unless the ticket says otherwise. Put the decision in `notes` when it is not obvious.

## 3. Implement

Write the tests from the contract first or alongside the code: one per decided behavior, including the invalid-input cases above. Use exactly the contract's names and shapes. If you must change the contract, change `contract.json` and say why in your final message.

## 4. Before calling it done

Run the contract check and the project's verify commands:

```
node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/bin/wf-contract-check.mjs
```

It prints `CONTRACT OK` or `CONTRACT NOT MET` with the missing file or name (exit 0 or 1). It checks names as text only: it does not prove behavior, so also confirm that every checklist case has a passing test. Do not report the work as finished while the check fails.
