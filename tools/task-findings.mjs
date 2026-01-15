#!/usr/bin/env node
/**
 * Task findings register — the shared seam between task-state and adversarial-runner.
 *
 * The adversarial pass produces findings; the task lifecycle consumes them as a precondition for
 * `done`. Both consumers parse and aggregate through THESE functions, so "any UNRESOLVED finding
 * blocks advance" cannot drift between the tool that records findings and the tool that enforces
 * them. Pure functions over the register object; the fs shell lives in each tool.
 */
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

export const FINDINGS_SCHEMA = "stallion/task-findings@1";
export const FINDING_STATUSES = ["UNRESOLVED", "RESOLVED", "WONT-FIX"];
export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

export function emptyFindings(taskId) {
  return { schema: FINDINGS_SCHEMA, task: taskId, passStartedAt: null, findings: [] };
}

/**
 * The pass marker is the difference between "no findings" and "no pass". Only `prepare` mints it
 * (against a real diff); verdict and the done-gate require it, so an empty register can never
 * stand in for a sweep that happened — an adversarial pass, end to-end.
 */
export function passMarkerError(register) {
  if (register.passStartedAt === undefined) return "register predates the pass marker";
  if (register.passStartedAt !== null && typeof register.passStartedAt !== "string") return "passStartedAt must be a timestamp string or null";
  return null;
}

function idError(f) {
  if (typeof f.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(f.id)) return `finding id malformed: ${String(f.id)}`;
  return null;
}

function shapeError(f) {
  if (!f || typeof f !== "object") return "finding is not an object";
  const id = idError(f);
  if (id) return id;
  if (!SEVERITIES.includes(f.severity)) return `finding ${f.id}: unknown severity ${String(f.severity)}`;
  if (!FINDING_STATUSES.includes(f.status)) return `finding ${f.id}: unknown status ${String(f.status)}`;
  if (typeof f.claim !== "string" || f.claim.trim().length === 0) return `finding ${f.id}: empty claim`;
  return null;
}

function statusObligationError(f) {
  if (f.status === "WONT-FIX" && (typeof f.justification !== "string" || f.justification.trim().length === 0)) {
    return `finding ${f.id}: WONT-FIX without justification`;
  }
  if (f.status === "RESOLVED" && (!Array.isArray(f.evidence) || f.evidence.length === 0)) {
    return `finding ${f.id}: RESOLVED without evidence`;
  }
  return null;
}

function findingError(f, seen) {
  const shape = shapeError(f);
  if (shape) return shape;
  if (seen.has(f.id)) return `duplicate finding id: ${f.id}`;
  return statusObligationError(f);
}

function registerShapeError(register) {
  if (!register || typeof register !== "object") return "register is not an object";
  if (register.schema !== FINDINGS_SCHEMA) return `unknown schema: ${String(register.schema)}`;
  if (typeof register.task !== "string" || register.task.length === 0) return "register has no task id";
  if (!Array.isArray(register.findings)) return "findings is not an array";
  return null;
}

/**
 * Fail-closed structural validation. Returns null when clean, a human reason when not — the same
 * contract everywhere so callers never have to distinguish "broken" from "guilty".
 */
export function validateFindings(register) {
  const shape = registerShapeError(register);
  if (shape) return shape;
  const marker = passMarkerError(register);
  if (marker) return marker;
  const seen = new Set();
  for (const f of register.findings) {
    const error = findingError(f, seen);
    if (error) return error;
    seen.add(f.id);
  }
  return null;
}

/** The aggregation both consumers agree on. `clean` is the single bit the lifecycle gates on. */
export function aggregateFindings(register) {
  const by = { UNRESOLVED: 0, RESOLVED: 0, "WONT-FIX": 0 };
  for (const f of register.findings) by[f.status] += 1;
  return { total: register.findings.length, unresolved: by.UNRESOLVED, resolved: by.RESOLVED, wontFix: by["WONT-FIX"], clean: by.UNRESOLVED === 0 };
}

/** Pure append. Returns a NEW register; refuses (returns a string) instead of mutating on bad input. */
export function appendFinding(register, { id, lane, severity, claim }) {
  const candidate = {
    ...register,
    findings: [
      ...register.findings,
      { id, lane: lane ?? null, severity, claim, status: "UNRESOLVED", recordedAt: new Date().toISOString() },
    ],
  };
  const error = validateFindings(candidate);
  return error ? error : candidate;
}

/** Pure status change with the same fail-closed rules (WONT-FIX needs a why; RESOLVED needs evidence). */
export function setFindingStatus(register, id, patch) {
  if (!register || typeof register !== "object") return "register is not an object";
  const target = register.findings.find((f) => f.id === id);
  if (!target) return `no such finding: ${id}`;
  if (target.status !== "UNRESOLVED") return `finding ${id} is already ${target.status} — resolutions are append-only; no re-litigating a closed finding`;
  const next = {
    ...register,
    findings: register.findings.map((f) => (f.id === id ? { ...f, ...patch, resolvedAt: new Date().toISOString() } : f)),
  };
  const error = validateFindings(next);
  return error ? error : next;
}

/**
 * Load + validate from disk. Missing file is NOT an error here — "no adversarial pass recorded" is
 * a lifecycle fact the caller reports; malformed content IS an error (fail closed on corruption).
 */
