# The task lifecycle

Work on code moves through six phases. The prose here says what each phase means;
`tools/task-state.mjs` refuses what this document forbids, so the rules do not depend on being
remembered.

## Phases

| Phase | Meaning |
|---|---|
| `intake` | the task exists: restated goal, risk class recorded |
| `planned` | spec settled: target files, forbidden files, gate plan, acceptance criteria |
| `executing` | the smallest patch that satisfies the spec |
| `verified` | RED-check evidence recorded, and the evidence files still exist on disk |
| `adversarial` | a fresh-context pass over the diff, recorded in the findings register |
| `done` | terminal; findings register aggregates clean. Reopen as a new task, never by rewinding |

## Risk classes

- `planning-only` — writes nothing. Can never reach `executing`.
- `docs-only` — documentation and registers only.
- `runtime-code` — source changes.
- `protected` — touches whatever your repo fences (gates, hooks, CI). Requires a recorded owner
  approval citing a full entry heading from `docs/decisions/DECISIONS.md` before `executing`.
- `migration` — schema or dependency changes. Same approval requirement.
- `experiment` — spec documents only, implementation not authorized. Can never reach `executing`.

## The law the machine enforces

- Phases advance one at a time, in order. No skips, no backwards moves, nothing leaves `done`.
- `planning-only` and `experiment` tasks never reach `executing`.
- `protected` and `migration` tasks carry an approval whose reference literally equals an entry
  heading in the decisions register. A substring is not a decision.
- `verified` requires a command pin: `red-check --command "<the failing check>"` RUNS the
  command, refuses if it passes, and records the command, its nonzero exit, and an output
  digest. Path evidence supplements but never substitutes; a task that cannot carry a runnable
  pin records a justified `pin-exempt` — accountability, not absence of law.
- A task's code commits are bound by its DECLARED SCOPE: `scope <id> --add "tools/**,docs/*"`
  records the blast radius as append-only glob events (declared once the task is `planned`).
  The `commit-msg` gate refuses code staged outside it at commit time; the push fence re-judges
  the range against the record — and a FINISHED task never authorizes new code at either
  transport, discriminated by history: code written while the task was in flight stays
  authorized, code landing after the task's done-flip commit refuses.
  The footer is a citation; the scope is the binding. Tasks created before
  2026-09-18T20:50:00.000Z are grandfathered for their settled commits (the same cutover
  pattern as the pin law); an undated or malformed creation stamp fails CLOSED, not open.
  Amendments are legal while a task is in flight and are visible as recorded events in the
  record's git history — no machine check reads event-vs-commit ordering.
- `done` requires a findings register that a prepared adversarial pass minted (empty is not a
  pass), that aggregates clean: zero UNRESOLVED findings, whose resolve evidence still exists —
  and every command pin re-runs GREEN. The full RED→GREEN arc is machine-verified at the gate.
- The prepared register records the swept range (base, head, diff digest); `verdict` reports it,
  so a pass can never silently claim to have swept more than it did.
- Records are event logs under `tasks/`. Phase is derived from the last transition, never
  stored. The tool refuses illegal transitions; it cannot cryptographically stop a hand edit,
  and the git history of the record file is the tamper evidence. Records completed before the
  command-pin law carry path-only evidence; the law binds transitions from its introduction.

## Commands

```bash
node tools/task-state.mjs new fix-the-thing --risk-class runtime-code
node tools/task-state.mjs advance fix-the-thing planned
node tools/task-state.mjs scope fix-the-thing --add "apps/api/**,packages/db/**"
node tools/task-state.mjs approve fix-the-thing --decision "<full DECISIONS.md heading>"
node tools/task-state.mjs advance fix-the-thing executing
# ...work; watch the pin fail against the broken code first, then record it...
node tools/task-state.mjs red-check fix-the-thing --command "npm test -- the-pin.test.ts"
node tools/task-state.mjs advance fix-the-thing verified
node tools/adversarial-runner.mjs prepare fix-the-thing
# ...dispatch bundles to fresh-context reviewers, record findings...
node tools/adversarial-runner.mjs verdict fix-the-thing
node tools/task-state.mjs advance fix-the-thing adversarial
node tools/task-state.mjs advance fix-the-thing done
```

## Parallel drafting

`tools/task-workspace.mjs` gives each task its own jj workspace. The law it encodes: jj-native
commits bypass git hooks, so a workspace drafts and the primary working copy lands. Never move
your main bookmark from a workspace.
