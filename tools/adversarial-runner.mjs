#!/usr/bin/env node
/**
 * Adversarial runner — the adversarial relay, mechanized .
 *
 * The adversarial cadence until now is dispatched by hand each wave: a fresh-context reviewer gets
 * the diff plus the audit checklist, files findings, and the wave resolves them. Hand-dispatched
 * structure drifts — lanes get skipped when time is short, exactly when they matter. This tool makes
 * the STRUCTURE deterministic and leaves only the judgment to agents: deterministic loop
 * scaffolding around fresh-context reviewers, with the law enforced by refusal.
 *
 * What it does NOT do: spawn agents. It prepares one refute-prompt bundle per escape-class lane of
 * docs/ADVERSARIAL-CHECKLIST.md, records findings into the shared register
 * (task-findings.mjs — the same parser task-state gates `done` on), and aggregates fail-closed:
 * any UNRESOLVED finding, or a missing register, fails the verdict.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { aggregateFindings, appendFinding, emptyFindings, loadFindings, missingResolveEvidence, mutateJson, setFindingStatus, validateFindings, SEVERITIES } from "./task-findings.mjs";
import { evidencePathIsFile } from "./task-state.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CHECKLIST = `${ROOT}docs/ADVERSARIAL-CHECKLIST.md`;
const STATE_DIR = `${ROOT}tasks`;
const BUNDLE_DIR = `${ROOT}adversarial`;

/**
 * Parse the checklist's escape-class sections (`### N. Title` up to the next heading) into lanes.
 * Pure: fixtures drive it in the self-test. A heading level other than ### under "The escape
 * classes" (e.g. a renamed section) is not matched — a lane that fails to appear fails loudly at
 * prepare time via the expected-lane count, not silently here.
 */
export function lanesFromChecklist(text) {
  const lanes = [];
  const lines = text.split("\n");
  let current = null;
  for (const line of lines) {
    const m = /^### (\d+)\. (.+)$/.exec(line);
    if (m) {
      if (current) lanes.push(current);
      current = { n: Number(m[1]), title: m[2].trim(), body: [] };
    } else if (current) {
      if (line.startsWith("## ")) { lanes.push(current); current = null; continue; }
      current.body.push(line);
    }
  }
  if (current) lanes.push(current);
  return lanes.map((l) => ({ ...l, slug: l.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), body: l.body.join("\n").trim() }));
}

/** The fresh-context refute prompt for one lane. Pure; the self-test pins the contract clauses. */
export function renderBundle(lane, taskId, diffStat, fileList) {
  return `# Adversarial pass — task ${taskId} — lane ${lane.n}: ${lane.title}

You are an adversarial auditor with NO context about this change and NO stake in it being correct.
Your job is to REFUTE the claim that this wave is sound. Assume guilt. Every clause below is the
audit law for your lane; a wave that cannot survive its lane's clauses is a wave that ships an
escape. Report findings, not reassurance — "looks fine" is a non-answer.

## Your lane's law (escape class ${lane.n})

${lane.body}

## The change under audit

\`\`\`
${diffStat}
\`\`\`

Files touched:
${fileList}

## Output contract (exactly one JSON object, nothing else)

{"findings": [{"severity": "CRITICAL|HIGH|MEDIUM|LOW", "claim": "<what is wrong, where, and why it escapes>", "evidence": "<file:line or command output>"}]}

If your lane truly finds nothing, answer {"findings": []} — but say so only after checking every
clause above against every file in the diff, not after the first file.
`;
}

class Refused extends Error {}

/** Refusals throw instead of exiting so a locked section's finally releases the lockfile —
 *  process.exit skips finally and would orphan the lock for the 60s stale-breaker. */
function die(message) {
  throw new Refused(message);
}

function gitOut(...args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    die(`git ${args.join(" ")} failed: ${e.message}`);
  }
}

/** Pure: a lane number must name one of the checklist's real escape classes — findings no
 *  sweep covered must not be recordable. */
export function laneRefusal(lane, laneCount) {
  if (!Number.isInteger(lane) || lane < 1 || lane > laneCount) {
    return `--lane ${String(lane)} is outside the checklist's 1..${laneCount} escape classes — no sweep covered that lane`;
  }
  return null;
}

function findingsPath(id) {
  return `${STATE_DIR}/${id}.findings.json`;
}

function requireKebabId(id) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) die(`task id must be kebab-case (a-z, 0-9, -): ${id} — a traversal-bearing id must never reach a path join`);
}

function requireTask(id) {
  requireKebabId(id);
  if (!existsSync(`${STATE_DIR}/${id}.json`)) die(`no such task: ${id} — prepare/record against a real task-state record (task-state new)`);
}

