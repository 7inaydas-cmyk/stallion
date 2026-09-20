#!/usr/bin/env node
/**
 * Task state — the TASK-LIFECYCLE as an executable state machine .
 *
 * The lifecycle's 13 phases are prose followed by reading; every rule in it was learned from a
 * dated escape, and prose rules escape: a written list drifts from what it counts, and readers
 * copy the list instead of checking the machine. The cure is making the declaration executable.
 * This tool is that cure for the lifecycle itself.
 *
 * Phase model (mapping to TASK-LIFECYCLE.md sections):
 *   intake      — steps 1-2  (restate, state verification)
 *   planned     — steps 3-6  (authority, skills, orientation, planning spec)
 *   executing   — steps 7-10 (smallest patch, targeted then full gates)
 *   verified    — step 11 gate evidence: RED-checks recorded, evidence ON DISK
 *   adversarial — adversarial pass recorded in the findings register
 *   done        — steps 12-13 (terminal; report + retrospective)
 *
 * Law encoded (each line refuses where prose used to merely ask):
 *   - planning-only and experiment tasks can NEVER reach executing.
 *   - protected and migration tasks need a recorded owner approval that cross-references a
 *     real line of docs/decisions/DECISIONS.md before executing.
 *   - executing -> verified requires recorded RED-check evidence paths, re-verified to EXIST at
 *     transition time (a pin is not a pin if the evidence file has since vanished).
 *   - adversarial -> done requires a findings register that aggregates clean (zero UNRESOLVED).
 *   - no phase skips, no backwards moves, nothing leaves done.
 *
 * Records are append-only event logs: phase is DERIVED from the last transition, never stored.
 * Honest trust boundary: the records are plain, unsigned JSON — the tool refuses illegal
 * transitions but cannot cryptographically stop a hand edit; the git history of the record file IS
 * the tamper evidence (editing events to skip obligations is a deliberate act against the register
 * and shows in the diff). Storage: tasks/<id>.json
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { aggregateFindings, chainError, chainStampEvents, loadFindings, missingResolveEvidence, mutateJson, STRICT_UTC_STAMP } from "./task-findings.mjs";
import { lessonsIndex, loadRegisters, summaryLine } from "./retrospective.mjs";
import { matches } from "./pathspec.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STATE_DIR = `${ROOT}tasks`;
const DECISIONS = `${ROOT}docs/decisions/DECISIONS.md`;

export const TASK_SCHEMA = "stallion/task-state@1";
/** The moment the command-pin law took effect. Records whose done transition predates this
 *  carry path-only evidence by design (documented in TASK-LIFECYCLE.md); the push fence
 *  exempts them from pin parity so a deliberate old-base audit stays executable. */
export const PIN_LAW_CUTOVER = "2026-09-18T20:00:00.000Z";
/** The moment the scope law took effect. Tasks CREATED after this must declare their code blast
 *  radius (scope globs) before their first code commit — the commit-msg gate refuses unscoped
 *  code and the push fence re-judges it. Records created earlier are grandfathered so already-
 *  settled history keeps judging under the law it was written under (same pattern as the pin law). */
export const SCOPE_LAW_CUTOVER = "2026-09-18T20:50:00.000Z";
/** The moment the chain law took effect (inspired by ECC's capsule envelope): records CREATED
 *  after this carry a hash chain — every event stamped with seq, parent_hash (the previous
 *  event's entry_hash, 64 zeros at genesis), and entry_hash (sha256 of the canonical JSON with
 *  the hash removed). Append-only becomes tamper-EVIDENT, not just tamper-visible in git diffs.
 *  task-state refuses to append to a broken chain; the fence refuses broken post-cutover
 *  records; the one record created inside the implementation window is blessed by the explicit,
 *  recorded `adopt-chain` command. Earlier records are grandfathered. */
export const CHAIN_CUTOVER = "2026-09-19T02:45:00.000Z";
/** The adoption window's end (the law's ship commit, fa4071c, 03:10Z): no record created after
 *  this may EVER be adopted. The bound is what keeps adopt-chain from laundering later
 *  forgeries — it exists for records born inside the implementation window, and only those. */
export const ADOPT_WINDOW_END = "2026-09-19T03:10:00.000Z";
/** Pins recorded from this instant MUST carry --expect assertion evidence (the lane-7 finding:
 *  an optional flag leaves the uncollectable-red escape open at the hasValidPin seam — a
 *  MODULE_NOT_FOUND exit verified a code task the day after the wave that promised to cure it).
 *  Pins recorded before the cutover are grandfathered; the law binds new events. */
export const PIN_EXPECT_CUTOVER = "2026-09-20T00:00:00.000Z";

function pinCarriesExpectLaw(p) {
  const at = typeof p.at === "string" ? p.at : "";
  return p.expect !== undefined || (at !== "" && Date.parse(at) < Date.parse(PIN_EXPECT_CUTOVER));
}

export const RISK_CLASSES = ["planning-only", "docs-only", "runtime-code", "protected", "migration", "experiment"];
export const PHASES = ["intake", "planned", "executing", "verified", "adversarial", "done"];
/** The taxonomy is defined HERE and imported by every other tool (issue #1): one law, no drift. */
export const IMPLEMENTATION_FORBIDDEN = new Set(["planning-only", "experiment"]);
export const APPROVAL_REQUIRED = new Set(["protected", "migration"]);

/** Phase is derived, never stored — and a forged/typo'd `to` is ignored rather than trusted.
 *  A `retired` event is TERMINAL (like done, but reached by event, not transition): a task that
 *  never executed retires with a recorded reason instead of misleading every future status read.
 *  Nothing after a retirement un-retires the record — the fence refuses that hand-forged shape. */
export function derivePhase(events) {
  let phase = "intake";
  for (const e of events) {
    if (e.type === "retired") return "retired";
    if (e.type === "transition" && PHASES.includes(e.to)) phase = e.to;
  }
  return phase;
}

/** The task's declared code blast radius: the ordered union of every scope event's patterns.
 *  Empty array = no scope declared — pre-cutover tasks by design; post-cutover that state
 *  refuses at the commit-msg gate and the push fence (task-coverage owns that law). */
export function scopeOf(record) {
  const patterns = [];
  for (const e of record.events ?? []) {
    if (e.type === "scope" && Array.isArray(e.patterns)) {
      for (const p of e.patterns) if (typeof p === "string" && !patterns.includes(p)) patterns.push(p);
    }
  }
  return patterns;
}

/** First timestamped event = the task's creation moment. The cutover comparison fact; empty for
 *  an undated (hand-forged) record, which then compares as pre-cutover — the plain-JSON trust
 *  boundary whose tamper trail is the record's git history. */
export function recordCreatedAt(record) {
  return (record.events ?? []).find((e) => typeof e.at === "string")?.at ?? "";
}

/** Pure: does this record owe a chain? The creation stamp is parsed with the same fail-closed
 *  strictness as every cutover law — an undated, malformed, or offset-spelled stamp MUST chain. */
export function recordMustChain(record) {
  const created = recordCreatedAt(record);
  if (!STRICT_UTC_STAMP.test(created)) return true;
  return Date.parse(created) >= Date.parse(CHAIN_CUTOVER);
}

/**
 * Pure: the scope glob dialect's admission rules. Repo-relative forward-slash globs (`*` and `?`
 * stay inside a segment, `**` as a whole segment crosses segments — task-coverage matches them);
 * this guards WRITES, and a hand-edited record that smuggles garbage patterns simply matches
 * nothing and refuses code — fail closed at the gates.
 */
export function globRefusal(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) return "a scope pattern must be a non-empty string";
  if (pattern.includes("\\")) return "backslash is not in this glob dialect — use forward slashes";
  if (pattern.startsWith("/")) return "scope patterns are repo-relative — no leading slash";
  if (pattern.endsWith("/")) return "a trailing slash names a directory — write the glob for files (e.g. 'tools/**')";
  const segments = pattern.split("/");
  for (const segment of segments) {
    if (segment.length === 0) return "empty path segment ('//' inside the pattern)";
    if (segment === "." || segment === "..") return `'${segment}' segment — scope stays inside the repo, relative to its root`;
  }
  if (pattern === "**") return "a scope of everything is no scope — name at least one top-level tree (e.g. 'tools/**')";
  if (segments[0] === "**" || segments[0] === "*") {
    return "the first segment must name a top-level tree ('**/' or '*/' could start anywhere and covers everything — e.g. 'tools/**')";
  }
  return null;
}

const FENCE_SURFACE_ROOTS = new Set([".githooks", ".github", "docs/gates"]);
/**
 * Does a scope PATTERN cover fence surface? Three laws in order of trust, each pure where it
 * can be — the disk-dependent half is LAST and fail-closed, because the gated party controls
 * cwd and working-tree state (an adversarial pass drove the walker-only version straight
 * through: invoked from /tmp, after rm-ing the target file, by naming a future file, and by
 * chmod-ing the directory):
 *   1. single-segment fast path (.githooks, .github) — set lookup, no disk;
 *   2. STRUCTURAL root-prefix — the pattern's leading segments coincide with a multi-segment
 *      root (docs/gates/anything.json, docs/gates/newdir/**), so it can only match paths UNDER
 *      the root; refuses whether or not any such file exists today (the future-file and
 *      rm'd-file doors);
 *   3. the real corpus, ROOT-anchored — strictly ADDITIVE coverage for exotic wildcards past the
 *      pure laws; an unreadable root reads as not-reaching here because laws 1-2 plus node-match
 *      already decided every shape that matters (including every docs/gates spelling).
 */
function coversFenceSurface(p) {
  const pattern = String(p);
  const segments = pattern.split("/");
  if (FENCE_SURFACE_ROOTS.has(segments[0])) return true;
  if (surfaceFileReached(".stallion-base", segments)) return true;
  return [...FENCE_SURFACE_ROOTS].some((root) => rootReachesPattern(root, pattern));
}

/** Pure: does a pattern reach a fence-surface FILE at the repo root (.stallion-base)? The first
 *  segment must glob-match the file's name, and the pattern must be shallow enough to cover a
 *  root-level FILE: the exact name, or name/** where the coverage dialect's trailing ** swallows
 *  zero segments (a wildcard-spelled stallion-base with a double-star tail escaped the tier
 *  law while the coverage seam authorized it — an adversarial pass brute-forced the shape). */
