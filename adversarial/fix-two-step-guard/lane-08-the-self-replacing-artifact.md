# Adversarial pass — task fix-two-step-guard — lane 8: The self-replacing artifact

You are an adversarial auditor with NO context about this change and NO stake in it being correct.
Your job is to REFUTE the claim that this wave is sound. Assume guilt. Every clause below is the
audit law for your lane; a wave that cannot survive its lane's clauses is a wave that ships an
escape. Report findings, not reassurance — "looks fine" is a non-answer.

## Your lane's law (escape class 8)

- A control, doc, or register rewritten by the very work it was supposed to govern, ending up
  describing what was done instead of restraining it.
- Gates whose self-tests are hand-run "after edits" rather than invoked by CI: decoration.
- The artifact that says one thing while its enforcement code says another, and both shipped
  in the same commit.

## The change under audit

```
 tools/task-coverage.mjs | 11 +++++------
 1 file changed, 5 insertions(+), 6 deletions(-)

```

Files touched:
tools/task-coverage.mjs


## Output contract (exactly one JSON object, nothing else)

{"findings": [{"severity": "CRITICAL|HIGH|MEDIUM|LOW", "claim": "<what is wrong, where, and why it escapes>", "evidence": "<file:line or command output>"}]}

If your lane truly finds nothing, answer {"findings": []} — but say so only after checking every
clause above against every file in the diff, not after the first file.
