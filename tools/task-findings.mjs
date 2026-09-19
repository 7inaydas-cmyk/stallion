#!/usr/bin/env node
/**
 * Task findings register — the shared seam between task-state and adversarial-runner.
 *
 * The adversarial pass produces findings; the task lifecycle consumes them as a precondition for
 * `done`. Both consumers parse and aggregate through THESE functions, so "any UNRESOLVED finding
 * blocks advance" cannot drift between the tool that records findings and the tool that enforces
 * them. Pure functions over the register object, plus the one shared fs shell — locked
 * read-modify-write — so every writer mutates state with the same discipline.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const FINDINGS_SCHEMA = "stallion/task-findings@1";
/** The moment the proof law took effect: CRITICAL/HIGH findings recorded after this owe a
 *  proof (evidence + a concrete failure scenario) at record time — enforced here, in the
 *  validator, not only in the dispatch prompt. Earlier findings are grandfathered. */
export const PROOF_CUTOVER = "2026-09-19T03:00:00.000Z";
/** The chain seam (inspired by ECC's capsule envelope): the genesis parent — 64 zeros. */
export const GENESIS_HASH = "0".repeat(64);
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
  if (f.lane !== null && f.lane !== undefined && (!Number.isInteger(f.lane) || f.lane < 1)) return `finding ${f.id}: lane must be a positive integer or null`;
  if (!SEVERITIES.includes(f.severity)) return `finding ${f.id}: unknown severity ${String(f.severity)}`;
  if ((f.severity === "CRITICAL" || f.severity === "HIGH") && typeof f.proof !== "string" && owesProof(f)) {
    return `finding ${f.id}: ${f.severity} owes a proof (evidence + a concrete failure scenario) — enforce it in the schema, not only in the prompt`;
  }
  if (typeof f.proof === "string" && f.proof.trim().length === 0) return `finding ${f.id}: an empty proof is not a proof`;
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

/**
 * Pure: does this finding owe a proof? The cutover stamp is parsed with the same fail-closed
 * strictness as every other cutover law — a missing, malformed, or offset-spelled recordedAt
 * OWES the proof (the forge case is the case that must not escape; an earlier version compared
 * lexicographically and failed open on exactly this class).
 */
export function owesProof(f) {
  if (typeof f.recordedAt !== "string") return true;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(f.recordedAt)) return true;
  return Date.parse(f.recordedAt) >= Date.parse(PROOF_CUTOVER);
}

