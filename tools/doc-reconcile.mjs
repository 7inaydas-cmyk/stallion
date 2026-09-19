#!/usr/bin/env node
/**
 * DOC-RECONCILIATION GATE — prose invariants re-proved against code, every run.
 *
 * Turns named prose invariants into executable checks. A load-bearing claim ("X is built AND wired",
 * "Y is served", "Z is write-only-inert") is registered in `docs/gates/doc-claims.json` together
 * with the CODE EVIDENCE that makes it true, and this gate re-proves the evidence on every run.
 * Ported from the Antitube harness (2026-09-20); the laws came over unchanged, and so did the
 * reasons they exist.
 *
 * WHY. Prose cannot fail, and every law below was learned from a prose claim that stayed green
 * while false. In the harness this was written for: `pnpm lint` was described as a gate while
 * being a repo-wide echo no-op for 26 days; the harness docs described a version as current
 * across 168 commits of drift; three docs said SEVEN gates while an eighth was CI-hard-gated;
 * and six separate artifacts agreed GIVT was an in-process bucket when GIVT appears nowhere in
 * the API — the copies corroborated each other, which is exactly why it survived. A control
 * that verifies structure, or looks only at the latest diff, or runs against a double, can
 * never prove that what was written is correct. This makes a named prose claim fail.
 *
 * IT IS BIDIRECTIONAL, WHICH IS THE POINT. Each claim binds a sentence in a doc to evidence in code:
 *   - code drifts away from the claim  -> the evidence check fails
 *   - the doc's sentence is edited away -> the anchor check fails
 * Either direction means doc and reality have parted, and the gate cannot tell you which one is
 * wrong — only that they no longer agree. That is the honest signal; deciding which to fix is a
 * human's job.
 *
 * EVIDENCE KINDS
 *   symbol   `path:name`   the symbol must EXIST in that file (the "cites its live reader" form)
 *   absent   `path:name`   the symbol must NOT appear — for write-only-inert / no-caller claims
 *   grep     `path:regex`  the pattern must match somewhere in the file
 *   count    `path:regex:n` the pattern must match EXACTLY n times — for "seven call sites" claims
 *   repo-count `regex:n`   the pattern must match EXACTLY n times across the WHOLE CORPUS
 *
 * SELF-EXCLUSION. Two prior verifications of the very row this law was learned from were false
 * positives because a grep matched an audit's own recommendation text rather than an
 * implementation. Evidence paths therefore must point at CODE, never at `docs/**` — a claim
 * proved by prose is the failure this gate exists to prevent, and `--self-test` asserts that
 * rule is enforced.
 *
 * THE CORPUS IS COMMITTED, AND IT IS DECLARED IN THE CONFIG (the WS1 lesson). It used to be
 * hardcoded — two directory trees — and that is how this gate came to certify a claim it could
 * not see: the claim said "8 REPO-WIDE", and repo-wide there were ten — two more in dev seed
 * scripts, both minting the exact label the operator allowlist refuses on the grounds that an
 * operator must never mint the cascade's own output. The gate's arithmetic was right for its
 * corpus and the word "repo-wide" was not. Its own `why` had been written as the fix for a
 * binding that "was never pointed at a file that could contradict it" — so the mitigation
 * reproduced the defect one scope level up, which is the whole reason the corpus is now
 * DECLARED in `doc-claims.json` rather than hidden in this file, and PRINTED on every run.
 *
 * AND A SCOPE WORD NOW BINDS (fails closed). A claim whose ANCHOR says "repo-wide", "anywhere",
 * "zero", "nothing" — see SCOPE_WORDS — is a claim about the whole repository, and it MUST carry
 * at least one repo-wide evidence item. A universal sentence proved by a single-file check is not
 * weak evidence, it is the wrong evidence, and it is precisely the shape the original H-5 had.
 * The anchor is checked and the `why` is not: the anchor IS the claim, and these `why` fields are
 * narrative paragraphs where "never" and "nothing" occur for reasons that have nothing to do
 * with scope.
 *
 * USAGE
 *   node tools/doc-reconcile.mjs             check every registered claim
 *   node tools/doc-reconcile.mjs --self-test prove the checker discriminates
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { matches } from "./pathspec.mjs";

const CLAIMS = "docs/gates/doc-claims.json";

/**
 * Words that make a sentence a claim about the WHOLE repository rather than about one file.
 *
 * Deliberately short. A list this broad enough to catch every hedge would trip on ordinary prose and
 * force bad bindings, and a gate that forces bad bindings is worse than one with a known hole — so
 * these are only the words that assert universal quantification outright.
 */
