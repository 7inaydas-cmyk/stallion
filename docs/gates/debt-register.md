# Process-debt register

**Why this file exists.** `tools/debt-gate.mjs` (vendored from the Antitube harness 2026-09-20)
reads THIS file and fails when an OPEN row is past its commit budget. Upstream, a correct RCA
diagnosis once decayed into a document nobody re-read for 168 commits while the unshipped fixes
compounded into a fresh pile of findings in exactly the classes it had targeted — a register that
nothing READS is not a register. This file is the data half of that lesson, vendored with the
gate that reads it.

A row leaves this register only by:

- **SHIPPED** — cite the commit and what landed;
- **DROPPED** — record the drop decision verbatim; never paraphrase a verdict into a status.

Never by being forgotten.

## How it works

`gate-baseline: af4fd70dec9d` — the commit the executable clock counts from. Reset this line
whenever rows ship; the clock exists to stop FUTURE decay, not to be born red over the past.

- **Due-by is a commit count, not a date** — velocity, not the calendar, is what outruns a guardrail.
- **Status** is `OPEN`, `SHIPPED` (cite the commit) or `DROPPED` (cite the decision).
- A session that ships a process fix updates this file in the same commit.
- The gate refuses an EMPTY register (zero parseable rows is a GATE_DEFECT, not an all-clear) —
  which is why the example row below exists: it keeps the register valid until the first real row
  replaces it.

## Rows

| id | item | source | priority | due-by | status |
|---|---|---|---|---|---|
| PD-0 | **EXAMPLE ROW — format only, not real debt.** Demonstrates the row shape to the gate and to readers: id `PD-<n>`, a due-by of `next <n> commits`, and a status that starts with OPEN/SHIPPED/DROPPED (annotations may follow the keyword). Replace this row when the first real entry lands; the gate accepts any `PD-<n>`. | vendored 2026-09-20 | P3 | next 50 commits | SHIPPED (2026-09-20: shipped with `tools/debt-gate.mjs` itself; format example, replaced by the first real row) |
