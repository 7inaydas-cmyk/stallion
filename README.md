# stallion

A task lifecycle for repos where AI agents write code. Five small Node tools, no dependencies,
that refuse work which should not ship.

The problem they solve is specific. Agents are reliable at producing plausible code and
unreliable at holding process rules in their head. Told "always verify the fix with a failing
test first", an agent will sometimes skip it, and nothing fails when it does. Stallion moves the
rules out of the prompt and into tools that say no.

## What the tools do

`task-state` records each task as an event log and moves it through six phases: intake, planned,
executing, verified, adversarial, done. The record is a JSON file under `tasks/`. Phase is
derived from the events, never stored, so history cannot be quietly rewritten.

The interesting part is what it refuses:

- a planning-only task can never reach `executing`
- a protected or migration task needs an approval that cites a full entry heading from your
  decisions register; a substring is not a decision
- `verified` requires evidence paths for RED checks (a test that has not been shown to fail
  against the broken code pins nothing), and the files must still exist at transition time
- `done` requires an adversarial findings register that aggregates clean

`adversarial-runner` mechanizes the review pass. It reads `docs/ADVERSARIAL-CHECKLIST.md` (eight
escape classes, from input forgeability to dead wiring to fixes that only look like fixes),
generates one refute prompt per class over your real diff, and records findings in a register
that fails closed. An empty register is not a clean pass; only a prepared pass counts.

`task-findings` is the shared seam both tools parse through, so "an unresolved finding blocks
done" cannot drift between the tool that records findings and the tool that enforces them.

`task-workspace` gives a task its own jj workspace for parallel drafting. Its one law comes from
a real trap: jj-native commits bypass git hooks, so a workspace drafts and the primary working
copy lands.

`task-coverage` closes the loop at the push. Any commit in the push range that touches code
must carry a `task: <id>` footer naming a record the machine authorized. Wire it into your
pre-push hook and CI; see `docs/WIRING.md`.

Two more fences ship with it. `--staged` refuses a commit that stages code while no task is in
flight, so the refusal lands at the mistake, not at the push. `--doctor` checks the wiring
itself. It fails when the hooks, the CI step, the push base, or a register is missing, so a
clone that quietly lost its fence cannot pretend to have one.

## Why refusal instead of convention

Each rule in stallion replaced a convention that stopped working under pressure. Checklists get
skipped when the session runs long. Hand-run self-tests stop being run. Reviews get friendly.
Every tool here ships a `--self-test` that drives its refusals, not just its happy path, and
stallion's CI runs all five on every push. A gate nobody has watched discriminate is
decoration.

Stallion was built to govern AI-authored commits on a production codebase, and was extracted
standalone without its history. The rules are the ones that survived contact.

## Install

Vendor it. Copy `tools/` into your repo, add the four scripts, create your decisions register,
wire the push control. It is about ten minutes; `docs/WIRING.md` walks it. Node 18 or newer.
Verify the wiring with `node tools/task-coverage.mjs --doctor`, and drop the `AGENTS.md` stanza
from the wiring guide at your root so every agent reads the law.

## License

MIT. Fork it, add tools, change the escape classes to fit your domain.
