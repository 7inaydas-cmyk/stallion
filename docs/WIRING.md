# Wiring stallion into a repository

The tools are dependency-free Node scripts that resolve your repo root from their own location
(`tools/` at the root). Adoption means vendoring: copy `tools/` into your repo, add the scripts,
wire the push control. Fork and adapt; the trees and defaults are knobs, not law.

## 1. Vendor the tools

```bash
git subtree add   # or plain copy: tools/*.mjs into <your-repo>/tools/
```

## 2. Scripts (package.json)

```json
{
  "scripts": {
    "task-state": "node tools/task-state.mjs",
    "adversarial": "node tools/adversarial-runner.mjs",
    "workspace": "node tools/task-workspace.mjs",
    "task-coverage": "node tools/task-coverage.mjs"
  }
}
```

## 3. The decisions register

Create `docs/decisions/DECISIONS.md` (see stallion's own for format). Protected and migration
tasks cite its full entry headings when approved. This is the human authorization surface: the
machine checks that an approval names a real, recorded decision.

## 4. The push control

`task-coverage` refuses a push whose range contains a code commit without an authorizing
`task: <id>` footer. Run it at every transport that can refuse:

**pre-push hook** (`.githooks/pre-push`, with `git config core.hooksPath .githooks`):

```bash
guard_base="origin/$(git branch --show-current)"
if [ -n "$guard_base" ]; then
  node tools/task-coverage.mjs --base "$guard_base" || exit 1
fi
```

**CI** (GitHub Actions shape; give it the same base your other range checks use):

```yaml
- name: Task coverage
  run: node tools/task-coverage.mjs --base "${{ github.event.before }}"
```

**A push wrapper** works too: anything that can refuse before `git push` runs.

## 5. Knobs

- `CODE_TREES` / `CODE_EXTS` / `CODE_NAMES` in `tools/task-coverage.mjs`: what counts as code in
  your layout. Defaults fit a typical monorepo (`apps/`, `packages/`, `tools/`, `deploy/`,
  TypeScript/JavaScript/shell, Dockerfile, Caddyfile).
- `tasks/` — where records and findings registers live (both tools; keep them committed, the git
  history is the tamper evidence).
- `docs/ADVERSARIAL-CHECKLIST.md` — the eight classes the refute bundles carry. Edit it to your
  domain; the runner pins the lane count and fails loudly if the format changes.

## What is deliberately NOT enforced

Working-tree edits are free; the fence is the push. Docs and config commits need no task record.
Nothing stops a hand-edited record; the git history of the record file is the evidence trail.
These are boundaries, not gaps, and they are stated so nobody has to discover them.
