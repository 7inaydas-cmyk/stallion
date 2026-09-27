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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateFindings, appendFinding, duplicateEvidenceOf, emptyFindings, loadFindings, missingResolveEvidence, mutateJson, normalizedEvidenceOf, raiseSeverity, setFindingStatus, validateFindings, SEVERITIES } from "./task-findings.mjs";
import { bundleBlock, lessonsIndex, loadRegisters } from "./retrospective.mjs";
import { evidencePathIsFile, findingsPath, TASK_ID } from "./task-state.mjs";

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

/**
 * The fresh-context refute prompt for one lane. Pure; the self-test pins the contract clauses.
 * `lessons` (optional) carries the retrospective block — what past lanes learned — so every
 * sweep starts standing on the registers instead of re-paying for the same escapes. `diff` is
 * diffUnderAudit's whole result, so its pinned base..head always rides along: without it the
 * reviewer's only anchor was a --stat, and `git diff HEAD~1` later audits a different change.
 */
export function renderBundle(lane, taskId, diff, lessons = "") {
  return `# Adversarial pass — task ${taskId} — lane ${lane.n}: ${lane.title}

You are an adversarial auditor with NO context about this change and NO stake in it being correct.
Your job is to REFUTE the claim that this wave is sound. Assume guilt. Every clause below is the
audit law for your lane; a wave that cannot survive its lane's clauses is a wave that ships an
escape. Report findings, not reassurance — "looks fine" is a non-answer.

## Your lane's law (escape class ${lane.n})

${lane.body}

## The change under audit
\nPinned range: ${diff.base}..${diff.head} — the register certifies exactly this range as swept. Read it with
\`git diff ${diff.base}..${diff.head}\` and file states with \`git show ${diff.head}:<path>\`, never a moving alias like HEAD~1.\n
\`\`\`
${diff.diffStat}
\`\`\`

Files touched:
${diff.fileList}
${lessons.length > 0 ? `\n${lessons}\n` : ""}
## The refutation contract

Refute a finding ONLY by affirmatively demonstrating from the change that it is a false positive.
If you cannot determine it, do NOT refute it — uncertainty never clears a blocker. A CRITICAL or
HIGH finding must carry proof: the exact evidence (file:line or command output) AND a concrete
failure scenario — the input or state that produces the outcome, and why the existing guards miss
it. If you cannot produce both, demote the severity or drop the finding. Returning zero findings
is valid and expected: manufactured findings are the primary failure mode of LLM reviewers. A
verifier or lane that fails to return at all leaves the finding BLOCKING — silence never clears
a blocker, and a dead verifier's findings stay exactly as they were recorded.

## Output contract (exactly one JSON object, nothing else)

{"findings": [{"severity": "CRITICAL|HIGH|MEDIUM|LOW", "claim": "<what is wrong, where, and why it escapes>", "evidence": "<file:line or command output>", "proof": "<REQUIRED for CRITICAL|HIGH: the concrete failure scenario — what input/state breaks, and why existing guards miss it>"}]}

If your lane truly finds nothing, answer {"findings": []} — but say so only after checking every
clause above against every file in the diff, not after the first file.
`;
}

class Refused extends Error {}

/** Refusals throw instead of exiting so a locked section's finally releases the lockfile —
 *  process.exit skips finally and would orphan the lock for the 60s stale-breaker. */
/** Pure: the human-readable swept-range line for a prepared register — the pass is pinned to
 *  WHAT it swept, not just when (issue #7's visibility half; gating waits for real usage). */
export function sweptRangeLine(register) {
  if (!register || typeof register !== "object" || !register.sweptBase || !register.sweptHead) return null;
  return `swept ${register.sweptBase}..${register.sweptHead} (digest ${String(register.sweptDiffDigest ?? "unpinned")})`;
}

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

function requireKebabId(id) {
  if (!TASK_ID.test(id)) die(`task id must be kebab-case (a-z, 0-9, -): ${id} — a traversal-bearing id must never reach a path join`);
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
function parseRegisterForWrite(text, id, path = findingsPath(id)) {
  if (text === null) die(`no findings register for ${id} — a pass begins with 'prepare ${id}', not with a write\n  fix: node tools/adversarial-runner.mjs prepare ${id}`);
  const restore = registerRepair(path, id);
  let register;
  try {
    register = JSON.parse(text);
  } catch (e) {
    die(`findings register is not valid JSON: ${e.message}${restore}`);
  }
  const error = validateFindings(register);
  if (error) die(`${error}${restore}`);
  if (register.task !== id) die(`findings register belongs to task '${register.task}', not '${id}'${restore}`);
  return register;
}

/** The diff under audit: defaults to the last commit, overridable for multi-commit waves. The
 *  head is resolved to a pinned sha — an alias like HEAD names a different range every day. */
function diffUnderAudit(args) {
  const base = args.base ?? "HEAD~1";
  const head = args.head ?? "HEAD";
  const fileList = gitOut("diff", "--name-only", `${base}..${head}`);
  if (!fileList) die(`no diff between ${base} and ${head} — an adversarial pass audits a CHANGE\n  fix: name commits that differ: adversarial-runner.mjs prepare <task-id> --base <rev> --head <rev>`);
  const pinnedHead = gitOut("rev-parse", head).trim();
  const pinnedBase = gitOut("rev-parse", base).trim();
  return { diffStat: gitOut("diff", "--stat", `${base}..${head}`), fileList, base: pinnedBase, head: pinnedHead, content: gitOut("diff", `${base}..${head}`) };
}

/**
 * Only prepare mints a register, and only with the pass marker: verdict and the done-gate
 * require it, so "no findings" can never stand in for "no pass".
 */
function mintPassMarker(id, base, head, sweptContent) {
  // A re-prepare is a NEW sweep of a possibly-new range: the marker re-pins to what this pass
  // will audit (findings stay append-only; the marker is pass metadata). An existing register is
  // read under the same law as every write path.
  const marker = {
    passStartedAt: new Date().toISOString(),
    sweptBase: base, sweptHead: head,
    sweptDiffDigest: createHash("sha256").update(sweptContent).digest("hex").slice(0, 12),
  };
  mutateJson(findingsPath(id), (text) => ({ ...(text === null ? emptyFindings(id) : parseRegisterForWrite(text, id)), ...marker }));
}

/**
 * The checklist's lanes, pinned to the EIGHT escape classes — ONE reader for prepare, record,
 * calibrate and calibrate-record. Four hand-copies had drifted: three let a missing checklist
 * escape as a stack trace instead of a refusal, and calibrate-record dropped the eight-lane pin.
 */
function checklistLanes(path = CHECKLIST) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    die(`cannot read the checklist at ${path} (${e.code ?? e.message})\n  fix: restore the eight '### N. Title' escape classes: git checkout -- docs/ADVERSARIAL-CHECKLIST.md`);
  }
  const lanes = lanesFromChecklist(text);
  if (lanes.length !== 8) die(`checklist yielded ${lanes.length} lanes (expected exactly the EIGHT escape classes) — the checklist format changed; update this parser and its count pin deliberately\n  fix: keep exactly eight '### N. Title' headings under '## The escape classes' in docs/ADVERSARIAL-CHECKLIST.md`);
  return lanes;
}

