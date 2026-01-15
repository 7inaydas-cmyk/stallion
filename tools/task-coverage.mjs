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
import { existsSync, readFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url).pathname;
const STATE_DIR = `${ROOT}tasks`;
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
    if (!ratificationHeadingExists(approval.ratification)) {
      return `approval cites no decisions-register entry heading: ${String(approval.ratification)}`;
    }
  }
  return null;
}

function ratificationHeadingExists(ref) {
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
      errors.push(`${short} touches code but carries no 'task: <id>' footer — future code is written only through the task-state lifecycle (task-state new)`);
      continue;
    }
    const { record, error } = loadRecord(footer);
    if (error) { errors.push(`${short}: ${error}`); continue; }
    const refusal = recordRefusal(record);
    if (refusal) errors.push(`${short} (task ${footer}): ${refusal}`);
  }
  return errors;
}

function die(message) {
  console.error(`task-coverage: ${message}`);
  process.exit(1);
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
    ["deploy scripts are code", isCodePath("deploy/jj-push.sh")],
    ["web tsx is code", isCodePath("apps/web/src/routes/page.tsx")],
    ["docs are not code", !isCodePath("docs/README.md")],
    ["markdown under apps is not code", !isCodePath("apps/web/README.md")],
    ["json state is not code", !isCodePath("tasks/x.json")],
    ["root package.json is not code", !isCodePath("package.json")],
    ["graphify output is not code", !isCodePath("graphify-out/graph.json")],
    [".mts is code", isCodePath("tools/dev/house-tracer.constants.d.mts")],
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
    ["protected with a real decision authorizes", recordRefusal(record("protected", ["planned", "executing"], [{ type: "approval", ratification: "2026-01-15 — ADOPTION: this repository runs its code through the task lifecycle" }])) === null],
    ["protected with an invented decision refused", recordRefusal(record("protected", ["planned", "executing"], [{ type: "approval", ratification: "2026-01-16 — I NEVER SAID THIS" }])) !== null],
    ["unknown risk class refused (hand-forged record)", recordRefusal(record("totally-made-up-class", ["planned", "executing"])) !== null],
    ["malformed record refused", recordRefusal(null) !== null],
    ["wrong schema refused", recordRefusal({ schema: "nope" }) !== null],
  ];
  for (const [name, passes] of authCases) if (!passes) fail(`task-coverage: ${name}`);

  console.log(failures.length === 0 ? "task-coverage self-test: OK (15 path + 6 footer + 11 authorization cases)" : `task-coverage self-test: FAILED\n  ${failures.join("\n  ")}`);
  return failures.length === 0;
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntry) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  const baseIdx = argv.indexOf("--base");
  if (baseIdx === -1 || !argv[baseIdx + 1]) die("usage: task-coverage.mjs --base <rev> (--self-test to self-test)");
  const base = argv[baseIdx + 1];
  try {
    execFileSync("git", ["rev-parse", "--verify", base], { cwd: ROOT, stdio: "ignore" });
  } catch {
    die(`base revision does not resolve: ${base} (a fresh repo with one commit has no parent to diff against; pass an explicit base)`);
  }
  const errors = checkRange(base);
  if (errors.length > 0) {
    for (const e of errors) console.error(`task-coverage: ✖ ${e}`);
    die("CODE LANDED OUTSIDE THE LIFECYCLE — nothing was pushed. Record the task (task-state new), advance it, and carry 'task: <id>' in the commit message.");
  }
  console.log("task-coverage: every code commit in range carries an authorizing task record.");
}
