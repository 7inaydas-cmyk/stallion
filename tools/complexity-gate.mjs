#!/usr/bin/env node
/**
 * COMPLEXITY RATCHET — new functions may not be born convoluted, and old ones may only get simpler.
 *
 * Ported from the Antitube harness (2026-09-20), where it earned its laws. WHY IT EXISTS: every
 * other static gate judges a property that is either true or false — does it parse, does it lint,
 * is it orphaned, is there a reader. None of them can see a function getting steadily harder to
 * hold in your head, and that is the shape most CRITICAL findings in real repos actually had: the
 * fail-open branch committed by a guard nobody could reason about; the unit of work blocked
 * because three methods each write four tables in one transaction and every proposed carve line
 * cuts through one. Neither is a parse error. Both are complexity that arrived one plausible
 * branch at a time.
 *
 * A RATCHET, NOT A LIMIT. A repo-wide threshold flipped on a live codebase produces a wall of
 * errors that teaches --no-verify. Existing over-threshold functions are recorded in the BASELINE
 * (docs/gates/complexity-baseline.json) at exactly the number they have today. What fails is
 * movement in the wrong direction:
 *
 *   1. a NEW function over the threshold that no test names       (born convoluted and unpinned)
 *   2. a BASELINED function whose complexity went UP              (the ratchet slipping)
 *   3. a baseline row that no longer matches reality              (a stale baseline is a dead gate)
 *
 * (3) is not bookkeeping: a baseline nobody is forced to update becomes a list of exemptions for
 * code that has since moved. Refreshing is --update-baseline — a deliberate act that shows in a diff.
 *
 * KNOWN HOLE, stated rather than discovered later. A new over-threshold function that a test DOES
 * name is permitted and is NOT written to the baseline, so the ratchet never grips it; recording
 * it would make the baseline grow on every legitimate addition, which turns a register into
 * noise. (1) is the birth check, (2) is the ratchet, and only functions over the line at baseline
 * time are ratcheted.
 *
 * THE TEST-NAMES HATCH IS CLOSED IN THIS REPO, HONESTLY. Upstream, the hatch asks "is the
 * function's identifier mentioned anywhere in the TEST CORPUS?" — a floor, never CRAP. Stallion's
 * tests are embedded self-tests inside the same files as the source, so a mention corpus drawn
 * from the source files would mention every declaration and open the hatch for everything. The
 * config therefore ships testGlobs EMPTY: no function is hatch-permitted here, and a new
 * over-threshold function must be split or consciously baselined. Vendors with real test files
 * set testGlobs and get the upstream behaviour.
 *
 * METRIC. McCabe cyclomatic complexity: 1 + each decision point (if · ?: · for/for-in/for-of ·
 * while · do · case · catch · && · || · ??), attributed to the NEAREST enclosing function so a
 * nested arrow's branches are its own and are not also charged to its parent.
 *
 * PARSING. The TypeScript compiler API (an OPTIONAL peer dependency — stallion's tools are
 * dependency-free at runtime; this gate is the one deliberate exception, declared in
 * package.json), which reads .ts/.tsx AND .mjs/.js. "The control could not see the file" is the
 * most-repeated incident class in the harness this came from.
 *
 * Usage:
 *   node tools/complexity-gate.mjs                    # gate
 *   node tools/complexity-gate.mjs --report           # every function over the threshold
 *   node tools/complexity-gate.mjs --update-baseline  # re-record; deliberate, reviewable
 *   node tools/complexity-gate.mjs --self-test        # proves the analyser discriminates
 */

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
// This gate's own repo-relative path, derived — never hand-written: every self-reference keys on it.
// The literal "tools/complexity-gate.mjs" matched no copy vendored elsewhere (tools/harness/ in the
// Antitube harness), so the self-exemption alarm filtered for a file that did not exist and stayed
// green there. Defined before the compiler import: its refusal (noCompilerFix) reads it.
const SELF_REL = relative(ROOT, fileURLToPath(import.meta.url)).replaceAll("\\", "/");
// The compiler is the OPTIONAL peer dependency (see package.json): a missing typescript must
// refuse with a fix line naming the two honest exits, not crash the battery with a bare
// ERR_MODULE_NOT_FOUND (an adversarial finding: the static import made the battery unrunnable
// in any fresh clone).
let ts;
try {
  ts = await import("typescript");
} catch {
  console.error("complexity-gate: the TypeScript compiler is not installed — the ratchet cannot count what it cannot parse");
  console.error(`  fix: ${noCompilerFix()}`);
  process.exit(1);
}
import { matches } from "./pathspec.mjs";
import { listedOnDisk, shq, skippedNote, stagedMissingRefusal } from "./test-lint.mjs";

/**
 * The missing-compiler fix names EVERY gate file that registers this tool — a partial list left
 * guard-reach red — read off the gate directory when the refusal prints, never listed here. In a
 * vendoring host those files are the host's own: a hardcoded list of ours turned the host's honest
 * registration of this gate into a red self-test it could clear only by patching vendored code.
 */
export function noCompilerFix(gatesDir = `${ROOT}docs/gates`) {
  const named = registrations(gatesDir);
  const entries = named.length > 0 ? `, and every entry naming it in ${named.join(", ")}` : "";
  const modes = named.includes("docs/gates/guard-reach.json") ? " (guard-reach rewrites guard-reach-modes.json itself)" : "";
  return `npm install -D typescript (an optional peer dep, dev-time only) — or vendor without this gate: delete ${SELF_REL} and drop its battery line, docs/gates/complexity*.json${entries}${modes}`;
}

/** The gate files (`docs/gates/*.json`, this gate's own complexity* aside) that name this tool. */
function registrations(gatesDir) {
  return (existsSync(gatesDir) ? readdirSync(gatesDir) : [])
    .filter((file) => file.endsWith(".json") && !file.startsWith("complexity"))
    .filter((file) => readFileSync(join(gatesDir, file), "utf8").includes(SELF_REL))
    .map((file) => `docs/gates/${file}`);
}

const CONFIG_PATH = "docs/gates/complexity.json";
export const BASELINE_PATH = "docs/gates/complexity-baseline.json";
const CONFIG_SHAPE = '{"threshold": 8, "includes": ["tools/**/*.mjs"], "excludes": ["**/node_modules/**", "**/fixtures/**"], "testGlobs": []}';
// --update-baseline cannot recreate a missing CONFIG (it needs one to run, and writes only the
// baseline), so the config's fix is a restore; the baseline's is a restore or a deliberate re-record.
const RESTORE_CONFIG = `git checkout -- ${CONFIG_PATH} (or copy it from the vendor template at docs/gates/) — shape: ${CONFIG_SHAPE}`;
const RESTORE_BASELINE = `git checkout -- ${BASELINE_PATH} (or resolve its merge conflict); a deliberate re-record is node ${SELF_REL} --update-baseline`;

/**
 * Config: threshold, includes, excludes, testGlobs — all repo data, none in this file. Fail
 * closed on every malformation shape (missing, unparseable, wrong types, empty includes) with a
 * fix line naming the path: a gate that cannot read its config must not pass. Returns
 * `{ ok: true, config }` or `{ ok: false, reason }` instead of exiting, so the self-test drives
 * every refusal from fixture files; the CLI dies on a refusal through `orDie`.
 */
