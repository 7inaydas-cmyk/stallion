# Stallion

The build-time harness that AI agents work under while writing code for a target
repository. It exists to move process rules out of prompts and into tools that refuse.

## Language

**Harness**:
The refusal layer governing how code gets written: task lifecycle, findings,
adversarial passes, push coverage. It operates only while code is being written.
_Avoid_: calling any part of it product infrastructure, runtime, or internals of the
target repo.

**Target repo**:
The repository whose code is written under the harness (the private host repo). The
harness is vendored into its tree but ships nothing into the product and replaces
none of the target repo's own machinery.
_Avoid_: "the project" used alone — it ambiguously names either the harness or the
target.

**Risk class**:
One of exactly six: planning-only, docs-only, runtime-code, protected, migration, experiment.
The lifecycle doc owns the list; the tools enforce it verbatim.
_Avoid_: harness-docs-only, product-protocol — pre-extraction names, removed.

**In flight**:
A task at executing, verified, or adversarial. Done is not in flight: a finished task
authorizes no new code at the staged gate.

**Scope**:
The code blast radius a task declares as append-only glob events on its record.
The commit-msg gate and the push fence refuse code files outside it; docs and
state files are never scoped.
_Avoid_: allowance, budget, permission list.

**Fact gate**:
The deny-once intervention at act boundaries: the first mutating touch of a target
refuses with a demand for concrete facts, and the retry proceeds. Bypass flags are
refused always; they are law, not questions.
_Avoid_: confirmation prompt, speed bump.

**Authoring gate**:
The edit-time transport: the ZCode plugin's PreToolUse hook that denies a code edit
unless an in-flight, scoped task covers the file. It imports the law from the repo's
own vendored harness, so it judges with the same functions as the staged gate and
the push fence. Distinct from the fact gate: the fact gate asks once at an act, the
authoring gate refuses every uncovered edit.
_Avoid_: calling it a linter, or the fact gate.

**Turn banner**:
The SessionStart/UserPromptSubmit hook that re-injects the live task state (task,
phase, scope, next command) every prompt. The transport cure for instruction decay.
Fails open: advisory context must never brick a session.
_Avoid_: calling it a reminder or a system prompt.

**Agreement matrix**:
The battery contract test that drives one fixture set through all three transports
(staged gate, citation seam, authoring gate) against the real law and asserts the
relations that must hold. Drift between transports becomes a failing battery, not a
discovered behavior.
_Avoid_: calling it a lint or a snapshot.

**Adoption base**:
The pinned revision where the push fence starts auditing, committed as `.stallion-base` so
CI clones can resolve it. History before it is grandfathered; a base that fences an empty
range is a refusal, not a configuration.

**Authoring layer (stallion)**:
The harness agents work under while writing and testing code: task lifecycle, RED→GREEN
pins, commit binding, adversarial passes. It governs the writing, never the running.

**Ingest layer**:
The target repo's own gates that judge what lands: its push fences, approvals, and CI.
Stallion's hardening ports down into it; its law stays the target repo's own.
_Avoid_: describing either layer as replacing the other.
