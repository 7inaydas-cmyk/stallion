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
 * evidence is git history; and the footer is a bearer citation — the machine authorizes the TASK,
 * not the specific commit (task↔commit binding is registered future work).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lanesFromChecklist } from "./adversarial-runner.mjs";
import { RISK_CLASSES, IMPLEMENTATION_FORBIDDEN, APPROVAL_REQUIRED, PHASES as PHASE_ORDER, derivePhase, hasValidPin, hasPinExemption } from "./task-state.mjs";

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
    const doctor = t.includes("--doctor");
    const staged = t.includes("--staged");
    if (mode === "doctor") return doctor;
    if (mode === "staged") return staged && !doctor;
    return !doctor && !staged; // "fence": the bare range check, with or without --base
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
  // Defense in depth: the advance-time pin law re-checked at the fence, because a hand-edited
  // record must not sail through on the advance-time check alone (an adversarial finding).
  if (record.riskClass !== "planning-only" && record.riskClass !== "experiment" && !hasValidPin(record) && !hasPinExemption(record)) {
    return "code task carries no valid command pin (and no recorded exemption) — red-check --command is machine-verified at advance time and re-checked here";
  }
  const phase = derivePhase(record.events ?? []);
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

/** The range check: every code commit in base..HEAD must carry an authorizing task footer. */
function checkRange(base) {
  const errors = [];
  const headSha = gitOut("rev-parse", "HEAD").trim();
  const commits = gitOut("rev-list", "--reverse", `${base}..HEAD`).trim().split("\n").filter(Boolean);
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
    if (refusal) errors.push(`${short} (task ${footer}): ${refusal}`);
  }
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
  check("pre-push hook committed and invoking the push fence", invokesMode(committedPrePush, "fence"), "commit .githooks/pre-push that runs 'node tools/task-coverage.mjs' (docs/WIRING.md)");
  check("pre-commit staged gate committed", invokesMode(committedPreCommit, "staged"), "commit .githooks/pre-commit that runs 'node tools/task-coverage.mjs --staged'");

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
    check("core.hooksPath points at a wired pre-push", invokesMode(livePrePush, "fence"), "git config core.hooksPath .githooks   (must point at the committed hooks)");
    check("core.hooksPath points at a wired pre-commit", invokesMode(livePreCommit, "staged"), "git config core.hooksPath .githooks");
  }

  const wfDir = `${ROOT}.github/workflows`;
  const committedWorkflows = (() => {
    try {
      return gitOut("ls-files", ".github/workflows").split("\n").filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    } catch {
      return existsSync(wfDir) ? readdirSync(wfDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")) : [];
    }
  })();
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

/** Strict flags: --base takes a value (both --base x and --base=x, non-empty); --staged and
 *  --doctor are exclusive (a silent winner masked the other); unknown flags refuse. */
function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--self-test" || a === "--staged" || a === "--doctor") {
      flags[a.slice(2)] = true;
      continue;
    }
    if (a === "--base" || a.startsWith("--base=")) {
      if (a.startsWith("--base=")) {
        if (a.slice(7).length === 0) die("--base requires a non-empty revision");
        flags.base = a.slice(7);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--") || next.length === 0) die("--base requires a non-empty revision (usage: [--base <rev>] [--staged] [--doctor])");
      flags.base = next;
      i += 1;
      continue;
    }
    die(`unknown flag: ${a} — usage: task-coverage.mjs [--base <rev>] [--staged] [--doctor] (--self-test to self-test)`);
  }
  if (flags.staged && flags.doctor) die("--staged and --doctor are separate invocations — running one silently would mask the other");
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
      { type: "created" },
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
    ["a pin-less record is refused at the fence (advance-time law, re-checked)", recordRefusal({ schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created" }, { type: "transition", to: "planned" }, { type: "transition", to: "executing" }] }) !== null],
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
  ];
  for (const [name, passes] of baseCases) if (!passes) fail(`task-coverage: ${name}`);

  console.log(failures.length === 0 ? "task-coverage self-test: OK (19 path + 6 footer + 13 authorization + 6 staged + 9 doctor + 8 base cases)" : `task-coverage self-test: FAILED\n  ${failures.join("\n  ")}`);
  return failures.length === 0;
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isEntry) {
  const flags = parseFlags(process.argv.slice(2));
  if (flags["self-test"]) process.exit(selfTest() ? 0 : 1);
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
  if (flags.base === undefined || flags.base === null) {
    // The self-resolved tiers (config/committed) read the audited tree — refuse a baseline the
    // audited commits themselves moved (the smuggle: unfooted code + a base bump past it).
    if (baseMovedInRange(committedTextAt(base, ".stallion-base"), committedText(".stallion-base"))) {
      die(`the adoption base moved INSIDE the audited range (${base}..HEAD)\n  rule: the fence's baseline cannot be rewritten by the commits it is judging\n  fix: if this move is deliberate, push once with the OLD base explicit (--base <old>, or git config stallion.push-base <old>), then let the new base take over`);
    }
  }
  const errors = checkRange(base);
  if (errors.length > 0) {
    for (const e of errors) console.error(`task-coverage: ✖ ${e}`);
    die("CODE LANDED OUTSIDE THE LIFECYCLE — nothing was pushed. Record the task (task-state new), advance it, and carry 'task: <id>' in the commit message.");
  }
  console.log(`task-coverage: every code commit in ${base}..HEAD carries an authorizing task record.`);
}