function loadConfig(path = `${ROOT}${CONFIG_PATH}`) {
  if (!existsSync(path)) return refused(`${CONFIG_PATH} is missing — the ratchet cannot run blind\n  fix: ${RESTORE_CONFIG}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return refused(`${CONFIG_PATH} does not parse: ${e.message}\n  fix: repair the JSON — shape: ${CONFIG_SHAPE}`);
  }
  const shape = configShapeError(parsed);
  if (shape !== null) return refused(`${CONFIG_PATH} ${shape}\n  fix: repair the config — shape: ${CONFIG_SHAPE}`);
  return { ok: true, config: { threshold: parsed.threshold, includes: parsed.includes, excludes: parsed.excludes, testGlobs: parsed.testGlobs } };
}

const refused = (reason) => ({ ok: false, reason });
const isGlobArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

/** The config's shape law, pure: the first malformation as refusal text, or null. */
function configShapeError(parsed) {
  if (!Number.isInteger(parsed?.threshold) || parsed.threshold < 2) return "field 'threshold' must be an integer >= 2";
  const bad = ["includes", "excludes"].find((key) => !isGlobArray(parsed[key]) || parsed[key].length === 0);
  if (bad !== undefined) return `field '${bad}' must be a non-empty array of glob strings`;
  if (!isGlobArray(parsed.testGlobs)) return "field 'testGlobs' must be an array of glob strings (empty = the test-names hatch is CLOSED)";
  return null;
}

/** The CLI boundary: a loader's refusal exits here, so the loaders themselves stay drivable. */
function orDie(loaded, key) {
  return loaded.ok ? loaded[key] : die(loaded.reason);
}

function die(message) {
  console.error(`complexity-gate: ${message}`);
  process.exit(1);
}

/**
 * Every source file git would carry — staged, committed, AND untracked-but-not-ignored.
 * `--others --exclude-standard` is not belt-and-braces: the first violation ever run through the
 * upstream gate PASSED because plain `git ls-files` lists the INDEX and the violating file was
 * new and unstaged. Ask git the wider question.
 *
 * `excludes` is a PARAMETER, not a closed-over constant: the source sweep must exclude test
 * files while the test-corpus lookup exists to read exactly those files. Sharing one exclude list
 * between both sweeps once made the "does a test name this?" hatch search 2 files out of 168 —
 * the gate failed closed (nothing shipped wrong) but its header claimed a check the code did not
 * perform, found only by a falsification sweep because the output was green and correct-looking.
 *
 * `-z`, split on NUL: without it git C-quotes a non-ASCII path and the quoted name matches no glob.
 *
 * The LIST is the index and the scan reads the WORKING TREE, so this one site guards both readers
 * (scan and testMentions), splitting the list with test-lint's listedOnDisk — one law. A listed
 * path with no regular file on disk and no staged change (an unstaged rm, or any `git rm`/`git mv`
 * under guard-reach's HEAD-index baseline) is skipped, NAMED via `note`, and pushed onto `skipped`
 * so scan can judge its baseline rows (refuseMissingSources). One with a staged change (staged, then
 * deleted) refuses: the next commit carries it and nothing here can read it. Exported for the
 * self-test's child probe, since the refusal exits.
 * ponytail: working tree only — reading the index blob (`git show :path`) was rejected: under the
 * HEAD index it re-scans a `git rm`'d file whose baseline rows the author removed and reports it
 * born convoluted, the same false red again. So a skipped path's content is NOT re-judged here,
 * the same boundary as a committed file edited on disk; a clean-clone run judges it.
 */
export function trackedFiles(globs, excludes, cwd = ROOT, env = process.env, note = console.error, skipped = []) {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd, env })
    .split("\0")
    .filter(Boolean)
    .filter((f) => globs.some((g) => matches(f, g)) && !excludes.some((g) => matches(f, g)));
  const split = listedOnDisk(cwd, env, listed);
  for (const p of split.stagedMissing) console.error(`complexity-gate: ${stagedMissingRefusal(p)}`);
  if (split.stagedMissing.length > 0) process.exit(1);
  if (split.skipped.length > 0) note(`complexity-gate: ${skippedNote(split.skipped)}`);
  skipped.push(...split.skipped);
  return split.present;
}

/**
 * A skipped path the INDEX lists — a file or link HEAD holds, a skip-worktree entry, or an
 * intent-to-add entry (which is how colocated jj writes a file added in its working-copy commit) —
 * with rows in the baseline is a source whose next commit nothing here can see: `git commit` keeps
 * HEAD's copy, and so does a sparse checkout (git's or jj's) that leaves it out, and `jj commit`
 * keeps a file it added; `git commit -a` and `jj commit` record a plain rm as its deletion. Every
 * guess shipped a red tip — dropping the rows let --update-baseline strip a source a commit still
 * keeps; carrying them kept a deleted file's ceilings behind a false green; carrying on git's
 * skip-worktree bit was blind to jj (which ignores the bit, and whose own sparse patterns never
 * set it) and to guard-reach's HEAD-index copy (which carries no bits). So scan REFUSES — gate,
 * --report and --update-baseline alike — until the source is back on disk or its deletion is
 * staged: the ratchet judges only sources it can read. The delete exit is conditioned on a full
 * checkout in the text alone — under jj's sparse patterns a git rm deletes nothing jj commits, and
 * nothing here can read jj's patterns. A path the index does not list (an untracked dangling link)
 * carries no source into any commit, so its rows go stale. An unreadable baseline refuses with the
 * restore alone: RESTORE_BASELINE's re-record route would die here again.
 */
function refuseMissingSources(skipped) {
  if (skipped.length === 0) return;
  const loaded = loadBaseline();
  if (!loaded.ok) die(`${loaded.reason.split("\n")[0]} — and it may hold the ceilings of ${skipped.length} path(s) missing from disk\n  fix: git checkout -- ${BASELINE_PATH} (or resolve its merge conflict)`);
  const held = indexListed(skipped.filter((p) => loaded.baseline.functions.some((row) => row.file === p)));
  for (const p of held) console.error(`complexity-gate: ${missingSourceRefusal(p)}`);
  if (held.length > 0) process.exit(1);
}

const missingSourceRefusal = (p) =>
  `${p} has no regular file on disk and no staged change, and ${BASELINE_PATH} holds its ceilings — whether the next commit keeps its source is not visible here (\`git commit\` keeps HEAD's copy and \`jj commit\` a file it added, even where a sparse checkout leaves them out; \`git commit -a\` and \`jj commit\` record a plain rm as its deletion)\n  fix: put it back on disk (a file HEAD holds: git --literal-pathspecs checkout HEAD -- ${shq(p)}; a link: restore its target; a file HEAD never held, an intent-to-add entry: re-create it; left out by a sparse checkout, git's or jj's: widen the checkout to include it) or, if you deleted it for good in a full checkout, stage the deletion and re-record (git --literal-pathspecs rm --ignore-unmatch -- ${shq(p)} && node ${SELF_REL} --update-baseline — it writes fence surface: land it under a protected task)`;

/** Which of `paths` the index lists. Every path is literal, here and in each printed exit: a name
 *  starting with `:` is a path, not pathspec magic (`:!x.mjs` would name every OTHER file). The
 *  query spells it per path, `:(literal)`, because git refuses the global --literal-pathspecs
 *  beside a GIT_ICASE/GLOB/NOGLOB_PATHSPECS a developer may export. */
function indexListed(paths) {
  if (paths.length === 0) return [];
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--", ...paths.map((p) => `:(literal)${p}`)], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0");
  return paths.filter((p) => listed.includes(p));
}

const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.Constructor,
]);

/**
 * One decision point each. `default:` is deliberately absent — it is the fallthrough, not a
 * branch. Written as set membership rather than the switch it obviously wants to be, because the
 * switch scored 14 against this gate's own threshold — and a control whose first act is to exempt
 * itself has already taught the lesson it exists to prevent.
 */
const DECISION_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
]);

const SHORT_CIRCUIT_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

function decisionPointsOf(node) {
  if (DECISION_KINDS.has(node.kind)) return 1;
  if (node.kind === ts.SyntaxKind.BinaryExpression && SHORT_CIRCUIT_OPERATORS.has(node.operatorToken.kind)) return 1;
  return 0;
}

/** A name a human would recognise in a failure message — the binding an anonymous function is assigned to. */
function ownerClassName(node) {
  const owner = node.parent;
  return owner && ts.isClassDeclaration(owner) && owner.name ? owner.name.text : null;
}

const NAME_BINDING_TESTS = [ts.isVariableDeclaration, ts.isPropertyAssignment, ts.isPropertyDeclaration];

function bindingName(parent) {
  if (!parent) return null;
  const bound = NAME_BINDING_TESTS.some((is) => is(parent));
  return bound && ts.isIdentifier(parent.name) ? parent.name.text : null;
}

function nameOf(node, source) {
  if (node.kind === ts.SyntaxKind.Constructor) {
    const cls = ownerClassName(node);
    return cls ? `${cls}.constructor` : "constructor";
  }
  if (node.name && ts.isIdentifier(node.name)) {
    const cls = ownerClassName(node);
    return cls ? `${cls}.${node.name.text}` : node.name.text;
  }
  const bound = bindingName(node.parent);
  if (bound) return bound;
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  return `<anonymous>:${line}`;
}

