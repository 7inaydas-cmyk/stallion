#!/usr/bin/env node
/**
 * Task coverage — the control that makes the executable lifecycle MANDATORY .
 *
 * Without this guard, the lifecycle is consented adoption: code can land with no record at all.
 * This control closes that. Run it wherever your push path can refuse: a pre-push hook, a push
 * wrapper, or CI. It refuses any push whose range contains a commit that touches CODE without a
 * task record authorizing it.
 *
 * The contract a code commit must satisfy (all three, or the push fails):
 *   1. its message carries a `task: <kebab-id>` footer on its own line;
 *   2. tasks/<id>.json exists and is a valid record;
 *   3. that record authorizes implementation AT PUSH TIME: risk class not implementation-forbidden,
 *      derived phase at least `executing`, and (defense in depth) protected/migration classes carry
 *      an approval event — task-state enforces these at advance-time; this re-checks them because a
 *      hand-edited record must not sail through on the advance-time check alone.
 *
 * What counts as CODE (deliberately broad, stated so it cannot widen by inference): files under
 * apps/**, packages/**, tools/**, deploy/** with a code extension (ts, tsx, js, mjs, cjs, sh, mts,
 * cts, css) or named Dockerfile/Caddyfile. Docs, JSON state, markdown, and config outside those
 * trees do not need a task — the lifecycle governs implementation, not prose. (.sql is exempt by
 * default: SQL migrations tend to be fenced by schema-review controls elsewhere.)
 *
 * Honest boundaries, acknowledged rather than fenced (an adversarial pass): the
 * record is read from the WORKING TREE at push time (CI re-judges from the pushed tree); nothing
 * re-checks a record after its push — a later rewind is the plain-JSON trust boundary whose
 * evidence is git history; and the footer binds the commit to the task's DECLARED SCOPE
 * (citationRefusal — the commit-msg gate at commit time, this fence at push time), so a citation
 * is no longer bearer: post-cutover tasks must name their blast radius and code outside it
 * refuses. A post-hoc scope widening IS possible (append-only amendment); no machine check
 * reads event-vs-commit ordering — this repo's neutral-date discipline makes timestamps
 * non-evidence — so the visibility is the amendment event itself in the record's git history,
 * and a single commit that both widens a scope and lands the excusing code is that history's
 * plainest tell (registered future work).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lanesFromChecklist } from "./adversarial-runner.mjs";
import { RISK_CLASSES, IMPLEMENTATION_FORBIDDEN, APPROVAL_REQUIRED, PHASES as PHASE_ORDER, derivePhase, hasValidPin, hasPinExemption, PIN_LAW_CUTOVER, scopeOf, recordCreatedAt, globRefusal, SCOPE_LAW_CUTOVER, recordMustChain, CHAIN_CUTOVER } from "./task-state.mjs";
import { chainError, chainStampEvents } from "./task-findings.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STATE_DIR = `${ROOT}tasks`;
const DECISIONS = `${ROOT}docs/decisions/DECISIONS.md`;
const CHECKLIST = `${ROOT}docs/ADVERSARIAL-CHECKLIST.md`;
const CODE_TREES = ["apps/", "packages/", "tools/", "deploy/"];
const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".sh", ".mts", ".cts", ".css"]);
const CODE_NAMES = new Set(["Dockerfile", "Caddyfile"]); // no-extension executables under the four trees

/** Pure: does this changed path count as code the lifecycle must cover? The fence's own
 *  surface — .stallion-base, the hooks, the CI workflows — IS code: an adversarial finding
 *  showed a base bump or a workflow edit needed no task footer, letting the gated party
 *  rewrite the fence in the very push it fences. */
export function isCodePath(path) {
  if (path === ".stallion-base") return true;
  if (path.startsWith(".githooks/")) return true;
  if (path.startsWith(".github/workflows/") && /\.(yml|yaml)$/.test(path)) return true;
  if (!CODE_TREES.some((t) => path.startsWith(t))) return false;
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (CODE_NAMES.has(base)) return true;
  const dot = path.lastIndexOf(".");
  return dot !== -1 && CODE_EXTS.has(path.slice(dot));
}

/**
 * Pure: the staged-files gate decision. Code staged + no task in flight = refusal carrying the
 * code files as evidence; null = pass. In flight means executing, verified, or adversarial —
 * done does NOT authorize new code (an adversarial finding: one stale done task was a master
 * key that held this gate open forever).
 */
export function stagedRefusal(stagedFiles, records) {
  const codeFiles = stagedFiles.filter(isCodePath);
  if (codeFiles.length === 0) return null;
  const active = records.filter((r) => {
    if (recordRefusal(r) !== null) return false;
    const phase = derivePhase(r.events ?? []);
    return phase !== "done" && PHASE_ORDER.indexOf(phase) >= PHASE_ORDER.indexOf("executing");
  });
  if (active.length > 0) return null;
  return { codeFiles };
}

/** Pure: base resolution order — explicit argument, then local config, then the COMMITTED
 *  adoption base (`.stallion-base`, the one thing a CI clone can read, which is what makes the
 *  first push of a branch auditable), then the current branch's remote-tracking ref (a local
 *  convenience; CI checkouts are detached). null means unresolvable, and the caller REFUSES:
 *  the fence must never fail open on a first push.
 */
export function pickBase(explicit, config, committed, originCurrent) {
  if (explicit) return explicit;
  if (config) return config;
  if (committed) return committed;
  return originCurrent ?? null;
}

/** Pure: did the adoption base file change INSIDE the range it is about to judge? A baseline
 *  rewritten by the commits under audit is the smuggle: refuse it (an adversarial finding). */
export function baseMovedInRange(fileAtRangeStart, fileAtHead) {
  if (fileAtRangeStart === null || fileAtHead === null) return false;
  return fileAtRangeStart.trim() !== fileAtHead.trim();
}

/**
 * Pure: the moved-base law. A base move is audited EXACTLY ONCE, FROM THE OLD BASE — the
 * remote tip's copy of .stallion-base. null = this push may proceed; "old-base" = the move is
 * not being judged from the old base (no explicit base was supplied, or the supplied one is
 * not the old value). With no remote-tip anchor there is no accusation (visible skip, never a
 * silent brick: the base-commit fallback anchored on a commit that always predates the move).
 */
export function movedBaseVerdict(explicitBase, remoteTipBase, headBase) {
  if (remoteTipBase === null) return null;
  if (headBase === null) return "old-base"; // deleting the anchor is a move — never exempt
  if (!baseMovedInRange(remoteTipBase, headBase)) return null;
  if (typeof explicitBase === "string" && explicitBase.trim() === remoteTipBase.trim()) return null;
  return "old-base";
}

/**
 * Pure: lane count via the ENFORCEMENT parser — the doctor must never re-implement the format
 * (an adversarial finding: two dialects of one law drift apart silently).
 */
export function checklistLaneCount(text) {
  return typeof text === "string" ? lanesFromChecklist(text).length : 0;
}

/** Pure: a live (non-comment) line actually INVOKES task-coverage in the given MODE — the
 *  invocation must start the command (an `echo` mentioning the tool wires nothing), and the
 *  doctor must not certify itself (an adversarial finding: its own step line satisfied the
 *  CI-fence check, and a --staged-only hook passed as a pre-push fence). */
