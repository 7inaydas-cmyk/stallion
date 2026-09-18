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
 *   - planning-only and product-protocol tasks can NEVER reach executing.
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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { aggregateFindings, loadFindings, mutateJson } from "./task-findings.mjs";

const ROOT = new URL("../", import.meta.url).pathname;
const STATE_DIR = `${ROOT}tasks`;
const DECISIONS = `${ROOT}docs/decisions/DECISIONS.md`;

export const TASK_SCHEMA = "stallion/task-state@1";
export const RISK_CLASSES = ["planning-only", "harness-docs-only", "runtime-code", "protected", "migration", "product-protocol"];
export const PHASES = ["intake", "planned", "executing", "verified", "adversarial", "done"];
const IMPLEMENTATION_FORBIDDEN = new Set(["planning-only", "product-protocol"]);
const APPROVAL_REQUIRED = new Set(["protected", "migration"]);

/** Phase is derived, never stored — and a forged/typo'd `to` is ignored rather than trusted. */
export function derivePhase(events) {
  let phase = "intake";
  for (const e of events) if (e.type === "transition" && PHASES.includes(e.to)) phase = e.to;
  return phase;
}

function hasApproval(record) {
  return record.events.some((e) => e.type === "approval");
}

function redCheckEvidence(record) {
  const paths = [];
  for (const e of record.events) if (e.type === "red-check") paths.push(...(e.evidence ?? []));
  return paths;
}

function evidencePathIsFile(p) {
  const resolved = existsSync(p) ? p : `${ROOT}${p.replace(/^\//, "")}`;
  return existsSync(resolved) && statSync(resolved).isFile();
}

function executionGuard(record) {
  if (IMPLEMENTATION_FORBIDDEN.has(record.riskClass)) {
    return `risk class '${record.riskClass}' is implementation-forbidden by TASK-LIFECYCLE — a separate, explicitly authorized task must be opened`;
  }
  if (APPROVAL_REQUIRED.has(record.riskClass) && !hasApproval(record)) {
    return `risk class '${record.riskClass}' requires a recorded owner approval (approve --decision <ref>) before executing`;
  }
  return null;
}

function verificationGuard(record, _findings, evidenceOnDisk) {
  const evidence = redCheckEvidence(record);
  if (evidence.length === 0) {
    return "no RED-check recorded — a pin is not a pin until it has been run RED against pre-fix source (red-check --evidence <paths>)";
  }
  if (!evidenceOnDisk) {
    return "recorded RED-check evidence no longer exists on disk — evidence must be present at verification time, not just remembered";
  }
  return null;
}

