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
 *   node tools/complexity-gate.mjs --report           # every function at or over the threshold
 *   node tools/complexity-gate.mjs --update-baseline  # re-record; deliberate, reviewable
 *   node tools/complexity-gate.mjs --self-test        # proves the analyser discriminates
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
// The compiler is the OPTIONAL peer dependency (see package.json): a missing typescript must
// refuse with a fix line naming the two honest exits, not crash the battery with a bare
// ERR_MODULE_NOT_FOUND (an adversarial finding: the static import made the battery unrunnable
// in any fresh clone).
let ts;
try {
  ts = await import("typescript");
} catch {
  console.error("complexity-gate: the TypeScript compiler is not installed — the ratchet cannot count what it cannot parse");
  console.error("  fix: npm install -D typescript (an optional peer dep, dev-time only) — or vendor without this gate and drop its battery line and docs/gates/complexity*.json");
  process.exit(1);
}
import { matches } from "./pathspec.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CONFIG_PATH = "docs/gates/complexity.json";
export const BASELINE_PATH = "docs/gates/complexity-baseline.json";

/**
 * Config: threshold, includes, excludes, testGlobs — all repo data, none in this file. Fail
 * closed on every malformation shape (missing, unparseable, wrong types, empty includes) with a
 * fix line naming the path: a gate that cannot read its config must not pass.
 */
function loadConfig() {
  const path = `${ROOT}${CONFIG_PATH}`;
  if (!existsSync(path)) die(`${CONFIG_PATH} is missing — the ratchet cannot run blind\n  fix: restore it (see the vendor template) or regenerate: node tools/complexity-gate.mjs --update-baseline`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    die(`${CONFIG_PATH} does not parse: ${e.message}\n  fix: repair the JSON`);
  }
  const strArray = (key) => {
    const v = parsed[key];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string") || v.length === 0) die(`${CONFIG_PATH} field '${key}' must be a non-empty array of glob strings\n  fix: repair the config`);
    return v;
  };
  if (typeof parsed.threshold !== "number" || !Number.isInteger(parsed.threshold) || parsed.threshold < 2) die(`${CONFIG_PATH} field 'threshold' must be an integer >= 2\n  fix: repair the config`);
  return { threshold: parsed.threshold, includes: strArray("includes"), excludes: strArray("excludes"), testGlobs: Array.isArray(parsed.testGlobs) && parsed.testGlobs.every((x) => typeof x === "string") ? parsed.testGlobs : die(`${CONFIG_PATH} field 'testGlobs' must be an array of glob strings (empty = the test-names hatch is CLOSED)\n  fix: repair the config`) };
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
 */
function trackedFiles(globs, excludes) {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: ROOT })
    .split("\n")
    .filter(Boolean)
    .filter((f) => globs.some((g) => matches(f, g)) && !excludes.some((g) => matches(f, g)));
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

/** Every function in the tracked corpus at or over the threshold. */
export function scan(config = loadConfig()) {
  const over = [];
  for (const file of trackedFiles(config.includes, config.excludes)) {
    for (const fn of analyse(file, readFileSync(`${ROOT}${file}`, "utf8"))) {
      if (fn.complexity > config.threshold) over.push(fn);
    }
  }
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

export function readBaseline() {
  try {
    return JSON.parse(readFileSync(`${ROOT}${BASELINE_PATH}`, "utf8"));
  } catch {
    return { threshold: null, functions: [] };
  }
}

/**
 * The three failure directions. Pure, so the self-test can drive it with fixtures instead of the
 * repo — a checker only ever exercised against a tree that passes is a checker nobody has watched
 * discriminate.
 */
export function judge(current, baseline, mentioned, threshold) {
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
          `${fn.file}:${fn.line} ${fn.name} — cyclomatic complexity ${fn.complexity} exceeds ${threshold} and no test names it. ` +
            "Split it, or pin it with a test that exercises the branches.",
        );
      }
      continue;
    }
    // 2. The ratchet. Baselined functions may fall, never rise.
    if (fn.complexity > was) {
      errors.push(`${fn.file}:${fn.line} ${fn.name} — complexity rose ${was} -> ${fn.complexity}. The baseline is a ceiling, not an allowance.`);
    }
  }

  errors.push(...staleBaselineErrors(baseline, seen, threshold));
  return errors;
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
      errors.push(`${BASELINE_PATH} still exempts ${row.file} ${row.name} (${row.complexity}), which is gone or now under ${threshold}. Run --update-baseline.`);
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

function selfTestJudgeCollisions(fail) {
  const dupBig = { file: "d.ts", name: "dup", line: 1, complexity: 26 };
  const dupSmall = { file: "d.ts", name: "dup", line: 9, complexity: 10 };
  const dupBase = { threshold: 8, functions: [{ file: "d.ts", name: "dup", complexity: 26 }] };
  const judged = judge([dupBig, dupSmall], dupBase, new Set(), 8);
  if (judged.length !== 2) fail("same-named functions sharing one baseline ceiling were not both refused");
  if (!judged.every((e) => e.includes("share this name"))) fail("a collision error did not say what it was");
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

  // And the repo's own config + baseline must be honest right now, or the gate ships pre-broken.
  const config = loadConfig();
  const live = judge(scan(config), readBaseline(), testMentions(config), config.threshold);
  if (live.length !== 0) fail(`the committed baseline does not describe this tree:\n    ${live.join("\n    ")}`);

  // THE GATE MUST NOT NEED TO EXEMPT ITSELF. A ratchet whose own author is in the baseline is an
  // argument for the threshold being wrong, made by the one file that cannot claim it did not know.
  const own = scan(config).filter((f) => f.file === "tools/complexity-gate.mjs");
  if (own.length !== 0) fail(`this gate exempts ${own.length} of its own function(s): ${own.map((f) => `${f.name}(${f.complexity})`).join(", ")}`);

  console.log(ok ? `complexity-gate self-test: OK (threshold ${config.threshold})` : "complexity-gate self-test: FAILED");
  return ok;
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);

  const config = loadConfig();
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
      note: "Functions permitted above the threshold, at exactly the complexity they had when recorded. The ratchet lets these fall, never rise. Regenerate with `node tools/complexity-gate.mjs --update-baseline` — a deliberate act, reviewable in the diff.",
      functions: current.map((f) => ({ file: f.file, name: f.name, complexity: f.complexity })),
    };
    writeFileSync(`${ROOT}${BASELINE_PATH}`, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`complexity-gate: baseline written — ${current.length} function(s) over ${config.threshold}`);
    process.exit(0);
  }

  const errors = judge(current, readBaseline(), testMentions(config), config.threshold);
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
