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
import { existsSync, readdirSync, readFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url).pathname;
const STATE_DIR = `${ROOT}tasks`;
const DECISIONS = `${ROOT}docs/decisions/DECISIONS.md`;
const CHECKLIST = `${ROOT}docs/ADVERSARIAL-CHECKLIST.md`;
const CODE_TREES = ["apps/", "packages/", "tools/", "deploy/"];
const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".sh", ".mts", ".cts", ".css"]);
const CODE_NAMES = new Set(["Dockerfile", "Caddyfile"]); // no-extension executables under the four trees
const PHASE_ORDER = ["intake", "planned", "executing", "verified", "adversarial", "done"];
const RISK_CLASSES = ["planning-only", "harness-docs-only", "runtime-code", "protected", "migration", "product-protocol"];
const IMPLEMENTATION_FORBIDDEN = new Set(["planning-only", "product-protocol"]);
const APPROVAL_REQUIRED = new Set(["protected", "migration"]);

/** Pure: does this changed path count as code the lifecycle must cover? */
export function isCodePath(path) {
  if (!CODE_TREES.some((t) => path.startsWith(t))) return false;
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (CODE_NAMES.has(base)) return true;
  const dot = path.lastIndexOf(".");
  return dot !== -1 && CODE_EXTS.has(path.slice(dot));
}

/**
 * Pure: the staged-files gate decision. Code staged + no record at executing-or-later with a
 * legal class = refusal carrying the code files as evidence; null = pass.
 */
export function stagedRefusal(stagedFiles, records) {
  const codeFiles = stagedFiles.filter(isCodePath);
  if (codeFiles.length === 0) return null;
  const active = records.filter((r) => recordRefusal(r) === null);
  if (active.length > 0) return null;
  return { codeFiles };
}

/**
 * Pure: base resolution order — explicit argument, then the configured adoption base, then the
 * remote-tracking ref of the current branch. null means unresolvable, and the caller REFUSES:
 * the fence must never fail open on a first push.
 */
export function pickBase(explicit, config, originCurrent) {
  if (explicit) return explicit;
  if (config) return config;
  return originCurrent ?? null;
}