function surfaceFileReached(name, segments) {
  if (!matches(name, segments[0] ?? "")) return false;
  // The tail may stack double-star segments: the coverage dialect's ** swallows zero segments
  // RECURSIVELY, so name/**, name/**/**, and deeper all cover a root-level file (an adversarial
  // pass brute-forced the stacked-tail reopen of the single-tail fix).
  return segments.length === 1 || segments.slice(1).every((seg) => seg === "**");
}

/** Pure per-root reach, in order of trust: the STRUCTURAL root-prefix (a multi-segment root's
 *  segments coincide with the pattern's leading segments — refuses whether or not the named
 *  file exists, closing the future-file and rm'd-file doors), the WILDCARD first segment (a
 *  single-segment root spelled with wildcards — ".*hooks/**" shapes an adversarial pass proved
 *  escaped every other law), the node-match (broad patterns covering the root directory
 *  itself), then the ROOT-anchored corpus walker for exotic shapes. */
function rootReachesPattern(root, pattern) {
  const rootSegments = root.split("/");
  const segments = String(pattern).split("/");
  if (rootSegments.length > 1 && rootSegments.every((seg, i) => matches(seg, segments[i] ?? ""))) return true;
  if (rootSegments.length === 1 && matches(root, segments[0])) return true;
  if (matches(root, String(pattern))) return true;
  return rootTouchesPattern(join(ROOT, root), pattern);
}

function rootTouchesPattern(rootDir, pattern) {
  try {
    if (!existsSync(rootDir)) return false;
    // Walk paths REPO-relative (the walk seeds at the ROOT PREFIX, not the empty string):
    // pathspec's dialect is repo-relative, and a walk seeded root-relatively matched bare
    // entry NAMES against repo globs — "*.md" and "workflows/**" falsely refused as fence
    // surface while no genuine reach ever needed them (an adversarial pass caught the
    // over-arm; the pre-fix absolute walk could not fire at all).
    const prefix = relative(ROOT, rootDir);
    const walk = (dir, rel) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        const relPath = `${rel}/${entry.name}`;
        if (matches(relPath, pattern)) return true;
        if (entry.isDirectory() && walk(full, relPath)) return true;
      }
      return false;
    };
    return walk(rootDir, prefix);
  } catch {
    // NOT reaching. The pure laws above (fast path, structural root-prefix, node-match) already
    // decide every shape that matters — including all multi-segment-root spellings, which is
    // where fail-closed was owed and now lives. This walker is strictly ADDITIVE for exotic
    // wildcard shapes; an unreadable directory must not over-arm unrelated patterns (a blanket
    // "reaching" here refused tools/** whenever .githooks happened to be unreadable).
    return false;
  }
}

/**
 * Pure: patterns reaching the fence's own surface (.githooks/**, .github/**, docs/gates/**,
 * .stallion-base) are protected-tier blast radius — only a protected or migration task WITH a
 * recorded approval may declare them. The gated party must not be able to scope over the fence
 * with a runtime-code self-serve amendment (the law isCodePath already states for the push fence).
 */
export function fenceSurfaceRefusal(record, patterns) {
  const reaching = (patterns ?? []).filter((p) => p === ".stallion-base" || coversFenceSurface(p));
  if (reaching.length === 0) return null;
  if (!APPROVAL_REQUIRED.has(record.riskClass)) {
    return {
      reason: `scope pattern(s) reach the fence's own surface (${reaching.join(", ")}) — rewriting the fence is protected-tier blast radius, not a runtime-code self-serve`,
      remedy: `open the fence change as its own task: node tools/task-state.mjs new <id> --risk-class protected   then approve --decision "<full DECISIONS.md heading>"`,
    };
  }
  if (!hasApproval(record)) {
    return {
      reason: `scope reaches the fence surface but this ${record.riskClass} task carries no approval event`,
      remedy: `node tools/task-state.mjs approve ${record.id} --decision "<full DECISIONS.md heading>"`,
    };
  }
  return null;
}

function hasApproval(record) {
  return record.events.some((e) => e.type === "approval");
}

/** Pure: the write-seam half of the retirement law — NO command may append to a retired record.
 *  Without this guard the tool itself writes the post-retirement-event shape its own fence then
 *  refuses as a hand-forgery (an adversarial finding, live-proven on four commands), poisoning
 *  the tamper narrative for a record the machine lawfully wrote. null = append is lawful. */
export function retiredAppendRefusal(record) {
  if (derivePhase(record.events ?? []) !== "retired") return null;
  return `task '${record.id}' is retired — terminal at the write seam too; no command appends to it (the fence would call this very append a hand-forgery)`;
}

/** Pure: the retirement law. A task that never executed (intake or planned) may retire with a
 *  recorded reason — the honest alternative to a planned record that misleads every future
 *  status read. A task that has begun landing code must finish its lifecycle honestly (its
 *  commits cite it; retirement would orphan them), done is terminal, and retirement is
 *  once-only. null = the retirement is lawful. */
export function retirementRefusal(record, because) {
  if (typeof because !== "string" || because.trim().length === 0) {
    return "retire requires --because — retiring a task without a reason is deleting evidence";
  }
  const phase = derivePhase(record.events ?? []);
  if (phase === "retired") return `task '${record.id}' is already retired — retirement is once-only`;
  if (phase === "done") return "done is terminal — a finished task retires nothing; reopen the concern as a new task";
  if (PHASES.indexOf(phase) > PHASES.indexOf("planned")) {
    return `task '${record.id}' is '${phase}' — a task that has begun landing code must finish its lifecycle honestly; retirement is for tasks that never executed`;
  }
  return null;
}

function redCheckEvidence(record) {
  const retired = new Set(record.events.filter((e) => e.type === "pin-retire").map((e) => e.command));
  const paths = [];
  for (const e of record.events) if (e.type === "red-check" && !retired.has(e.command)) paths.push(...(e.evidence ?? []));
  return paths;
}

/** Command pins: red-check events that RAN a command and recorded a nonzero integer exit —
 *  the only machine-verified form. A recorded pin without a nonzero integer exitCode is not a
 *  pin (hand-forged or killed events refuse, they do not pass). A pin retired with a recorded
 *  justification no longer counts and no longer re-runs at done. */
export function hasValidPin(record) {
  const retired = new Set(record.events.filter((e) => e.type === "pin-retire").map((e) => e.command));
  return record.events.some((e) => e.type === "red-check" && typeof e.command === "string" && e.command.length > 0 && !retired.has(e.command) && Number.isInteger(e.exitCode) && e.exitCode !== 0 && pinCarriesExpectLaw(e));
}

function commandPins(record) {
  const retired = new Set(record.events.filter((e) => e.type === "pin-retire").map((e) => e.command));
  return record.events.filter((e) => e.type === "red-check" && typeof e.command === "string" && e.command.length > 0 && !retired.has(e.command) && Number.isInteger(e.exitCode) && e.exitCode !== 0 && pinCarriesExpectLaw(e));
}

export function hasPinExemption(record) {
  return record.events.some((e) => e.type === "pin-exemption" && typeof e.justification === "string" && e.justification.trim().length > 0);
}

function evidencePathIsFile(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  const resolved = existsSync(p) ? p : `${ROOT}${p.replace(/^\//, "")}`;
  return existsSync(resolved) && statSync(resolved).isFile();
}
/** One evidence law for every consumer (RED-checks at advance, resolutions at verdict and done):
 *  a path that exists AND is a file, cwd-relative then repo-relative. Exported so the other
 *  tools cannot grow a weaker copy of it. */
export { evidencePathIsFile };

function executionGuard(record) {
  if (IMPLEMENTATION_FORBIDDEN.has(record.riskClass)) {
    return {
      reason: `risk class '${record.riskClass}' is implementation-forbidden by TASK-LIFECYCLE — a separate, explicitly authorized task must be opened`,
      remedy: `node tools/task-state.mjs new <new-id> --risk-class runtime-code  (class '${record.riskClass}' can never reach executing)`,
    };
  }
  if (APPROVAL_REQUIRED.has(record.riskClass) && !hasApproval(record)) {
    return {
      reason: `risk class '${record.riskClass}' requires a recorded owner approval (approve --decision <ref>) before executing`,
      remedy: `node tools/task-state.mjs approve ${record.id} --decision "<heading text WITHOUT the '## ' prefix>" — candidates: grep "^## " docs/decisions/DECISIONS.md | sed 's/^## //'`,
    };
  }
  return null;
}

const NON_CODE_CLASSES = new Set(["planning-only", "docs-only", "experiment"]);

function verificationGuard(record, _findings, evidenceOnDisk, _facts = {}) {
  const { batteryGreen = true } = _facts;
  if (!batteryGreen) {
    return { reason: "the selftest battery is not green — verification runs the whole battery at the phase boundary (ECC's stop-time batching: checks once at the boundary, not per edit)", remedy: "npm run selftest   — fix every failing tool, then advance" };
  }
  const evidence = redCheckEvidence(record);
  const pins = commandPins(record);
  const needsPin = !NON_CODE_CLASSES.has(record.riskClass);
  if (evidence.length === 0 && pins.length === 0) {
    return {
      reason: "no RED-check recorded — a pin is not a pin until it has been run RED against pre-fix source",
      remedy: `node tools/task-state.mjs red-check ${record.id} --command "<the failing check>"`,
    };
  }
  if (needsPin && pins.length === 0 && !hasPinExemption(record)) {
    return {
      reason: "code tasks need at least one COMMAND pin (red-check --command) — a path only proves a file exists, not that a check ran RED",
      remedy: `node tools/task-state.mjs red-check ${record.id} --command "<the failing check>"   (or record an exemption: node tools/task-state.mjs pin-exempt ${record.id} --justification "<why>")`,
    };
  }
  if (evidence.length > 0 && !evidenceOnDisk) {
    return {
      reason: "recorded RED-check evidence no longer exists on disk — evidence must be present at verification time, not just remembered",
      remedy: `re-run the pin against the broken code, then re-record: node tools/task-state.mjs red-check ${record.id} --evidence <path>`,
    };
  }
  return null;
}

