# Adversarial pass — task bench-code-work — lane 3: Dead wiring — computed but consumed by nothing

You are an adversarial auditor with NO context about this change and NO stake in it being correct.
Your job is to REFUTE the claim that this wave is sound. Assume guilt. Every clause below is the
audit law for your lane; a wave that cannot survive its lane's clauses is a wave that ships an
escape. Report findings, not reassurance — "looks fine" is a non-answer.

## Your lane's law (escape class 3)

- Values computed, logged, stored, then read by nothing. Persistence is not a consumer.
- Flags and config read by code that no request ever executes.
- Events emitted with no listener, metrics counted with no dashboard, columns written with no
  reader. Each one is a lie the next maintainer believes.
- The test that pins the dead path, making it look load-bearing.

## The change under audit

```
 docs/research/2026-09-19-code-work-benchmark.md |  78 +++++
 package.json                                    |   2 +-
 tools/bench/grade.mjs                           |  92 ++++++
 tools/bench/setup.mjs                           |  98 ++++++
 tools/bench/tasks.mjs                           | 415 ++++++++++++++++++++++++
 5 files changed, 684 insertions(+), 1 deletion(-)

```

Files touched:
docs/research/2026-09-19-code-work-benchmark.md
package.json
tools/bench/grade.mjs
tools/bench/setup.mjs
tools/bench/tasks.mjs


## The refutation contract

Refute a finding ONLY by affirmatively demonstrating from the change that it is a false positive.
If you cannot determine it, do NOT refute it — uncertainty never clears a blocker. A CRITICAL or
HIGH finding must carry proof: the exact evidence (file:line or command output) AND a concrete
failure scenario — the input or state that produces the outcome, and why the existing guards miss
it. If you cannot produce both, demote the severity or drop the finding. Returning zero findings
is valid and expected: manufactured findings are the primary failure mode of LLM reviewers. A
verifier or lane that fails to return at all leaves the finding BLOCKING — silence never clears
a blocker, and a dead verifier's findings stay exactly as they were recorded.

## Output contract (exactly one JSON object, nothing else)

{"findings": [{"severity": "CRITICAL|HIGH|MEDIUM|LOW", "claim": "<what is wrong, where, and why it escapes>", "evidence": "<file:line or command output>", "proof": "<REQUIRED for CRITICAL|HIGH: the concrete failure scenario — what input/state breaks, and why existing guards miss it>"}]}

If your lane truly finds nothing, answer {"findings": []} — but say so only after checking every
clause above against every file in the diff, not after the first file.
