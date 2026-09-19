# Decisions

The decisions register: dated, append-only entries recording the human acts that authorize work
the lifecycle treats as sensitive (protected and migration risk classes). An approval recorded
with `task-state approve --decision <ref>` must cite a FULL entry heading from this file,
verbatim. A substring is not a decision.

Format: one `## <date> — <TITLE>` heading per decision, prose below it stating what was
authorized and any scope limits. Supersede additively; never rewrite a recorded decision.

---

## 2026-01-15 — ADOPTION: this repository runs its code through the task lifecycle

Example entry (the self-tests cite this heading). Every commit that touches code carries a
`task: <id>` footer naming a task record the state machine authorized. Wiring lives in
docs/WIRING.md. Scope: the push path only; working-tree edits stay free; docs and config
commits need no record.

## 2026-09-18 — BINDING LAW: the task footer is bound by declared scope, not borne

Closes the bearer-citation boundary (issue #8). Every task created from this decision forward
declares its code blast radius as append-only scope-glob events on its record
(`task-state scope <id> --add`). The `commit-msg` gate refuses, at commit time, a code commit
whose footer names no task, an unknown task, a finished task, or stages code outside the named
task's declared scope; the push fence re-judges every commit in the range against the record,
so clones without hooks stay fenced. Scope amendments are legal while a task is in flight and
are themselves auditable events. Tasks created before 2026-09-18T20:50:00.000Z are
grandfathered — their commits settled under the law of their day.

## 2026-09-19 — THE BATTERY LAW: membership is derived, omissions refuse

The selftest battery's membership is derived from the tree (every `tools/**/*.mjs` that
dispatches on `--self-test`, in any dispatch spelling) and the doctor refuses a battery that
omits a member. Rationale: a vacuous adversarial-runner self-test shipped through a green
battery (issue #16), and the first derivation's single-spelling predicate went blind to
task-gate's own dispatch (caught by review, issue-untracked). A self-test the battery never
runs is a silent skip; the derivation makes it a wiring failure with a fix line. Do not
hand-maintain the member list or the counts.

## 2026-09-19 — DERIVE, DON'T DECLARE: no re-typed subsets of the one taxonomy

Phase subsets are never re-typed: seams slice `PHASES` (imported from task-state, or from the
edited repo's own task-state at decision time, as the plugin does). Rationale: two hand-typed
copies (the workspace drafting window, the plugin's authorizing window) were live drift seeds
(issue #20); a taxonomy change must flow through one seam, not N copies. Anchors ("planned",
"executing", "done") are law stated once; the set is a slice.