/**
 * The register a WRITE path may touch, parsed INSIDE the lock: it must already exist (only
 * `prepare` mints one, against a real diff) and belong to this task. A real failure mode, found
 * the hard way: the old load-or-init let a FAILING 'resolve <typo-id>' mint an empty register
 * that verdict scored CLEAN and the done-gate accepted — a command that fails must leave no
 * state that passes.
 */
function parseRegisterForWrite(text, id) {
  if (text === null) die(`no findings register for ${id} — a pass begins with 'prepare ${id}', not with a write\n  fix: node tools/adversarial-runner.mjs prepare ${id}`);
  let register;
  try {
    register = JSON.parse(text);
  } catch (e) {
    die(`findings register is not valid JSON: ${e.message}`);
  }
  const error = validateFindings(register);
  if (error) die(error);
  if (register.task !== id) die(`findings register belongs to task '${register.task}', not '${id}'`);
  return register;
}

/** The diff under audit: defaults to the last commit, overridable for multi-commit waves. */
function diffUnderAudit(args) {
  const base = args.base ?? "HEAD~1";
  const head = args.head ?? "HEAD";
  const fileList = gitOut("diff", "--name-only", `${base}..${head}`);
  if (!fileList) die(`no diff between ${base} and ${head} — an adversarial pass audits a CHANGE\n  fix: name commits that differ: adversarial-runner.mjs prepare <task-id> --base <rev> --head <rev>`);
  return { diffStat: gitOut("diff", "--stat", `${base}..${head}`), fileList };
}

/**
 * Only prepare mints a register, and only with the pass marker: verdict and the done-gate
 * require it, so "no findings" can never stand in for "no pass".
 */
function mintPassMarker(id) {
  mutateJson(findingsPath(id), (text) => {
    if (text === null) return { ...emptyFindings(id), passStartedAt: new Date().toISOString() };
    let register;
    try {
      register = JSON.parse(text);
    } catch (e) {
      die(`findings register is not valid JSON: ${e.message}`);
    }
    const error = validateFindings(register);
    if (error) die(error);
    if (register.task !== id) die(`findings register belongs to task '${register.task}', not '${id}'`);
    return undefined; // already prepared — a re-prepare changes nothing
  });
}

function cmdPrepare(args) {
  const id = args._[0];
  if (!id) die("usage: prepare <task-id> [--base <rev>] [--head <rev>]");
  requireTask(id);
  const { diffStat, fileList } = diffUnderAudit(args);
  const lanes = lanesFromChecklist(readFileSync(CHECKLIST, "utf8"));
  if (lanes.length !== 8) die(`checklist yielded ${lanes.length} lanes (expected exactly the EIGHT escape classes) — the checklist format changed; update this parser and its count pin deliberately\n  fix: keep exactly eight '### N. Title' headings under '## The escape classes' in docs/ADVERSARIAL-CHECKLIST.md`);
  const dir = `${BUNDLE_DIR}/${id}`;
  mkdirSync(dir, { recursive: true });
  for (const lane of lanes) writeFileSync(`${dir}/lane-${String(lane.n).padStart(2, "0")}-${lane.slug}.md`, renderBundle(lane, id, diffStat, fileList));
  mintPassMarker(id);
  console.log(`${lanes.length} refute bundles written to adversarial/${id}/`);
  console.log(`next: dispatch each bundle to a FRESH-context reviewer, then record findings here, then 'verdict ${id}'`);
}

function cmdRecord(args) {
  const id = args._[0];
  if (!id) die("usage: record <task-id> --lane <n> --severity <S> --claim <text>");
  requireTask(id);
  const lane = Number(args.lane);
  if (!Number.isInteger(lane) || lane < 1) die("record requires --lane <n> (the checklist escape class)");
  if (!SEVERITIES.includes(args.severity)) die(`record requires --severity in ${SEVERITIES.join(", ")}`);
  if (!args.claim || typeof args.claim !== "string") die("record requires --claim <what is wrong, where, why it escapes>");
  let laneCount = 0;
  try {
    const lanes = lanesFromChecklist(readFileSync(CHECKLIST, "utf8"));
    if (lanes.length !== 8) die(`checklist yielded ${lanes.length} lanes (expected exactly the EIGHT escape classes, the same pin prepare enforces)\n  fix: restore exactly eight '### N. Title' headings in docs/ADVERSARIAL-CHECKLIST.md`);
    laneCount = lanes.length;
  } catch (e) {
    if (e instanceof Refused) throw e;
    die(`cannot read the checklist at ${CHECKLIST} to validate the lane\n  fix: restore docs/ADVERSARIAL-CHECKLIST.md (eight '### N. Title' escape classes)`);
  }
  const laneLaw = laneRefusal(lane, laneCount);
  if (laneLaw) die(`${laneLaw}\n  fix: record with --lane between 1 and ${laneCount} (the lane whose sweep produced the finding)`);
  // The id mint and the append are one locked step: f{len+1} computed against a stale snapshot
  // collides with the sibling writer that already appended.
  const next = mutateJson(findingsPath(id), (text) => {
    const register = parseRegisterForWrite(text, id);
    const appended = appendFinding(register, { id: `f${register.findings.length + 1}`, lane, severity: args.severity, claim: args.claim });
    if (typeof appended === "string") die(appended);
    return appended;
  });
  console.log(`finding ${next.findings[next.findings.length - 1].id} recorded (lane ${lane}, ${args.severity}) — UNRESOLVED`);
}

