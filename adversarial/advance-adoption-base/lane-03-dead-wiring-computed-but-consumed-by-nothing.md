# Adversarial pass — task advance-adoption-base — lane 3: Dead wiring — computed but consumed by nothing

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
 .stallion-base                                     |   2 +-
 ...ity-trust-boundaries-that-believe-the-client.md |  74 +++++++++
 ...rization-and-tenancy-who-else-can-reach-this.md |  70 +++++++++
 ...dead-wiring-computed-but-consumed-by-nothing.md |  69 ++++++++
 ...ams-where-a-double-stands-in-for-the-machine.md |  70 +++++++++
 ...ent-drift-docs-and-controls-diverge-silently.md |  71 +++++++++
 ...silent-correctness-liveness-and-reachability.md |  70 +++++++++
 .../lane-07-the-repair-itself.md                   |  72 +++++++++
 .../lane-08-the-self-replacing-artifact.md         |  69 ++++++++
 tasks/advance-adoption-base.json                   |  30 ++++
 tasks/wave1-red-green-pins.findings.json           | 174 +++++++++++++++++++++
 tasks/wave1-red-green-pins.json                    |  62 ++++++++
 12 files changed, 832 insertions(+), 1 deletion(-)

```

Files touched:
.stallion-base
adversarial/wave1-red-green-pins/lane-01-input-forgeability-trust-boundaries-that-believe-the-client.md
adversarial/wave1-red-green-pins/lane-02-authorization-and-tenancy-who-else-can-reach-this.md
adversarial/wave1-red-green-pins/lane-03-dead-wiring-computed-but-consumed-by-nothing.md
adversarial/wave1-red-green-pins/lane-04-mock-vs-live-seams-where-a-double-stands-in-for-the-machine.md
adversarial/wave1-red-green-pins/lane-05-law-and-enforcement-drift-docs-and-controls-diverge-silently.md
adversarial/wave1-red-green-pins/lane-06-silent-correctness-liveness-and-reachability.md
adversarial/wave1-red-green-pins/lane-07-the-repair-itself.md
adversarial/wave1-red-green-pins/lane-08-the-self-replacing-artifact.md
tasks/advance-adoption-base.json
tasks/wave1-red-green-pins.findings.json
tasks/wave1-red-green-pins.json


## Output contract (exactly one JSON object, nothing else)

{"findings": [{"severity": "CRITICAL|HIGH|MEDIUM|LOW", "claim": "<what is wrong, where, and why it escapes>", "evidence": "<file:line or command output>"}]}

If your lane truly finds nothing, answer {"findings": []} — but say so only after checking every
clause above against every file in the diff, not after the first file.