function doneGuard(record, findings, _evidenceOnDisk, facts = {}) {
  const { resolveEvidenceMissing = [], greenFailures = [] } = facts;
  if (!findings) {
    return {
      reason: "no adversarial findings register — the adversarial pass must be recorded before done (adversarial-runner record/verdict)",
      remedy: `node tools/adversarial-runner.mjs prepare ${record.id} — dispatch the bundles, record findings, then verdict`,
    };
  }
  if (!findings.passStartedAt) {
    return {
      reason: "findings register carries no pass marker — only a prepared pass (a real diff swept) counts; an empty register is not a completed pass",
      remedy: `node tools/adversarial-runner.mjs prepare ${record.id}`,
    };
  }
  const agg = aggregateFindings(findings);
  if (!agg.clean) {
    return {
      reason: `${agg.unresolved} UNRESOLVED adversarial finding(s) — resolve or wont-fix each before done`,
      remedy: `node tools/adversarial-runner.mjs resolve ${record.id} <finding-id> --evidence <paths>   (or: node tools/adversarial-runner.mjs wont-fix ${record.id} <finding-id> --justification "<why>")`,
    };
  }
  // The done GATE re-verifies resolve evidence — the caller computes the fs fact (as it does for
  // RED-checks) so this judge stays pure; a check that lives only in the advisory verdict
  // command enforces nothing (an adversarial finding).
  if (resolveEvidenceMissing.length > 0) {
    return {
      reason: `RESOLVED finding(s) cite evidence that no longer exists: ${resolveEvidenceMissing.join(", ")}`,
      remedy: `re-resolve with evidence that exists: node tools/adversarial-runner.mjs resolve ${record.id} <finding-id> --evidence <file-paths-that-exist>`,
    };
  }
  // The GREEN half of the arc: every command pin must PASS by done. The caller re-runs them and
  // passes the failures here, so this judge stays pure (issue #9).
  if (greenFailures.length > 0) {
    return {
      reason: `command pin(s) no longer pass at done: ${greenFailures.join("; ")}`,
      remedy: `the fix must make every pin GREEN before done — repair the code, or retire a genuinely wrong pin: node tools/task-state.mjs pin-retire ${record.id} --command "<the exact pin command>" --justification "<why the pin is wrong>"`,
    };
  }
  return null;
}

const TRANSITION_GUARDS = {
  "planned->executing": executionGuard,
  "executing->verified": verificationGuard,
  "adversarial->done": doneGuard,
};

/** The terminal phases' refusal, shared shape for done and retired (both never advance). */
function terminalAdvanceRefusal(record, current) {
  if (current === "done") return { reason: "done is terminal — a finished task is reopened as a NEW task, not by rewinding this one", remedy: `node tools/task-state.mjs new <new-id> --risk-class ${record.riskClass}` };
  if (current === "retired") return { reason: "retired is terminal — a retired task never advances; its successor carries the work", remedy: `node tools/task-state.mjs new <new-id> --risk-class ${record.riskClass}   (the retirement's --because names the successor)` };
  return null;
}

/**
 * Pure transition judge. `findings` is the loaded findings register (null = none recorded) and
 * `evidenceOnDisk` is whether every recorded RED-check evidence path still exists — the fs fact the
 * caller re-verifies, so this stays testable with synthetic records.
 * Returns { ok: true } or { ok: false, reason } — the reason is the law being invoked.
 */
export function evaluateTransition(record, findings, target, evidenceOnDisk, facts = {}) {
  const { resolveEvidenceMissing = [], greenFailures = [], batteryGreen = true } = facts;
  if (!record || record.schema !== TASK_SCHEMA) return { ok: false, reason: "not a task-state record", remedy: "start a real one: node tools/task-state.mjs new <id> --risk-class <class>" };
  if (!PHASES.includes(target)) return { ok: false, reason: `unknown phase: ${target}`, remedy: `phases are exactly: ${PHASES.join(", ")}` };
  const current = derivePhase(record.events);
  const terminal = terminalAdvanceRefusal(record, current);
  if (terminal) return { ok: false, ...terminal };
  if (PHASES.indexOf(target) !== PHASES.indexOf(current) + 1) {
    const next = PHASES[PHASES.indexOf(current) + 1];
    return { ok: false, reason: `illegal jump ${current} -> ${target}: phases advance one at a time, in order`, remedy: `node tools/task-state.mjs advance ${record.id} ${next}` };
  }
  const guard = TRANSITION_GUARDS[`${current}->${target}`];
  if (guard) {
    const refusal = guard(record, findings, evidenceOnDisk, { resolveEvidenceMissing, greenFailures, batteryGreen });
    if (refusal) return { ok: false, reason: refusal.reason, remedy: refusal.remedy };
  }
  return { ok: true };
}

/** What blocks the next transition, computed from the SAME facts `advance` will check. The
 *  exceptions are the runs advance performs and a status read must not: `advance done` re-runs
 *  command pins, `advance verified` runs the selftest battery — status reports that each WILL
 *  happen instead (a sweep caught the silent fail-open before the note existed). */
/** The terminal phases' status line — both close the record to further obligations. A retired
 *  task's reason is SURFACED here (an adversarial finding: a law whose namesake field nothing
 *  ever printed), flattened — client text cannot forge the machine's voice. */
function terminalObligations(record, current) {
  if (current === "done") return ["done — reopen as a new task if more work is needed"];
  if (current === "retired") {
    const because = (record.events ?? []).find((e) => e.type === "retired")?.because ?? "";
    return [`retired — never executed, authorizes nothing; reason: ${flat(because)}`];
  }
  return null;
}

export function obligations(record, findings, evidenceOnDisk) {
  const current = derivePhase(record.events);
  const terminal = terminalObligations(record, current);
  if (terminal) return terminal;
  const target = PHASES[PHASES.indexOf(current) + 1];
  const verdict = evaluateTransition(record, findings, target, evidenceOnDisk);
  if (verdict.ok && target === "done") {
    return [`advance to ${target} is unblocked`, `done will re-run ${commandPins(record).length} command pin(s) — each must pass`];
  }
  if (verdict.ok && target === "verified" && derivePhase(record.events) === "executing") {
    return [`advance to ${target} is unblocked`, `verified will run the WHOLE selftest battery — every tool must be green`];
  }
  return verdict.ok ? [`advance to ${target} is unblocked`] : [verdict.reason, `fix: ${verdict.remedy}`];
}

/**
 * Pure: the evidence-graded handoff (ECC's save-session shape, machine-generated from the
 * record and register): WORKED with evidence (green pins, resolved findings), FAILED with the
 * exact reason (wont-fix justifications, retired pins — "'threw X because Y' is useful;
 * 'didn't work' is not"), NOT TRIED (unresolved findings, unmet obligations). No free text
 * enters it that the tools did not already require somewhere.
 */
/** Client text is FLATTENED (newlines become ⏎) — a justification or claim cannot forge
 *  section headings in the machine's voice (a sweep caught exactly that injection). */
function flat(text) {
  return String(text ?? "").replace(/[\r\n]+/g, " ⏎ ");
}

export function handoffReport(record, findings, evidenceOnDisk = true, resolveEvidenceMissing = []) {
  const phase = derivePhase(record.events);
  const pins = commandPins(record);
  const retired = record.events.filter((e) => e.type === "pin-retire");
  const resolved = (findings?.findings ?? []).filter((f) => f.status === "RESOLVED");
  const wont = (findings?.findings ?? []).filter((f) => f.status === "WONT-FIX");
  const unresolved = (findings?.findings ?? []).filter((f) => f.status === "UNRESOLVED");
  const obligationsLeft = obligations(record, findings, evidenceOnDisk).filter((o) => !o.startsWith("advance to"));
  const missing = new Set(resolveEvidenceMissing.map((m) => m.split(":")[0]));
  const lines = [
    `# Handoff — ${record.id} (${phase}, ${record.riskClass})`,
    "",
    "## WORKED (with evidence)",
    ...(pins.length > 0
      ? pins.map((p) => phase === "done"
        ? `- pin GREEN at done: ${flat(p.command)} (re-run passed the done gate)`
        : `- pin recorded RED (exit ${p.exitCode}, digest ${p.outputDigest}): ${flat(p.command)} — re-runs and must be GREEN at done`)
      : ["- (no command pins recorded)"]),
    ...resolved.filter((f) => !missing.has(f.id)).map((f) => `- finding ${f.id} RESOLVED — ${(f.evidence ?? []).map(flat).join(", ")}`),
    "",
    "## FAILED (exact reasons)",
    ...record.events.filter((e) => e.type === "retired").map((e) => `- task retired: ${flat(e.because)}`),
    ...retired.map((e) => `- pin retired (${flat(e.command)}): ${flat(e.justification)}`),
    ...wont.map((f) => `- finding ${f.id} WONT-FIX: ${flat(f.justification)}`),
    "",
    "## NOT TRIED",
    ...unresolved.map((f) => `- finding ${f.id} (${f.severity}): ${flat(f.claim)}`),
    ...[...missing].map((id) => `- finding ${id} RESOLVED but its evidence no longer exists — re-resolve with live paths`),
    ...obligationsLeft.map((o) => `- obligation: ${flat(o)}`),
    ...(phase !== "done" && phase !== "retired" ? ["- (the task is not done: the done gate re-runs every pin and re-verifies resolve evidence)"] : []),
  ];
  return lines.join("\n");
}

class Refused extends Error {}

/** Refusals throw instead of exiting so a locked section's finally releases the lockfile —
 *  process.exit skips finally and would orphan the lock for the 60s stale-breaker. */
function die(message) {
  throw new Refused(message);
}

function taskPath(id) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) die(`task id must be kebab-case (a-z, 0-9, -): ${id}`);
  return `${STATE_DIR}/${id}.json`;
}

function parseTaskRecord(text, id, path) {
  if (text === null) die(`no such task: ${id} (expected ${path})\n  fix: node tools/task-state.mjs status   — lists every recorded task`);
  let record;
  try {
    record = JSON.parse(text);
  } catch (e) {
    die(`task record is not valid JSON: ${e.message}\n  evidence: ${path} — the git history of this file is the tamper trail`);
  }
  if (record.schema !== TASK_SCHEMA) die(`task record has unknown schema: ${String(record.schema)}`);
  return record;
}

function loadTask(id) {
  const path = taskPath(id);
  return parseTaskRecord(existsSync(path) ? readFileSync(path, "utf8") : null, id, path);
}

/**
 * The only way a record changes: parse, judge, and append all INSIDE the file lock. A load
 * outside the lock is the lost-update bug — two writers append to the same snapshot and the
 * second write silently erases the first's event.
 */
function mutateTask(id, mutate) {
  const path = taskPath(id);
  return mutateJson(path, (text) => {
    const current = parseTaskRecord(text, id, path);
    if (recordMustChain(current)) {
      const err = chainError(current.events);
      if (err) {
        die(`record ${id}'s chain is broken or unadopted — refusing to append (${err})
  rule: a post-cutover record is tamper-EVIDENT; appending to an unverifiable record launders it
  fix: if this record was created inside the chain law's implementation window, bless it once: node tools/task-state.mjs adopt-chain ${id}   — otherwise the git history of the record is the tamper trail; investigate before writing`);
      }
    }
    const next = mutate(current);
    if (recordMustChain(current) && next) return { ...next, events: chainStampEvents(next.events) };
    return next;
  });
}