function cmdPrepare(args) {
  const id = args._[0];
  if (!id) die("usage: prepare <task-id> [--base <rev>] [--head <rev>]");
  requireTask(id);
  const diff = diffUnderAudit(args);
  const lanes = checklistLanes();
  const dir = `${BUNDLE_DIR}/${id}`;
  mkdirSync(dir, { recursive: true });
  const { registers: lessonRegisters, skipped } = loadRegisters(STATE_DIR);
  if (skipped > 0) console.error(`adversarial prepare: retrospective skipped ${skipped} malformed register(s) — the standing lessons in the bundles are INCOMPLETE until they parse`);
  const lessons = bundleBlock(lessonsIndex(lessonRegisters));
  for (const lane of lanes) writeFileSync(`${dir}/lane-${String(lane.n).padStart(2, "0")}-${lane.slug}.md`, renderBundle(lane, id, diff, lessons));
  mintPassMarker(id, diff.base, diff.head, diff.content);
  console.log(`${lanes.length} refute bundles written to adversarial/${id}/ — pinned range ${diff.base.slice(0, 10)}..${diff.head.slice(0, 10)}`);
  console.log(`next: dispatch each bundle to a FRESH-context reviewer, then record findings here, then 'verdict ${id}'`);
}

function cmdRecord(args) {
  const id = args._[0];
  if (!id) die("usage: record <task-id> --lane <n> --severity <S> --claim <text> [--proof <scenario>] [--evidence <file:line or command output>]");
  requireTask(id);
  const lane = Number(args.lane);
  if (!Number.isInteger(lane) || lane < 1) die("record requires --lane <n> (the checklist escape class)");
  if (!SEVERITIES.includes(args.severity)) die(`record requires --severity in ${SEVERITIES.join(", ")}`);
  if (!args.claim || typeof args.claim !== "string") die("record requires --claim <what is wrong, where, why it escapes>");
  const laneCount = checklistLanes().length;
  const laneLaw = laneRefusal(lane, laneCount);
  if (laneLaw) die(`${laneLaw}\n  fix: record with --lane between 1 and ${laneCount} (the lane whose sweep produced the finding)`);
  const { next, mergeMsg } = recordFinding(id, args, lane);
  if (mergeMsg) console.log(mergeMsg);
  else console.log(`finding ${next.findings[next.findings.length - 1].id} recorded (lane ${lane}, ${args.severity}) — UNRESOLVED`);
}

/**
 * Record's one write: the dedup and the append against the register (`path` lets the self-test
 * drive it — the pure dedup alone let a call site that swapped in evidence-only dedup stay green).
 */
function recordFinding(id, args, lane, path = findingsPath(id)) {
  // The id mint and the append are one locked step: f{len+1} computed against a stale snapshot
  // collides with the sibling writer that already appended.
  let mergeMsg = null;
  const next = mutateJson(path, (text) => {
    const register = parseRegisterForWrite(text, id, path);
    const evidence = typeof args.evidence === "string" && args.evidence.trim() ? { evidence: args.evidence } : {};
    const dup = duplicateEscapeOf(register, { claim: args.claim, ...evidence }, id);
    if (dup) {
      mergeMsg = `finding ${dup} carries this normalized evidence — severity raised to ${args.severity} (strictest wins), no new lane spent`;
      return raiseDuplicate(register, dup, args);
    }
    const proof = typeof args.proof === "string" && args.proof.trim() ? { proof: args.proof } : {};
    const appended = appendFinding(register, { id: `f${register.findings.length + 1}`, lane, severity: args.severity, claim: args.claim, ...proof, ...evidence });
    if (typeof appended === "string") die(appended);
    return appended;
  });
  return { next, mergeMsg };
}

/**
 * The spec's severity-merge (ECC's orch-review: dedup keeps the STRICTEST severity): a stricter
 * finding on the same evidence RAISES the existing one; an equal-or-weaker duplicate refuses —
 * resolution lanes are not spent twice on one escape. A raise INTO a proof-owing severity carries
 * the duplicate's proof with it (the law travels with the severity, not with which CLI path set it).
 */
function raiseDuplicate(register, dup, args) {
  const proof = typeof args.proof === "string" && args.proof.trim() ? args.proof : undefined;
  const raised = raiseSeverity(register, dup, args.severity, proof);
  if (typeof raised === "string") die(`${raised}
  fix: the finding is already recorded on this evidence — re-record with a STRICTER severity (adding --proof when the raise enters CRITICAL/HIGH), resolve/wont-fix ${dup}, or record a DISTINCT escape`);
  return raised;
}

/**
 * The finding a candidate DUPLICATES: the same normalized evidence AND the same claim. A shared
 * file:line is not a shared escape (found in review: a CRITICAL escape citing the line a LOW
 * finding cited was folded into it — its claim and lane dropped, so resolving the trivial claim
 * cleared both). The same evidence under a different claim refuses, naming the standing claim.
 */
function duplicateEscapeOf(register, candidate, id) {
  const dup = duplicateEvidenceOf(register, candidate);
  const standing = register.findings.find((f) => f.id === dup);
  if (!standing || claimKey(standing.claim) === claimKey(candidate.claim)) return dup;
  // POSIX single-quoted: a claim carrying ", $ or \ pasted inside double quotes came back
  // CHANGED, missed the standing claim, and hit this same refusal again.
  const quoted = `'${standing.claim.replace(/'/g, "'\\''")}'`;
  die(`finding ${dup} already cites this evidence for a DIFFERENT claim — a shared file:line is not a shared escape, and merging would drop this claim and its lane\n  evidence: ${dup} claims "${standing.claim}"\n  fix: re-record with --evidence that names THIS escape (quote the offending token or the command output); if it IS ${dup}'s escape, raise it with ${dup}'s own claim: node tools/adversarial-runner.mjs record ${id} --lane <n> --severity <stricter> --claim ${quoted} --evidence "<the same evidence>"`);
}

/**
 * The repair a register that fails its read owes: evidence plus a NON-destructive fix. The old
 * `git checkout -- <register>` failed on the untracked register of a pass in flight, and on a
 * tracked one silently dropped every finding since the last commit — UNRESOLVED blockers
 * included — so a verdict could turn CLEAN. Only a register holding no findings is re-minted.
 */
function registerRepair(path, id) {
  const rel = relative(ROOT, path);
  const mint = path.endsWith(".calibration.json") ? "calibrate" : "prepare";
  return `\n  evidence: ${rel} — git diff -- ${rel} shows what changed since its last commit, if it has one\n  fix: repair ${rel} by hand, keeping every recorded finding (append-only: a dropped finding is a blocker silently cleared); if it holds no findings yet: rm ${rel} && node tools/adversarial-runner.mjs ${mint} ${id}`;
}

/** The one normalization evidence dedup uses, applied to a claim (no evidence ⇒ the claim is the key). */
function claimKey(claim) {
  return normalizedEvidenceOf({ claim });
}

/** Parse + existence-check the --evidence list (comma-split, repo-relative or cwd-relative).
 *  The SAME file-only law verdict judges with (evidencePathIsFile): resolve used to accept any
 *  path that merely exists — a directory recorded here failed there, and the verdict's promised
 *  re-resolve was refused by the append-only law, deadlocking the register (the harness defect
 *  the resolve-evidence-repair task closed). One law at both ends of a resolution. */