function doneGuard(_record, findings) {
  if (!findings) return "no adversarial findings register — the adversarial pass must be recorded before done (adversarial-runner record/verdict)";
  if (!findings.passStartedAt) return "findings register carries no pass marker — only a prepared pass (a real diff swept) counts; an empty register is not a completed pass";
  const agg = aggregateFindings(findings);
  if (!agg.clean) return `${agg.unresolved} UNRESOLVED adversarial finding(s) — resolve or wont-fix each before done`;
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
export function evaluateTransition(record, findings, target, evidenceOnDisk) {
  if (!record || record.schema !== TASK_SCHEMA) return { ok: false, reason: "not a task-state record" };
  if (!PHASES.includes(target)) return { ok: false, reason: `unknown phase: ${target}` };
  const current = derivePhase(record.events);
  if (current === "done") return { ok: false, reason: "done is terminal — a finished task is reopened as a NEW task, not by rewinding this one" };
  if (PHASES.indexOf(target) !== PHASES.indexOf(current) + 1) {
    return { ok: false, reason: `illegal jump ${current} -> ${target}: phases advance one at a time, in order` };
  }
  const guard = TRANSITION_GUARDS[`${current}->${target}`];
  if (guard) {
    const reason = guard(record, findings, evidenceOnDisk);
    if (reason) return { ok: false, reason };
  }
  return { ok: true };
}

/** What blocks the next transition, computed from the SAME facts `advance` will check. */
export function obligations(record, findings, evidenceOnDisk) {
  const current = derivePhase(record.events);
  if (current === "done") return ["done — reopen as a new task if more work is needed"];
  const target = PHASES[PHASES.indexOf(current) + 1];
  const verdict = evaluateTransition(record, findings, target, evidenceOnDisk);
  return verdict.ok ? [`advance to ${target} is unblocked`] : [verdict.reason];
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
  if (text === null) die(`no such task: ${id} (expected ${path})`);
  let record;
  try {
    record = JSON.parse(text);
  } catch (e) {
    die(`task record is not valid JSON: ${e.message}`);
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
    if (text !== null) die(`task already exists: ${id}`);
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
    die(`no decisions-register entry heading equals: ${ref}\n  an approval must cite a FULL entry heading from docs/decisions/DECISIONS.md, verbatim — a substring is not an act: short refs match by accident`);
  }
  mutateTask(id, (record) => ({ ...record, events: [...record.events, { at: new Date().toISOString(), type: "approval", decision: ref }] }));
  console.log(`task ${id}: owner approval recorded (decision: ${ref})`);
}

function cmdRedCheck(args) {
  const [id, ...paths] = args._;
  if (!id) die("usage: red-check <id> --evidence <path>[,<path>...]  (or bare paths after the id)");
  const all = [...paths, ...(typeof args.evidence === "string" ? args.evidence.split(",") : [])].map((p) => p.trim()).filter(Boolean);
  if (all.length === 0) die("red-check requires evidence paths — the files that prove the pin ran RED");
  for (const p of all) if (!evidencePathIsFile(p)) die(`evidence path is not a readable file: ${p}`);
  mutateTask(id, (record) => ({ ...record, events: [...record.events, { at: new Date().toISOString(), type: "red-check", evidence: all }] }));
  console.log(`task ${id}: RED-check evidence recorded (${all.length} path(s))`);
}

function cmdAdvance(args) {
  const [id, target] = args._;
  if (!id || !target) die("usage: advance <id> <phase>");
  let from;
  mutateTask(id, (record) => {
    const { ok, register, error } = loadFindings(`${STATE_DIR}/${id}.findings.json`);
    if (!ok) die(error);
    if (register && register.task !== id) die(`findings register belongs to task '${register.task}', not '${id}'`);
    const verdict = evaluateTransition(record, register, target, redCheckEvidence(record).every(evidencePathIsFile));
    if (!verdict.ok) die(`REFUSED — ${verdict.reason}`);
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
    ["intake -> planned allowed", evaluateTransition(base, null, "planned", true).ok],
    ["skip intake -> executing refused", !evaluateTransition(base, null, "executing", true).ok],
    ["backwards move refused", !evaluateTransition(at(executing, "executing"), null, "planned", true).ok],
    ["planning-only cannot execute", !evaluateTransition({ ...base, riskClass: "planning-only" }, null, "executing", true).ok],
    ["product-protocol cannot execute", !evaluateTransition({ ...base, riskClass: "product-protocol" }, null, "executing", true).ok],
    ["protected without approval refused", !evaluateTransition({ ...at(base, "planned"), riskClass: "protected" }, null, "executing", true).ok],
    ["protected with approval allowed", evaluateTransition({ ...at(base, "planned"), riskClass: "protected", events: [...at(base, "planned").events, { type: "approval", decision: "d" }] }, null, "executing", true).ok],
    ["migration without approval refused", !evaluateTransition({ ...at(base, "planned"), riskClass: "migration" }, null, "executing", true).ok],
    ["verified without red-check refused", !evaluateTransition(at(executing, "executing"), null, "verified", true).ok],
    ["verified with red-check allowed", evaluateTransition({ ...at(executing, "executing"), events: [...at(executing, "executing").events, { type: "red-check", evidence: ["a.test.ts"] }] }, null, "verified", true).ok],
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

  console.log(failures.length === 0 ? "task-state self-test: OK (19 transition cases)" : `task-state self-test: FAILED\n  ${failures.join("\n  ")}`);
  return failures.length === 0;
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntry) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  try {
    const [cmd, ...rest] = argv;
    const args = parseArgs(rest);
    const commands = { new: cmdNew, approve: cmdApprove, "red-check": cmdRedCheck, advance: cmdAdvance, status: cmdStatus };
    if (!commands[cmd]) die("usage: task-state.mjs <new|approve|red-check|advance|status> ... (--self-test to self-test)");
    commands[cmd](args);
  } catch (e) {
    if (e instanceof Refused) {
      console.error(`task-state: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
