# Adversarial pass — task wave2-fence-ancestry — lane 3: Dead wiring — computed but consumed by nothing

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
 ...ity-trust-boundaries-that-believe-the-client.md |  58 ++++++
 ...rization-and-tenancy-who-else-can-reach-this.md |  54 ++++++
 ...dead-wiring-computed-but-consumed-by-nothing.md |  53 ++++++
 ...ams-where-a-double-stands-in-for-the-machine.md |  54 ++++++
 ...ent-drift-docs-and-controls-diverge-silently.md |  55 ++++++
 ...silent-correctness-liveness-and-reachability.md |  54 ++++++
 .../lane-07-the-repair-itself.md                   |  56 ++++++
 .../lane-08-the-self-replacing-artifact.md         |  53 ++++++
 docs/TASK-LIFECYCLE.md                             |   5 +-
 docs/WIRING.md                                     |   5 +-
 tasks/wave2-fence-ancestry.json                    |  36 ++++
 tasks/wave2-task-binding.findings.json             | 199 +++++++++++++++++++++
 tasks/wave2-task-binding.json                      |  15 ++
 tools/task-coverage.mjs                            |  57 +++---
 14 files changed, 727 insertions(+), 27 deletions(-)

```

Files touched:
adversarial/wave2-task-binding/lane-01-input-forgeability-trust-boundaries-that-believe-the-client.md
adversarial/wave2-task-binding/lane-02-authorization-and-tenancy-who-else-can-reach-this.md
adversarial/wave2-task-binding/lane-03-dead-wiring-computed-but-consumed-by-nothing.md
adversarial/wave2-task-binding/lane-04-mock-vs-live-seams-where-a-double-stands-in-for-the-machine.md
adversarial/wave2-task-binding/lane-05-law-and-enforcement-drift-docs-and-controls-diverge-silently.md
adversarial/wave2-task-binding/lane-06-silent-correctness-liveness-and-reachability.md
adversarial/wave2-task-binding/lane-07-the-repair-itself.md
adversarial/wave2-task-binding/lane-08-the-self-replacing-artifact.md
docs/TASK-LIFECYCLE.md
docs/WIRING.md
tasks/wave2-fence-ancestry.json
tasks/wave2-task-binding.findings.json
tasks/wave2-task-binding.json
tools/task-coverage.mjs


## Output contract (exactly one JSON object, nothing else)

{"findings": [{"severity": "CRITICAL|HIGH|MEDIUM|LOW", "claim": "<what is wrong, where, and why it escapes>", "evidence": "<file:line or command output>"}]}

If your lane truly finds nothing, answer {"findings": []} — but say so only after checking every
clause above against every file in the diff, not after the first file.
