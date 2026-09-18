# Agent harness landscape: how scaffolds for code-writing agents enforce process

**Date:** 2026-09-18
**Question:** How do the major harnesses/scaffolds for AI coding agents enforce a task lifecycle — what is mechanized (hooks, exit codes, gates, sandboxes) vs left as prompt convention — and what should a refusal-based harness like stallion learn from them?
**Method:** Primary sources only: official documentation, papers on arXiv, source repositories, first-party engineering blogs. Every claim below carries the URL of the source that owns it. Claims that could not be verified from a reachable primary source are marked **[unverified]** or dropped.
**Repo-state note:** stallion at time of writing = five Node CLI tools (`task-state`, `adversarial-runner`, `task-findings`, `task-workspace`, `task-coverage`), six-phase event-log lifecycle, findings register that fails closed, task-footer push gate (per `README.md`).

Doc-location notes from the fieldwork (2026-09-18): OpenAI's Codex docs at `developers.openai.com/codex/*` now 308-redirect to `learn.chatgpt.com/docs/*` (still first-party). `task-standard.metr.org` no longer resolves; METR's task docs live in the GitHub repo plus `taskdev.metr.org` (page body did not render for extraction). The OpenHands repository has pivoted to "Agent Canvas," an orchestration layer that itself runs Claude Code, Codex, Gemini, and OpenHands agents — the classic agent architecture now lives in the SDK docs and an arXiv paper.

---

## 1. Anthropic Claude Code

The only mainstream harness whose refusal semantics are a documented contract. Hooks fire per session/turn/tool-call; `PreToolUse` runs before a tool executes and "Can block it." Exit codes: 0 = success (JSON for structured control), 2 = "a blocking error" whose blocking message is the JSON reason or stderr, every other code = non-blocking error — the action proceeds. A `permissionDecision: "deny"` JSON on exit 0 blocks equally. Crucially the model *sees* the refusal reason, so a block is corrective feedback, not a dead stop. https://code.claude.com/docs/en/hooks

Hooks are **fail-open by design**: a crashed or timed-out hook does not block the tool call, and the docs warn that a "mistyped path in `settings.json` leaves the gate silently disabled." They also advise using the permission system, not hooks, for hard enforcement when a command's effect can't be determined. https://code.claude.com/docs/en/hooks

Permissions are the fail-closed layer: modes `default`/`plan`/`acceptEdits`/`dontAsk`/`bypassPermissions` (+ an `auto` mode with background checks); rules `allow`/`ask`/`deny` are "evaluated in order: deny, then ask, then allow," deny wins across all settings scopes, and — the key sentence — CLAUDE.md instructions "don't change what Claude Code allows": enforcement is client-side, never model-side. https://code.claude.com/docs/en/permissions

State/context: `CLAUDE.md` files are discovered root-down to cwd and concatenated (not overridden), support `@path` imports to depth 4, and target under 200 lines; `/init` generates a starting file. https://code.claude.com/docs/en/memory. Skills are folders with `SKILL.md` under progressive disclosure — only the description sits in context until invoked; embedded `!command` context injection "aborts the entire skill invocation" on failure. https://code.claude.com/docs/en/skills

