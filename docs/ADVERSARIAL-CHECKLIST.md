# The adversarial checklist — eight escape classes

A fresh-context reviewer gets the diff plus this checklist and one instruction: refute the claim
that the change is sound. Every class below exists because code in the wild escaped through it.
The examples are patterns, not accusations; substitute your domain.

## The escape classes

### 1. Input forgeability — trust boundaries that believe the client

Any value that crosses from a client into a trusted computation is an attack surface until
pinned server-side. Hunt for:

- Attribution and analytics values the client supplies (source, campaign, referer) that later
  decide money, ranking, or moderation. If a field influences outcomes, the client must not be
  its author.
- Timestamps and sequence the client sends, used as if the server observed them.
- Pagination cursors that leak or trust row identity (a cursor naming a primary key hands out
  an enumeration oracle).
- "It came from our own frontend" as an authenticity argument. A browser is the client.

### 2. Authorization and tenancy — who else can reach this?

- Every new route or handler: name who may call it, then check the code enforces that answer.
- IDs from the request reaching a query without a tenancy predicate. Object-level checks, not
  role-level only.
- Admin or operator surfaces reachable through the same path as user surfaces, differing only
  by a flag the client sets.
- Internal tools and jobs that bypass auth "because they are internal". Name the boundary.

### 3. Dead wiring — computed but consumed by nothing

- Values computed, logged, stored, then read by nothing. Persistence is not a consumer.
- Flags and config read by code that no request ever executes.
- Events emitted with no listener, metrics counted with no dashboard, columns written with no
  reader. Each one is a lie the next maintainer believes.
- The test that pins the dead path, making it look load-bearing.

### 4. Mock-vs-live seams — where a double stands in for the machine

- A test double whose behavior diverges from the real dependency on error paths. Doubles agree
  on the happy path by construction; they disagree exactly where production breaks.
- Adapters tested only against fakes, never once against the real thing before ship.
- "Works in the sandbox" claims where the sandbox differs from production in auth, network,
  timing, or data shape.
- Environment-gated skips that silently stop testing the thing they were written to test.

### 5. Law-and-enforcement drift — docs and controls diverge silently

- A documented control that exists only as prose. Prose rules escape; refusal rules hold.
- A canonical list that contradicts itself (says one count, enumerates another) in the very
  document that defines the count.
- A gate that is wired into one transport but not the others (pre-commit but not pre-push,
  local but not CI). A control that fires where nobody looks has been switched off by
  attention, not configuration.
- Docs claiming behavior the code no longer has, with nothing failing on the gap.

### 6. Silent correctness, liveness, and reachability

- Failure paths that swallow errors and report success (catch-and-continue where the catch
  empties the meaning).
- Work queued that never runs; timers armed that never fire; retries that give up quietly.
- States that can be entered but never exited, records written but never read back.
- Anything where the failure mode is "nothing happens". Nothing-happens is the hardest bug
  class to notice and the easiest to ship.

### 7. The repair itself

When auditing a fix, the fix is the most suspect code in the diff:

- The pin that asserts a true sub-statement instead of the claim (grepping for a string that
  appears in comments as well as code proves nothing).
- The repro that was never verified byte-level (mangled fixture bytes "confirm" false theories).
- The fix that adapts a surface without authenticating against the real one.
- The test added after the fact that passes against both the fixed and the broken code. Run it
  against the pre-fix source and watch it fail, or it pins nothing.

### 8. The self-replacing artifact

- A control, doc, or register rewritten by the very work it was supposed to govern, ending up
  describing what was done instead of restraining it.
- Gates whose self-tests are hand-run "after edits" rather than invoked by CI: decoration.
- The artifact that says one thing while its enforcement code says another, and both shipped
  in the same commit.

## Per-audit mechanics

- The reviewer is fresh-context: no part in writing the change, no stake in it passing.
- Findings, not reassurance. "Looks fine" is a non-answer.
- Every finding names severity, the claim, and evidence (file:line or command output).
- A clean lane is clean only after every clause was checked against every file in the diff.
- Any UNRESOLVED finding blocks the task from finishing; resolutions carry evidence paths,
  accepted risks carry written justifications. Forever, in the register.
