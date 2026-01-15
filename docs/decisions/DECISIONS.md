# Decisions

The decisions register: dated, append-only entries recording the human acts that authorize work
the lifecycle treats as sensitive (protected and migration risk classes). An approval recorded
with `task-state approve --ratification <ref>` must cite a FULL entry heading from this file,
verbatim. A substring is not a decision.

Format: one `## <date> — <TITLE>` heading per decision, prose below it stating what was
authorized and any scope limits. Supersede additively; never rewrite a recorded decision.

---

## 2026-01-15 — ADOPTION: this repository runs its code through the task lifecycle

Example entry (the self-tests cite this heading). Every commit that touches code carries a
`task: <id>` footer naming a task record the state machine authorized. Wiring lives in
docs/WIRING.md. Scope: the push path only; working-tree edits stay free; docs and config
commits need no record.
