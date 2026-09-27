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
 * THE CORPUS IS THE TRACKED TREE, AND IT IS DECLARED IN THE CONFIG (the WS1 lesson). It used to be
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
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { matches } from "./pathspec.mjs";

const CLAIMS = "docs/gates/doc-claims.json";
/** Every path is repo-relative and resolved from THIS FILE, like every sibling gate — never the cwd. */
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const fromRoot = (path) => resolve(ROOT, path);
/** Printed git fixes name the repo, so they run from the same subdirectory the gate was run from. */
const GIT = `git -C ${ROOT}`;

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
  return text.replace(CODE_TOKENS, blankComment);
}

/** A matched literal survives intact; a matched comment becomes spaces (length and lines kept). */
function blankComment(match, literal) {
  return literal !== undefined ? match : match.replace(/[^\n]/g, " ");
}

/**
 * `#` comments for shell and YAML, under the same order law as CODE_TOKENS (quoted strings first).
 * A `#` opens a comment only at line start or after whitespace: `${#x}`, `$#` and `url#frag` are code.
 * KNOWN LIMITATION: heredoc bodies and YAML block scalars are not tracked, so a `#` line inside one is
 * masked as a comment.
 */
const HASH_TOKENS = /("(?:\\.|[^"\\\n])*"|'[^'\n]*')|((?<!\S)#[^\n]*)/g;

/**
 * Comment masking by the file's OWN grammar. JavaScript masking run over every corpus file let a YAML or
 * shell `#` comment count as evidence (the WS2 lesson, one grammar over), and blanked markdown prose
 * after every bare `https://` — markdown is in the corpus precisely so its prose is visible. JSON has
 * no comments, so it passes through. Every grammar NOT named here (.ts, .tsx, .jsx, ...) keeps JS
 * masking: fail closed, since the WS2 founding case was a JSDoc in a .ts file.
 */
