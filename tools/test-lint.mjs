#!/usr/bin/env node
/**
 * ANTI-BUG-PINNING TEST LINT — ported from the Antitube harness.
 *
 * A test can pass for reasons that have nothing to do with the behaviour it names. This flags the
 * shapes that have actually done so at the origin repo, and deliberately not the ones that merely
 * could in theory.
 *
 * WHY THE SUBSET IS WHAT IT IS. Four checks were asked for there. Two are mechanical with
 * essentially no false positives, and both describe incidents that happened — one of them twice
 * in a single day. The third is judgement-shaped, so it advises rather than blocks. The fourth (a
 * state-is-set assertion with no persistence follow-on) is the most valuable and the most likely
 * to misfire, and is deliberately NOT implemented: a lint that fires on legitimate tests teaches
 * `--no-verify`, and the origin repo has a documented history of exactly that. A narrow lint that
 * runs is worth more than a broad one that gets bypassed.
 *
 * THE CHECKS
 *
 *   TAUTOLOGY (blocking) — `expect(true).toBe(true)`, `expect(x).toBe(x)`. Asserts nothing about
 *   the system. One was committed as a placeholder at the origin repo and survived review.
 *
 *   UNSTRIPPED SOURCE READ (blocking) — a test that reads a source file and asserts on its CONTENT
 *   without removing comments first. This bit TWICE IN A SINGLE DAY at the origin repo: an
 *   extractor returned comments as code so a handler tripped its own pin, and later a
 *   source-contract test FAILED AGAINST CORRECT CODE because the branch's own comment contained
 *   the string the test asserted was absent. Both times the test was reading prose about code and
 *   calling it code.
 *
 *   ECHOED EXPECTATION (advisory) — an expected literal that also appears in an object literal
 *   earlier in the same test, i.e. the test may be asserting that the system returned what the
 *   test just handed it. This is the original ask and it has real false positives (a fixture id
 *   legitimately appears in both the seed and the assertion), so it prints and never blocks.
 *
 * PORT NOTES. Discovery here is shape-based, not path-based: no hardcoded package roots. With no
 * arguments the tool discovers `*.test.*` / `*.spec.*` files via `git ls-files`; explicit paths
 * are linted as given, because in this repo the tests are embedded self-tests inside plain `.mjs`
 * tools rather than separately named test files. If this gate joins the selftest battery, its
 * `--self-test` must run before it is trusted to block anything, and a defective version is
 * validated by running it directly — the file on disk is what executes, so a corrected version
 * takes effect without being committed first.
 *
 * USAGE
 *   node tools/test-lint.mjs              lint discovered test files; non-zero on a blocking finding
 *   node tools/test-lint.mjs <path>...    lint the given files/directories (embedded self-tests)
 *   node tools/test-lint.mjs --advisory   include advisory findings in the report
 *   node tools/test-lint.mjs --self-test  prove each check discriminates
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TEST_RE = /\.(test|spec)\.(ts|tsx|mjs|js|cjs)$/;
const LINTABLE_RE = /\.(ts|tsx|mjs|js|cjs)$/;

function discoverTestFiles() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => TEST_RE.test(f));
}

/**
 * Explicit paths are walked as given: a file is linted as-is, a directory recursively for
 * lintable code files. `node_modules` and `.git` are never descended into.
 */
function expandPaths(args) {
  const out = [];
  for (const arg of args) {
    const stat = statSync(arg, { throwIfNoEntry: false });
    if (stat?.isFile()) out.push(arg);
    else if (stat?.isDirectory()) out.push(...walk(arg));
    else {
      console.error(`test-lint: no such file or directory: ${arg}`);
      process.exitCode = 2;
    }
  }
  return out;
}

function walk(dir, prefix = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === ".git" || entry === "node_modules") continue;
    const full = `${dir}/${entry}`;
    const stat = statSync(full, { throwIfNoEntry: false });
    if (stat?.isDirectory()) out.push(...walk(full, prefix));
    else if (LINTABLE_RE.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Strip comments and string contents before structural matching.
 *
 * The irony is deliberate and load-bearing: this lint exists partly because a test read comments as
 * code, so it must not repeat the mistake. String contents are blanked (not removed) so that a
 * documented example inside a message — `"expect(true).toBe(true)"` in this very file's own prose —
 * cannot be mistaken for a real assertion, while offsets stay stable for line reporting.
 */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + m.slice(p1.length).replace(/./g, " "));
}

