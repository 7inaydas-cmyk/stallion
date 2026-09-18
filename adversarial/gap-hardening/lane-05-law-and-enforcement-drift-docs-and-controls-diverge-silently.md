# Adversarial pass — task gap-hardening — lane 5: Law-and-enforcement drift — docs and controls diverge silently

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