/** Parse + existence-check the --evidence list (comma-split, repo-relative or cwd-relative). */
function evidencePaths(args) {
  const evidence = typeof args.evidence === "string" ? args.evidence.split(",").map((s) => s.trim()).filter(Boolean) : [];
  for (const p of evidence) if (!existsSync(p) && !existsSync(`${ROOT}${p.replace(/^\//, "")}`)) die(`evidence path does not exist: ${p}\n  fix: pass repo-relative or cwd-relative paths that exist, comma-separated`);
  return evidence;
}

function cmdResolve(args) {
  const [id, findingId] = args._;
  if (!id || !findingId) die("usage: resolve <task-id> <finding-id> --evidence <path>[,<path>...]");
  requireKebabId(id);
  const evidence = evidencePaths(args);
  if (evidence.length === 0) die("resolve requires --evidence — the paths that prove the fix");
  mutateJson(findingsPath(id), (text) => {
    const register = parseRegisterForWrite(text, id);
    if (!register.findings.some((f) => f.id === findingId)) {
      die(`no such finding: ${findingId}\n  evidence: register ${id} holds ${register.findings.map((f) => f.id).join(", ") || "no findings yet"}\n  fix: node tools/adversarial-runner.mjs resolve ${id} <one-of-those> --evidence <paths>`);
    }
    const next = setFindingStatus(register, findingId, { status: "RESOLVED", evidence });
    if (typeof next === "string") die(next);
    return next;
  });
  console.log(`finding ${findingId} RESOLVED (${evidence.length} evidence path(s))`);
}

function cmdWontFix(args) {
  const [id, findingId] = args._;
  if (!id || !findingId) die("usage: wont-fix <task-id> <finding-id> --justification <why this is accepted>");
  requireKebabId(id);
  if (!args.justification || typeof args.justification !== "string") die("wont-fix requires --justification — an accepted escape must say why, in the register, forever");
  mutateJson(findingsPath(id), (text) => {
    const next = setFindingStatus(parseRegisterForWrite(text, id), findingId, { status: "WONT-FIX", justification: args.justification });
    if (typeof next === "string") die(next);
    return next;
  });
  console.log(`finding ${findingId} WONT-FIX (justification recorded)`);
}

/** The register verdict scores: must exist, belong to this task, and carry a prepared-pass marker. */
function loadMarkedRegister(id) {
  const { ok, register, error } = loadFindings(findingsPath(id));
  if (!ok) die(error);
  if (!register) die(`FAIL — no adversarial findings register for ${id}: the pass was never recorded, and absent is not clean`);
  if (register.task !== id) die(`FAIL — findings register belongs to task '${register.task}', not '${id}'`);
  if (!register.passStartedAt) die(`FAIL — register for ${id} carries no pass marker: only a prepared pass counts, and an empty register is not a completed pass`);
  return register;
}

function cmdVerdict(args) {
  const id = args._[0];
  if (!id) die("usage: verdict <task-id>");
  requireKebabId(id);
  const register = loadMarkedRegister(id);
  const missing = missingResolveEvidence(register, evidencePathIsFile);
  if (missing.length > 0) {
    console.error("adversarial-runner: verdict FAIL — resolve evidence no longer exists:");
    for (const m of missing) console.error(`  ✖ ${m}`);
    die(`  rule: a resolution is proven by its evidence at verdict time, not remembered from resolve time\n  fix: node tools/adversarial-runner.mjs resolve ${id} <finding-id> --evidence <paths-that-exist>`);
  }
  const agg = aggregateFindings(register);
  console.log(`task ${id}: ${agg.total} finding(s) — ${agg.unresolved} UNRESOLVED, ${agg.resolved} RESOLVED, ${agg.wontFix} WONT-FIX`);
  for (const f of register.findings) console.log(`  [${f.status}] ${f.id} (lane ${f.lane ?? "?"}, ${f.severity}): ${f.claim}`);
  if (!agg.clean) {
    console.error("adversarial-runner: verdict FAIL — resolve or wont-fix every finding");
    for (const f of register.findings) {
      if (f.status === "UNRESOLVED") console.error(`  fix: node tools/adversarial-runner.mjs resolve ${id} ${f.id} --evidence <paths>   |   node tools/adversarial-runner.mjs wont-fix ${id} ${f.id} --justification "<why>"`);
    }
    process.exit(1);
  }
  console.log("adversarial-runner: verdict CLEAN — task-state may advance to done");
}

