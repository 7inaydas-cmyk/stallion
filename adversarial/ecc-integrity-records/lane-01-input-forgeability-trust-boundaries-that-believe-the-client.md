# Adversarial pass — task ecc-integrity-records — lane 1: Input forgeability — trust boundaries that believe the client

You are an adversarial auditor with NO context about this change and NO stake in it being correct.
Your job is to REFUTE the claim that this wave is sound. Assume guilt. Every clause below is the
audit law for your lane; a wave that cannot survive its lane's clauses is a wave that ships an
escape. Report findings, not reassurance — "looks fine" is a non-answer.

## Your lane's law (escape class 1)

Any value that crosses from a client into a trusted computation is an attack surface until
pinned server-side. Hunt for:

- Attribution and analytics values the client supplies (source, campaign, referer) that later
  decide money, ranking, or moderation. If a field influences outcomes, the client must not be
  its author.
- Timestamps and sequence the client sends, used as if the server observed them.
- Pagination cursors that leak or trust row identity (a cursor naming a primary key hands out
  an enumeration oracle).
- "It came from our own frontend" as an authenticity argument. A browser is the client.

## The change under audit

```
 README.md                                       |   4 +-
 docs/TASK-LIFECYCLE.md                          |  15 ++++
 docs/research/2026-09-19-ecc-mechanism-study.md |  56 +++++++++++++
 tools/adversarial-runner.mjs                    |  20 ++++-
 tools/task-coverage.mjs                         |  25 ++++--
 tools/task-findings.mjs                         | 100 +++++++++++++++++++++++-
 tools/task-state.mjs                            |  66 ++++++++++++++--
 7 files changed, 267 insertions(+), 19 deletions(-)

```

Files touched:
README.md
docs/TASK-LIFECYCLE.md
docs/research/2026-09-19-ecc-mechanism-study.md
tools/adversarial-runner.mjs
tools/task-coverage.mjs
tools/task-findings.mjs
tools/task-state.mjs


## The refutation contract

Refute a finding ONLY by affirmatively demonstrating from the change that it is a false positive.
If you cannot determine it, do NOT refute it — uncertainty never clears a blocker. A CRITICAL or
HIGH finding must carry proof: the exact evidence (file:line or command output) AND a concrete
failure scenario — the input or state that produces the outcome, and why the existing guards miss
it. If you cannot produce both, demote the severity or drop the finding. Returning zero findings
is valid and expected: manufactured findings are the primary failure mode of LLM reviewers.

## Output contract (exactly one JSON object, nothing else)

{"findings": [{"severity": "CRITICAL|HIGH|MEDIUM|LOW", "claim": "<what is wrong, where, and why it escapes>", "evidence": "<file:line or command output>", "proof": "<REQUIRED for CRITICAL|HIGH: the concrete failure scenario — what input/state breaks, and why existing guards miss it>"}]}

If your lane truly finds nothing, answer {"findings": []} — but say so only after checking every
clause above against every file in the diff, not after the first file.
