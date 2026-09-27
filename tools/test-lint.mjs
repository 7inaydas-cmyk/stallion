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
 * arguments the tool discovers `*.test.*` / `*.spec.*` files via `git ls-files` (the INDEX); a
 * listed path with no regular file on disk is refused when it carries a staged change (staged, then
 * deleted) and otherwise skipped and named (see listedOnDisk). The lint judges the WORKING TREE:
 * what a commit carries but the disk does not show — HEAD's content for a skipped path, a committed
 * file edited on disk without staging, staged content under a file since edited — is not re-read
 * here; only a clean-clone run judges it. Explicit paths walk the disk and never consult the index
 * (this repo's battery runs `test-lint tools`). Explicit paths are linted as given, because in this repo the tests are embedded self-tests inside
 * plain `.mjs` tools rather than separately named test files. If this gate joins the selftest
 * battery, its `--self-test` must run before it is trusted to block anything, and a defective
 * version is validated by running it directly — the file on disk is what executes, so a corrected
 * version takes effect without being committed first.
 *
 * USAGE
 *   node tools/test-lint.mjs              lint discovered test files; non-zero on a blocking finding
 *   node tools/test-lint.mjs <path>...    lint the given files/directories (embedded self-tests)
 *   node tools/test-lint.mjs --advisory   include advisory findings in the report
 *   node tools/test-lint.mjs --self-test  prove each check discriminates
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_RE = /\.(test|spec)\.(ts|tsx|mjs|js|cjs)$/;
const LINTABLE_RE = /\.(ts|tsx|mjs|js|cjs)$/;

/** Tracked `*.test.*` / `*.spec.*` files, split by what the disk holds (see listedOnDisk). `-z`,
 *  split on NUL: without it git C-quotes a non-ASCII path and the quoted name never matches TEST_RE.
 *  The list is the index and the read is the disk, so a listed path missing from disk (an unstaged
 *  rm, or any `git rm`/`git mv` judged under guard-reach's HEAD-index baseline) is never read. */
function discoverTestFiles(cwd = process.cwd(), env = process.env) {
  const listed = execFileSync("git", ["ls-files", "-z"], { cwd, env, encoding: "utf8" })
    .split("\0")
    .filter((f) => TEST_RE.test(f));
  return listedOnDisk(cwd, env, listed);
}

/**
 * Listed paths, split by what the disk holds: `present` is a regular file and is read.
 * `stagedMissing` has no regular file while `git diff --cached` names it — the next commit carries
 * index content this tool cannot read — refused. `skipped` is everything else with no regular file:
 * no staged change: the next commit keeps HEAD's copy (a sparse checkout; an unstaged rm under
 * `git commit`) or deletes it (an unstaged rm under `git commit -a` or a colocated-jj commit), or
 * carries no content git commits (an intent-to-add entry, though `jj commit` keeps a file jj added
 * and wrote so; an untracked dangling link). Its content is NOT
 * re-judged here — the same boundary as a committed file edited on disk; complexity-gate refuses a
 * skip the index lists and its baseline holds rows for (refuseMissingSources). Under
 * guard-reach's HEAD-index copy `diff --cached` is empty, so a
 * correct `git rm`/`git mv` is skipped rather than refused here. `--relative` keeps diff's
 * names in ls-files' cwd-relative form. complexity-gate imports this: one law, one copy.
 */
export function listedOnDisk(cwd, env, files) {
  const split = { present: [], stagedMissing: [], skipped: [] };
  let staged = null;
  for (const f of files) {
    if (statSync(join(cwd, f), { throwIfNoEntry: false })?.isFile()) {
      split.present.push(f);
      continue;
    }
    staged ??= new Set(execFileSync("git", ["diff", "--cached", "--name-only", "-z", "--relative"], { cwd, env, encoding: "utf8" }).split("\0"));
    (staged.has(f) ? split.stagedMissing : split.skipped).push(f);
  }
  return split;
}

export const shq = (word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

export const stagedMissingRefusal = (p) =>
  `${p} is staged but missing from disk — its index content cannot be judged\n  fix: restore it (git --literal-pathspecs checkout -- ${shq(p)}) or, if you deleted it for good in a full checkout, stage the deletion (git --literal-pathspecs rm -- ${shq(p)})`;

/** The skip note: what listedOnDisk checked, and no more. */
export const skippedNote = (skipped) => `skipped ${skipped.length} listed path(s) with no regular file on disk and no staged change: ${skipped.map(shq).join(" ")}`;

/** Discovery as main uses it: staged-but-missing content refuses (exit 1, the rest still linted, as
 *  for a missing positional path); skipped paths are NAMED, so an accidental rm is seen. */
function discovered() {
  const { present, stagedMissing, skipped } = discoverTestFiles();
  for (const p of stagedMissing) console.error(`test-lint: ${stagedMissingRefusal(p)}`);
  if (stagedMissing.length > 0) process.exitCode = 1;
  if (skipped.length > 0) console.error(`test-lint: ${skippedNote(skipped)}`);
  return present;
}

/**
 * Explicit paths are walked as given: a file is linted as-is, a directory recursively for
 * lintable REGULAR files — a dangling symlink died on ENOENT and a FIFO would hang the read.
 * `node_modules` and `.git` are never descended into.
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
    else if (stat?.isFile() && LINTABLE_RE.test(entry)) out.push(full);
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
 *
 * ONE LEFT-TO-RIGHT TOKEN PASS: string, template and regex literals are matched in the same pass as
 * comments, so whichever starts first is consumed whole — order is the algorithm. The two-regex
 * stripper this replaces ran its comment pass over string contents, so a glob like "src/*" opened a
 * fake block comment that blanked real code up to the next `*\/` and hid both blocking checks. A
 * regex literal is recognised by what precedes it (an operator, an arrow's `>`, an opening bracket,
 * `return`, or a line start), so a quote or backtick inside one opens nothing. A line start counts
 * only when the line before does not end an expression (a word, `)` or `]`): `total\n  / count` is
 * division, as JS reads it, and taking it for a regex swallowed a backtick and blanked every line
 * to the next one. A template is matched with its `${}` balanced (see `template`), so a template
 * nested in one does not end the outer: cut at the inner backtick, the `}/` closing the `${}` read
 * as a regex opening and a template ran on over the comment below.
 * ponytail: a heuristic, not a parser — a regex right after `)`, a regex opening a line after a
 * comment that ends in a word, a `${}` nested past TEMPLATE_DEPTH or holding a regex or comment
 * with a quote, brace or backtick in it (the plain backtick-to-backtick span then applies), and a
 * glob in JSX text (`<p>src/*.ts</p>` opens a block comment) still misread, and a template that
 * never closes costs time quadratic in the templates nested in it; bring in a real tokenizer if
 * any shows up in a test.
 */
const STRING = String.raw`"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'`;
const TEMPLATE_DEPTH = 3;

/**
 * A template literal whose `${}` holds code — strings, balanced braces, further templates —
 * `depth` levels deep; at 0, the plain backtick-to-backtick span. A `$` before `{` must open a
 * substitution, so a template parses one way only and a failed match costs no backtracking blow-up.
 */
function template(depth) {
  if (depth === 0) return String.raw`\`(?:\\.|[^\\\`])*\``;
  return String.raw`\`(?:\\.|\$\{${code(depth)}\}|\$(?!\{)|[^\\\`$])*\``;
}

/** The code between a `${` or `{` and its `}`, `depth` levels deep. */
function code(depth) {
  const nested = depth === 0 ? "" : String.raw`|\{${code(depth - 1)}\}|${template(depth - 1)}`;
  return String.raw`(?:[^{}\`"']|${STRING}${nested})*`;
}

const TOKENS = new RegExp(
  String.raw`(${STRING}|${template(TEMPLATE_DEPTH)}|${template(0)}|(?<=(?:(?<![\w$)\]]\s*)^|[(,=:[!&|?{};>]|\breturn)\s*)\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[a-z]*)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)`,
  "gm",
);

const blank = (text) => text.replace(/[^\n]/g, " ");

/**
 * Comments blanked; literals kept — or, with `emptyStrings`, string and template contents blanked
 * between their quotes, and with `emptyRegexes`, regex literals blanked whole.
 */
function mask(source, emptyStrings, emptyRegexes = false) {
  return source.replace(TOKENS, (token, literal) => {
    if (literal === undefined || (emptyRegexes && token[0] === "/")) return blank(token);
    return emptyStrings && "\"'`".includes(token[0]) ? token[0] + blank(token.slice(1, -1)) + token.at(-1) : token;
  });
}

export function stripComments(source) {
  return mask(source, false);
}

function strip(source) {
  return mask(source, true);
}

/**
 * `expect(X).toBe(X)` / `toEqual` / `toStrictEqual` where both sides are textually identical.
 *
 * FOUND on fully-stripped text, so a string or comment cannot host a fake assertion; JUDGED on the
 * comment-stripped text at the same offsets (blanking keeps length), because a blanked literal is
 * all spaces and its contents are the evidence. Judged blanked, identical templates and strings
 * were once skipped as "not evidence" — `expect(`${r}`).toBe(`${r}`)` passed — while
 * `expect(a + "x").toBe(a + "y")` read as a tautology.
 */
export function findTautologies(stripped, raw) {
  const code = stripComments(raw);
  const out = [];
  const re = /expect\(\s*([^)]{1,80}?)\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\(\s*([^)]{1,80}?)\s*\)/dg;
  for (const m of stripped.matchAll(re)) {
    const [lhs, rhs] = [m.indices[1], m.indices[2]].map(([from, to]) => code.slice(from, to).trim());
    if (lhs.length === 0 || lhs !== rhs) continue;
    out.push({
      index: m.index ?? 0,
      detail: `expect(${lhs}) compared to itself — asserts nothing\n      fix: assert against an independently derived expected value, or delete the placeholder`,
    });
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
  if (!readsSource) return [];
  // The EXEMPTION is judged on code only, or this check repeats the mistake it exists for: a TODO
  // naming stripComments, a message quoting `strip(` or the strip regex, or an assertion's regex
  // matching the strip call is text about the fix, not the fix. The regex-idiom arms read
  // `stripped` — comments and string contents gone, regex literals kept, since the strip regex IS
  // one; the name arms read `bare`, where regex literals are gone too.
  const bare = mask(raw, true, true);
  const stripsComments =
    /replace\(\s*\/\\\/\\\*/.test(stripped) ||
    /\/\\\/\\\*\[\\s\\S\]\*\?\\\*\\\//.test(stripped) ||
    /replace\([^)]*\/\*/.test(stripped) ||
    bare.includes("stripComments") ||
    bare.includes("strip(");
  if (stripsComments) return [];
  const index = commentsGone.search(/readFileSync/);
  return [
    {
      index: index === -1 ? 0 : index,
      detail:
        "reads a source file and asserts on its content without stripping comments — a comment quoting " +
        "the asserted string makes this pass or fail for the wrong reason (happened twice in a single " +
        "day at the origin repo)\n      fix: pass the read through stripComments() (exported by tools/test-lint.mjs) before asserting on it",
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

/** Discovery, run for real: git C-quotes a non-ASCII, `"` or `\` path in plain `ls-files` output
 *  (`"caf\303\251.test.mjs"`), which TEST_RE never matches — the test file went unlinted with nothing
 *  printed. Driven in a scratch repo with the inherited GIT_* env removed: inside a hook GIT_DIR /
 *  GIT_INDEX_FILE name the HOST repo. core.quotePath is forced back on: under a user's
 *  `quotepath = false` git prints the name raw and a listing without -z passed this case. */
function discoversNonAsciiTest() {
  const dir = mkdtempSync(join(tmpdir(), "test-lint-ls-"));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.quotePath",
    GIT_CONFIG_VALUE_0: "true",
  };
  try {
    writeFileSync(join(dir, "café.test.mjs"), "x\n");
    execFileSync("git", ["init", "-q"], { cwd: dir, env, stdio: "ignore" });
    execFileSync("git", ["add", "café.test.mjs"], { cwd: dir, env, stdio: "ignore" });
    return discoverTestFiles(dir, env).present.includes("café.test.mjs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A scratch-repo git with an identity and none of the user's hooks or signing. */
const scratchGit = (dir, env) => (...args) =>
  execFileSync("git", ["-c", "user.name=selftest", "-c", "user.email=selftest@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, env, stdio: "ignore" });

/** This lint in discovery mode, run as a child in `dir`: its exit status and both streams. */
function lintIn(dir, env) {
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { cwd: dir, env, encoding: "utf8" });
  return { status: run.status, stdout: run.stdout, out: `${run.stdout}\n${run.stderr}` };
}

/** The index is the LIST and the disk is the TEXT. A committed test file deleted but not staged is
 *  in one and not the other: it was handed to readFileSync and the lint died on ENOENT — and under
 *  guard-reach's HEAD-index baseline every correct `git rm` / `git mv` did the same. It carries no
 *  staged change, so it is skipped and NAMED; a violation beside it must still be caught. The name
 *  says what the check proved and nothing more: an intent-to-add entry (`git add -N`, then rm) also
 *  has no staged change, yet HEAD never held it — "content equals HEAD" was a false statement.
 *  Driven for real, in a scratch repo. */
function vanishedTestCases(t) {
  const dir = mkdtempSync(join(tmpdir(), "test-lint-gone-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const git = scratchGit(dir, env);
  try {
    writeFileSync(join(dir, "kept.test.mjs"), "expect(true).toBe(true);\n");
    writeFileSync(join(dir, "gone.test.mjs"), "x\n");
    git("init", "-q");
    git("add", "kept.test.mjs", "gone.test.mjs");
    git("commit", "-q", "-m", "seed");
    rmSync(join(dir, "gone.test.mjs"));
    writeFileSync(join(dir, "ita.test.mjs"), "x\n");
    git("add", "-N", "ita.test.mjs");
    rmSync(join(dir, "ita.test.mjs"));
    const gone = lintIn(dir, env);
    t(
      "vanished-test-file-read: a tracked test file missing from disk is not handed to the reader",
      gone.status === 1 && gone.out.includes("kept.test.mjs:1 TAUTOLOGY") && gone.out.includes("gone.test.mjs") && !gone.out.includes("ENOENT"),
    );
    t(
      "skip-label-false: a skipped path is named for what was checked (no regular file on disk, no staged change), never as content equal to HEAD",
      gone.out.includes("test-lint: skipped 2 listed path(s) with no regular file on disk and no staged change: gone.test.mjs ita.test.mjs"),
    );
    stagedMissingCases(t, dir, env, git);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Content staged and then deleted exists only in the index, so skipping it would pass the commit
 *  that carries it: it refuses with the two remedies, and the run must not END on the clean verdict
 *  (the refusal once scrolled past on stderr above a closing "no bug-pinned tests"). Run from a
 *  subdirectory too: ls-files names paths from the cwd while `diff --cached` without --relative
 *  names them from the root, and the refusal silently became a skip. */
function stagedMissingCases(t, dir, env, git) {
  writeFileSync(join(dir, "kept.test.mjs"), "expect(a).toBe(b);\n");
  mkdirSync(join(dir, "sub"));
  for (const file of ["new.test.mjs", "sub/deep.test.mjs"]) {
    writeFileSync(join(dir, file), "x\n");
    git("add", file);
    rmSync(join(dir, file));
  }
  const staged = lintIn(dir, env);
  t(
    "staged-missing-test-unjudged: a staged test file missing from disk refuses with its remedy",
    staged.status === 1 && staged.out.includes("test-lint: new.test.mjs is staged but missing from disk") && staged.out.includes("fix: restore it (git --literal-pathspecs checkout -- new.test.mjs) or, if you deleted it for good in a full checkout, stage the deletion (git --literal-pathspecs rm -- new.test.mjs)"),
  );
  t("refusal-ends-green: a refused run does not end on the clean verdict", !staged.stdout.includes("no bug-pinned tests") && staged.out.includes("test-lint: FAILED"));
  const deep = lintIn(join(dir, "sub"), env);
  t("staged-missing-subdir-skipped: run from a subdirectory, staged content missing from disk still refuses", deep.status === 1 && deep.out.includes("test-lint: deep.test.mjs is staged but missing from disk"));
}

/** walk() handed any LINTABLE_RE name to the reader, so a dangling symlink under a walked
 *  directory died on ENOENT (and a FIFO would hang the read): only a regular file is lintable. */
function walksPastDanglingLink() {
  const dir = mkdtempSync(join(tmpdir(), "test-lint-walk-"));
  try {
    writeFileSync(join(dir, "real.mjs"), "x\n");
    symlinkSync("nowhere.mjs", join(dir, "dangle.mjs"));
    const seen = walk(dir);
    return seen.length === 1 && seen[0] === `${dir}/real.mjs`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

function selfTest() {
  const cases = [];
  const t = (name, pass) => cases.push([name, pass]);
  const taut = (source) => findTautologies(strip(source), source);

  t("flags expect(true).toBe(true)", taut("expect(true).toBe(true);").length === 1);
  t("flags expect(x).toBe(x)", taut("expect(row.id).toBe(row.id);").length === 1);
  t("does NOT flag a real assertion", taut("expect(row.id).toBe(other.id);").length === 0);
  // The check must not fire on its own documentation — the strip pass blanks string contents.
  t(
    "does NOT flag a tautology quoted inside a string",
    taut('const msg = "expect(true).toBe(true)";').length === 0,
  );
  // ...nor on one inside a comment, which is the mistake this lint exists to prevent.
  t(
    "does NOT flag a tautology inside a comment",
    taut("// e.g. expect(true).toBe(true) is meaningless\nexpect(a).toBe(b);").length === 0,
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
  // The EXEMPTION is judged on code too: prose that merely names a strip idiom is not a strip.
  const todoComment = `// TODO: stripComments before asserting\n${sibling}`;
  t("exempt-by-comment: a comment naming stripComments does not excuse the read", findUnstrippedSourceReads(strip(todoComment), todoComment).length === 1);
  const stringMention = `const note = "call strip( first";\n${sibling}`;
  t("exempt-by-string: a string naming strip( does not excuse the read", findUnstrippedSourceReads(strip(stringMention), stringMention).length === 1);
  const helperStrip = `import { stripComments } from "../tools/test-lint.mjs";\nconst s = stripComments(readFileSync(new URL("./thing.ts", import.meta.url), "utf8"));`;
  t("does NOT flag a read passed through stripComments()", findUnstrippedSourceReads(strip(helperStrip), helperStrip).length === 0);
  // ...and the regex-idiom arms likewise: a string or comment QUOTING the strip regex is no strip.
  const replaceQuoted = `const note = "never call s.replace(/* nothing */) here";\n${sibling}`;
  t("replace-comment-in-string: a string quoting replace(/* does not excuse the read", findUnstrippedSourceReads(strip(replaceQuoted), replaceQuoted).length === 1);
  const idiomQuoted = `const note = "s.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '') first";\n${sibling}`;
  t("strip-regex-in-string: a string quoting the strip regex does not excuse the read", findUnstrippedSourceReads(strip(idiomQuoted), idiomQuoted).length === 1);
  const idiomTodo = `// TODO: s.replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")\n${sibling}`;
  t("strip-regex-in-comment: a comment quoting the strip regex does not excuse the read", findUnstrippedSourceReads(strip(idiomTodo), idiomTodo).length === 1);

  // STRINGS ARE NOT COMMENTS. A glob like "src/*" once opened a fake block comment that blanked
  // every line up to the next `*/` (a later JSDoc), hiding both blocking checks.
  const globTautology = 'const p = "src/*";\nexpect(true).toBe(true);\n/** h */';
  t("glob-string-opens-comment: a \"src/*\" string hides the tautology after it", taut(globTautology).length === 1);
  const globRead = `const p = "src/*";\n${sibling}\n/** h */`;
  t("glob-string-hides-read: a \"src/*\" string hides the source read after it", findUnstrippedSourceReads(strip(globRead), globRead).length === 1);
  t("does NOT treat a // inside a string as a comment", stripComments('const u = "https://x"; f();') === 'const u = "https://x"; f();');
  t("does NOT flag equal-length blanked templates", taut("expect(`ab`).toBe(`cd`);").length === 0);
  // A regex literal carrying a quote or a backtick must not open a string that runs on.
  t("a quote inside a regex literal opens no string", taut('const r = /"/; expect(true).toBe(true); const q = "x";').length === 1);
  t("a backtick inside a regex literal opens no template", taut("const r = /`/g;\nexpect(true).toBe(true);\nconst q = `x`;").length === 1);
  t("regex-after-arrow: a backtick in a regex after => opens no template", taut("const f = (s) => /`/.test(s);\nexpect(true).toBe(true);\nconst q = `x`;").length === 1);
  t("regex-after-return: a backtick in a regex after return opens no template", taut("function f() { return /`/g; }\nexpect(true).toBe(true);\nconst q = `x`;").length === 1);
  // ...and a line that OPENS with `/` after an expression is division, as JS reads it: taken for a
  // regex it swallowed a backtick and blanked every line to the next one.
  t("leading-division: a line opening with / after an expression is division, not a regex", taut("const avg = total\n  / count; const label = `a/b`;\nexpect(true).toBe(true);\nconst z = `end`;").length === 1);
  // A template nested in a template's `${}` must not end the outer one: cut at the inner backtick,
  // the `}/` that closes the `${}` read as a regex opening, swallowed the next backtick, and a
  // template ran on over the comment below — kept as code for doc-reconcile's grep evidence.
  const nested = stripComments("die(`pins: ${xs.map((p) => ` /${p}/`).join(\", \")} fix: tools/x`);\n// onlyInAComment\nconsole.log(`done`);\n");
  t("template-brace-opens-regex: a `}/` closing a template's ${} leaves the next comment blanked", !nested.includes("onlyInAComment") && nested.includes("console.log(`done`)"));
  const templateMention = "const note = `call stripComments first`;\n" + sibling;
  t("exempt-by-template: a template naming stripComments does not excuse the read", findUnstrippedSourceReads(strip(templateMention), templateMention).length === 1);
  const regexMention = "expect(src).toMatch(/stripComments\\(readFileSync/);\n" + sibling;
  t("strip-name-in-regex-literal: a regex naming stripComments does not excuse the read", findUnstrippedSourceReads(strip(regexMention), regexMention).length === 1);

  // Blanking finds the assertion; the literal text judges it. A blanked operand once read as "not
  // evidence", so identical templates and strings stopped being tautologies.
  t("template-tautology: identical templates still flag", taut("expect(`user-${id}`).toBe(`user-${id}`);\nexpect(`abc`).toEqual(`abc`);").length === 2);
  t("literal-tautology: identical string literals still flag", taut('expect("abc").toBe("abc");').length === 1);
  t("does NOT flag differing literals behind a shared prefix", taut('expect(a + "x").toBe(a + "y");').length === 0);

  // Every blocking finding carries its remedy, as every refusal in this harness must.
  t("blocking-without-fix: a TAUTOLOGY finding names its fix", taut("expect(true).toBe(true);")[0]?.detail.includes("fix:"));
  t("blocking-without-fix: an UNSTRIPPED finding names its fix", findUnstrippedSourceReads(strip(sibling), sibling)[0]?.detail.includes("fix:"));

  t(
    "advisory flags an echoed expectation",
    findEchoedExpectations('const seed = { caption: "hello world" };\nexpect(row.caption).toBe("hello world");').length === 1,
  );
  t("advisory ignores an unseeded expectation", findEchoedExpectations('expect(row.caption).toBe("hello world");').length === 0);
  // Discovery must see every tracked test file byte for byte, not git's C-quoted rendering of it.
  t("quoted-test-path-invisible: a non-ASCII test file is discovered", discoversNonAsciiTest());
  vanishedTestCases(t);
  t("dangling-link-read: walk() hands only regular files to the reader", walksPastDanglingLink());

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
  const files = positional.length > 0 ? expandPaths(positional) : discovered();

  const blocking = [];
  const advisory = [];

  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const stripped = strip(raw);
    for (const hit of findTautologies(stripped, raw)) {
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

  return verdictOf(blocking);
}

/** The run's last word. A refusal that set process.exitCode (staged content missing from disk, a
 *  missing positional path) linted the rest and must not then end on the clean verdict. */
function verdictOf(blocking) {
  if (blocking.length > 0) {
    console.error("test-lint: FAILED — a test that passes for the wrong reason is worse than no test.");
    return 1;
  }
  if (process.exitCode) {
    console.error("test-lint: FAILED — a path above could not be judged; its refusal names the fix.");
    return process.exitCode;
  }
  console.log("test-lint — no bug-pinned tests.");
  return 0;
}

/**
 * CLI, guarded by an entry-module check (pathspec's lesson): this module exports its checks and
 * may be imported by other tools, so a bare `process.argv.includes(...)` test would fire the CLI
 * on IMPORT and exit before the importer's own self-test could run.
 */
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
  const verdict = main();
  process.exit(verdict === 0 && process.exitCode !== undefined ? process.exitCode : verdict);;
}