export const SCOPE_WORDS = [
  "repo-wide",
  "repo wide",
  "anywhere",
  "everywhere",
  "nowhere",
  "zero",
  "none",
  "nothing",
  "no caller",
  "no producer",
  "no reader",
  "write-only-inert",
];

/** The scope word a sentence uses, or null. Case-insensitive: AGENTS.md shouts ("ZERO", "NOTHING"). */
export function scopeWordIn(text) {
  const flat = String(text).toLowerCase();
  return SCOPE_WORDS.find((word) => flat.includes(word)) ?? null;
}

/** Evidence paths must be code. A claim whose proof lives in prose proves nothing (see header). */
function evidencePathIsCode(path) {
  return !path.startsWith("docs/") && !path.endsWith(".md");
}

/**
 * String literals first, then comments. Order is the whole algorithm: a literal matched at position
 * `i` is emitted intact, so `"https://x"` and `"/* not a comment *\/"` survive, while a `//` reached
 * in code position blanks to end of line.
 */
const CODE_TOKENS = /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^\\`])*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g;

/**
 * Blank out comments, keeping length and line structure (comment bytes become spaces).
 *
 * WHY THIS EXISTS (the WS2 lesson, 2026-08-21, upstream). A claim was registered against
 * `grep single-replica.ts:pg_try_advisory_lock`. That string occurred in that file exactly once,
 * inside a JSDoc block, and the file made zero `query(` calls — the real acquisition lived in
 * `main.ts`. So a registered invariant was proved by a SENTENCE, in the one file that structurally
 * cannot contain the regression its own `why` describes. This gate's header already refuses `docs/`
 * evidence on the grounds that "a claim proved by prose proves nothing"; it just could not see that
 * a comment inside a source file is also prose. It is the same defect `test-lint.mjs` exists to
 * catch in tests, in the gate that was written after it.
 *
 * Masking rather than deleting, so a future evidence kind can still report an honest line number.
 *
 * KNOWN LIMITATION, stated rather than discovered later: regex LITERALS are not tracked, so a regex
 * containing `//` or `/*` would be misread as starting a comment. Tracking regex literals needs
 * division-vs-regex disambiguation, which is a parser, and a parser here would be a much bigger
 * thing to trust than the hole it closes.
 */
export function maskComments(text) {
  return text.replace(CODE_TOKENS, (match, literal) => (literal !== undefined ? match : match.replace(/[^\n]/g, " ")));
}

/**
 * The corpus a repo-wide claim is measured against: every tracked file of a declared extension,
 * minus the declared ignore globs. Both halves live in `doc-claims.json` so they are reviewable in a
 * diff, and `describeCorpus` prints them on every run so an exclusion can never be a quiet one.
 *
 * Matching is delegated to `pathspec.mjs` — the one dialect. This is not ceremony: writing the glob
 * matcher by hand for the throwaway measurement that sized the upstream change produced a
 * double-star-slash that silently narrowed to a single segment, so a nested file was NOT excluded
 * by its own test glob. Writing the same matcher a fifth time would be inviting the same bug.
 */
let corpusCache = null;
function repoCorpus(config) {
  if (corpusCache !== null) return corpusCache;
  const extensions = new RegExp(`\\.(${config.extensions.join("|")})$`);
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => extensions.test(f))
    .filter((f) => !config.ignore.some((entry) => matches(f, entry.glob)));
  corpusCache = files.map((file) => ({ file, text: maskComments(readFileSync(file, "utf8")) }));
  return corpusCache;
}

/** Count every match of `re` across `files`, returning the total and a per-file breakdown. */
function countAcross(files, re) {
  const hits = [];
  let total = 0;
  for (const { file, text } of files) {
    const n = (text.match(re) ?? []).length;
    if (n > 0) {
      hits.push(`${file} x${n}`);
      total += n;
    }
  }
  return { total, hits };
}

/**
 * REPO-WIDE, because a single-file binding cannot express "nothing ELSE does this" — and that is
 * exactly the shape that let a claim be false and green upstream (H-5, 2026-08-15): a claim
 * asserted producers were screening-only while checking only one controller for absence. When an
 * operator label surface shipped in a service file, the claim became false and the check stayed
 * green — it was never pointed at a file that could contradict it. A count across the whole corpus
 * can.
 *
 * A repo-count may narrow the corpus further with its own `ignore` list. Every entry carries a `why`
 * and every entry is PRINTED when the gate runs, because "exclude the file that contradicts you" is
 * the failure mode of exactly this feature and the only real defence is that it cannot be done
 * quietly.
 */
