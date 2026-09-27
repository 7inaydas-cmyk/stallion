# Wiring stallion into a repository

The tools are dependency-free Node scripts that resolve your repo root from their own location
(`tools/` at the root) — the one deliberate exception is complexity-gate's optional TypeScript
compiler, declared as an optional peer dependency; skipping that gate means deleting
`tools/complexity-gate.mjs` and dropping its battery line, `docs/gates/complexity*.json`, and its
`complexity-gate-new-file` guard in `docs/gates/guard-reach.json`.
Adoption means vendoring: copy `tools/` into your repo, add the scripts, copy `docs/gates/`
and edit it to your repo, wire the fences. Fork and adapt; the trees and defaults are knobs, not
law.

## 1. Vendor the tools

```bash
git subtree add   # or plain copy: tools/*.mjs into <your-repo>/tools/
```

Commit the lineage WITH the copy: `tools/harness/VENDOR.json` (schema
`stallion/vendor-manifest@1`) records the upstream stallion commit, the sha256 of every vendored
file as it stands in your tree (grafts included), and the host paths of the law docs the
refusals cite. `vendor-drift` runs it both ways — an undeclared, patched, or deleted vendored
file refuses with a re-vendor remedy, and remedies only name paths your tree actually carries.
The corpus is anchored: the gate must live inside the tree it polices, so a manifest nominating
some other directory refuses as born-scoped. The upstream sha is recorded provenance — a host
without stallion's git history cannot machine-check it offline, so every refusal prints it for
the human to verify at re-vendor time. Vendored code is superseded by re-vendoring, never by
patching; every re-vendor regenerates the manifest in the same commit.

## 2. Scripts (package.json)

```json
{
  "scripts": {
    "task-state": "node tools/task-state.mjs",
    "adversarial": "node tools/adversarial-runner.mjs",
    "workspace": "node tools/task-workspace.mjs",
    "task-coverage": "node tools/task-coverage.mjs",
    "selftest": "node tools/task-findings.mjs --self-test && node tools/task-state.mjs --self-test && node tools/adversarial-runner.mjs --self-test && node tools/task-workspace.mjs --self-test && node tools/task-coverage.mjs --self-test && node tools/task-gate.mjs --self-test && node tools/pathspec.mjs --self-test && node tools/retrospective.mjs --self-test && node tools/test-lint.mjs --self-test"
  }
}
```

(The example shows the six core members a basic vendoring carries, closed over their imports
(pathspec, retrospective, test-lint); this repo's own battery also
runs `tools/bench/grade.mjs` and the plugin's law checks — every `tools/**/*.mjs` that dispatches
on `--self-test` belongs in the script.) The doctor derives the tool list from the tree and
refuses a battery that omits a member — a self-test the battery never runs is a silent skip, the
exact regression that once shipped a vacuous adversarial-runner self-test through a green
battery.

## 3. Tell the agents: AGENTS.md

AGENTS.md is the one file every coding agent reads (Codex documents its precedence rules for
it; Claude Code can import it via `@AGENTS.md`). Paste a stanza like this at your repo root and
keep it true:

```md
# AGENTS.md

Code in this repo is written under the stallion task lifecycle.

- Before planning: `node tools/task-state.mjs status`
- Code lands only under a task: `node tools/task-state.mjs new <id> --risk-class <class>`,
  advanced one phase at a time (intake, planned, executing, verified, adversarial, done).
- Commits that touch code carry a `task: <id>` footer on its own line, last paragraph.
- Every task declares its blast radius at `planned`: `node tools/task-state.mjs scope <id> --add
  "tools/**"` — code commits outside the declared scope are refused at commit time and at push.
- `verified` needs a command pin AND a green whole-battery run (`advance verified` runs
  `npm run selftest` at the boundary); `done` needs a clean adversarial pass and every pin
  re-run GREEN (twice, with the recorded RED signature gone — intermittent and vacuous greens
  refuse); `task-state handoff <id>` prints the evidence-graded handoff.
- The lanes themselves are gradeable: `adversarial-runner calibrate <past-task-id>` replays a
  recorded wave's real diff to fresh lane bundles, and `calibrate-verdict` refuses unless they
  rediscover two-thirds (rounded up) of the wave's CRITICAL/HIGH findings — a grader that
  cannot fail is not a grader.
- Refusals print the exact fix command. Run it. Do not work around a refusal.
- Self-check the wiring: `node tools/task-coverage.mjs --doctor`
```

