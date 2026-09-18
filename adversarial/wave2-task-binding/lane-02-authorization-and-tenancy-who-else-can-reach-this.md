# Adversarial pass — task wave2-task-binding — lane 2: Authorization and tenancy — who else can reach this?

You are an adversarial auditor with NO context about this change and NO stake in it being correct.
Your job is to REFUTE the claim that this wave is sound. Assume guilt. Every clause below is the
audit law for your lane; a wave that cannot survive its lane's clauses is a wave that ships an
escape. Report findings, not reassurance — "looks fine" is a non-answer.

## Your lane's law (escape class 2)

- Every new route or handler: name who may call it, then check the code enforces that answer.
- IDs from the request reaching a query without a tenancy predicate. Object-level checks, not
  role-level only.
- Admin or operator surfaces reachable through the same path as user surfaces, differing only
  by a flag the client sets.
- Internal tools and jobs that bypass auth "because they are internal". Name the boundary.

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
