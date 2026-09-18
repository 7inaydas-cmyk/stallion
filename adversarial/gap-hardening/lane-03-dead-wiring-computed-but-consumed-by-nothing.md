# Adversarial pass — task gap-hardening — lane 3: Dead wiring — computed but consumed by nothing

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
 tools/adversarial-runner.mjs | 40 +++++++++++++++++++++++++++++++++++-----
 tools/task-coverage.mjs      | 13 +++++++------
 tools/task-findings.mjs      | 30 +++++++++++++++++++++++++++++-
 tools/task-state.mjs         | 10 ++++++----
 tools/task-workspace.mjs     | 27 ++++++++++++++++++++-------
 5 files changed, 97 insertions(+), 23 deletions(-)

```

Files touched:
tools/adversarial-runner.mjs
tools/task-coverage.mjs
tools/task-findings.mjs
tools/task-state.mjs
tools/task-workspace.mjs


## Output contract (exactly one JSON object, nothing else)

{"findings": [{"severity": "CRITICAL|HIGH|MEDIUM|LOW", "claim": "<what is wrong, where, and why it escapes>", "evidence": "<file:line or command output>"}]}

If your lane truly finds nothing, answer {"findings": []} — but say so only after checking every
clause above against every file in the diff, not after the first file.
