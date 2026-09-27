#!/usr/bin/env node
/**
 * READER-EXISTENCE SWEEP — config-driven port of the Antitube harness gate (PD-14 / RCA-15 R7),
 * adapted to stallion 2026-09-20. Config: docs/gates/reader-existence.json.
 *
 * For every member of a shared-contract string union, assert production code contains BOTH a
 * PRODUCER (something that writes the value) and a CONSUMER (something that branches on it).
 *
 * WHY THIS EXISTS, AND WHY EXPORT ANALYSIS CANNOT DO IT (the 2026-07-15 RCA lesson, generalized).
 * Any dead-code analysis that judges liveness at the EXPORT level — knip is the example the RCA
 * named — sees the container: `RISK_CLASSES` is exported and used, so the union is live. It cannot
 * see that one MEMBER inside that union is dead: a consumed-but-never-produced member is a branch
 * that cannot fire, and a produced-but-never-consumed member is a signal nothing reads. The RCA
 * added knip saying so ("NOT yet done: enum-member / object-literal-key flagging"), and the gap it
 * named went on to produce a real finding (Antitube 2026-08-13: three labels read by tier() and
 * written by NOTHING — every gate green, because the labels WERE referenced and the tests seeded
 * them by hand). A finding of that severity should not depend on someone thinking to look.
 *
 * KNOWN LIMIT — LITERAL producers only, and stallion's biggest producers are GENERIC. This sweep
 * matches literals (`riskClass: "protected"`); a producer that passes the value as a variable is
 * invisible to it. In stallion the generic producers are the CLIs themselves: `new --risk-class
 * <class>`, `record --severity <S>`, `advance <phase>` all take the member as an ARGUMENT, so a
 * member can be reachable from the terminal while this sweep reports NO_PRODUCER. Read a
 * NO_PRODUCER here as "no CODE PATH hard-codes it", never as "unreachable". Where that is the
 * whole story, the config's `accepted` rows record it WITH a reason instead of hiding it.
 *
 * VERDICTS
 *   DEAD         zero production references at all
 *   NO_PRODUCER  consumed but never produced — a branch that cannot fire
 *   NO_CONSUMER  produced but never consumed — a signal nothing reads
 *
 * CONSERVATISM IS THE WHOLE DESIGN. A verdict is issued ONLY when the classification is
 * unambiguous. Anything this tool cannot confidently classify counts as AMBIGUOUS and SUPPRESSES
 * the verdict for that member — a blocking gate that cries wolf gets bypassed, and a bypassed gate
 * is worth less than no gate. The suppressed count is printed PER CONTRACT rather than hidden: a
 * contract swept to zero findings by mass ambiguity is vacuous, and vacuity is a number you can
 * watch instead of a silence you have to trust (the Antitube baseline carries a row deleted in
 * error exactly because one ambiguous use silently suppressed a live verdict).
 *
 * CORPUS — what "production code" means HERE, and the two adaptations that make it honest:
 *   1. INLINE SELF-TESTS. Antitube classified test FILES out of the corpus by name
 *      (`.test.`, `.spec.`, `/test/`, `/dist/`). Stallion has no test files: every tool carries its
 *      self-test INSIDE the production file (`function selfTestValidate() { ... }` in the same
 *      module that ships). A name filter cannot see that, and test code seeding members by hand is
 *      precisely the blindness this gate exists to remove — so the corpus cuts `selfTest*`
 *      DECLARATIONS, and every file-private helper — a `function`, or a `const` arrow, function
 *      expression or fixture table — that only they reach, or that nothing reaches (string-,
 *      template- and regex-aware bracket matching; on parser doubt — no balanced end, or a quote
 *      still open at a line's end — the cut runs to EOF, which can only over-report findings, the
 *      fail-closed direction; see selfTestRanges for the doubt it cannot see).
 *   2. THE DECLARATION. Antitube excluded the contract FILE; stallion's contracts share files with
 *      their own producers (`RISK_CLASSES` lives in task-state.mjs, which also branches on its
 *      members), so excluding the file would gut the sweep. The corpus excludes exactly the
 *      declaration's line range instead — the lines the compiler would read, nothing else.
 *   Plus the standing law: docs, fixtures, dist and THIS TOOL are never corpus members (this
 *   tool's fixtures name every member; counting them was the false-positive class that motivated
 *   the original self-exclusion).
 *
 * BASELINE. `accepted` in the config records today's ACCEPTED findings, each with a reason that
 * OPENS with the verdict it accepts — an absent reason, or one naming no verdict, fails the config.
 * The gate fails on any finding NOT accepted, on an accepted row that is no longer a finding, and on
 * a row whose finding now carries a different verdict: a stale or drifted row means the baseline
 * has stopped describing reality, and a baseline nobody prunes decays into a permission slip.
 *
 * FAIL CLOSED ON THE CONFIG. Missing, unparseable, or wrongly shaped config fails the gate with a
 * fix line naming the path — a gate that cannot read its own law certifies nothing.
 *
 * USAGE
 *   node tools/reader-existence.mjs              report + gate against the config's baseline
 *   node tools/reader-existence.mjs --report     report everything, exit 0 (triage aid)
 *   node tools/reader-existence.mjs --self-test  prove the classifier discriminates (fixtures
 *                                                 only — never the live config)
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { matches } from "./pathspec.mjs";

const CONFIG_PATH = "docs/gates/reader-existence.json";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SELF_REALPATH = realpathSync(fileURLToPath(import.meta.url));
const CODE_EXTS = /\.(?:mjs|cjs|js)$/;
/** Fixed law, not config: test artifacts by name are never production, whatever the tree grows. */
const NEVER_CORPUS = /\.(?:test|spec)\.[^.]+$|\/(?:test|tests|__tests__|fixtures|dist)\//;
/** The verdicts memberVerdict issues (see VERDICTS in the header) — every accepted row opens with one. */
const VERDICTS = ["DEAD", "NO_PRODUCER", "NO_CONSUMER"];
/** The verdict an accepted row was written for: its reason's opening token, or null. */
const recordedVerdict = (reason) => VERDICTS.find((verdict) => new RegExp(`^${verdict}\\b`).test(reason)) ?? null;

/* ------------------------------------------------------------------------------------------------
 * Config — fail closed on every shape this gate depends on. Each validator returns null or a
 * [message, fix] pair; loadConfig chains them so every refusal names the path and its fix.
 * ---------------------------------------------------------------------------------------------- */

function configDefect(message, fix) {
  return { ok: false, error: `reader-existence GATE_DEFECT — ${message}\n  fix: ${fix}` };
}

function contractsError(contracts) {
  if (!Array.isArray(contracts) || contracts.length === 0) return ["no contracts[]; sweeping nothing certifies nothing", `add at least one { "path", "symbol" } to contracts[] in ${CONFIG_PATH}.`];
  for (const c of contracts) {
    if (!isContractEntry(c)) return [`every contract needs string path+symbol; got ${JSON.stringify(c)}`, `fix the entry in ${CONFIG_PATH} (e.g. { "path": "tools/task-state.mjs", "symbol": "RISK_CLASSES" }).`];
  }
  return null;
}

function isContractEntry(c) {
  if (typeof c?.path !== "string" || c.path.length === 0) return false;
  if (typeof c?.symbol !== "string" || c.symbol.length === 0) return false;
  return true;
}