function cmdNew(args) {
  const id = args._[0];
  if (!id) die("usage: new <id> --risk-class <class> [--title <t>]");
  const riskClass = args["risk-class"];
  if (!riskClass || riskClass === true) die("new requires --risk-class <class>");
  if (!RISK_CLASSES.includes(riskClass)) die(`unknown risk class: ${riskClass} (one of ${RISK_CLASSES.join(", ")})`);
  mkdirSync(STATE_DIR, { recursive: true });
  mutateJson(taskPath(id), (text) => {
    if (text !== null) die(`task already exists: ${id}\n  fix: node tools/task-state.mjs status ${id}   — see where it stands before duplicating it`);
    return { schema: TASK_SCHEMA, id, title: args.title ?? null, riskClass, events: chainStampEvents([{ at: new Date().toISOString(), type: "created", riskClass }]) };
  });
  console.log(`task ${id}: intake (risk class ${riskClass}) — tasks/${id}.json`);
}

function cmdApprove(args) {
  const id = args._[0];
  if (!id) die("usage: approve <id> --decision <ref>");
  const ref = args.decision;
  if (!ref || ref === true) die("approve requires --decision <ref> — the dated entry in docs/decisions/DECISIONS.md");
  if (!existsSync(DECISIONS)) die("docs/decisions/DECISIONS.md is missing — cannot cross-reference an approval");
  const heading = readFileSync(DECISIONS, "utf8").split("\n").find((l) => l.startsWith("## ") && l.slice(3).trim() === ref.trim());
  if (!heading) {
    die(`no decisions-register entry heading equals: ${ref}\n  rule: an approval cites a FULL entry heading from docs/decisions/DECISIONS.md verbatim, MINUS its '## ' prefix — a substring is not an act\n  fix: grep "^## " docs/decisions/DECISIONS.md | sed 's/^## //'   then: node tools/task-state.mjs approve ${id} --decision "<one full line of that output>"`);
  }
  mutateTask(id, (record) => {
    const retired = retiredAppendRefusal(record);
    if (retired) die(`REFUSED — ${retired}`);
    return { ...record, events: [...record.events, { at: new Date().toISOString(), type: "approval", decision: ref }] };
  });
  console.log(`task ${id}: owner approval recorded (decision: ${ref})`);
}

/**
 * Declare or widen a task's scope — the append-only blast-radius amendment. The initial
 * declaration belongs at `planned` (the plan is what names the blast radius); amendments stay
 * legal while the task is in flight because plans learn, and every amendment is a recorded
 * event an adversarial pass and a reviewer can see. Done closes the scope for good.
 */
function cmdScope(args) {
  const id = args._[0];
  if (!id) die("usage: scope <id> --add <glob>[,<glob>...]");
  const adds = typeof args.add === "string" ? args.add.split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (adds.length === 0) die(`scope requires --add <glob>[,<glob>...] — the code blast radius this task may touch (e.g. 'tools/**,docs/*')`);
  for (const p of adds) {
    const refusal = globRefusal(p);
    if (refusal) die(`scope pattern refused: ${JSON.stringify(p)}\n  rule: ${refusal}\n  fix: node tools/task-state.mjs scope ${id} --add "<corrected glob>[,<glob>...]"`);
  }
  mutateTask(id, (record) => {
    const phase = derivePhase(record.events);
    if (phase === "done") die("done is terminal — a finished task's scope is closed; new blast radius opens a new task");
    if (phase === "retired") die("retired is terminal — a retired task's scope is closed forever; it never executes, so it never widens");
    if (PHASES.indexOf(phase) < PHASES.indexOf("planned")) {
      die(`task is '${phase}' — scope is declared once there is a plan to name a blast radius\n  fix: node tools/task-state.mjs advance ${id} planned   then re-run the scope amendment`);
    }
    const tier = fenceSurfaceRefusal(record, adds);
    if (tier) die(`REFUSED — ${tier.reason}\n  fix: ${tier.remedy}`);
    const already = new Set(scopeOf(record));
    const novel = adds.filter((p) => !already.has(p));
    if (novel.length === 0) die(`every pattern is already inside ${id}'s declared scope — amendments record NEW blast radius, not repetition`);
    return { ...record, events: [...record.events, { at: new Date().toISOString(), type: "scope", patterns: novel }] };
  });
  const written = loadTask(id);
  console.log(`task ${id}: scope amended (append-only) — ${scopeOf(written).length} pattern(s) declared in total: ${scopeOf(written).join(", ")}`);
}

/** Pure: is this record adoptable? The window is BOUNDED — created in [CHAIN_CUTOVER,
 *  ADOPT_WINDOW_END] — so a later hand-forgery can never be blessed; done is terminal; a
 *  record that already carries a chain is once-only. Everything judges the locked snapshot. */
export function adoptionRefusal(record) {
  const created = recordCreatedAt(record);
  const strict = STRICT_UTC_STAMP.test(created);
  if (!strict || Date.parse(created) < Date.parse(CHAIN_CUTOVER)) {
    return `record predates the chain cutover (${CHAIN_CUTOVER}) — grandfathered, nothing to adopt`;
  }
  if (Date.parse(created) > Date.parse(ADOPT_WINDOW_END)) {
    return `record was created after the adoption window closed (${ADOPT_WINDOW_END}) — the chain law has shipped, so an unchained record born now is a hand-forgery, not a window artifact; adoption refuses`;
  }
  if (derivePhase(record.events) === "done") return "done is terminal — a finished record is not rewritten, even to be blessed";
  if (derivePhase(record.events) === "retired") return "retired is terminal — a retired record is never rewritten, not even to be blessed";
  if (record.events.some((e) => typeof e.entry_hash === "string")) return "record already carries a chain — adoption is a once-only act";
  return null;
}

/**
 * Bless the one record created inside the chain law's implementation window (created
 * post-cutover, before the stamping code existed). Stamps every existing event and appends a
 * recorded `chain-adopt` marker — the adoption is itself a chained event, visible forever. The
 * read, the judgment, and the write all happen INSIDE the lock (a load outside the lock is the
 * lost-update bug this file's own header refuses).
 */
function cmdAdoptChain(args) {
  const id = args._[0];
  if (!id) die("usage: adopt-chain <id>");
  const path = taskPath(id);
  const written = mutateJson(path, (text) => {
    const record = parseTaskRecord(text, id, path);
    const refusal = adoptionRefusal(record);
    if (refusal) die(`REFUSED — ${refusal}`);
    return { ...record, events: chainStampEvents([...record.events, { at: new Date().toISOString(), type: "chain-adopt" }]) };
  });
  const check = chainError(written.events);
  if (check) die(`adoption produced an invalid chain (${check}) — investigate`);
  console.log(`task ${id}: chain adopted — ${written.events.length} events stamped, adoption recorded`);
}

const PIN_COMMAND_TIMEOUT_MS = 300_000;
const PIN_MAX_BUFFER = 10 * 1024 * 1024;

/** Run a pin command and return { exitCode, output } — the machine-verified RED capture.
 *  exitCode is null when the command could not deliver a verdict (spawn failure, timeout,
 *  signal, buffer overflow): a null verdict is NEVER a RED pin (an adversarial finding: real
 *  Node reports status null, not undefined, on all those paths). */
export function runPinCommand(command) {
  // spawnSync, not execFileSync: the exit-0 path must see stderr too. execFileSync returns stdout
  // only on success, so a check that exits 0 while printing its RED signature on stderr was
  // invisible to the vacuous-green guard — and this repo's tools print SELF-TEST FAIL via
  // console.error (the lane-4 finding, demonstrated live). Both channels, both outcomes.
  const run = spawnSync("sh", ["-c", command], { cwd: ROOT, encoding: "utf8", timeout: PIN_COMMAND_TIMEOUT_MS, maxBuffer: PIN_MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] });
  if (!Number.isInteger(run.status)) {
    die(`pin command delivered no verdict: ${command} (${run.error?.code ?? run.signal ?? "no status"})\n  rule: a pin that did not run to completion is not evidence of anything\n  fix: make the command complete (it hangs, explodes past ${PIN_MAX_BUFFER / 1024 / 1024}MB of output, or cannot start)`);
  }
  return { exitCode: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

/** Guarded regex test: a malformed recorded pattern never decides a GREEN (it refused the RED side already). */
function patternMatches(pattern, output) {
  try {
    return new RegExp(pattern).test(output);
  } catch {
    return false;
  }
}

/**
 * Pure: the GREEN half of a pin's arc at done (the 2026-09-20 evaluation, gap 6). Exit code alone
 * used to clear the gate, so an intermittently-green or vacuously-green check passed. Now the
 * re-run must pass TWICE, and when the pin carries a recorded --expect signature, a passing run
 * that STILL shows it is a vacuous green — the failure signature the RED half matched cannot
 * still be on screen while the check claims success.
 */
export function greenVerdictOf(pin, runs) {
  const steady = steadyRunFailure(pin.command, runs[0], runs[1]);
  if (steady !== null) return steady;
  for (const run of runs) {
    const vacuous = vacuousGreenOf(pin, run);
    if (vacuous !== null) return vacuous;
  }
  return null;
}

/** Exit-code law: the re-run must pass TWICE — the second run surfaces intermittent greens. */
function steadyRunFailure(command, first, second) {
  if (first === undefined || first.exitCode !== 0) return `"${command}" exit ${first?.exitCode ?? "no verdict"}`;
  if (second === undefined || second.exitCode !== 0) {
    return `"${command}" passed once then exit ${second?.exitCode ?? "no verdict"} — an intermittent green is not a GREEN`;
  }
  return null;
}

/** Signature law: a passing run that still shows the pin's recorded RED signature is vacuous. */
function vacuousGreenOf(pin, run) {
  if (typeof pin.expect === "string" && pin.expect.length > 0 && patternMatches(pin.expect, run.output ?? "")) {
    return `"${pin.command}" exits 0 but still shows its recorded RED signature (${pin.expect}) — a vacuous green is not a GREEN`;
  }
  return null;
}

function outputDigest(output) {
  return createHash("sha256").update(output).digest("hex").slice(0, 12);
}

/**
 * Pure: does a RED run's output carry the assertion evidence the author expected? `--expect`
 * binds a pattern to a pin at RECORD time — the pattern should name a line the check prints only
 * when tests RAN and FAILED (a runner's failure line, a self-test's FAIL print, a structural
 * assertion's own refusal). An uncollectable run — a suite that fails to resolve its imports, a
 * tool that dies on an unknown flag, a command that crashes before asserting — exits nonzero
 * while proving nothing, and red-pins nothing (an adversarial lane caught exactly this shape on
 * 2026-09-19: a brand-new module's contract suite "failed" pre-fix at transform, zero tests
 * collected, and the vacuous RED sailed through as evidence). null = satisfied; otherwise the
 * refusal reason.
 */
export function expectationRefusal(pattern, output) {
  let re;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    return `--expect is not a valid regular expression: ${pattern}`;
  }
  if (!re.test(output)) {
    return `the command failed but its output does not carry the expected evidence: ${pattern}`;
  }
  return null;
}

