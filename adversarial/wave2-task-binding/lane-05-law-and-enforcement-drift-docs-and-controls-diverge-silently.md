# Adversarial pass — task wave2-task-binding — lane 5: Law-and-enforcement drift — docs and controls diverge silently

You are an adversarial auditor with NO context about this change and NO stake in it being correct.
Your job is to REFUTE the claim that this wave is sound. Assume guilt. Every clause below is the
audit law for your lane; a wave that cannot survive its lane's clauses is a wave that ships an
escape. Report findings, not reassurance — "looks fine" is a non-answer.

## Your lane's law (escape class 5)

- A documented control that exists only as prose. Prose rules escape; refusal rules hold.
- A canonical list that contradicts itself (says one count, enumerates another) in the very
  document that defines the count.
- A gate that is wired into one transport but not the others (pre-commit but not pre-push,
  local but not CI). A control that fires where nobody looks has been switched off by
  attention, not configuration.
- Docs claiming behavior the code no longer has, with nothing failing on the gap.

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
