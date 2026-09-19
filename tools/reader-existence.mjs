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
 *      FUNCTION BODIES (string-aware brace matching; on parser doubt the cut runs to EOF, which
 *      can only over-report findings, the fail-closed direction).
 *   2. THE DECLARATION. Antitube excluded the contract FILE; stallion's contracts share files with
 *      their own producers (`RISK_CLASSES` lives in task-state.mjs, which also branches on its
 *      members), so excluding the file would gut the sweep. The corpus excludes exactly the
 *      declaration's line range instead — the lines the compiler would read, nothing else.
 *   Plus the standing law: docs, fixtures, dist and THIS TOOL are never corpus members (this
 *   tool's fixtures name every member; counting them was the false-positive class that motivated
 *   the original self-exclusion).
 *
 * BASELINE. `accepted` in the config records today's ACCEPTED findings, each with a reason — an
 * absent or empty reason fails the config. The gate fails on any finding NOT accepted, and ALSO on
 * an accepted row that is no longer a finding: a stale row means the baseline has stopped
 * describing reality, and a baseline nobody prunes decays into a permission slip.
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { matches } from "./pathspec.mjs";

const CONFIG_PATH = "docs/gates/reader-existence.json";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SELF_REALPATH = realpathSync(fileURLToPath(import.meta.url));
const CODE_EXTS = /\.(?:mjs|cjs|js)$/;
/** Fixed law, not config: test artifacts by name are never production, whatever the tree grows. */
const NEVER_CORPUS = /\.(?:test|spec)\.[^.]+$|\/(?:test|tests|__tests__|fixtures|dist)\//;

/* ------------------------------------------------------------------------------------------------
 * Config — fail closed on every shape this gate depends on. Each validator returns null or a
 * [message, fix] pair; loadConfig chains them so every refusal names the path and its fix.
 * ---------------------------------------------------------------------------------------------- */

function configDefect(path, message, fix) {
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
    if (typeof reason !== "string" || reason.trim().length === 0) return [`accepted row ${id} carries no reason`, `give ${id} a reason in ${CONFIG_PATH}, or delete the row — "it was already like that" is not one.`];
  }
  return null;
}

export function loadConfig(path) {
  if (!existsSync(path)) {
    return configDefect(path, `${path} is missing; the gate cannot know its contracts, corpus, or accepted findings.`, `restore ${path} from history (its accepted rows and exclusion reasons are the baseline's audit trail) — do not re-seed it blind.`);
  }
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return configDefect(path, `${path} is unreadable: ${e.message}`, "check the file's permissions, then re-run.");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return configDefect(path, `${path} is not valid JSON: ${e.message}`, `repair the JSON in ${path} (a gate that cannot parse its law fails closed).`);
  }
  const defect = contractsError(parsed.contracts) ?? corpusError(parsed.corpus) ?? acceptedError(parsed.accepted);
  if (defect !== null) return configDefect(path, `${path}: ${defect[0]}`, defect[1]);
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

function consumerRoles(line, literal) {
  const q = escapeRe(literal);
  const roles = new Set();
  if (new RegExp(`([=!]==?\\s*"${q}")|("${q}"\\s*[=!]==)`).test(line)) roles.add("CONSUMER");
  if (new RegExp(`case\\s+"${q}"`).test(line)) roles.add("CONSUMER");
  if (new RegExp(`\\.?(has|includes|indexOf|startsWith|endsWith)\\(\\s*"${q}"`).test(line)) roles.add("CONSUMER");
  return roles;
}

