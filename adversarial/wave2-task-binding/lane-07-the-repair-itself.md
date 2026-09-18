# Adversarial pass — task wave2-task-binding — lane 7: The repair itself

You are an adversarial auditor with NO context about this change and NO stake in it being correct.
Your job is to REFUTE the claim that this wave is sound. Assume guilt. Every clause below is the
audit law for your lane; a wave that cannot survive its lane's clauses is a wave that ships an
escape. Report findings, not reassurance — "looks fine" is a non-answer.

## Your lane's law (escape class 7)

When auditing a fix, the fix is the most suspect code in the diff:

- The pin that asserts a true sub-statement instead of the claim (grepping for a string that
  appears in comments as well as code proves nothing).
- The repro that was never verified byte-level (mangled fixture bytes "confirm" false theories).
- The fix that adapts a surface without authenticating against the real one.
- The test added after the fact that passes against both the fixed and the broken code. Run it
  against the pre-fix source and watch it fail, or it pins nothing.

## The change under audit

```
 .githooks/commit-msg           |   5 +
 .github/workflows/selftest.yml |  30 ++++++
 AGENTS.md                      |   3 +
 CONTEXT.md                     |   6 ++
 README.md                      |   6 +-
 docs/TASK-LIFECYCLE.md         |   7 ++
 docs/WIRING.md                 |  37 +++++++-
 docs/decisions/DECISIONS.md    |  11 +++
 tasks/wave2-task-binding.json  |  46 ++++++++++
 tools/task-coverage.mjs        | 204 +++++++++++++++++++++++++++++++++++++----
 tools/task-state.mjs           |  96 ++++++++++++++++++-
 11 files changed, 425 insertions(+), 26 deletions(-)

```

Files touched:
.githooks/commit-msg
.github/workflows/selftest.yml
AGENTS.md
CONTEXT.md
README.md
docs/TASK-LIFECYCLE.md
docs/WIRING.md
docs/decisions/DECISIONS.md
tasks/wave2-task-binding.json
tools/task-coverage.mjs
tools/task-state.mjs


## Output contract (exactly one JSON object, nothing else)

{"findings": [{"severity": "CRITICAL|HIGH|MEDIUM|LOW", "claim": "<what is wrong, where, and why it escapes>", "evidence": "<file:line or command output>"}]}

If your lane truly finds nothing, answer {"findings": []} — but say so only after checking every
clause above against every file in the diff, not after the first file.