Concurrency: subagents each run "in its own context window with a custom system prompt, specific tool access, and independent permissions," delegated by description, up to 20 concurrent by default (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`). https://code.claude.com/docs/en/sub-agents

## 2. OpenAI Codex CLI

Mechanical enforcement is sandboxing plus approval policy. Sandbox modes: `read-only` (no writes), `workspace-write` (writes "limited to the active workspace," network "off unless you enable it," `.git` "protected as read-only"), `danger-full-access` (`--yolo`, "No sandbox; no approvals (not recommended)"). Approval policies: `on-request`, `never`, plus a `granular` policy per category; `untrusted` is retired. Denied/failed escalations fail closed: "denied or timed-out requests mean the action still does not run." Platform mechanisms: Seatbelt (`sandbox-exec -p`) on macOS, bubblewrap + seccomp on Linux. The authors themselves caveat the boundary: DNS-rebinding checks "reduce[] risk, but it does not eliminate it." https://learn.chatgpt.com/docs/agent-approvals-security (official redirect target of developers.openai.com/codex/sandbox)

Context is AGENTS.md with explicit precedence: global `~/.codex/AGENTS.md` first (one file only), then a walk from project root to cwd; files are concatenated root-down and "closer to your current directory override earlier guidance because they appear later in the combined prompt," capped at 32 KiB (`project_doc_max_bytes`). Recommended content is exactly stallion's domain: "Always run `npm test` after modifying JavaScript files," "Run `npm run lint` before opening a pull request." https://learn.chatgpt.com/docs/agent-configuration/agents-md

Verification is convention, not gate: those test/lint instructions live in prose; there is no refusal when they're skipped. Repo with full docs tree (`docs/agents_md.md`, `docs/sandbox.md`, `docs/execpolicy.md`, `docs/skills.md`): https://github.com/openai/codex

## 3. SWE-agent (Princeton) — the ACI paper

The strongest evidence anywhere that *interface design alone* moves agent success. Four stated principles: actions should be "simple and easy to understand"; "compact and efficient"; feedback should be "informative but concise"; and "guardrails mitigate error propagation and hasten recovery." The custom ACI reached 12.5% pass@1 on SWE-bench, then state of the art. https://arxiv.org/abs/2405.15793

The guardrail: after every edit, flake8 (codes F821/F822/F831/E111–E113/E999/E902) runs on the file; if the edit introduced errors it is **discarded and the agent retries**, and the error message shows all three of error, would-be edited file, and original file — remove any one and agents misdiagnose or re-issue the same failing command. Observations are capped everywhere: search returns max 50 results with an over-broad-query error; the file viewer shows 100 lines with omitted-line counts. https://arxiv.org/html/2405.15793v3

Ablations (SWE-bench Lite, baseline 18.0%): removing the edit interface −7.7 (to 10.3); full-file viewer instead of 100-line window −5.3 (to 12.7); *iterative paginated* search −6.0 (to 12.0 — worse than no search tools at all, because agents exhaustively paged through matches); edit without linting −3.0; full history instead of last 5 observations −3.0. The authors attribute 23.4% of unresolved instances to cascading failed edits in the lint ablation, and 51.7% of GPT-4 Turbo trajectories contained at least one failed edit. https://arxiv.org/html/2405.15793v3

## 4. Aider

The reference implementation of tight feedback loops. Auto-lint: "By default, aider will lint any files which it edits" with built-in linters; a custom `--lint-cmd` contract is literal exit-code refusal — the linter must "return a non-zero exit code" on errors. Auto-test: `--test-cmd` + `--auto-test` runs the suite "after each time the AI edits your code," and "Aider will try and fix any errors if the command returns a non-zero exit code." https://aider.chat/docs/usage/lint-test.html

Git discipline: "Whenever aider edits a file, it commits those changes with a descriptive commit message" (`--no-auto-commits` to disable); dirty files are committed first so human and AI edits never mix; authorship is attributed with "(aider)" metadata; `/undo` discards the last change. Notably, aider **skips pre-commit hooks by default** (`--git-commit-verify` opts in) — ambient hooks are not something tool authors trust to run. https://aider.chat/docs/git.html

Context strategy is the repo map: "a concise map of your whole git repository" built by "a graph ranking algorithm" over file dependencies, budgeted to `--map-tokens` (default **1k tokens**), re-ranked by git state so recently changed files surface. https://aider.chat/docs/repomap.html. Conventions are prompt-level: a CONVENTIONS.md loaded read-only via `--read` / the `read:` config key. https://aider.chat/docs/usage/conventions.html. Edit formats (whole, diff = `<<<<<<< SEARCH`/`>>>>>>> REPLACE` blocks, diff-fenced, udiff, editor-*) are chosen per model; udiff exists because GPT-4 Turbo had "'lazy coding' tendencies" in other formats. https://aider.chat/docs/more/edit-formats.html

## 5. OpenHands (formerly OpenDevin)

Architecture (V0, still documented): the backend "spawns an Agent and an EventStream"; the agent writes actions into the stream, a Docker-hosted action execution server executes them ("executes various types of actions (shell commands, file operations, Python code, etc.) safely within the container") and returns observations over REST — the rationale is that "arbitrary code can be run safely without risking the host system." https://docs.openhands.dev/openhands/usage/architecture/runtime

The V1 SDK redesign is now a paper: "stateless[ness], composability," typed events, interchangeable workspaces (local single-process, Docker, remote container server), and the empirical claim that "V1 substantially reduces system-attributable failures over V0 with negligible event-sourcing overhead" — an append-only event log as the source of truth costs almost nothing. Skills/microagents are "Reusable user-defined prompts with trigger-based activation" (keyword-triggered or always-active). https://arxiv.org/abs/2511.03690, https://docs.openhands.dev/sdk/arch/overview

The 2026 pivot is itself a datapoint: the flagship repo is now "Agent Canvas," "The self-hosted developer control center for coding agents," which can "Run OpenHands, Claude Code, Codex, Gemini, or any ACP-compatible agent" — the harness layer collapsed into an orchestrator of other vendors' agents. https://github.com/All-Hands-AI/OpenHands

## 6. GitHub Spec Kit

Structured process as prompt skills, not gates: `/speckit-constitution` (once per project), then `specify → plan → tasks → implement → converge` "one at a time, and review the result before continuing"; artifacts are Markdown under `.specify/`. Nothing is mechanically validated — quality gates ("clarification, checklists, and consistency analysis") are optional add-ons. The one hard-sounding rule is still prose: bug-fix verdicts are "verified, partial, or failed," and "Missing verification is not a successful fix." https://github.com/github/spec-kit

## 7. Amazon Kiro

Three artifacts per feature — `requirements.md` (user stories, acceptance criteria "in structured notation"), `design.md`, `tasks.md` ("discrete, executable implementation tasks... with real-time status updates"). The standard workflow has approval gates between phases (the "Quick Spec" variant is contrasted as auto-generating artifacts "without approval gates"); an "Analyze Requirements" pass can "catch inconsistencies, ambiguities, and gaps." Mechanized concurrency is the interesting part: Kiro "analyzes your task list," builds a dependency graph, and groups tasks into waves — wave 1 = no dependencies, later waves sequential, tasks within a wave concurrent. https://kiro.dev/docs/specs

## 8. OpenSpec

`/opsx:explore` → `/opsx:propose` (creates `proposal.md`, `specs/`, `design.md`, `tasks.md` under `openspec/changes/<name>/`) → `/opsx:apply` (works the tasks checklist) → `/opsx:archive` (moves to `openspec/changes/archive/<date>-<slug>/`, "Specs updated"). Specs are "Plain Markdown — requirements with concrete scenarios," SHALL-style with WHEN/THEN. The approval gate is positional, not mechanical: "you review the plan before any code is written" because apply is a separate command. The repo ships `schemas/spec-driven/`, but the README documents no enforced validation CLI. https://github.com/Fission-AI/OpenSpec

## 9. AGENTS.md (the standard)

Pure convention with near-total adoption: "just standard Markdown," no schema, no required fields, "the agent simply parses the text you provide"; discovery is nearest-file-wins ("The closest AGENTS.md to the edited file wins; explicit user chat prompts override everything"); 60k+ open-source projects and every major agent vendor listed as consumers (OpenAI, Google, Cursor, Cognition, Block/goose, Aider, VS Code, JetBrains, ...); stewarded by the Agentic AI Foundation under the Linux Foundation. Recommended content is process rules — build and test commands, testing instructions, "anything you'd tell a new teammate." It is a context convention with zero enforcement. https://agents.md/

## 10. Block's Goose

Rust agent (desktop/CLI/API) with "70+ extensions via the Model Context Protocol" and 15+ providers. https://github.com/block/goose. Its distinctive mechanical layer is adversarial: an "'adversary reviewer' that watches for unsafe actions" alongside "prompt injection detection, tool permission controls, sandbox mode" (per the docs homepage, https://goose-docs.ai/). The adversary-mode page specifies it precisely: "a silent, independent agent reviewer that watches tool calls before they execute," which "evaluates the tool call against your rules and returns ALLOW or BLOCK"; "Blocked tool calls are denied — the agent sees the rejection and cannot retry"; enabled purely by the existence of `~/.config/goose/adversary.md` (plain-language rules). It is **fail-open**: "If the reviewer fails for any reason, the tool call is allowed through." https://goose-docs.ai/docs/guides/security/adversary-mode. Recipes: "Capture workflows as portable YAML configs. Share with your team, run in CI, include instructions, extensions, parameters, and subrecipes." https://goose-docs.ai/. Manual and Smart approval modes exist **[detail unverified — docs page found via search but exact URL not captured]**.

## 11. Cursor

Rules as versioned context with scoping: `.cursor/rules/*.mdc` files with kinds `Always` ("Apply to every chat session"), `Auto Attached` (globs), `Agent Requested` ("the description of the rule will be presented to the Cursor Agent to decide if it should be applied"), `Manual` (`@`-mention only); precedence "Team Rules → Project Rules → User Rules"; nested AGENTS.md merge with "more specific instructions taking precedence"; guidance to "Keep rules under 500 lines." All prompt-side; no exit-code gates. https://cursor.com/docs/context/rules

## 12. Gemini CLI

Terminal agent with "Custom context files (GEMINI.md) to tailor behavior for your projects," conversation checkpointing, MCP servers via `~/.gemini/settings.json`, custom commands/extensions, and linked docs for "Sandboxing & Security" and "Trusted Folders" ("Control execution policies by folder") — the sandbox/approval details live behind those links and were not extracted here. https://github.com/google-gemini/gemini-cli

## 13. Devin (Cognition)

First-party docs confirm the shape, not the machinery: sessions with a Workspace exposing a Shell ("Devin's terminal, where you can watch commands being executed"), an IDE you can "take over," and a Browser; parallel Deins marketed as a core strength ("Tackling many tasks in parallel"); "PR Review" and "Codebase Q&A" listed as standard tasks. Their own usage guidance is a validation of stallion's thesis: prompts should carry "explicit completion criteria" and be "easy to verify." The playbook/knowledge/API pages were not extractable from the reachable docs index, so deeper claims are omitted. https://docs.devin.ai/

## 14. METR Task Standard

The eval-harness answer to "what is a task and when is it done." A task = (1) an environment — "a container or VM with a particular operating system, various installed packages, task-specific files" plus a declared "degree of internet access"; (2) "a string of instructions for the agent"; (3) optional automated scoring. Tasks come in families defined by a Python `TaskFamily` class (`get_instructions`, `install`, `get_tasks`, `score(t, submission) -> float | None`). Acceptance is a function call over end state, not an opinion. Safety defaults are fail-closed on both axes: the flow diagram restricts network access unless "'full_internet' permission [is] requested," and "the agent runs as the `agent` user" that "cannot access files and processes created/owned by `root`." Scale: ~200 families / ~2000 tasks as of Jan 2024. The standard "emerged from the platform that METR built" (Vivaria) and "isn't fully stable yet (it will become so at v1.0.0)." https://github.com/METR/task-standard (task-dev guide at http://taskdev.metr.org; page body did not render for extraction)

---

## Comparison table

| System | Enforcement mechanism | Verification gate | State tracking | Context strategy | Concurrency |
|---|---|---|---|---|---|
| Claude Code | PreToolUse/Stop hooks, exit 2 blocks; permission rules deny>ask>allow; fail-open hooks, fail-closed deny rules | Hooks can *run* checks and block, but writing them is your job (exit-2 contract) | Session transcript; hooks; auto-memory notes | CLAUDE.md root→cwd concat, @imports; skills w/ progressive disclosure | Subagents, own context/tools, 20 parallel default |
| Codex CLI | OS sandbox (Seatbelt / bwrap+seccomp) + approval policies; denied actions fail closed | Prose in AGENTS.md (build/test commands); no gate | Session logs | AGENTS.md global + root→cwd concat, 32 KiB cap, nearest-wins | One session; exec mode non-interactive |
| SWE-agent | Custom ACI: edits linted (flake8), bad edits discarded, output caps (100-line viewer, 50 search results) | Lint-after-every-edit; that gate = +3 pts, its removal = cascading failures (23.4% of unresolved) | Trajectory = observation history (last-5 truncation beats full) | Bounded observations; search/nav tools instead of file dumps | Single agent |
| Aider | Exit-code contracts: linter nonzero = error; auto-commit machinery | Auto-lint every edit; auto-test after edits; "will try and fix any errors" on nonzero | Git history is the log (commit per edit, "(aider)" attribution, /undo) | Repo map (graph-ranked, 1k-token default); CONVENTIONS.md read-only | Single session; dirty-file separation |
| OpenHands | Docker/remote sandbox runtime; event stream between agent and executor | None built-in; plugins/skills | Event-sourced conversation log ("negligible event-sourcing overhead") | Microagents/skills, keyword-triggered | Isolated sessions; multi-agent server; now an orchestrator of other agents |
| Spec Kit | None — slash-command phases with human review between | Prose verdicts; "Missing verification is not a successful fix" | Markdown artifacts under `.specify/` | Constitution + per-feature docs | Sequential by design |
| Kiro | Approval gates between phases (standard workflow) | "Analyze Requirements" consistency check | requirements/design/tasks.md; "real-time status updates" | Codebase analysis feeding design phase | Dependency-graph waves; tasks within a wave parallel |
| OpenSpec | Positional: `propose` and `apply` are separate commands; review between | Schemas exist; enforced validation not documented | `openspec/changes/<name>/` → `archive/<date>-<slug>/` | Plain-Markdown specs, SHALL + WHEN/THEN | Sequential |
| AGENTS.md | None — pure convention | None (tests listed in prose get "attempted") | None | Nearest-file-wins markdown | N/A |
| Goose | Adversary reviewer returns ALLOW/BLOCK pre-execution (fail-open); tool permissions; sandbox mode | Adversary reviews tool calls vs. rules in adversary.md | Session/conversation; recipes as YAML | .goosehints; MCP extensions; recipes | Schedules (cron) **[unverified detail]** |
| Cursor | None at rule level (scoped rule *selection* is mechanical) | None | Rules files | .mdc kinds Always/Auto/Agent-Requested/Manual; globs | IDE-level sessions |
| Gemini CLI | Sandboxing + trusted folders **[docs linked, not extracted]** | None documented in README | Checkpointed conversations | GEMINI.md hierarchy, settings.json | GitHub Action / API **[unverified]** |
| Devin | Not documented in reachable docs | Human watches Shell/IDE/Browser; "explicit completion criteria" advised | Sessions | Workspace state | Parallel Devins as a feature |
| METR Task Standard | Container/VM env; network off unless requested; agent user ≠ root | `TaskFamily.score(t, submission) -> float | None` — programmatic, end-state | TaskRun / scoring logs (Vivaria) | Task instructions string; env definition files | Vivaria runs many task runs |

---

## Lessons for stallion

### What stallion already does that the landscape validates

1. **Exit-code refusal as the enforcement seam.** Claude Code's documented contract — exit 2 blocks, stderr becomes the model's corrective context (https://code.claude.com/docs/en/hooks) — and Aider's linter contract — nonzero exit means an error the agent must fix (https://aider.chat/docs/usage/lint-test.html) — are precisely stallion's tool semantics. Stallion is not inventing a convention; it is using the two most widely deployed ones.
2. **Fail-closed evidence gates.** Stallion's "verified requires RED-test evidence" and "an empty adversarial register is not a clean pass" are the mechanized versions of Spec Kit's "Missing verification is not a successful fix" (https://github.com/github/spec-kit) and METR's programmatic `score()` over end state (https://github.com/METR/task-standard). SWE-agent quantifies the stakes: dropping the edit-lint guardrail cost 3 points and produced cascading failed edits in 23.4% of unresolved runs (https://arxiv.org/html/2405.15793v3).
3. **Append-only event log as task state.** Phase derived from events, never stored, matches OpenHands V1's event-sourcing with "negligible... overhead" (https://arxiv.org/abs/2511.03690). Everyone else stores mutable phase fields; the log design is the more defensible one.
4. **Commit/push-time identity enforcement.** Aider *skips* pre-commit hooks by default (https://aider.chat/docs/git.html) — proof that ambient git hooks are not a reliable enforcement point for agent-authored commits. Stallion's push-range footer check plus CI re-check is the correct shape, and task-footers give what Kiro/OpenSpec only imply: mechanical traceability from commit to task record.
5. **Phase-gated artifacts before code.** Kiro, Spec Kit, and OpenSpec independently converged on requirements → design → tasks artifacts with a review between (https://kiro.dev/docs/specs, https://github.com/github/spec-kit, https://github.com/Fission-AI/OpenSpec). They all gate it with prompts or button-clicks; stallion gates it with refusals. That is a real, unoccupied niche in the table above.

### What stallion is missing that others proved matters

1. **Refusal messages as corrective feedback, not just failure.** SWE-agent's best-performing detail: the rejection shows *the error, the attempted change, and the original*, because omitting any part caused agents to misdiagnose or re-issue the identical failing action (https://arxiv.org/html/2405.15793v3). Every stallion refusal should print three things: the rule violated, the evidence that failed (the actual diff hunk, the actual missing register entry), and the exact remediation command. Goose builds this in — "the agent sees the rejection" (https://goose-docs.ai/docs/guides/security/adversary-mode). This is the single highest-leverage change.
2. **A fast inner gate, not only phase gates.** SWE-agent lints after *every edit*; stallion currently refuses at phase transitions, which can be thousands of tokens and many minutes after the mistake. Claude Code's PreToolUse hook + Codex's AGENTS.md give a cheap deployment path: ship a one-line hook matcher that shells out to the relevant stallion tool on `Bash(git commit*)` / `Edit`, so refusals land within one turn of the violation.
3. **Bounded observations.** Capped output beat uncapped everywhere it was ablated: 100-line viewer beats full file (+5.3), last-5 observations beats full history (+3.0), capped search beats pagination (+6.0) (https://arxiv.org/html/2405.15793v3). The adversarial-runner's per-class refute prompts should carry a bounded, deterministic diff slice, not the whole diff; findings registers should stay line-capped.
4. **A detection story for an unwired install.** Claude Code's own docs warn a misconfigured gate "leav[es] the gate silently disabled" (https://code.claude.com/docs/en/hooks). Stallion's `--self-test` proves the tools discriminate; nothing yet proves the *wiring* exists in a given clone. A `task-state doctor`-style check (pre-push hook present, footers regex active, CI job present) that itself exits nonzero from CI would close the fail-open gap at the adoption layer.
5. **Concurrency testing of the shared seam.** Claude Code parallelizes 20 subagents by default (https://code.claude.com/docs/en/sub-agents) and Kiro explicitly fans out task waves (https://kiro.dev/docs/specs); concurrent appends to one task JSON is therefore a *when*, not an *if*. OpenHands' answer — an append-only log with negligible overhead — says the event-log design survives; it still needs atomic append (single writer, `O_APPEND`, or lockfile) and a CI test that fires N parallel transitions.
6. **AGENTS.md as the adoption surface.** It is the one file every listed agent reads (https://agents.md/), Codex documents exact discovery and precedence for it (https://learn.chatgpt.com/docs/agent-configuration/agents-md), and Claude Code can import it via `@AGENTS.md` (https://code.claude.com/docs/en/memory). A ready-to-paste AGENTS.md stanza ("run `task-state --help` before planning; commits require `task:` footers") is cheaper and more portable than per-agent wiring docs.

### What others do that stallion should deliberately NOT copy

1. **Fail-open error semantics.** Claude Code hooks (crash → action proceeds) and goose's adversary ("If the reviewer fails for any reason, the tool call is allowed through") both choose availability over correctness. Stallion's value is being the exception; never add "if the register is unreadable, allow."
2. **Approval prompts as the primary gate.** Codex's approval policies and Claude Code's permission modes are interactive, human-in-the-loop devices. Stallion's approvals are *recorded* (decisions-register citations, full-heading matches) — that auditability is the product; a runtime prompt would erase it.
3. **An LLM as the enforcement layer.** Goose's adversary and Claude Code's `auto` mode put a model between the action and the gate. Stallion's adversarial pass may be model-*written* but must remain machine-*aggregated* (the `task-findings` seam); the moment a model decides whether a finding blocks, the gate is prompt convention again.
4. **Sandbox/VM machinery.** Seatbelt/bwrap/Seccomp/Docker runtimes (Codex, OpenHands, METR) solve a different problem — untrusted *execution* — at heavy dependency cost. Stallion is build-time governance, dependency-free; the right boundary is the git push, not the syscall.
5. **Spec-prose empires.** Spec Kit's constitutions and OpenSpec's schemas spend their complexity on document form, and their gates remain prose or positional. Stallion gates process, not prose; growing a spec schema would dilute the refusal core.
6. **Iterative/paginated anything.** SWE-agent's pagination ablation is a direct warning: browsing interfaces invite exhaustive, budget-destroying loops (https://arxiv.org/html/2405.15793v3). Keep stallion's interfaces one-shot command → verdict.

### Concrete changes, ranked

1. **Enrich refusal output** to error + evidence + remediation command on every nonzero exit (SWE-agent guardrail pattern; exit-2 stderr contract). Low cost, immediate effect on agent self-correction.
2. **Ship hook snippets, not a dispatch daemon** — the answer to "how much to mechanize the adversarial loop": mechanize the register and aggregation (done), publish PreToolUse/AGENTS.md/pre-push wiring snippets so the *dispatch* reuses each agent's native loop, and keep the eight refute prompts as generated artifacts, not an orchestrator.
3. **Add a wiring self-check** (doctor/preflight) that fails CI when the push gate is absent — close the "silently disabled gate" hole at the only layer stallion controls.
4. **Bound every observation**: cap diff context in refute prompts, cap register size, deterministic slices.
5. **Harden the event append**: atomic writes + a parallel-transitions test, since 20-way subagent concurrency is now default behavior in the most popular agent.
6. **Distribute context via AGENTS.md** with a CLAUDE.md `@AGENTS.md` import note; keep harness docs themselves under the 200–500-line guidance every vendor converges on (https://code.claude.com/docs/en/memory, https://cursor.com/docs/context/rules).
7. **Do not add**: sandboxes, interactive approvals, model-judged gates, spec schemas, pagination.

---

## Sources

- Claude Code hooks reference — https://code.claude.com/docs/en/hooks
- Claude Code permissions — https://code.claude.com/docs/en/permissions
- Claude Code memory — https://code.claude.com/docs/en/memory
- Claude Code skills — https://code.claude.com/docs/en/skills
- Claude Code subagents — https://code.claude.com/docs/en/sub-agents
- OpenAI Codex repo — https://github.com/openai/codex
- Codex sandbox & approvals (redirect target of developers.openai.com/codex/sandbox) — https://learn.chatgpt.com/docs/agent-approvals-security
- Codex AGENTS.md guide — https://learn.chatgpt.com/docs/agent-configuration/agents-md
- SWE-agent paper, abstract — https://arxiv.org/abs/2405.15793 ; full text — https://arxiv.org/html/2405.15793v3
- Aider repo map — https://aider.chat/docs/repomap.html ; lint/test — https://aider.chat/docs/usage/lint-test.html ; conventions — https://aider.chat/docs/usage/conventions.html ; edit formats — https://aider.chat/docs/more/edit-formats.html ; git — https://aider.chat/docs/git.html
- OpenHands repo — https://github.com/All-Hands-AI/OpenHands ; runtime architecture — https://docs.openhands.dev/openhands/usage/architecture/runtime ; SDK architecture — https://docs.openhands.dev/sdk/arch/overview ; SDK paper — https://arxiv.org/abs/2511.03690
- GitHub Spec Kit — https://github.com/github/spec-kit
- Kiro Specs — https://kiro.dev/docs/specs
- OpenSpec — https://github.com/Fission-AI/OpenSpec
- AGENTS.md — https://agents.md/
- Goose repo — https://github.com/block/goose ; docs — https://goose-docs.ai/ ; adversary mode — https://goose-docs.ai/docs/guides/security/adversary-mode
- Cursor rules — https://cursor.com/docs/context/rules
- Gemini CLI — https://github.com/google-gemini/gemini-cli
- Devin docs — https://docs.devin.ai/
- METR Task Standard — https://github.com/METR/task-standard (task-dev guide site: http://taskdev.metr.org, body not extractable)