## 4. The decisions register

Create `docs/decisions/DECISIONS.md` (see stallion's own for format). Protected and migration
tasks cite its full entry headings when approved. This is the human authorization surface: the
machine checks that an approval names a real, recorded decision.

## 5. The inner gate: refuse at stage time

`.githooks/pre-commit`:

```bash
#!/bin/sh
node tools/task-coverage.mjs --staged || exit 1
node tools/detached-head-guard.mjs || exit 1
```

The doctor checks that the pre-commit hook, committed and live, runs the detached-head guard;
this hook is the guard's only live run.

Activate per clone: `git config core.hooksPath .githooks`. Agents that skip hooks (aider does,
by default) are still fenced at push (next section) — the inner gate exists so the refusal
lands within one action of the mistake, not as the last line of defense.

**Claude Code PreToolUse hook** (blocks before `git commit` runs at all). Exit-code translation
matters: Claude Code blocks a tool call only on exit 2; stallion refuses with exit 1, so wrap:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash(git commit*)",
        "hooks": [ { "type": "command", "command": "sh -c 'node tools/task-coverage.mjs --staged || exit 2'" } ]
      }
    ]
  }
}
```

Without the `|| exit 2`, a refusal is a non-blocking error and the commit proceeds.

## 6. The binding gate: refuse at message time

`.githooks/commit-msg` (git passes the message file as `$1`):

```bash
#!/bin/sh
node tools/task-coverage.mjs --commit-msg "$1" || exit 1
```

The staged gate (§5) proves SOME task is in flight; the binding gate proves THIS commit's footer
names a real, in-flight task whose DECLARED SCOPE covers every staged code file. A code commit
with no footer, an unknown id, a finished task, or code outside the declared scope refuses here
— within one action of the mistake — with the exact fix command. The push fence (§7) re-judges
the same law (one shared citation law, both transports), so a clone without hooks — and
`--no-verify`, and partial `git commit <paths>` commits that skip hooks — is still fenced at
push; for those transports the refusal lands at the fence, not at the commit. The doctor
certifies a commit-msg hook only when it passes `"$1"` through and does not swallow the verdict
(a hook line certifies only when its verdict reaches git: `|| exit N` where N is not a multiple
of 256 (`|| exit 2` is the Claude Code translation), or the hook's last command, or a line run
while `set -e` is in force (a later `set +e` undoes it). An `sh -c '…'` wrapper's inner exit sets
only the wrapper's status, so in a hook file that line too must be last or run under `set -e`.
Anything else after the arguments (`; exit 0`, `|| echo`, `&`, `|| true`, `|| exit 256`)
certifies nothing).

Declare the scope when the task is planned and amend append-only while it is in flight:

```bash
node tools/task-state.mjs scope fix-the-thing --add "apps/api/**,packages/db/**"
```

Globs are repo-relative whole-path matches: `**` crosses directories, `*` and `?` stay inside
one segment, and the first segment must name a top-level tree — a pattern that could start
anywhere (`**/*`, `*/**`) covers everything and refuses. The admission law also runs on the
judge path: a hand-edited malformed or over-broad pattern matches NOTHING and the record fails
closed. Docs and state files are not code — the scope binds code files only. Scope reaching the
fence's own surface (`.githooks/**`, `.github/**`, `docs/gates/**`, `.stallion-base`) is
protected-tier blast radius: only a protected or migration task with a recorded approval may
declare it — judged STRUCTURALLY (a pattern whose leading segments coincide with a surface root
refuses whether or not the named file exists) and re-judged at BOTH transports, the commit-msg
gate and the push fence, not only at declaration time. At the fence the re-judgment carries the
same mid-history-law cutover as every law here: commits at-or-after 3bf3bac answer to it, and
commits that settled before keep the first-segment law of their day. Tasks
created before the scope-law cutover (2026-09-18T20:50:00.000Z in stallion's own history) are
grandfathered for their settled commits — a FINISHED task never authorizes new code, whatever
its age. The fence discriminates against the SETTLED ANCHOR — the remote tip this push is
about to update, or the explicit `--base` a CI fence step supplies; the one input outside the
push itself. A task whose record already reads done AT THE ANCHOR is finished settled work:
new commits citing it refuse. A task first-landing in this push (or still in flight at the
anchor) authorizes its own tail commits — a wave's code, written in flight, lands with it.

## 7. The intervention gate: refuse at the act, not the transport

`tools/task-gate.mjs` (from the ECC study) refuses at ACT boundaries inside the agent's tool
loop — the pattern ECC's GateGuard proved: asking "are you sure?" gets "yes"; demanding
concrete facts gets investigation.

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Edit|Write|MultiEdit", "hooks": [ { "type": "command", "command": "sh -c 'node tools/task-gate.mjs --stdin || exit 2'" } ] },
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "sh -c 'node tools/task-gate.mjs --stdin || exit 2'" } ] }
    ]
  }
}
```

(`--stdin` reads Claude Code's PreToolUse payload — `tool_input.file_path` for an edit,
`tool_input.command` for a command, and `session_id`, which keeps concurrent conversations from
sharing gate state; an agent with another hook contract passes `--edit <file>` /
`--bash <command>` / `--session <id>` instead; the `|| exit 2` translation is the Claude Code
blocking form — see §5. The Bash matcher is ALL commands, not git-only: the
destructive laws cover `rm`, `dd`, and SQL, and a compound like `cd pkg && git push --force`
never starts with `git`.) Three laws: the FIRST edit of each file per session refuses with
a fact demand (importers, affected surface, the user's instruction verbatim — the retry passes);
gate-bypassing git commands (`--no-verify`, `commit -n`, `-c core.hooksPath=`) refuse ALWAYS;
destructive commands (force push, hard reset, `rm -rf`, SQL drops) deny once per session with a
rollback demand. Denials carry a strictly increasing session ordinal — never textually
identical, condensing after the third full demand shown (never the once-per-session rollback
demand; bypass refusals carry the ordinal but never count toward condensing) — because identical
repeated denials feed the repetition loops they refuse. Session state lives in `.stallion/gate-state-*.json` (repo-local, gitignored,
30-minute TTL); the self-test runs in the `selftest` battery. The staged-content scan (secrets,
`debugger`) rides in the commit-msg gate (§6) — same transport, no new wiring.

Why bypass blocking lives HERE and not in the commit-msg gate: `--no-verify` never reaches a
git hook by definition — the flag's entire effect is skipping them. A gate cannot judge a
command it never sees, so bypass refusal belongs to the one transport that sees the command
before the shell runs it.

Honest boundary, stated rather than hidden: the classifiers read the command TEXT through one
quote-aware scan — single-token quotes are tokens, interpreter/eval payloads are classified one
level deep, backslash escapes and ANSI-C `$'…'` decoding are modeled, and compounds split at
UNQUOTED separators only. What no static view can classify: variable expansion (`$v`), command
substitution (`$(…)`), scripts piped into an interpreter (`echo '…' | sh`), and nesting beyond
one level — these resolve only at execution. The gate is friction that demands facts, not a
shell parser and not a security boundary; the push fence is the control for what reaches the
remote. Extending the quoting model is deliberately incremental: every sweep finds one more
spelling, and the honest answer is the fence, not an arms race.

### The edit-time transport: the ZCode plugin

One transport earlier than all of the above: `tools/zcode-plugin/` is a ZCode plugin whose
PreToolUse authoring gate DENIES a code edit unless an in-flight, scoped task covers the file,
judged by THIS repo's own vendored harness functions (both the stallion and the
`tools/harness/` layouts are auto-detected), plus a turn banner that re-injects the task state
every prompt — now with a derived SITREP line (done count, last done task with its title and
date, how far the tip sits ahead of the remote), each fact independently fail-open so advisory
context never bricks a session. Install and verification steps live in `tools/zcode-plugin/README.md`; the
doctor checks its hook manifest is present and wired (a matcher covering no edit tool, a
missing banner event, a gate nothing dispatches, or a registered hook script missing from disk
all refuse), and the battery runs its law checks (`gate-law`, `agreement-check`) alongside
every tool. In runtimes without a hook system, this transport simply does not exist there —
the staged, message, and push transports below are the control.

## 8. The push control

`.githooks/pre-push`:

```bash
#!/bin/sh
node tools/task-coverage.mjs --pre-push || exit 1
```

`--pre-push` also reads the refs git is pushing (stdin) and refuses any pushed tip outside the
checked-out history — push another branch from its own checkout, where the fence judges it
whole. CI and manual runs use the bare command.

The base is resolved inside the tool, in order: an explicit `--base <rev>`, then
`git config stallion.push-base <rev>` (local override), then the COMMITTED `.stallion-base`
file (the one a CI clone can read — this is what keeps the first push of a branch auditable),
then the current branch's remote-tracking ref. If nothing resolves, the check REFUSES rather
than skipping. Pin the adoption base once, when you wire up:

```bash
node tools/task-state.mjs new pin-adoption-base --risk-class protected
node tools/task-state.mjs approve pin-adoption-base --decision "<full docs/decisions/DECISIONS.md entry heading>"
node tools/task-state.mjs advance pin-adoption-base planned
node tools/task-state.mjs scope pin-adoption-base --add .stallion-base
node tools/task-state.mjs advance pin-adoption-base executing
git rev-parse HEAD > .stallion-base && git add .stallion-base tasks/pin-adoption-base.json
git commit -m "chore: pin the stallion adoption base" -m "task: pin-adoption-base"
```

`.stallion-base` is fence surface, so the pin commit sits inside the range it opens and needs a
protected, approved task's footer; every refusal that asks you to pin a base prints this flow.

Everything before that revision is grandfathered; every code commit after it needs a task.
The fence's own surface counts as code: `.stallion-base`, `.githooks/*`, and
`.github/workflows/*` all require a `task:` footer — the gated party cannot rewrite the fence
in the push it fences. Moving the adoption base forward later is a deliberate two-step: push
once with the old base explicit (`--base <old>` or `git config stallion.push-base <old>`),
then let the new base take over — a base that moved inside its own audited range is refused.

**CI**:

```yaml
- name: Task coverage
  if: github.event_name == 'push'
  run: |
    BASE="${{ github.event.before }}"
    if [ "$BASE" = "0000000000000000000000000000000000000000" ]; then
      node tools/task-coverage.mjs
    else
      node tools/task-coverage.mjs --base "$BASE"
    fi
```

(The zero-SHA of a new branch means no prior tip; with no `--base` the tool resolves the
committed `.stallion-base` — a fallback to `origin/<default>` would equal HEAD and fence
nothing. The unconditional bare step earlier in the workflow is the backstop: the delta step
above trusts `github.event.before`, while the bare step re-audits from the pinned base on
every run.)

Pull requests are not re-fenced, on purpose: every commit reaches the default branch through a
push, and every push is fenced.

## 9. The gate for the gate: doctor

```yaml
- name: Wiring doctor
  if: github.event_name == 'push'
  run: node tools/task-coverage.mjs --doctor
```

`--doctor` fails the build when the fence is unwired: hooks (pre-push, pre-commit, commit-msg)
not committed — and, in local runs, not activated (a CI clone cannot observe clone-local
config, so there the activation check skips visibly instead);
no CI coverage step, `CODE_TREES`/`CODE_EXTS` classifying nothing (a gate matching nothing
covers nothing — the vacuous-gate trap), no resolvable push base, no decisions-register
headings, checklist not parsing to eight lanes; the pre-push hook must pass `--pre-push` (the
pushed-refs law runs only under it) and the pre-commit hook must also run
`node tools/detached-head-guard.mjs` — both checked in the committed hooks and in the live
`core.hooksPath` hooks. Each failure prints its fix. Run it locally
too: fresh clones must re-run `git config core.hooksPath .githooks`, and the doctor says so.

## 10. Knobs

- `CODE_TREES` / `CODE_EXTS` / `CODE_NAMES` in `tools/task-coverage.mjs`: what counts as code in
  your layout. Defaults fit a typical monorepo (`apps/`, `packages/`, `tools/`, `deploy/`,
  TypeScript/JavaScript/shell, Dockerfile, Caddyfile). The doctor refuses a classification that
  matches nothing.
- `tasks/` — where records and findings registers live (both tools; keep them committed, the git
  history is the tamper evidence).
- `docs/ADVERSARIAL-CHECKLIST.md` — the eight classes the refute bundles carry. Edit it to your
  domain; the runner pins the lane count and fails loudly if the format changes.

## 11. The gates (the 2026-09-20 merge wave)

These gates joined the lifecycle core — most ported from the Antitube harness (a sibling
lineage that grew them in production), all made config-driven: their repo data lives under
`docs/gates/`, which is the vendor template — copy it and edit it to your repo. Each gate ships
a `--self-test` (the battery runs them all) and fails closed when its config is missing or
malformed. The bullets below are the human-readable enumeration; `docs/gates/gate-registry.json`
is the machine-checked one, and the registry is where drift between the two surfaces gets
caught — which is why this paragraph carries no count to go stale.

- `pathspec` — the ONE path-matching dialect every guard shares (`matches`/`explain`/`firstMatch`;
  `**` spans zero segments). A guard needing a new matching capability adds it here, once.
- `detached-head-guard` — a bare `git commit` on a detached HEAD refuses loudly (colocated-jj
  shape: push succeeds having shipped none of the work) — only a rebase of a branch is exempt
  (git moves that branch when the rebase finishes); a detached HEAD during a merge, cherry-pick,
  revert, bisect, or a rebase/am started detached still refuses; escape `ALLOW_DETACHED_HEAD=1`.
- `debt-gate` — an OPEN row of `docs/gates/debt-register.md` past its commits-since-baseline
  budget fails the build; process debt leaves the register only by SHIPPED or DROPPED, never by
  being forgotten.
- `test-lint` — anti-bug-pinning: tautologies, and source-reading tests that don't strip comments.
- `remote-string-lint` — remote command strings must not expand where they're BUILT
  (backticks/`$( )` in double quotes); corpus and floors in `docs/gates/remote-string.json`.
- `gate-coverage` — every tracked source file is seen by at least one gate declared in
  `docs/gates/coverage.json`; a healthy gate not pointed at the code covers nothing.
- `reader-existence` — every shared-contract union member needs a producer AND a consumer
  (dead members inside used unions are invisible to export analysis); contracts and accepted
  findings in `docs/gates/reader-existence.json`.
- `doc-reconcile` — named prose claims in `docs/gates/doc-claims.json` are re-proved against
  code evidence, bidirectionally: code drifting from the claim fails, the sentence being edited
  away fails. Prose cannot fail; this makes it.
- `complexity-gate` — the ratchet: nothing born convoluted, baselined functions never rise
  (`docs/gates/complexity.json` + baseline). The test-names hatch ships CLOSED here (stallion's
  tests are embedded self-tests); vendors with test files open it via `testGlobs`.
- `guard-reach` — each registered guard is PROVEN to reach a newly-added file in its corpus
  (genuine violations planted into an index copy; `docs/gates/guard-reach.json`). The baseline
  and probe runs use a copy of HEAD's index, so a registered guard must reach a verdict when HEAD
  lists a path the disk lacks — the state of every uncommitted `git rm` or `git mv`. A guard that
  lists the index and reads the disk crashes there, and guard-reach reports it INCONCLUSIVE:
  test-lint and complexity-gate skip such a path (test-lint's `listedOnDisk`, which
  complexity-gate imports) — except that complexity-gate refuses one its baseline still holds
  ceilings for (see "What is deliberately NOT enforced"), so a `git rm` of a baselined source
  reads INCONCLUSIVE until `--update-baseline` runs, as the direct gate reads it stale.
  doc-reconcile's `readCorpus` refuses a vanished tracked file on purpose, but only when some
  registered claim carries `repo-count` evidence — stallion's
  `docs/gates/doc-claims.json` carries none today, so here it cannot fire. Were doc-reconcile ever
  registered alongside such a claim, every uncommitted `git rm` would read INCONCLUSIVE (a false
  red, not an escape). That caveat lives only in this paragraph: its `notRegistered` reason in
  `docs/gates/guard-reach.json` records the edit-probe reason alone, and amending it is fence
  surface.
- `gate-registry` — every gate invocation declared once in `docs/gates/gate-registry.json` and
  drift-checked across the transports that carry it, both directions: missing from a declared
  transport, or shadowing in an undeclared one.
- `vendor-drift` — the vendoring lineage gate (the 2026-09-20 Letta evaluation, gap 3): a
  vendored tree's committed `VENDOR.json` manifest is law, and divergence in either direction
  refuses with a re-vendor remedy — an undeclared file under the corpus, a patched or deleted
  vendored file, a mapped law doc that does not exist. `--upstream` mode keeps stallion itself
  from ever carrying a forged manifest. This is the tool behind §1's "superseded by
  re-vendoring, not by patching" — that sentence was prose until this gate shipped.
  `--freshness <path-to-upstream-clone>` is the WAVE-INTAKE half: it answers "has upstream
  moved past our pin, and did anything vendored move with it" against a local clone (fetch and
  fast-forward it first — the verdict is as current as the clone; a clone behind the pin, or
  behind its own fetched upstream (its tracking branch, else origin/HEAD for a detached clone),
  refuses, and so does a manifest source or docs key that names no file in the upstream tree at
  the pin), and a moved vendored source refuses with the
  re-vendor remedy before the wave's own work lands on the stale pin. Run it at every wave's
  intake; the two batteries' wires carry only the `--self-test`/`--upstream` halves.
- `path-obligations` — the incident list as an executable checklist, graduated from the vendor
  repo's PD-17: advisory, path-keyed, never blocking. `node tools/path-obligations.mjs
  --staged` (or bare for the working change set, untracked included) prints the obligations
  armed by the paths touched plus the minimum context set for them. Wire the `--staged` run
  into `.githooks/pre-commit` beside the staged gate, and declare it in
  `docs/gates/gate-registry.json` with `"advisory": true` (it prints, never blocks; gate-registry
  otherwise refuses a swallowed or non-final bare line as not carried) — that hook edit is fence surface and
  rides a protected task; until wired, run it by hand at commit time and wave intake.
- `retrospective` — the cross-task lessons index (the same evaluation, gap 1): DERIVED from
  every committed findings register, never stored — every live WONT-FIX boundary with its
  justification, the recurring vocabulary of past findings, findings per escape class.
  `adversarial prepare` injects the block into every lane bundle — ALL boundaries,
  severity-ranked, no cap (a recall surface must never drop rows) — so each sweep starts
  standing on what past sweeps learned, and `task-state status` prints the one-line summary.
  `task-state metrics` derives per-task wall-clock span and findings density from the same
  records on demand. Write-only findings were the disease; this is the recall surface.

The doctor carries one derived family check: `docs/gates/` must be non-empty and every JSON in
it must parse. Wiring these gates into pre-push/CI is a vendor choice; gate-registry declares
whatever you wire.

**Antitube-harness mapping, for vendors arriving from that lineage**: risk classes map
`harness-docs-only → docs-only` and `product-protocol → protected` (or `migration`, per case —
both demand a recorded approval citing a decisions-register heading); task records live at
`tasks/<id>.json` and refute bundles at `adversarial/<id>/`; records are hash-chained (a
pre-chain vendored harness adopts chaining on its next wave, grandfathering existing records);
`red-check --expect` binds assertion evidence to every new pin. The lifecycle five (task-state,
task-coverage, task-findings, task-workspace, adversarial-runner) are stallion-native here — an
older vendored copy is superseded by re-vendoring, not by patching.

## What is deliberately NOT enforced

Working-tree edits are free; the fence is the stage gate and the push. Docs and config commits
need no task record — with one boundary earned the hard way: `docs/gates/**` IS code to the
fence (a gate's threshold, exemptions, and baselines are its decision law; the gated party must
not rewrite them in the push they fence — the same precedent as the hooks and CI workflows).
Nothing stops a hand-edited record; the git history of the record file is the evidence trail.
Per-commit battery greenness is not enforced: `npm run selftest` runs at `advance verified` and
in CI on the pushed tip, and no local hook runs it, so an intermediate commit of a multi-commit
landing can be red while the tip is green. test-lint in discovery mode (no path arguments — how
guard-reach and a vendor's pre-commit run it) and complexity-gate list the index and judge the
WORKING TREE. A listed path with no regular file on disk refuses when `git diff --cached` names it
(staged, then deleted), since the next commit would carry content neither tool can read; any other
such path (an unstaged rm, an intent-to-add entry, an untracked dangling link) has no staged
change, so it is skipped and named on stderr with the exit code unchanged — with one exception.
complexity-gate REFUSES (the gate, `--report` and `--update-baseline` alike) when HEAD holds a
skipped path as a file or a link (a committed link resolves on a clean checkout, so its source is
scanned under the link's name) and the baseline holds ceilings for it. Whether the next commit
keeps that source is not visible to a working-tree gate — `git commit` keeps HEAD's copy, and so
does a sparse checkout that leaves it out, while `git commit -a` and a colocated-jj commit (jj
keeps git's index at `@-`) record a plain rm as its deletion — and every guess shipped a red tip:
dropping the rows stripped a source HEAD still tracks; carrying them kept a deleted file's ceilings
behind a false green; carrying only git's skip-worktree entries was blind to jj (which ignores the
bit, and whose own sparse patterns never set it) and to guard-reach's HEAD-index copy (which
carries no bits). The fix names the exits that settle it: put the source back on disk (restore it
from HEAD, or widen a sparse checkout to include it), or stage its deletion with `git rm` and
re-record — so a sparse checkout must hold every baselined source, since the ratchet judges only
what it can read. A committed link that dangles in HEAD itself is refused like any other and clears
only by `git rm`. A path HEAD holds nothing at (an intent-to-add entry, an untracked link) has no
source any commit keeps, so its rows go stale. Neither tool re-reads what a commit carries but the
disk does not show — HEAD's content for a skipped path, a committed file edited on disk without
staging, staged content under a file since edited (staged, then edited); only a clean-clone run (CI
on the pushed tip) judges it. test-lint's explicit paths (this repo's battery runs `test-lint
tools`) walk the disk and never consult the index. Deleting or moving a file that has
complexity-baseline rows needs a baseline refresh in the same task: stage the deletion with `git
rm` (under jj too — `jj commit` then records it), then `--update-baseline`; that refresh is fence
surface, so the task is protected. These are boundaries, not gaps, and they are stated so nobody
has to discover them.