function cmdRedCheck(args) {
  const [id, ...paths] = args._;
  if (!id) die(`usage: red-check <id> --command "<failing check>" [--expect "<output pattern>"] [--evidence <path>[,<paths>...]]`);
  const command = typeof args.command === "string" && args.command.trim().length > 0 ? args.command.trim() : null;
  const expect = typeof args.expect === "string" && args.expect.trim().length > 0 ? args.expect.trim() : null;
  if (expect !== null && command === null) die("--expect binds to a command pin — pass it together with --command");
  const all = [...paths, ...(typeof args.evidence === "string" ? args.evidence.split(",") : [])].map((p) => p.trim()).filter(Boolean);
  if (!command && all.length === 0) die(`red-check requires --command "<the failing check>" (and optionally --expect "<output pattern>" / --evidence <paths>)`);
  for (const p of all) if (!evidencePathIsFile(p)) die(`evidence path is not a readable file: ${p}\n  fix: pass paths that exist, repo-relative or cwd-relative: node tools/task-state.mjs red-check ${id} --evidence <path>`);
  const event = { at: new Date().toISOString(), type: "red-check" };
  if (command) {
    const run = runPinCommand(command);
    if (run.exitCode === 0) {
      die(`REFUSED — the pin passed (exit 0): ${command}\n  rule: a pin is evidence only when it FAILS against pre-fix source\n  fix: run the red-check before the fix lands, or point the command at the pre-fix behavior`);
    }
    if (expect !== null) {
      const refusal = expectationRefusal(expect, run.output);
      if (refusal !== null) {
        die(`REFUSED — ${refusal}\n  rule: an uncollectable run red-pins nothing — a suite that fails to load, a tool that refuses on a flag, and a crash before the first assertion ALL exit nonzero while proving nothing\n  fix: point --expect at a line your check prints only when it ran and failed for the asserted reason (a runner's failure line, a SELF-TEST FAIL print), or restructure the pin as a structural assertion on the defect itself`);
      }
      event.expect = expect;
    }
    if (expect === null && Date.now() >= Date.parse(PIN_EXPECT_CUTOVER)) {
      die(`REFUSED — a command pin without --expect no longer records (pin-expect cutover ${PIN_EXPECT_CUTOVER})\n  rule: an uncollectable run red-pins nothing — the pattern is the proof the failure is an assertion failure, and the author names it for their own runner\n  fix: red-check ${id} --command "<cmd>" --expect "<a line the check prints only when it ran and failed>" (structural pins use their own refusal text)`);
    }
    event.command = command;
    event.exitCode = run.exitCode;
    event.outputDigest = outputDigest(run.output);
  }
  if (all.length > 0) event.evidence = all;
  mutateTask(id, (record) => {
    const retired = retiredAppendRefusal(record);
    if (retired) die(`REFUSED — ${retired}\n  fix: the pin was run, but a retired record accepts no events; record it under the successor task`);
    return { ...record, events: [...record.events, event] };
  });
  console.log(command
    ? `task ${id}: command pin recorded RED (exit ${event.exitCode}, digest ${event.outputDigest}${event.expect ? `, expects /${event.expect}/` : ""}) — ${command}`
    : `task ${id}: RED-check evidence recorded (${all.length} path(s)) — supplementary, not a substitute for a command pin`);
}

function cmdPinRetire(args) {
  const id = args._[0];
  if (!id) die("usage: pin-retire <id> --command \"<the exact pin command>\" --justification \"<why this pin is wrong>\"");
  const command = args.command;
  const justification = args.justification;
  if (typeof command !== "string" || command.trim().length === 0) die("pin-retire requires --command — the exact command of the pin being retired");
  if (typeof justification !== "string" || justification.trim().length === 0) die("pin-retire requires --justification — retiring a pin without a reason is deleting evidence");
  mutateTask(id, (record) => {
    const retired = retiredAppendRefusal(record);
    if (retired) die(`REFUSED — ${retired}`);
    if (derivePhase(record.events) === "done") die("done is terminal — a finished task's pins cannot be retired; reopen the concern as a new task");
    const recorded = record.events.some((e) => e.type === "red-check" && e.command === command);
    if (!recorded) die(`no command pin records exactly: ${command}\n  evidence: the task's pin commands are ${commandPins(record).map((p) => JSON.stringify(p.command)).join(", ") || "none"}`);
    const alreadyRetired = record.events.some((e) => e.type === "pin-retire" && e.command === command);
    if (alreadyRetired) die(`pin already retired: ${command}`);
    return { ...record, events: [...record.events, { at: new Date().toISOString(), type: "pin-retire", command, justification }] };
  });
  console.log(`task ${id}: pin retired (justification in the register, forever) — ${command}`);
}

function cmdPinExempt(args) {
  const id = args._[0];
  if (!id) die("usage: pin-exempt <id> --justification \"<why this task cannot carry a runnable pin>\"");
  const justification = args.justification;
  if (typeof justification !== "string" || justification.trim().length === 0) die("pin-exempt requires --justification — an exemption without a reason is not accountability");
  mutateTask(id, (record) => {
    const retired = retiredAppendRefusal(record);
    if (retired) die(`REFUSED — ${retired}`);
    return { ...record, events: [...record.events, { at: new Date().toISOString(), type: "pin-exemption", justification }] };
  });
  console.log(`task ${id}: pin exemption recorded (justification in the register, forever)`);
}

/**
 * Retire a task that will never execute — the honest ledger alternative to a planned record
 * that misleads every future status read into believing work is queued. Lawful only before
 * executing (a task with landed commits must finish honestly), terminal, once-only, and the
 * reason rides the register forever. The fence treats a retired record as authorizing nothing.
 */
function cmdRetire(args) {
  const id = args._[0];
  if (!id) die("usage: retire <id> --because \"<why this task never executes — name the successor or the fulfilled-by work>\"");
  mutateTask(id, (record) => {
    const refusal = retirementRefusal(record, args.because);
    if (refusal) die(`REFUSED — ${refusal}`);
    return { ...record, events: [...record.events, { at: new Date().toISOString(), type: "retired", because: String(args.because).trim() }] };
  });
  console.log(`task ${id}: retired (reason in the register, forever) — never executed, authorizes nothing`);
}

function cmdAdvance(args) {
  const [id, target] = args._;
  if (!id || !target) die("usage: advance <id> <phase>");
  let from;
  // Pin re-runs happen OUTSIDE the task lock and only when the transition could succeed: a pin
  // may run minutes, and the lock's stale-breaker would gift concurrent writers a lost update
  // (an adversarial finding — the exact bug the lock exists to prevent).
  let greenFailures = [];
  // The verified boundary runs the WHOLE battery once (ECC's stop-time batching): checks land
  // at the phase boundary, not per edit — and a red tool blocks the phase, not the commit.
  let batteryGreen = true;
  let batteryOutput = "";
  if (target === "verified" && derivePhase(loadTask(id).events) === "executing") {
    const run = runPinCommand("npm run selftest");
    if (run.exitCode !== 0) {
      batteryGreen = false;
      batteryOutput = run.output.split("\n").filter((l) => /FAILED|Error/.test(l)).slice(0, 3).join(" | ");
      die(`REFUSED — the selftest battery is not green (exit ${run.exitCode}) — verification runs the whole battery at the phase boundary
  evidence: ${batteryOutput || "(no FAILED lines captured — run npm run selftest)"}
  fix: npm run selftest   — fix every failing tool, then advance`);
    }
  }
  if (target === "done" && derivePhase(loadTask(id).events) === "adversarial") {
    const pins = commandPins(loadTask(id));
    for (const pin of pins) {
      // Twice, deliberately: the second run surfaces intermittent greens the single exit code hid.
      const failure = greenVerdictOf(pin, [runPinCommand(pin.command), runPinCommand(pin.command)]);
      if (failure !== null) greenFailures.push(failure);
    }
  }
  mutateTask(id, (record) => {
    const { ok, register, error } = loadFindings(`${STATE_DIR}/${id}.findings.json`);
    if (!ok) die(error);
    if (register && register.task !== id) die(`findings register belongs to task '${register.task}', not '${id}'`);
    const resolveMissing = register ? missingResolveEvidence(register, evidencePathIsFile) : [];
    const verdict = evaluateTransition(record, register, target, redCheckEvidence(record).every(evidencePathIsFile), { resolveEvidenceMissing: resolveMissing, greenFailures, batteryGreen });
    if (!verdict.ok) die(`REFUSED — ${verdict.reason}\n  fix: ${verdict.remedy}`);
    from = derivePhase(record.events);
    return { ...record, events: [...record.events, { at: new Date().toISOString(), type: "transition", to: target }] };
  });
  console.log(`task ${id}: ${from} -> ${target}`);
}

function statusObligations(record) {
  const { ok, register } = loadFindings(`${STATE_DIR}/${record.id}.findings.json`);
  return obligations(record, ok ? register : null, redCheckEvidence(record).every(evidencePathIsFile));
}

/** The pure half of one metrics row: span and density from a record and its findings. */
export function metricDerivation(record, findings) {
  const first = record.events?.[0]?.at;
  const doneAts = (record.events ?? []).filter((e) => e?.to === "done").map((e) => e.at);
  const doneAt = doneAts.length > 0 ? doneAts[doneAts.length - 1] : undefined;
  return {
    days: first !== undefined && doneAt !== undefined ? ((Date.parse(doneAt) - Date.parse(first)) / 86_400_000).toFixed(1) : null,
    findings: findings.length,
    highs: findings.filter((x) => x.severity === "CRITICAL" || x.severity === "HIGH").length,
  };
}