function corpusText(file, text) {
  if (/\.(?:sh|ya?ml)$/.test(file)) return text.replace(HASH_TOKENS, blankComment);
  if (/\.(?:md|json)$/.test(file)) return text;
  return maskComments(text);
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
 *
 * The LIST is the index; the TEXT is the working tree, like every other read this gate makes. A tracked
 * file deleted but not staged is in one and not the other, so it is a GATE_DEFECT with the two fixes —
 * never an ENOENT stack trace, and never a silent zero.
 */
function trackedFiles() {
  return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n");
}

function readCorpus(config, tracked = trackedFiles()) {
  const extensions = new RegExp(`\\.(${config.extensions.join("|")})$`);
  const files = tracked.filter((f) => extensions.test(f)).filter((f) => !config.ignore.some((entry) => matches(f, entry.glob)));
  const vanished = files.filter((f) => !existsSync(fromRoot(f)));
  if (vanished.length > 0) {
    const paths = vanished.join(" ");
    return { error: `tracked file(s) missing from the working tree: ${paths} — the corpus cannot be read, so no repo-wide count can be trusted. Fix: stage the deletion (${GIT} rm -- ${paths}) or restore it (${GIT} checkout -- ${paths}).` };
  }
  return { corpus: files.map((file) => ({ file, text: corpusText(file, readFileSync(fromRoot(file), "utf8")) })) };
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
function checkRepoCount(evidence, corpus) {
  const { pattern, want } = splitCount(evidence.spec);
  const local = evidence.ignore ?? [];
  const files = corpus.filter((f) => !local.some((entry) => matches(f.file, entry.glob)));
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
    const { pattern, want } = splitCount(rest);
    const got = (text.match(new RegExp(pattern, "g")) ?? []).length;
    return got === want ? { ok: true } : { ok: false, why: `pattern /${pattern}/ matches ${got}x in ${path}, claim says ${want}x` };
  },
};

function checkInFile(kind, path, rest, text) {
  const check = IN_FILE_CHECKS[kind];
  return check === undefined ? { ok: false, why: `unknown evidence kind "${kind}"` } : check(path, rest, text);
}

/** A file-local spec, `path:rest`, split at its FIRST colon: a path has none, a pattern may. */
function splitPath(spec) {
  const firstColon = spec.indexOf(":");
  return { path: spec.slice(0, firstColon), rest: spec.slice(firstColon + 1) };
}

/** A count tail, `regex:n`, split at its LAST colon, for the same reason. */
function splitCount(tail) {
  const lastColon = tail.lastIndexOf(":");
  return { pattern: tail.slice(0, lastColon), want: Number(tail.slice(lastColon + 1)) };
}

/** The regex a grep, count or repo-count spec carries, split the way its check splits it; null for the literal kinds. */
function patternOf({ kind, spec }) {
  if (kind === "repo-count") return splitCount(spec).pattern;
  const { rest } = splitPath(spec);
  if (kind === "grep") return rest;
  return kind === "count" ? splitCount(rest).pattern : null;
}

function checkEvidence(evidence, corpus) {
  if (evidence.kind === "repo-count") return checkRepoCount(evidence, corpus);

  const { path, rest } = splitPath(evidence.spec);

  if (!evidencePathIsCode(path)) {
    return { ok: false, why: `evidence path ${path} is prose; a claim proved by a document proves nothing` };
  }
  if (!existsSync(fromRoot(path))) {
    return { ok: false, why: `evidence file ${path} does not exist` };
  }
  return checkInFile(evidence.kind, path, rest, corpusText(path, readFileSync(fromRoot(path), "utf8")));
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
  if (!existsSync(fromRoot(doc))) return { ok: false, why: `doc ${doc} does not exist` };
  const flat = (s) => s.replace(/\s+/g, " ");
  return flat(readFileSync(fromRoot(doc), "utf8")).includes(flat(anchor))
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
function describeCorpus(config, claims, corpus) {
  console.log(`  corpus: ${corpus.length} tracked file(s) [${config.extensions.join(", ")}], minus ${config.ignore.length} declared ignore glob(s).`);
  for (const line of exclusionLines(config, claims)) console.log(line);
}

/** Every carve-out, top-level and per-evidence, as the line a reviewer reads beside the verdict. */
function exclusionLines(config, claims) {
  const corpusWide = config.ignore.map((entry) => `  ↳ corpus excludes ${entry.glob} — ${entry.why}`);
  const perEvidence = claims.flatMap((claim) =>
    claim.evidence.flatMap((evidence) => (evidence.ignore ?? []).map((entry) => `  ↳ ${claim.id} additionally excludes ${entry.glob} — ${entry.why}`)),
  );
  return [...corpusWide, ...perEvidence];
}

/** Run `fn`, turning a throw into a value: a refusal case must FAIL by name, not crash the self-test. */
function settle(fn) {
  try {
    return fn();
  } catch (e) {
    return { threw: e.message };
  }
}

/** A printed git fix names the repo (`git -C <root>`), so it works from the subdirectory the gate ran in. */
function rootedGitFix(message) {
  return String(message).includes(`git -C ${ROOT} `) && !/\bgit (?:checkout|log|diff|rm)\b/.test(String(message));
}

/** The repo is found from THIS FILE, never the cwd: from a subdirectory or a hook, the same answers. */
function selfTestRoot(t) {
  const here = process.cwd();
  process.chdir(tmpdir());
  try {
    const found = settle(
      () =>
        checkEvidence({ kind: "symbol", spec: "tools/pathspec.mjs:export function matches" }).ok === true &&
        checkAnchor("docs/TASK-LIFECYCLE.md", "Phase is derived from the last transition, never stored").ok === true &&
        !String(loadRegistry().error).includes("is missing") &&
        Array.isArray(trackedFiles()),
    );
    t("the gate resolves the repo from its own location, not the cwd", found === true);
  } finally {
    process.chdir(here);
  }
}

/** Every registry refusal, driven — a loader only ever run on the happy path was never watched to refuse. */
function selfTestRegistry(t) {
  const dir = mkdtempSync(join(tmpdir(), "doc-reconcile-st-"));
  const claim = { id: "c", doc: "README.md", anchor: "a sentence", why: "w", evidence: [{ kind: "symbol", spec: "tools/pathspec.mjs:matches" }] };
  const corpus = { extensions: ["mjs"], ignore: [{ glob: "gen/**", why: "generated output" }] };
  const load = (name, registry) => {
    const path = join(dir, `${name}.json`);
    writeFileSync(path, typeof registry === "string" ? registry : JSON.stringify(registry));
    return settle(() => loadRegistry(path));
  };
  const refusal = (name, registry) => String(load(name, registry).error ?? "");
  try {
    t("a well-formed registry loads", load("ok", { corpus, claims: [claim] }).error === undefined);
    t("a missing registry is refused with a restore-from-history fix", String(settle(() => loadRegistry(join(dir, "absent.json"))).error).includes("restore it from git history"));
    t("an empty registry is refused", refusal("empty", { corpus, claims: [] }).includes("empty"));
    t("a registry with no corpus block is refused", refusal("nocorpus", { claims: [claim] }).includes("no usable"));
    t("a reasonless corpus ignore is refused", refusal("reasonless", { corpus: { ...corpus, ignore: [{ glob: "gen/**" }] }, claims: [claim] }).includes("no usable"));
    t("a reasonless evidence ignore is refused", refusal("reasonless-ev", { corpus, claims: [{ ...claim, evidence: [{ kind: "repo-count", spec: "x:0", ignore: [{ glob: "gen/**" }] }] }] }).includes("ignore list"));
    t("an unparseable registry is a GATE_DEFECT, not a stack trace", refusal("broken", "{ not json").includes("not valid JSON"));
    t("a claim with no evidence is refused", refusal("hollow", { corpus, claims: [{ ...claim, evidence: [] }] }).includes("no evidence"));
    t("a claim missing its evidence field is refused", refusal("noevidence", { corpus, claims: [{ ...claim, evidence: undefined }] }).includes("no evidence"));
    t("a claim with a blank anchor is refused", refusal("blank", { corpus, claims: [{ ...claim, anchor: " " }] }).includes("non-blank anchor"));
    for (const [kind, spec] of [["grep", "tools/pathspec.mjs:foo("], ["count", "tools/pathspec.mjs:foo(:1"], ["repo-count", "foo(:0"]]) {
      t(`a ${kind} pattern that does not compile is refused`, refusal(`badre-${kind}`, { corpus, claims: [{ ...claim, evidence: [{ kind, spec }] }] }).includes("pattern compiles"));
    }
    for (const [kind, spec] of [["count", "tools/pathspec.mjs:foo"], ["repo-count", "foo"], ["count", "tools/pathspec.mjs:foo:many"], ["repo-count", "foo:-1"], ["repo-count", "foo:"]]) {
      t(`a ${kind} spec with no whole-number tail (${spec}) is refused`, refusal(`nowant-${kind}-${spec.length}`, { corpus, claims: [{ ...claim, evidence: [{ kind, spec }] }] }).includes("whole-number count"));
    }
    const colonPatterns = [{ kind: "grep", spec: "tools/pathspec.mjs:(?:a)" }, { kind: "count", spec: "tools/pathspec.mjs:(?:a):1" }, { kind: "repo-count", spec: "(?:a):0" }];
    t("a compiling grep, count and repo-count pattern with a colon in it loads", load("okre", { corpus, claims: [{ ...claim, evidence: colonPatterns }] }).error === undefined);
    t("the missing-registry fix command runs from any cwd", rootedGitFix(settle(() => loadRegistry(join(dir, "absent.json"))).error));
    t("the unparseable-registry fix command runs from any cwd", rootedGitFix(refusal("broken", "{ not json")));
    t("the empty-registry fix command runs from any cwd", rootedGitFix(refusal("empty", { corpus, claims: [] })));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const printed = (config, claims, glob, why) => exclusionLines(config, claims).some((line) => line.includes(glob) && line.includes(why));
  t("every top-level exclusion is printed with its reason", printed(corpus, [], "gen/**", "generated output"));
  t("a per-evidence exclusion is printed with its reason", printed({ ignore: [] }, [{ id: "c", evidence: [{ ignore: [{ glob: "x/**", why: "one file" }] }] }], "x/**", "one file"));
}

/** The corpus half: repo-count arithmetic on a SYNTHETIC corpus, masking by grammar, a vanished file. */
function selfTestCorpus(t) {
  const corpus = [
    { file: "a.mjs", text: "foo foo" },
    { file: "gen/b.mjs", text: "foo" },
  ];
  t("repo-count passes on the exact corpus total", checkEvidence({ kind: "repo-count", spec: "foo:3" }, corpus).ok === true);
  t("repo-count FAILS on a wrong total", checkEvidence({ kind: "repo-count", spec: "foo:2" }, corpus).ok === false);
  t("a per-evidence ignore narrows the count", checkEvidence({ kind: "repo-count", spec: "foo:2", ignore: [{ glob: "gen/**", why: "generated" }] }, corpus).ok === true);
  t("a markdown corpus file keeps the prose after a URL", corpusText("a.md", "see https://example.com then keepme\n").includes("keepme"));
  t("a yaml # comment stops being evidence", !corpusText("a.yml", "k: 1 # onlyInComment\n").includes("onlyInComment"));
  t("a shell # comment stops being evidence", !corpusText("a.sh", "# onlyInComment\necho hi\n").includes("onlyInComment"));
  t("a # inside a quoted yaml string survives", corpusText("a.yml", 'run: echo "a # keepme"\n').includes("keepme"));
  t("a shell length expansion is code, not a comment", corpusText("a.sh", "n=${#keepme}\n").includes("keepme"));
  t("js comments are still masked in the corpus", !corpusText("a.mjs", "// onlyInComment\n").includes("onlyInComment"));
  // Fail closed: a grammar nobody named (.ts, .tsx, ...) is masked as JS — the WS2 founding case was a .ts JSDoc.
  t("a .ts comment is still masked in evidence", !corpusText("a.ts", "/** onlyInComment */\n").includes("onlyInComment"));
  const vanished = settle(() => readCorpus({ extensions: ["md"], ignore: [] }, ["zz-deleted-in-the-worktree.md"]));
  t("a tracked file deleted in the working tree is a GATE_DEFECT, not a crash", String(vanished.error).includes("zz-deleted-in-the-worktree.md"));
  t("the vanished-file fix command runs from any cwd", rootedGitFix(vanished.error));
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

  selfTestRoot(t);
  selfTestRegistry(t);
  selfTestCorpus(t);

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
  const config = registry?.corpus;
  return Array.isArray(config?.extensions) && Array.isArray(config.ignore) && !config.ignore.some(isReasonless) ? config : null;
}

/**
 * An ignore entry with no glob or no reason — refused, never defaulted. "Exclude the file that
 * contradicts you" is a one-line edit; the only defence is that it can never be a quiet one.
 */
function isReasonless(entry) {
  return isBlank(entry?.glob) || isBlank(entry.why);
}

function compiles(pattern) {
  try {
    return new RegExp(pattern) instanceof RegExp;
  } catch {
    return false;
  }
}

function isBlank(value) {
  return typeof value !== "string" || value.trim() === "";
}

/**
 * Why one claim cannot be checked, or null. A HOLLOW claim — no evidence, or a blank anchor (which
 * every doc "contains") — certifies nothing while counting toward the banner; a missing field is a
 * stack trace mid-run instead of a refusal.
 */
function claimShapeError(claim) {
  const blank = ["id", "doc", "anchor", "why"].find((field) => isBlank(claim?.[field]));
  if (blank !== undefined) return `needs a non-blank ${blank}`;
  if (!Array.isArray(claim.evidence) || claim.evidence.length === 0) return "carries no evidence — a claim proved by nothing certifies nothing";
  const bad = claim.evidence.find(isMalformedEvidence);
  return bad === undefined ? null : `evidence ${JSON.stringify(bad)} needs a kind, a spec whose pattern compiles (a count kind ending in a whole-number count), and an ignore list whose every entry carries a glob and a why`;
}

/** An uncompilable pattern is a SyntaxError mid-run, naming no claim and no fix — so it is refused here. */
function isMalformedEvidence(evidence) {
  if (isBlank(evidence?.kind) || isBlank(evidence.spec)) return true;
  if (specIsMalformed(evidence)) return true;
  return evidence.ignore !== undefined && (!Array.isArray(evidence.ignore) || evidence.ignore.some(isReasonless));
}

/** A spec its check would misread: a pattern that does not compile, or a count kind whose tail
 *  is not a whole number ("x:foo" once split to the pattern "fo" and a NaN count). */
function specIsMalformed(evidence) {
  const pattern = patternOf(evidence);
  if (pattern !== null && !compiles(pattern)) return true;
  return !countTailIsWhole(evidence);
}

/** A count or repo-count spec must END in a whole-number count (an empty or signed tail is not
 *  one); the other kinds carry no count. */
function countTailIsWhole({ kind, spec }) {
  if (kind === "repo-count") return /:\d+$/.test(spec);
  return kind !== "count" || /:\d+$/.test(splitPath(spec).rest);
}

/** The first claim that cannot be checked, as a GATE_DEFECT message, or null. */
function claimsError(claims, path) {
  for (const [i, claim] of claims.entries()) {
    const shape = claimShapeError(claim);
    if (shape !== null) return `claim ${JSON.stringify(claim?.id ?? `#${i}`)} ${shape}. Fix: repair that entry in ${path}.`;
  }
  return null;
}

/** Read the registry, or return the GATE_DEFECT message that says why it cannot be used. */
function loadRegistry(path = CLAIMS) {
  if (!existsSync(fromRoot(path))) {
    return { error: `${path} is missing; the gate has nothing to check. Fix: restore it from git history (${GIT} checkout HEAD -- ${path}, or from before the commit that deleted it: ${GIT} log --diff-filter=D -- ${path}) — its verified whyHash stamps are the audit trail; do not re-seed it blind.` };
  }
  let registry;
  try {
    registry = JSON.parse(readFileSync(fromRoot(path), "utf8"));
  } catch (e) {
    return { error: `${path} is not valid JSON (${e.message}). Fix: repair it — ${GIT} diff -- ${path} shows the break.` };
  }
  const claims = registry?.claims;
  if (!Array.isArray(claims) || claims.length === 0) {
    return { error: `the claim registry in ${path} is empty, so this gate is a no-op that reports success. Fix: restore its claims from git history (${GIT} log -p -- ${path}).` };
  }
  const config = corpusOf(registry);
  if (config === null) {
    return { error: `${path} declares no usable \`corpus\` block — extensions[] and ignore[], every ignore entry a { "glob", "why" } with a non-empty why. A repo-wide claim has nothing to be repo-wide ABOUT. Fix: add or repair "corpus": { "extensions": [...], "ignore": [{ "glob": "...", "why": "..." }] } in ${path}.` };
  }
  const shape = claimsError(claims, path);
  return shape === null ? { claims, config } : { error: shape };
}

function collectFailures(claims, corpus) {
  const failures = [];
  for (const claim of claims) {
    const anchor = checkAnchor(claim.doc, claim.anchor);
    if (!anchor.ok) failures.push(`${claim.id}: ${anchor.why}`);
    const scope = checkScopeBinding(claim);
    if (!scope.ok) failures.push(`${claim.id}: ${scope.why}`);
    const justification = checkJustification(claim);
    if (!justification.ok) failures.push(`${claim.id}: ${justification.why}`);
    for (const evidence of claim.evidence) {
      const res = checkEvidence(evidence, corpus);
      if (!res.ok) failures.push(`${claim.id}: ${res.why}`);
    }
  }
  return failures;
}

/** The registry, then the corpus it declares — either can be the GATE_DEFECT. */
function loadGate() {
  const registry = loadRegistry();
  if (registry.error !== undefined) return registry;
  const read = readCorpus(registry.config);
  return read.error !== undefined ? read : { ...registry, corpus: read.corpus };
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const { claims, config, corpus, error } = loadGate();
  if (error !== undefined) {
    console.error(`doc-reconcile GATE_DEFECT — ${error}`);
    return 1;
  }

  const failures = collectFailures(claims, corpus);
  const evidenceCount = claims.reduce((n, c) => n + c.evidence.length, 0);
  console.log(`doc-reconcile — ${claims.length} claim(s), ${evidenceCount} evidence check(s).`);
  describeCorpus(config, claims, corpus);
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

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isEntry) process.exit(main());
