# Stallion code-work benchmark — 2026-09-19

Question: does working UNDER stallion change the results of code work, not just the ceremony
around it? Method: a two-arm sandbox benchmark. Eight fresh agent sessions — four TREATMENT
(stallion vendored: staged + commit-msg gates wired, AGENTS.md law, the full lifecycle
mandatory) and four CONTROL (plain repo, same spec text) — each solved one of four small
zero-dependency coding tasks (two bug-fix with planted defects, two feature). Arms differ ONLY
in the harness. Graded by HIDDEN acceptance suites the agents never saw (deliberately
different from the visible ones), plus a fresh-context adversarial review of all eight outputs
and lifecycle telemetry from the treatment records. n=4 per arm: directional, not statistical.

## Acceptance (hidden suites)

| task | treatment | control |
|---|---|---|
| parse-duration | 8/8 pass | 8/8 pass |
| lru-cache | 6/6 pass | 6/6 pass |
| chunk-generator | 7/7 pass | 6/7 — string chunks yield arrays, not joined strings |
| csv-fields | 8/8 pass | 8/8 pass |
| **total** | **29/29 (100%)** | **28/29 (96.6%)** |

(Grade runs emit exact counts: treatment 8+6+7+8, control 8+6+6+8 — the discrepancy is the
control chunk-generator failure below.)

The one acceptance difference: the CONTROL chunk implementation yields arrays of characters
for string inputs — its author segmented by code unit but never joined the buffer, exactly the
class of half-finished-edge the spec's round-trip sentence forbids. The TREATMENT author hit
the same seam and closed it (their record shows the RED pin over the visible suite failing
first, then the fix covering the string case).

## Adversarial review (fresh-context, all eight outputs, proof-required)

| file | treatment defects | control defects |
|---|---|---|
| parse-duration | 1 LOW (sub-µs rounding) | 1 LOW (float noise: "1.1h" → 3960000.0000000005) |
| lru-cache | 0 | 0 |
| chunk-generator | 1 HIGH (code-point, not code-unit, chunking — non-BMP only) | 1 HIGH (string chunks are arrays — EVERY string input) |
| csv-fields | 0 | 0 |

Both chunk implementations missed the same latent spec subtlety (code-unit vs code-point); the
control's defect additionally broke the common case the hidden suite caught. The parse-duration
LOWs are two different precision stances — treatment rounded (loses sub-µs), control didn't
(gains float noise): a wash at this severity.

## Lifecycle telemetry (treatment records)

- 4/4 tasks: record created, scope declared (all `apps/lib/**`), RED command pin recorded with
  exit 1 BEFORE the fix (digests in the records), work committed with the `task:` footer.
- 2/4 reached `verified` (battery green at the boundary); 2 stopped at `executing` with pins
  recorded — the adversarial pass is the operator's, as instructed.
- The verified battery surfaced two real adoption frictions the control arm never felt: the
  sandbox needed a `selftest` script, and the vendored `task-coverage --self-test` requires the
  decisions register the bare vendoring omits. Both were fixed inside the treatment flow by
  following the refusals' own remedy text — the corrective-refusal loop doing its job.
- Gate refusals observed live before dispatch: no-footer code commit refused; unknown-task
  footer refused; honest scoped commit passed through the real wired hook.

## Cost

Treatment sessions used ~2–8x the tokens of control (more tool calls: lifecycle commands,
battery runs, refusal remedies). That is the price of the evidence trail: every treatment task
ends with a machine-checkable record (pin digests, scope, phases) that control has no
equivalent of.

## Honest reading

On tasks this small, with one model and n=4: acceptance 29/29 vs 28/29 and defect counts
2-vs-3 (both chunk HIGHs being the same missed subtlety) is a DIRECTIONAL signal, not proof.
What the benchmark cleanly shows is mechanism, not magic: stallion did not make anyone smarter,
it (a) forced the failing-test-first pin that the control arm skipped by construction, (b)
caught the one acceptance gap in the control's chunk at commit time rather than review time,
and (c) left an auditable record for every commit. On larger tasks where agents drift — scope
creep, skipped verification, bearer footers — those mechanisms are the actual product.

Reproduce: `node tools/bench/setup.mjs <treatment|control> <taskId> <dir>` then dispatch a
fresh agent per sandbox; `node tools/bench/grade.mjs <dir> <taskId>` grades. The grader
self-test proves discrimination (reference passes all, seed fails some) and is wired into the
battery.
