# Adversarial pass — task ecc-gate-round2 — lane 5: Law-and-enforcement drift — docs and controls diverge silently

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
 AGENTS.md                                          |   4 +-
 ...ity-trust-boundaries-that-believe-the-client.md |  75 ++++++++++++
 ...rization-and-tenancy-who-else-can-reach-this.md |  71 +++++++++++
 ...dead-wiring-computed-but-consumed-by-nothing.md |  70 +++++++++++
 ...ams-where-a-double-stands-in-for-the-machine.md |  71 +++++++++++
 ...ent-drift-docs-and-controls-diverge-silently.md |  72 +++++++++++
 ...silent-correctness-liveness-and-reachability.md |  71 +++++++++++
 .../ecc-gate-repairs/lane-07-the-repair-itself.md  |  73 +++++++++++
 .../lane-08-the-self-replacing-artifact.md         |  70 +++++++++++
 docs/WIRING.md                                     |   7 ++
 tasks/ecc-gate-repairs.findings.json               | 133 +++++++++++++++++++++
 tasks/ecc-gate-repairs.json                        |  85 +++++++++++++
 tools/task-coverage.mjs                            |  18 +--
 tools/task-gate.mjs                                |  38 ++++--
 14 files changed, 840 insertions(+), 18 deletions(-)

```

Files touched:
AGENTS.md
adversarial/ecc-gate-repairs/lane-01-input-forgeability-trust-boundaries-that-believe-the-client.md
adversarial/ecc-gate-repairs/lane-02-authorization-and-tenancy-who-else-can-reach-this.md
adversarial/ecc-gate-repairs/lane-03-dead-wiring-computed-but-consumed-by-nothing.md
adversarial/ecc-gate-repairs/lane-04-mock-vs-live-seams-where-a-double-stands-in-for-the-machine.md
adversarial/ecc-gate-repairs/lane-05-law-and-enforcement-drift-docs-and-controls-diverge-silently.md
adversarial/ecc-gate-repairs/lane-06-silent-correctness-liveness-and-reachability.md
adversarial/ecc-gate-repairs/lane-07-the-repair-itself.md
adversarial/ecc-gate-repairs/lane-08-the-self-replacing-artifact.md
docs/WIRING.md
tasks/ecc-gate-repairs.findings.json
tasks/ecc-gate-repairs.json
tools/task-coverage.mjs
tools/task-gate.mjs


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
