/**
 * PATHSPEC — the one path-matching module every guard uses.
 *
 * WHY THIS EXISTS (ported from the Antitube harness, 2026-09-20). Four guards each invented
 * their own dialect, with no shared code:
 *
 *   one guard            `{ glob: "packages/core/**" }`  string mini-glob, first-match-wins
 *   another              `(p) => p.includes("migrate")`  free-form predicate, multi-match
 *   a third              `{ glob: /^apps\/web\/.*$/}`     anchored RegExp, any-match
 *   a fourth, off alone  `/^apps\/(api|web)\/src\//`      a fourth dialect, in the corner
 *
 * The same key name `glob` held a STRING in one module and a RegExp in another. That is not a
 * cosmetic inconsistency — it decides incidents. When a refactor moved files, one matcher caught
 * them because it used a PREFIX, and another lost them because it used EXACT FILENAMES. One
 * matcher survived the refactor and one silently didn't, and the one that didn't was a fail-closed
 * fence. One matcher, one dialect, self-tested here.
 *
 * THE INTERFACE IS DELIBERATELY THREE FUNCTIONS. `matches` answers yes/no; `explain` returns
 * every matching spec so a caller can report WHY; `firstMatch` gives guards where the first hit
 * wins. Everything else — glob dialect, prefix semantics, negation — is implementation. A guard
 * that needs a new matching capability adds it here, once, where the self-test can see it.
 *
 * DIALECT (deliberately small — the whole point is that there is only one):
 *   "a/b/c.ts"     exact path
 *   "a/b/**"       that directory and everything beneath it
 *   "a/**\/*.ts"   glob segments; `**` spans zero or more path segments, `*` spans one
 *   "a?c"          `?` spans exactly one character, never a separator (the scope dialect's
 *                  tier law matches `.githook?/**` through it — a dropped `?` fails that law OPEN)
 *   /^regex$/      a RegExp, tested against the path as-is
 *   (p) => bool    a predicate, for the handful of rules that genuinely need one
 *
 * `**` SPANNING ZERO SEGMENTS IS NOT A DETAIL. A linter's `apps/web/scripts/**\/*.mjs` must match
 * `apps/web/scripts/copy-thing.mjs` — zero intervening segments. A matcher that requires at least
 * one is wrong in a way that only shows up on the file nobody thought about.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** @typedef {string | RegExp | ((path: string) => boolean)} Spec */

const GLOB_CACHE = new Map();

/**
 * Compile a string glob to an anchored RegExp.
 *
 * Order matters: `**\/` must be consumed before `**`, and `**` before `*`, or a `*` rule eats the
 * second star and every `**` silently narrows to a single segment — exactly the drift a gate
 * census is written to detect between its own regexes and a linter config.
 */