/**
 * Strict parser (found the hard way: the lenient one coerced '--lane --severity HIGH'
 * into lane=true, which Number() scored as lane 1, and kept only the LAST of repeated flags).
 * Every flag here takes a value; duplicates are refused.
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

function selfTestLanes(fail) {
  const fixture = [
    "# Checklist",
    "## The escape classes",
    "### 1. Input forgeability — trust boundaries that believe the client",
    "Clause one.",
    "Clause two.",
    "",
    "### 2. Authorization and tenancy — who else can reach this?",
    "Clause.",
    "## Per-audit mechanics",
    "not a lane",
  ].join("\n");
  const lanes = lanesFromChecklist(fixture);
  if (lanes.length !== 2) fail(`adversarial-runner: expected 2 lanes from fixture, got ${lanes.length}`);
  if (lanes[0]?.n !== 1 || lanes[0]?.slug !== "input-forgeability-trust-boundaries-that-believe-the-client") fail("adversarial-runner: lane 1 parsed wrong");
  if (!lanes[0]?.body.includes("Clause two.")) fail("adversarial-runner: lane body lost lines");
  if (lanes[1]?.body.includes("not a lane")) fail("adversarial-runner: content after the next ## leaked into a lane");
}

function selfTestBundle(fail) {
  const lane = { n: 1, title: "Input forgeability", slug: "input", body: "Clause two." };
  const bundle = renderBundle(lane, "t9", " 3 files changed, 10 insertions(+)", "a.ts\nb.ts");
  for (const clause of ["NO context", "REFUTE", "Clause two.", "3 files changed", "a.ts", '"findings"', '{"findings": []}']) {
    if (!bundle.includes(clause)) fail(`adversarial-runner: bundle missing contract clause: ${clause}`);
  }
}

function selfTestAggregation(fail) {
  // Verdict aggregation refusals, driven through the shared seam end-to-end.
  const register = appendFinding(emptyFindings("t9"), { id: "f1", lane: 1, severity: "HIGH", claim: "x" });
  if (typeof register === "string") fail(`adversarial-runner: fixture append refused (${register})`);
  if (aggregateFindings(register).clean) fail("adversarial-runner: unresolved register must not be clean");
  const bareWontFix = setFindingStatus(register, "f1", { status: "WONT-FIX" });
  if (typeof bareWontFix !== "string") fail("adversarial-runner: wont-fix without justification accepted");
  const resolved = setFindingStatus(register, "f1", { status: "WONT-FIX", justification: "duplicate of registered decision" });
  if (typeof resolved === "string") fail(`adversarial-runner: justified wont-fix refused (${resolved})`);
  if (!aggregateFindings(resolved).clean) fail("adversarial-runner: wont-fixed register must aggregate clean");
}

export function selfTest() {
  const failures = [];
  const fail = (m) => failures.push(m);
  selfTestLanes(fail);
  selfTestBundle(fail);
  selfTestAggregation(fail);
  const laneCases = [
    ["lane beyond the checklist refused", laneRefusal(99, 8) !== null],
    ["lane within the checklist allowed", laneRefusal(3, 8) === null],
    ["lane zero refused", laneRefusal(0, 8) !== null],
  ];
  for (const [name, passes] of laneCases) if (!passes) fail(`adversarial-runner: ${name}`);
  console.log(failures.length === 0 ? "adversarial-runner self-test: OK (2 lanes + bundle contract + aggregation + 3 lane-bound cases)" : `adversarial-runner self-test: FAILED\n  ${failures.join("\n  ")}`);
  return failures.length === 0;
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isEntry) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  try {
    const [cmd, ...rest] = argv;
    const args = parseArgs(rest);
    const commands = { prepare: cmdPrepare, record: cmdRecord, resolve: cmdResolve, "wont-fix": cmdWontFix, verdict: cmdVerdict };
    if (!commands[cmd]) die("usage: adversarial-runner.mjs <prepare|record|resolve|wont-fix|verdict> ... (--self-test to self-test)");
    commands[cmd](args);
  } catch (e) {
    if (e instanceof Refused) {
      console.error(`adversarial-runner: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
