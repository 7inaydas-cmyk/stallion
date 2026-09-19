# stallion-enforcement (ZCode plugin)

The problem: agents stop invoking the lifecycle after a handful of turns. Prompts lose
influence under context pressure — instruction decay — and an `AGENTS.md` nobody re-reads is
adoption by consent. This plugin moves the law to a transport that cannot decay: a
**PreToolUse hook that denies the edit itself**, within one action of the mistake, judged by
the repo's OWN vendored harness so the gate cannot drift from the staged gate and the push
fence that re-judge the same code later.

## What ships

- `hooks/authoring-gate.mjs` — PreToolUse, matcher `Edit|Write|ApplyPatch`. A CODE edit is
  allowed only when an in-flight task (executing/verified/adversarial) whose declared scope
  covers the file exists. Everything else exits 2 (block) with the rule, the evidence, and an
  exact fix command on stderr. Fails closed: unreadable payload, no vendored harness, or a
  harness missing law exports all refuse.
- `hooks/banner.mjs` — SessionStart + UserPromptSubmit. Re-injects the live task state (task,
  phase, scope, next command) every turn, including after compaction. Fails open: advisory
  context must never brick a session.
- `lib/law-source.mjs` — locates the session repo's harness (stallion shape
  `tools/task-coverage.mjs` + `tasks/`, vendored shape `tools/harness/task-coverage.mjs` +
  `docs/harness/task-state/`) and imports `isCodePath`, `recordRefusal`, `scopeRefusal`,
  `citationRefusal`, `PHASES`, `derivePhase`, `scopeOf` from it. The law is never copied.
- `lib/gate-law.mjs` — the pure decision core; `--self-test` proves every refusal and
  allowance both directions.

## Install

1. Copy this directory to your plugins location (Settings → Plugin Management → add from
   filesystem), or symlink it. The plugin's `hooks/hooks.json` registers the hooks; a plugin
   hook enables the hook runner automatically — no `hooks.enabled` flag needed (that flag is
   the config-file route, which stays off by default).
2. `node` (>= 18) must be on PATH; the hooks are `type: "process"` hooks (argument vector, no
   shell), so the executable bit does not matter.
3. The repo you edit must vendor a stallion harness (one of the two layouts above). A repo
   without one refuses code edits closed, with the fix in the message.

## Verify (run all of these; never trust the diff)

```
node tools/zcode-plugin/lib/gate-law.mjs --self-test          # the pure law, both directions
printf '%s' '{"tool_name":"Edit","cwd":"<repo>","tool_input":{"file_path":"<repo>/README.md"}}' \
  | node tools/zcode-plugin/hooks/authoring-gate.mjs          # exit 0: docs are not code
printf '%s' '{"tool_name":"Edit","cwd":"<repo>","tool_input":{"file_path":"<repo>/tools/x.mjs"}}' \
  | node tools/zcode-plugin/hooks/authoring-gate.mjs          # exit 2 with rule+fix
printf '%s' '{"cwd":"<repo>"}' | node tools/zcode-plugin/hooks/banner.mjs   # task banner JSON
```

Then trigger a real edit in the client and read the hook run records (Settings → Plugin
Management → the plugin's hooks; outcomes are also in the ZCode log with duration and the
error-stream preview). The gate and the banner must both appear as runnable.

## Boundaries (honest)

The gate judges edits, not transport: commits and pushes are still judged by the repo's own
commit-msg gate and push fence — this plugin is the third transport, the earliest one. A
hand-edited task record fools this gate exactly as well as it fools the staged gate; the
fence's record checks and the record's git history remain the tamper trail. The banner's
JSON output shape follows the strict hook-output schema (`hookSpecificOutput.hookEventName`);
if a client version rejects it, the banner stays silent (fail open) and the gate keeps
working on exit codes alone.
