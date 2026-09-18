# Adversarial pass — task narrow-base-exemption — lane 1: Input forgeability — trust boundaries that believe the client

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
 tools/task-coverage.mjs | 54 +++++++++++++++++++++++++++++++++++++++----------
 1 file changed, 43 insertions(+), 11 deletions(-)

```

Files touched:
tools/task-coverage.mjs


## Output contract (exactly one JSON object, nothing else)

{"findings": [{"severity": "CRITICAL|HIGH|MEDIUM|LOW", "claim": "<what is wrong, where, and why it escapes>", "evidence": "<file:line or command output>"}]}

If your lane truly finds nothing, answer {"findings": []} — but say so only after checking every
clause above against every file in the diff, not after the first file.
