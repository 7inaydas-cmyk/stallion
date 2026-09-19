# stallion

A task lifecycle Harness for repos where AI agents write code. Six small Node tools, no dependencies,
that refuse work which should not ship.

The problem they solve is specific. Agents are reliable at producing plausible code and
unreliable at holding process rules in their head. Told "always verify the fix with a failing
test first", an agent will sometimes skip it, and nothing fails when it does. Stallion moves
the rules out of the prompt and into tools that say no.

## What the tools do

`task-state` records each task as an event log and moves it through six phases: intake,
planned, executing, verified, adversarial, done. The record is a JSON file under `tasks/`.
Phase is derived from the events, never stored, so history cannot be quietly rewritten. Every
record created since the chain cutover is also hash-chained (seq, parent hash, entry hash
over canonical JSON): a hand edit is not just visible in git, it breaks the chain the tools
refuse to append to. Records predating the cutover are grandfathered; their integrity law is
the git-history boundary, and a backdated creation stamp on a wholly forged record is that
boundary's known edge.

The interesting part is what it refuses:

- a planning-only task can never reach `executing`
- a protected or migration task needs an approval that cites a full entry heading from your
  decisions register; a substring is not a decision
- `verified` requires a command pin: `red-check --command` runs the failing check, refuses if
  it passes, and records the command with its nonzero exit and an output digest. Advancing
  also runs the whole tool battery at the phase boundary, so a red tool blocks the phase.
- `done` requires an adversarial findings register that aggregates clean, and every pin
  re-runs GREEN at the gate. The full RED-to-GREEN arc is machine-verified, not promised.

`adversarial-runner` mechanizes the review pass. It reads `docs/ADVERSARIAL-CHECKLIST.md`
(eight escape classes, from input forgeability to dead wiring to fixes that only look like
fixes), generates one refute prompt per class over your real diff, and records findings in a
register that fails closed. An empty register is not a clean pass; only a prepared pass
counts. CRITICAL and HIGH findings owe a proof (the concrete failure scenario) at record
time, and the same escape recorded twice refuses: the register keeps the strictest severity
instead of spending resolution effort twice.

`task-findings` is the shared seam both tools parse through, so "an unresolved finding blocks
done" cannot drift between the tool that records findings and the tool that enforces them.

`task-workspace` gives a task its own jj workspace for parallel drafting. Its one law comes
from a real trap: jj-native commits bypass git hooks, so a workspace drafts and the primary
working copy lands.

`task-gate` refuses at the act, not the transport. Wire it through your agent's PreToolUse
hooks (docs/WIRING.md §7; the mechanism study is from ECC). The first edit of a file demands
facts before it proceeds: importers, affected surface, the user's instruction verbatim.
Gate-bypassing git commands (`--no-verify`, re-pointed `core.hooksPath`) refuse outright.
Destructive commands owe a rollback line, asked once per session, then out of the way.
Denials carry a session ordinal so they never repeat verbatim; identical refusals feed the
repetition loops they are meant to stop.

`task-coverage` closes the loop at the push. Any commit in the push range that touches code
must carry a `task: <id>` footer naming a record the machine authorized. Wire it into your
pre-push hook and CI; see `docs/WIRING.md`.

Three more fences ship with it. `--staged` refuses a commit that stages code while no task is
in flight, so the refusal lands at the mistake, not at the push. `--commit-msg` (wired as a
commit-msg hook) binds the footer to a task: it refuses a code commit whose message carries
no `task:` footer, names an unknown or finished task, or stages code outside that task's
DECLARED SCOPE. Scope globs are recorded on the task record
(`task-state scope <id> --add "tools/**"`) and re-judged by the push fence, so a hookless
clone is still fenced. `--doctor` checks the wiring itself. It fails when the hooks, the CI
step, the push base, or a register is missing, so a clone that quietly lost its fence cannot
pretend to have one.

## Why refusal instead of convention

Each rule in stallion replaced a convention that stopped working under pressure. Checklists
get skipped when the session runs long. Hand-run self-tests stop being run. Reviews get
friendly. Every tool here ships a `--self-test` that drives its refusals, not just its happy
path, and stallion's CI runs the battery on every push. A gate nobody has watched discriminate
is decoration.

Stallion was built to govern AI-authored commits on a production codebase, then extracted
standalone without its history. The rules are the ones that survived contact.

## Install

Vendor it. Copy `tools/` into your repo, add the scripts, create your decisions register,
wire the push control. About ten minutes; `docs/WIRING.md` walks it. Node 18 or newer. Verify
the wiring with `node tools/task-coverage.mjs --doctor`, and drop the `AGENTS.md` stanza from
the wiring guide at your repo root so every agent reads the law.

## License

MIT. Fork it, add tools, change the escape classes to fit your domain.