function checkRepoCount(evidence, config) {
  const lastColon = evidence.spec.lastIndexOf(":");
  const pattern = evidence.spec.slice(0, lastColon);
  const want = Number(evidence.spec.slice(lastColon + 1));
  const local = evidence.ignore ?? [];
  const files = repoCorpus(config).filter((f) => !local.some((entry) => matches(f.file, entry.glob)));
  const { total, hits } = countAcross(files, new RegExp(pattern, "g"));
  return total === want
    ? { ok: true }
    : {
        ok: false,
        why: `pattern /${pattern}/ matches ${total}x across the corpus (${files.length} files), claim says ${want}x — ${hits.join(", ")}`,
      };
}

/**
 * The four file-local kinds, one small function each behind a lookup rather than an if-chain.
 *
 * A table, not a chain, because the complexity ratchet refused the chain — correctly. This dispatch
 * also makes the failure for an unregistered kind a MISSING KEY rather than a fall-through, which is
 * the difference between "this gate does not know that word" and a silent pass.
 */
const IN_FILE_CHECKS = {
  symbol: (path, rest, text) =>
    text.includes(rest) ? { ok: true } : { ok: false, why: `symbol \`${rest}\` no longer appears in ${path}` },
  absent: (path, rest, text) =>
    text.includes(rest)
      ? { ok: false, why: `\`${rest}\` NOW APPEARS in ${path} — the claim asserted its absence` }
      : { ok: true },
  grep: (path, rest, text) =>
    new RegExp(rest).test(text) ? { ok: true } : { ok: false, why: `pattern /${rest}/ no longer matches in ${path}` },
  count: (path, rest, text) => {
    const lastColon = rest.lastIndexOf(":");
    const pattern = rest.slice(0, lastColon);
    const want = Number(rest.slice(lastColon + 1));
    const got = (text.match(new RegExp(pattern, "g")) ?? []).length;
    return got === want ? { ok: true } : { ok: false, why: `pattern /${pattern}/ matches ${got}x in ${path}, claim says ${want}x` };
  },
};

function checkInFile(kind, path, rest, text) {
  const check = IN_FILE_CHECKS[kind];
  return check === undefined ? { ok: false, why: `unknown evidence kind "${kind}"` } : check(path, rest, text);
}

function checkEvidence(evidence, config) {
  if (evidence.kind === "repo-count") return checkRepoCount(evidence, config);

  const firstColon = evidence.spec.indexOf(":");
  const path = evidence.spec.slice(0, firstColon);
  const rest = evidence.spec.slice(firstColon + 1);

  if (!evidencePathIsCode(path)) {
    return { ok: false, why: `evidence path ${path} is prose; a claim proved by a document proves nothing` };
  }
  if (!existsSync(path)) {
    return { ok: false, why: `evidence file ${path} does not exist` };
  }
  return checkInFile(evidence.kind, path, rest, maskComments(readFileSync(path, "utf8")));
}

/**
 * Short digest of a claim's justification. Truncated to 16 hex chars — long enough that nobody
 * collides one by accident, short enough to sit on one line in a diff, and this is a tripwire rather
 * than a security boundary.
 */
export function hashWhy(why) {
  return createHash("sha256").update(String(why), "utf8").digest("hex").slice(0, 16);
}

/**
 * THE JUSTIFICATION IS BOUND TO THE CONCLUSION (the WS5 lesson, 2026-08-21, upstream).
 *
 * The pattern this exists for: the false justification for four claims and the adapter that refuted
 * it were introduced by **the same commit** (3cae1cf upstream). It was not a claim that decayed. It
 * was false the day it was written, and it was written as the REPLACEMENT for a previous reason
 * that had died the day before. Two successive justifications, both false, one surviving
 * conclusion — and because the conclusion never moved, nobody re-read either.
 *
 * A `why` edit is invisible today: prose churn inside a JSON blob, indistinguishable in a diff from a
 * typo fix. Binding it to a hash makes replacing a justification a STRUCTURED, DATED EVENT that
 * cannot happen silently — the gate goes red until someone stamps it, and the stamp lands in the
 * commit that did it.
 *
 * WHAT THE STAMP ASSERTS, STATED NARROWLY SO IT IS NOT READ AS MORE. "On this date, this claim's
 * justification read as recorded, and its evidence passed." It does NOT assert that a human
 * independently re-derived the conclusion — no file can assert that. What it buys is that the
 * justification cannot be swapped without the swap appearing in the record.
 *
 * There is deliberately NO bulk re-stamp command. `complexity-gate --update-baseline` has one because
 * a baseline is bookkeeping; a justification is an argument, and a one-key way to re-affirm every
 * argument at once is the exact reflex this control exists to interrupt.
 */
