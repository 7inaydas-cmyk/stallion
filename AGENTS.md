# AGENTS.md

Code in this repo is written under the stallion task lifecycle.

- Before planning: `node tools/task-state.mjs status`
- Code lands only under a task: `node tools/task-state.mjs new <id> --risk-class runtime-code`,
  advanced one phase at a time (`intake → planned → executing → verified → adversarial → done`).
- Commits that touch code carry a `task: <id>` footer on its own line, in the final trailer
  block of the message.
- The footer is bound by DECLARED SCOPE: `node tools/task-state.mjs scope <id> --add "tools/**"`
  records the blast radius (append-only, declared at planned). The commit-msg gate refuses code
  staged outside it; the push fence re-judges every commit in the range.
- `verified` needs a command pin (`red-check --command "<failing check>"` — the tool runs it and
  refuses if it passes); `done` needs a prepared adversarial pass that aggregates clean and
  every pin re-run GREEN.
- Refusals print the rule, the evidence, and an exact fix command. Run the fix. Do not work
  around a refusal.
- Verify changes with `npm run selftest`; verify the wiring with
  `node tools/task-coverage.mjs --doctor`.
- Fresh clones: `git config core.hooksPath .githooks` (hooks are committed; the activation is
  per clone, and the doctor enforces it).