/** Every function in `text`, with its cyclomatic complexity. Exported for the self-test. */
export function analyse(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.Unknown);
  const found = [];

  const walk = (node, current) => {
    if (FUNCTION_KINDS.has(node.kind)) {
      const record = {
        file,
        name: nameOf(node, source),
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        complexity: 1,
      };
      found.push(record);
      // Branches inside a nested function belong to that function, so `record` becomes the target
      // for everything below this node until the next function boundary.
      ts.forEachChild(node, (child) => walk(child, record));
      return;
    }
    if (current) current.complexity += decisionPointsOf(node);
    ts.forEachChild(node, (child) => walk(child, current));
  };

  ts.forEachChild(source, (child) => walk(child, null));
  return found;
}

/** Every function in the tracked corpus over the threshold — refused while a baselined source is missing from disk (refuseMissingSources). */
export function scan(config = orDie(loadConfig(), "config")) {
  const over = [];
  const skipped = [];
  for (const file of trackedFiles(config.includes, config.excludes, ROOT, process.env, console.error, skipped)) {
    for (const fn of analyse(file, readFileSync(`${ROOT}${file}`, "utf8"))) {
      if (fn.complexity > config.threshold) over.push(fn);
    }
  }
  refuseMissingSources(skipped);
  return over.sort((a, b) => b.complexity - a.complexity || a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}

/** Identifiers the test corpus mentions. Empty testGlobs = the hatch is closed (see header). */
function testMentions(config) {
  const mentioned = new Set();
  for (const file of trackedFiles(config.testGlobs, ["**/node_modules/**"])) {
    for (const m of readFileSync(`${ROOT}${file}`, "utf8").matchAll(/[A-Za-z_$][\w$]*/g)) mentioned.add(m[0]);
  }
  return mentioned;
}

const keyOf = (fn) => `${fn.file}::${fn.name}`;

/**
 * The ceilings. An ABSENT baseline is an empty one — a fresh vendor has recorded nothing yet. An
 * unparseable or wrong-shaped one REFUSES: a catch-all once turned a merge-conflicted baseline into
 * 42 "born convoluted" misdiagnoses (and, with testGlobs set, into no ceilings at all), and a `{}`
 * into a TypeError stack instead of a refusal.
 */
function loadBaseline(path = `${ROOT}${BASELINE_PATH}`) {
  if (!existsSync(path)) return { ok: true, baseline: { threshold: null, functions: [] } };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return refused(`${BASELINE_PATH} does not parse: ${e.message}\n  fix: ${RESTORE_BASELINE}`);
  }
  if (!Array.isArray(parsed?.functions) || !parsed.functions.every(isBaselineRow)) {
    return refused(`${BASELINE_PATH} field 'functions' must be an array of {file, name, complexity} rows\n  fix: ${RESTORE_BASELINE}`);
  }
  return { ok: true, baseline: parsed };
}

const isBaselineRow = (row) => typeof row?.file === "string" && typeof row?.name === "string" && Number.isInteger(row?.complexity);

export function readBaseline() {
  return orDie(loadBaseline(), "baseline");
}

/**
 * The three failure directions. Pure, so the self-test can drive it with fixtures instead of the
 * repo — a checker only ever exercised against a tree that passes is a checker nobody has watched
 * discriminate. `hatchOpen` (testGlobs non-empty) only chooses which remedy the birth refusal
 * prints; what is permitted is decided by `mentioned` alone.
 */
export function judge(current, baseline, mentioned, threshold, hatchOpen = false) {
  const errors = [];
  const recorded = new Map(baseline.functions.map((f) => [`${f.file}::${f.name}`, f.complexity]));
  const seen = new Set();
  const collided = sameNameCollisions(current);

  for (const fn of current) {
    const key = keyOf(fn);
    seen.add(key);
    if (collided.has(key)) {
      errors.push(
        `${fn.file}:${fn.line} ${fn.name} — ${collided.get(key)} functions share this name in this file, so they share one baseline ceiling. Rename them; the gate will not guess which rise is which.`,
      );
      continue;
    }
    const was = recorded.get(key);
    if (was === undefined) {
      // 1. Born over the threshold. Permitted only if a test names it — where a test corpus exists.
      const nameOnly = fn.name.split(".").pop();
      if (!mentioned.has(nameOnly)) {
        errors.push(
          `${fn.file}:${fn.line} ${fn.name} — cyclomatic complexity ${fn.complexity} exceeds ${threshold} and no test names it.\n  fix: ${bornRemedy(threshold, hatchOpen)}`,
        );
      }
      continue;
    }
    // 2. The ratchet. Baselined functions may fall, never rise.
    if (fn.complexity > was) {
      errors.push(
        `${fn.file}:${fn.line} ${fn.name} — complexity rose ${was} -> ${fn.complexity}. The baseline is a ceiling, not an allowance.\n  fix: bring ${fn.name} back to ${was} or below — split out the branches that arrived`,
      );
    }
  }

  errors.push(...staleBaselineErrors(baseline, seen, threshold));
  return errors;
}

/** The test-names hatch is open only where testGlobs names a test corpus (see header). */
const hatchOpenOf = (config) => config.testGlobs.length > 0;

/**
 * The birth refusal names only exits that exist HERE. With testGlobs empty the test-names hatch is
 * closed, so "pin it with a test" sent an agent to write a test the gate then ignored.
 */
function bornRemedy(threshold, hatchOpen) {
  const split = `split it until each piece is at or under ${threshold}`;
  if (hatchOpen) return `${split}, or name it in a test under testGlobs (${CONFIG_PATH}) that exercises its branches`;
  return `${split} — the test-names hatch is CLOSED here (testGlobs in ${CONFIG_PATH} is empty); a deliberate exemption is node ${SELF_REL} --update-baseline, landed under a protected task (${BASELINE_PATH} is fence surface)`;
}

/**
 * SAME-NAME FUNCTIONS IN ONE FILE SILENTLY SHARE A SINGLE CEILING (found upstream 2026-09-16,
 * after a recorded explanation had the mechanism backwards — the rows do not "pair in order", the
 * Map key collapses them). Two live functions with one key both compare against the one recorded
 * row: the smaller can rise to just-under the larger's ceiling with no error. judge refuses them.
 */
function sameNameCollisions(current) {
  const occurrences = new Map();
  for (const fn of current) {
    const k = keyOf(fn);
    occurrences.set(k, (occurrences.get(k) ?? 0) + 1);
  }
  return new Map([...occurrences].filter(([, n]) => n > 1));
}

/** 3. A baseline that no longer describes the tree — an exemption for code that no longer needs one. */
function staleBaselineErrors(baseline, seen, threshold) {
  const errors = [];
  for (const row of baseline.functions) {
    if (!seen.has(`${row.file}::${row.name}`)) {
      errors.push(
        `${BASELINE_PATH} still exempts ${row.file} ${row.name} (${row.complexity}), which is gone or now under ${threshold}.\n  fix: node ${SELF_REL} --update-baseline (it writes fence surface: land it under a protected task)`,
      );
    }
  }
  return errors;
}