/** One metrics row, derived from one record (and its findings register, when present).
 * A register that does not parse is VISIBLE, never silently zeroed (the f12 finding: a corrupt
 * register must not render its task the cleanest wave in the ranking). */
function metricRow(record) {
  const { ok, register, error } = loadFindings(`${STATE_DIR}/${record.id}.findings.json`);
  if (!ok) {
    console.error(`task-state metrics: the findings register for '${record.id}' does not parse (${error}) — its row is INCOMPLETE until it does`);
  }
  const findings = ok && register ? register.findings : [];
  return { id: record.id, phase: derivePhase(record.events), ...metricDerivation(record, findings) };
}

/**
 * The read-side metrics derivation (the 2026-09-20 evaluation, gap 7): per-task wall-clock span
 * (first event → done) and findings density, DERIVED from the committed records and registers,
 * never stored. Wave ranking finally has a measured basis.
 */
function cmdMetrics() {
  const rows = [];
  for (const f of readdirSync(STATE_DIR).filter((x) => x.endsWith(".json") && !x.includes(".findings."))) {
    let record;
    try {
      record = JSON.parse(readFileSync(`${STATE_DIR}/${f}`, "utf8"));
    } catch {
      console.error(`task-state metrics: skipping unparsable ${f}`);
      continue;
    }
    if (record.schema !== TASK_SCHEMA) continue;
    rows.push(metricRow(record));
  }
  rows.sort((a, b) => b.findings - a.findings || b.highs - a.highs);
  console.log("task                    phase       days  findings  crit+high");
  for (const r of rows) {
    console.log(`${r.id.padEnd(23)} ${r.phase.padEnd(11)} ${String(r.days ?? "-").padEnd(5)} ${String(r.findings).padEnd(9)} ${r.highs}`);
  }
}

function cmdHandoff(args) {
  const id = args._[0];
  if (!id) die("usage: handoff <id>");
  const record = loadTask(id);
  const { ok, register, error } = loadFindings(`${STATE_DIR}/${id}.findings.json`);
  if (!ok) die(error);
  if (register && register.task !== id) die(`findings register belongs to task '${register.task}', not '${id}'`);
  // Real fs facts, the same ones advance judges with — a handoff that assumes the disk
  // understates what remains (a sweep caught the stubbed-true version).
  const onDisk = redCheckEvidence(record).every(evidencePathIsFile);
  const missing = register ? missingResolveEvidence(register, evidencePathIsFile) : [];
  console.log(handoffReport(record, ok ? register : null, onDisk, missing));
}

function cmdStatus(args) {
  if (args._[0]) {
    const record = loadTask(args._[0]);
    console.log(`task ${record.id} — ${derivePhase(record.events)} (risk class ${record.riskClass})`);
    const scope = scopeOf(record);
    if (scope.length > 0) console.log(`  scope: ${scope.join(", ")}`);
    for (const o of statusObligations(record)) console.log(`  • ${o}`);
    return;
  }
  if (!existsSync(STATE_DIR)) return console.log("no tasks recorded");
  const files = readdirSync(STATE_DIR).filter((f) => f.endsWith(".json") && !f.includes(".findings."));
  if (files.length === 0) return console.log("no tasks recorded");
  for (const f of files) {
    // One malformed foreign file must not make every task unreadable — warn and continue.
    let record;
    try {
      record = JSON.parse(readFileSync(`${STATE_DIR}/${f}`, "utf8"));
    } catch {
      console.error(`task-state: skipping unparsable ${f}`);
      continue;
    }
    if (record.schema !== TASK_SCHEMA) { console.error(`task-state: skipping non-task file ${f}`); continue; }
    console.log(`${derivePhase(record.events).padEnd(12)} ${record.id} (${record.riskClass})`);
  }
  printRetrospectiveSummary();
}

/** The status tail: the buried-knowledge counter, with malformed registers visible when skipped. */
function printRetrospectiveSummary() {
  const { registers, skipped } = loadRegisters(STATE_DIR);
  if (skipped > 0) console.error(`task-state status: retrospective skipped ${skipped} malformed register(s) — the summary line is INCOMPLETE until they parse`);
  console.log(summaryLine(lessonsIndex(registers)));
}

/**
 * Strict parser (found the hard way: the lenient one coerced '--lane --severity HIGH'
 * into lane=true, which Number() happily scored as lane 1, and silently kept only the LAST of
 * repeated --evidence flags). Every flag in this tool takes a value; duplicates are refused.
 */
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) { args._.push(a); continue; }
    const eq = a.indexOf("=");
    const key = a.slice(2, eq === -1 ? undefined : eq);
    if (args[key] !== undefined) die(`--${key} given more than once`);
    if (eq !== -1) { args[key] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) die(`--${key} requires a value`);
    args[key] = next;
    i += 1;
  }
  return args;
}