// PRODUCER — the literal is being supplied as data. Checked INDEPENDENTLY of the consumer
// patterns, never as an else-branch: one line can do both, and stopping at the first match
// mis-reads `return labels.includes("BLOCK") ? labels : [...labels, "BLOCK"];` as consumer-only.
// A classifier that stops at its first hit under-counts the busier role.
function producerRoles(line, literal) {
  const q = escapeRe(literal);
  const roles = new Set();
  if (new RegExp(`return\\s+.*"${q}"`).test(line)) roles.add("PRODUCER");
  if (new RegExp(`:\\s*"${q}"`).test(line)) roles.add("PRODUCER");
  if (new RegExp(`\\.push\\(\\s*"${q}"`).test(line)) roles.add("PRODUCER");
  if (new RegExp(`[^=!<>]=\\s*"${q}"`).test(line)) roles.add("PRODUCER");
  if (new RegExp(`\\.\\.\\.[A-Za-z_][A-Za-z0-9_]*\\s*,\\s*"${q}"`).test(line)) roles.add("PRODUCER");
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

const SELFTEST_DECL = /^(?:export\s+)?(?:async\s+)?function\s+selfTest\w*\s*\(/;

/**
 * [startLine, endLine] (inclusive) of every inline `selfTest*` function body — stallion's test
 * code lives INSIDE production files, so the corpus cuts the function, not the file. The brace
 * match is STRING-AWARE (a naive count ends the function at the first `}` inside a quoted string
 * or template); if no balanced end is found the cut runs to EOF, which can only REMOVE corpus and
 * therefore OVER-report findings — the fail-closed direction for a blocking gate.
 */
export function selfTestRanges(lines) {
  const ranges = [];
  let i = 0;
  while (i < lines.length) {
    if (!SELFTEST_DECL.test(lines[i])) {
      i += 1;
      continue;
    }
    const end = functionEnd(lines, i);
    ranges.push([i, end]);
    i = end + 1;
  }
  return ranges;
}

/** Index of the line where the function starting at `start` closes; EOF on parser doubt. */
function functionEnd(lines, start) {
  const st = { depth: 0, started: false, str: null, block: false };
  for (let j = start; j < lines.length; j += 1) {
    if (scanLine(lines[j], st)) return j;
  }
  return lines.length - 1;
}

/** One line through the scanner; true when the tracked function closes on this line. */
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
  if (line[k] === st.str) st.str = null;
  return { next: k + 1, ended: false };
}

const QUOTE_CHARS = new Set(['"', "'", "`"]);

function codeStep(line, k, st) {
  const c = line[k];
  if (c === "/") {
    if (line[k + 1] === "/") return { next: line.length, ended: false }; // line comment: rest is prose
    if (line[k + 1] === "*") st.block = true;
  }
  if (QUOTE_CHARS.has(c)) st.str = c; // templates are opaque, holes included
  if (c === "{") {
    st.depth += 1;
    st.started = true;
  }
  if (c === "}") st.depth -= 1;
  return { next: k + 1, ended: st.started && st.depth <= 0 };
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
  const files = corpusFiles(root, config.corpus ?? { roots: ["tools"] });
  const cache = new Map();
  const deadByFile = new Map();
  const load = (path) => {
    if (!cache.has(path)) {
      const text = readFileSync(join(root, path), "utf8");
      const lines = text.split("\n");
      cache.set(path, { text, lines, dead: selfTestRanges(lines), predicate: predicateArrayRanges(text) });
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

function baselineVerdict(accepted, findings) {
  const acceptedIds = new Set(Object.keys(accepted));
  const current = new Set(findings.map((f) => f.id));
  const added = [...current].filter((id) => !acceptedIds.has(id));
  const stale = [...acceptedIds].filter((id) => !current.has(id));
  for (const id of added) console.error(`  NEW dead wiring: ${id} — add a reader/producer, or accept it in ${CONFIG_PATH} WITH A REASON.`);
  for (const id of stale) console.error(`  STALE accepted row: ${id} is no longer a finding — remove it from ${CONFIG_PATH}. A baseline nobody prunes becomes a permission slip.`);
  if (added.length > 0 || stale.length > 0) {
    console.error(`reader-existence: FAILED (${added.length} new, ${stale.length} stale).`);
    return 1;
  }
  console.log(`reader-existence — no new dead wiring (${acceptedIds.size} accepted finding(s), each with a reason, in ${CONFIG_PATH}).`);
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
  for (const [want, got] of cases) {
    // `got` is a SET of roles — the case table lists a role that must be PRESENT, not equality.
    if (!got.has(want)) fail(`classifier wanted ${want}, got [${[...got].join(",")}]`);
  }
  // The both-roles line is the regression that motivated the Set: assert BOTH, not just one.
  const both = classifyLine('  return labels.includes("BLOCK") ? labels : [...labels, "BLOCK"];', "BLOCK", false);
  if (!both.has("CONSUMER") || !both.has("PRODUCER")) fail(`a produce-and-consume line classified as [${[...both].join(",")}]`);
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
}

function writeFixtureTree(dir) {
  writeFileSync(join(dir, "contract.mjs"), 'export const MODES = [\n  "OPEN",\n  "CLOSED",\n  "GHOST",\n  "ORPHAN",\n];\n');
  writeFileSync(
    join(dir, "app.mjs"),
    [
      'export function open() { return { status: "OPEN" }; }',
      'export const isOpen = (m) => m === "OPEN";',
      'export function close() { return { status: "CLOSED" }; }',
      'export const isClosed = (m) => m === "CLOSED";',
      'export const isGhost = (m) => m === "GHOST";',
      'function selfTestUnit() {',
      '  if (isGhost("GHOST") !== true) throw new Error("GHOST seeded by hand, like a test would");',
      '  if ("ORPHAN" === "ORPHAN") console.log("ORPHAN referenced only by test prose");',
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
    accepted: { "MODES.ORPHAN": "fixture: seeded dead member accepted with a reason" },
  };
}

function selfTestSweepVerdicts(fail, dir) {
  const result = sweep(dir, fixtureConfig());
  if (result.defect) {
    fail(`fixture sweep refused: ${result.defect}`);
    return;
  }
  const verdicts = JSON.stringify(Object.fromEntries(result.findings.map((f) => [f.id, f.verdict])), Object.keys({ "MODES.GHOST": 1, "MODES.ORPHAN": 1 }).sort());
  // The inline self-test's hand-seeded references must NOT count — the founding blindness.
  const expected = JSON.stringify({ "MODES.ORPHAN": "DEAD", "MODES.GHOST": "NO_PRODUCER" }, ["MODES.GHOST", "MODES.ORPHAN"]);
  if (verdicts !== expected) fail(`fixture verdicts wrong: ${verdicts}`);
  if (result.findings.some((f) => f.where.some((w) => w.startsWith("old.test.mjs")))) fail("a test artifact leaked into the corpus");
}

function selfTestBaselineDirection(fail, dir) {
  const config = fixtureConfig();
  config.accepted["MODES.OPEN"] = "stale on purpose";
  const current = new Set(sweep(dir, config).findings.map((f) => f.id));
  const stale = Object.keys(config.accepted).filter((id) => !current.has(id));
  if (stale.join(",") !== "MODES.OPEN") fail(`stale detection wrong: ${stale.join(",")}`);
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
  ];
  for (const [label, result, needle] of cases) {
    if (result.ok || !result.error.includes(needle)) fail(`${label} (wanted the refusal to name "${needle}")`);
  }
  rmSync(tmpCfg, { force: true });
}

function selfTest() {
  let ok = true;
  const fail = (m) => {
    ok = false;
    console.error(`  reader-existence self-test FAIL: ${m}`);
  };
  selfTestClassifier(fail);
  selfTestPredicateShapes(fail);
  selfTestUnionShapes(fail);
  selfTestDeclarationAndCut(fail);
  const dir = mkdtempSync(join(tmpdir(), "reader-existence-st-"));
  try {
    writeFixtureTree(dir);
    selfTestSweepVerdicts(fail, dir);
    selfTestBaselineDirection(fail, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  selfTestConfigFailClosed(fail);
  console.log(ok ? "reader-existence self-test: OK (9 classifier cases + predicate/union/declaration/cut/corpus/baseline/config groups)" : "reader-existence self-test: FAILED");
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

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) process.exit(main());