function checkJustification(claim) {
  const actual = hashWhy(claim.why);
  const recorded = claim.verified?.whyHash;
  if (recorded === undefined) {
    return { ok: false, why: `carries no \`verified\` stamp. Add "verified": { "at": "<date>", "whyHash": "${actual}" } after reading the claim against the code.` };
  }
  return recorded === actual
    ? { ok: true }
    : {
        ok: false,
        why:
          `the JUSTIFICATION changed but the verification was not renewed (recorded ${recorded}, actual ${actual}).\n` +
          `      Replacing a \`why\` while the conclusion stays put is the 3cae1cf pattern: there, the new justification was false the day it was written,\n` +
          `      and because the conclusion did not move nobody re-read it. Re-read this claim against the code, then set\n` +
          `      "verified": { "at": "<today>", "whyHash": "${actual}" }.`,
      };
}

/**
 * A scope-worded claim must be measured against the corpus. Fails CLOSED: the whole finding was that
 * a claim can say "repo-wide" while its evidence looks at one directory tree, and be green.
 */
function checkScopeBinding(claim) {
  const word = scopeWordIn(claim.anchor);
  if (word === null) return { ok: true };
  return claim.evidence.some((e) => e.kind === "repo-count")
    ? { ok: true }
    : {
        ok: false,
        why: `anchor says "${word}" — a claim about the whole repo — but carries no repo-count evidence. A universal sentence proved by a file-local check is how H-5 stayed green.`,
      };
}

/**
 * The doc must still contain the sentence the claim is about.
 *
 * WHITESPACE IS NORMALISED on both sides. These docs are hard-wrapped prose, so a sentence routinely
 * spans a line break — the first claim registered upstream failed on exactly that. Reflowing a
 * paragraph is not drift, and a gate that treats it as drift trains people to edit the gate instead
 * of the doc.
 */
function checkAnchor(doc, anchor) {
  if (!existsSync(doc)) return { ok: false, why: `doc ${doc} does not exist` };
  const flat = (s) => s.replace(/\s+/g, " ");
  return flat(readFileSync(doc, "utf8")).includes(flat(anchor))
    ? { ok: true }
    : { ok: false, why: `anchor text not found in ${doc} — the doc changed but the claim did not` };
}

/**
 * Announce the corpus and every exclusion, on every run.
 *
 * This is the control on the control. A per-evidence `ignore` list is the feature most able to make
 * this gate lie — "exclude the file that contradicts the count" is a one-line edit that leaves the
 * gate green — and no static check can tell a legitimate exclusion from a self-serving one. What CAN
 * be guaranteed is that it is never quiet: the corpus size and every excluded glob with its reason
 * are printed beside the verdict, so a reviewer reading a green run reads the carve-outs too.
 */
function describeCorpus(config, claims) {
  console.log(`  corpus: ${repoCorpus(config).length} tracked file(s) [${config.extensions.join(", ")}], minus ${config.ignore.length} declared ignore glob(s).`);
  for (const claim of claims) {
    for (const evidence of claim.evidence) {
      for (const entry of evidence.ignore ?? []) {
        console.log(`  ↳ ${claim.id} additionally excludes ${entry.glob} — ${entry.why}`);
      }
    }
  }
}