/** `[file, source, function, expected complexity]`. A straight-line function is 1; each construct adds one. */
const METRIC_CASES = [
  ["p.ts", "function f(a){ return a; }", "f", 1],
  ["p.ts", "function f(a,b,c){ if (a) return 1; return 2; }", "f", 2],
  ["p.ts", "function f(a,b,c){ return a ? 1 : 2; }", "f", 2],
  ["p.ts", "function f(a,b,c){ for (const x of a) g(x); }", "f", 2],
  ["p.ts", "function f(a,b,c){ for (let i=0;i<a;i++) g(i); }", "f", 2],
  ["p.ts", "function f(a,b,c){ for (const k in a) g(k); }", "f", 2],
  ["p.ts", "function f(a,b,c){ while (a) g(); }", "f", 2],
  ["p.ts", "function f(a,b,c){ do { g(); } while (a); }", "f", 2],
  // `default:` is the fallthrough, not a branch — two cases plus a default is 3, not 4.
  ["p.ts", "function f(a,b,c){ switch (a) { case 1: return 1; case 2: return 2; default: return 3; } }", "f", 3],
  ["p.ts", "function f(a,b,c){ try { g(); } catch { h(); } }", "f", 2],
  ["p.ts", "function f(a,b,c){ return a && b; }", "f", 2],
  ["p.ts", "function f(a,b,c){ return a || b; }", "f", 2],
  ["p.ts", "function f(a,b,c){ return a ?? b; }", "f", 2],
  ["p.ts", "function f(a,b,c){ if (a && b) { if (c) return 1; } return 2; }", "f", 4],
  // Nested functions are their OWN score and are not also charged to the parent. Without this a
  // module of small callbacks reads as one enormous function and the gate becomes noise.
  ["p.ts", "function outer(a){ const inner = (b) => b ? 1 : 2; return a ? inner : null; }", "outer", 2],
  ["p.ts", "function outer(a){ const inner = (b) => b ? 1 : 2; return a ? inner : null; }", "inner", 2],
  // .mjs must be parsed: a control that cannot see the files the typechecker cannot see is the
  // exact class this repo keeps re-learning.
  ["p.mjs", "export function f(a){ return a ? 1 : 2; }", "f", 2],
];

/** `[source, expected name of the first function]` — a failure that cannot name its function gets ignored. */
const NAMING_CASES = [
  ["const named = (a) => a;", "named"],
  ["class Svc { handle(a){ return a; } }", "Svc.handle"],
  ["const o = { prop: (a) => a };", "prop"],
  ["export function decl(a){ return a; }", "decl"],
];

function selfTestMetric(fail) {
  for (const [file, source, fn, expected] of METRIC_CASES) {
    const got = analyse(file, source).find((f) => f.name === fn)?.complexity;
    if (got !== expected) fail(`${fn} in ${JSON.stringify(source)} scored ${got}, expected ${expected}`);
  }
  for (const [source, expected] of NAMING_CASES) {
    const got = analyse("p.ts", source)[0]?.name;
    if (got !== expected) fail(`${JSON.stringify(source)} named "${got}", expected "${expected}"`);
  }
}

function selfTestJudge(fail) {
  const T = 8;
  const fnA = { file: "a.ts", name: "big", line: 1, complexity: 12 };
  const base = { threshold: T, functions: [{ file: "a.ts", name: "big", complexity: 12 }] };
  if (judge([fnA], base, new Set(), T).length !== 0) fail("an unchanged baselined function was reported");
  if (judge([{ ...fnA, complexity: 13 }], base, new Set(), T).length !== 1) fail("a RISING baselined complexity was not caught (the ratchet)");
  if (judge([{ ...fnA, complexity: 11 }], base, new Set(), T).length !== 0) fail("a FALLING complexity was reported — the ratchet must only bite upward");
  if (judge([], base, new Set(), T).length !== 1) fail("a stale baseline row was not caught");
  const born = { file: "b.ts", name: "fresh", line: 4, complexity: 9 };
  if (judge([fnA, born], base, new Set(), T).length !== 1) fail("a NEW over-threshold function with no test was not caught");
  if (judge([fnA, born], base, new Set(["fresh"]), T).length !== 0) fail("a NEW over-threshold function that a test names was still refused");
  // A class method is keyed `Class.method`; the test lookup must use the bare method name or every
  // method in the repo reads as untested.
  const method = { file: "c.ts", name: "Svc.handle", line: 2, complexity: 9 };
  if (judge([fnA, method], base, new Set(["handle"]), T).length !== 0) fail("a class method named by a test was refused (bare-name lookup broken)");
}

/** `[fixture, file body (null = absent), refusal expected]` — every shape loadConfig promises to refuse. */
const CONFIG_CASES = [
  ["valid config", '{"threshold": 8, "includes": ["tools/**/*.mjs"], "excludes": ["**/fixtures/**"], "testGlobs": []}', false],
  ["missing config", null, true],
  ["unparseable config", "{not json", true],
  ["null config", "null", true],
  ["string-threshold config", '{"threshold": "8", "includes": ["a"], "excludes": ["b"], "testGlobs": []}', true],
  ["fractional-threshold config", '{"threshold": 8.5, "includes": ["a"], "excludes": ["b"], "testGlobs": []}', true],
  ["threshold-below-2 config", '{"threshold": 1, "includes": ["a"], "excludes": ["b"], "testGlobs": []}', true],
  ["empty-includes config", '{"threshold": 8, "includes": [], "excludes": ["b"], "testGlobs": []}', true],
  ["non-string-excludes config", '{"threshold": 8, "includes": ["a"], "excludes": [1], "testGlobs": []}', true],
  ["no-testGlobs config", '{"threshold": 8, "includes": ["a"], "excludes": ["b"]}', true],
];

/** The same for loadBaseline. An ABSENT baseline is an empty one (a fresh vendor has recorded nothing). */
const BASELINE_CASES = [
  ["valid baseline", '{"threshold": 8, "functions": [{"file": "a.mjs", "name": "f", "complexity": 9}]}', false],
  ["absent baseline", null, false],
  ["unparseable baseline", "<<<<<<< HEAD\n{", true],
  ["shapeless baseline", "{}", true],
  ["row-less baseline", '{"functions": [{"file": "a.mjs", "name": "f"}]}', true],
];

function fixture(dir, name, body) {
  const path = join(dir, `${name.replaceAll(" ", "-")}.json`);
  if (body !== null) writeFileSync(path, body);
  return path;
}

function expectVerdict(fail, name, refuses, loaded) {
  if (loaded.ok === refuses) fail(`the ${name} fixture was ${refuses ? "accepted" : `refused: ${loaded.reason}`}`);
  if (!loaded.ok && !loaded.reason.includes("\n  fix: ")) fail(`the ${name} fixture was refused without a fix line`);
}

