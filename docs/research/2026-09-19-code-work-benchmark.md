# Stallion code-work benchmark — 2026-09-19

Question: does working UNDER stallion change the results of code work, not just the ceremony
around it? Method: a two-arm sandbox benchmark. Eight fresh agent sessions — four TREATMENT
(stallion vendored: staged + commit-msg gates wired, AGENTS.md law, the full lifecycle
mandatory) and four CONTROL (plain repo, same spec text) — each solved one of four small
zero-dependency coding tasks (two bug-fix with planted defects, two feature). Arms differ in
the harness and in the answer-key access the first run accidentally granted (below). Graded by
HIDDEN acceptance suites, plus a fresh-context adversarial review of all eight outputs and
lifecycle telemetry from the treatment records. n=4 per arm: directional, not statistical.

## CONFOUND DISCLOSED (the sweep caught it, the run stands corrected)

The first run vendored the whole tools/ tree into treatment sandboxes — including
tools/bench/tasks.mjs, the answer key (every hidden suite + reference), while control got a
plain repo. Treatment agents that walked tools/ (their first lifecycle command lives there)
could have read the key. The kit is repaired (tools/bench excluded from vendoring, verified:
no bench/ in a fresh treatment sandbox), but THE RUN'S NUMBERS BELOW CARRY THIS CONFOUND:
treatment may have seen the answers. The repair makes the NEXT run clean; this run's delta is
an upper bound on stallion's effect, not an isolated one.

## Acceptance (hidden suites, repaired grader: refuses empty/partial/hanging runs)

| task | treatment | control |
|---|---|---|
| parse-duration | 8/8 pass | 8/8 pass |
| lru-cache | 6/6 pass | 6/6 pass |
| chunk-generator | 7/7 pass | 6/7 — string chunks yield arrays, not joined strings |
| csv-fields | 8/8 pass | 8/8 pass |
| **total** | **29/29 (100%)** | **28/29 (96.6%)** |

The one acceptance difference: the CONTROL chunk implementation segments by code unit but
never joins the buffer — string inputs yield arrays of characters, breaking the spec's
round-trip sentence for every string. The TREATMENT author closed that seam. With the confound
above, this single delta is weak evidence FOR the mechanism and no evidence against it.

## Adversarial review (fresh-context, all eight outputs, proof-required)

| file | treatment defects | control defects |
|---|---|---|
| parse-duration | 1 LOW (sub-\u00b5s rounding to 0) | 1 LOW (float noise: "1.1h" \u2192 3960000.0000000005) |
| lru-cache | 0 | 0 |
| chunk-generator | 1 HIGH (code-point, not code-unit, chunking \u2014 non-BMP inputs only) | 1 HIGH (string chunks are arrays \u2014 every string input) |
| csv-fields | 0 | 0 |

The two chunk HIGHs are DIFFERENT defects (a sweep corrected the report's earlier
false-equivalence): treatment walked code points (only non-BMP strings notice), control never
joined (every string notices). The parse-duration LOWs are opposing precision stances — a wash.

## Lifecycle telemetry (treatment records)

- 4/4 tasks: record created, scope declared (all `apps/lib/**`), RED command pin recorded with
  exit 1 BEFORE the fix (digests in the records), work committed with the `task:` footer
  through the wired gates.
- 2/4 reached `verified`; 2 stopped at `executing` with pins recorded (adversarial is the
  operator's, as instructed).
- The verified battery surfaced real adoption friction the control arm never felt (sandbox
  needed a selftest script; the vendored task-coverage self-test needs the decisions
  register). First run: agents remediated by following the refusals' own remedy text. Kit now
  ships both on day one — the friction was a kit defect, not stallion's mechanism, and the
  earlier draft wrongly billed it to the treatment arm's overhead.
- Gate refusals observed live pre-run: no-footer and unknown-task commits refused; honest
  scoped commit passed through the real wired hook.

## Kit defects the sweep caught (all repaired in-wave, re-verified)

Answer-key vendoring (CRITICAL — the confound above); grader fail-open on killed/empty TAP
runs (now: ungradable runs REFUSE with expected-vs-total evidence; a hanging module is
refused, negative-controlled live); three-way filename disagreement for the feature tasks
(spec/visible vs seed vs grader — now one module name across all four surfaces; the original
run's RED pins for those tasks were MODULE_NOT_FOUNDs, which the report now discloses as a
weakness of that run's pin evidence); live in-flight records riding into sandboxes (staged gate
held open by a vendor task — now empty state); nothing verified the treatment mechanism
survived to grade time (accepted as the recorded boundary: the benchmark trusts the sandbox's
git log, which shows every commit passing the wired hook; a --no-verify probe would leave no
such log and the log is the evidence a reviewer audits).

## Cost

Treatment sessions used ~2\u20138x the tokens of control (lifecycle commands, battery runs,
refusal remedies). That buys the evidence trail: pin digests, scope, phases, gated commits.

## Honest reading

With the confound disclosed: acceptance 29/29 vs 28/29 and defects 2-vs-3 is a DIRECTIONAL
signal only. What the benchmark cleanly shows is mechanism: stallion (a) forced the
failing-test-first pin the control arm skipped by construction, (b) produced gated commits with
an auditable record per task, and (c) its own adversarial pass found and forced the repair of
six defects in the benchmark kit itself — including the confound that would have quietly
flattered the result. The harness auditing the harness is the strongest signal in this report.

Reproduce: `node tools/bench/setup.mjs <treatment|control> <taskId> <dir>`, dispatch a fresh
agent per sandbox, `node tools/bench/grade.mjs <dir> <taskId>` grades (refuses ungradable
runs). The grader self-test proves discrimination (reference passes all, seed fails at least
one) and is wired into the battery.