function evidencePaths(args) {
  const evidence = typeof args.evidence === "string" ? args.evidence.split(",").map((s) => s.trim()).filter(Boolean) : [];
  for (const p of evidence) if (!evidencePathIsFile(p)) die(`evidence path is not a readable file: ${p}\n  fix: pass FILE paths that exist, repo-relative or cwd-relative, comma-separated — the same law the verdict judges with`);
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
    // The repair seam: the predicate injects the verdict's own evidence law, so a RESOLVED finding
    // whose recorded evidence no longer exists can be re-resolved here — exactly what the verdict's
    // fix line promises — while a closed finding with live evidence still refuses.
    const next = setFindingStatus(register, findingId, { status: "RESOLVED", evidence }, evidencePathIsFile);
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

/** Pure: why a loaded register is not a completed pass of THIS task, or null — verdict scores
 *  only a register that exists, belongs to the task, and carries a prepared-pass marker. */
function markerRefusal(register, id, path = findingsPath(id)) {
  if (!register) return `FAIL — no adversarial findings register for ${id}: the pass was never recorded, and absent is not clean\n  fix: node tools/adversarial-runner.mjs prepare ${id}`;
  if (register.task !== id) return `FAIL — findings register belongs to task '${register.task}', not '${id}'${registerRepair(path, id)}`;
  if (!register.passStartedAt) return `FAIL — register for ${id} carries no pass marker: only a prepared pass counts, and an empty register is not a completed pass\n  fix: node tools/adversarial-runner.mjs prepare ${id}`;
  return null;
}

/** The register verdict scores, or die with markerRefusal's law (`path` lets the self-test drive the die sites). */
function loadMarkedRegister(id, path = findingsPath(id)) {
  const { ok, register, error } = loadFindings(path);
  if (!ok) die(`${error}${registerRepair(path, id)}`);
  const refusal = markerRefusal(register, id, path);
  if (refusal) die(refusal);
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
    die(`  rule: a resolution is proven by its evidence at verdict time, not remembered from resolve time\n  fix: node tools/adversarial-runner.mjs resolve ${id} <finding-id> --evidence <file-paths-that-exist>   (a RESOLVED finding whose recorded evidence no longer exists may be re-resolved — the append-only law's one repair)`);
  }
  const agg = aggregateFindings(register);
  console.log(`task ${id}: ${agg.total} finding(s) — ${agg.unresolved} UNRESOLVED, ${agg.resolved} RESOLVED, ${agg.wontFix} WONT-FIX`);
  const swept = sweptRangeLine(register);
  if (swept) console.log(`  ${swept}`);
  for (const f of register.findings) {
    console.log(`  [${f.status}] ${f.id} (lane ${f.lane ?? "?"}, ${f.severity}): ${f.claim}`);
    if (f.evidence) console.log(`      evidence: ${f.evidence}`);
    if (f.proof) console.log(`      proof: ${f.proof}`);
  }
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
  const cases = [
    ["two lanes parse from the fixture", lanes.length === 2],
    ["lane 1 parses its number and slug", lanes[0]?.n === 1 && lanes[0]?.slug === "input-forgeability-trust-boundaries-that-believe-the-client"],
    ["a lane body keeps every line", lanes[0]?.body.includes("Clause two.") === true],
    ["content after the next ## never leaks into a lane", !lanes[1]?.body.includes("not a lane")],
  ];
  for (const [name, passes] of cases) if (!passes) fail(`adversarial-runner: ${name}`);
  return cases.length;
}

function selfTestBundle(fail) {
  const lane = { n: 1, title: "Input forgeability", slug: "input", body: "Clause two." };
  const bundle = renderBundle(lane, "t9", { diffStat: " 3 files changed, 10 insertions(+)", fileList: "a.ts\nb.ts", base: "b4se000000", head: "h3ad000000" });
  const clauses = ["NO context", "REFUTE", "Clause two.", "3 files changed", "a.ts", '"findings"', '{"findings": []}', "never clears a blocker", '"proof"', "zero findings", "leaves the finding BLOCKING"];
  for (const clause of clauses) if (!bundle.includes(clause)) fail(`adversarial-runner: bundle missing contract clause: ${clause}`);
  const cases = [
    ["a prepared bundle names the pinned base..head its register certifies as swept (never a moving HEAD~1)", bundle.includes("git diff b4se000000..h3ad000000") && bundle.includes("git show h3ad000000:<path>")],
  ];
  for (const [name, passes] of cases) if (!passes) fail(`adversarial-runner: ${name}`);
  return clauses.length + cases.length;
}

function selfTestAggregation(fail) {
  // Verdict aggregation refusals, driven through the shared seam end-to-end.
  const register = appendFinding(emptyFindings("t9"), { id: "f1", lane: 1, severity: "HIGH", claim: "x", proof: "fixture proof: pinned" });
  const resolved = setFindingStatus(register, "f1", { status: "WONT-FIX", justification: "duplicate of registered decision" });
  const cases = [
    ["the fixture append is accepted", typeof register !== "string"],
    ["an unresolved register is not clean", !aggregateFindings(register).clean],
    ["wont-fix without a justification refuses", typeof setFindingStatus(register, "f1", { status: "WONT-FIX" }) === "string"],
    ["a justified wont-fix is accepted", typeof resolved !== "string"],
    ["a wont-fixed register aggregates clean", typeof resolved !== "string" && aggregateFindings(resolved).clean],
  ];
  for (const [name, passes] of cases) if (!passes) fail(`adversarial-runner: ${name}`);
  return cases.length;
}

/** The refusal `fn` raised (a Refused's message), or null — a return or a crash is no refusal. */
function refusalOf(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Refused ? e.message : null;
  }
}

function refuses(fn) {
  return refusalOf(fn) !== null;
}

