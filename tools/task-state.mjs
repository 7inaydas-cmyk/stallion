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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { aggregateFindings, loadFindings, missingResolveEvidence, mutateJson } from "./task-findings.mjs";

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
export const RISK_CLASSES = ["planning-only", "docs-only", "runtime-code", "protected", "migration", "experiment"];
export const PHASES = ["intake", "planned", "executing", "verified", "adversarial", "done"];
/** The taxonomy is defined HERE and imported by every other tool (issue #1): one law, no drift. */
export const IMPLEMENTATION_FORBIDDEN = new Set(["planning-only", "experiment"]);
export const APPROVAL_REQUIRED = new Set(["protected", "migration"]);

/** Phase is derived, never stored — and a forged/typo'd `to` is ignored rather than trusted. */
export function derivePhase(events) {
  let phase = "intake";
  for (const e of events) if (e.type === "transition" && PHASES.includes(e.to)) phase = e.to;
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

const FENCE_SURFACE_ROOTS = new Set([".githooks", ".github"]);
/**
 * Pure: patterns reaching the fence's own surface (.githooks/**, .github/**, .stallion-base)
 * are protected-tier blast radius — only a protected or migration task WITH a recorded approval
 * may declare them. The gated party must not be able to scope over the fence with a runtime-code
 * self-serve amendment (the law isCodePath already states for the push fence).
 */
export function fenceSurfaceRefusal(record, patterns) {
  const reaching = (patterns ?? []).filter((p) => p === ".stallion-base" || FENCE_SURFACE_ROOTS.has(String(p).split("/")[0]));
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
  return record.events.some((e) => e.type === "red-check" && typeof e.command === "string" && e.command.length > 0 && !retired.has(e.command) && Number.isInteger(e.exitCode) && e.exitCode !== 0);
}

function commandPins(record) {
  const retired = new Set(record.events.filter((e) => e.type === "pin-retire").map((e) => e.command));
  return record.events.filter((e) => e.type === "red-check" && typeof e.command === "string" && e.command.length > 0 && !retired.has(e.command) && Number.isInteger(e.exitCode) && e.exitCode !== 0);
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

function verificationGuard(record, _findings, evidenceOnDisk) {
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

function doneGuard(record, findings, _evidenceOnDisk, resolveEvidenceMissing = [], greenFailures = []) {
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
      remedy: `re-resolve with evidence that exists: node tools/adversarial-runner.mjs resolve ${record.id} <finding-id> --evidence <paths-that-exist>`,
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

/**
 * Pure transition judge. `findings` is the loaded findings register (null = none recorded) and
 * `evidenceOnDisk` is whether every recorded RED-check evidence path still exists — the fs fact the
 * caller re-verifies, so this stays testable with synthetic records.
 * Returns { ok: true } or { ok: false, reason } — the reason is the law being invoked.
 */
export function evaluateTransition(record, findings, target, evidenceOnDisk, resolveEvidenceMissing = [], greenFailures = []) {
  if (!record || record.schema !== TASK_SCHEMA) return { ok: false, reason: "not a task-state record", remedy: "start a real one: node tools/task-state.mjs new <id> --risk-class <class>" };
  if (!PHASES.includes(target)) return { ok: false, reason: `unknown phase: ${target}`, remedy: `phases are exactly: ${PHASES.join(", ")}` };
  const current = derivePhase(record.events);
  if (current === "done") return { ok: false, reason: "done is terminal — a finished task is reopened as a NEW task, not by rewinding this one", remedy: `node tools/task-state.mjs new <new-id> --risk-class ${record.riskClass}` };
  if (PHASES.indexOf(target) !== PHASES.indexOf(current) + 1) {
    const next = PHASES[PHASES.indexOf(current) + 1];
    return { ok: false, reason: `illegal jump ${current} -> ${target}: phases advance one at a time, in order`, remedy: `node tools/task-state.mjs advance ${record.id} ${next}` };
  }
  const guard = TRANSITION_GUARDS[`${current}->${target}`];
  if (guard) {
    const refusal = guard(record, findings, evidenceOnDisk, resolveEvidenceMissing, greenFailures);
    if (refusal) return { ok: false, reason: refusal.reason, remedy: refusal.remedy };
  }
  return { ok: true };
}

/** What blocks the next transition, computed from the SAME facts `advance` will check (the one
 *  exception: `advance done` re-runs command pins, which a status read must not do — status
 *  reports that the re-run WILL happen instead). */
export function obligations(record, findings, evidenceOnDisk) {
  const current = derivePhase(record.events);
  if (current === "done") return ["done — reopen as a new task if more work is needed"];
  const target = PHASES[PHASES.indexOf(current) + 1];
  const verdict = evaluateTransition(record, findings, target, evidenceOnDisk);
  if (verdict.ok && target === "done") {
    return [`advance to ${target} is unblocked`, `done will re-run ${commandPins(record).length} command pin(s) — each must pass`];
  }
  return verdict.ok ? [`advance to ${target} is unblocked`] : [verdict.reason, `fix: ${verdict.remedy}`];
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
  return mutateJson(path, (text) => mutate(parseTaskRecord(text, id, path)));
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
    return { schema: TASK_SCHEMA, id, title: args.title ?? null, riskClass, events: [{ at: new Date().toISOString(), type: "created", riskClass }] };
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
  mutateTask(id, (record) => ({ ...record, events: [...record.events, { at: new Date().toISOString(), type: "approval", decision: ref }] }));
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

const PIN_COMMAND_TIMEOUT_MS = 300_000;
const PIN_MAX_BUFFER = 10 * 1024 * 1024;

/** Run a pin command and return { exitCode, output } — the machine-verified RED capture.
 *  exitCode is null when the command could not deliver a verdict (spawn failure, timeout,
 *  signal, buffer overflow): a null verdict is NEVER a RED pin (an adversarial finding: real
 *  Node reports status null, not undefined, on all those paths). */
export function runPinCommand(command) {
  try {
    const out = execFileSync("sh", ["-c", command], { cwd: ROOT, encoding: "utf8", timeout: PIN_COMMAND_TIMEOUT_MS, maxBuffer: PIN_MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] });
    return { exitCode: 0, output: out };
  } catch (e) {
    if (!Number.isInteger(e.status)) {
      die(`pin command delivered no verdict: ${command} (${e.code ?? e.signal ?? e.message})\n  rule: a pin that did not run to completion is not evidence of anything\n  fix: make the command complete (it hangs, explodes past ${PIN_MAX_BUFFER / 1024 / 1024}MB of output, or cannot start)`);
    }
    return { exitCode: e.status, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function outputDigest(output) {
  return createHash("sha256").update(output).digest("hex").slice(0, 12);
}

function cmdRedCheck(args) {
  const [id, ...paths] = args._;
  if (!id) die("usage: red-check <id> --command \"<failing check>\" [--evidence <path>[,<path>...]]");
  const command = typeof args.command === "string" && args.command.trim().length > 0 ? args.command.trim() : null;
  const all = [...paths, ...(typeof args.evidence === "string" ? args.evidence.split(",") : [])].map((p) => p.trim()).filter(Boolean);
  if (!command && all.length === 0) die("red-check requires --command \"<the failing check>\" (and optionally --evidence <paths>)");
  for (const p of all) if (!evidencePathIsFile(p)) die(`evidence path is not a readable file: ${p}\n  fix: pass paths that exist, repo-relative or cwd-relative: node tools/task-state.mjs red-check ${id} --evidence <path>`);
  const event = { at: new Date().toISOString(), type: "red-check" };
  if (command) {
    const run = runPinCommand(command);
    if (run.exitCode === 0) {
      die(`REFUSED — the pin passed (exit 0): ${command}\n  rule: a pin is evidence only when it FAILS against pre-fix source\n  fix: run the red-check before the fix lands, or point the command at the pre-fix behavior`);
    }
    event.command = command;
    event.exitCode = run.exitCode;
    event.outputDigest = outputDigest(run.output);
  }
  if (all.length > 0) event.evidence = all;
  mutateTask(id, (record) => ({ ...record, events: [...record.events, event] }));
  console.log(command
    ? `task ${id}: command pin recorded RED (exit ${event.exitCode}, digest ${event.outputDigest}) — ${command}`
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
  mutateTask(id, (record) => ({ ...record, events: [...record.events, { at: new Date().toISOString(), type: "pin-exemption", justification }] }));
  console.log(`task ${id}: pin exemption recorded (justification in the register, forever)`);
}

function cmdAdvance(args) {
  const [id, target] = args._;
  if (!id || !target) die("usage: advance <id> <phase>");
  let from;
  // Pin re-runs happen OUTSIDE the task lock and only when the transition could succeed: a pin
  // may run minutes, and the lock's stale-breaker would gift concurrent writers a lost update
  // (an adversarial finding — the exact bug the lock exists to prevent).
  let greenFailures = [];
  if (target === "done" && derivePhase(loadTask(id).events) === "adversarial") {
    const pins = commandPins(loadTask(id));
    for (const pin of pins) {
      const run = runPinCommand(pin.command);
      if (run.exitCode !== 0) greenFailures.push(`"${pin.command}" exit ${run.exitCode ?? "no verdict"}`);
    }
  }
  mutateTask(id, (record) => {
    const { ok, register, error } = loadFindings(`${STATE_DIR}/${id}.findings.json`);
    if (!ok) die(error);
    if (register && register.task !== id) die(`findings register belongs to task '${register.task}', not '${id}'`);
    const resolveMissing = register ? missingResolveEvidence(register, evidencePathIsFile) : [];
    const verdict = evaluateTransition(record, register, target, redCheckEvidence(record).every(evidencePathIsFile), resolveMissing, greenFailures);
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
    ["a command pin verifies a code task", evaluateTransition({ ...at(executing, "executing"), events: [...at(executing, "executing").events, { type: "red-check", command: "npm test -- x", exitCode: 1, outputDigest: "abc" }] }, null, "verified", true).ok],
    ["a recorded pin exemption substitutes for the command pin", evaluateTransition({ ...at(executing, "executing"), events: [...at(executing, "executing").events, { type: "red-check", evidence: ["a.test.ts"] }, { type: "pin-exemption", justification: "cannot re-run in this env" }] }, null, "verified", true).ok],
    ["a forged pin with exit 0 is not a pin", !evaluateTransition({ ...at(executing, "executing"), events: [...at(executing, "executing").events, { type: "red-check", command: "true", exitCode: 0, outputDigest: "x" }] }, null, "verified", true).ok],
    ["a killed pin (null exit) is not a pin", !evaluateTransition({ ...at(executing, "executing"), events: [...at(executing, "executing").events, { type: "red-check", command: "hang", exitCode: null, outputDigest: "x" }] }, null, "verified", true).ok],
    ["verified with vanished evidence refused", !evaluateTransition({ ...at(executing, "executing"), events: [...at(executing, "executing").events, { type: "red-check", evidence: ["gone.test.ts"] }] }, null, "verified", false).ok],
    ["done without findings register refused", !evaluateTransition(adversarial, null, "done", true).ok],
    ["done with UNRESOLVED finding refused", !evaluateTransition(adversarial, dirtyFindings, "done", true).ok],
    ["done with clean register allowed", evaluateTransition(adversarial, cleanFindings, "done", true).ok],
    ["done with an UNMARKED (never-prepared) register refused — empty is not a pass", !evaluateTransition(adversarial, { ...cleanFindings, passStartedAt: null, findings: [] }, "done", true).ok],
    ["forged transition event to an unknown phase is ignored by derivePhase", derivePhase([{ type: "transition", to: "shipped" }]) === "intake"],
    ["done is terminal", !evaluateTransition(at(adversarial, "done"), cleanFindings, "verified", true).ok],
    ["unknown phase refused", !evaluateTransition(base, null, "shipped", true).ok],
  ];
  for (const [name, passes] of cases) if (!passes) fail(`task-state: ${name}`);

  const remedyCases = [
    ["illegal jump names the legal next step", evaluateTransition(base, null, "executing", true).remedy?.includes("advance t planned")],
    ["approval refusal cites the approve command", evaluateTransition({ ...at(base, "planned"), riskClass: "protected" }, null, "executing", true).remedy?.includes("approve t --decision")],
    ["missing RED-check cites red-check", evaluateTransition(at(executing, "executing"), null, "verified", true).remedy?.includes("red-check t --command")],
    ["missing register cites prepare", evaluateTransition(adversarial, null, "done", true).remedy?.includes("prepare t")],
    ["unresolved findings cite resolve/wont-fix", evaluateTransition(adversarial, dirtyFindings, "done", true).remedy?.includes("resolve t")],
    ["vanished resolve evidence blocks done at the gate", !evaluateTransition(adversarial, cleanFindings, "done", true, ["f1: gone.test.ts"]).ok],
    ["a missing-evidence list absent (pure default) keeps the clean path pure", evaluateTransition(adversarial, cleanFindings, "done", true).ok],
    ["a failed GREEN re-run blocks done at the gate", !evaluateTransition(adversarial, cleanFindings, "done", true, [], ['"npm test -- x" exit 1']).ok],
    ["green pins pass the done gate", evaluateTransition(adversarial, cleanFindings, "done", true, [], []).ok],
    ["a retired pin neither verifies nor blocks done", (() => {
      const withPin = { ...at(executing, "executing"), events: [...at(executing, "executing").events, { type: "red-check", command: "bad --pin", exitCode: 1, outputDigest: "x" }, { type: "pin-retire", command: "bad --pin", justification: "demo pin" }] };
      return !evaluateTransition(withPin, null, "verified", true).ok && evaluateTransition(adversarial, cleanFindings, "done", true, [], []).ok;
    })()],
  ];
  for (const [name, passes] of remedyCases) if (!passes) fail(`task-state: ${name}`);

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
    ["globRefusal refuses a first segment of '**' (covers everything)", globRefusal("**/*") !== null],
    ["globRefusal refuses a first segment of bare '*' (covers everything)", globRefusal("*/**") !== null],
    ["globRefusal accepts a named first segment with wildcards", globRefusal("tool*/*.mjs") === null],
    ["fence-surface scope under runtime-code refuses", fenceSurfaceRefusal({ riskClass: "runtime-code", events: [] }, [".githooks/**"]) !== null],
    ["fence-surface scope under protected WITHOUT approval refuses", fenceSurfaceRefusal({ riskClass: "protected", events: [] }, [".github/workflows/**"]) !== null],
    ["fence-surface scope under protected WITH approval passes", fenceSurfaceRefusal({ riskClass: "protected", events: [{ type: "approval", decision: "d" }] }, [".githooks/**", ".stallion-base"]) === null],
    ["non-surface scope never trips the tier law", fenceSurfaceRefusal({ riskClass: "runtime-code", events: [] }, ["tools/**", "docs/*"]) === null],
    ["the tier refusal carries the protected-task fix", fenceSurfaceRefusal({ riskClass: "runtime-code", events: [] }, [".githooks/**"]).remedy?.includes("--risk-class protected")],
  ];
  for (const [name, passes] of scopeCases) if (!passes) fail(`task-state: ${name}`);

  console.log(failures.length === 0 ? "task-state self-test: OK (26 transition + 10 remedy + 23 scope cases)" : `task-state self-test: FAILED\n  ${failures.join("\n  ")}`);
  return failures.length === 0;
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isEntry) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  try {
    const [cmd, ...rest] = argv;
    const args = parseArgs(rest);
    const commands = { new: cmdNew, approve: cmdApprove, scope: cmdScope, "red-check": cmdRedCheck, "pin-exempt": cmdPinExempt, "pin-retire": cmdPinRetire, advance: cmdAdvance, status: cmdStatus };
    if (!commands[cmd]) die("usage: task-state.mjs <new|approve|scope|red-check|pin-exempt|pin-retire|advance|status> ... (--self-test to self-test)");
    commands[cmd](args);
  } catch (e) {
    if (e instanceof Refused) {
      console.error(`task-state: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
