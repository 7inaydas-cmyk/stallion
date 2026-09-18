# Adversarial pass — task corrective-refusals-and-wiring — lane 4: Mock-vs-live seams — where a double stands in for the machine

You are an adversarial auditor with NO context about this change and NO stake in it being correct.
Your job is to REFUTE the claim that this wave is sound. Assume guilt. Every clause below is the
audit law for your lane; a wave that cannot survive its lane's clauses is a wave that ships an
escape. Report findings, not reassurance — "looks fine" is a non-answer.

## Your lane's law (escape class 4)

- A test double whose behavior diverges from the real dependency on error paths. Doubles agree
  on the happy path by construction; they disagree exactly where production breaks.
- Adapters tested only against fakes, never once against the real thing before ship.
- "Works in the sandbox" claims where the sandbox differs from production in auth, network,
  timing, or data shape.
- Environment-gated skips that silently stop testing the thing they were written to test.

## The change under audit

```
tools/adversarial-runner.mjs |  26 +++--
 tools/task-coverage.mjs      | 220 ++++++++++++++++++++++++++++++++++++++++---
 tools/task-state.mjs         |  81 +++++++++++-----
 3 files changed, 287 insertions(+), 40 deletions(-)
```

Files touched:
tools/adversarial-runner.mjs
tools/task-coverage.mjs
tools/task-state.mjs

## Output contract (exactly one JSON object, nothing else)

{"findings": [{"severity": "CRITICAL|HIGH|MEDIUM|LOW", "claim": "<what is wrong, where, and why it escapes>", "evidence": "<file:line or command output>"}]}

If your lane truly finds nothing, answer {"findings": []} — but say so only after checking every
clause above against every file in the diff, not after the first file.