function strip(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + m.slice(p1.length).replace(/./g, " "))
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => `"${" ".repeat(Math.max(0, m.length - 2))}"`)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => `'${" ".repeat(Math.max(0, m.length - 2))}'`);
}

/** `expect(X).toBe(X)` / `toEqual` / `toStrictEqual` where both sides are textually identical. */
export function findTautologies(stripped) {
  const out = [];
  const re = /expect\(\s*([^)]{1,80}?)\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\(\s*([^)]{1,80}?)\s*\)/g;
  for (const m of stripped.matchAll(re)) {
    const [lhs, rhs] = [m[1].trim(), m[2].trim()];
    if (lhs.length === 0 || rhs.length === 0) continue;
    // A blanked string literal is not evidence either way — the strip pass emptied it.
    if (/^["']\s*["']$/.test(lhs)) continue;
    if (lhs === rhs) {
      out.push({ index: m.index ?? 0, detail: `expect(${lhs}) compared to itself — asserts nothing` });
    }
  }
  return out;
}

/**
 * A test that reads a source file and asserts on its content, without stripping comments.
 *
 * Detects the READ (a `readFileSync` naming a source path) and the absence of any comment-stripping
 * in the same file. Deliberately coarse: any of the usual strip idioms counts, because the point is
 * that the author THOUGHT about it, not that they used a particular regex.
 */
export function findUnstrippedSourceReads(stripped, raw) {
  // Detected on COMMENT-stripped text, not fully-stripped: `strip` blanks string contents, which
  // erases the very path that identifies a source read. Comments still must go, or a comment
  // mentioning readFileSync would trip this — the same confusion the check itself is about.
  const commentsGone = stripComments(raw);
  // The read is matched by SHAPE — a source extension in the read — not by enumerated package
  // roots. An earlier origin-repo version required a package-rooted path, so a SIBLING read
  // (`new URL("./thing.ts", import.meta.url)`) was invisible — and that is exactly how a
  // fail-closed conformance pin once read its source. Demonstrated there: every real call of a
  // function was removed from the module under test and its conformance test still passed 8/8,
  // because one comment mentioned the name. Match the READ and any source extension instead of
  // trying to enumerate path shapes; the only path forms kept are the generic parent-relative
  // `../src/` and `../public/` shapes.
  const readsSource =
    /readFileSync\([^)]*\.(?:ts|tsx|js|mjs|cjs|html|css)\b/.test(commentsGone) ||
    /readFileSync\([^)]*(?:\.\.\/src\/|\.\.\/public\/)/.test(commentsGone);
  void stripped;
  if (!readsSource) return [];
  const stripsComments =
    /replace\(\s*\/\\\/\\\*/.test(raw) ||
    /\/\\\/\\\*\[\\s\\S\]\*\?\\\*\\\//.test(raw) ||
    /replace\([^)]*\/\*/.test(raw) ||
    raw.includes("stripComments") ||
    raw.includes("strip(");
  if (stripsComments) return [];
  const index = commentsGone.search(/readFileSync/);
  return [
    {
      index: index === -1 ? 0 : index,
      detail:
        "reads a source file and asserts on its content without stripping comments — a comment quoting " +
        "the asserted string makes this pass or fail for the wrong reason (happened twice in a single " +
        "day at the origin repo)",
    },
  ];
}

/** ADVISORY: an expected string literal that also appears in an object literal earlier in the file. */
export function findEchoedExpectations(raw) {
  const out = [];
  const re = /expect\([^)]*\)\s*\.\s*(?:toBe|toEqual)\(\s*"([^"]{4,60})"\s*\)/g;
  for (const m of raw.matchAll(re)) {
    const literal = m[1];
    const before = raw.slice(0, m.index ?? 0);
    // Seeded as an object property value earlier in the same file.
    if (new RegExp(`:\\s*"${literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(before)) {
      out.push({ index: m.index ?? 0, detail: `expected "${literal}" is also seeded earlier in this file` });
    }
  }
  return out;
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

function selfTest() {
  const cases = [];
  const t = (name, pass) => cases.push([name, pass]);

  t("flags expect(true).toBe(true)", findTautologies(strip("expect(true).toBe(true);")).length === 1);
  t("flags expect(x).toBe(x)", findTautologies(strip("expect(row.id).toBe(row.id);")).length === 1);
  t("does NOT flag a real assertion", findTautologies(strip("expect(row.id).toBe(other.id);")).length === 0);
  // The check must not fire on its own documentation — the strip pass blanks string contents.
  t(
    "does NOT flag a tautology quoted inside a string",
    findTautologies(strip('const msg = "expect(true).toBe(true)";')).length === 0,
  );
  // ...nor on one inside a comment, which is the mistake this lint exists to prevent.
  t(
    "does NOT flag a tautology inside a comment",
    findTautologies(strip("// e.g. expect(true).toBe(true) is meaningless\nexpect(a).toBe(b);")).length === 0,
  );

  const unstripped = 'const s = readFileSync(new URL("../src/x.ts", u), "utf8");\nexpect(s).toContain("y");';
  t("flags an unstripped source read", findUnstrippedSourceReads(strip(unstripped), unstripped).length === 1);
  const strippedRead = `const s = readFileSync(new URL("../src/x.ts", u), "utf8").replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");`;
  t("does NOT flag a source read that strips", findUnstrippedSourceReads(strip(strippedRead), strippedRead).length === 0);
  t("does NOT flag a test that reads no source", findUnstrippedSourceReads(strip("expect(1).toBe(2);"), "expect(1).toBe(2);").length === 0);
  // The SIBLING read — a same-directory source, no parent traversal — is the shape the origin
  // repo's first version missed. It must be caught by the extension arm alone.
  const sibling = 'const s = readFileSync(new URL("./thing.ts", import.meta.url), "utf8");\nexpect(s).toContain("y");';
  t("flags a SIBLING source read (no ../)", findUnstrippedSourceReads(strip(sibling), sibling).length === 1);
  t(
    "does NOT flag reading a data file (no source extension)",
    findUnstrippedSourceReads(strip('const s = readFileSync("fixtures/seed.json");'), 'const s = readFileSync("fixtures/seed.json");').length === 0,
  );

  t(
    "advisory flags an echoed expectation",
    findEchoedExpectations('const seed = { caption: "hello world" };\nexpect(row.caption).toBe("hello world");').length === 1,
  );
  t("advisory ignores an unseeded expectation", findEchoedExpectations('expect(row.caption).toBe("hello world");').length === 0);

  let ok = true;
  for (const [name, pass] of cases) {
    if (!pass) {
      ok = false;
      console.error(`  test-lint self-test FAILED: ${name}`);
    }
  }
  console.log(ok ? `test-lint self-test: OK (${cases.length} cases)` : "test-lint self-test: FAILED");
  return ok;
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest() ? 0 : 1;
  const showAdvisory = process.argv.includes("--advisory");
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const files = positional.length > 0 ? expandPaths(positional) : discoverTestFiles();

  const blocking = [];
  const advisory = [];

  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const stripped = strip(raw);
    for (const hit of findTautologies(stripped)) {
      blocking.push(`${file}:${lineOf(raw, hit.index)} TAUTOLOGY — ${hit.detail}`);
    }
    for (const hit of findUnstrippedSourceReads(stripped, raw)) {
      blocking.push(`${file}:${lineOf(raw, hit.index)} UNSTRIPPED SOURCE READ — ${hit.detail}`);
    }
    for (const hit of findEchoedExpectations(raw)) {
      advisory.push(`${file}:${lineOf(raw, hit.index)} echoed expectation — ${hit.detail}`);
    }
  }

  console.log(`test-lint — ${files.length} test file(s), ${blocking.length} blocking, ${advisory.length} advisory.`);
  for (const line of blocking) console.error(`  ${line}`);
  if (showAdvisory) for (const line of advisory) console.log(`  (advisory) ${line}`);

  if (blocking.length > 0) {
    console.error("test-lint: FAILED — a test that passes for the wrong reason is worse than no test.");
    return 1;
  }
  console.log("test-lint — no bug-pinned tests.");
  return 0;
}

/**
 * CLI, guarded by an entry-module check (pathspec's lesson): this module exports its checks and
 * may be imported by other tools, so a bare `process.argv.includes(...)` test would fire the CLI
 * on IMPORT and exit before the importer's own self-test could run.
 */
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  process.exit(main());
}