export function invokesMode(text, mode) {
  if (typeof text !== "string") return false;
  return text.split("\n").some((l) => {
    let t = l.trim();
    if (t.length === 0 || t.startsWith("#")) return false;
    t = t.replace(/^run:\s*/, "").replace(/^sh\s+-c\s+['"]/, "").replace(/'\s*$/, "");
    if (!/^node\s+tools\/task-coverage\.mjs(\s|$)/.test(t)) return false;
    // A hook that swallows the tool's verdict wires nothing, whatever mode it names — the
    // doctor must not certify its own decoy (an adversarial finding: '|| exit 0' and
    // '|| true' both passed every wiring check). '|| exit 2' (the Claude Code translation)
    // is a BLOCKING outcome and stays certified.
    if (/\|\|\s*(?:true|:|exit\s+0)\b/.test(t)) return false;
    const doctor = t.includes("--doctor");
    const staged = t.includes("--staged");
    const commitMsg = t.includes("--commit-msg");
    if (mode === "doctor") return doctor;
    if (mode === "staged") return staged && !doctor;
    // The commit-msg hook's ARGUMENT is the validated surface: git hands the message file as
    // $1, and a decoy path (a committed file with a compliant footer) certifies nothing.
    if (mode === "commit-msg") return commitMsg && !doctor && !staged && /\$1/.test(t);
    return !doctor && !staged && !commitMsg; // "fence": the bare range check, with or without --base
  });
}

/** Pure: count '## ' entry headings in the decisions register. */
export function registerHeadingCount(text) {
  return typeof text === "string" ? text.split("\n").filter((l) => l.startsWith("## ")).length : 0;
}

/**
 * Pure: the `task: <id>` footer — TRAILER-ANCHORED: only in the message's final trailer block, so a
 * quoted example or pasted log in the body cannot authorize a commit .
 */
export function taskFooterOf(message) {
  const trimmed = message.replace(/\s+$/, "");
  const lastParagraph = trimmed.split(/\n\s*\n/).pop() ?? "";
  if (!/^([\w-]+: .*\n?)+$/.test(lastParagraph)) return null;
  const m = /(?:^|\n)task: ([a-z0-9][a-z0-9-]*)\s*$/.exec(lastParagraph);
  return m ? m[1] : null;
}

/** One segment of a scope glob → one regex: `*` and `?` stay inside the segment, every other
 *  metacharacter is literal. Cached — fences and gates match many paths against few patterns. */
const segmentRegexCache = new Map();
function segmentRegExp(segment) {
  if (!segmentRegexCache.has(segment)) {
    const source = segment
      .replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" || ch === "?" ? ch : `\\${ch}`))
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
    segmentRegexCache.set(segment, new RegExp(`^${source}$`));
  }
  return segmentRegexCache.get(segment);
}

function segmentsMatch(patternSegs, pathSegs) {
  if (patternSegs.length === 0) return pathSegs.length === 0;
  const [head, ...rest] = patternSegs;
  if (head === "**") {
    // a whole `**` segment swallows zero or more path segments: tools/** covers tools/ itself
    for (let take = 0; take <= pathSegs.length; take += 1) {
      if (segmentsMatch(rest, pathSegs.slice(take))) return true;
    }
    return false;
  }
  if (pathSegs.length === 0) return false;
  return segmentRegExp(head).test(pathSegs[0]) && segmentsMatch(rest, pathSegs.slice(1));
}

/**
 * Pure: the scope glob dialect — repo-relative, whole-path matching (`tools/**` any depth,
 * `tools/*` one segment, `?` one char). ONE dialect for the commit-msg gate and the push fence:
 * the binding law cannot drift between the two transports that enforce it. No patterns match
 * nothing — a garbage pattern in a hand-edited record refuses code, never authorizes it.
 */
export function pathInScope(path, patterns) {
  if (typeof path !== "string" || !Array.isArray(patterns)) return false;
  const pathSegs = path.split("/");
  return patterns.some((p) => typeof p === "string" && segmentsMatch(p.split("/"), pathSegs));
}

/**
 * Pure: is this record excused from the scope law as genuinely pre-cutover? The timestamp is
 * client-authored plain JSON, so it is PARSED, not trusted lexicographically — an undated,
 * malformed, or offset-spelled stamp is NOT grandfathered (fail closed: the forge case is the
 * case that must not escape). Only a parseable instant strictly before the cutover excuses.
 */
export function isGrandfatheredScope(record) {
  const created = recordCreatedAt(record);
  // Strict UTC ISO form only: V8's lenient parser makes "0000" a valid year zero, so shape is
  // checked before parsing — real stamps come from toISOString() and always match.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(created)) return false;
  const createdMs = Date.parse(created);
  return Number.isFinite(createdMs) && createdMs < Date.parse(SCOPE_LAW_CUTOVER);
}

/**
 * Pure: the scope law, shared verbatim by the commit-msg gate and the push fence (the
 * lanesFromChecklist discipline: the enforcement never re-implements the format). A task CREATED
 * after SCOPE_LAW_CUTOVER binds its code commits with a DECLARED blast radius: no usable scope,
 * or code outside it, refuses. The ADMISSION law (globRefusal) is re-applied on the judge path —
 * a hand-edited over-broad or malformed pattern matches NOTHING and the record fails closed, it
 * never authorizes. null = within the law; otherwise the reason names the files, the remedy the
 * exact command. The fence reads the record from the working tree at fence time (CI re-judges
 * from the pushed tree); a post-hoc widening is visible as a recorded amendment event in the
 * record's git history — in timestamped histories it trails the commit it excuses.
 */
export function scopeRefusal(record, codeFiles) {
  if (!Array.isArray(codeFiles) || codeFiles.length === 0) return null;
  if (isGrandfatheredScope(record)) return null;
  const declared = scopeOf(record);
  const patterns = declared.filter((p) => globRefusal(p) === null);
  const dropped = declared.length - patterns.length;
  if (patterns.length === 0) {
    const note = dropped > 0 ? ` (${dropped} recorded pattern(s) are malformed or over-broad and match nothing — fail closed)` : "";
    return {
      reason: `task '${record.id}' declares no usable scope${note} — a post-cutover task binds its code commits with declared blast radius, not a bearer footer`,
      remedy: `node tools/task-state.mjs scope ${record.id} --add "<glob>[,<glob>...]   (e.g. 'tools/**') — declare the blast radius the code will touch`,
    };
  }
  const outside = codeFiles.filter((f) => !pathInScope(f, patterns));
  if (outside.length > 0) {
    return {
      reason: `code outside task '${record.id}'s declared scope (${patterns.join(", ")}): ${outside.join(", ")}`,
      remedy: `widen the record (append-only, auditable): node tools/task-state.mjs scope ${record.id} --add "<the missing glob>"   — or move the change to the task that owns those files`,
    };
  }
  return null;
}

/**
 * Pure: the full citation law — one seam for the commit-msg gate and the push fence, so the two
 * transports cannot drift (an adversarial finding found exactly that drift shipped). For a NEW
 * commit, a finished task never authorizes code (the stale-done-master-key law the staged gate
 * already lives under). `isNewCommit` is the caller's transport fact: always true at commit-msg
 * time (the commit is being made NOW, against the working tree — deliberately the stricter
 * transport); at the fence it is judged against the SETTLED ANCHOR, the one input outside this
 * push, so a wave's own tail commits, written while the task was in flight, stay authorized
 * (see isNewCitation / anchorRecordPhase).
 */
export function citationRefusal(record, codeFiles, isNewCommit) {
  if (isNewCommit && derivePhase(record.events ?? []) === "done") {
    return {
      reason: `task '${record.id}' is done — a finished task does not authorize new code`,
      remedy: `node tools/task-state.mjs new <new-id> --risk-class ${record.riskClass}   (done is terminal by design)`,
    };
  }
  return scopeRefusal(record, codeFiles);
}

function classRefusal(record) {
  if (!RISK_CLASSES.includes(record.riskClass)) return `unknown risk class: ${String(record.riskClass)} (hand-forged records refuse, they do not pass)`;
  if (IMPLEMENTATION_FORBIDDEN.has(record.riskClass)) return `risk class '${record.riskClass}' is implementation-forbidden`;
  if (APPROVAL_REQUIRED.has(record.riskClass)) {
    const approval = record.events?.find((e) => e.type === "approval");
    if (!approval) return `risk class '${record.riskClass}' carries no owner approval event`;
    if (!decisionHeadingExists(approval.decision)) {
      return `approval cites no decisions-register entry heading: ${String(approval.decision)}`;
    }
  }
  return null;
}

function decisionHeadingExists(ref) {
  if (typeof ref !== "string" || ref.length === 0) return false;
  const path = `${ROOT}docs/decisions/DECISIONS.md`;
  if (!existsSync(path)) return false;
  return readFileSync(path, "utf8").split("\n").some((l) => l.startsWith("## ") && l.slice(3).trim() === ref.trim());
}

/**
 * Pure: does this record authorize implementation? Returns null when yes, the violated law when no.
 * Fail-closed: a malformed record refuses rather than passes.
 */
export function recordRefusal(record) {
  if (!record || typeof record !== "object") return "record is not an object";
  if (record.schema !== "stallion/task-state@1") return `unknown schema: ${String(record?.schema)}`;
  const classLaw = classRefusal(record);
  if (classLaw) return classLaw;
  if (record.riskClass === "docs-only") return "risk class 'docs-only' writes docs, not code — a code change needs a runtime-code/protected/migration task";
  // Defense in depth: a DONE record that predates no pin law and carries no valid pin/exemption
  // is a hand-edit or a forgery — refuse it at the fence. In-flight records are exempt: code
  // commits land at executing, before the pin exists by design (verified is where pins bind).
  // Records done before PIN_LAW_CUTOVER are grandfathered path-only evidence. The doneAt stamp
  // is client-authored plain JSON, so it is PARSED: a malformed or missing stamp is NOT
  // grandfathered (fail closed — the forge case is the case that must not escape).
  const phase = derivePhase(record.events ?? []);
  if (phase === "done" && !hasValidPin(record) && !hasPinExemption(record)) {
    const doneAt = [...(record.events ?? [])].reverse().find((e) => e.type === "transition" && e.to === "done")?.at ?? "";
    const doneMs = Date.parse(doneAt);
    if (!(Number.isFinite(doneMs) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(doneAt) && doneMs < Date.parse(PIN_LAW_CUTOVER))) {
      return "done record carries no valid command pin (and no recorded exemption) — hand-edited records refuse at the fence";
    }
  }
  // The chain law, re-judged here because a hand-edited record must not sail through on the
  // append-time check alone (the same defense-in-depth as pin parity): a post-cutover record
  // with a broken or missing chain is tampering or a laundering attempt, and refuses.
  if (recordMustChain(record) && chainError(record.events ?? [])) {
    return `record chain broken or unadopted (chain law in force since ${CHAIN_CUTOVER}) — tamper-evident records refuse at the fence`;
  }
  if (PHASE_ORDER.indexOf(phase) < PHASE_ORDER.indexOf("executing")) {
    return `task is '${phase}' — code landed before the machine authorized executing`;
  }
  return null;
}

function gitOut(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function revParseOk(rev) {
  try {
    execFileSync("git", ["rev-parse", "--verify", `${rev}^{commit}`], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitConfig(key) {
  try {
    return gitOut("config", "--get", key).trim() || null;
  } catch {
    return null;
  }
}

function currentBranch() {
  try {
    return gitOut("branch", "--show-current").trim();
  } catch {
    return "";
  }
}

/** The branch origin points at by default — the anchor for detached checkouts (CI), where
 *  branch --show-current is empty. */
function remoteHeadBranch() {
  try {
    const ref = gitOut("symbolic-ref", "--short", "refs/remotes/origin/HEAD").trim();
    return ref.startsWith("origin/") ? ref.slice("origin/".length) : "";
  } catch {
    return "";
  }
}

function rangeCount(base) {
  try {
    return Number(gitOut("rev-list", "--count", `${base}..HEAD`).trim());
  } catch {
    return -1; // a git failure is NOT an empty range — the caller must not coach a base change
  }
}

/** The committed content of a path (null when absent) — "committed" checks must read the tree
 *  git will serve to a fresh clone, not the working tree an adversarial pass caught certifying
 *  untracked hooks. */
function committedText(path) {
  try {
    return gitOut("show", `HEAD:${path}`);
  } catch {
    return null;
  }
}

function committedTextAt(rev, path) {
  try {
    return gitOut("show", `${rev}:${path}`);
  } catch {
    return null;
  }
}

/**
 * The committed adoption base — travels with the clone, so CI (which cannot read a developer's
 *  local git config) still resolves a real range on the very first push of a branch. Strictly
 *  validated: one full 40-hex commit sha, nothing clever.
 */
function committedBase() {
  const text = committedText(".stallion-base");
  if (text === null) return null;
  const value = text.trim();
  if (!/^[0-9a-f]{40}$/.test(value)) {
    die(`committed .stallion-base is malformed (expected one full 40-hex commit sha): ${JSON.stringify(value.slice(0, 60))}\n  fix: git rev-parse HEAD > .stallion-base   (full sha, one line) then commit it`);
  }
  return value;
}

function loadRecord(id) {
  const path = `${STATE_DIR}/${id}.json`;
  if (!existsSync(path)) return { error: `no task record for '${id}' (expected ${path})` };
  try {
    return { record: JSON.parse(readFileSync(path, "utf8")) };
  } catch (e) {
    return { error: `task record '${id}' is not valid JSON: ${e.message}` };
  }
}

/**
 * Pure: does this citation need to answer the done-law? The record's phase comes from the
 * working tree; the ANCHOR PHASE is what the settled audit anchor (the explicit base, or
 * origin/<branch> — the one input outside this push) knew about the task; `commitSettled` says
 * the citing commit is at-or-behind the anchor (re-audited settled history, never accused).
 * A task the anchor already showed as DONE is finished settled work: a citing commit new since
 * that anchor is posthumous and refuses. A task first-landing at the anchor (or in flight
 * there) is landing in THIS push — its tail commits were written in flight and stay
 * authorized. No anchor skips the law (never a brick); an unreadable anchor copy fails closed.
 */
export function isNewCitation(recordPhase, anchorPhase, commitSettled) {
  if (recordPhase !== "done") return true;
  if (commitSettled) return false;
  if (anchorPhase === "settled-done" || anchorPhase === "unreadable") return true;
  return false; // first-landing, in-flight-there, no-anchor
}

/**
 * The task's phase as the settled audit anchor knows it. Presence is checked with ls-tree
 * (tree-only: survives shallow clones, where blobs of included trees are always present);
 * content is read with one git show. Never pickaxe — byte-coupled detectors break on
 * serialization (an adversarial finding proved the compact spelling matches nothing).
 */
function anchorRecordPhase(id, anchorRef) {
  if (!anchorRef) return "no-anchor";
  let listed;
  try {
    listed = gitOut("ls-tree", anchorRef, "--", `tasks/${id}.json`).trim();
  } catch {
    return "no-anchor";
  }
  if (listed === "") return "first-landing";
  try {
    const record = JSON.parse(gitOut("show", `${anchorRef}:tasks/${id}.json`));
    return derivePhase(record.events ?? []) === "done" ? "settled-done" : "in-flight-there";
  } catch {
    return "unreadable";
  }
}

/** The range check: every code commit in base..HEAD must carry an authorizing task footer. */
function checkRange(base, anchorRef = null) {
  const errors = [];
  const headSha = gitOut("rev-parse", "HEAD").trim();
  const commits = gitOut("rev-list", "--reverse", `${base}..HEAD`).trim().split("\n").filter(Boolean);
  const anchorPhaseCache = new Map();
  let anchorSkips = 0;
  for (const sha of commits) {
    // -m --first-parent: merges are diffed against their first parent. Plain `diff-tree -r` emits
    // NOTHING for a merge, which made every merge invisible — an evil merge could land code no
    // transport ever judged (an adversarial pass's CRITICAL, proven with a real
    // commit-tree merge). Fail-closed: a merge that introduces code vs its first parent carries a
    // footer like any other commit.
    const files = gitOut("diff-tree", "--no-commit-id", "--name-only", "-r", "-m", "--first-parent", sha).trim().split("\n").filter(Boolean);
    if (!files.some(isCodePath)) continue;
    const message = gitOut("log", "-1", "--format=%B", sha);
    const footer = taskFooterOf(message);
    const short = sha.slice(0, 8);
    if (!footer) {
      const fix = sha === headSha
        ? `git commit --amend --no-edit --trailer "task: <id>"`
        : `rebase to add the footer to ${short} (git rebase -i ${base}) or drop the code change — amend cannot reach a non-HEAD commit`;
      errors.push(`${short} touches code but carries no 'task: <id>' footer — future code is written only through the task-state lifecycle (task-state new)\n      fix: ${fix}`);
      continue;
    }
    const { record, error } = loadRecord(footer);
    if (error) { errors.push(`${short}: ${error}\n      fix: node tools/task-state.mjs new ${footer} --risk-class <class> && node tools/task-state.mjs advance ${footer} planned && node tools/task-state.mjs advance ${footer} executing`); continue; }
    const refusal = recordRefusal(record);
    if (refusal) { errors.push(`${short} (task ${footer}): ${refusal}`); continue; }
    // The binding half of issue #8, through the ONE citation seam the commit-msg gate also
    // lives behind. The done-law is judged against the SETTLED ANCHOR (the one input outside
    // this push): a task the anchor already showed done refuses new citing commits, while a
    // task first-landing or in flight there authorizes its own tail. Commits at-or-behind the
    // anchor are re-audited settled history and are never accused. The named task's DECLARED
    // scope must cover every code file either way.
    let isNew = true;
    if (derivePhase(record.events ?? []) === "done") {
      const settled = Boolean(anchorRef) && isAncestorOrSelf(sha, anchorRef);
      const anchorPhase = anchorPhaseCache.get(footer) ?? anchorRecordPhase(footer, anchorRef);
      anchorPhaseCache.set(footer, anchorPhase);
      if (anchorPhase === "no-anchor" && !anchorRef) anchorSkips += 1;
      isNew = isNewCitation("done", anchorPhase, settled);
      if (anchorPhase === "unreadable" && !settled) {
        errors.push(`${short} (task ${footer}): the audit anchor's copy of the record is unreadable — a gate that cannot read state must not pass`);
        continue;
      }
    }
    const citation = citationRefusal(record, files.filter(isCodePath), isNew);
    if (citation) { errors.push(`${short} (task ${footer}): ${citation.reason}\n      fix: ${citation.remedy}`); continue; }
  }
  if (anchorSkips > 0) console.log(`task-coverage: ~ done-citation law skipped for ${anchorSkips} citing commit(s) — no audit anchor resolvable (detached clone, no origin/<branch>); skip, never brick`);
  return errors;
}

function die(message) {
  console.error(`task-coverage: ${message}`);
  process.exit(1);
}

/**
 * The inner gate: code staged but no task at executing-or-later refuses BEFORE the commit is
 * made. Wire as a pre-commit hook, or as a Claude Code PreToolUse hook on Bash(git commit*) —
 * with the exit-code translation that vendor's contract requires (see docs/WIRING.md).
 */
function cmdStaged() {
  let staged;
  try {
    staged = gitOut("diff", "--cached", "--name-only");
  } catch (e) {
    die(`cannot read the staged file list — git diff --cached failed (${String(e.message).split("\n")[0]})\n  rule: a gate that cannot read state must not pass — this seam fails closed like every other\n  fix: make git work in this environment (PATH, safe.directory, readable index), then retry the commit`);
  }
  const files = staged.trim().split("\n").filter(Boolean);
  const records = [];
  if (existsSync(STATE_DIR)) {
    for (const f of readdirSync(STATE_DIR).filter((x) => x.endsWith(".json") && !x.includes(".findings."))) {
      try {
        records.push(JSON.parse(readFileSync(`${STATE_DIR}/${f}`, "utf8")));
      } catch {
        // a malformed record cannot authorize anything — it simply is not an active task
      }
    }
  }
  const refusal = stagedRefusal(files, records);
  if (!refusal) {
    const stagedCode = files.filter(isCodePath).length;
    return console.log(stagedCode === 0
      ? "task-coverage (staged): no code files staged."
      : `task-coverage (staged): ${stagedCode} code file(s) staged while a task is in flight (executing/verified/adversarial).`);
  }
  console.error(`task-coverage: ✖ REFUSED — code is staged but no task is in flight (executing/verified/adversarial)`);
  console.error(`  rule: implementation happens only under a task the machine has authorized`);
  console.error(`  evidence: ${refusal.codeFiles.join(", ")}`);
  die(`  fix: node tools/task-state.mjs new <id> --risk-class runtime-code && node tools/task-state.mjs advance <id> planned && node tools/task-state.mjs advance <id> executing\n      (existing tasks: node tools/task-state.mjs status)`);
}

/** Secret/`debugger` patterns for the staged scan (ECC's pre-bash-commit-quality, adapted):
 *  literal shapes first (prefixes are structural), then a narrow key=value shape with a
 *  placeholder whitelist — a scan that fires on "your_api_key_here" is a scan people disable. */
const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/, "Anthropic API key"],
  [/ghp_[A-Za-z0-9]{30,}/, "GitHub PAT"],
  [/gho_[A-Za-z0-9]{30,}/, "GitHub OAuth token"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key id"],
  [/sk-[A-Za-z0-9]{20,}/, "generic API key"],
];
/** Placeholder BODIES (the part after the structural prefix): the whitelist an adversarial
 *  pass proved was dead code in its ^-over-m[0] form — no placeholder is a prefix of sk-ant-.
 *  The body test makes redacted fixtures (sk-ant-XXXX…) pass while real keys refuse. */
const PLACEHOLDER_BODY = /^(?:[xX0*]{4,}|your|example|test|dummy|sample|changeme|redacted|placeholder|<[^>]*>|\$\{)/;

/**
 * Pure: scan ADDED diff lines for secrets and stray debugger statements. Returns null when
 * clean, or { reason } naming file, line, and what matched — the refusal an agent can act on.
 */
export function stagedScanRefusal(addedLines) {
  for (const { file, line, text } of addedLines ?? []) {
    for (const [pattern, name] of SECRET_PATTERNS) {
      const m = pattern.exec(text);
      const body = m ? m[0].replace(/^(?:sk-ant-|ghp_|gho_|AKIA|sk-)/i, "") : "";
      if (m && !PLACEHOLDER_BODY.test(body)) {
        return { reason: `staged content carries a ${name} at ${file}:${line} — secrets do not land in git; rotate the key and read it from the environment` };
      }
    }
    if (/^\s*debugger;?\s*$/.test(text)) {
      return { reason: `staged content carries a debugger statement at ${file}:${line} — remove it before committing` };
    }
  }
  return null;
}

/** Added diff lines as {file, line, text}, tracking hunk headers — the scan's input.
 *  Exported: an adversarial pass caught the doubles-without-adapter gap (the pure scan was
 *  pinned while the parser that feeds it had no test callers at all). */
export function addedDiffLines(diffText) {
  const out = [];
  let file = "";
  let line = 0;
  for (const raw of String(diffText ?? "").split("\n")) {
    const m = /^diff --git a\/(.*) b\/(.*)$/.exec(raw);
    if (m) { file = m[2]; continue; }
    const h = /^@@ -(?:\d+)(?:,\d+)? \+(\d+)/.exec(raw);
    if (h) { line = Number(h[1]); continue; }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      out.push({ file, line, text: raw.slice(1) });
      line += 1;
    } else if (!raw.startsWith("-")) {
      line += 1;
    }
  }
  return out;
}

/**
 * The binding gate (issue #8): at commit-msg time the `task:` footer must name a REAL, IN-FLIGHT
 * task whose DECLARED scope covers the staged code. The refusal lands within one action of the
 * mistake; the push fence re-judges the same law from the pushed tree (a local hook is a
 * convenience — the fence is the control). Wire as a commit-msg hook:
 *   node tools/task-coverage.mjs --commit-msg "$1"
 */
function cmdCommitMsg(messageFile) {
  if (typeof messageFile !== "string" || messageFile.length === 0) {
    die(`--commit-msg requires the message file git passes the hook (usage: --commit-msg <file>, hook form: node tools/task-coverage.mjs --commit-msg "$1")`);
  }
  if (!existsSync(messageFile) && !existsSync(`${ROOT}${messageFile.replace(/^\//, "")}`)) {
    die(`cannot read the commit message file: ${messageFile}\n  rule: a gate that cannot read state must not pass\n  fix: this runs as a commit-msg hook — check core.hooksPath (.githooks) and that the hook passes "$1" through`);
  }
  const message = readFileSync(existsSync(messageFile) ? messageFile : `${ROOT}${messageFile.replace(/^\//, "")}`, "utf8");
  let staged;
  try {
    staged = gitOut("diff", "--cached", "--name-only");
  } catch (e) {
    die(`cannot read the staged file list — git diff --cached failed (${String(e.message).split("\n")[0]})\n  rule: a gate that cannot read state must not pass\n  fix: make git work in this environment (PATH, safe.directory, readable index), then retry the commit`);
  }
  const files = staged.trim().split("\n").filter(Boolean);
  const codeFiles = files.filter(isCodePath);
  const footer = taskFooterOf(message);
  if (!footer) {
    if (codeFiles.length === 0) return console.log("task-coverage (commit-msg): no code staged — no task footer required.");
    const sample = codeFiles.slice(0, 3).join(", ") + (codeFiles.length > 3 ? ", …" : "");
    die(`✖ REFUSED — this commit stages code (${codeFiles.length} file(s): ${sample}) but the message carries no 'task: <id>' footer\n  rule: code lands only under a task this machine can name, within that task's declared scope\n  fix: git commit --amend --trailer "task: <id>"   (existing tasks: node tools/task-state.mjs status)`);
  }
  const { record, error } = loadRecord(footer);
  if (error) {
    die(`✖ REFUSED — ${error}\n  fix: node tools/task-state.mjs new ${footer} --risk-class <class> && node tools/task-state.mjs advance ${footer} planned && node tools/task-state.mjs advance ${footer} executing   (or fix the footer: git commit --amend --trailer "task: <real-id>")`);
  }
  const refusal = recordRefusal(record);
  if (refusal) die(`✖ REFUSED — task '${footer}' does not authorize this commit: ${refusal}`);
  const citation = citationRefusal(record, codeFiles, true);
  if (citation) die(`✖ REFUSED — ${citation.reason}\n  fix: ${citation.remedy}`);
  // The staged scan (ECC's pre-commit quality gate, adapted): the diff about to become history
  // is scanned for secrets and debugger statements — refusals name file and line.
  let cachedDiff = "";
  try {
    // Config-neutral on purpose: repo-local color.ui AND the more specific color.diff slot
    // both lace the output (a sweep proved color.ui=never alone does not override
    // color.diff=always); external diff drivers and textconv blank or rewrite it entirely.
    cachedDiff = gitOut("-c", "color.ui=never", "-c", "color.diff=never", "-c", "diff.noprefix=false", "-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--cached");
  } catch (e) {
    die(`cannot read the staged diff — git diff --cached failed (${String(e.message).split("\n")[0]})\n  rule: a gate that cannot read state must not pass`);
  }
  const scan = stagedScanRefusal(addedDiffLines(cachedDiff));
  if (scan) die(`✖ REFUSED — ${scan.reason}`);
  console.log(codeFiles.length === 0
    ? `task-coverage (commit-msg): footer cites in-flight task '${footer}' (no code staged).`
    : `task-coverage (commit-msg): ${codeFiles.length} code file(s) bound to in-flight task '${footer}' within its declared scope.`);
}

/**
 * The gate for the gate: prove the fence is WIRED in this clone, not just present in the repo.
 * Fail-closed on everything a clone can observe; the one clone-local setting CI cannot carry
 * (core.hooksPath) is scoped to local runs.
 */
function cmdDoctor() {
  const results = [];
  const check = (name, ok, fix) => results.push({ name, ok, fix });

  // Wiring checks read the COMMITTED tree and demand the right MODE per transport: the fence
  // for CI and pre-push, the staged gate for pre-commit — the doctor's own step line must not
  // be able to certify the doctor.
  const committedPrePush = committedText(".githooks/pre-push") ?? "";
  const committedPreCommit = committedText(".githooks/pre-commit") ?? "";
  const committedCommitMsg = committedText(".githooks/commit-msg") ?? "";
  check("pre-push hook committed and invoking the push fence", invokesMode(committedPrePush, "fence"), "commit .githooks/pre-push that runs 'node tools/task-coverage.mjs' (docs/WIRING.md)");
  check("pre-commit staged gate committed", invokesMode(committedPreCommit, "staged"), "commit .githooks/pre-commit that runs 'node tools/task-coverage.mjs --staged'");
  check("commit-msg binding gate committed", invokesMode(committedCommitMsg, "commit-msg"), "commit .githooks/commit-msg that runs 'node tools/task-coverage.mjs --commit-msg \"$1\"' (docs/WIRING.md)");

  // Activation is clone-local config CI cannot carry — scoped honestly instead of faked:
  // locally it is checked for real (and value-checked, not just set); in CI it is SKIPPED,
  // visibly, never silently passed.
  const hooksPath = gitConfig("core.hooksPath");
  if (process.env.CI === "true") {
    console.log("task-coverage doctor: ~ core.hooksPath activation — not observable in a CI clone (clone-local config); enforced by local doctor runs and the push fence");
  } else {
    const dir = hooksPath && hooksPath.startsWith("/") ? hooksPath.replace(/\/$/, "") : hooksPath ? `${ROOT}${hooksPath.replace(/^\//, "").replace(/\/$/, "")}` : null;
    const livePrePush = dir && existsSync(`${dir}/pre-push`) ? readFileSync(`${dir}/pre-push`, "utf8") : "";
    const livePreCommit = dir && existsSync(`${dir}/pre-commit`) ? readFileSync(`${dir}/pre-commit`, "utf8") : "";
    const liveCommitMsg = dir && existsSync(`${dir}/commit-msg`) ? readFileSync(`${dir}/commit-msg`, "utf8") : "";
    check("core.hooksPath points at a wired pre-push", invokesMode(livePrePush, "fence"), "git config core.hooksPath .githooks   (must point at the committed hooks)");
    check("core.hooksPath points at a wired pre-commit", invokesMode(livePreCommit, "staged"), "git config core.hooksPath .githooks");
    check("core.hooksPath points at a wired commit-msg", invokesMode(liveCommitMsg, "commit-msg"), "git config core.hooksPath .githooks");
  }

  const wfDir = `${ROOT}.github/workflows`;
  const committedWorkflows = (() => {
    try {
      return gitOut("ls-files", ".github/workflows").split("\n").filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    } catch {
      return existsSync(wfDir) ? readdirSync(wfDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")) : [];
    }
  })();
  let selftestScript = "";
  try {
    selftestScript = JSON.parse(committedText("package.json") ?? "{}")?.scripts?.selftest ?? "";
  } catch {
    selftestScript = "";
  }
  check("the selftest battery runs the intervention gate's own self-test", selftestScript.includes("task-gate.mjs --self-test"), "add 'node tools/task-gate.mjs --self-test' to the selftest SCRIPT in package.json — a string elsewhere in the file wires nothing");

  const ciOk = committedWorkflows.some((f) => invokesMode(committedText(f) ?? "", "fence"));
  check("CI re-runs the push fence", ciOk, "add a bare 'node tools/task-coverage.mjs' step to .github/workflows (docs/WIRING.md) and commit it");

  let tracked = "";
  try {
    tracked = gitOut("ls-files");
  } catch {
    // not a git repo — nothing is classified
  }
  const trackedFiles = tracked.split("\n").filter(Boolean);
  check("CODE_TREES/CODE_EXTS classify at least one tracked file", trackedFiles.some(isCodePath), trackedFiles.length > 0 ? "edit CODE_TREES/CODE_EXTS in tools/task-coverage.mjs to match this repo's layout — a gate matching nothing covers nothing" : "commit some files first");

  const branch = currentBranch();
  const originCurrent = branch && revParseOk(`origin/${branch}`) ? `origin/${branch}` : null;
  const configBase = gitConfig("stallion.push-base");
  const committedBaseValue = committedBase();
  const doctorBase = pickBase(null, configBase, committedBaseValue, originCurrent);
  const narrowing = configBase && committedBaseValue && configBase.trim() !== committedBaseValue && !isAncestorOrSelf(configBase, committedBaseValue);
  const baseSane = doctorBase !== null && revParseOk(doctorBase) && rangeCount(doctorBase) > 0 && !narrowing;
  check("push base resolves and fences a non-empty range (local overrides are widen-only)", baseSane, "git rev-parse HEAD > .stallion-base && git add .stallion-base && git commit   (an ancestor before HEAD; a base at HEAD audits nothing; a local config newer than the committed base narrows the fence and is refused)");

  const register = committedText("docs/decisions/DECISIONS.md") ?? "";
  check("decisions register exists with entry headings", registerHeadingCount(register) > 0, "create docs/decisions/DECISIONS.md with at least one '## ' entry heading");

  const checklist = committedText("docs/ADVERSARIAL-CHECKLIST.md") ?? "";
  check("adversarial checklist parses to exactly 8 lanes", checklistLaneCount(checklist) === 8, "keep exactly eight '### N. Title' escape-class headings (or change the runner's count pin deliberately)");

  let failed = 0;
  for (const r of results) {
    if (r.ok) console.log(`task-coverage doctor: ✔ ${r.name}`);
    else {
      failed += 1;
      console.error(`task-coverage doctor: ✖ ${r.name}`);
      console.error(`    fix: ${r.fix}`);
    }
  }
  if (failed > 0) die(`doctor: ${failed} check(s) failed — the fence is not fully wired; fixes printed above`);
  console.log("task-coverage doctor: all checks pass — the fence is wired end to end");
}

/**
 * Where the push range starts: --base, then the configured adoption base, then the current
 * branch's remote-tracking ref. Unresolvable REFUSES (never skip: the first push of a branch is
 * exactly when unreviewed history must not sail through).
 */
function resolvePushBase(explicit) {
  const branch = currentBranch();
  const originCurrent = branch && revParseOk(`origin/${branch}`) ? `origin/${branch}` : null;
  const config = gitConfig("stallion.push-base");
  const committed = committedBase();
  const base = pickBase(explicit, config, committed, originCurrent);
  if (!base) {
    die(`no resolvable push base — refusing rather than guessing a range\n  rule: a first push must not fail open\n  fix: git rev-parse HEAD > .stallion-base && git add .stallion-base && git commit   (committed — CI resolves from it)\n       or: git config stallion.push-base <rev>   (local override, widen-only)\n       or run with an explicit --base <rev>`);
  }
  // A local override may only WIDEN the audit: a config base newer than the committed base
  // narrows the fence below the repo's baseline, invisibly to any reviewer (an adversarial
  // finding). Advancing the base is a deliberate edit of the committed file, two-step.
  if (!explicit && config && committed && config.trim() !== committed && !isAncestorOrSelf(config, committed)) {
    die(`local stallion.push-base (${config.trim()}) narrows the fence below the committed adoption base (${committed.slice(0, 8)})\n  rule: local overrides widen the audit or match it — never shrink it\n  fix: git config --unset stallion.push-base, or pin the older base: git config stallion.push-base ${committed}\n       to ADVANCE the adoption base, edit the committed .stallion-base and push once with --base <old>`);
  }
  return base;
}

function isAncestorOrSelf(rev, maybeDescendant) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", rev, maybeDescendant], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Strict flags: --base and --commit-msg take values (both `--flag x` and `--flag=x`, non-empty);
 *  --staged, --doctor, and --commit-msg are exclusive modes (a silent winner masked the others);
 *  unknown flags refuse. */
function parseFlags(argv) {
  const flags = {};
  const seen = new Set();
  const once = (name) => {
    if (seen.has(name)) die(`--${name} given more than once — a repeated flag silently keeping the last value is the escape task-state's parser already refuses`);
    seen.add(name);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--self-test" || a === "--staged" || a === "--doctor") {
      once(a.slice(2));
      flags[a.slice(2)] = true;
      continue;
    }
    if (a === "--base" || a.startsWith("--base=") || a === "--commit-msg" || a.startsWith("--commit-msg=")) {
      const eq = a.indexOf("=");
      const inline = eq !== -1;
      const key = a.slice(2, eq === -1 ? undefined : eq);
      once(key);
      if (inline && a.slice(eq + 1).length === 0) die(`--${key} requires a non-empty value`);
      if (inline) { flags[key] = a.slice(eq + 1); continue; }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--") || next.length === 0) die(`--${key} requires a non-empty value (usage: [--base <rev>] [--staged] [--doctor] [--commit-msg <file>])`);
      flags[key] = next;
      i += 1;
      continue;
    }
    die(`unknown flag: ${a} — usage: task-coverage.mjs [--base <rev>] [--staged] [--doctor] [--commit-msg <file>] (--self-test to self-test)`);
  }
  const modes = [flags.staged && "staged", flags.doctor && "doctor", flags["commit-msg"] && "commit-msg"].filter(Boolean);
  if (modes.length > 1) die(`--${modes.join(" and --")} are separate invocations — running one silently would mask the other`);
  return flags;
}

/** Self-test: the refusals ARE the feature — every guard proven both directions. */
export function selfTest() {
  const failures = [];
  const fail = (m) => failures.push(m);
  const record = (riskClass, phases, extraEvents = []) => ({
    schema: "stallion/task-state@1",
    id: "t",
    riskClass,
    events: [
      { type: "created", at: "2026-09-17T00:00:00.000Z" },
      { type: "red-check", command: "npm test -- the-pin.test.ts", exitCode: 1, outputDigest: "abc" },
      ...phases.map((to) => ({ type: "transition", to })),
      ...extraEvents,
    ],
  });

  const codeCases = [
    ["apps source is code", isCodePath("apps/api/src/main.ts")],
    ["packages source is code", isCodePath("packages/db/src/schema.ts")],
    ["harness tools are code", isCodePath("tools/harness/task-state.mjs")],
    ["deploy scripts are code", isCodePath("deploy/push.sh")],
    ["web tsx is code", isCodePath("apps/web/src/routes/page.tsx")],
    ["docs are not code", !isCodePath("docs/README.md")],
    ["markdown under apps is not code", !isCodePath("apps/web/README.md")],
    ["json state is not code", !isCodePath("tasks/x.json")],
    ["root package.json is not code", !isCodePath("package.json")],
    ["generated artifacts are not code", !isCodePath("artifacts/graph.json")],
    [".mts is code", isCodePath("tools/dev/constants.d.mts")],
    [".css is code", isCodePath("apps/web/src/style.css")],
    ["Dockerfile is code", isCodePath("apps/api/Dockerfile")],
    ["deploy Caddyfile is code", isCodePath("deploy/Caddyfile")],
    ["sql is exempt by default", !isCodePath("db/migrations/0001_init.sql")],
    ["the adoption-base file is code (it IS the fence)", isCodePath(".stallion-base")],
    ["committed hooks are code (they ARE the fence)", isCodePath(".githooks/pre-push")],
    ["CI workflows are code (they carry the fence)", isCodePath(".github/workflows/selftest.yml")],
    ["docs under .github are not code", !isCodePath(".github/ISSUE_TEMPLATE.md")],
  ];
  for (const [name, passes] of codeCases) if (!passes) fail(`task-coverage: ${name}`);

  const footerCases = [
    ["own-line footer extracted", taskFooterOf("fix: x\n\ntask: my-task") === "my-task"],
    ["last-line footer extracted", taskFooterOf("fix: x\n\ntask: my-task\n") === "my-task"],
    ["mid-sentence 'task:' is not a footer", taskFooterOf("fix: the task: went nowhere") === null],
    ["missing footer is null", taskFooterOf("fix: x") === null],
    ["a quoted example in the body does not authorize", taskFooterOf("docs: explain the convention\n\nThe convention is:\n\n```\ntask: enforce-task-coverage\n```\n\nThat is all.") === null],
    ["non-kebab id rejected", taskFooterOf("fix: x\n\ntask: My_Task") === null],
  ];
  for (const [name, passes] of footerCases) if (!passes) fail(`task-coverage: ${name}`);

  const authCases = [
    ["executing runtime-code authorizes", recordRefusal(record("runtime-code", ["planned", "executing"])) === null],
    ["done authorizes", recordRefusal(record("runtime-code", ["planned", "executing", "verified", "adversarial", "done"])) === null],
    ["planning-only never authorizes", recordRefusal(record("planning-only", ["planned", "executing"])) !== null],
    ["intake does not authorize", recordRefusal(record("runtime-code", [])) !== null],
    ["planned does not authorize", recordRefusal(record("runtime-code", ["planned"])) !== null],
    ["protected without approval refused", recordRefusal(record("protected", ["planned", "executing"])) !== null],
    // A REAL decisions-register heading: the cross-check reads the live register, so the fixture cites it.
    ["protected with a real decision authorizes", recordRefusal(record("protected", ["planned", "executing"], [{ type: "approval", decision: "2026-01-15 — ADOPTION: this repository runs its code through the task lifecycle" }])) === null],
    ["protected with an invented decision refused", recordRefusal(record("protected", ["planned", "executing"], [{ type: "approval", decision: "2026-01-16 — I NEVER SAID THIS" }])) !== null],
    ["unknown risk class refused (hand-forged record)", recordRefusal(record("totally-made-up-class", ["planned", "executing"])) !== null],
    ["docs-only cannot authorize code", recordRefusal(record("docs-only", ["planned", "executing"])) !== null],
    ["a pin-less done record is refused at the fence (hand-edit parity)", recordRefusal({ schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created", at: "2026-09-17T00:00:00.000Z" }, { type: "transition", to: "planned" }, { type: "transition", to: "executing" }, { type: "transition", to: "verified" }, { type: "transition", to: "adversarial" }, { type: "transition", to: "done", at: "2026-09-19T00:00:00.000Z" }] }) !== null],
    ["a pin-less in-flight record passes the fence (pins bind at verified, commits land at executing)", recordRefusal({ schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created", at: "2026-09-17T00:00:00.000Z" }, { type: "transition", to: "planned" }, { type: "transition", to: "executing" }] }) === null],
    ["a pre-cutover done record is grandfathered at the fence", recordRefusal({ schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created", at: "2026-09-17T00:00:00.000Z" }, { type: "transition", to: "planned" }, { type: "transition", to: "executing" }, { type: "transition", to: "verified" }, { type: "transition", to: "adversarial" }, { type: "transition", to: "done", at: "2026-09-18T15:00:00.000Z" }] }) === null],
    ["a post-chain-cutover record with a broken chain refuses at the fence", recordRefusal({ schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created", at: "2026-09-19T03:00:00.000Z", type2: "created" }, { type: "transition", to: "planned" }, { type: "transition", to: "executing" }] }) !== null],
    ["a post-chain-cutover record with an intact chain passes the fence chain law", (() => {
      const stamped = chainStampEvents([{ type: "created", at: "2026-09-19T03:00:00.000Z" }, { type: "transition", to: "planned", at: "2026-09-19T03:00:01.000Z" }, { type: "transition", to: "executing", at: "2026-09-19T03:00:02.000Z" }]);
      return recordRefusal({ schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: stamped }) === null;
    })()],
    ["a pre-chain-cutover record stays chain-grandfathered at the fence", recordRefusal({ schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created", at: "2026-09-18T12:00:00.000Z" }, { type: "transition", to: "planned" }, { type: "transition", to: "executing" }] }) === null],
    ["malformed record refused", recordRefusal(null) !== null],
    ["wrong schema refused", recordRefusal({ schema: "nope" }) !== null],
  ];
  for (const [name, passes] of authCases) if (!passes) fail(`task-coverage: ${name}`);

  const stagedCases = [
    ["no code staged passes", stagedRefusal(["docs/x.md", "package.json"], [record("runtime-code", [])]) === null],
    ["code staged with an executing task passes", stagedRefusal(["apps/a.ts"], [record("runtime-code", ["planned", "executing"])]) === null],
    ["code staged with no tasks refuses and lists the code files", stagedRefusal(["apps/a.ts", "docs/x.md"], []).codeFiles?.length === 1],
    ["code staged under a planning-only task still refuses", stagedRefusal(["tools/x.mjs"], [record("planning-only", ["planned", "executing"])]) !== null],
    ["a done task does not keep the staged gate open", stagedRefusal(["apps/a.ts"], [record("runtime-code", ["planned", "executing", "verified", "adversarial", "done"])]) !== null],
    ["a docs-only task does not keep the staged gate open", stagedRefusal(["apps/a.ts"], [record("docs-only", ["planned", "executing"])]) !== null],
  ];
  for (const [name, passes] of stagedCases) if (!passes) fail(`task-coverage: ${name}`);

  const doctorCases = [
    ["lane count delegates to the enforcement parser", checklistLaneCount("### 1. A\nbody\n### 2. B\nbody") === 2],
    ["the fence detector matches a bare range-check step", invokesMode("      run: node tools/task-coverage.mjs --base \"$BASE\"", "fence")],
    ["the doctor's own step does not certify the fence", !invokesMode("      run: node tools/task-coverage.mjs --doctor", "fence")],
    ["an echo line mentioning the tool wires nothing", !invokesMode("      run: echo node tools/task-coverage.mjs\n", "fence")],
    ["a sh -c wrapped staged hook certifies staged (Claude Code form)", invokesMode("sh -c 'node tools/task-coverage.mjs --staged || exit 2'", "staged")],
    ["a --staged-only hook does not certify the fence", !invokesMode("#!/bin/sh\nnode tools/task-coverage.mjs --staged || exit 1\n", "fence")],
    ["the staged detector requires --staged on a live line", invokesMode("#!/bin/sh\nnode tools/task-coverage.mjs --staged || exit 1\n", "staged")],
    ["a commented-out pre-commit hook wires nothing", !invokesMode("#!/bin/sh\n# node tools/task-coverage.mjs --staged\nexit 0\n", "staged")],
    ["register heading counter counts '## ' only", registerHeadingCount("## A\n### a\n## B") === 2],
  ];
  for (const [name, passes] of doctorCases) if (!passes) fail(`task-coverage: ${name}`);

  const baseCases = [
    ["explicit base wins over everything", pickBase("HEAD~1", "cfg", "sha-c", "origin/x") === "HEAD~1"],
    ["local config overrides the committed adoption base", pickBase(null, "cfg", "sha-c", "origin/x") === "cfg"],
    ["the committed adoption base beats origin tracking", pickBase(null, null, "sha-c", "origin/x") === "sha-c"],
    ["origin tracking is the last fallback", pickBase(null, null, null, "origin/main") === "origin/main"],
    ["nothing resolvable is null (fail closed, never skip)", pickBase(null, null, null, null) === null],
    ["an adoption base moved inside the audited range is flagged", baseMovedInRange("aaa\n", "bbb\n")],
    ["an unchanged adoption base passes", !baseMovedInRange("aaa\n", "aaa\n")],
    ["a base file absent at range start passes (first adoption)", !baseMovedInRange(null, "aaa\n")],
    ["an unmoved base needs no old-base audit", movedBaseVerdict(null, "old\n", "old\n") === null],
    ["a moved base audited from the OLD base passes", movedBaseVerdict("old", "old\n", "new\n") === null],
    ["a moved base audited from the NEW base is refused", movedBaseVerdict("new", "old\n", "new\n") === "old-base"],
    ["a moved base with no explicit base is refused", movedBaseVerdict(null, "old\n", "new\n") === "old-base"],
    ["no anchor, no accusation (detached clones skip visibly)", movedBaseVerdict(null, null, "new\n") === null],
    ["deleting the anchor is a move, never exempt", movedBaseVerdict(null, "old\n", null) === "old-base"],
    ["a short-sha spelling of the old base is refused (byte equality)", movedBaseVerdict("abc123", "abc123def456\n", "new\n") === "old-base"],
  ];
  for (const [name, passes] of baseCases) if (!passes) fail(`task-coverage: ${name}`);

  const scopedPost = { schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created", at: "2026-09-19T00:00:00.000Z" }, { type: "scope", patterns: ["tools/**", ".githooks/*"] }] };
  const unscopedPost = { schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created", at: "2026-09-19T00:00:00.000Z" }, { type: "transition", to: "executing" }] };
  const unscopedPre = { schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created", at: "2026-09-18T12:00:00.000Z" }, { type: "transition", to: "executing" }] };
  const globCases = [
    ["a tree glob matches at any depth", pathInScope("tools/a/b/c.mjs", ["tools/**"])],
    ["a star matches one segment", pathInScope("tools/a.mjs", ["tools/*"])],
    ["a star stays inside one segment", !pathInScope("tools/a/b.mjs", ["tools/*"])],
    ["a literal segment matches exactly", pathInScope("package.json", ["package.json"])],
    ["a double-star segment matches zero segments", pathInScope("docs/x.md", ["docs/**/x.md"])],
    ["a double-star segment matches many segments", pathInScope("docs/a/b/x.md", ["docs/**/x.md"])],
    ["? matches exactly one non-separator char", pathInScope("tools/a1.mjs", ["tools/a?.mjs"]) && !pathInScope("tools/a12.mjs", ["tools/a?.mjs"])],
    ["regex metacharacters in a pattern are literal", pathInScope("tools/a.b.mjs", ["tools/a.b.mjs"]) && !pathInScope("tools/axb.mjs", ["tools/a.b.mjs"])],
    ["no scope means nothing matches (fail closed)", !pathInScope("tools/a.mjs", [])],
    ["a path outside every pattern refuses", !pathInScope("apps/x.ts", ["tools/**", ".githooks/*"])],
  ];
  for (const [name, passes] of globCases) if (!passes) fail(`task-coverage: ${name}`);

  const scopeCases = [
    ["a post-cutover task with covering scope passes", scopeRefusal(scopedPost, ["tools/a.mjs", ".githooks/pre-commit"]) === null],
    ["a post-cutover task with no declared scope refuses", scopeRefusal(unscopedPost, ["tools/a.mjs"]) !== null],
    ["code outside the declared scope refuses", scopeRefusal(scopedPost, ["apps/x.ts"]) !== null],
    ["the outside-scope refusal names the offending files", scopeRefusal(scopedPost, ["apps/x.ts", "packages/y.js"]).reason.includes("apps/x.ts")],
    ["no code files means no scope question", scopeRefusal(unscopedPost, []) === null],
    ["a pre-cutover task is grandfathered without scope", scopeRefusal(unscopedPre, ["tools/a.mjs", "apps/x.ts"]) === null],
    ["the no-scope refusal carries the exact fix command", scopeRefusal(unscopedPost, ["tools/a.mjs"]).remedy?.includes("scope t --add")],
    ["the outside-scope refusal carries the amendment fix", scopeRefusal(scopedPost, ["apps/x.ts"]).remedy?.includes("scope t --add")],
    ["an UNDATED record is NOT grandfathered (fail closed)", !isGrandfatheredScope({ events: [{ type: "created" }] })],
    ["a malformed timestamp is NOT grandfathered (fail closed)", !isGrandfatheredScope({ events: [{ type: "created", at: "0000" }] })],
    ["an offset-spelled post-cutover instant is NOT grandfathered", !isGrandfatheredScope({ events: [{ type: "created", at: "2026-09-18T19:00:00.000-05:00" }] })],
    ["a parseable pre-cutover instant IS grandfathered", isGrandfatheredScope(unscopedPre)],
    ["a hand-edited everything-pattern matches nothing and fails closed", scopeRefusal({ ...unscopedPost, events: [{ type: "created", at: "2026-09-19T00:00:00.000Z" }, { type: "scope", patterns: ["**"] }] }, ["tools/a.mjs"]).reason.includes("no usable scope")],
    ["a record mixing good and malformed patterns keeps only the good", scopeRefusal({ ...unscopedPost, events: [{ type: "created", at: "2026-09-19T00:00:00.000Z" }, { type: "scope", patterns: ["**", "tools/**"] }] }, ["tools/a.mjs"]) === null],
  ];
  for (const [name, passes] of scopeCases) if (!passes) fail(`task-coverage: ${name}`);

  const citationCases = [
    ["a NEW commit citing a done task refuses at the seam", (() => {
      const donePost = { ...unscopedPost, events: [...unscopedPost.events, { type: "transition", to: "verified" }, { type: "transition", to: "adversarial" }, { type: "transition", to: "done" }] };
      return citationRefusal(donePost, ["tools/a.mjs"], true) !== null && citationRefusal(donePost, ["tools/a.mjs"], true).remedy?.includes("new <new-id>");
    })()],
    ["re-judged settled history citing a done task falls through to the scope law", citationRefusal(unscopedPre, ["tools/a.mjs"], false) === null],
    ["a new commit citing an in-flight scoped task passes the seam", citationRefusal(scopedPost, ["tools/a.mjs"], false) === null && citationRefusal({ ...scopedPost, events: [...scopedPost.events, { type: "transition", to: "executing" }] }, ["tools/a.mjs"], true) === null],
    ["a malformed doneAt stamp does not grandfather the pin law", recordRefusal({ schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created", at: "2026-09-17T00:00:00.000Z" }, { type: "transition", to: "planned" }, { type: "transition", to: "executing" }, { type: "transition", to: "verified" }, { type: "transition", to: "adversarial" }, { type: "transition", to: "done", at: "not-a-date" }] }) !== null],
  ];
  for (const [name, passes] of citationCases) if (!passes) fail(`task-coverage: ${name}`);

  const anchorCases = [
    ["a task settled-done at the anchor refuses a commit new since that anchor", isNewCitation("done", "settled-done", false) === true],
    ["a task first-landing at the anchor authorizes its own tail commits", isNewCitation("done", "first-landing", false) === false],
    ["a task in flight at the anchor authorizes its finishing push", isNewCitation("done", "in-flight-there", false) === false],
    ["no anchor skips the done-law rather than bricking", isNewCitation("done", "no-anchor", false) === false],
    ["an unreadable anchor copy fails closed", isNewCitation("done", "unreadable", false) === true],
    ["a commit already settled at the anchor is re-audited, never accused", isNewCitation("done", "settled-done", true) === false],
    ["an in-flight record never trips the done-law", isNewCitation("executing", "settled-done", false) === true],
    ["an adversarial-phase record never trips the done-law", isNewCitation("adversarial", "first-landing", false) === true],
  ];
  for (const [name, passes] of anchorCases) if (!passes) fail(`task-coverage: ${name}`);

  const scanCases = [
    ["a staged Anthropic key refuses with file and line", stagedScanRefusal([{ file: "apps/api/k.ts", line: 3, text: `const k = "${["sk", "ant"].join("-")}-0123456789abcdef0123"` }])?.reason.includes("apps/api/k.ts:3")],
    ["a placeholder key passes", stagedScanRefusal([{ file: "a.ts", line: 1, text: 'const k = "your_api_key_here_xxxxxxxxxxxxx"' }]) === null],
    ["a debugger statement refuses", stagedScanRefusal([{ file: "a.ts", line: 9, text: "  debugger;" }]) !== null],
    ["ordinary code passes", stagedScanRefusal([{ file: "a.ts", line: 1, text: "const x = 1;" }]) === null],
    ["a short sk- word is not a key", stagedScanRefusal([{ file: "a.ts", line: 1, text: "const sk = ski trip" }]) === null],
    ["a REDACTED structural key passes (the body whitelist works)", stagedScanRefusal([{ file: "docs/runbook.md", line: 4, text: "set KEY=sk-ant-XXXXXXXXXXXXXXXXXXXX" }]) === null],
    ["a real key after a placeholder-shaped prefix still refuses", stagedScanRefusal([{ file: "a.ts", line: 2, text: `k = "${["sk", "ant"].join("-")}-real0123456789abcdef"` }]) !== null],
    ["the adapter parses a real diff shape: file, hunk header, added lines counted", (() => {
      const parsed = addedDiffLines([
        "diff --git a/apps/api/k.ts b/apps/api/k.ts",
        "index 111..222 100644",
        "--- a/apps/api/k.ts",
        "+++ b/apps/api/k.ts",
        "@@ -10,3 +10,4 @@ context()",
        " unchanged line",
        "-removed line",
        "+const keep = 1;",
        "+const bad = 2; // carries the scan target",
        "+another added",
      ].join("\n"));
      return parsed.length === 3 && parsed[0].file === "apps/api/k.ts" && parsed[0].line === 11 && parsed[2].line === 13;
    })()],
  ];
  for (const [name, passes] of scanCases) if (!passes) fail(`task-coverage: ${name}`);

  const bannerCounts = `${codeCases.length} path + ${footerCases.length} footer + ${authCases.length} authorization + ${stagedCases.length} staged + ${doctorCases.length} doctor + ${baseCases.length} base + ${globCases.length} glob + ${scopeCases.length} scope + ${citationCases.length} citation + ${anchorCases.length} anchor + ${scanCases.length} scan cases — all counts derived`;
  console.log(failures.length === 0 ? `task-coverage self-test: OK (${bannerCounts} — group counts derived where arrays are local)` : `task-coverage self-test: FAILED\n  ${failures.join("\n  ")}`);
  return failures.length === 0;
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isEntry) {
  const flags = parseFlags(process.argv.slice(2));
  if (flags["self-test"]) process.exit(selfTest() ? 0 : 1);
  if (flags["commit-msg"]) { cmdCommitMsg(flags["commit-msg"]); process.exit(0); }
  if (flags.staged) { cmdStaged(); process.exit(0); }
  if (flags.doctor) { cmdDoctor(); process.exit(0); }
  const base = resolvePushBase(flags.base ?? null);
  if (!revParseOk(base)) {
    die(`base revision does not resolve: ${base}\n  fix: pass --base <rev>, or update the committed adoption base: git rev-parse <rev> > .stallion-base && git commit\n       (a fresh repo with one commit has no parent to diff against — pin the adoption base explicitly)`);
  }
  const count = rangeCount(base);
  if (count === -1) {
    die(`cannot count the range ${base}..HEAD — git rev-list failed\n  rule: a gate that cannot read state must not pass\n  fix: this is a git failure, not a configuration problem — check the repository (permissions, safe.directory, object store) and retry`);
  }
  if (count === 0) {
    die(`base ${base} fences an empty range — ${base}..HEAD contains no commits\n  rule: a range that audits nothing is not coverage (the vacuous-base escape, refused)\n  fix: pin the base to an ancestor before HEAD: git rev-parse <earlier-rev> > .stallion-base && git commit`);
  }
  // The moved-base law: a push that moves .stallion-base is judged exactly once, from the OLD
  // base (the remote tip's copy). Only an explicit base EQUAL to the old value skips the
  // refusal — a tier-wide exemption let config=NEW-base skip the audit entirely (an
  // adversarial replay proved the smuggle). With no anchor, skip visibly; never fall back to
  // the base-commit copy, which always predates the move and bricked detached clones forever.
  // The audit anchor — the settled remote tip (or the explicit base a CI fence step supplies):
  // the one input outside this push. It anchors BOTH the moved-base audit and the done-citation
  // law. No anchor = visible skips, never silent bricks.
  const guardBranch = [currentBranch(), remoteHeadBranch()].find((c) => c && revParseOk(`origin/${c}`))
    ?? [currentBranch(), remoteHeadBranch()].find(Boolean) ?? "";
  const originOk = revParseOk(`origin/${guardBranch}`);
  if (originOk) {
    const oldBaseRequired = movedBaseVerdict(flags.base ?? gitConfig("stallion.push-base"), committedTextAt(`origin/${guardBranch}`, ".stallion-base"), committedText(".stallion-base"));
    if (oldBaseRequired !== null) {
      die(`the adoption base moves in THIS push and is not being audited from the OLD base\n  rule: a base move is judged exactly once, from the old base\n  fix: git config stallion.push-base <old-base-sha>   — the EXACT value in origin's copy of .stallion-base, byte-for-byte — then push, then unset`);
    }
  } else {
    console.log("task-coverage: ~ moved-base check skipped — no remote tip anchor resolvable (no origin/<branch>, no origin/HEAD)");
  }
  const anchorRef = flags.base ?? (originOk ? `origin/${guardBranch}` : null);
  const errors = checkRange(base, anchorRef);
  if (errors.length > 0) {
    for (const e of errors) console.error(`task-coverage: ✖ ${e}`);
    die("CODE LANDED OUTSIDE THE LIFECYCLE — nothing was pushed. Record the task (task-state new), advance it, and carry 'task: <id>' in the commit message.");
  }
  console.log(`task-coverage: every code commit in ${base}..HEAD carries an authorizing task record.`);
}
