# Adversarial pass — task ci-adoption-base-fallback — lane 6: Silent correctness, liveness, and reachability

You are an adversarial auditor with NO context about this change and NO stake in it being correct.
Your job is to REFUTE the claim that this wave is sound. Assume guilt. Every clause below is the
audit law for your lane; a wave that cannot survive its lane's clauses is a wave that ships an
escape. Report findings, not reassurance — "looks fine" is a non-answer.

## Your lane's law (escape class 6)

- Failure paths that swallow errors and report success (catch-and-continue where the catch
  empties the meaning).
- Work queued that never runs; timers armed that never fire; retries that give up quietly.
- States that can be entered but never exited, records written but never read back.
- Anything where the failure mode is "nothing happens". Nothing-happens is the hardest bug
  class to notice and the easiest to ship.

## The change under audit

```
.githooks/pre-commit                               |   3 +
 .githooks/pre-push                                 |   4 +
 .github/workflows/selftest.yml                     |  12 +
 .stallion-base                                     |   1 +
 AGENTS.md                                          |  17 ++
 README.md                                          |   7 +
 ...ity-trust-boundaries-that-believe-the-client.md |  40 +++
 ...rization-and-tenancy-who-else-can-reach-this.md |  36 +++
 ...dead-wiring-computed-but-consumed-by-nothing.md |  35 +++
 ...ams-where-a-double-stands-in-for-the-machine.md |  36 +++
 ...ent-drift-docs-and-controls-diverge-silently.md |  37 +++
 ...silent-correctness-liveness-and-reachability.md |  36 +++
 .../lane-07-the-repair-itself.md                   |  38 +++
 .../lane-08-the-self-replacing-artifact.md         |  35 +++
 docs/WIRING.md                                     | 122 ++++++--
 tasks/corrective-refusals-and-wiring.findings.json | 243 +++++++++++++++
 tasks/corrective-refusals-and-wiring.json          |  46 +++
 tools/adversarial-runner.mjs                       |  22 +-
 tools/task-coverage.mjs                            | 337 ++++++++++++++++++++-
 tools/task-state.mjs                               |  89 ++++--
 tools/task-workspace.mjs                           |   2 +-
 21 files changed, 1131 insertions(+), 67 deletions(-)
```

Files touched:
.githooks/pre-commit
.githooks/pre-push
.github/workflows/selftest.yml
.stallion-base
AGENTS.md
README.md
adversarial/corrective-refusals-and-wiring/lane-01-input-forgeability-trust-boundaries-that-believe-the-client.md
adversarial/corrective-refusals-and-wiring/lane-02-authorization-and-tenancy-who-else-can-reach-this.md
adversarial/corrective-refusals-and-wiring/lane-03-dead-wiring-computed-but-consumed-by-nothing.md
adversarial/corrective-refusals-and-wiring/lane-04-mock-vs-live-seams-where-a-double-stands-in-for-the-machine.md
adversarial/corrective-refusals-and-wiring/lane-05-law-and-enforcement-drift-docs-and-controls-diverge-silently.md
adversarial/corrective-refusals-and-wiring/lane-06-silent-correctness-liveness-and-reachability.md
adversarial/corrective-refusals-and-wiring/lane-07-the-repair-itself.md
adversarial/corrective-refusals-and-wiring/lane-08-the-self-replacing-artifact.md
docs/WIRING.md
tasks/corrective-refusals-and-wiring.findings.json
tasks/corrective-refusals-and-wiring.json
tools/adversarial-runner.mjs
tools/task-coverage.mjs
tools/task-state.mjs
tools/task-workspace.mjs

## Output contract (exactly one JSON object, nothing else)

{"findings": [{"severity": "CRITICAL|HIGH|MEDIUM|LOW", "claim": "<what is wrong, where, and why it escapes>", "evidence": "<file:line or command output>"}]}

If your lane truly finds nothing, answer {"findings": []} — but say so only after checking every
clause above against every file in the diff, not after the first file.