/** The loaders' fail-closed refusals, driven from real files: an undriven refusal is decoration. */
function selfTestLoaders(fail) {
  const dir = mkdtempSync(join(tmpdir(), "complexity-gate-"));
  try {
    for (const [name, body, refuses] of CONFIG_CASES) expectVerdict(fail, name, refuses, loadConfig(fixture(dir, name, body)));
    for (const [name, body, refuses] of BASELINE_CASES) expectVerdict(fail, name, refuses, loadBaseline(fixture(dir, name, body)));
    // The missing-config fix must be one that works: --update-baseline needs the config to run at
    // all, and writes only the baseline.
    const missing = String(loadConfig(join(dir, "absent.json")).reason);
    if (!missing.includes(" is missing")) fail(`an absent config was not refused as missing: ${missing}`);
    if (missing.includes("--update-baseline")) fail("missing-config-fix-circular: the missing-config fix names --update-baseline, which dies on the same missing config");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every refusal names a fix that exists HERE — the test hatch is closed while testGlobs is empty. */
function selfTestRemedies(fail) {
  const big = { file: "a.ts", name: "big", line: 1, complexity: 12 };
  const born = { file: "b.ts", name: "fresh", line: 4, complexity: 9 };
  const base = { threshold: 8, functions: [{ file: "a.ts", name: "big", complexity: 12 }] };
  // Driven through hatchOpenOf, the switch both call sites use: the remedy AND the switch are pinned.
  const [closed] = judge([big, born], base, new Set(), 8, hatchOpenOf({ testGlobs: [] }));
  if (!closed.includes("\n  fix: ") || /pin it with a test|name it in a test/.test(closed) || !closed.includes("CLOSED")) fail("born-remedy-closed-hatch: with testGlobs empty the birth refusal still offers the closed test hatch as its fix");
  const [open] = judge([big, born], base, new Set(), 8, hatchOpenOf({ testGlobs: ["**/*.test.ts"] }));
  if (!open.includes("name it in a test under testGlobs") || open.includes("CLOSED")) fail("born-remedy-open-hatch: with testGlobs set the birth refusal does not offer the test route, or calls the hatch closed");
  const [rose] = judge([{ ...big, complexity: 13 }], base, new Set(), 8);
  if (!rose.includes("\n  fix: ")) fail("rise-without-fix: the ratchet refusal names no fix");
  const [stale] = judge([], base, new Set(), 8);
  if (!stale.includes(`\n  fix: node ${SELF_REL} --update-baseline`)) fail("stale-fix-not-a-command: the stale-row refusal does not print the runnable refresh command");
}

/**
 * The opt-out fix must name every gate file that registers this tool, or following it leaves the
 * battery red. Driven from a fixture directory, not the live one: the live docs/gates is a host's
 * own data, and judging it against a list of ours failed every host that registered this gate.
 */
function selfTestOptOut(fail) {
  const dir = mkdtempSync(join(tmpdir(), "complexity-gate-gates-"));
  try {
    writeFileSync(join(dir, "gate-registry.json"), `{"gates": [{"id": "complexity-ratchet", "invocation": "node ${SELF_REL}"}]}`);
    writeFileSync(join(dir, "guard-reach.json"), `{"entries": [{"script": "${SELF_REL}"}]}`);
    writeFileSync(join(dir, "complexity.json"), `{"_comment": "read by ${SELF_REL}"}`);
    writeFileSync(join(dir, "unrelated.json"), "{}");
    const fix = noCompilerFix(dir);
    if (!fix.includes("docs/gates/gate-registry.json")) fail(`opt-out-fix-host-registration: a host gate file that registers ${SELF_REL} is not named in the missing-compiler fix`);
    for (const rel of ["docs/gates/gate-registry.json", "docs/gates/guard-reach.json"]) {
      if (!fix.includes(rel)) fail(`opt-out-fix-incomplete: ${rel} registers ${SELF_REL}, but the missing-compiler fix does not say to drop it`);
    }
    if (/docs\/gates\/(?:complexity|unrelated)\.json/.test(fix)) fail(`opt-out-fix-overreach: the missing-compiler fix names a gate file that does not register this tool: ${fix}`);
    // task-coverage --doctor requires every self-testing tool in tools/ to ride the battery, so
    // dropping the battery line while the file stays leaves the doctor red.
    if (!fix.includes(`delete ${SELF_REL}`)) fail(`opt-out-keeps-tool: the missing-compiler fix drops the battery line but keeps ${SELF_REL}, which task-coverage --doctor then refuses`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The listing, run for real: git C-quotes a non-ASCII, `"` or `\` path in plain `ls-files`
 *  output (`"tools/caf\303\251.mjs"`), which no include glob matches — the file fell out of the
 *  scan with nothing printed. Driven in a scratch repo with the inherited GIT_* env removed: inside
 *  a hook GIT_DIR / GIT_INDEX_FILE name the HOST repo. core.quotePath is forced back on: under a
 *  user's `quotepath = false` git prints the name raw and a listing without -z passed this case.
 *  The same listing is the INDEX while the scan reads the DISK: a committed source deleted but not
 *  staged (or any `git rm` judged under guard-reach's HEAD-index baseline) died on ENOENT in scan().
 *  It must be skipped AND named, while a tracked source still on disk (kept) and an untracked one
 *  (café) both still reach the scan — a filter that dropped every index path would pass the rest. */
function selfTestTrackedNames(fail) {
  const dir = mkdtempSync(join(tmpdir(), "complexity-gate-ls-"));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.quotePath",
    GIT_CONFIG_VALUE_0: "true",
  };
  const git = (...args) => execFileSync("git", ["-c", "user.name=selftest", "-c", "user.email=selftest@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, env, stdio: "ignore" });
  try {
    mkdirSync(join(dir, "tools"));
    for (const name of ["café.mjs", "kept.mjs", "gone.mjs"]) writeFileSync(join(dir, "tools", name), "x\n");
    git("init", "-q");
    git("add", "tools/kept.mjs", "tools/gone.mjs");
    git("commit", "-q", "-m", "seed");
    rmSync(join(dir, "tools", "gone.mjs"));
    symlinkSync("nowhere.mjs", join(dir, "tools", "link.mjs"));
    const notes = [];
    const seen = trackedFiles(["tools/**/*.mjs"], [], dir, env, (line) => notes.push(line));
    if (!seen.includes("tools/café.mjs")) fail(`quoted-path-invisible: a non-ASCII source path never reaches the scan (saw: ${seen.join(", ")})`);
    if (!seen.includes("tools/kept.mjs")) fail(`present-source-dropped: a tracked source present on disk never reaches the scan (saw: ${seen.join(", ")})`);
    if (seen.includes("tools/gone.mjs")) fail(`vanished-source-read: a tracked source missing from disk is still handed to the reader (saw: ${seen.join(", ")})`);
    if (!notes.join("\n").includes("tools/gone.mjs")) fail(`vanished-source-silent: a skipped tracked source is not named, so an accidental rm goes unseen (notes: ${notes.join(" | ")})`);
    // An untracked dangling link (listed through --others) was named a "tracked path ... (content
    // equals HEAD)": the note must say what was checked — no regular file, no staged change.
    if (!/no regular file on disk and no staged change: .*tools\/link\.mjs/.test(notes.join("\n"))) fail(`skip-label-false: a skipped path is named as something the check never proved (notes: ${notes.join(" | ")})`);
    selfTestStagedMissing(fail, dir, env, git);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Content staged and then deleted from disk exists only in the index: skipping it would pass the
 *  commit that carries it, so the listing REFUSES with the two remedies. Run in a child, because
 *  the refusal exits the process. */
function selfTestStagedMissing(fail, dir, env, git) {
  writeFileSync(join(dir, "tools", "new.mjs"), "x\n");
  git("add", "tools/new.mjs");
  rmSync(join(dir, "tools", "new.mjs"));
  const probe = `(await import(${JSON.stringify(import.meta.url)})).trackedFiles(["tools/**/*.mjs"], [], ${JSON.stringify(dir)});`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8", env });
  const refusal = "complexity-gate: tools/new.mjs is staged but missing from disk";
  const fix = "fix: restore it (git --literal-pathspecs checkout -- tools/new.mjs, and a link's target) or, if you deleted it for good in a full checkout, stage the deletion (git --literal-pathspecs rm -- tools/new.mjs)";
  if (run.status !== 1 || !run.stderr.includes(refusal) || !run.stderr.includes(fix)) fail(`staged-missing-unjudged: staged content missing from disk must refuse with its remedy (exit ${run.status}: ${run.stderr.trim()})`);
}

function selfTestJudgeCollisions(fail) {
  const dupBig = { file: "d.ts", name: "dup", line: 1, complexity: 26 };
  const dupSmall = { file: "d.ts", name: "dup", line: 9, complexity: 10 };
  const dupBase = { threshold: 8, functions: [{ file: "d.ts", name: "dup", complexity: 26 }] };
  const judged = judge([dupBig, dupSmall], dupBase, new Set(), 8);
  if (judged.length !== 2) fail("same-named functions sharing one baseline ceiling were not both refused");
  if (!judged.every((e) => e.includes("share this name"))) fail("a collision error did not say what it was");
}

/**
 * THE GATE MUST NOT NEED TO EXEMPT ITSELF. A ratchet whose own author is in the baseline is an
 * argument for the threshold being wrong, made by the one file that cannot claim it did not know.
 * selfTest feeds this the live scan; selfTestSelfAlarm and selfTestVendoredSelf feed it canary rows.
 */
export function selfExemptionAlarm(fail, rows) {
  const own = rows.filter((f) => f.file === SELF_REL);
  if (own.length !== 0) fail(`this gate exempts ${own.length} of its own function(s): ${own.map((f) => `${f.name}(${f.complexity})`).join(", ")}`);
}

/** Canary rows through the alarm: one for this gate, one for a foreign file — only the first may fire. */
function selfTestSelfAlarm(fail) {
  const raised = [];
  selfExemptionAlarm((msg) => raised.push(msg), [{ file: SELF_REL, name: "canary", line: 1, complexity: 99 }]);
  selfExemptionAlarm((msg) => raised.push(msg), [{ file: "elsewhere/x.mjs", name: "foreign", line: 1, complexity: 99 }]);
  if (raised.length !== 1 || !raised[0].includes("canary(99)")) fail(`self-alarm-miskeyed: the self-exemption alarm must fire for ${SELF_REL} alone; it raised: ${JSON.stringify(raised)}`);
}

/** Run in a child: imports the relocated copy at `url` and reports what its self-references key on. */
const vendorProbe = (url) => `
const gate = await import(${JSON.stringify(url)});
const raised = [];
for (const file of ["vendor/complexity-gate.mjs", "tools/complexity-gate.mjs"]) gate.selfExemptionAlarm((msg) => raised.push(msg), [{ file, name: file.split("/")[0], line: 1, complexity: 99 }]);
const [born, stale] = gate.judge([{ file: "b.mjs", name: "g", line: 1, complexity: 9 }], { functions: [{ file: "a.mjs", name: "f", complexity: 9 }] }, new Set(), 8);
console.log(JSON.stringify({ raised, born, stale, optOut: gate.noCompilerFix() }));
`;

const runModule = (source) => spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" });

/**
 * A scratch host (hostCopy) with a host gate file registering the copy and a merge-conflicted
 * baseline. Returns the copy's URL.
 */
function vendoredHost(dir) {
  const copy = hostCopy(dir);
  writeFileSync(join(dir, "docs", "gates", "gate-registry.json"), '{"gates": [{"invocation": "node vendor/complexity-gate.mjs"}]}');
  writeFileSync(join(dir, BASELINE_PATH), "<<<<<<< HEAD\n{");
  return pathToFileURL(copy).href;
}

/** This gate and every module it imports copied into `dir/vendor/`, typescript linked beside them. Returns the copy's path. */
function hostCopy(dir) {
  for (const sub of ["vendor", "node_modules", "docs/gates"]) mkdirSync(join(dir, sub), { recursive: true });
  const copy = join(dir, "vendor", "complexity-gate.mjs");
  copyFileSync(fileURLToPath(import.meta.url), copy);
  for (const dep of ["pathspec.mjs", "test-lint.mjs"]) copyFileSync(fileURLToPath(new URL(`./${dep}`, import.meta.url)), join(dir, "vendor", dep));
  symlinkSync(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), join(dir, "node_modules", "typescript"), "junction");
  return copy;
}

/** One function at complexity 9: over threshold 8. */
const BIG_SOURCE = `export function big(a) {\n${Array.from({ length: 8 }, (_, n) => `  if (a === ${n}) return ${n};\n`).join("")}  return -1;\n}\n`;

/**
 * A scratch host (hostCopy) in `dir` under a fresh git repo: threshold 8 over `includes`, a baseline
 * holding a `big` (9) row for each of `files`, and each of `sources` written as BIG_SOURCE. Every
 * git, shell and gate run drops the inherited GIT_* env (inside a hook it names the HOST repo); `git`
 * throws on failure, `gitRun` returns the result (a refused commit is an outcome, not an error).
 */
function baselinedHost(dir, files, sources = files, includes = ["tools/**/*.mjs"]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const gate = hostCopy(dir);
  for (const sub of ["tools", "lib"]) mkdirSync(join(dir, sub));
  writeFileSync(join(dir, CONFIG_PATH), JSON.stringify({ threshold: 8, includes, excludes: ["**/node_modules/**"], testGlobs: [] }));
  writeFileSync(join(dir, BASELINE_PATH), JSON.stringify({ threshold: 8, functions: files.map((file) => ({ file, name: "big", complexity: 9 })) }));
  for (const source of sources) writeFileSync(join(dir, source), BIG_SOURCE);
  const argv = (args) => ["-c", "user.name=selftest", "-c", "user.email=selftest@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args];
  const git = (...args) => execFileSync("git", argv(args), { cwd: dir, env, stdio: "ignore" });
  git("init", "-q");
  const baselinePath = join(dir, BASELINE_PATH);
  return {
    dir,
    git,
    gitRun: (...args) => spawnSync("git", argv(args), { cwd: dir, env, encoding: "utf8" }),
    baselinePath,
    run: (...args) => spawnSync(process.execPath, [gate, ...args], { cwd: dir, env, encoding: "utf8" }),
    runWith: (extra, ...args) => spawnSync(process.execPath, [gate, ...args], { cwd: dir, env: { ...env, ...extra }, encoding: "utf8" }),
    sh: (command) => spawnSync("sh", ["-c", command], { cwd: dir, env, encoding: "utf8" }),
    baseline: () => readFileSync(baselinePath, "utf8"),
  };
}

/** A scratch dir for `body(dir)`, removed however the body ends. */
function inScratch(prefix, body) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * AN UNSTAGED DELETION OF A BASELINED SOURCE IS REFUSED, NEVER GUESSED. The gate cannot see the
 * next commit: `git commit` takes the index (the rm stays out, HEAD's file and its ceilings
 * stand) while `git commit -a` and every colocated-jj commit (jj keeps git's index at @-) take the
 * working tree (the rm IS the deletion, its rows go stale). Dropping the rows broke the first — a
 * re-record that stripped a file HEAD still tracks; carrying them broke the second — a false
 * green, a re-record that kept a deleted file's ceilings, a commit -a whose printed fix looped.
 * Driven for real in a scratch host: a baselined source and an unbaselined one, committed, then
 * removed from disk only.
 */
function selfTestUnstagedDeletion(fail) {
  inScratch("complexity-gate-unstaged-", (dir) => {
    const host = baselinedHost(dir, BASELINED);
    writeFileSync(join(dir, "tools", "small.mjs"), "export const small = 1;\n");
    host.git("add", ...BASELINED, "tools/small.mjs", CONFIG_PATH, BASELINE_PATH);
    host.git("commit", "-q", "-m", "seed");
    rmSync(join(dir, "tools", "small.mjs"));
    const unbaselined = host.run();
    if (unbaselined.status !== 0 || unbaselined.stderr.includes("holds its ceilings")) fail(`unbaselined-skip-refused: an unstaged rm of a source with no baseline rows must be skipped with the exit unchanged (exit ${unbaselined.status}: ${unbaselined.stderr.trim()})`);
    for (const p of BASELINED) rmSync(join(dir, p));
    unstagedDeletionRefused(fail, host);
    conflictedUnderSkip(fail, host);
    commitAllConverges(fail, host);
  });
}

/** The baselined sources the unstaged-deletion host commits and removes: the refusal names each. */
const BASELINED = ["tools/big.mjs", "tools/second.mjs"];

/** The exits a missing baselined source's refusal names — put it back, or delete it for good. */
const missingSourceFix = (p) =>
  `fix: put it back on disk (a file HEAD holds: git --literal-pathspecs checkout HEAD -- ${p}; a link: restore its target; a file HEAD never held, an intent-to-add entry: re-create it; left out by a sparse checkout, git's or jj's: widen the checkout to include it) or, if you deleted it for good in a full checkout, stage the deletion and re-record (git --literal-pathspecs rm --ignore-unmatch -- ${p} && node vendor/complexity-gate.mjs --update-baseline — it writes fence surface: land it under a protected task)`;

/** The gate and the re-record both refuse each source with the exits that settle it; the baseline is untouched. */
function unstagedDeletionRefused(fail, host) {
  const recorded = host.baseline();
  for (const [what, run] of [["gate", host.run()], ["--update-baseline", host.run("--update-baseline")]]) {
    const unnamed = BASELINED.filter((p) => !run.stderr.includes(missingSourceFix(p)));
    if (run.status !== 1 || unnamed.length > 0) fail(`unstaged-deletion-guessed: the ${what} on an unstaged rm of a baselined source must refuse with the exits that settle it (unrefused: ${unnamed.join(", ")}; exit ${run.status}: ${run.stderr.trim()})`);
  }
  if (host.baseline() !== recorded) fail(`unstaged-deletion-rerecorded: --update-baseline rewrote the baseline under an unstaged deletion: ${host.baseline()}`);
}

/** A conflicted baseline may hold those ceilings too: the refusal must not send the re-record back into itself. */
function conflictedUnderSkip(fail, host) {
  const recorded = host.baseline();
  writeFileSync(host.baselinePath, "<<<<<<< HEAD\n{");
  const conflicted = host.run("--update-baseline");
  writeFileSync(host.baselinePath, recorded);
  if (conflicted.status !== 1 || conflicted.stderr.includes("--update-baseline") || !conflicted.stderr.includes(`git checkout -- ${BASELINE_PATH}`)) fail(`skipped-baseline-circular-fix: an unreadable baseline under a skipped path must refuse with the restore alone (exit ${conflicted.status}: ${conflicted.stderr.trim()})`);
}

/**
 * The real `git commit -a` path, the gate run as a pre-commit hook. The hook's own index stages the
 * rm, so it refuses the stale row and prints --update-baseline; run from the shell, where the rm is
 * unstaged, that fix must REFUSE rather than keep the row (carrying kept it, and the next commit -a
 * refused again, forever). The refusal's delete exit then lands the deletion and the dropped
 * ceilings together, through the same hooked `commit -a`: the TIP holds neither source nor row,
 * and matches the working tree the final green gate judged.
 */
function commitAllConverges(fail, host) {
  mkdirSync(join(host.dir, "hooks"));
  writeFileSync(join(host.dir, "hooks", "pre-commit"), "#!/bin/sh\nexec node vendor/complexity-gate.mjs\n", { mode: 0o755 });
  const commitAll = () => host.gitRun("-c", "core.hooksPath=hooks", "commit", "-q", "-a", "-m", "delete");
  const hooked = commitAll();
  const printed = host.run("--update-baseline");
  if (hooked.status === 0 || !hooked.stderr.includes("still exempts tools/big.mjs") || printed.status !== 1) fail(`unstaged-deletion-looped: the hooked commit -a must refuse the stale row, and its printed --update-baseline, run from the shell, must refuse rather than keep the row (hook ${hooked.status}, shell re-record ${printed.status}: ${printed.stderr.trim()})`);
  host.git("rm", "-q", "--ignore-unmatch", "--", ...BASELINED);
  const rerecorded = host.run("--update-baseline");
  const landed = commitAll();
  const after = host.run();
  const tip = landedTipDefect(host);
  if (rerecorded.status !== 0 || landed.status !== 0 || after.status !== 0 || tip !== "") fail(`unstaged-deletion-no-exit: after git rm + re-record the hooked commit -a must land a tip with no row for the deleted source, matching the green working tree (re-record ${rerecorded.status}, commit -a ${landed.status}, gate ${after.status}, tip: ${tip}: ${landed.stderr.trim()} ${after.stderr.trim()})`);
}

/** Why the landed tip is not the deleted-and-re-recorded one, or "": its baseline must hold no row
 *  for the source, and no gate file or source may differ from the working tree the gate judged. */
function landedTipDefect(host) {
  if (host.gitRun("show", `HEAD:${BASELINE_PATH}`).stdout.includes("tools/big.mjs")) return "its baseline still holds tools/big.mjs";
  const drift = host.gitRun("status", "--porcelain", "--", "tools", "docs").stdout.trim();
  return drift === "" ? "" : `uncommitted ${drift}`;
}

/**
 * A committed link resolves on a clean checkout, so its source is scanned under the LINK's name.
 * With its target removed from disk only, the link dangles and is skipped while `git commit` keeps
 * both: the same guess as a regular file, so it is refused — never read as stale rows whose fix,
 * --update-baseline, stripped the ceilings a clean clone then needed.
 */
function selfTestLinkedSource(fail) {
  inScratch("complexity-gate-link-", (dir) => {
    const host = baselinedHost(dir, ["tools/alias.mjs"], ["lib/real.mjs"]);
    symlinkSync("../lib/real.mjs", join(dir, "tools", "alias.mjs"));
    host.git("add", "lib/real.mjs", "tools/alias.mjs");
    host.git("commit", "-q", "-m", "seed");
    rmSync(join(dir, "lib", "real.mjs"));
    const fix = "stage the deletion and re-record (git --literal-pathspecs rm --ignore-unmatch -- tools/alias.mjs && node vendor/complexity-gate.mjs --update-baseline";
    for (const [what, run] of [["gate", host.run()], ["--update-baseline", host.run("--update-baseline")]]) {
      if (run.status !== 1 || !run.stderr.includes(fix)) fail(`linked-source-dropped: the ${what} on a committed link whose target was removed from disk only must refuse (exit ${run.status}: ${run.stderr.trim()})`);
    }
  });
}

/**
 * A skip-worktree entry (a sparse checkout) is refused like any missing baselined source, with the
 * widen exit named: carrying it on git's skip-worktree bit was a false green under jj (which ignores
 * the bit and deletes the file) and a red battery under guard-reach (whose HEAD-index copy carries
 * no bits), and jj's own sparse patterns never set the bit at all. The ratchet reads what it exempts.
 */
function selfTestSparseEntry(fail) {
  inScratch("complexity-gate-sparse-", (dir) => {
    const host = baselinedHost(dir, ["tools/far.mjs"]);
    host.git("add", "tools/far.mjs");
    host.git("commit", "-q", "-m", "seed");
    host.git("update-index", "--skip-worktree", "tools/far.mjs");
    rmSync(join(dir, "tools", "far.mjs"));
    const recorded = host.baseline();
    for (const [what, run] of [["gate", host.run()], ["--update-baseline", host.run("--update-baseline")]]) {
      if (run.status !== 1 || !run.stderr.includes(missingSourceFix("tools/far.mjs"))) fail(`sparse-entry-carried: the ${what} on a skip-worktree baselined source must refuse and name the widen exit (exit ${run.status}: ${run.stderr.trim()})`);
    }
    if (host.baseline() !== recorded) fail(`sparse-entry-rerecorded: --update-baseline rewrote the baseline over a skip-worktree source: ${host.baseline()}`);
    host.git("update-index", "--no-skip-worktree", "tools/far.mjs");
    host.git("checkout", "HEAD", "--", "tools/far.mjs");
    const widened = host.run();
    if (widened.status !== 0) fail(`sparse-entry-no-exit: widening the checkout to include the source must clear the refusal (exit ${widened.status}: ${widened.stderr.trim()})`);
  });
}

/**
 * A skipped path the index does not list — an untracked dangling link — carries no source into
 * any commit, so its rows are STALE: reported by the gate, dropped by the re-record. Carrying them
 * kept a dead ceiling that every clean clone then refused. Run on an unborn HEAD as well as after a
 * seed commit: an earlier HEAD-based query needed its own unborn guard, and nothing may again.
 */
function selfTestNoHeadFile(fail) {
  for (const seeded of [false, true]) inScratch("complexity-gate-nohead-", (dir) => noHeadFileStale(fail, dir, seeded));
}

function noHeadFileStale(fail, dir, seeded) {
  const host = baselinedHost(dir, ["tools/loose.mjs"], []);
  if (seeded) host.git("commit", "-q", "--allow-empty", "-m", "seed");
  symlinkSync("nowhere.mjs", join(dir, "tools", "loose.mjs"));
  const judged = host.run();
  const head = seeded ? "a seeded HEAD" : "an unborn HEAD";
  if (judged.status !== 1 || !judged.stderr.includes("still exempts tools/loose.mjs big (9)") || judged.stderr.includes("stage the deletion")) fail(`no-head-file-carried: under ${head}, rows for a path the index does not list must read as stale, never carried or refused (exit ${judged.status}: ${judged.stderr.trim()})`);
  const updated = host.run("--update-baseline");
  if (updated.status !== 0 || JSON.parse(host.baseline()).functions.length !== 0) fail(`no-head-file-kept: under ${head}, --update-baseline kept ceilings no commit can hold (exit ${updated.status}: ${host.baseline()})`);
}

/**
 * An intent-to-add entry is how colocated jj writes a file added in its working-copy commit, and
 * `jj commit` keeps it even when jj's sparse patterns take it off disk: reading its rows as stale
 * let --update-baseline strip a ceiling the commit kept. The index lists it, so it is refused, and
 * the delete exit — the one that runs for a file HEAD never held — clears it.
 */
function selfTestIntentToAdd(fail) {
  inScratch("complexity-gate-ita-", (dir) => {
    const host = baselinedHost(dir, ["tools/ita.mjs"]);
    host.git("add", "-N", "tools/ita.mjs");
    rmSync(join(dir, "tools", "ita.mjs"));
    const judged = host.run();
    if (judged.status !== 1 || !judged.stderr.includes(missingSourceFix("tools/ita.mjs"))) fail(`intent-to-add-dropped: an intent-to-add baselined source missing from disk must be refused, not read as stale rows (exit ${judged.status}: ${judged.stderr.trim()})`);
    host.git("rm", "-q", "--ignore-unmatch", "--", "tools/ita.mjs");
    const rerecorded = host.run("--update-baseline");
    if (rerecorded.status !== 0 || host.run().status !== 0) fail(`intent-to-add-no-exit: the delete exit must clear an intent-to-add entry's refusal (re-record ${rerecorded.status}: ${rerecorded.stderr.trim()})`);
  });
}

/**
 * A root-level source named with a leading `:` is pathspec magic to git unless the pathspec is
 * literal: `:!x.mjs` names every OTHER file. The index query must not miss it (the refusal would
 * read its rows as stale), even under an exported GIT_ICASE_PATHSPECS (git refuses the global
 * literal flag beside it), and both printed exits — run here verbatim, through a shell — must act
 * on that one file, quoted: the restore clears the refusal, the delete exit drops its row.
 */
function selfTestLiteralName(fail) {
  inScratch("complexity-gate-literal-", (dir) => {
    const host = baselinedHost(dir, [LITERAL_NAME], [LITERAL_NAME], [":*.mjs"]);
    host.git("add", "--", `${dir}/${LITERAL_NAME}`);
    host.git("commit", "-q", "-m", "seed");
    rmSync(join(dir, LITERAL_NAME));
    const judged = host.run();
    const restore = /git --literal-pathspecs checkout HEAD -- '[^']*'/.exec(judged.stderr)?.[0];
    const restored = restore ? host.sh(restore).status : null;
    if (judged.status !== 1 || !restore || restored !== 0 || host.run().status !== 0) fail(`literal-name-dropped: a source named '${LITERAL_NAME}' must be refused with a quoted literal-pathspec restore that clears it (gate ${judged.status}, restore ${restored}: ${judged.stderr.trim()})`);
    literalDeleteExit(fail, host, dir);
  });
}

const LITERAL_NAME = ":big one.mjs";

/** The same source removed again: refused under GIT_ICASE_PATHSPECS too, and its delete exit, run verbatim, drops the row. */
function literalDeleteExit(fail, host, dir) {
  rmSync(join(dir, LITERAL_NAME));
  const judged = host.runWith({ GIT_ICASE_PATHSPECS: "1" });
  const remove = /git --literal-pathspecs rm --ignore-unmatch -- '[^']*' && node vendor\/complexity-gate\.mjs --update-baseline/.exec(judged.stderr)?.[0];
  const removed = remove ? host.sh(remove).status : null;
  if (judged.status !== 1 || !remove || removed !== 0 || host.run().status !== 0 || host.baseline().includes(LITERAL_NAME)) fail(`literal-name-kept: under GIT_ICASE_PATHSPECS the source must still be refused, and its delete exit run verbatim must drop its row (gate ${judged.status}, delete ${removed}: ${judged.stderr.trim()})`);
}

