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
The repository whose code is written under the harness (currently Antitube). The
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