function corpusError(corpus) {
  const roots = corpus?.roots;
  if (!Array.isArray(roots) || roots.length === 0) return ["corpus.roots is missing or empty (non-empty string paths)", `add "corpus": { "roots": ["tools"] } to ${CONFIG_PATH}.`];
  if (roots.some((r) => typeof r !== "string" || r.length === 0)) return ["corpus.roots must be non-empty strings", `fix corpus.roots in ${CONFIG_PATH}.`];
  for (const x of corpus.exclude ?? []) {
    if (isReasonlessExclusion(x)) return [`every corpus.exclude entry needs a spec AND a non-empty why; got ${JSON.stringify(x)}`, `fix the entry in ${CONFIG_PATH} — a reasonless exclusion is a silent hole (the same law as reasonless baseline rows).`];
  }
  return null;
}

function isReasonlessExclusion(x) {
  if (typeof x?.spec !== "string") return true;
  if (typeof x?.why !== "string" || x.why.trim().length === 0) return true;
  return false;
}

function acceptedError(accepted) {
  if (typeof accepted !== "object" || accepted === null || Array.isArray(accepted)) return ['accepted must be an object of { "<SYMBOL>.<member>": "<reason>" }', `repair accepted in ${CONFIG_PATH}.`];
  for (const [id, reason] of Object.entries(accepted)) {
    const defect = acceptedRowError(id, reason);
    if (defect !== null) return defect;
  }
  return null;
}

/** A row's reason must exist AND open with the verdict it accepts — the token baselineVerdict holds it to. */
function acceptedRowError(id, reason) {
  if (typeof reason !== "string" || reason.trim().length === 0) return [`accepted row ${id} carries no reason`, `give ${id} a reason in ${CONFIG_PATH}, or delete the row — "it was already like that" is not one.`];
  if (recordedVerdict(reason) === null) return [`accepted row ${id} does not open with the verdict it accepts (${VERDICTS.join(" / ")})`, `start ${id}'s reason in ${CONFIG_PATH} with its verdict (e.g. "NO_PRODUCER — <why>") — a row naming no verdict cannot be checked for drift.`];
  return null;
}

export function loadConfig(path) {
  if (!existsSync(path)) {
    return configDefect(`${path} is missing; the gate cannot know its contracts, corpus, or accepted findings.`, `restore ${path} from history (its accepted rows and exclusion reasons are the baseline's audit trail) — do not re-seed it blind.`);
  }
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return configDefect(`${path} is unreadable: ${e.message}`, "check the file's permissions, then re-run.");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return configDefect(`${path} is not valid JSON: ${e.message}`, `repair the JSON in ${path} (a gate that cannot parse its law fails closed).`);
  }
  const defect = contractsError(parsed.contracts) ?? corpusError(parsed.corpus) ?? acceptedError(parsed.accepted);
  if (defect !== null) return configDefect(`${path}: ${defect[0]}`, defect[1]);
  return { ok: true, config: parsed };
}

/* ------------------------------------------------------------------------------------------------
 * Contract reading — members of `export const NAME = [...]` / `{...}`, `as const` optional
 * (stallion declares its unions without `as const`; the object form is kept for parity).
 * ---------------------------------------------------------------------------------------------- */

/** Members of `export const NAME = [...] (as const)` or `= {...} as const` (object values). */
export function unionMembers(source, name) {
  const arr = new RegExp(`export const ${name} = \\[(.*?)\\](?:\\s*as\\s+const)?`, "s").exec(source);
  if (arr !== null) return [...arr[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const obj = new RegExp(`export const ${name} = \\{(.*?)\\}(?:\\s*as\\s+const)?`, "s").exec(source);
  if (obj !== null) {
    // An object union is reached through its KEY (`QUEUES.transcode`) far more often than through
    // its value string. Scanning only for the value reports every key-reached member as DEAD.
    return [...obj[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*"([^"]+)"/g)].map((m) => ({ member: m[2], alias: m[1] }));
  }
  return [];
}

/** [startLine, endLine] (inclusive, 0-based) of NAME's declaration — the corpus exclusion range.
 *  Excludes the DECLARATION, not the file: stallion's contract files also carry the producers and
 *  consumers (Antitube excluded the whole file because its contract was a types-only module). */
export function declarationRange(source, name) {
  const arr = new RegExp(`export const ${name} = \\[.*?\\](?:\\s+as\\s+const)?;?`, "s").exec(source);
  const obj = arr === null ? new RegExp(`export const ${name} = \\{.*?\\}(?:\\s+as\\s+const)?;?`, "s").exec(source) : null;
  const m = arr ?? obj;
  if (m === null) return null;
  const startLine = (source.slice(0, m.index).match(/\n/g) ?? []).length;
  return [startLine, startLine + (m[0].match(/\n/g) ?? []).length];
}

/* ------------------------------------------------------------------------------------------------
 * Classification — ported from the Antitube sweep; roles are a SET because one line can do both.
 * ---------------------------------------------------------------------------------------------- */

const escapeRe = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The shapes that READ a member: a comparison operand, a `case` label, a predicate call's argument, or
 *  an element of the inline array a predicate is called on, whatever else it holds (`["X", Y].includes(m)`,
 *  `[...BASE, "X"].some(f)`, `new Set(["X"]).has(m)`). */
const consumerShapes = (q) => [
  `[=!]==?\\s*"${q}"`,
  `"${q}"\\s*[=!]==`,
  `case\\s+"${q}"`,
  `\\.?(?:has|includes|indexOf|startsWith|endsWith)\\(\\s*"${q}"`,
  `\\[(?:[^\\[\\]]*,\\s*)?"${q}"(?:\\s*,[^\\[\\]]*)?\\]\\s*\\)?\\s*\\.(?:has|includes|indexOf|some|every|find|findIndex)\\(`,
];

function consumerRoles(line, literal) {
  const q = escapeRe(literal);
  return consumerShapes(q).some((shape) => new RegExp(shape).test(line)) ? new Set(["CONSUMER"]) : new Set();
}

// PRODUCER — the literal is being supplied as data. Checked INDEPENDENTLY of the consumer
// patterns, never as an else-branch: one line can do both, and stopping at the first match
// mis-reads `return labels.includes("BLOCK") ? labels : [...labels, "BLOCK"];` as consumer-only.
// A classifier that stops at its first hit under-counts the busier role.
function producerRoles(line, literal) {
  const q = escapeRe(literal);
  const roles = new Set();
  // A `return` or a spread supplies the literal only where it is not a READ: `return m === "GHOST"` and
  // `[...BASE, "GHOST"].includes(m)` produce nothing, and counting them turned a read-never-written member green.
  const unread = line.replace(new RegExp(consumerShapes(q).join("|"), "g"), "");
  if (new RegExp(`return\\s+.*"${q}"`).test(unread)) roles.add("PRODUCER");
  if (new RegExp(`:\\s*"${q}"`).test(line)) roles.add("PRODUCER");
  if (new RegExp(`\\.push\\(\\s*"${q}"`).test(line)) roles.add("PRODUCER");
  if (new RegExp(`[^=!<>]=\\s*"${q}"`).test(line)) roles.add("PRODUCER");
  if (new RegExp(`\\.\\.\\.[A-Za-z_][A-Za-z0-9_]*\\s*,\\s*"${q}"`).test(unread)) roles.add("PRODUCER");
  return roles;
}

/**
 * Classify one line's use of the literal.
 *
 * The hard case is array membership: `return ["SPAM", "DO_NOT_AMPLIFY"]` (labels to APPLY) and
 * `const HARD_BLOCK = ["HASH_MATCH", ...]` (labels to TEST AGAINST) are the same shape. They are
 * separated by what encloses them: a `return [` is a producer; a `const NAME = [` resolves through
 * how NAME is used elsewhere, which the caller supplies as `predicateConsts`.
 */
export function classifyLine(line, literal, predicateConsts) {
  const roles = new Set([...consumerRoles(line, literal), ...producerRoles(line, literal)]);
  if (roles.size > 0) return roles;
  // Membership in a known predicate array/set (or a bare member line inside one): a READ.
  if (predicateConsts && line.includes(`"${literal}"`)) return new Set(["CONSUMER"]);
  if (new RegExp(`^\\s*"${escapeRe(literal)}",?\\s*$`).test(line)) {
    return new Set([predicateConsts ? "CONSUMER" : "AMBIGUOUS"]);
  }
  return new Set(["AMBIGUOUS"]);
}

/**
 * [startLine, endLine] (inclusive) ranges of `const NAME = [...]` / `new Set([...])` declarations
 * that are later used with a predicate method (`NAME.some(`, `NAME.has(`, ...) — membership in
 * those is a READ. Ported from Antitube with the two shapes stallion actually writes: the guard
 * sets are SINGLE-LINE `new Set([...])` consts (`APPROVAL_REQUIRED`, `NON_CODE_CLASSES`), not the
 * multi-line arrays the original looked for. Without this, every guard-set member is AMBIGUOUS and
 * the sweep silently suppresses the verdicts it was built to produce.
 */
export function predicateArrayRanges(text) {
  const ranges = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const decl = /^\s*(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*(?:new\s+Set\s*\(\s*)?\[\s*(?:\]|.*)$/.exec(lines[i]);
    if (decl === null) continue;
    // Iterated is not tested: `for (const x of NAMES)` reads the ARRAY, not a member by name.
    if (!new RegExp(`\\b${decl[1]}\\.(?:some|every|includes|indexOf|has)\\(`).test(text)) continue;
    const closing = closingBracketLine(lines, i);
    if (closing !== null) ranges.push([i, closing]);
  }
  return ranges;
}

function closingBracketLine(lines, from) {
  if (/(?:\]\s*\)?\s*;?\s*)$/.test(lines[from])) return from; // single-line declaration
  for (let j = from + 1; j < lines.length; j += 1) {
    if (/^\s*(?:\)\s*)?\]/.test(lines[j])) return j;
  }
  return null; // unterminated: not resolvable, stays ambiguous (suppressed, never guessed)
}