function selfTest() {
  const cases = [];
  const t = (name, cond) => cases.push([name, cond]);

  // A claim proved by prose must be refused, whatever it says. This is the exact false-positive shape
  // that made two prior verifications of the upstream row wrong.
  t("rejects docs/ evidence", checkEvidence({ kind: "symbol", spec: "docs/gates/debt-register.md:RULE 7" }).ok === false);
  t("rejects .md evidence", evidencePathIsCode("README.md") === false);
  t("accepts code evidence", evidencePathIsCode("tools/task-coverage.mjs") === true);

  // Each evidence kind must be able to FAIL, not merely to pass.
  t("symbol present passes", checkEvidence({ kind: "symbol", spec: "tools/pathspec.mjs:export function matches" }).ok === true);
  t("symbol absent fails", checkEvidence({ kind: "symbol", spec: "tools/pathspec.mjs:definitelyNotASymbolHere" }).ok === false);
  t("absent kind fails when present", checkEvidence({ kind: "absent", spec: "tools/pathspec.mjs:export function matches" }).ok === false);
  t("absent kind passes when absent", checkEvidence({ kind: "absent", spec: "tools/pathspec.mjs:zzzNotHere" }).ok === true);
  t("missing file fails", checkEvidence({ kind: "symbol", spec: "tools/nope.mjs:x" }).ok === false);
  t("count mismatch fails", checkEvidence({ kind: "count", spec: "tools/pathspec.mjs:export function matches:99" }).ok === false);
  t("anchor miss fails", checkAnchor("README.md", "this sentence is not in README.md at all").ok === false);
  // Reflow tolerance: a hard-wrapped sentence must still match when given on one line.
  //
  // ANCHORED ON A RULE ABOUT THE RECORD ITSELF, for the reason the upstream harness learned twice:
  // its first fixture here quoted a product sentence and broke when the product changed, and the
  // second anchored a RATIFIED constraint that a later clean slate amended away. Twice the
  // self-test failed for reasons having nothing to do with reflow. So the lesson is not "pick a
  // more durable claim" — it is that NO CLAIM ABOUT THE PRODUCT is durable enough to be a fixture.
  // Phase being DERIVED from the events and never stored is the one constraint this whole
  // lifecycle exists to serve; if it ever goes, this self-test failing is the correct alarm.
  t(
    "anchor survives a line wrap",
    checkAnchor("docs/TASK-LIFECYCLE.md", "Phase is derived from the last transition, never stored").ok === true,
  );

  // The scope binding must DISCRIMINATE, in both directions. The defect it exists for upstream was a
  // claim reading "8 repo-wide" whose only repo-wide evidence looked at two directories, so the case
  // that matters is the FAILING one — a universal anchor with file-local evidence.
  t(
    "a scope-worded anchor with only file-local evidence FAILS",
    checkScopeBinding({ anchor: "8 repo-wide across exactly two surfaces", evidence: [{ kind: "count", spec: "a.ts:x:1" }] }).ok === false,
  );
  t(
    "a scope-worded anchor carrying repo-count passes",
    checkScopeBinding({ anchor: "ZERO distribution callers", evidence: [{ kind: "repo-count", spec: "x:0" }] }).ok === true,
  );
  t(
    "an anchor with no scope word needs no repo-count",
    checkScopeBinding({ anchor: "the constitution IS served machine-readable", evidence: [{ kind: "grep", spec: "a.ts:x" }] }).ok === true,
  );
  t("scope words are matched case-insensitively", scopeWordIn("ZERO distribution callers") === "zero");
  t("ordinary prose carries no scope word", scopeWordIn("the house-only NSFW adapter is built AND wired by DI") === null);

  // Comments are not evidence (the WS2 lesson). Fixtures are SYNTHETIC on purpose — this file
  // already learned upstream that a self-test anchored to real source reports "the checker is
  // broken" when the only thing that happened is that the world moved on.
  const masked = (src) => maskComments(src);
  t("a line comment stops being evidence", !masked("// pg_try_advisory_lock\nconst a = 1;\n").includes("pg_try_advisory_lock"));
  t("a JSDoc block stops being evidence", !masked("/**\n * calls pg_try_advisory_lock\n */\nconst a = 1;\n").includes("pg_try_advisory_lock"));
  t("executable code survives masking", masked('const q = "SELECT pg_try_advisory_lock($1)";\n').includes("pg_try_advisory_lock"));
  // The two ways a naive stripper corrupts real source. Both occur in real code.
  t("a URL inside a string is not a comment", masked('const u = "https://example.com/watch";\n').includes("example.com/watch"));
  t("a comment marker inside a string survives", masked('const s = "/* literal */";\n').includes("/* literal */"));
  t("an apostrophe in a comment does not open a string", masked("// don't\nconst keep = 1;\n").includes("const keep = 1"));
  t("a multi-line template literal survives", masked("const t = `line1\nkeepme\n`;\n").includes("keepme"));
  t("masking preserves length and line count", masked("// abcdef\nconst a = 1;\n").length === "// abcdef\nconst a = 1;\n".length);
  // The discrimination that matters: same pattern, comment vs code.
  t("grep FAILS on a comment-only match", checkInFile("grep", "f.ts", "onlyInAComment", masked("// onlyInAComment\n")).ok === false);
  t("grep passes on a code match", checkInFile("grep", "f.ts", "inRealCode", masked("const inRealCode = 1;\n")).ok === true);

  // A justification cannot be swapped under a surviving conclusion (the WS5 lesson). The failing
  // case IS the 3cae1cf pattern — same anchor, same evidence, different `why`.
  const stamped = { id: "x", why: "the original reason", verified: { at: "2026-09-19", whyHash: hashWhy("the original reason") } };
  t("an unchanged justification passes", checkJustification(stamped).ok === true);
  t("a SWAPPED justification fails", checkJustification({ ...stamped, why: "a new reason, plausible and false" }).ok === false);
  t("an unstamped claim fails CLOSED", checkJustification({ id: "x", why: "no stamp at all" }).ok === false);
  t("a whitespace-only edit still counts as a change", checkJustification({ ...stamped, why: "the original reason " }).ok === false);
  // No "the hash is stable" case: `hashWhy(x) === hashWhy(x)` is a self-comparison, which a linter
  // refuses and test-lint exists to catch. It would assert that sha256 is a function.
  t("a one-character difference changes the hash", hashWhy("abc") !== hashWhy("abd"));

  let ok = true;
  for (const [name, pass] of cases) {
    if (!pass) {
      ok = false;
      console.error(`  doc-reconcile self-test FAILED: ${name}`);
    }
  }
  console.log(ok ? `doc-reconcile self-test: OK (${cases.length} cases)` : "doc-reconcile self-test: FAILED");
  return ok ? 0 : 1;
}

