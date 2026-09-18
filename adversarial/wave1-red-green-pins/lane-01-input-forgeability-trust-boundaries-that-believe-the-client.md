# Adversarial pass — task wave1-red-green-pins — lane 1: Input forgeability — trust boundaries that believe the client

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
 AGENTS.md                                          |   5 +-
 README.md                                          |   2 +-
 ...ity-trust-boundaries-that-believe-the-client.md |  46 +++++
 ...rization-and-tenancy-who-else-can-reach-this.md |  42 +++++
 ...dead-wiring-computed-but-consumed-by-nothing.md |  41 +++++
 ...ams-where-a-double-stands-in-for-the-machine.md |  42 +++++
 ...ent-drift-docs-and-controls-diverge-silently.md |  43 +++++
 ...silent-correctness-liveness-and-reachability.md |  42 +++++
 .../gap-hardening/lane-07-the-repair-itself.md     |  44 +++++
 .../lane-08-the-self-replacing-artifact.md         |  41 +++++
 docs/TASK-LIFECYCLE.md                             |  18 +-
 docs/WIRING.md                                     |   3 +-
 tasks/gap-hardening.findings.json                  | 162 +++++++++++++++++
 tasks/gap-hardening.json                           |  47 +++++
 tools/adversarial-runner.mjs                       |  88 +++++++--
 tools/task-coverage.mjs                            |  33 ++--
 tools/task-findings.mjs                            |  39 +++-
 tools/task-state.mjs                               | 201 ++++++++++++++++++---
 tools/task-workspace.mjs                           |  28 +--
 19 files changed, 890 insertions(+), 77 deletions(-)

```

Files touched:
AGENTS.md
README.md
adversarial/gap-hardening/lane-01-input-forgeability-trust-boundaries-that-believe-the-client.md
adversarial/gap-hardening/lane-02-authorization-and-tenancy-who-else-can-reach-this.md
adversarial/gap-hardening/lane-03-dead-wiring-computed-but-consumed-by-nothing.md
adversarial/gap-hardening/lane-04-mock-vs-live-seams-where-a-double-stands-in-for-the-machine.md
adversarial/gap-hardening/lane-05-law-and-enforcement-drift-docs-and-controls-diverge-silently.md
adversarial/gap-hardening/lane-06-silent-correctness-liveness-and-reachability.md
adversarial/gap-hardening/lane-07-the-repair-itself.md
adversarial/gap-hardening/lane-08-the-self-replacing-artifact.md
docs/TASK-LIFECYCLE.md
docs/WIRING.md
tasks/gap-hardening.findings.json
tasks/gap-hardening.json
tools/adversarial-runner.mjs
tools/task-coverage.mjs
tools/task-findings.mjs
tools/task-state.mjs
tools/task-workspace.mjs


## Output contract (exactly one JSON object, nothing else)

{"findings": [{"severity": "CRITICAL|HIGH|MEDIUM|LOW", "claim": "<what is wrong, where, and why it escapes>", "evidence": "<file:line or command output>"}]}

If your lane truly finds nothing, answer {"findings": []} — but say so only after checking every
clause above against every file in the diff, not after the first file.