/** What a POSIX shell makes of one printed argument, or null when it does not even parse. */
function shellWord(printed) {
  try {
    return execFileSync("sh", ["-c", `printf %s ${printed}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** A temp checklist of `n` escape-class headings under `dir`; returns its path. */
function checklistFixture(dir, n) {
  const path = join(dir, `c${n}.md`);
  writeFileSync(path, ["## The escape classes", ...Array.from({ length: n }, (_, i) => `### ${i + 1}. Class ${i + 1}\nClause.`)].join("\n"));
  return path;
}

/** The checklist reader's law, driven against real temp files: every site refuses the same way. */
function selfTestChecklist(fail) {
  const dir = mkdtempSync(join(tmpdir(), "adversarial-checklist-"));
  try {
    const checklist = (n) => checklistFixture(dir, n);
    const cases = [
      ["a missing checklist REFUSES with a fix line — never a stack trace", refuses(() => checklistLanes(join(dir, "absent.md")))],
      ["a nine-heading checklist refuses the eight-lane pin", refuses(() => checklistLanes(checklist(9)))],
      ["an eight-heading checklist yields its eight lanes", checklistLanes(checklist(8)).length === 8],
      ["calibrate-record reads the checklist's own lane law — a missing checklist refuses, never a hard-coded eight", refuses(() => calibrationRecordArgs({ lane: "3", severity: "LOW", claim: "x" }, [], join(dir, "absent.md")))],
      ["calibrate-record takes a lane within the checklist's eight", calibrationRecordArgs({ lane: "3", severity: "LOW", claim: "x" }, [], checklist(8)).lane === 3],
    ];
    for (const [name, passes] of cases) if (!passes) fail(`adversarial-runner: ${name}`);
    return cases.length;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The die() SITES, driven against real temp files: the pure seams alone let a revert of a call
 * site (verdict CLEAN on a never-prepared register, a verdict on a stale sweep, a re-calibration
 * graded on the closed epoch's claims) keep the battery green.
 */
function selfTestRegisterFiles(fail) {
  const dir = mkdtempSync(join(tmpdir(), "adversarial-registers-"));
  const put = (name, value) => {
    writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
    return join(dir, name);
  };
  try {
    const at = "2026-09-27T00:00:00.000Z";
    const letters = ["alpha", "bravo", "charlie"];
    const wave = letters.reduce((r, l, i) => appendFinding(r, { id: `f${i + 1}`, lane: 1, severity: "HIGH", claim: `the walker coordinates defect variant ${l} manifests in manifests`, proof: "fixture proof" }), { ...emptyFindings("t9"), passStartedAt: at, sweptBase: "b1", sweptHead: "h1" });
    const registerPath = put("t9.findings.json", wave);
    const firstDispatch = letters.reduce((c, l, i) => appendFinding(c, { id: `f${i + 1}`, lane: 1, severity: "LOW", claim: `walker coordinates variant ${l} restated inside manifests` }), openDispatch(null, wave, "t9", at));
    const calPath = put("t9.calibration.json", { ...firstDispatch, calibrationVerdict: { passed: true } });
    const corrupt = refusalOf(() => loadMarkedRegister("t9", put("corrupt.findings.json", "{ bad"))) ?? "";
    const onDisk = (path) => JSON.parse(readFileSync(path, "utf8"));
    const recordPath = put("record.findings.json", { ...emptyFindings("t9"), passStartedAt: at });
    const standing = put("standing.calibration.json", { ...firstDispatch, sweptBase: "b0", sweptHead: "h0", calibrationVerdict: { passed: true } });
    const replay = { registerPath, path: standing, checklist: checklistFixture(dir, 8), diffOf: () => ({}) };
    const cases = [
      ["record's write raises the same claim on the same evidence to the stricter severity — no new lane spent", (() => {
        recordFinding("t9", { severity: "LOW", claim: "stale comment in parseArgs", evidence: "tools/x.mjs:361" }, 3, recordPath);
        const { mergeMsg } = recordFinding("t9", { severity: "MEDIUM", claim: "stale comment in parseArgs", evidence: "tools/x.mjs:361" }, 3, recordPath);
        const { findings } = onDisk(recordPath);
        return mergeMsg !== null && findings.length === 1 && findings[0].severity === "MEDIUM";
      })()],
      ["record's write refuses a DIFFERENT claim on the standing evidence — never merged, its claim and lane dropped", (() => {
        const refusal = refusalOf(() => recordFinding("t9", { severity: "HIGH", claim: "parseArgs lets a flag value forge another flag", proof: "fixture proof", evidence: "tools/x.mjs:361" }, 1, recordPath));
        const { findings } = onDisk(recordPath);
        return refusal?.includes("DIFFERENT claim") === true && findings.length === 1 && findings[0].severity === "MEDIUM";
      })()],
      ["a calibrate refused at a replay read leaves the standing epoch and its verdict untouched", (() => {
        const refused = refuses(() => openReplay("t9", { ...replay, diffOf: () => die("fixture: the swept range is gone") }));
        return refused && onDisk(standing).calibrationVerdict?.passed === true;
      })()],
      ["a calibrate refused at the checklist read leaves the standing epoch and its verdict untouched", (() => {
        const refused = refuses(() => openReplay("t9", { ...replay, checklist: join(dir, "absent.md") }));
        const kept = onDisk(standing);
        return refused && kept.dispatchFrom === 0 && kept.calibrationVerdict?.passed === true;
      })()],
      ["a re-calibrate through the command's seam opens a new epoch on disk — dispatchFrom moves past the closed claims and the sweep re-pins", (() => {
        openReplay("t9", replay);
        const reopened = onDisk(standing);
        return reopened.dispatchFrom === 3 && reopened.sweptHead === "h1" && !("calibrationVerdict" in reopened);
      })()],
      ["verdict refuses an UNMARKED register at its die site — empty is not a pass", refusalOf(() => loadMarkedRegister("t9", put("unmarked.findings.json", emptyFindings("t9"))))?.includes("carries no pass marker") === true],
      ["verdict loads a marked register of this task", loadMarkedRegister("t9", registerPath).task === "t9"],
      ["verdict refuses a corrupt register with the non-destructive repair", corrupt.includes("keeping every recorded finding") && corrupt.includes("prepare t9") && !corrupt.includes("git checkout")],
      ["calibrate-verdict refuses at its die site a calibration pinned to a sweep the register no longer records", refusalOf(() => gradeCalibration("t9", put("moved.findings.json", { ...wave, sweptHead: "h9" }), calPath))?.includes("different sweep") === true],
      ["calibrate-verdict grades a dispatch pinned to the register's sweep", gradeCalibration("t9", registerPath, calPath).rediscovered === 3],
      ["a re-calibration opened ON DISK grades only its own dispatch — the closed epoch's claims and pass never carry", (() => {
        const reopened = openCalibrationDispatch("t9", wave, calPath);
        const graded = gradeCalibration("t9", registerPath, calPath);
        return reopened.dispatchFrom === 3 && !("calibrationVerdict" in JSON.parse(readFileSync(calPath, "utf8"))) && graded.refuse && graded.rediscovered === 0;
      })()],
      ["a first calibrate mints its dispatch file at zero", openCalibrationDispatch("t9", wave, join(dir, "fresh.calibration.json")).dispatchFrom === 0 && existsSync(join(dir, "fresh.calibration.json"))],
      ["a corrupt calibration register refuses to reopen, naming the calibrate repair", refusalOf(() => openCalibrationDispatch("t9", wave, put("bad.calibration.json", "{ bad")))?.includes("adversarial-runner.mjs calibrate t9") === true],
    ];
    for (const [name, passes] of cases) if (!passes) fail(`adversarial-runner (register files): ${name}`);
    return cases.length;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Record's dedup law: a duplicate is the same ESCAPE — same evidence AND same claim. */
function selfTestDedup(fail) {
  const register = appendFinding({ ...emptyFindings("t9"), passStartedAt: "2026-09-27T00:00:00.000Z" }, { id: "f1", lane: 3, severity: "LOW", claim: "stale comment in parseArgs", evidence: "tools/x.mjs:361" });
  let sameEscape = null;
  const sameRefused = refuses(() => { sameEscape = duplicateEscapeOf(register, { claim: "Stale comment in  parseArgs", evidence: " TOOLS/x.mjs:361" }, "t9"); });
  const cases = [
    ["a DIFFERENT claim citing the same evidence refuses — never folded into the standing finding, its claim and lane dropped", refuses(() => duplicateEscapeOf(register, { claim: "parseArgs lets a flag value forge another flag", evidence: "tools/x.mjs:361" }, "t9"))],
    ["the same claim on the same evidence is still the duplicate (the strictest-wins merge)", !sameRefused && sameEscape === "f1"],
    ["distinct evidence is no duplicate", duplicateEscapeOf(register, { claim: "stale comment in parseArgs", evidence: "tools/y.mjs:1" }, "t9") === null],
    ["the DIFFERENT-claim refusal's printed record command carries the standing claim through a shell byte-for-byte", (() => {
      const claim = `the "\${id}" placeholder isn't filled \\ here`;
      const tricky = appendFinding(emptyFindings("t9"), { id: "f1", lane: 3, severity: "LOW", claim, evidence: "tools/x.mjs:10" });
      const printed = /--claim (.+) --evidence/.exec(refusalOf(() => duplicateEscapeOf(tricky, { claim: "another escape", evidence: "tools/x.mjs:10" }, "t9")) ?? "")?.[1];
      return printed !== undefined && shellWord(printed) === claim;
    })()],
  ];
  for (const [name, passes] of cases) if (!passes) fail(`adversarial-runner: ${name}`);
  return cases.length;
}

/** The CLI's own refusals, driven in-process: die() throws Refused, so no temp repo is needed. */
function selfTestCliRefusals(fail) {
  const own = JSON.stringify({ ...emptyFindings("t9"), passStartedAt: "2026-09-27T00:00:00.000Z" });
  const marked = JSON.parse(own);
  const cases = [
    ["a write to an ABSENT register refuses — only prepare mints one (a failing command leaves no state that passes)", refuses(() => parseRegisterForWrite(null, "t9"))],
    ["a write to another task's register refuses", refuses(() => parseRegisterForWrite(JSON.stringify(emptyFindings("other")), "t9"))],
    ["a write to an unparsable register refuses", refuses(() => parseRegisterForWrite("{ bad", "t9"))],
    ["a write to this task's own register proceeds", parseRegisterForWrite(own, "t9").task === "t9"],
    ["a calibration write with no open dispatch refuses, naming calibrate — only calibrate opens one", refusalOf(() => parseCalibrationForWrite(null, "t9"))?.includes("fix: node tools/adversarial-runner.mjs calibrate t9") === true],
    ["a repeated flag refuses — never last-one-wins", refuses(() => parseArgs(["--lane", "1", "--lane", "2"]))],
    ["a flag followed by a flag refuses — never coerced to a value", refuses(() => parseArgs(["--lane", "--severity", "HIGH"]))],
    ["flags parse in both spellings", (() => { const a = parseArgs(["t9", "--lane", "3", "--claim=a=b"]); return a._[0] === "t9" && a.lane === "3" && a.claim === "a=b"; })()],
    ["calibrate-verdict refuses a --bar knob before any read — the bar is the law", refusalOf(() => cmdCalibrateVerdict({ _: ["t9"], bar: "1" }))?.startsWith("--bar is refused") === true],
    ["verdict refuses an absent register, naming the prepare fix", markerRefusal(null, "t9")?.includes("fix: node tools/adversarial-runner.mjs prepare t9") === true],
    ["verdict refuses another task's register", markerRefusal({ ...marked, task: "other" }, "t9") !== null],
    ["verdict refuses an UNMARKED register — empty is not a pass", markerRefusal(emptyFindings("t9"), "t9")?.includes("fix: node tools/adversarial-runner.mjs prepare t9") === true],
    ["verdict scores a marked register of this task", markerRefusal(marked, "t9") === null],
    ["a broken register's repair never prints a git checkout — it fails on the untracked register of a pass in flight, and on a tracked one drops every finding since the last commit", [refusalOf(() => parseRegisterForWrite("{ bad", "t9")), markerRefusal({ ...marked, task: "other" }, "t9")].every((m) => m?.includes("rm tasks/t9.findings.json && node tools/adversarial-runner.mjs prepare t9") && !m.includes("git checkout"))
      && refusalOf(() => parseCalibrationForWrite("{ bad", "t9"))?.includes("rm tasks/t9.calibration.json && node tools/adversarial-runner.mjs calibrate t9") === true],
  ];
  for (const [name, passes] of cases) if (!passes) fail(`adversarial-runner: ${name}`);
  return cases.length;
}

/**
 * CALIBRATION (the 2026-09-20 evaluation, gap 4 — "a grader that cannot fail is not a grader",
 * tools/bench/grade.mjs:10-11, applied to the lanes themselves): replay a RECORDED wave's diff to
 * fresh lanes and demand they rediscover the defects the original pass found. No synthetic
 * seeds — the known-defect set is the wave's own CRITICAL/HIGH register, and the replayed diff
 * is the register's recorded swept range, so calibration grades the real grading instrument on
 * real past escapes.
 */

/** The known-defect set for calibration: the CRITICAL/HIGH findings a past wave's lanes found. */
export function knownDefectsOf(register) {
  return (register?.findings ?? []).filter((f) => f.severity === "CRITICAL" || f.severity === "HIGH");
}

const CALIBRATION_STOP = new Set("because between cannot commits defects different finding fresh gradient instructor nothing reported rewinds severity should theoretical unsupported verified".split(" "));

/** Distinctive tokens of a claim: ≥6 chars, hyphens kept, plural-stemmed, stopwords out. */
export function claimTokens(claim) {
  const tokens = new Set();
  for (const raw of `${claim}`.toLowerCase().split(/[^a-z-]+/)) {
    const token = raw.replace(/^-+|-+$/g, "");
    if (token.length < 6 || CALIBRATION_STOP.has(token)) continue;
    // Light plural stemming: invocation/invocations are one vocabulary unit, and the link
    // substance floor was failing on exactly that pair.
    const stemmed = token.length >= 7 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
    tokens.add(stemmed);
  }
  return tokens;
}

/**
 * Shared-distinctive-token count between two claims, or 0 when the overlap is not a rediscovery.
 * TWO bars, tuned on the real replay matrix (where clear rediscoveries share ≥4 tokens or 3
 * dense ones, and the false adjacency hits the lanes flagged share exactly 3 sparse): at least
 * four shared tokens, or three when they own a quarter of the smaller claim's vocabulary.
 * Generic class-level prose (battery, wiring, commit) shares threes across unrelated escapes
 * but never owns a quarter of a specific one. A heuristic, honestly labeled: the verdict lists
 * the unmatched knowns so a human reviews what tokens cannot see.
 */
export function overlapOf(knownClaim, reportedClaim) {
  const a = claimTokens(knownClaim);
  const b = claimTokens(reportedClaim);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared >= 4 || (shared >= 3 && shared / Math.min(a.size, b.size) >= 0.25) ? shared : 0;
}

/**
 * Does a reported claim rediscover a known defect? A paraphrase of the original finding matches
 * (specific vocabulary, densely shared); a different finding about a different escape does not.
 */
export function rediscovers(knownClaim, reportedClaim) {
  return overlapOf(knownClaim, reportedClaim) > 0;
}

/** The rediscovery bar for a known-defect set: two-thirds, rounded up — 9 known ⇒ 6, the original grill design. */
export function barOf(knownCount) {
  return Math.ceil((2 * knownCount) / 3);
}

/** Raw count of shared distinctive tokens, no density bars — the substance floor an explicit link owes. */
function rawSharedTokens(knownClaim, reportedClaim) {
  const a = claimTokens(knownClaim);
  let shared = 0;
  for (const token of claimTokens(reportedClaim)) if (a.has(token)) shared += 1;
  return shared;
}

/**
 * Pure: which known defects were rediscovered, and whether the bar holds. TWO counting paths:
 * (a) MUTUAL best-match over token overlap — each claim can win at most ONE known this way, so
 * generic prose cannot blanket the set (the f6 finding); (b) EXPLICIT LINKS — a claim recorded
 * with `rediscoverOf: <known-id>` counts only when the token overlap is non-empty, because the
 * dispatcher's asserted correspondence still owes substance. A token heuristic cannot read
 * paraphrase; the honest instrument records the human/LLM judgment and machine-verifies it.
 * Fewer than three known defects pins nothing.
 */
export function calibrationVerdict(known, reported, bar) {
  const claims = reported.map((r) => (typeof r === "string" ? { claim: r } : r));
  const pairs = [];
  known.forEach((finding, ki) => {
    claims.forEach((entry, ci) => {
      const overlap = overlapOf(finding.claim, entry.claim);
      if (overlap > 0) pairs.push({ ki, ci, overlap });
    });
  });
  pairs.sort((x, y) => y.overlap - x.overlap);
  const covered = new Set();
  const spent = new Set();
  for (const pair of pairs) {
    if (covered.has(pair.ki) || spent.has(pair.ci)) continue;
    covered.add(pair.ki);
    spent.add(pair.ci);
  }
  claims.forEach((entry, ci) => {
    // No spent-guard here, deliberately: mutual matching spends a claim on its densest known,
    // but a claim that genuinely describes two defects shows substance for both — the link is
    // the dispatcher's asserted correspondence and the raw-token floor is its proof of substance.
    if (typeof entry.rediscoverOf !== "string") return;
    const ki = known.findIndex((f) => f.id === entry.rediscoverOf);
    if (ki >= 0 && rawSharedTokens(known[ki].claim, entry.claim) >= 2) covered.add(ki);
  });
  const rediscovered = covered.size;
  const unmatched = known.filter((_, ki) => !covered.has(ki)).map((f) => f.id);
  return { known: known.length, rediscovered, bar, refuse: known.length < 3 || rediscovered < bar, unmatched };
}

function calibrationPath(id) {
  return `${STATE_DIR}/${id}.calibration.json`;
}

/** Load a wave's register and its known-defect set, or die with the law that stops a bad calibration. */
function replayFactsOf(id, path = findingsPath(id)) {
  const { ok, register, error } = loadFindings(path);
  if (!ok || register === null) die(`no parsable findings register for '${id}'${error ? ` — ${error}` : ""}\n  rule: calibration replays a RECORDED wave — the known defects are the register's own CRITICAL/HIGH findings\n  fix: calibrate a task whose adversarial pass completed`);
  const known = knownDefectsOf(register);
  if (known.length < 3) die(`only ${known.length} CRITICAL/HIGH finding(s) on '${id}'s register — fewer than three known defects pins nothing\n  fix: calibrate a wave whose lanes found at least three CRITICAL/HIGH escapes`);
  if (!register.sweptBase || !register.sweptHead) die(`'${id}'s register records no swept range — the replay diff cannot be reconstructed`);
  return { register, known };
}

function cmdCalibrate(args) {
  const id = args._[0];
  if (!id) die("usage: calibrate <past-task-id>");
  requireKebabId(id);
  const { register, known, diff, lanes } = openReplay(id);
  const dir = `${BUNDLE_DIR}/${id}-calibration`;
  mkdirSync(dir, { recursive: true });
  // Production-shaped (the f8 finding): the bundles carry the standing lessons like every
  // normal pass — EXCLUDING the replayed task's own register, which is the answer key (the f7
  // finding). The one calibration-specific difference is the tree note below: the graded lanes
  // must read the SWEPT HEAD, not the live tree, because the live tree carries the register.
  const { registers: lessonRegisters } = loadRegisters(STATE_DIR);
  const lessons = bundleBlock(lessonsIndex(lessonRegisters.filter((r) => r.task !== id)));
  const treeNote = [
    "## The tree under audit",
    "",
    `This pass audits the recorded range ${register.sweptBase.slice(0, 10)}..${register.sweptHead.slice(0, 10)}. Read file`,
    "states AS OF THE SWEPT HEAD — `git show <head>:<path>` or a `git worktree add <tmp> <head>` — not the",
    "live working tree, which carries later history.",
    "",
  ].join("\n");
  for (const lane of lanes) {
    const slug = `lane-${String(lane.n).padStart(2, "0")}-${lane.slug}.md`;
    writeFileSync(`${dir}/${slug}`, `${renderBundle(lane, id, diff, lessons)}\n${treeNote}`);
  }
  console.log(`${lanes.length} calibration bundles written to adversarial/${id}-calibration/ — replaying ${register.sweptBase.slice(0, 8)}..${register.sweptHead.slice(0, 8)}, ${known.length} known defect(s), bar ${barOf(known.length)}`);
  console.log(`next: dispatch each bundle to a FRESH-context reviewer, record with 'calibrate-record ${id} --lane <n> --severity <S> --claim <text>', then 'calibrate-verdict ${id}'`);
}

/** Validate the calibrate-record argv, or die. The lane law is DERIVED from the checklist (the f9 finding). */
function calibrationRecordArgs(args, known, checklist = CHECKLIST) {
  const lane = Number(args.lane);
  const laneCount = checklistLanes(checklist).length;
  const laneLaw = laneRefusal(lane, laneCount);
  if (laneLaw) die(`${laneLaw}\n  fix: record with --lane between 1 and ${laneCount} (the lane whose sweep produced the finding)`);
  if (!SEVERITIES.includes(args.severity)) die(`calibrate-record requires --severity in ${SEVERITIES.join(", ")}`);
  if (!args.claim || typeof args.claim !== "string") die("calibrate-record requires --claim <what is wrong, where, why it escapes>");
  let rediscoverOf = undefined;
  if (args.rediscovers !== undefined) {
    if (!known.some((f) => f.id === args.rediscovers)) {
      die(`--rediscovers names '${args.rediscovers}', which is not a known CRITICAL/HIGH finding id on the wave's register\n  fix: link one of ${known.map((f) => f.id).join(", ")}`);
    }
    rediscoverOf = args.rediscovers;
  }
  return { lane, severity: args.severity, claim: args.claim, rediscoverOf };
}

function cmdCalibrateRecord(args) {
  const id = args._[0];
  if (!id) die("usage: calibrate-record <past-task-id> --lane <n> --severity <S> --claim <text>");
  requireKebabId(id);
  const { register } = replayFactsOf(id);
  const { lane, severity, claim, rediscoverOf } = calibrationRecordArgs(args, knownDefectsOf(register));
  const registered = mutateJson(calibrationPath(id), (text) => {
    const base = parseCalibrationForWrite(text, id);
    const appended = appendFinding(base, { id: `f${base.findings.length + 1}`, lane, severity, claim, proof: args.proof, evidence: args.evidence, rediscoverOf });
    if (typeof appended === "string") die(appended);
    return appended;
  });
  console.log(`calibration finding recorded for ${id} — ${registered.findings[registered.findings.length - 1].id} (lane ${lane}, ${severity})`);
}

/**
 * Pure: the calibration register a `calibrate` run leaves — a NEW dispatch epoch re-pinned to the
 * register's current sweep. Earlier dispatches' claims stay (append-only) but are never graded
 * again (found in review: calibrate never touched the file, so a failed dispatch's claims
 * piled into the next one's verdict until the union cleared the bar, and a re-prepared wave's
 * sweep mismatch could not be cleared by the refusal's own fix).
 */
function openDispatch(calibration, register, id, at) {
  // The closed epoch's verdict goes with it: kept, it paired the new sweep with a pass graded on another.
  const { calibrationVerdict: _closed, ...base } = calibration ?? { ...emptyFindings(id), calibration: true };
  return { ...base, passStartedAt: at, sweptBase: register.sweptBase, sweptHead: register.sweptHead, dispatchFrom: base.findings.length };
}

/** The one write `calibrate` makes: open a dispatch epoch on disk (`path` lets the self-test drive it). */
function openCalibrationDispatch(id, register, path = calibrationPath(id)) {
  return mutateJson(path, (text) => openDispatch(text === null ? null : parseRegisterForWrite(text, id, path), register, id, new Date().toISOString()));
}

/**
 * What `calibrate` runs before its bundles: every read that can refuse (the recorded wave, its
 * diff, the checklist), THEN the dispatch write — a refused calibrate never closes the standing
 * epoch. The paths and the diff reader are parameters so the self-test drives the write through
 * this seam; the helper alone let a call site that dropped the write stay green.
 */
function openReplay(id, { registerPath = findingsPath(id), path = calibrationPath(id), checklist = CHECKLIST, diffOf = diffUnderAudit } = {}) {
  const { register, known } = replayFactsOf(id, registerPath);
  const diff = diffOf({ base: register.sweptBase, head: register.sweptHead });
  const lanes = checklistLanes(checklist);
  openCalibrationDispatch(id, register, path);
  return { register, known, diff, lanes };
}

/** Pure: the claims a verdict grades — the current dispatch's only (a legacy register is one dispatch). */
function dispatchClaimsOf(calibration) {
  return calibration.findings.slice(calibration.dispatchFrom ?? 0);
}

/** Pure: did the calibration grade a different sweep than the register now records? */
function sweepMismatch(register, calibration) {
  return calibration.sweptBase !== register.sweptBase || calibration.sweptHead !== register.sweptHead;
}

/** A calibration write needs an OPEN dispatch — only `calibrate` opens one, pinned to the sweep. */
function parseCalibrationForWrite(text, id) {
  if (text === null) die(`no calibration dispatch open for '${id}' — a dispatch begins with 'calibrate ${id}', not with a write\n  fix: node tools/adversarial-runner.mjs calibrate ${id}`);
  return parseRegisterForWrite(text, id, calibrationPath(id));
}

/**
 * Grade the OPEN dispatch at the law's bar, or die on every precondition the verdict owes. The
 * load, the sweep check and the dispatch slice are one seam, so the self-test drives the wiring
 * against real files — not only the pure helpers, whose call sites a revert could silently drop.
 */
function gradeCalibration(id, registerPath = findingsPath(id), path = calibrationPath(id)) {
  const { ok, register } = loadFindings(registerPath);
  if (!ok || register === null) die(`no findings register for '${id}' — calibrate it first`);
  const known = knownDefectsOf(register);
  const { ok: calibrationOk, register: calibration, error } = loadFindings(path);
  if (!calibrationOk) die(`the calibration register does not parse: ${error}${registerRepair(path, id)}`);
  if (calibration === null) die(`no calibration register for '${id}' — run calibrate, dispatch, and calibrate-record first`);
  if (sweepMismatch(register, calibration)) {
    die(`the calibration graded a different sweep than the register now records — the wave was re-prepared between record and verdict (the f12 finding)\n  rule: a verdict about a correspondence that no longer exists certifies nothing\n  fix: node tools/adversarial-runner.mjs calibrate ${id}   (opens a fresh dispatch pinned to the current sweep), then re-dispatch and calibrate-record`);
  }
  return calibrationVerdict(known, dispatchClaimsOf(calibration), barOf(known.length));
}

function cmdCalibrateVerdict(args) {
  const id = args._[0];
  if (!id) die("usage: calibrate-verdict <past-task-id>");
  requireKebabId(id);
  if (args.bar !== undefined) die(`--bar is refused: the bar is the law — two-thirds of the known defects, rounded up — and a knob that lowers it would make the grader's failure optional (the f1 finding, demonstrated live at --bar 1)\n  fix: calibrate against a wave whose lanes can genuinely clear barOf(known), or strengthen the checklist`);
  const verdict = gradeCalibration(id);
  // The verdict is DURABLE (the f1 finding: a pass with no trace is indistinguishable from a
  // lawful one): the register records what was judged, at which bar, and when.
  mutateJson(calibrationPath(id), (text) => {
    const base = parseCalibrationForWrite(text, id);
    return { ...base, calibrationVerdict: { rediscovered: verdict.rediscovered, known: verdict.known, bar: verdict.bar, passed: !verdict.refuse, at: new Date().toISOString() } };
  });
  if (verdict.refuse) {
    die(`CALIBRATION FAILED — rediscovered ${verdict.rediscovered} of ${verdict.known} known defect(s), bar ${verdict.bar}\n  rule: the lanes are the grader, and a grader that cannot fail is not a grader — a wave dispatched by lanes that miss two-thirds of past escapes certifies nothing\n  fix: strengthen the checklist's escape classes (docs/ADVERSARIAL-CHECKLIST.md) or the bundle's audit law, then re-calibrate`);
  }
  console.log(`CALIBRATION PASSED — rediscovered ${verdict.rediscovered} of ${verdict.known} known defect(s) (bar ${verdict.bar}); the lanes can fail, so their verdicts certify`);
  if (verdict.unmatched.length > 0) {
    console.log(`  unmatched by the token heuristic (human-review these): ${verdict.unmatched.join(", ")}`);
  }
}

/** The calibration case family: the matcher, the bar, and the verdict — pure, like the law. */
function selfTestCalibration(fail) {
  const walk = "the walkCorpus manifest-skip compares corpus-relative against cwd-relative manifest paths";
  const cases = [
    ["an identical claim rediscovers", rediscovers(walk, walk)],
    ["a paraphrase rediscovers (dense specific vocabulary)", rediscovers(walk, "walkCorpus compares the manifest-skip against relative paths in the wrong coordinate system — the manifest path never matches")],
    ["a different escape does not rediscover", !rediscovers(walk, "the staged gate forgets to refuse unscoped docs-only deletions in the reader census")],
    ["generic class-level prose does not rediscover a specific defect (the saturation finding)", !rediscovers("the battery crashes in every fresh clone because the static typescript import is member five and the workflow installs nothing", "the docs wiring claims the battery fails the build but no transport invokes the register anywhere")],
    ["claimTokens drops short and stopword tokens, keeps hyphens", (() => {
      const t = claimTokens("the vendor-drift self-test refuses because six tokens");
      return t.has("vendor-drift") && t.has("self-test") && t.has("tokens") && !t.has("because");
    })()],
    ["knownDefectsOf keeps only CRITICAL and HIGH", knownDefectsOf({ findings: [{ severity: "CRITICAL", claim: "x" }, { severity: "HIGH", claim: "y" }, { severity: "MEDIUM", claim: "z" }, { severity: "LOW", claim: "w" }] }).length === 2],
    ["barOf is two-thirds rounded up — 9 known demand 6, the original grill design", barOf(9) === 6 && barOf(3) === 2 && barOf(4) === 3],
    ["the verdict passes at the bar and refuses one under it (mutual best-match)", (() => {
      const letters = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india"];
      const known = letters.map((l) => ({ severity: "HIGH", claim: `the walker coordinates defect variant ${l} manifests in manifests` }));
      const all = letters.map((l) => `walker coordinates variant ${l} restated inside manifests`);
      const pass = calibrationVerdict(known, all, 6);
      const under = calibrationVerdict(known, all.slice(0, 5), 6);
      return !pass.refuse && pass.rediscovered === 9 && under.refuse && under.rediscovered === 5;
    })()],
    ["one claim cannot blanket many knowns (the mutual-match law)", (() => {
      const known = Array.from({ length: 5 }, () => ({ severity: "HIGH", claim: "walker coordinates and manifests mismatch" }));
      return calibrationVerdict(known, ["walker coordinates and manifests mismatch"], 3).rediscovered === 1;
    })()],
    ["an explicit link counts only when the overlap shows substance", (() => {
      const known = [
        { id: "fA", severity: "HIGH", claim: "walker coordinates and manifests mismatch" },
        { id: "fB", severity: "HIGH", claim: "the staged census forgets deletions entirely" },
        { id: "fC", severity: "HIGH", claim: "an unrelated third defect about proxies" },
      ];
      const linked = calibrationVerdict(known, [{ claim: "walker coordinates variant restated inside manifests", rediscoverOf: "fA" }], 1);
      const hollow = calibrationVerdict(known, [{ claim: "an entirely battery wiring prose with no shared vocabulary at all", rediscoverOf: "fA" }], 1);
      return linked.rediscovered === 1 && !linked.refuse && hollow.rediscovered === 0 && hollow.refuse;
    })()],
    ["fewer than three known defects refuses — insufficient signal pins nothing", calibrationVerdict([{ severity: "HIGH", claim: "a" }], ["a"], 1).refuse],
    ["an empty claim never matches", !rediscovers(walk, "")],
    ["a re-calibration grades ONLY the new dispatch and re-pins the sweep — retries never pile up into a pass", (() => {
      const earlier = [1, 2, 3, 4, 5].reduce((c, n) => appendFinding(c, { id: `f${n}`, lane: 1, severity: "LOW", claim: `first dispatch claim ${n}` }), { ...emptyFindings("t9"), calibration: true, sweptBase: "b1", sweptHead: "h1" });
      const reopened = openDispatch(earlier, { sweptBase: "b2", sweptHead: "h2" }, "t9", "2026-09-27T00:00:00.000Z");
      const second = appendFinding(reopened, { id: "f6", lane: 2, severity: "LOW", claim: "second dispatch claim" });
      const graded = dispatchClaimsOf(second);
      return second.findings.length === 6 && graded.length === 1 && graded[0].id === "f6" && !sweepMismatch({ sweptBase: "b2", sweptHead: "h2" }, second);
    })()],
    ["a first calibration opens its dispatch at zero, pinned to the register's sweep", (() => {
      const first = openDispatch(null, { sweptBase: "b1", sweptHead: "h1" }, "t9", "2026-09-27T00:00:00.000Z");
      return first.task === "t9" && first.calibration === true && first.dispatchFrom === 0 && validateFindings(first) === null && !sweepMismatch({ sweptBase: "b1", sweptHead: "h1" }, first);
    })()],
    ["a reopened dispatch carries no closed epoch's calibrationVerdict — a pass graded on another dispatch never sits beside the new sweep", !("calibrationVerdict" in openDispatch({ ...emptyFindings("t9"), calibration: true, calibrationVerdict: { passed: true } }, { sweptBase: "b2", sweptHead: "h2" }, "t9", "2026-09-27T00:00:00.000Z"))],
    ["a legacy register with no dispatch mark is graded whole", dispatchClaimsOf({ findings: [{ id: "f1" }, { id: "f2" }] }).length === 2],
    ["a re-prepared wave's sweep mismatches the calibration it had", sweepMismatch({ sweptBase: "b1", sweptHead: "h9" }, { sweptBase: "b1", sweptHead: "h1" })],
  ];
  for (const [name, passes] of cases) if (!passes) fail(`adversarial-runner (calibration): ${name}`);
  return cases.length;
}

export function selfTest() {
  const failures = [];
  const fail = (m) => failures.push(m);
  const unitCases = selfTestLanes(fail) + selfTestBundle(fail) + selfTestAggregation(fail) + selfTestCalibration(fail) + selfTestChecklist(fail) + selfTestDedup(fail) + selfTestCliRefusals(fail) + selfTestRegisterFiles(fail);
  const laneCases = [
    ["lane beyond the checklist refused", laneRefusal(99, 8) !== null],
    ["lane within the checklist allowed", laneRefusal(3, 8) === null],
    ["lane zero refused", laneRefusal(0, 8) !== null],
  ];
  for (const [name, passes] of laneCases) if (!passes) fail(`adversarial-runner: ${name}`);
  const sweptCases = [
    ["the swept range is recorded and reported", sweptRangeLine({ sweptBase: "aaa", sweptHead: "bbb", sweptDiffDigest: "abc123" }) === "swept aaa..bbb (digest abc123)"],
    ["an unmarked register reports nothing", sweptRangeLine({}) === null],
  ];
  for (const [name, passes] of sweptCases) if (!passes) fail(`adversarial-runner: ${name}`);
  // ONE exit, derived from the failure list — an early return shipped a truthy case COUNT once
  // (73a8fd2) and every collected failure became invisible: exit 0, no banner, battery green.
  const total = unitCases + laneCases.length + sweptCases.length;
  console.log(failures.length === 0 ? `adversarial-runner self-test: OK (${total} cases — count derived)` : `adversarial-runner self-test: FAILED\n  ${failures.join("\n  ")}`);
  return failures.length === 0;
}

// Both sides canonical: Node realpaths the main module unless --preserve-symlinks-main, and
// argv[1] may be a symlink or name no file at all (node -e) — then this module is not the entry.
const isEntry = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isEntry) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  try {
    const [cmd, ...rest] = argv;
    const args = parseArgs(rest);
    const commands = { prepare: cmdPrepare, record: cmdRecord, resolve: cmdResolve, "wont-fix": cmdWontFix, verdict: cmdVerdict, calibrate: cmdCalibrate, "calibrate-record": cmdCalibrateRecord, "calibrate-verdict": cmdCalibrateVerdict };
    if (!commands[cmd]) die("usage: adversarial-runner.mjs <prepare|record|resolve|wont-fix|verdict|calibrate|calibrate-record|calibrate-verdict> ... (--self-test to self-test)");
    commands[cmd](args);
  } catch (e) {
    if (e instanceof Refused) {
      console.error(`adversarial-runner: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