/* ------------------------------------------------------------------------------------------------
 * Corpus
 * ---------------------------------------------------------------------------------------------- */

/** A top-level `const|let|var NAME =` binding — an arrow helper, a function expression, a fixture table. */
const BINDING_DECL = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/;
const SELFTEST_DECL = /^(?:export\s+)?(?:(?:async\s+)?function\s+selfTest\w*\s*\(|(?:const|let|var)\s+selfTest\w*\s*=)/;

/**
 * [startLine, endLine] (inclusive) of every inline `selfTest*` declaration — stallion's test
 * code lives INSIDE production files, so the corpus cuts the function, not the file. The brace
 * match is STRING- AND REGEX-AWARE (a naive count ends the function at the first `}` inside a
 * quoted string or template); if no balanced end is found, or a quote is still open at a line's end
 * (a misread the scan cannot resume from), the cut runs to EOF, which can only REMOVE corpus and
 * therefore OVER-report findings — the fail-closed direction for a blocking gate. KNOWN LIMIT: the
 * doubt must be visible — a regex right after `)` reads as division, and a quote-free bracket
 * inside it is counted.
 */
export function selfTestRanges(lines) {
  const ranges = [];
  let i = 0;
  while (i < lines.length) {
    if (!SELFTEST_DECL.test(lines[i])) {
      i += 1;
      continue;
    }
    const end = declarationEnd(lines, i);
    ranges.push([i, end]);
    i = end + 1;
  }
  return ranges;
}

const PRIVATE_FN_DECL = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/;

/**
 * TEST CODE in a production file: every `selfTest*` declaration, plus — to a fixpoint — every
 * FILE-PRIVATE top-level declaration (a `function`, or a `const|let|var` binding: arrow helper,
 * function expression, fixture table) reached only from test code, or by nothing at all. A helper
 * is test code by what reaches it, not by its name or its shape: `runLawRepairCases` and
 * `bundleBlockCarriesAllRanked` escaped a name-only cut, and their hand-seeded literals counted as
 * production — hiding a DEAD member and flipping accepted rows (the 2026-09-27 sweep); a const arrow
 * or table then escaped the function-only cut the same way. Exported declarations are never cut
 * this way: another module may be their production caller. KNOWN LIMIT: any mention outside test
 * code, a comment included, keeps a helper in the corpus; naming it selfTest* cuts it outright.
 * Class declarations and destructured bindings are not candidates.
 */
export function testCodeRanges(lines) {
  const ranges = selfTestRanges(lines);
  const cut = new Set(ranges.flatMap(lineSpan));
  const refs = identifierLines(lines);
  let pending = privateDeclarations(lines);
  let reached = pending.filter((fn) => onlyTestReached(fn, refs, cut));
  while (reached.length > 0) {
    for (const fn of reached) {
      ranges.push(fn.range);
      for (const i of lineSpan(fn.range)) cut.add(i);
    }
    pending = pending.filter((fn) => !reached.includes(fn));
    reached = pending.filter((fn) => onlyTestReached(fn, refs, cut));
  }
  return ranges;
}

const lineSpan = ([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** Top-level, non-exported, non-selfTest declarations — functions and bindings — each with its line range. */
function privateDeclarations(lines) {
  const found = [];
  lines.forEach((line, i) => {
    const decl = PRIVATE_FN_DECL.exec(line) ?? BINDING_DECL.exec(line);
    if (decl !== null && !SELFTEST_DECL.test(line)) found.push({ name: decl[1], range: [i, declarationEnd(lines, i)] });
  });
  return found;
}

/** identifier -> the lines it appears on. */
function identifierLines(lines) {
  const index = new Map();
  lines.forEach((line, i) => {
    for (const id of new Set(line.match(/[A-Za-z_$][\w$]*/g))) {
      if (!index.has(id)) index.set(id, []);
      index.get(id).push(i);
    }
  });
  return index;
}

/** Reached only from lines already cut as test code, or from nothing (its own body aside): a
 *  file-private helper no line reaches never runs, and keeping it let a dead literal count as live. */
function onlyTestReached(fn, refs, cut) {
  const [start, end] = fn.range;
  const outside = (refs.get(fn.name) ?? []).filter((i) => i < start || i > end);
  return outside.every((i) => cut.has(i));
}

/** Index of the line where the declaration starting at `start` closes; EOF on parser doubt. A
 *  function closes with its body's brace, a binding with its statement's `;`. Only a template or a
 *  block comment spans lines: a quote still open at a line's end was misread, and resuming past it
 *  one bracket short closed the cut EARLY — test code left in the corpus, the fail-open direction. */
function declarationEnd(lines, start) {
  const shape = BINDING_DECL.test(lines[start].replace(/^export\s+/, "")) ? statementStep : functionStep;
  const st = { depth: 0, parens: 0, started: false, str: null, block: false, prev: null, holes: [], shape };
  for (let j = start; j < lines.length; j += 1) {
    if (scanLine(lines[j], st)) return j;
    if (st.str === '"' || st.str === "'") break;
  }
  return lines.length - 1;
}

/** One line through the scanner; true when the tracked declaration closes on this line. */
function scanLine(line, st) {
  for (let k = 0; k < line.length; ) {
    const step = consume(line, k, st);
    if (step.ended) return true;
    k = step.next;
  }
  return false;
}

/** One character in whatever state we are in. */
function consume(line, k, st) {
  if (st.block) return blockStep(line, k, st);
  if (st.str !== null) return stringStep(line, k, st);
  return codeStep(line, k, st);
}

function blockStep(line, k, st) {
  if (line[k] === "*" && line[k + 1] === "/") {
    st.block = false;
    return { next: k + 2, ended: false };
  }
  return { next: k + 1, ended: false };
}

function stringStep(line, k, st) {
  if (line[k] === "\\") return { next: k + 2, ended: false }; // escaped char: skip its target
  if (st.str === "`" && line.startsWith("${", k)) {
    st.holes.push(0); // a template's hole is CODE — a template nested in it is its own string
    st.str = null;
    return { next: k + 2, ended: false };
  }
  if (line[k] === st.str) st.str = null;
  return { next: k + 1, ended: false };
}

const QUOTE_CHARS = new Set(['"', "'", "`"]);

function codeStep(line, k, st) {
  const c = line[k];
  const slash = c === "/" ? slashStep(line, k, st) : null;
  if (slash !== null) return slash;
  if (holeCloses(c, st)) return { next: k + 1, ended: false };
  if (QUOTE_CHARS.has(c)) st.str = c;
  if (c.trim() !== "") st.prev = c;
  return { next: k + 1, ended: st.shape(c, st) };
}

/** Inside a template's `${...}` hole braces nest; the one that closes the hole resumes the template. */
function holeCloses(c, st) {
  const top = st.holes.length - 1;
  if (top < 0) return false;
  if (c === "{") st.holes[top] += 1;
  if (c !== "}") return false;
  if (st.holes[top] > 0) {
    st.holes[top] -= 1;
    return false;
  }
  st.holes.pop();
  st.str = "`";
  return true;
}

/** A `/` in code: a line comment (the rest is prose), a block comment, a regex literal skipped whole
 *  where an operand may start, or null — division, an ordinary character. */
function slashStep(line, k, st) {
  if (line[k + 1] === "/") return { next: line.length, ended: false };
  if (line[k + 1] === "*") {
    st.block = true;
    return { next: k + 2, ended: false };
  }
  const end = regexCanStart(line.slice(0, k), st.prev) ? regexEnd(line, k) : -1;
  return end === -1 ? null : { next: end + 1, ended: false };
}

/** After an operator or opening punctuation, or a keyword that takes an operand, `/` opens a regex —
 *  never after a postfix `++`/`--`, whose operand is finished. */
const REGEX_AFTER = new Set([..."(,=:[!&|?{;+-*%<>~^"]);
function regexCanStart(before, prev) {
  if (/(?:\+\+|--)\s*$/.test(before)) return false;
  return prev === null || REGEX_AFTER.has(prev) || /(?:^|[^\w$.])(?:return|typeof|case|void|throw|in|of|yield|await)\s*$/.test(before);
}

/** Index of the `/` closing the regex literal that opens at `k`, or -1. A regex cannot span lines, so
 *  a `/` with no closing one on its line is division — read as a regex, it swallowed the rest of the
 *  line and a bracket with it. Quotes and brackets inside are pattern; a class's `/` does not close. */
function regexEnd(line, k) {
  let cls = false;
  for (let j = k + 1; j < line.length; j += 1) {
    const c = line[j];
    if (c === "\\") j += 1;
    else if (c === "/" && !cls) return j;
    else if (c === "[" || c === "]") cls = c === "[";
  }
  return -1;
}

/** A function: nothing counts until its body opens; it closes with that body's brace. */
function functionStep(c, st) {
  if (st.started) bodyStep(c, st);
  else headerStep(c, st);
  return st.started && st.depth <= 0;
}

/** A binding: every bracket kind nests, and a `;` outside them all ends the statement. */
function statementStep(c, st) {
  if ("([{".includes(c)) st.depth += 1;
  if (")]}".includes(c)) st.depth -= 1;
  return c === ";" && st.depth <= 0;
}

/** Before the body: braces inside the PARAMETER list (destructuring, `= {}` defaults) are not the
 *  body's — ending the cut on them left whole helper bodies in the corpus, the fail-open direction. */
function headerStep(c, st) {
  if (c === "(") st.parens += 1;
  if (c === ")") st.parens -= 1;
  if (c === "{" && st.parens === 0) {
    st.depth = 1;
    st.started = true;
  }
}

function bodyStep(c, st) {
  if (c === "{") st.depth += 1;
  if (c === "}") st.depth -= 1;
}

/** Production corpus under `root`: config roots, code extensions, minus test artifacts, minus the
 *  config's reasoned exclusions, minus this tool (its fixtures name every member). */
export function corpusFiles(root, corpusConfig) {
  const out = [];
  const exclude = corpusConfig.exclude ?? [];
  for (const r of corpusConfig.roots) {
    // "." means the root itself, so its files land at top level (`app.mjs`), not `./app.mjs`.
    walkDir(join(root, r), r === "." ? "" : r.replace(/\/+$/, ""), out, exclude);
  }
  return out.sort();
}

function walkDir(abs, rel, out, exclude) {
  let entries = [];
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return; // an unreadable directory contributes nothing; the corpus is what we can see
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walkDir(join(abs, entry.name), relPath, out, exclude);
      continue;
    }
    if (admitFile(join(abs, entry.name), entry.name, relPath, exclude)) out.push(relPath);
  }
}

function admitFile(absPath, name, relPath, exclude) {
  if (!CODE_EXTS.test(name)) return false;
  if (NEVER_CORPUS.test(`/${relPath}`)) return false;
  if (isSelf(absPath)) return false; // self-exclusion: the RCA's false-positive class
  if (exclude.some((x) => matches(relPath, x.spec))) return false;
  return true;
}

function isSelf(absPath) {
  let real = null;
  try {
    real = realpathSync(absPath);
  } catch {
    return true; // unresolvable: exclude, which fails toward findings, never toward silence
  }
  return real === SELF_REALPATH;
}

/* ------------------------------------------------------------------------------------------------
 * The sweep
 * ---------------------------------------------------------------------------------------------- */

export function sweep(root, config) {
  const ctx = buildContext(root, config);
  const findings = [];
  const ambiguousByContract = {};
  let memberCount = 0;
  for (const contract of config.contracts) {
    const result = sweepContract(contract, ctx);
    if (result.defect) return result;
    findings.push(...result.findings);
    ambiguousByContract[result.label] = result.ambiguous;
    memberCount += result.memberCount;
  }
  return { findings, ambiguousByContract, memberCount, fileCount: ctx.files.length };
}

function buildContext(root, config) {
  const files = corpusFiles(root, config.corpus);
  const cache = new Map();
  const deadByFile = new Map();
  const load = (path) => {
    if (!cache.has(path)) {
      const text = readFileSync(join(root, path), "utf8");
      const lines = text.split("\n");
      cache.set(path, { text, lines, dead: testCodeRanges(lines), predicate: predicateArrayRanges(text) });
    }
    return cache.get(path);
  };
  const deadSetFor = (path) => {
    if (!deadByFile.has(path)) {
      const set = new Set();
      for (const [a, b] of load(path).dead) for (let i = a; i <= b; i += 1) set.add(i);
      deadByFile.set(path, set);
    }
    return deadByFile.get(path);
  };
  return { root, files, load, deadSetFor };
}

function sweepContract(contract, ctx) {
  const contractPath = join(ctx.root, contract.path);
  if (!existsSync(contractPath)) {
    return { defect: `reader-existence GATE_DEFECT — contract file ${contract.path} does not exist; a sweep that cannot read its contract certifies nothing.\n  fix: fix the path in ${CONFIG_PATH}.` };
  }
  const source = readFileSync(contractPath, "utf8");
  const members = unionMembers(source, contract.symbol);
  if (members.length === 0) {
    return { defect: `reader-existence GATE_DEFECT — ${contract.symbol} not found (or empty) in ${contract.path}.\n  fix: fix the symbol in ${CONFIG_PATH}, or sweep the union where it actually lives.` };
  }
  markDeclarationDead(ctx, contract.path, source, contract.symbol);
  return contractVerdicts(contract, members, ctx);
}

/** The declaration's own lines are excluded from the corpus for THIS contract's file — computed
 *  per contract, layered on the selfTest cuts already recorded for that file. */
function markDeclarationDead(ctx, path, source, symbol) {
  const range = declarationRange(source, symbol);
  if (range === null) return;
  const dead = ctx.deadSetFor(path);
  for (let i = range[0]; i <= range[1]; i += 1) dead.add(i);
}

function contractVerdicts(contract, members, ctx) {
  const findings = [];
  let ambiguous = 0;
  for (const raw of members) {
    const verdict = memberSweep(raw, contract, ctx);
    ambiguous += verdict.ambiguous;
    if (verdict.finding !== null) findings.push(verdict.finding);
  }
  return { findings, ambiguous, memberCount: members.length, label: `${contract.symbol} (${contract.path})` };
}

function memberSweep(raw, contract, ctx) {
  const member = typeof raw === "string" ? raw : raw.member;
  const alias = typeof raw === "string" ? null : raw.alias;
  const counts = { producers: 0, consumers: 0, ambiguous: 0, where: [] };
  const files = ctx.files.includes(contract.path) ? ctx.files : [...ctx.files, contract.path];
  for (const file of files) countRoles(file, ctx, { member, alias, symbol: contract.symbol, counts });
  return memberVerdict(`${contract.symbol}.${member}`, counts);
}

function countRoles(file, ctx, m) {
  const { lines, predicate } = ctx.load(file);
  const dead = ctx.deadSetFor(file);
  lines.forEach((line, i) => {
    if (dead.has(i)) return;
    // An aliased (object) union counts a KEY reference as a producer-and-consumer pair:
    // reaching `QUEUES.transcode` both names the member and uses it.
    if (m.alias !== null && new RegExp(`\\b${m.symbol}\\.${m.alias}\\b`).test(line)) {
      m.counts.producers += 1;
      m.counts.consumers += 1;
      m.counts.where.push(`${file}:${i + 1}`);
      return;
    }
    if (!line.includes(`"${m.member}"`)) return;
    const inPredicate = predicate.some(([a, b]) => i >= a && i <= b);
    tally(classifyLine(line, m.member, inPredicate), m.counts, `${file}:${i + 1}`);
  });
}

function tally(roles, counts, where) {
  if (roles.has("PRODUCER")) counts.producers += 1;
  if (roles.has("CONSUMER")) counts.consumers += 1;
  if (roles.has("AMBIGUOUS")) counts.ambiguous += 1;
  counts.where.push(where);
}

/**
 * The verdict, or none. An unclassified use SUPPRESSES every verdict for this member — see the
 * header. Written as guards on each branch so the suppression rule reads as one condition.
 */
function memberVerdict(id, counts) {
  const { producers, consumers, ambiguous, where } = counts;
  if (producers === 0 && consumers === 0 && ambiguous === 0) {
    return { finding: { id, verdict: "DEAD", detail: "no production reference at all", where }, ambiguous };
  }
  if (ambiguous === 0 && producers === 0) {
    return { finding: { id, verdict: "NO_PRODUCER", detail: `${consumers} consumer(s), no producer`, where }, ambiguous };
  }
  if (ambiguous === 0 && consumers === 0) {
    return { finding: { id, verdict: "NO_CONSUMER", detail: `${producers} producer(s), no consumer`, where }, ambiguous };
  }
  return { finding: null, ambiguous };
}

/* ------------------------------------------------------------------------------------------------
 * Report + baseline gate
 * ---------------------------------------------------------------------------------------------- */

function runGate(config, { report }) {
  const result = sweep(ROOT, config);
  if (result.defect) {
    console.error(result.defect);
    return 1;
  }
  printSweep(result, report);
  if (report) return 0;
  return baselineVerdict(config.accepted ?? {}, result.findings);
}

function printSweep(result, report) {
  const suppressed = Object.values(result.ambiguousByContract).reduce((a, b) => a + b, 0);
  console.log(`reader-existence — ${Object.keys(result.ambiguousByContract).length} contract(s), ${result.memberCount} member(s) swept over ${result.fileCount} production file(s): ${result.findings.length} finding(s), ${suppressed} unclassified use(s) suppressed.`);
  for (const f of result.findings) printFinding(f, report);
  for (const [contract, count] of Object.entries(result.ambiguousByContract)) {
    if (count > 0) console.log(`  SUPPRESSED    ${contract} — ${count} unclassified use(s); every verdict for those members is withheld (a vacuous sweep is visible here, not silent).`);
  }
}

function printFinding(f, report) {
  const where = report && f.where.length > 0 ? `\n${f.where.map((w) => `      ${w}`).join("\n")}` : "";
  console.log(`  ${f.verdict.padEnd(12)} ${f.id} — ${f.detail}${where}`);
}

/**
 * The gate. Three ways the baseline stops describing reality: a NEW finding, a STALE row, and a row
 * whose verdict DRIFTED — keyed by id alone, a NO_PRODUCER row whose last consumer is deleted turns
 * DEAD and stays green, its reason still describing a reader that no longer exists.
 */
function baselineVerdict(accepted, findings, out = console) {
  const acceptedIds = new Set(Object.keys(accepted));
  const current = new Set(findings.map((f) => f.id));
  const added = [...current].filter((id) => !acceptedIds.has(id));
  const stale = [...acceptedIds].filter((id) => !current.has(id));
  const drifted = findings.filter((f) => acceptedIds.has(f.id) && recordedVerdict(accepted[f.id]) !== f.verdict);
  for (const id of added) out.error(`  NEW dead wiring: ${id} — add a reader/producer, or accept it in ${CONFIG_PATH} WITH A REASON.`);
  for (const id of stale) out.error(`  STALE accepted row: ${id} is no longer a finding — first rule out a test-only producer that escaped the corpus cut (a row pruned as stale that way hid a live finding once), then remove it from ${CONFIG_PATH}. A baseline nobody prunes becomes a permission slip.`);
  for (const f of drifted) out.error(`  DRIFTED accepted row: ${f.id} was accepted as ${recordedVerdict(accepted[f.id])}, the sweep now says ${f.verdict} — fix the wiring, or re-justify the row in ${CONFIG_PATH} with a reason opening "${f.verdict} —".`);
  if (added.length + stale.length + drifted.length > 0) {
    out.error(`reader-existence: FAILED (${added.length} new, ${stale.length} stale, ${drifted.length} drifted).`);
    return 1;
  }
  out.log(`reader-existence — no new dead wiring (${acceptedIds.size} accepted finding(s), each with a reason, in ${CONFIG_PATH}).`);
  return 0;
}

/* ------------------------------------------------------------------------------------------------
 * Self-test — fixtures only; never the live config, never the live tree's verdicts.
 * ---------------------------------------------------------------------------------------------- */

/** loadConfig over an in-memory object (serialized through the same parser the file path takes). */
function loadConfigFromObject(object) {
  const path = join(tmpdir(), `reader-existence-obj-${process.pid}.json`);
  writeFileSync(path, JSON.stringify(object));
  const result = loadConfig(path);
  rmSync(path, { force: true });
  return result;
}

function selfTestClassifier(fail) {
  const cases = [
    ["CONSUMER", classifyLine('  } else if (has("AGE_GATE")) {', "AGE_GATE", false)],
    ["CONSUMER", classifyLine('    case "queued":', "queued", false)],
    ["CONSUMER", classifyLine('  if (x === "SPAM") {', "SPAM", false)],
    ["PRODUCER", classifyLine('  applyPostLabel({ label: "SCANNED" });', "SCANNED", false)],
    ["PRODUCER", classifyLine('      return ["SPAM", "DO_NOT_AMPLIFY"];', "SPAM", false)],
    ["CONSUMER", classifyLine('  "HASH_MATCH",', "HASH_MATCH", true)],
    ["AMBIGUOUS", classifyLine('  "HASH_MATCH",', "HASH_MATCH", false)],
    // Prose describing a member is not a reference to it (the self-exclusion false-positive class).
    ["AMBIGUOUS", classifyLine('  * every "AGE_GATE" claim cites its reader', "AGE_GATE", false)],
    // The stallion shape the port added: a single-line guard set, resolved as a predicate const.
    ["CONSUMER", classifyLine('export const APPROVAL_REQUIRED = new Set(["protected", "migration"]);', "protected", true)],
  ];
  // Every assertion is counted as it runs, so the banner's number is derived, never hand-typed.
  let asserted = 0;
  const check = (ok, message) => {
    asserted += 1;
    if (!ok) fail(message);
  };
  // `got` is a SET of roles — the case table lists a role that must be PRESENT, not equality.
  for (const [want, got] of cases) check(got.has(want), `classifier wanted ${want}, got [${[...got].join(",")}]`);
  // The both-roles line is the regression that motivated the Set: assert BOTH, not just one.
  const both = classifyLine('  return labels.includes("BLOCK") ? labels : [...labels, "BLOCK"];', "BLOCK", false);
  check(both.has("CONSUMER") && both.has("PRODUCER"), `a produce-and-consume line classified as [${[...both].join(",")}]`);
  // A READ that happens to sit in a return statement writes nothing: counting it as a producer
  // turns a read-never-written member green (the founding tier() shape, one statement over).
  const readInReturn = classifyLine('  return m === "GHOST";', "GHOST", false);
  check(!readInReturn.has("PRODUCER"), `a comparison inside a return was read as a PRODUCER: [${[...readInReturn].join(",")}]`);
  // A literal ARGUMENT beside an unrelated predicate call is not that read: it stays unclassified.
  const beside = classifyLine('  send("GHOST", list[0].has(x));', "GHOST", false);
  check(!beside.has("CONSUMER"), `a literal argument beside a predicate call was read as a CONSUMER: [${[...beside].join(",")}]`);
  // The same READ spelled as inline membership: the literal is the receiver's element, not the call's argument.
  for (const line of ['  return ["GHOST", "X"].includes(m);', '  return new Set(["GHOST"]).has(m);', '  return ["GHOST"].some((x) => x === m);']) {
    const roles = classifyLine(line, "GHOST", false);
    check(roles.has("CONSUMER") && !roles.has("PRODUCER"), `an inline membership test inside a return was not read as a CONSUMER: ${line.trim()} -> [${[...roles].join(",")}]`);
  }
  // Mixed with an identifier or a spread, the inline array is still only the receiver of a read.
  for (const line of ['  return [KIND, "GHOST"].includes(m);', '  return ["GHOST", KIND].includes(m);', '  return [...BASE, "GHOST"].includes(m);', '  if ([...BASE, "GHOST"].includes(m)) go();']) {
    const roles = classifyLine(line, "GHOST", false);
    check(roles.has("CONSUMER") && !roles.has("PRODUCER"), `an inline membership test over a mixed array was not read as a CONSUMER: ${line.trim()} -> [${[...roles].join(",")}]`);
  }
  const spread = classifyLine('  send([...BASE, "GHOST"]);', "GHOST", false);
  check(spread.has("PRODUCER"), `a spread array that is not read lost its PRODUCER role: [${[...spread].join(",")}]`);
  const returned = classifyLine('  return ok ? "CLOSED" : null;', "CLOSED", false);
  check(returned.has("PRODUCER"), `a returned literal lost its PRODUCER role: [${[...returned].join(",")}]`);
  return asserted;
}

function selfTestPredicateShapes(fail) {
  // The two real shapes, and the iterated const that must NOT resolve (reading the array is not
  // testing a member).
  const multi = ['const HARD_BLOCK = [', '  "HASH_MATCH",', '  "SPAM",', '];', 'if (HARD_BLOCK.some((l) => l === x)) return true;'].join("\n");
  if (JSON.stringify(predicateArrayRanges(multi)) !== "[[0,3]]") fail(`multi-line predicate range wrong: ${JSON.stringify(predicateArrayRanges(multi))}`);
  const single = 'const APPROVAL_REQUIRED = new Set(["protected", "migration"]);\nif (APPROVAL_REQUIRED.has(record.riskClass)) return null;';
  if (JSON.stringify(predicateArrayRanges(single)) !== "[[0,0]]") fail(`single-line new Set predicate range wrong: ${JSON.stringify(predicateArrayRanges(single))}`);
  const iterated = 'const phases = ["intake", "planned"];\nfor (const p of phases) console.log(p);';
  if (predicateArrayRanges(iterated).length !== 0) fail("an ITERATED const must not resolve as a predicate");
}

function selfTestUnionShapes(fail) {
  const arrMembers = unionMembers('export const MODES = [\n  "OPEN",\n  "CLOSED",\n] as const;', "MODES");
  if (JSON.stringify(arrMembers) !== JSON.stringify(["OPEN", "CLOSED"])) fail(`array members wrong: ${JSON.stringify(arrMembers)}`);
  if (JSON.stringify(unionMembers('export const SEVERITIES = ["CRITICAL", "HIGH"];', "SEVERITIES")) !== JSON.stringify(["CRITICAL", "HIGH"])) fail("as-const-optional array form failed");
  const objMembers = unionMembers('export const QUEUES = { transcode: "media.transcode" } as const;', "QUEUES");
  if (objMembers.length !== 1 || objMembers[0].alias !== "transcode" || objMembers[0].member !== "media.transcode") fail(`object members wrong: ${JSON.stringify(objMembers)}`);
  if (unionMembers("export const NOTHING = 1;", "MISSING").length !== 0) fail("a missing symbol must yield no members");
}

function selfTestDeclarationAndCut(fail) {
  // The exclusion covers the declaration, not the file: the producer on the next line survives.
  const decl = ['// header', 'export const MODES = [', '  "OPEN",', '] as const;', 'const other = "OPEN";'].join("\n");
  if (JSON.stringify(declarationRange(decl, "MODES")) !== "[1,3]") fail(`declaration range wrong: ${JSON.stringify(declarationRange(decl, "MODES"))}`);
  // String-aware braces: a `}` inside a string or template must not end the function.
  const cutLines = [
    'function selfTestUnit(fail) {',
    '  const tricky = "a string with } inside";',
    '  const tpl = `template with ${deep({ a: 1 })} and } too`;',
    '  if (1) { fail("x"); }',
    '}',
    'export function next() { return 2; }',
  ];
  if (JSON.stringify(selfTestRanges(cutLines)) !== "[[0,4]]") fail(`selfTest cut wrong: ${JSON.stringify(selfTestRanges(cutLines))} (the function after must survive)`);
  const unbalanced = ['function selfTestOdd(fail) {', '  fail("never closes in this fixture");'];
  const odd = selfTestRanges(unbalanced);
  if (odd.length !== 1 || odd[0][1] !== unbalanced.length - 1) fail("parser doubt must cut to EOF (over-cut fails toward findings)");
  // Braces in the PARAMETER list (destructuring, `= {}` defaults) are not the body's: ending the cut
  // there leaves the whole body in the corpus — the under-cut, fail-open direction.
  const destructured = ['function selfTestD(fail, { a, b } = {}) {', '  fail(a, b);', '}', 'export const after = 1;'];
  if (JSON.stringify(selfTestRanges(destructured)) !== "[[0,2]]") fail(`a destructured parameter list ended the cut early: ${JSON.stringify(selfTestRanges(destructured))}`);
  // A file-private helper NOTHING reaches never runs: its literals are not production either.
  const stray = ["function stray() {", '  return { status: "X" };', "}", "export const y = 1;"];
  if (JSON.stringify(testCodeRanges(stray)) !== "[[0,2]]") fail(`an unreferenced file-private helper stayed in the corpus: ${JSON.stringify(testCodeRanges(stray))}`);
  selfTestBindingCut(fail);
}

/** Test code is test code in EVERY declaration shape: a const arrow helper and a fixture table reached
 *  only from selfTest code, and a `const selfTest*` binding, are cut like a `function` is. */
function selfTestBindingCut(fail) {
  const sorted = (lines) => JSON.stringify(testCodeRanges(lines).sort((a, b) => a[0] - b[0]));
  const shapes = [
    ["a const arrow helper", ['const seed = () => ({ status: "X" });', "function selfTestX() {", "  seed();", "}"], "[[0,0],[1,3]]"],
    ["a multi-line fixture table", ["const CASES = [", '  { status: "X" },', "];", "function selfTestX() {", "  for (const c of CASES) void c;", "}"], "[[0,2],[3,5]]"],
    // main() dispatching --self-test is production reaching it: the NAME cuts it, as it cuts `function selfTest*`.
    ["a const selfTest* binding", ['const selfTestSeed = () => ({ status: "X" });', "export function main() { return selfTestSeed(); }"], "[[0,0]]"],
  ];
  for (const [label, lines, want] of shapes) {
    if (sorted(lines) !== want) fail(`${label} reached only from test code stayed in the corpus: ${sorted(lines)} (wanted ${want})`);
  }
  // A regex literal's quote or backtick is not a string: read as one, it swallowed the file — and every
  // production reference with it, so a live helper looked reached by nothing and was cut.
  const regexHelper = ["function helper(x) {", "  return /[\"'`]/.test(x);", "}", "export function f(x) { return helper(x); }"];
  if (sorted(regexHelper) !== "[]") fail(`a regex literal's quote swallowed a production caller: ${sorted(regexHelper)}`);
  const regexBrace = ["function helper(x) {", "  return /[{]/.test(x);", "}", "export function f(x) { return helper(x); }"];
  if (sorted(regexBrace) !== "[]") fail(`a regex literal's brace unbalanced the scan past a production caller: ${sorted(regexBrace)}`);
  // A template nested in a template's hole: an opaque hole closed the outer template on the inner one's backtick.
  const nested = ["const quote = (w) => `'${w.replaceAll(\"'\", `'\\\\''`)}'`;", "export function f(w) { return quote(w); }"];
  if (sorted(nested) !== "[]") fail(`a template nested in a template hole swallowed a production caller: ${sorted(nested)}`);
  selfTestSlashDoubt(fail);
}

/** A misread `/` swallows a bracket, and a scan that resumes one bracket short closes the cut EARLY — test
 *  literals left in the corpus, the fail-open direction. A regex cannot span lines and a postfix `++` is
 *  followed only by division; a quote still open at a line's end is doubt, and doubt cuts to EOF. */
function selfTestSlashDoubt(fail) {
  // The odd quote in the comment re-syncs a scan that carried the open quote on, so only EOF passes.
  const body = (line) => ["function selfTestA() {", line, '    seed("GHOST"); // a "quote', "  }", '  seed("GHOST2");', "}", "export const x = 1;"];
  const shapes = [
    ["division after a postfix ++", "  let i = 0; i++ / 2; if (i) {", "[[0,5]]"],
    ["division after a postfix ++, a later slash on the line", "  let i = 0; i++ / 2; if (i) { i /= 2;", "[[0,5]]"],
    ["division after an identifier spelled like a keyword", "  const of = 4; const h = of / 2; if (h) {", "[[0,5]]"],
    ["a regex read as division, its quote left open", '  if (i) /"/.test(s); if (s) {', "[[0,6]]"],
  ];
  for (const [label, line, want] of shapes) {
    const got = JSON.stringify(selfTestRanges(body(line)));
    if (got !== want) fail(`a misread slash resumed the cut one bracket short (${label}): ${got}, wanted ${want}`);
  }
}

function writeFixtureTree(dir) {
  writeFileSync(join(dir, "contract.mjs"), 'export const MODES = [\n  "OPEN",\n  "CLOSED",\n  "GHOST",\n  "ORPHAN",\n];\n');
  writeFileSync(
    join(dir, "app.mjs"),
    [
      'export function open() { return { status: "OPEN" }; }',
      'export const isOpen = (m) => m === "OPEN";',
      // A file-private helper that PRODUCTION reaches: its literals are production, never cut.
      'function closedStatus() {',
      '  return { status: "CLOSED" };',
      '}',
      'export function close() { return closedStatus(); }',
      'export const isClosed = (m) => m === "CLOSED";',
      'export const isGhost = (m) => m === "GHOST";',
      // File-private helpers that ONLY the self-test reaches — one of them through the other — are
      // test code whatever their names. `open` is reached from the self-test too, but it is EXPORTED:
      // another module may be its production caller, so it stays.
      'function orphanStatus() {',
      '  return { status: "ORPHAN" };',
      '}',
      'function seedOrphan() {',
      '  return orphanStatus();',
      '}',
      // Reached by nothing at all: dead code, whose literal must not turn ORPHAN produced.
      'function strayOrphan() { return { status: "ORPHAN" }; }',
      // The same seeding in the codebase's other helper shapes: a const arrow and a fixture table.
      'const ghostRecord = () => ({ status: "GHOST" });',
      'const ORPHAN_CASES = [',
      '  { status: "ORPHAN" },',
      '];',
      'function selfTestUnit() {',
      '  ghostRecord();',
      '  for (const c of ORPHAN_CASES) void c;',
      '  if (isGhost("GHOST") !== true) throw new Error("GHOST seeded by hand, like a test would");',
      '  if ("ORPHAN" === "ORPHAN") console.log("ORPHAN referenced only by test prose");',
      '  seedOrphan();',
      '  open();',
      '}',
      'void selfTestUnit;',
    ].join("\n"),
  );
  writeFileSync(join(dir, "old.test.mjs"), 'export const fake = "ORPHAN"; // a test artifact is never production');
}

function fixtureConfig() {
  return {
    contracts: [{ path: "contract.mjs", symbol: "MODES" }],
    corpus: { roots: ["."], exclude: [] },
    accepted: { "MODES.ORPHAN": "DEAD — fixture: seeded dead member accepted with a reason" },
  };
}

function selfTestSweepVerdicts(fail, dir) {
  const result = sweep(dir, fixtureConfig());
  if (result.defect) {
    fail(`fixture sweep refused: ${result.defect}`);
    return;
  }
  // The WHOLE map, sorted: a key-whitelist replacer would hide a spurious finding on any other member.
  const verdicts = JSON.stringify(Object.fromEntries(result.findings.map((f) => [f.id, f.verdict]).sort()));
  // The inline self-test's hand-seeded references must NOT count — the founding blindness.
  if (verdicts !== '{"MODES.GHOST":"NO_PRODUCER","MODES.ORPHAN":"DEAD"}') fail(`fixture verdicts wrong: ${verdicts}`);
  const orphan = result.findings.find((f) => f.id === "MODES.ORPHAN");
  if (orphan?.verdict !== "DEAD") fail(`a helper called only from selfTest code leaked into the corpus: MODES.ORPHAN is ${orphan?.verdict} at ${orphan?.where.join(", ")}`);
  if (result.findings.some((f) => f.where.some((w) => w.startsWith("old.test.mjs")))) fail("a test artifact leaked into the corpus");
  const defect = (contract) => String(sweep(dir, { ...fixtureConfig(), contracts: [contract] }).defect);
  if (!defect({ path: "missing.mjs", symbol: "MODES" }).includes("does not exist")) fail("a missing contract file must be a GATE_DEFECT");
  if (!defect({ path: "contract.mjs", symbol: "NOPE" }).includes("not found")) fail("an unknown contract symbol must be a GATE_DEFECT");
}

/** baselineVerdict itself, every direction — its exit code is the gate; a copy of its logic proves nothing. */
function selfTestBaselineDirection(fail) {
  const findings = [
    { id: "MODES.ORPHAN", verdict: "DEAD" },
    { id: "MODES.GHOST", verdict: "NO_PRODUCER" },
  ];
  const clean = { "MODES.ORPHAN": "DEAD — r", "MODES.GHOST": "NO_PRODUCER — r" };
  const cases = [
    ["the matching baseline passes", clean, 0, "no new dead wiring"],
    ["an unaccepted finding fails as NEW", { "MODES.ORPHAN": "DEAD — r" }, 1, "NEW dead wiring: MODES.GHOST"],
    ["an accepted row with no finding fails as STALE", { ...clean, "MODES.OPEN": "NO_CONSUMER — stale on purpose" }, 1, "STALE accepted row: MODES.OPEN"],
    ["a verdict drifted under an accepted row and the baseline stayed green", { ...clean, "MODES.ORPHAN": "NO_PRODUCER — r" }, 1, "DRIFTED accepted row: MODES.ORPHAN"],
    // The verdict a row accepts is the one it OPENS with, not the first one its prose mentions.
    ["a row naming an older verdict in its prose was read as drifted", { ...clean, "MODES.GHOST": "NO_PRODUCER — was DEAD before the reader landed" }, 0, "no new dead wiring"],
  ];
  for (const [label, accepted, code, needle] of cases) {
    const lines = [];
    const sink = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
    const got = baselineVerdict(accepted, findings, sink);
    if (got !== code || !lines.join("\n").includes(needle)) fail(`${label} (wanted exit ${code} naming "${needle}", got exit ${got})`);
  }
}

function selfTestConfigFailClosed(fail) {
  const tmpCfg = join(tmpdir(), `reader-existence-cfg-${process.pid}.json`);
  writeFileSync(tmpCfg, "{ not json");
  const cases = [
    ["a missing config must fail closed naming the path", loadConfig("/nonexistent/reader-existence.json"), "/nonexistent/reader-existence.json"],
    ["an unparseable config must fail closed", loadConfig(tmpCfg), "not valid JSON"],
    ["a config with no contracts must fail closed", loadConfigFromObject({ corpus: { roots: ["tools"] } }), "no contracts"],
    [
      "a reasonless exclusion must fail closed",
      loadConfigFromObject({ contracts: [{ path: "tools/task-state.mjs", symbol: "RISK_CLASSES" }], corpus: { roots: ["tools"], exclude: [{ spec: "tools/bench/**", why: "" }] } }),
      "why",
    ],
    [
      "an accepted row without a reason must fail closed",
      loadConfigFromObject({ contracts: [{ path: "tools/task-state.mjs", symbol: "RISK_CLASSES" }], corpus: { roots: ["tools"] }, accepted: { "RISK_CLASSES.protected": "" } }),
      "no reason",
    ],
    [
      "an accepted row that mentions a verdict without opening with one must fail closed",
      loadConfigFromObject({ contracts: [{ path: "tools/task-state.mjs", symbol: "RISK_CLASSES" }], corpus: { roots: ["tools"] }, accepted: { "RISK_CLASSES.protected": "not DEAD: the reader lands next wave" } }),
      "verdict",
    ],
    [
      "an accepted row that names no verdict must fail closed",
      loadConfigFromObject({ contracts: [{ path: "tools/task-state.mjs", symbol: "RISK_CLASSES" }], corpus: { roots: ["tools"] }, accepted: { "RISK_CLASSES.protected": "argv produces it" } }),
      "verdict",
    ],
  ];
  for (const [label, result, needle] of cases) {
    if (result.ok || !result.error.includes(needle)) fail(`${label} (wanted the refusal to name "${needle}")`);
  }
  const wellFormed = loadConfigFromObject({ contracts: [{ path: "tools/task-state.mjs", symbol: "RISK_CLASSES" }], corpus: { roots: ["tools"] }, accepted: { "RISK_CLASSES.protected": "NO_PRODUCER — argv produces it" } });
  if (!wellFormed.ok) fail(`a well-formed config must load: ${wellFormed.error}`);
  rmSync(tmpCfg, { force: true });
}

function selfTest() {
  let ok = true;
  const fail = (m) => {
    ok = false;
    console.error(`  reader-existence self-test FAIL: ${m}`);
  };
  const classifierCases = selfTestClassifier(fail);
  selfTestPredicateShapes(fail);
  selfTestUnionShapes(fail);
  selfTestDeclarationAndCut(fail);
  const dir = mkdtempSync(join(tmpdir(), "reader-existence-st-"));
  try {
    writeFixtureTree(dir);
    selfTestSweepVerdicts(fail, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  selfTestBaselineDirection(fail);
  selfTestConfigFailClosed(fail);
  console.log(ok ? `reader-existence self-test: OK (${classifierCases} classifier cases, count derived + predicate/union/declaration/cut/corpus/baseline/config groups)` : "reader-existence self-test: FAILED");
  return ok;
}

/* ------------------------------------------------------------------------------------------------
 * CLI, guarded by an entry-module check (pathspec.mjs's law: a bare argv check fires on IMPORT
 * and exits before an importing guard's own --self-test can run).
 * ---------------------------------------------------------------------------------------------- */

function main() {
  if (process.argv.includes("--self-test")) return selfTest() ? 0 : 1;
  const loaded = loadConfig(join(ROOT, CONFIG_PATH));
  if (!loaded.ok) {
    console.error(loaded.error);
    return 1;
  }
  return runGate(loaded.config, { report: process.argv.includes("--report") });
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
if (isEntry) process.exit(main());