/**
 * A VENDORED COPY MUST KNOW ITSELF. The self-references once keyed on the literal
 * "tools/complexity-gate.mjs", which no copy vendored elsewhere matches (tools/harness/ in the
 * Antitube harness): its self-exemption alarm filtered for a file that did not exist and stayed
 * green, its opt-out fix missed the host's registrations, and its fixes named a script that was not
 * there. Driven for real: a copy imported from a scratch `vendor/` must alarm on its own row alone
 * and name `vendor/complexity-gate.mjs` in every fix — stale row, birth, baseline restore, opt-out.
 */
function selfTestVendoredSelf(fail) {
  const dir = mkdtempSync(join(tmpdir(), "complexity-gate-vendor-"));
  try {
    const url = vendoredHost(dir);
    const run = runModule(vendorProbe(url));
    if (run.status !== 0) return fail(`vendored-probe-crashed: a copy of this gate imported from vendor/ exited ${run.status}: ${run.stderr.trim()}`);
    const { raised, born, stale, optOut } = JSON.parse(run.stdout);
    // readBaseline dies on the conflicted baseline, so its refusal is read off a second child's stderr.
    const restore = runModule(`await (await import(${JSON.stringify(url)})).readBaseline();`).stderr;
    if (raised.length !== 1 || !raised[0].includes("vendor(99)")) fail(`vendored-alarm-dead: a copy at vendor/complexity-gate.mjs must alarm on its own row alone; it raised: ${JSON.stringify(raised)}`);
    for (const [what, text] of [["stale-row", stale], ["birth", born], ["baseline-restore", restore]]) {
      if (!text.includes("node vendor/complexity-gate.mjs --update-baseline")) fail(`vendored-fix-not-runnable: a vendored copy's ${what} fix names a script that is not there: ${text}`);
    }
    if (!optOut.includes("delete vendor/complexity-gate.mjs") || !optOut.includes("docs/gates/gate-registry.json")) fail(`vendored-optout-blind: a vendored copy's missing-compiler fix misses itself or its host registration: ${optOut}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function selfTest() {
  let ok = true;
  const fail = (msg) => {
    console.error(`complexity-gate SELF-TEST FAIL: ${msg}`);
    ok = false;
  };

  selfTestMetric(fail);
  selfTestJudge(fail);
  selfTestJudgeCollisions(fail);
  selfTestLoaders(fail);
  selfTestRemedies(fail);
  selfTestOptOut(fail);
  selfTestTrackedNames(fail);
  selfTestUnstagedDeletion(fail);
  selfTestLinkedSource(fail);
  selfTestSparseEntry(fail);
  selfTestNoHeadFile(fail);
  selfTestIntentToAdd(fail);
  selfTestLiteralName(fail);
  selfTestSelfAlarm(fail);
  selfTestVendoredSelf(fail);

  // And the repo's own config + baseline must be honest right now, or the gate ships pre-broken.
  const config = orDie(loadConfig(), "config");
  const live = judge(scan(config), readBaseline(), testMentions(config), config.threshold, hatchOpenOf(config));
  if (live.length !== 0) fail(`the committed baseline does not describe this tree:\n    ${live.join("\n    ")}`);

  selfExemptionAlarm(fail, scan(config));

  console.log(ok ? `complexity-gate self-test: OK (threshold ${config.threshold})` : "complexity-gate self-test: FAILED");
  return ok;
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

  const config = orDie(loadConfig(), "config");
  const current = scan(config);

  if (argv.includes("--report")) {
    const mentioned = testMentions(config);
    console.log(`Functions over cyclomatic complexity ${config.threshold} (${current.length}):\n`);
    for (const fn of current) {
      console.log(`  ${String(fn.complexity).padStart(3)}  ${mentioned.has(fn.name.split(".").pop()) ? "test" : "  — "}  ${fn.file}:${fn.line} ${fn.name}`);
    }
    process.exit(0);
  }

  if (argv.includes("--update-baseline")) {
    const payload = {
      threshold: config.threshold,
      note: `Functions permitted above the threshold, at exactly the complexity they had when recorded. The ratchet lets these fall, never rise. Regenerate with \`node ${SELF_REL} --update-baseline\` — a deliberate act, reviewable in the diff.`,
      functions: current.map((f) => ({ file: f.file, name: f.name, complexity: f.complexity })),
    };
    writeFileSync(`${ROOT}${BASELINE_PATH}`, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`complexity-gate: baseline written — ${current.length} function(s) over ${config.threshold}`);
    process.exit(0);
  }

  const errors = judge(current, readBaseline(), testMentions(config), config.threshold, hatchOpenOf(config));
  if (errors.length === 0) {
    // "over the threshold", not "baselined": `current` may include a NEW function permitted by the
    // named-by-a-test hatch, which is deliberately not written to the baseline.
    console.log(`complexity-gate: OK — ${current.length} function(s) over ${config.threshold} (${readBaseline().functions.length} baselined), none rising, nothing new born convoluted`);
    process.exit(0);
  }
  for (const error of errors) console.error(`complexity-gate: ${error}`);
  console.error(`\ncomplexity-gate FAILED (${errors.length}). Threshold ${config.threshold}. See ${BASELINE_PATH}.`);
  process.exit(1);
}