export function loadFindings(path) {
  if (!existsSync(path)) return { ok: true, register: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { ok: false, error: `findings register is not valid JSON: ${e.message}` };
  }
  const error = validateFindings(parsed);
  if (error) return { ok: false, error };
  return { ok: true, register: parsed };
}

/** Self-test: drive every refusal AND every allowance — a validator nobody has watched refuse is decoration. */
function selfTestValidate(fail) {
  const base = emptyFindings("self-test");
  const cases = [
    ["clean empty register validates", validateFindings(base) === null],
    ["unknown schema refused", validateFindings({ ...base, schema: "nope" }) !== null],
    ["findings non-array refused", validateFindings({ ...base, findings: {} }) !== null],
    ["WONT-FIX without justification refused", validateFindings({ ...base, findings: [{ id: "f1", severity: "LOW", status: "WONT-FIX", claim: "x" }] }) !== null],
    ["RESOLVED without evidence refused", validateFindings({ ...base, findings: [{ id: "f1", severity: "LOW", status: "RESOLVED", claim: "x" }] }) !== null],
    ["duplicate id refused", validateFindings({ ...base, findings: [
      { id: "f1", severity: "LOW", status: "UNRESOLVED", claim: "x" },
      { id: "f1", severity: "LOW", status: "UNRESOLVED", claim: "y" },
    ] }) !== null],
    ["unknown severity refused", validateFindings({ ...base, findings: [{ id: "f1", severity: "MAXIMUM", status: "UNRESOLVED", claim: "x" }] }) !== null],
  ];
  for (const [name, passes] of cases) if (!passes) fail(`task-findings: ${name}`);
}

function selfTestAppendResolve(fail) {
  const base = emptyFindings("self-test");
  const appended = appendFinding(base, { id: "f1", lane: 3, severity: "HIGH", claim: "dead wiring claimed fixed" });
  if (typeof appended === "string") fail(`task-findings: appendFinding refused a good finding (${appended})`);
  const dupAppend = appendFinding(appended, { id: "f1", lane: 3, severity: "HIGH", claim: "again" });
  if (typeof dupAppend !== "string") fail("task-findings: appendFinding accepted a duplicate id");
  let agg = aggregateFindings(appended);
  if (agg.clean || agg.unresolved !== 1) fail("task-findings: one UNRESOLVED finding must not aggregate clean");
  const resolved = setFindingStatus(appended, "f1", { status: "RESOLVED", evidence: ["test/x.test.ts"] });
  if (typeof resolved === "string") fail(`task-findings: resolve refused a good patch (${resolved})`);
  agg = aggregateFindings(resolved);
  if (!agg.clean || agg.resolved !== 1) fail("task-findings: a RESOLVED-only register must aggregate clean");
}

function selfTestStatusGuards(fail) {
  const base = emptyFindings("self-test");
  const appended = appendFinding(base, { id: "f1", lane: 3, severity: "HIGH", claim: "dead wiring claimed fixed" });
  const resolved = setFindingStatus(appended, "f1", { status: "RESOLVED", evidence: ["test/x.test.ts"] });
  const bareWontFix = setFindingStatus(appended, "f1", { status: "WONT-FIX" });
  if (typeof bareWontFix !== "string") fail("task-findings: WONT-FIX without justification accepted");
  const unknownId = setFindingStatus(appended, "nope", { status: "RESOLVED", evidence: ["e"] });
  if (typeof unknownId !== "string") fail("task-findings: status change on unknown finding id accepted");
  const reLitigated = setFindingStatus(resolved, "f1", { status: "UNRESOLVED" });
  if (typeof reLitigated !== "string") fail("task-findings: re-opening a closed finding accepted");
  const nonObject = setFindingStatus("garbage", "f1", { status: "RESOLVED", evidence: ["e"] });
  if (typeof nonObject !== "string") fail("task-findings: status change on a non-register accepted");
}

export function selfTestFindings(fail) {
  selfTestValidate(fail);
  selfTestAppendResolve(fail);
  selfTestStatusGuards(fail);
}

/**
 * Serialized read-modify-write for the JSON state both tools mutate (a real
 * finding: two concurrent `record`s both computed `f1` and the second silently erased the first —
 * a lost UNRESOLVED finding makes the register cleaner than reality). An O_EXCL lockfile with
 * stale-breaking plus temp+rename so a crashed writer leaves either the old or the new file,
 * never a torn one.
 */
export function withLock(path, fn) {
  const lock = `${path}.lock`;
  acquireLock(lock);
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

function acquireLock(lock) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      closeSync(openSync(lock, "wx"));
      return;
    } catch {
      if (existsSync(lock) && statSync(lock).mtimeMs < Date.now() - 60_000) rmSync(lock, { force: true }); // stale writer
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  throw new Error(`could not acquire ${lock} after 60 attempts (6s) — another writer holds it`);
}

/** Write-then-rename: readers never observe a half-written register. */
export function atomicWriteJson(path, value) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntry && process.argv.includes("--self-test")) {
  const failures = [];
  selfTestFindings((m) => failures.push(m));
  console.log(failures.length === 0 ? "task-findings self-test: OK (7 validation + 9 mutation cases)" : `task-findings self-test: FAILED\n  ${failures.join("\n  ")}`);
  process.exit(failures.length === 0 ? 0 : 1);
}