function globToRegExp(glob) {
  const cached = GLOB_CACHE.get(glob);
  if (cached !== undefined) return cached;

  // A bare `dir/**` means the directory itself AND everything under it. Handled before the general
  // compiler because "the directory itself" is not something a path glob expresses naturally.
  let source = "";
  let i = 0;
  while (i < glob.length) {
    const rest = glob.slice(i);
    if (rest.startsWith("**/")) {
      source += "(?:[^/]+/)*"; // zero or more whole segments
      i += 3;
    } else if (rest.startsWith("**")) {
      source += ".*";
      i += 2;
    } else if (rest.startsWith("*")) {
      source += "[^/]*"; // one segment, no separator
      i += 1;
    } else if (rest.startsWith("?")) {
      source += "[^/]";
      i += 1;
    } else {
      source += glob[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  const compiled = new RegExp(`^${source}$`);
  GLOB_CACHE.set(glob, compiled);
  return compiled;
}

/** Does `path` match one spec? */
export function matches(path, spec) {
  if (typeof spec === "function") return spec(path);
  if (spec instanceof RegExp) return spec.test(path);
  if (typeof spec !== "string") {
    throw new TypeError(`pathspec: unsupported spec ${Object.prototype.toString.call(spec)}`);
  }
  // `dir/**` covers the directory node itself, which a pure glob does not.
  if (spec.endsWith("/**")) {
    const prefix = spec.slice(0, -3);
    if (path === prefix || path.startsWith(`${prefix}/`)) return true;
  }
  return globToRegExp(spec).test(path);
}

/**
 * Every entry whose `spec` matches, in declaration order.
 *
 * Entries are `{ spec, ...rest }`; `rest` is returned untouched so each guard keeps its own
 * payload (`why` for a fence, `title`/`body` for an obligations table, nothing for a census).
 * The module matches paths; it does not have opinions about what a match means.
 */
export function explain(path, entries) {
  return entries.filter((entry) => matches(path, entry.spec));
}

/** First matching entry, or null. For guards where the first hit wins. */
export function firstMatch(path, entries) {
  return entries.find((entry) => matches(path, entry.spec)) ?? null;
}

/**
 * Self-test. NEGATIVE CASES ARE THE POINT: a matcher that says yes to everything passes any
 * positive-only suite while certifying a hole. Each case below is a real path shape or a real
 * near-miss that a previous matcher got wrong.
 */
export function selfTest() {
  /** @type {Array<[string, Spec, boolean, string]>} */
  const cases = [
    // exact
    ["packages/db/src/schema.ts", "packages/db/src/schema.ts", true, "exact hit"],
    ["packages/db/src/schema.ts2", "packages/db/src/schema.ts", false, "exact must anchor at the end"],
    ["xpackages/db/src/schema.ts", "packages/db/src/schema.ts", false, "exact must anchor at the start"],

    // dir/** — including the directory node itself
    ["packages/core", "packages/core/**", true, "dir/** covers the directory node"],
    ["packages/core/src/tier.ts", "packages/core/**", true, "dir/** covers descendants"],
    ["packages/core/src/a/b/c.ts", "packages/core/**", true, "dir/** is arbitrary depth"],
    ["packages/coreExtra/x.ts", "packages/core/**", false, "dir/** must not match a sibling prefix"],

    // ** spanning ZERO segments — the case that made a census disagree with a linter config
    ["apps/web/scripts/copy-thing.mjs", "apps/web/scripts/**/*.mjs", true, "** spans zero segments"],
    ["apps/web/scripts/a/b/x.mjs", "apps/web/scripts/**/*.mjs", true, "** spans many segments"],
    ["apps/api/src/main.ts", "apps/**/src/**/*.ts", true, "linter-style nested **"],
    ["apps/api/src/deep/nested/main.ts", "apps/**/src/**/*.ts", true, "nested ** at both ends"],
    ["apps/src/main.ts", "apps/**/src/**/*.ts", true, "leading ** may span zero"],

    // * must not cross a separator
    ["apps/api/x.config.ts", "apps/*/x.config.ts", true, "* spans one segment"],
    ["apps/api/sub/x.config.ts", "apps/*/x.config.ts", false, "* must NOT cross a separator"],

    // ? spans exactly one character — never zero (a live regex quantifier), never a separator
    [".githooks", ".githook?", true, "? matches one char"],
    [".githook", ".githook?", false, "? must match exactly one char, not zero (never a live regex quantifier)"],
    ["a/b", "a?b", false, "? must NOT cross a separator"],

    // extension discipline
    ["apps/web/test/a.tsx", "apps/**/test/**/*.ts", false, "*.ts must not match .tsx"],
    ["apps/web/test/a.ts", "apps/**/test/**/*.ts", true, ".ts matches"],

    // dotfiles at the root
    [".dependency-cruiser.cjs", "*.cjs", true, "root glob matches a dotfile"],
    ["tools/x.cjs", "*.cjs", false, "root glob must not descend"],

    // regex + predicate specs
    ["apps/worker/src/screening-verdicts.ts", /^apps\/worker\/src\/screening/, true, "RegExp spec"],
    ["apps/worker/src/embedding.ts", /^apps\/worker\/src\/screening/, false, "RegExp spec, negative"],
    ["packages/db/drizzle/0020_x.sql", (p) => p.startsWith("packages/db/drizzle/"), true, "predicate spec"],
    ["packages/db/src/index.ts", (p) => p.startsWith("packages/db/drizzle/"), false, "predicate spec, negative"],

    // regex metacharacters in a literal glob must not be live
    ["packages/db/srcXindex.ts", "packages/db/src/index.ts", false, "a literal dot is not a wildcard"],
  ];

  let ok = true;
  for (const [path, spec, expected, why] of cases) {
    let got;
    try {
      got = matches(path, spec);
    } catch (error) {
      console.error(`pathspec SELF-TEST ERROR: ${why} — ${String(error)}`);
      ok = false;
      continue;
    }
    if (got !== expected) {
      console.error(`pathspec SELF-TEST FAIL: ${why}\n    path=${path}\n    spec=${spec}\n    expected=${expected} got=${got}`);
      ok = false;
    }
  }

  // explain/firstMatch semantics, since guards depend on the difference — and the module's one
  // refusal: a spec of no known kind throws, it never quietly matches or misses
  const entries = [
    { spec: "packages/**", tag: "broad" },
    { spec: "packages/db/src/schema.ts", tag: "narrow" },
  ];
  const all = explain("packages/db/src/schema.ts", entries).map((e) => e.tag);
  const semantics = [
    [all.join(",") === "broad,narrow", `explain must return ALL matches in order, got ${all}`],
    [firstMatch("packages/db/src/schema.ts", entries)?.tag === "broad", "firstMatch must return the first declared match"],
    [firstMatch("README.md", entries) === null, "firstMatch must return null on no match"],
    [refusesUnsupported(() => matches("x", 42)), "an unsupported spec must throw pathspec's own TypeError, never match or miss"],
  ];
  for (const [passes, why] of semantics) {
    if (!passes) {
      console.error(`pathspec SELF-TEST FAIL: ${why}`);
      ok = false;
    }
  }

  console.log(ok ? `pathspec self-test: OK (${cases.length} cases + ${semantics.length} semantics)` : "pathspec self-test: FAILED");
  return ok;
}

/** Did `run` throw the unsupported-spec refusal? Its own message, not any TypeError: a number
 *  spec also crashes natively on `.endsWith`, which would witness a refusal that never ran. */
function refusesUnsupported(run) {
  try {
    run();
    return false;
  } catch (error) {
    return error instanceof TypeError && error.message.startsWith("pathspec: unsupported spec");
  }
}

/**
 * CLI, guarded by an entry-module check.
 *
 * `process.argv.includes("--self-test")` alone is WRONG here: this module is imported by guards
 * that take their own `--self-test`, so a bare argv check fires on IMPORT and `process.exit()`s
 * before the importing guard's self-test can run. A guard's self-test silently stopped running
 * the moment this file was imported into it — a control disabled by the very module added to make
 * controls consistent. Caught because the guard printed pathspec's self-test line instead of its
 * own.
 */
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isEntry && process.argv.includes("--self-test")) {
  process.exit(selfTest() ? 0 : 1);
}