/**
 * The declared corpus, or null if the registry does not declare one.
 *
 * FAILS CLOSED. Defaulting to some built-in scope is exactly how this gate came to measure
 * "repo-wide" against two directories, so a registry with no corpus block must make the gate refuse
 * rather than quietly fall back to a default nobody can see in the config.
 */
function corpusOf(registry) {
  const config = registry.corpus;
  if (config === undefined) return null;
  return Array.isArray(config.extensions) && Array.isArray(config.ignore) ? config : null;
}

/** Read the registry, or return the GATE_DEFECT message that says why it cannot be used. */
function loadRegistry() {
  if (!existsSync(CLAIMS)) {
    return { error: `${CLAIMS} is missing; the gate has nothing to check. Fix: create it with a "corpus" block (extensions + ignore, each with a why) and at least one claim.` };
  }
  const registry = JSON.parse(readFileSync(CLAIMS, "utf8"));
  const claims = registry.claims ?? [];
  if (claims.length === 0) return { error: "the claim registry is empty, so this gate is a no-op that reports success." };
  const config = corpusOf(registry);
  if (config === null) {
    return { error: `${CLAIMS} declares no usable \`corpus\` block. A repo-wide claim has nothing to be repo-wide ABOUT. Fix: add "corpus": { "extensions": [...], "ignore": [...] }.` };
  }
  return { claims, config };
}

function collectFailures(claims, config) {
  const failures = [];
  for (const claim of claims) {
    const anchor = checkAnchor(claim.doc, claim.anchor);
    if (!anchor.ok) failures.push(`${claim.id}: ${anchor.why}`);
    const scope = checkScopeBinding(claim);
    if (!scope.ok) failures.push(`${claim.id}: ${scope.why}`);
    const justification = checkJustification(claim);
    if (!justification.ok) failures.push(`${claim.id}: ${justification.why}`);
    for (const evidence of claim.evidence) {
      const res = checkEvidence(evidence, config);
      if (!res.ok) failures.push(`${claim.id}: ${res.why}`);
    }
  }
  return failures;
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const { claims, config, error } = loadRegistry();
  if (error !== undefined) {
    console.error(`doc-reconcile GATE_DEFECT — ${error}`);
    return 1;
  }

  const failures = collectFailures(claims, config);
  const evidenceCount = claims.reduce((n, c) => n + c.evidence.length, 0);
  console.log(`doc-reconcile — ${claims.length} claim(s), ${evidenceCount} evidence check(s).`);
  describeCorpus(config, claims);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  ${f}`);
    console.error(
      `doc-reconcile: FAILED (${failures.length}). Doc and code have parted. Fix whichever is wrong — the gate cannot tell you which, only that they disagree.`,
    );
    return 1;
  }
  console.log("doc-reconcile — every registered claim still matches the code it describes.");
  return 0;
}

process.exit(main());
