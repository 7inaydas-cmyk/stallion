# ECC mechanism study — what stallion is absorbing, and why

Source studied: github.com/affaan-m/ECC v2.2.1 ("the agent harness operating system"), a Claude
Code plugin framework (~294 skills, 68 prompt-file agents, 94 commands, ~55 hooks, a Rust TUI, an
installer apparatus). Studied 2026-09-19 for mechanism porting; full grilling decision tree in the
session log. The blunt finding first, then what we took.

## The blunt finding

Most of ECC's volume is distribution apparatus: per-language prompt checklists, prompt-file agents,
self-declared "legacy" commands, multi-harness ports, installer/manifest/fingerprint machinery. The
guides are blog posts. What is genuinely load-bearing is small — almost entirely in
`scripts/hooks/` (GateGuard, block-no-verify, config-protection, pre-commit quality scan),
`workflows/orch-review.workflow.js` (fail-closed adversarial verification), and three schemas
(capsule envelope, findings-with-proof, state). That core is exactly stallion's scale: a focused
implementer could re-express each mechanism in a few hundred lines of zero-dependency Node.

## Mechanisms absorbed (issues #12–#15)

1. **Hash-chained append-only journals** (ECC `schemas/capsule-envelope.schema.json`): `seq` equals
   the line index; `parent_hash` is the previous entry's `entry_hash` (64 zeros at genesis);
   `entry_hash` is sha256 of the canonical JSON of the entry with its own hash removed. Stallion's
   records were append-only but only tamper-VISIBLE (the git diff); chains make them tamper-EVIDENT.
2. **Fail-closed refutation semantics** (ECC `orch-review.workflow.js`): "Set isReal=false ONLY if
   you can affirmatively demonstrate from the diff that the finding is a false positive… If you
   cannot determine… do NOT refute it… Uncertainty must never clear a blocker"; a dead verifier
   leaves the finding blocking; a dead reviewer means the verdict is never clean.
3. **Proof-required findings, enforced in the schema** (ECC `agents/code-reviewer.md` +
   FINDINGS_SCHEMA `allOf/if/then`): CRITICAL/HIGH carry evidence plus a concrete failure scenario,
   refused at record time — "enforce it in the schema, not only in the reviewer prompt"; zero
   findings is a valid answer, because manufactured findings are the primary failure mode of LLM
   reviewers.
4. **Deny-once-then-allow fact-forcing** (ECC `scripts/hooks/gateguard-fact-force.js`): refuse the
   first mutating touch of each target with an exact fact demand, mark it asked, allow the retry —
   "instead of asking 'are you sure?', demand concrete facts; the act of investigation creates
   awareness that self-evaluation never did."
5. **Denial dampening + batch-sibling truth** (same file): identical repeated denials push models
   into loops — condense after N denials, carry an ordinal, never repeat textually; and a hook that
   sees one call at a time must say "other edits in this batch may already be applied — re-read."
6. **Bypass-flag and gate-self-protection refusals** (ECC `block-no-verify.js`,
   `config-protection.js`): agents weaken gates to make checks pass; block the bypass flags and the
   config edits that do it.
7. **Pre-execution staged-content scanning** (ECC `pre-bash-commit-quality.js`): validate the
   pending commit's message and staged content (secrets, debugger) before the process starts, so it
   works where git hooks aren't installed.
8. **Evidence-graded handoff shape** (ECC `commands/save-session.md`): worked-with-evidence /
   failed-with-the-exact-reason ("'threw X because Y' is useful; 'didn't work' is not") / not-tried.
9. **Evidence-keyed dedup before refutation** (ECC orch-review): dedup on normalized evidence, not
   titles or line numbers, keeping the strictest severity — raw findings collapsed roughly by half
   before verifier spend.

Deliberately NOT taken: ECC's prompt libraries, agents-as-files, installer/manifests, TUI, LLM
wrapper, multi-harness ports (framework scale, and stallion's bet is the opposite one); the SE0–SE4
effect-class taxonomy (valuable, but stallion's events don't yet have heterogeneous effects worth
classifying); session-summary persistence and continuous-learning ("instincts") — worth a future
look once task-gate exists.
