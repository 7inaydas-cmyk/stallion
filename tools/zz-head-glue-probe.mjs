#!/usr/bin/env node
/**
 * Pins the glue law against the COMMITTED artifact, not the working tree: a resolution recorded
 * in a findings register must be true at the commit that carries it. Exit 1 while HEAD's
 * guard-reach.mjs still splices the captured streams without a separator.
 *
 * The law is read from CODE only: comments are stripped first (a trailing `// was: …` quoting the
 * separated form satisfied the raw-text match while the call site spliced), and no test label is
 * required (rewording guard-reach's case name reddened the battery with the behaviour unchanged).
 */
import { realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stripComments } from "./test-lint.mjs";
import { GLUE_SITE } from "./guard-reach.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));


/** Pure: does this guard-reach source carry the glue law in its code? */
export function glueVerdict(src) {
  return GLUE_SITE.test(stripComments(src));
}

/** The verdict against fixture sources — both directions, because a probe that passes everything
 *  pins nothing and one that fails on a label reword pins prose, not code. */
export function selfTest() {
  const separated = 'return { output: `${error.stdout ?? ""}\\n${error.stderr ?? ""}` };\n';
  const spliced = 'return { output: `${error.stdout ?? ""}${error.stderr ?? ""}` };\n';
  const label = '["runGuard separates stdout from stderr (the glue law, call-site pinned)", x, true],\n';
  const cases = [
    ["a separated call site carries the law", separated + label, true],
    ["a spliced call site lacks the law", spliced + label, false],
    ["a spliced call site lacks the law even when a comment quotes the separated form", `${label}${spliced}// was: \${error.stdout ?? ""}\\n\${error.stderr ?? ""}\n`, false],
    ["a separated call site carries the law whatever the self-test label says", separated, true],
  ];
  const failures = cases.filter(([, src, expected]) => glueVerdict(src) !== expected).map(([name]) => name);
  for (const name of failures) console.error(`zz-head-glue-probe SELF-TEST FAIL: ${name}`);
  console.log(failures.length === 0 ? `zz-head-glue-probe self-test: OK (${cases.length} cases)` : `zz-head-glue-probe self-test: FAILED (${failures.length} failure(s))`);
  return failures.length === 0;
}

const RULE = "  rule: the COMMITTED tools/guard-reach.mjs must join the captured streams with a newline at runGuard's call site — a fix in the working tree alone is not a landed fix";

function runProbe() {
  let src;
  try {
    src = execSync("git show HEAD:tools/guard-reach.mjs", { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    console.error(`zz-head-glue-probe: cannot read HEAD's tools/guard-reach.mjs — ${String(error.stderr || error.message).trim().split("\n")[0]}`);
    console.error(RULE);
    console.error(`  fix: git -C ${ROOT} log -1 --oneline -- tools/guard-reach.mjs   — HEAD must carry the file; commit it under its task footer`);
    process.exit(1);
  }
  if (!glueVerdict(src)) {
    console.error("HEAD lacks the glue law: runGuard still splices stdout and stderr without a separator");
    console.error(RULE);
    console.error("  fix: git diff HEAD -- tools/guard-reach.mjs   — restore `${error.stdout ?? \"\"}\\n${error.stderr ?? \"\"}` at runGuard's call site if it is not there, then commit it under its task footer");
    process.exit(1);
  }
  console.log("HEAD carries the glue law (separated call site present in code)");
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
  if (process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  runProbe();
}