/** Self-test: the refusals ARE the feature — each case is a rule the prose lifecycle used to merely state. */
export function selfTest() {
  const failures = [];
  const fail = (m) => failures.push(m);
  const base = { schema: TASK_SCHEMA, id: "t", riskClass: "runtime-code", events: [{ type: "created" }] };
  const at = (record, to) => ({ ...record, events: [...record.events, { type: "transition", to }] });
  const cleanFindings = { schema: "stallion/task-findings@1", task: "t", passStartedAt: "2026-01-01T00:00:00.000Z", findings: [{ id: "f1", severity: "LOW", status: "RESOLVED", claim: "x", evidence: ["e"] }] };
  const dirtyFindings = { schema: "stallion/task-findings@1", task: "t", passStartedAt: "2026-01-01T00:00:00.000Z", findings: [{ id: "f1", severity: "HIGH", status: "UNRESOLVED", claim: "x" }] };
  const executing = at(base, "planned");
  const adversarial = at(at(at(executing, "executing"), "verified"), "adversarial");

  const cases = [
    ["fresh task derives intake", derivePhase(base.events) === "intake"],
    ["the taxonomy is pinned by content (the frozen six, in order)", JSON.stringify(RISK_CLASSES) === JSON.stringify(["planning-only", "docs-only", "runtime-code", "protected", "migration", "experiment"])],
    ["implementation-forbidden pinned by content", [...IMPLEMENTATION_FORBIDDEN].sort().join(",") === "experiment,planning-only"],
    ["approval-required pinned by content", [...APPROVAL_REQUIRED].sort().join(",") === "migration,protected"],
    ["intake -> planned allowed", evaluateTransition(base, null, "planned", true).ok],
    ["skip intake -> executing refused", !evaluateTransition(base, null, "executing", true).ok],
    ["backwards move refused", !evaluateTransition(at(executing, "executing"), null, "planned", true).ok],
    ["planning-only cannot execute", !evaluateTransition({ ...base, riskClass: "planning-only" }, null, "executing", true).ok],
    ["experiment cannot execute", !evaluateTransition({ ...base, riskClass: "experiment" }, null, "executing", true).ok],
    ["protected without approval refused", !evaluateTransition({ ...at(base, "planned"), riskClass: "protected" }, null, "executing", true).ok],
    ["protected with approval allowed", evaluateTransition({ ...at(base, "planned"), riskClass: "protected", events: [...at(base, "planned").events, { type: "approval", decision: "d" }] }, null, "executing", true).ok],
    ["migration without approval refused", !evaluateTransition({ ...at(base, "planned"), riskClass: "migration" }, null, "executing", true).ok],
    ["verified without red-check refused", !evaluateTransition(at(executing, "executing"), null, "verified", true).ok],
    ["a path-only red-check no longer verifies a code task", !evaluateTransition({ ...at(executing, "executing"), events: [...at(executing, "executing").events, { type: "red-check", evidence: ["a.test.ts"] }] }, null, "verified", true).ok],
    ["a command pin verifies a code task", evaluateTransition({ ...at(executing, "executing"), events: [...at(executing, "executing").events, { type: "red-check", command: "npm test -- x", at: "2026-09-19T00:00:00.000Z", exitCode: 1, outputDigest: "abc" }] }, null, "verified", true).ok],
    ["a pin carrying a satisfied --expect stays a valid pin", hasValidPin({ ...base, events: [...at(executing, "executing").events, { type: "red-check", command: "npm test -- x", expect: "Tests.*failed", exitCode: 1, outputDigest: "abc" }] })],
    ["a post-cutover pin WITHOUT expect does not verify (the seam the optional flag left open)", !hasValidPin({ ...base, events: [...at(executing, "executing").events, { type: "red-check", command: "npm test -- x", at: "2026-09-21T00:00:00.000Z", exitCode: 1, outputDigest: "abc" }] })],
    ["a pre-cutover pin without expect stays valid (grandfathered)", hasValidPin({ ...base, events: [...at(executing, "executing").events, { type: "red-check", command: "npm test -- x", at: "2026-09-19T00:00:00.000Z", exitCode: 1, outputDigest: "abc" }] })],
    ["--expect is satisfied by an assertion-failure line", expectationRefusal("Tests.*failed", "Test Files  1 failed (1)\n      Tests  3 failed | 9 passed (12)") === null],
    ["--expect refuses the uncollectable shape (nonzero exit, no tests ran)", expectationRefusal("Tests.*failed", "Test Files  1 failed (1)\n      Tests  no tests\n Failed to resolve import") !== null],
    ["--expect refuses an invalid pattern with its own reason", expectationRefusal("[unclosed", "anything") !== null],
    ["a recorded pin exemption substitutes for the command pin", evaluateTransition({ ...at(executing, "executing"), events: [...at(executing, "executing").events, { type: "red-check", evidence: ["a.test.ts"] }, { type: "pin-exemption", justification: "cannot re-run in this env" }] }, null, "verified", true).ok],
    ["a forged pin with exit 0 is not a pin", !evaluateTransition({ ...at(executing, "executing"), events: [...at(executing, "executing").events, { type: "red-check", command: "true", exitCode: 0, outputDigest: "x" }] }, null, "verified", true).ok],
    ["a killed pin (null exit) is not a pin", !evaluateTransition({ ...at(executing, "executing"), events: [...at(executing, "executing").events, { type: "red-check", command: "hang", exitCode: null, outputDigest: "x" }] }, null, "verified", true).ok],
    ["a red battery blocks verified even WITH a valid pin (the discriminating form)", !evaluateTransition({ ...at(executing, "executing"), events: [...at(executing, "executing").events, { type: "red-check", command: "npm test -- x", at: "2026-09-19T00:00:00.000Z", exitCode: 1, outputDigest: "abc" }] }, null, "verified", true, { batteryGreen: false }).ok],
    ["a green battery lets verified proceed", evaluateTransition({ ...at(executing, "executing"), events: [...at(executing, "executing").events, { type: "red-check", command: "npm test -- x", at: "2026-09-19T00:00:00.000Z", exitCode: 1, outputDigest: "abc" }] }, null, "verified", true, { batteryGreen: true }).ok],
    ["verified with vanished evidence refused", !evaluateTransition({ ...at(executing, "executing"), events: [...at(executing, "executing").events, { type: "red-check", evidence: ["gone.test.ts"] }] }, null, "verified", false).ok],
    ["done without findings register refused", !evaluateTransition(adversarial, null, "done", true).ok],
    ["done with UNRESOLVED finding refused", !evaluateTransition(adversarial, dirtyFindings, "done", true).ok],
    ["done with clean register allowed", evaluateTransition(adversarial, cleanFindings, "done", true).ok],
    ["done with an UNMARKED (never-prepared) register refused — empty is not a pass", !evaluateTransition(adversarial, { ...cleanFindings, passStartedAt: null, findings: [] }, "done", true).ok],
    ["forged transition event to an unknown phase is ignored by derivePhase", derivePhase([{ type: "transition", to: "shipped" }]) === "intake"],
    ["done is terminal", !evaluateTransition(at(adversarial, "done"), cleanFindings, "verified", true).ok],
    ["unknown phase refused", !evaluateTransition(base, null, "shipped", true).ok],
  ];
  for (const [n, passes] of cases) if (!passes) fail(`task-state: ${n}`);

  const remedyCases = [
    ["illegal jump names the legal next step", evaluateTransition(base, null, "executing", true).remedy?.includes("advance t planned")],
    ["approval refusal cites the approve command", evaluateTransition({ ...at(base, "planned"), riskClass: "protected" }, null, "executing", true).remedy?.includes("approve t --decision")],
    ["missing RED-check cites red-check", evaluateTransition(at(executing, "executing"), null, "verified", true).remedy?.includes("red-check t --command")],
    ["missing register cites prepare", evaluateTransition(adversarial, null, "done", true).remedy?.includes("prepare t")],
    ["unresolved findings cite resolve/wont-fix", evaluateTransition(adversarial, dirtyFindings, "done", true).remedy?.includes("resolve t")],
    ["vanished resolve evidence blocks done at the gate", !evaluateTransition(adversarial, cleanFindings, "done", true, { resolveEvidenceMissing: ["f1: gone.test.ts"] }).ok],
    ["a missing-evidence list absent (pure default) keeps the clean path pure", evaluateTransition(adversarial, cleanFindings, "done", true).ok],
    ["a failed GREEN re-run blocks done at the gate", !evaluateTransition(adversarial, cleanFindings, "done", true, { greenFailures: ['"npm test -- x" exit 1'] }).ok],
    ["green pins pass the done gate", evaluateTransition(adversarial, cleanFindings, "done", true, {}).ok],
    ["a retired pin neither verifies nor blocks done", (() => {
      const withPin = { ...at(executing, "executing"), events: [...at(executing, "executing").events, { type: "red-check", command: "bad --pin", exitCode: 1, outputDigest: "x" }, { type: "pin-retire", command: "bad --pin", justification: "demo pin" }] };
      return !evaluateTransition(withPin, null, "verified", true).ok && evaluateTransition(adversarial, cleanFindings, "done", true, {}).ok;
    })()],
  ];
  for (const [n, passes] of remedyCases) if (!passes) fail(`task-state: ${n}`);

  const scopeCases = [
    ["scopeOf unions scope events in first-declared order", JSON.stringify(scopeOf({ events: [{ type: "scope", patterns: ["tools/**"] }, { type: "transition", to: "planned" }, { type: "scope", patterns: [".githooks/*", "tools/**"] }] })) === JSON.stringify(["tools/**", ".githooks/*"])],
    ["a record with no scope events has an empty scope", scopeOf({ events: [{ type: "created" }] }).length === 0],
    ["malformed scope events contribute nothing", scopeOf({ events: [{ type: "scope", patterns: "tools/**" }, { type: "scope" }] }).length === 0],
    ["globRefusal accepts a tree glob", globRefusal("tools/**") === null],
    ["globRefusal refuses a leading slash", globRefusal("/tools/**") !== null],
    ["globRefusal refuses traversal segments", globRefusal("tools/../etc/**") !== null],
    ["globRefusal refuses a trailing slash", globRefusal("tools/") !== null],
    ["globRefusal refuses the everything-glob", globRefusal("**") !== null],
    ["globRefusal refuses an empty pattern", globRefusal("") !== null],
    ["globRefusal refuses a backslash pattern", globRefusal("tools\\**") !== null],
    ["recordCreatedAt reads the first timestamped event", recordCreatedAt({ events: [{ type: "created", at: "2026-09-18T20:56:00.000Z" }] }) === "2026-09-18T20:56:00.000Z"],
    ["recordCreatedAt is empty for an undated record", recordCreatedAt({ events: [{ type: "created" }] }) === ""],
    ["the scope law cut over after the pin law did", SCOPE_LAW_CUTOVER >= PIN_LAW_CUTOVER],
    ["the chain law cut over after the scope law did", CHAIN_CUTOVER > SCOPE_LAW_CUTOVER],
    ["the handoff report grades by evidence: worked / failed-with-reason / not-tried", (() => {
      const r = handoffReport({
        schema: TASK_SCHEMA, id: "t", riskClass: "runtime-code",
        events: [
          { type: "created", at: "2026-09-19T05:00:00.000Z" },
          { type: "red-check", command: "npm test", at: "2026-09-19T05:01:00.000Z", exitCode: 1, outputDigest: "d" },
          { type: "pin-retire", command: "bad", justification: "retired because the command hung" },
        ],
      }, {
        schema: "stallion/task-findings@1", task: "t", passStartedAt: "x",
        findings: [
          { id: "f1", severity: "LOW", status: "RESOLVED", claim: "a", evidence: ["e"] },
          { id: "f2", severity: "LOW", status: "WONT-FIX", claim: "b", justification: "boundary recorded" },
        ],
      });
      return r.includes("WORKED (with evidence)") && r.includes("FAILED (exact reasons)") && r.includes("boundary recorded") && r.includes("NOT TRIED")
        && r.includes("pin recorded RED (exit 1") && !r.includes("GREEN at done: \"npm test\"")  // truthful pre-done labels
        && (r.match(/\n## /g) ?? []).length === 3;  // exactly the machine headings — flattened client text cannot add any
    })()],
    ["an undated record MUST chain (fail closed)", recordMustChain({ events: [{ type: "created" }] }) === true],
    ["a pre-cutover record is chain-grandfathered", recordMustChain({ events: [{ type: "created", at: "2026-09-18T12:00:00.000Z" }] }) === false],
    ["a post-cutover record must chain", recordMustChain({ events: [{ type: "created", at: "2026-09-19T03:00:00.000Z" }] }) === true],
    ["an offset-spelled stamp fails closed for chains", recordMustChain({ events: [{ type: "created", at: "2026-09-18T20:00:00.000-05:00" }] }) === true],
    ["a window record is adoptable", adoptionRefusal({ events: [{ type: "created", at: "2026-09-19T02:50:00.000Z" }] }) === null],
    ["a post-window record can NEVER be adopted (the laundering bound)", adoptionRefusal({ events: [{ type: "created", at: "2026-09-19T05:00:00.000Z" }] }) !== null],
    ["a pre-cutover record refuses adoption", adoptionRefusal({ events: [{ type: "created", at: "2026-09-18T12:00:00.000Z" }] }) !== null],
    ["an already-chained record refuses adoption", adoptionRefusal({ events: [{ type: "created", at: "2026-09-19T02:50:00.000Z", entry_hash: "a".repeat(64) }] }) !== null],
    ["the post-window refusal names the forgery reading", adoptionRefusal({ events: [{ type: "created", at: "2026-09-19T05:00:00.000Z" }] }).includes("hand-forgery")],
    ["globRefusal refuses a first segment of '**' (covers everything)", globRefusal("**/*") !== null],
    ["globRefusal refuses a first segment of bare '*' (covers everything)", globRefusal("*/**") !== null],
    ["globRefusal accepts a named first segment with wildcards", globRefusal("tool*/*.mjs") === null],
    ["fence-surface scope under runtime-code refuses", fenceSurfaceRefusal({ riskClass: "runtime-code", events: [] }, [".githooks/**"]) !== null],
    ["fence-surface scope under protected WITHOUT approval refuses", fenceSurfaceRefusal({ riskClass: "protected", events: [] }, [".github/workflows/**"]) !== null],
    ["fence-surface scope under protected WITH approval passes", fenceSurfaceRefusal({ riskClass: "protected", events: [{ type: "approval", decision: "d" }] }, [".githooks/**", ".stallion-base"]) === null],
    ["non-surface scope never trips the tier law", fenceSurfaceRefusal({ riskClass: "runtime-code", events: [] }, ["tools/**", "tasks/**"]) === null],
    ["the tier refusal carries the protected-task fix", fenceSurfaceRefusal({ riskClass: "runtime-code", events: [] }, [".githooks/**"]).remedy?.includes("--risk-class protected")],
  ];
  for (const [n, passes] of scopeCases) if (!passes) fail(`task-state: ${n}`);

  const greenPinCount = runGreenPinCases(fail);

  const retireCases = runRetireRefusalCases(fail, { base, at, executing, adversarial }) + runRetireTerminalCases(fail, { at, executing });
  const fenceSurfaceCases = selfTestFenceSurfaceCases(fail) + selfTestFenceSurfaceNegativeCases(fail);

  console.log(failures.length === 0 ? `task-state self-test: OK (${cases.length} transition + ${remedyCases.length} remedy + ${scopeCases.length} scope + ${greenPinCount} green-pin + ${retireCases} retire + ${fenceSurfaceCases} fence-surface cases — counts derived)` : `task-state self-test: FAILED\n  ${failures.join("\n  ")}`);
  return failures.length === 0;
}


/** The over-arm family: root-level file globs and unrelated name-shapes must NOT read as fence
 *  surface — a walker seeded root-relatively once matched bare entry names against repo globs
 *  and refused *.md and workflows/** as protected-tier blast radius (an adversarial pass). */
function selfTestFenceSurfaceNegativeCases(fail) {
  const runtime = { riskClass: "runtime-code", events: [] };
  const cases = [
    ["root-level file globs do NOT reach fence surface (*.md, *.json pass)", fenceSurfaceRefusal(runtime, ["*.md"]) === null && fenceSurfaceRefusal(runtime, ["*.json"]) === null],
    ["unrelated name-shape patterns pass (workflows/**, gate-*)", fenceSurfaceRefusal(runtime, ["workflows/**"]) === null && fenceSurfaceRefusal(runtime, ["gate-*"]) === null],
    ["non-surface trees never trip the tier law", fenceSurfaceRefusal(runtime, ["tools/**", "tasks/**"]) === null],
  ];
  for (const [n, passes] of cases) if (!passes) fail(`task-state: ${n}`);
  return cases.length;
}

/** The tier-law family, ported from the vendor repo's close-out: the multi-segment docs/gates
 *  root, the broad patterns that cover it, and the name-shape-narrower shapes that reach real
 *  configs — the walker decides against the REAL corpus, never synthetic enumerations. */
function selfTestFenceSurfaceCases(fail) {
  const runtime = { riskClass: "runtime-code", events: [] };
  const approved = { riskClass: "protected", events: [{ type: "approval", decision: "d" }] };
  const cases = [
    ["multi-segment fence surface (docs/gates) refuses under runtime-code — the inert-entry finding", fenceSurfaceRefusal(runtime, ["docs/gates/**"]) !== null],
    ["a broad docs pattern that covers gates also refuses", fenceSurfaceRefusal(runtime, ["docs/**"]) !== null],
    ["wildcard-spelled single-segment roots refuse (the .*hooks/** escape, found at the vendor repo's wave-2 pass)", fenceSurfaceRefusal(runtime, [".*hooks/**"]) !== null && fenceSurfaceRefusal(runtime, [".git*/*"]) !== null],
    ["a wildcard-spelled .stallion-base refuses too — the fourth surface (the brute-forced escape)", fenceSurfaceRefusal(runtime, [".stallion*/**"]) !== null && fenceSurfaceRefusal(runtime, [".s*/**"]) !== null && fenceSurfaceRefusal(runtime, [".stallion-base"]) !== null],
    ["stacked double-star tails refuse too — the coverage dialect swallows them recursively (the brute-forced reopen)", fenceSurfaceRefusal(runtime, [".s*/**/**"]) !== null && fenceSurfaceRefusal(runtime, [".stallion-base/**/**"]) !== null && fenceSurfaceRefusal(runtime, [".s*/**/**/**"]) !== null],

    ["docs/* covers the gates directory NODE and correctly refuses (a scope matching the node can delete it)", fenceSurfaceRefusal(runtime, ["docs/*"]) !== null],
  ];
  for (const [n, passes] of cases) if (!passes) fail(`task-state: ${n}`);
  return cases.length + selfTestFenceSurfaceAllowedCases(fail, approved) + selfTestFenceSurfaceStructuralCases(fail);
}

/** The structural-prefix family: docs/gates spellings refuse with NO file on disk. */
function selfTestFenceSurfaceStructuralCases(fail) {
  const runtime = { riskClass: "runtime-code", events: [] };
  const cases = [
    ["name-shape-narrower patterns refuse STRUCTURALLY — the prefix law needs no file on disk (the future-file and rm'd-file doors)", fenceSurfaceRefusal(runtime, ["docs/gates/*.json"]) !== null && fenceSurfaceRefusal(runtime, ["docs/gates/gate-*"]) !== null && fenceSurfaceRefusal(runtime, ["docs/gates/brand-new-gate.json"]) !== null && fenceSurfaceRefusal(runtime, ["docs/gates/newdir/**"]) !== null],
    ["a cwd change cannot disarm the tier law — the multi-segment decision is pure, not corpus-relative", fenceSurfaceRefusal(runtime, ["docs/gates/anything-at-all.json"]) !== null],
  ];
  for (const [n, passes] of cases) if (!passes) fail(`task-state: ${n}`);
  return cases.length;
}

/** The allowed half: protected-with-approval may scope the surface; nobody else is over-armed. */
function selfTestFenceSurfaceAllowedCases(fail, approved) {
  const cases = [
    ["a protected task WITH approval may scope the gates surface", fenceSurfaceRefusal(approved, ["docs/gates/**"]) === null],
    ["a protected task WITH approval may scope the single-segment roots", fenceSurfaceRefusal(approved, [".githooks/**"]) === null],
  ];
  for (const [n, passes] of cases) if (!passes) fail(`task-state: ${n}`);
  return cases.length;
}

/** The retire-law refusal family: the pure retirementRefusal's every side. */
function runRetireRefusalCases(fail, { base, at, executing, adversarial }) {
  const cases = [
    ["an intake task retires lawfully", retirementRefusal(base, "superseded by y") === null],
    ["a planned task retires lawfully", retirementRefusal(executing, "superseded by y") === null],
    ["an executing task refuses retirement — its commits cite it", (retirementRefusal(at(executing, "executing"), "x") ?? "").includes("finish its lifecycle")],
    ["done refuses retirement (terminal twice over)", (retirementRefusal(at(adversarial, "done"), "x") ?? "").includes("done is terminal")],
    ["a retired task refuses re-retirement (once-only)", (retirementRefusal({ ...base, events: [...base.events, { type: "retired", because: "first" }] }, "again") ?? "").includes("already retired")],
    ["retirement without --because refuses", (retirementRefusal(executing, "   ") ?? "").includes("--because")],
    ["the write seam refuses appends to a retired record", retiredAppendRefusal({ ...base, events: [...base.events, { type: "retired", because: "superseded" }] }) !== null],
    ["the write seam leaves every non-retired record alone", retiredAppendRefusal(executing) === null && retiredAppendRefusal(at(adversarial, "done")) === null],
  ];
  for (const [n, passes] of cases) if (!passes) fail(`task-state: ${n}`);
  return cases.length;
}

/** The retire-law terminal family: derivation, advance, obligations, adoption. */
function runRetireTerminalCases(fail, { at, executing }) {
  const retiredOf = (record) => ({ ...record, events: [...record.events, { type: "retired", because: "superseded by y" }] });
  const advance = evaluateTransition(retiredOf(executing), null, "executing", true);
  const cases = [
    ["a retired event makes derivePhase terminal (the retire law)", derivePhase([{ type: "transition", to: "planned" }, { type: "retired", because: "superseded" }]) === "retired"],
    ["a transition after a retired event cannot un-retire the record", derivePhase([{ type: "transition", to: "planned" }, { type: "retired", because: "x" }, { type: "transition", to: "executing" }]) === "retired"],
    ["advancing a retired task refuses with the successor remedy", !advance.ok && advance.reason.includes("retired is terminal") && (advance.remedy ?? "").includes("new <new-id>")],
    ["obligations of a retired task name the terminal state", (obligations(retiredOf(executing), null, true)[0] ?? "").includes("retired")],
    ["adoption refuses a retired record", (adoptionRefusal({ events: [{ type: "created", at: "2026-09-19T02:50:00.000Z" }, { type: "retired", because: "x" }] }) ?? "").includes("retired is terminal")],
  ];
  for (const [n, passes] of cases) if (!passes) fail(`task-state: ${n}`);
  return cases.length;
}

/** Runs the GREEN-half case family; returns its count for the banner. */
function runGreenPinCases(fail) {
  const cases = [
    ...greenPinCaseFamily(),
    ["a signature on the SECOND exit-0 run also refuses (the lane-1 finding)", greenVerdictOf({ command: "npm test", expect: "SELF-TEST FAIL" }, [{ exitCode: 0, output: "all good" }, { exitCode: 0, output: "SELF-TEST FAIL: flaky" }])?.includes("vacuous green")],
    ["metrics derive span, density, and high counts purely", (() => {
      const record = { events: [{ at: "2026-09-19T00:00:00Z", type: "created" }, { at: "2026-09-20T12:00:00Z", to: "done" }] };
      const m = metricDerivation(record, [{ severity: "HIGH" }, { severity: "LOW" }, { severity: "MEDIUM" }]);
      return m.days === "1.5" && m.findings === 3 && m.highs === 1;
    })()],
    ["metrics leave span null for an unfinished task", metricDerivation({ events: [{ at: "2026-09-19T00:00:00Z" }] }, []).days === null],
  ];
  for (const [n, passes] of cases) if (!passes) fail(`task-state: ${n}`);
  return cases.length;
}

/** The GREEN-half case family, split from selfTest so the ratchet keeps its word on both. */
function greenPinCaseFamily() {
  return [
    ["a red first run is a plain failure", greenVerdictOf({ command: "npm test", expect: "SELF-TEST FAIL" }, [{ exitCode: 1, output: "" }, { exitCode: 0, output: "" }]) !== null],
    ["an intermittent green (pass then fail) refuses", greenVerdictOf({ command: "npm test" }, [{ exitCode: 0, output: "" }, { exitCode: 1, output: "" }])?.includes("intermittent green")],
    ["a vacuous green (exit 0 still showing the RED signature) refuses", greenVerdictOf({ command: "npm test", expect: "SELF-TEST FAIL" }, [{ exitCode: 0, output: "SELF-TEST FAIL: x" }, { exitCode: 0, output: "" }])?.includes("vacuous green")],
    ["a clean double pass with the signature gone clears", greenVerdictOf({ command: "npm test", expect: "SELF-TEST FAIL" }, [{ exitCode: 0, output: "all good" }, { exitCode: 0, output: "all good" }]) === null],
    ["a pin without a recorded expect clears on a double pass", greenVerdictOf({ command: "npm test" }, [{ exitCode: 0, output: "anything" }, { exitCode: 0, output: "" }]) === null],
    ["a single run alone is not a verdict (the caller must run twice)", greenVerdictOf({ command: "npm test" }, [{ exitCode: 0, output: "" }])?.includes("intermittent green")],
  ];
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isEntry) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  try {
    const [cmd, ...rest] = argv;
    const args = parseArgs(rest);
    const commands = { new: cmdNew, approve: cmdApprove, scope: cmdScope, "adopt-chain": cmdAdoptChain, "red-check": cmdRedCheck, "pin-exempt": cmdPinExempt, "pin-retire": cmdPinRetire, retire: cmdRetire, advance: cmdAdvance, status: cmdStatus, handoff: cmdHandoff, metrics: cmdMetrics };
    if (!commands[cmd]) die("usage: task-state.mjs <new|approve|scope|adopt-chain|red-check(--command, --expect, --evidence)|pin-exempt|pin-retire|retire(--because)|advance|status|handoff|metrics> ... (--self-test to self-test)");
    commands[cmd](args);
  } catch (e) {
    if (e instanceof Refused) {
      console.error(`task-state: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