/** Pure append. Returns a NEW register; refuses (returns a string) instead of mutating on bad input. */
export function appendFinding(register, { id, lane, severity, claim, proof, evidence }) {
  const candidate = {
    ...register,
    findings: [
      ...register.findings,
      { id, lane: lane ?? null, severity, claim, status: "UNRESOLVED", recordedAt: new Date().toISOString(), ...(proof ? { proof } : {}), ...(evidence ? { evidence } : {}) },
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
  const appended = appendFinding(base, { id: "f1", lane: 3, severity: "HIGH", claim: "dead wiring claimed fixed", proof: "fixture proof: pinned so the battery never depends on the wall clock" });
  if (typeof appended === "string") fail(`task-findings: appendFinding refused a good finding (${appended})`);
  const dupAppend = appendFinding(appended, { id: "f1", lane: 3, severity: "HIGH", claim: "again", proof: "fixture" });
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
  selfTestResolveEvidence(fail);
  selfTestChain(fail);
  selfTestProofLaw(fail);
}

function selfTestChain(fail) {
  if (canonicalJson({ b: 1, a: { d: 2, c: 3 } }) !== canonicalJson({ a: { c: 3, d: 2 }, b: 1 })) fail("task-findings: canonical JSON must be key-order independent");
  if (canonicalJson({ b: 1, a: 2 }) !== '{"a":2,"b":1}') fail("task-findings: canonical JSON must sort keys with no whitespace");
  const stamped = chainStampEvents([{ type: "created", at: "2026-09-19T03:00:00.000Z" }, { type: "transition", to: "planned", at: "2026-09-19T03:01:00.000Z" }]);
  if (chainError(stamped) !== null) fail("task-findings: a freshly stamped chain must verify clean");
  if (stamped[0].parent_hash !== GENESIS_HASH) fail("task-findings: the first event's parent must be the 64-zero genesis");
  if (stamped[1].parent_hash !== stamped[0].entry_hash) fail("task-findings: each event's parent must be the previous entry hash");
  if (chainError([{ ...stamped[0], entry_hash: "0".repeat(64) }, stamped[1]]) === null) fail("task-findings: a tampered entry hash must be detected");
  if (chainError([stamped[0], { ...stamped[1], parent_hash: "f".repeat(64) }]) === null) fail("task-findings: a broken parent link must be detected");
  if (chainError([stamped[0], { ...stamped[1], seq: 5 }]) === null) fail("task-findings: a seq that is not the event index must be detected");
  if (chainError([{ type: "created" }]) === null) fail("task-findings: unstamped events must fail verification");
}

function selfTestProofLaw(fail) {
  const post = { id: "f1", severity: "CRITICAL", status: "UNRESOLVED", claim: "x", recordedAt: "2026-09-19T03:00:00.000Z" };
  const pre = { id: "f1", severity: "CRITICAL", status: "UNRESOLVED", claim: "x", recordedAt: "2026-09-17T00:00:00.000Z" };
  if (validateFindings({ ...emptyFindings("t"), findings: [post] }) === null) fail("task-findings: a post-cutover CRITICAL finding without proof must be refused");
  if (validateFindings({ ...emptyFindings("t"), findings: [{ ...post, proof: "file:line + the input that breaks it" }] }) !== null) fail("task-findings: a CRITICAL finding with proof must validate");
  if (validateFindings({ ...emptyFindings("t"), findings: [{ ...post, severity: "LOW" }] }) !== null) fail("task-findings: a LOW finding does not owe proof");
  if (validateFindings({ ...emptyFindings("t"), findings: [pre] }) !== null) fail("task-findings: a pre-cutover finding is grandfathered without proof");
  if (!owesProof({ severity: "CRITICAL" })) fail("task-findings: a finding with NO recordedAt owes a proof (fail closed)");
  if (!owesProof({ severity: "CRITICAL", recordedAt: 123 })) fail("task-findings: a non-string recordedAt owes a proof (fail closed)");
  if (!owesProof({ severity: "CRITICAL", recordedAt: "2026-09-18T23:00:00.000-05:00" })) fail("task-findings: an offset-spelled post-cutover stamp owes a proof (fail closed)");
  if (owesProof({ severity: "CRITICAL", recordedAt: "2026-09-17T00:00:00.000Z" })) fail("task-findings: a strict-Z pre-cutover stamp is grandfathered");
}

/**
 * Resolve evidence that no longer exists. RESOLVED findings owe their evidence at verdict time,
 * not just at resolve time (the same law RED-checks already live under). Returns one
 * "<finding>: <path>" entry per vanished path; empty means clean.
 */
export function missingResolveEvidence(register, existsFn) {
  if (!register || typeof register !== "object" || !Array.isArray(register.findings)) return [];
  const missing = [];
  for (const f of register.findings) {
    if (f.status !== "RESOLVED") continue;
    for (const p of f.evidence ?? []) if (!existsFn(p)) missing.push(`${f.id}: ${p}`);
  }
  return missing;
}

function selfTestResolveEvidence(fail) {
  const base = emptyFindings("self-test");
  const appended = appendFinding(base, { id: "f1", lane: 3, severity: "HIGH", claim: "x", proof: "fixture" });
  if (typeof appended === "string") fail(`task-findings: evidence fixture append refused (${appended})`);
  const resolved = setFindingStatus(appended, "f1", { status: "RESOLVED", evidence: ["gone.test.ts"] });
  if (typeof resolved === "string") fail(`task-findings: evidence fixture resolve refused (${resolved})`);
  if (typeof resolved !== "string") {
    if (missingResolveEvidence(resolved, () => false).length !== 1) fail("task-findings: vanished resolve evidence must be reported");
    if (missingResolveEvidence(resolved, () => true).length !== 0) fail("task-findings: present resolve evidence must not be reported");
    if (missingResolveEvidence(appended, () => false).length !== 0) fail("task-findings: UNRESOLVED findings carry no evidence obligation");
  }
  if (validateFindings({ ...base, findings: [{ id: "f1", lane: 0, severity: "LOW", status: "UNRESOLVED", claim: "x" }] }) === null) fail("task-findings: a zero lane in a stored register must be refused");
  if (validateFindings({ ...base, findings: [{ id: "f1", lane: "3", severity: "LOW", status: "UNRESOLVED", claim: "x" }] }) === null) fail("task-findings: a string lane in a stored register must be refused");
}

/**
 * Canonical JSON: object keys sorted recursively, no insignificant whitespace. The chain hashes
 * THIS and nothing else, so formatting churn can never masquerade as content. (Chain seam
 * inspired by ECC's capsule-envelope schema: seq = index, parent = previous hash, genesis 64
 * zeros, entry_hash = sha256 of the entry with its own hash removed.)
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 hex of the canonical JSON of one event with its entry_hash removed. */
export function entryHashOf(event) {
  const { entry_hash, ...rest } = event ?? {};
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

/**
 * Stamp every UNstamped event, in order, each parented on the previous event's hash (genesis
 * for the first). Already-stamped events pass through untouched — appending stamps only the new
 * tail; full-list stamping happens at record creation and at chain adoption.
 */
export function chainStampEvents(events) {
  let parent = GENESIS_HASH;
  return (events ?? []).map((event, i) => {
    if (event && typeof event === "object" && typeof event.entry_hash === "string" && event.entry_hash.length === 64) {
      parent = event.entry_hash;
      return event;
    }
    const stamped = { ...event, seq: i, parent_hash: parent };
    stamped.entry_hash = entryHashOf(stamped);
    parent = stamped.entry_hash;
    return stamped;
  });
}

/**
 * Walk the chain: every event must sit at its index, parent on the previous hash (genesis for
 * the first), and re-hash to its recorded entry_hash. Returns null when intact, a human reason
 * when not — unstamped events fail verification, which is the point: a post-cutover record with
 * no chain is not a verified record.
 */
export function chainError(events) {
  let parent = GENESIS_HASH;
  for (let i = 0; i < (events ?? []).length; i += 1) {
    const e = events[i];
    if (!e || typeof e !== "object") return `event ${i}: not an object`;
    if (e.seq !== i) return `event ${i}: seq is ${String(e.seq)}, expected ${i}`;
    if (e.parent_hash !== parent) return `event ${i}: parent_hash does not chain to event ${i - 1}`;
    if (typeof e.entry_hash !== "string" || entryHashOf(e) !== e.entry_hash) return `event ${i}: entry_hash does not match its content`;
    parent = e.entry_hash;
  }
  return null;
}

/**
 * Mutual exclusion around one file: an O_EXCL lockfile with stale-breaking. `fn` runs holding
 * the lock; a throw releases it via finally — so a refusal raised inside a locked section must
 * THROW, never process.exit: exit skips finally and orphans the lockfile for the 60s
 * stale-breaker to clean up.
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

/**
 * Read-modify-write with the load INSIDE the lock. The load must happen there — locking only
 * the write serializes nothing: two writers load the same snapshot, both append, and the second
 * write silently erases the first's event while both report success (a real finding: two
 * concurrent `record`s both computed `f1`; a lost UNRESOLVED finding makes the register cleaner
 * than reality). `mutate` gets the file's current text (null when absent) and returns the next
 * value to write; null/undefined means "no write".
 */
export function mutateJson(path, mutate) {
  return withLock(path, () => {
    const next = mutate(existsSync(path) ? readFileSync(path, "utf8") : null);
    if (next !== undefined && next !== null) atomicWriteJson(path, next);
    return next;
  });
}

/**
 * The one case that needs real processes: 8 children race read-modify-writes on one file.
 * Under the lost-update bug the survivors land short of 8 while every writer reports success —
 * that silence is what makes the bug dangerous; under the lock every append survives.
 */
async function selfTestConcurrentWriters(fail) {
  const dir = mkdtempSync(join(tmpdir(), "stallion-race-"));
  try {
    const target = join(dir, "shared.json");
    atomicWriteJson(target, { items: [] });
    const script = `
      (async () => {
        const m = await import(${JSON.stringify(import.meta.url)});
        m.mutateJson(${JSON.stringify(target)}, (text) => {
          const o = JSON.parse(text);
          o.items.push(1);
          return o;
        });
      })().catch((e) => { console.error(e); process.exit(1); });
    `;
    const children = [];
    const exits = [];
    for (let i = 0; i < 8; i += 1) {
      const child = spawn(process.execPath, ["-e", script]);
      children.push(child);
      exits.push(new Promise((resolve) => child.on("exit", (code) => resolve(code))));
    }
    const codes = await Promise.race([
      Promise.all(exits),
      new Promise((resolve) => { setTimeout(() => resolve(null), 30_000); }),
    ]);
    if (codes === null) {
      for (const c of children) c.kill("SIGKILL");
      fail("task-findings: 8 concurrent writers did not settle within 30s");
      return;
    }
    const failed = codes.filter((c) => c !== 0).length;
    if (failed > 0) fail(`task-findings: ${failed}/8 concurrent writer(s) exited nonzero`);
    const final = JSON.parse(readFileSync(target, "utf8"));
    if (final.items.length !== 8) fail(`task-findings: LOST UPDATE — 8 concurrent read-modify-writes left ${final.items.length} appends`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isEntry && process.argv.includes("--self-test")) {
  (async () => {
    const failures = [];
    selfTestFindings((m) => failures.push(m));
    await selfTestConcurrentWriters((m) => failures.push(m));
    console.log(failures.length === 0 ? "task-findings self-test: OK (8 validation + 12 mutation + 9 chain + 8 proof cases + 8-writer race)" : `task-findings self-test: FAILED\n  ${failures.join("\n  ")}`);
    process.exit(failures.length === 0 ? 0 : 1);
  })();
}
