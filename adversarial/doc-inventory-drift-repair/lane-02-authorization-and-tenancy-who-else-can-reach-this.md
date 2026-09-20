# Adversarial pass — task doc-inventory-drift-repair — lane 2: Authorization and tenancy — who else can reach this?

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
 README.md      | 6 +++---
 docs/WIRING.md | 4 ++--
 2 files changed, 5 insertions(+), 5 deletions(-)

```

Files touched:
README.md
docs/WIRING.md


## The refutation contract

Refute a finding ONLY by affirmatively demonstrating from the change that it is a false positive.
If you cannot determine it, do NOT refute it — uncertainty never clears a blocker. A CRITICAL or
HIGH finding must carry proof: the exact evidence (file:line or command output) AND a concrete
failure scenario — the input or state that produces the outcome, and why the existing guards miss
it. If you cannot produce both, demote the severity or drop the finding. Returning zero findings
is valid and expected: manufactured findings are the primary failure mode of LLM reviewers. A
verifier or lane that fails to return at all leaves the finding BLOCKING — silence never clears
a blocker, and a dead verifier's findings stay exactly as they were recorded.

## Output contract (exactly one JSON object, nothing else)

{"findings": [{"severity": "CRITICAL|HIGH|MEDIUM|LOW", "claim": "<what is wrong, where, and why it escapes>", "evidence": "<file:line or command output>", "proof": "<REQUIRED for CRITICAL|HIGH: the concrete failure scenario — what input/state breaks, and why existing guards miss it>"}]}

If your lane truly finds nothing, answer {"findings": []} — but say so only after checking every
clause above against every file in the diff, not after the first file.