/** Pure: count '### N.' lane headings — the doctor's checklist-format check. */
export function checklistLaneCount(text) {
  return typeof text === "string" ? text.split("\n").filter((l) => /^### \d+\.\s/.test(l)).length : 0;
}

/** Pure: does a workflow or hook text actually invoke task-coverage? (one detector, both seams) */
export function hasCoverageStep(text) {
  return typeof text === "string" && text.includes("task-coverage");
}

export function prePushWired(text) {
  return hasCoverageStep(text);
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

function derivePhase(events) {
  let phase = "intake";
  for (const e of events) if (e.type === "transition" && PHASE_ORDER.includes(e.to)) phase = e.to;
  return phase;
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
  const phase = derivePhase(record.events ?? []);
  if (PHASE_ORDER.indexOf(phase) < PHASE_ORDER.indexOf("executing")) {
    return `task is '${phase}' — code landed before the machine authorized executing`;
  }
  return null;
}

function gitOut(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

function revParseOk(rev) {
  try {
    execFileSync("git", ["rev-parse", "--verify", rev], { cwd: ROOT, stdio: "ignore" });
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
      errors.push(`${short} touches code but carries no 'task: <id>' footer — future code is written only through the task-state lifecycle (task-state new)\n      fix: git commit --amend --no-edit --trailer "task: <id>"`);
      continue;
    }
    const { record, error } = loadRecord(footer);
    if (error) { errors.push(`${short}: ${error}\n      fix: node tools/task-state.mjs new ${footer} --risk-class <class>   — then advance it to executing`); continue; }
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
  let staged = "";
  try {
    staged = gitOut("diff", "--cached", "--name-only");
  } catch {
    staged = "";
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
    return console.log(`task-coverage (staged): ${stagedCode} code file(s) staged under an active task.`);
  }
  console.error(`task-coverage: ✖ REFUSED — code is staged but no task record is at executing or later`);
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

  const hooksDir = `${ROOT}.githooks`;
  const prePush = existsSync(`${hooksDir}/pre-push`) ? readFileSync(`${hooksDir}/pre-push`, "utf8") : "";
  const preCommit = existsSync(`${hooksDir}/pre-commit`) ? readFileSync(`${hooksDir}/pre-commit`, "utf8") : "";
  check("pre-push hook committed and invoking task-coverage", prePushWired(prePush), "create .githooks/pre-push running 'node tools/task-coverage.mjs' and commit it (docs/WIRING.md)");
  check("pre-commit staged gate committed", prePushWired(preCommit) && preCommit.includes("--staged"), "create .githooks/pre-commit running 'node tools/task-coverage.mjs --staged'");

  const inCI = process.env.CI === "true";
  const hooksActive = gitConfig("core.hooksPath") !== null;
  check(`core.hooksPath activates the hooks${inCI ? " (CI clone: unset is expected, push CI re-fences)" : ""}`, hooksActive || inCI, "git config core.hooksPath .githooks   (per clone — fresh clones must re-run this; the doctor enforces it)");

  const wfDir = `${ROOT}.github/workflows`;
  const workflows = existsSync(wfDir) ? readdirSync(wfDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")) : [];
  const ciOk = workflows.some((f) => hasCoverageStep(readFileSync(`${wfDir}/${f}`, "utf8")));
  check("CI re-runs task-coverage", ciOk, "add a task-coverage step to .github/workflows (docs/WIRING.md)");

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
  check("push base resolvable (--base / stallion.push-base / origin/<branch>)", pickBase(null, gitConfig("stallion.push-base"), originCurrent) !== null, "git config stallion.push-base <rev-at-adoption>   (once at adoption; grandfathers earlier history)");

  const register = existsSync(DECISIONS) ? readFileSync(DECISIONS, "utf8") : "";
  check("decisions register exists with entry headings", registerHeadingCount(register) > 0, "create docs/decisions/DECISIONS.md with at least one '## ' entry heading");

  const checklist = existsSync(CHECKLIST) ? readFileSync(CHECKLIST, "utf8") : "";
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
  const base = pickBase(explicit, gitConfig("stallion.push-base"), originCurrent);
  if (!base) {
    die(`no resolvable push base — refusing rather than guessing a range\n  rule: a first push must not fail open\n  fix: git config stallion.push-base <rev-at-adoption>   (once, at adoption; see docs/WIRING.md)\n       or run with an explicit --base <rev>`);
  }
  return base;
}

/** Self-test: the refusals ARE the feature — every guard proven both directions. */
export function selfTest() {
  const failures = [];
  const fail = (m) => failures.push(m);
  const record = (riskClass, phases, extraEvents = []) => ({
    schema: "stallion/task-state@1",
    id: "t",
    riskClass,
    events: [{ type: "created" }, ...phases.map((to) => ({ type: "transition", to })), ...extraEvents],
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
    ["malformed record refused", recordRefusal(null) !== null],
    ["wrong schema refused", recordRefusal({ schema: "nope" }) !== null],
  ];
  for (const [name, passes] of authCases) if (!passes) fail(`task-coverage: ${name}`);

  const stagedCases = [
    ["no code staged passes", stagedRefusal(["docs/x.md", "package.json"], [record("runtime-code", [])]) === null],
    ["code staged with an executing task passes", stagedRefusal(["apps/a.ts"], [record("runtime-code", ["planned", "executing"])]) === null],
    ["code staged with no tasks refuses and lists the code files", stagedRefusal(["apps/a.ts", "docs/x.md"], []).codeFiles?.length === 1],
    ["code staged under a planning-only task still refuses", stagedRefusal(["tools/x.mjs"], [record("planning-only", ["planned", "executing"])]) !== null],
  ];
  for (const [name, passes] of stagedCases) if (!passes) fail(`task-coverage: ${name}`);

  const doctorCases = [
    ["lane counter counts '### N.' headings", checklistLaneCount("### 1. A\nbody\n### 2. B\nbody") === 2],
    ["coverage-step detector matches a workflow step", hasCoverageStep("      run: node tools/task-coverage.mjs --base \"$BASE\"")],
    ["pre-push detector matches the hook body", prePushWired("#!/bin/sh\nnode tools/task-coverage.mjs || exit 1\n")],
    ["register heading counter counts '## ' only", registerHeadingCount("## A\n### a\n## B") === 2],
  ];
  for (const [name, passes] of doctorCases) if (!passes) fail(`task-coverage: ${name}`);

  const baseCases = [
    ["explicit base wins over everything", pickBase("HEAD~1", "cfg-ref", "origin/x") === "HEAD~1"],
    ["config beats origin tracking", pickBase(null, "cfg-ref", "origin/x") === "cfg-ref"],
    ["origin tracking is the last fallback", pickBase(null, null, "origin/main") === "origin/main"],
    ["nothing resolvable is null (fail closed, never skip)", pickBase(null, null, null) === null],
  ];
  for (const [name, passes] of baseCases) if (!passes) fail(`task-coverage: ${name}`);

  console.log(failures.length === 0 ? "task-coverage self-test: OK (15 path + 6 footer + 11 authorization + 4 staged + 4 doctor + 4 base cases)" : `task-coverage self-test: FAILED\n  ${failures.join("\n  ")}`);
  return failures.length === 0;
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntry) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  if (argv.includes("--staged")) { cmdStaged(); process.exit(0); }
  if (argv.includes("--doctor")) { cmdDoctor(); process.exit(0); }
  const baseIdx = argv.indexOf("--base");
  if (baseIdx !== -1 && !argv[baseIdx + 1]) die("usage: task-coverage.mjs [--base <rev>] [--staged] [--doctor]   (--self-test to self-test)");
  const base = resolvePushBase(baseIdx === -1 ? null : argv[baseIdx + 1]);
  if (!revParseOk(base)) {
    die(`base revision does not resolve: ${base}\n  fix: pass --base <rev>, or update the adoption base: git config stallion.push-base <rev>\n       (a fresh repo with one commit has no parent to diff against — record the adoption base explicitly)`);
  }
  const errors = checkRange(base);
  if (errors.length > 0) {
    for (const e of errors) console.error(`task-coverage: ✖ ${e}`);
    die("CODE LANDED OUTSIDE THE LIFECYCLE — nothing was pushed. Record the task (task-state new), advance it, and carry 'task: <id>' in the commit message.");
  }
  console.log(`task-coverage: every code commit in ${base}..HEAD carries an authorizing task record.`);
}
