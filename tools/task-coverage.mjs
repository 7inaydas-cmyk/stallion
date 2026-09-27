#!/usr/bin/env node
/**
 * Task coverage — the control that makes the executable lifecycle MANDATORY .
 *
 * Without this guard, the lifecycle is consented adoption: code can land with no record at all.
 * This control closes that. Run it wherever your push path can refuse: a pre-push hook, a push
 * wrapper, or CI. It refuses any push whose range contains a commit that touches CODE without a
 * task record authorizing it.
 *
 * The contract a code commit must satisfy (all three, or the push fails):
 *   1. its message carries a `task: <kebab-id>` footer on its own line;
 *   2. tasks/<id>.json exists and is a valid record;
 *   3. that record authorizes implementation AT PUSH TIME: risk class not implementation-forbidden,
 *      derived phase at least `executing`, and (defense in depth) protected/migration classes carry
 *      an approval event — task-state enforces these at advance-time; this re-checks them because a
 *      hand-edited record must not sail through on the advance-time check alone.
 *
 * What counts as CODE (deliberately broad, stated so it cannot widen by inference): files under
 * apps/**, packages/**, tools/**, deploy/** with a code extension (ts, tsx, js, mjs, cjs, sh, mts,
 * cts, css) or named Dockerfile/Caddyfile. Docs, JSON state, markdown, and config outside those
 * trees do not need a task — the lifecycle governs implementation, not prose. (.sql is exempt by
 * default: SQL migrations tend to be fenced by schema-review controls elsewhere.)
 *
 * Honest boundaries, acknowledged rather than fenced (an adversarial pass): the
 * record is read from the WORKING TREE at push time (CI re-judges from the pushed tree); nothing
 * re-checks a record after its push — a later rewind is the plain-JSON trust boundary whose
 * evidence is git history; and the footer binds the commit to the task's DECLARED SCOPE
 * (citationRefusal — the commit-msg gate at commit time, this fence at push time), so a citation
 * is no longer bearer: post-cutover tasks must name their blast radius and code outside it
 * refuses. A post-hoc scope widening IS possible (append-only amendment); no machine check
 * reads event-vs-commit ordering — this repo's neutral-date discipline makes timestamps
 * non-evidence — so the visibility is the amendment event itself in the record's git history,
 * and a single commit that both widens a scope and lands the excusing code is that history's
 * plainest tell (registered future work).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { lanesFromChecklist } from "./adversarial-runner.mjs";
import { RISK_CLASSES, IMPLEMENTATION_FORBIDDEN, APPROVAL_REQUIRED, PHASES as PHASE_ORDER, derivePhase, hasValidPin, hasPinExemption, PIN_LAW_CUTOVER, scopeOf, recordCreatedAt, globRefusal, SCOPE_LAW_CUTOVER, recordMustChain, CHAIN_CUTOVER, fenceSurfaceRefusal, FENCE_SURFACE, decisionHeadingExists } from "./task-state.mjs";
import { chainError, chainStampEvents, STRICT_UTC_STAMP } from "./task-findings.mjs";
import { stripComments } from "./test-lint.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STATE_DIR = `${ROOT}tasks`;
const DECISIONS_REL = "docs/decisions/DECISIONS.md";
const CHECKLIST_REL = "docs/ADVERSARIAL-CHECKLIST.md";
const CODE_TREES = ["apps/", "packages/", "tools/", "deploy/"];
/** The commit where docs/gates/** became fence surface (2026-09-20 merge wave). Commits BEFORE
 *  this sha are judged with docs/gates as NON-code — the law they were written under. A new
 *  classification that retroactively outlaws settled history makes its own range unshippable (an
 *  adversarial CRITICAL: the wave's own footer-less docs commit predated its own fence-surface
 *  law), and the repo's answer to a law changing mid-history is the same cutover pattern the pin,
 *  scope, and chain laws use: grandfather what settled under the law of its day. */
export const FENCE_SURFACE_CUTOVER_COMMIT = "484df9daebace7148e491b9ded1ae33697890f25";
const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".sh", ".mts", ".cts", ".css"]);
const CODE_NAMES = new Set(["Dockerfile", "Caddyfile"]); // no-extension executables under the four trees

/** Pure: does this changed path count as code the lifecycle must cover? The fence's own
 *  surface — .stallion-base, the hooks, the CI workflows — IS code: an adversarial finding
 *  showed a base bump or a workflow edit needed no task footer, letting the gated party
 *  rewrite the fence in the very push it fences. */
/** Pure: is this path fence SURFACE — the controls' own law, rewrites of which must carry a
 *  task footer like any code? Earned twice: .stallion-base/.githooks/.github were reclassified
 *  because the gated party could rewrite the fence in the push it fences; docs/gates/ joined
 *  them in the 2026-09-20 merge wave (an adversarial finding) because a gate's threshold,
 *  exemptions, accepted findings, required transports, and ratchet baseline live there —
 *  rewriting any of them defangs a gate in a commit that would otherwise need no task footer. */
function fenceSurfacePath(path) {
  if (FENCE_SURFACE.files.includes(path)) return true;
  // The one documented narrowing: of .github/, only the CI workflow files are fence surface.
  if (path.startsWith(".github/")) return path.startsWith(".github/workflows/") && /\.(yml|yaml)$/.test(path);
  return FENCE_SURFACE.roots.some((root) => path.startsWith(`${root}/`));
}

export function isCodePath(path) {
  if (fenceSurfacePath(path)) return true;
  if (!CODE_TREES.some((t) => path.startsWith(t))) return false;
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (CODE_NAMES.has(base)) return true;
  const dot = path.lastIndexOf(".");
  return dot !== -1 && CODE_EXTS.has(path.slice(dot));
}

/**
 * Pure: the staged-files gate decision. Code staged + no task in flight = refusal carrying the
 * code files as evidence; null = pass. In flight means executing, verified, or adversarial —
 * done does NOT authorize new code (an adversarial finding: one stale done task was a master
 * key that held this gate open forever).
 */
export function stagedRefusal(stagedFiles, records) {
  const codeFiles = stagedFiles.filter(isCodePath);
  if (codeFiles.length === 0) return null;
  const inFlight = records.filter((r) => {
    const phase = stagedPhaseOf(r);
    return phase !== "done" && PHASE_ORDER.indexOf(phase) >= PHASE_ORDER.indexOf("executing");
  });
  if (inFlight.some((r) => recordRefusal(r) === null)) return null;
  // An in-flight record the record law refuses is NAMED with its reason: "no task is in flight"
  // while status lists one executing is a falsehood that sends the reader to the wrong fix.
  const refused = inFlight.map((r) => `${r.id} (${derivePhase(r.events ?? [])}): ${recordRefusal(r)}`);
  return { codeFiles, fenceSurface: codeFiles.some(fenceSurfacePath), refused };
}

/** Pure: a staged record's phase, or null when none derives (a null record, non-iterable events,
 *  a null event) — a malformed record simply is not in flight, so it neither holds the gate open
 *  nor crashes it (a review finding: deriving before the record law threw a stack trace). */
function stagedPhaseOf(record) {
  try {
    return derivePhase(record.events ?? []);
  } catch {
    return null;
  }
}

/** Pure: base resolution order — explicit argument, then local config, then the COMMITTED
 *  adoption base (`.stallion-base`, the one thing a CI clone can read, which is what makes the
 *  first push of a branch auditable), then the current branch's remote-tracking ref (a local
 *  convenience; CI checkouts are detached). null means unresolvable, and the caller REFUSES:
 *  the fence must never fail open on a first push.
 */
export function pickBase(explicit, config, committed, originCurrent) {
  if (explicit) return explicit;
  if (config) return config;
  if (committed) return committed;
  return originCurrent ?? null;
}

/** Pure: did the adoption base file change INSIDE the range it is about to judge? A baseline
 *  rewritten by the commits under audit is the smuggle: refuse it (an adversarial finding). */
export function baseMovedInRange(fileAtRangeStart, fileAtHead) {
  if (fileAtRangeStart === null || fileAtHead === null) return false;
  return fileAtRangeStart.trim() !== fileAtHead.trim();
}

/**
 * Pure: the moved-base law. A base move is audited EXACTLY ONCE, FROM THE OLD BASE — the
 * remote tip's copy of .stallion-base. null = this push may proceed; "old-base" = the move is
 * not being judged from the old base (no explicit base was supplied, or the supplied one is
 * not the old value). With no remote-tip anchor there is no accusation (visible skip, never a
 * silent brick: the base-commit fallback anchored on a commit that always predates the move).
 */
export function movedBaseVerdict(explicitBase, remoteTipBase, headBase) {
  if (remoteTipBase === null) return null;
  if (headBase === null) return "old-base"; // deleting the anchor is a move — never exempt
  if (!baseMovedInRange(remoteTipBase, headBase)) return null;
  if (typeof explicitBase === "string" && explicitBase.trim() === remoteTipBase.trim()) return null;
  return "old-base";
}

/**
 * Pure: lane count via the ENFORCEMENT parser — the doctor must never re-implement the format
 * (an adversarial finding: two dialects of one law drift apart silently).
 */
export function checklistLaneCount(text) {
  return typeof text === "string" ? lanesFromChecklist(text).length : 0;
}

/** Pure: a live (non-comment) line actually INVOKES a harness hook tool in the given MODE — the
 *  invocation must start the command (an `echo` mentioning the tool wires nothing), and the
 *  doctor must not certify itself (an adversarial finding: its own step line satisfied the
 *  CI-fence check, and a --staged-only hook passed as a pre-push fence). A hook mode also needs
 *  the verdict to REACH git: a hook without `set -e` runs on past a failed line and exits with its
 *  last command's status, so a bare line certifies only as that last command or while `set -e`
 *  is in force (a review finding: a pre-push whose fence line lost `|| exit 1` pushed while the fence printed
 *  'nothing was pushed', the doctor certifying it). "fence" is the CI mode: Actions runs a
 *  `run:` step under bash -e. An unknown mode certifies nothing — it once fell through to the
 *  bare fence, which is how a pre-push hook without --pre-push passed as wired (a review finding). */
export function invokesMode(text, mode) {
  const test = MODE_TESTS.get(mode);
  if (typeof text !== "string" || typeof test !== "function") return false;
  const raw = text.split("\n").filter((l) => l.trim().length > 0 && !l.trim().startsWith("#"));
  const live = raw.map((l) => l.trim());
  const errexit = errexitBefore(raw);
  const reachesGit = (inv, i) => mode === "fence" || inv.blocking || i === live.length - 1 || errexit[i];
  return live.some((line, i) => {
    const inv = hookInvocation(line);
    return inv !== null && test(inv) && reachesGit(inv, i);
  });
}

/** Pure: per live hook line (RAW, indentation kept), whether `set -e` is in force as it runs. Any
 *  `set` word carrying `+e` (or `+o errexit`) undoes it — turning errexit off is the fail-closed
 *  direction, so it needs no reading of where a command starts, and one that did missed `if set +e`,
 *  `! set +e` and `eval set +e` (review findings). `set -e` turns it on only at column 0 on a line
 *  the shell starts fresh — indented it may sit in a branch or a function that never runs (the
 *  trimmed read certified `if false; then\n  set -e\nfi`), and inside a quote or after a trailing
 *  `\` it is data (`echo "\nset -e\n"` certified; review findings). Options end at `--` (`set -- -e`
 *  sets $1). Stated residual: a heredoc body reads as shell, and an unindented set -e in a dead
 *  branch counts. gate-registry's errexitAt is a sibling reading, not this one: it has no
 *  trailing-`\` state. */
function errexitBefore(raw) {
  let [on, carried] = [false, null];
  return raw.map((line) => {
    const before = on;
    for (const m of line.matchAll(SET_COMMAND)) on = setsErrexit(m, carried) ?? on;
    carried = carriedState(line, carried);
    return before;
  });
}

/** A `set` word and its options, anywhere a word can stand. */
const SET_COMMAND = /(?<![\w./$-])set((?:[ \t]+[^\s;&|]+)*)/g;

/** One `set`'s effect on errexit: false, true, or null (none). `carried` is the line's start state. */
function setsErrexit(m, carried) {
  const options = ` ${m[1].split(/[ \t]--(?:[ \t]|$)/)[0]}`;
  if (/\s\+(?:[A-Za-z]*e|o[ \t]+errexit\b)/.test(options)) return false;
  return m.index === 0 && carried === null && /\s-(?:[A-Za-z]*e|o[ \t]+errexit\b)/.test(options) ? true : null;
}

/** Pure: what a hook line hands the next — the quote it leaves open, `\` when it ends in a
 *  continuation, or null. A `#` starting a word outside quotes ends the line (`# it's` opens
 *  nothing); `'` quotes to the next `'`, `"` honours backslash escapes (gate-registry's openQuote). */
function carriedState(line, carried) {
  let open = carried === "\\" ? null : carried;
  for (let i = 0; i < line.length && !startsComment(line, i, open); i += 1) {
    if (line[i] === "\\" && open !== "'") {
      if (i === line.length - 1) return open ?? "\\";
      i += 1;
    } else open = nextQuote(line[i], open);
  }
  return open;
}

/** Does a comment start at `i` — a `#` beginning a word outside quotes? */
const startsComment = (line, i, open) => open === null && line[i] === "#" && (i === 0 || /\s/.test(line[i - 1]));

/** The quote open after an unescaped character `c`. */
function nextQuote(c, open) {
  if (open === null) return "'\"".includes(c) ? c : null;
  return c === open ? null : open;
}

/** A harness hook tool's invocation: its arguments (words or quoted strings, `$VAR` included),
 *  then at most `|| exit N`. An ALLOWLIST — anything else after the arguments (`; exit 0`,
 *  `|| echo`, `&&`, a trailing `&`) runs past the verdict; the denylist of three swallow
 *  spellings it replaced certified those decoys (a review finding). */
const INVOCATION = /^node\s+tools\/(task-coverage|detached-head-guard)\.mjs((?:\s+(?:"[^"]*"|'[^']*'|[^\s"'`;&|<>()\\]+))*)\s*(?:\|\|\s*exit\s+(\d+))?$/;

/** One hook or CI line, normalized to the invocation it runs and its flags — or null when the
 *  line wires nothing: another command, a swallowed verdict, or a self-test run. `|| exit 0`
 *  swallows (an adversarial finding: it passed every wiring check), and so does any N sh folds to
 *  0 (`|| exit 256`); '|| exit 2' (the Claude Code translation) is a BLOCKING outcome and stays
 *  certified. An `sh -c '…'` wrapper's inner exit only sets the WRAPPER's status — in a hook file
 *  that line still has to be the last command or follow set -e (a review finding: a non-final
 *  wrapper certified as blocking while the hook ran on to exit 0). A --self-test line judges nothing
 *  either: it exits before any mode dispatch, so a fence swapped for one passed every push while
 *  the doctor certified it — matched in any spelling (`--self-test||exit 1`, a quoted flag),
 *  since a boundary-bound arm let those through (two review findings). */
function hookInvocation(line) {
  const step = line.replace(/^run:\s*/, "");
  const wrapped = /^sh\s+-c\s+(['"])(.*)\1$/.exec(step);
  const t = wrapped ? wrapped[2] : step;
  const m = INVOCATION.exec(t);
  if (m === null || /--self-test/.test(t) || Number(m[3]) % 256 === 0) return null;
  const args = m[2];
  return { tool: m[1], blocking: m[3] !== undefined && !wrapped, doctor: args.includes("--doctor"), staged: args.includes("--staged"), commitMsg: args.includes("--commit-msg"), prePush: /--pre-push(?![-\w])/.test(args), passesMessageFile: /\$1/.test(args) };
}

/** Each mode's test over a line's invocation. "fence" is the bare range check, with or without
 *  --base; "pre-push" is that check reading the pushed refs, which only --pre-push does. The
 *  commit-msg hook's ARGUMENT is the validated surface: git hands the message file as $1, and a
 *  decoy path (a committed file with a compliant footer) certifies nothing. */
const isCoverage = (f) => f.tool === "task-coverage";
const isBareFence = (f) => isCoverage(f) && !f.doctor && !f.staged && !f.commitMsg;
const MODE_TESTS = new Map([
  ["fence", isBareFence],
  ["pre-push", (f) => isBareFence(f) && f.prePush],
  ["doctor", (f) => isCoverage(f) && f.doctor],
  ["staged", (f) => isCoverage(f) && f.staged && !f.doctor],
  ["commit-msg", (f) => isCoverage(f) && f.commitMsg && !f.doctor && !f.staged && f.passesMessageFile],
  ["detached-head-guard", (f) => f.tool === "detached-head-guard"],
]);

/** Pure: count '## ' entry headings in the decisions register. */
export function registerHeadingCount(text) {
  return typeof text === "string" ? text.split("\n").filter((l) => l.startsWith("## ")).length : 0;
}

/** Pure: which self-testing tools the battery script never runs. The doctor derives the tool
 *  list from the tree, so a tool with a --self-test that the battery omits is a WIRING failure
 *  with a fix line — never the silent skip that let a vacuous adversarial-runner self-test ship
 *  through a green battery (issue #16). */
export function missingSelfTests(selftestScript, toolFiles) {
  if (typeof selftestScript !== "string") return [...(toolFiles ?? [])];
  return (toolFiles ?? []).filter((f) => !selftestScript.includes(`tools/${f} --self-test`));
}

/** Pure: does this file DISPATCH on --self-test (as opposed to merely mentioning it)? A review
 *  caught the first derivation blind to spelling: it matched only `.includes("--self-test")`,
 *  while task-gate.mjs dispatches via `a === "--self-test"` — so the very tool that prompted
 *  the law escaped it. A second review caught the equality arm too wide: `={2,3}` admitted
 *  loose `==` and the tail of `!==`, and a negated test is not a dispatch. The law is exactly
 *  the three idioms the tree spells — `.includes(...)`, `.indexOf(...)`, `===` — and a bare
 *  mention inside a string (bench/setup.mjs writes battery text into sandboxes) stays a
 *  non-member. */
export function dispatchesSelfTest(text) {
  if (typeof text !== "string") return false;
  return /\.(?:includes|indexOf)\(\s*["']--self-test["']\s*\)|===\s*["']--self-test["']/.test(text);
}

/** Pure: the script path a hook entry DISPATCHES — the arg (or command) that names the script.
 *  The judge hands THE DISPATCHED PATH to the caller's existence fact, never a basename
 *  re-derived against a fixed directory: that double agreed with the hook runtime on the
 *  happy path and diverged exactly on the re-pointed decoy, where the basename stayed on
 *  disk while the dispatch ENOENTed (an adversarial pass caught the mock-vs-live seam).
 *  null = the entry dispatches nothing for that script. */
const dispatchedScript = (hooks, script) => {
  for (const h of hooks ?? []) {
    for (const part of [h?.command, ...(h?.args ?? [])]) {
      if (typeof part === "string" && part.includes(script)) return part;
    }
  }
  return null;
};

/** Pure: is the ZCode plugin's authoring gate wired in its hooks manifest AND on disk? Issue
 *  #14's acceptance said "doctor sees it" and a review found the doctor only checked battery
 *  membership — a deleted or de-fanged hook registration passed. A second review caught the
 *  seam still half-wired: the manifest was judged but the SCRIPTS it dispatches were not.
 *  `scriptExists` receives the DISPATCHED path and answers whether it resolves on disk — the
 *  caller's fs fact (the judge stays pure, and refuses when called without it). Every clause
 *  runs before any pass: the banner law is judged even when the matcher is omitted (an early
 *  return on omission once let a deleted banner pass — caught twice in one adversarial pass).
 *  Returns null when wired, the reason when not. */
export function pluginWiringRefusal(manifest, scriptExists) {
  if (typeof scriptExists !== "function") return "the wiring judge was called without the script-existence fact — a gate that cannot read state must not pass";
  const need = ["Edit", "Write", "ApplyPatch"];
  let parsed;
  try {
    parsed = typeof manifest === "string" ? JSON.parse(manifest) : manifest;
  } catch (e) {
    return `the plugin's hooks.json does not parse: ${e.message}`;
  }
  const events = parsed?.hooks ?? {};
  if (!Array.isArray(events.PreToolUse) || events.PreToolUse.length === 0) return "the plugin registers no PreToolUse hook — the authoring gate is not wired";
  const pre = events.PreToolUse.find((entry) => dispatchedScript(entry?.hooks, "authoring-gate.mjs"));
  if (!pre) return "no PreToolUse hook invokes authoring-gate.mjs — the gate exists but nothing dispatches it";
  const gatePath = dispatchedScript(pre.hooks, "authoring-gate.mjs");
  if (!scriptExists(gatePath)) return `the manifest dispatches '${gatePath}' but that path resolves to nothing on disk — the gate is registered to fire at nothing`;
  for (const event of ["SessionStart", "UserPromptSubmit"]) {
    const entry = Array.isArray(events[event]) && events[event].find((e) => dispatchedScript(e?.hooks, "banner.mjs"));
    if (!entry) return `no ${event} hook invokes banner.mjs — the turn banner is not wired on that event`;
    const bannerPath = dispatchedScript(entry.hooks, "banner.mjs");
    if (!scriptExists(bannerPath)) return `the manifest dispatches '${bannerPath}' on ${event} but that path resolves to nothing on disk — the banner is registered to fire at nothing`;
  }
  if (pre.matcher === undefined) return null; // an omitted matcher matches everything — wired, and every clause above has already run
  let matcher;
  try {
    matcher = new RegExp(pre.matcher);
  } catch {
    return `the PreToolUse matcher is not a valid regular expression: ${String(pre.matcher)} — an invalid expression never matches, the gate never fires`;
  }
  const missed = need.filter((tool) => !matcher.test(tool));
  if (missed.length > 0) return `the PreToolUse matcher '${pre.matcher}' does not cover ${missed.join(", ")} — edits through those tool names escape the gate`;
  return null;
}

/**
 * Pure: the `task: <id>` footer — TRAILER-ANCHORED: only in the message's final trailer block, so a
 * quoted example or pasted log in the body cannot authorize a commit .
 */
export function taskFooterOf(message) {
  const trimmed = message.replace(/\s+$/, "");
  const lastParagraph = trimmed.split(/\n\s*\n/).pop() ?? "";
  if (!/^([\w-]+: .*\n?)+$/.test(lastParagraph)) return null;
  const m = /(?:^|\n)task: ([a-z0-9][a-z0-9-]*)\s*$/.exec(lastParagraph);
  return m ? m[1] : null;
}

/** One segment of a scope glob → one regex: `*` and `?` stay inside the segment, every other
 *  metacharacter is literal. Cached — fences and gates match many paths against few patterns. */
const segmentRegexCache = new Map();
function segmentRegExp(segment) {
  if (!segmentRegexCache.has(segment)) {
    const source = segment
      .replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" || ch === "?" ? ch : `\\${ch}`))
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
    segmentRegexCache.set(segment, new RegExp(`^${source}$`));
  }
  return segmentRegexCache.get(segment);
}

function segmentsMatch(patternSegs, pathSegs) {
  if (patternSegs.length === 0) return pathSegs.length === 0;
  const [head, ...rest] = patternSegs;
  if (head === "**") {
    // a whole `**` segment swallows zero or more path segments: tools/** covers tools/ itself
    for (let take = 0; take <= pathSegs.length; take += 1) {
      if (segmentsMatch(rest, pathSegs.slice(take))) return true;
    }
    return false;
  }
  if (pathSegs.length === 0) return false;
  return segmentRegExp(head).test(pathSegs[0]) && segmentsMatch(rest, pathSegs.slice(1));
}

/**
 * Pure: the scope glob dialect — repo-relative, whole-path matching (`tools/**` any depth,
 * `tools/*` one segment, `?` one char). ONE dialect for the commit-msg gate and the push fence:
 * the binding law cannot drift between the two transports that enforce it. No patterns match
 * nothing — a garbage pattern in a hand-edited record refuses code, never authorizes it.
 */
export function pathInScope(path, patterns) {
  if (typeof path !== "string" || !Array.isArray(patterns)) return false;
  const pathSegs = path.split("/");
  return patterns.some((p) => typeof p === "string" && segmentsMatch(p.split("/"), pathSegs));
}

/**
 * Pure: is this record excused from the scope law as genuinely pre-cutover? The timestamp is
 * client-authored plain JSON, so it is PARSED, not trusted lexicographically — an undated,
 * malformed, or offset-spelled stamp is NOT grandfathered (fail closed: the forge case is the
 * case that must not escape). Only a parseable instant strictly before the cutover excuses.
 */
export function isGrandfatheredScope(record) {
  const created = recordCreatedAt(record);
  // Strict UTC ISO form only: V8's lenient parser makes "0000" a valid year zero, so shape is
  // checked before parsing — real stamps come from toISOString() and always match.
  if (!STRICT_UTC_STAMP.test(created)) return false;
  const createdMs = Date.parse(created);
  return Number.isFinite(createdMs) && createdMs < Date.parse(SCOPE_LAW_CUTOVER);
}

/**
 * Pure: the scope law, shared verbatim by the commit-msg gate and the push fence (the
 * lanesFromChecklist discipline: the enforcement never re-implements the format). A task CREATED
 * after SCOPE_LAW_CUTOVER binds its code commits with a DECLARED blast radius: no usable scope,
 * or code outside it, refuses. The ADMISSION law (globRefusal) is re-applied on the judge path —
 * a hand-edited over-broad or malformed pattern matches NOTHING and the record fails closed, it
 * never authorizes. null = within the law; otherwise the reason names the files, the remedy the
 * exact command. The fence reads the record from the working tree at fence time (CI re-judges
 * from the pushed tree); a post-hoc widening is visible as a recorded amendment event in the
 * record's git history — in timestamped histories it trails the commit it excuses.
 */

/** The coverage half of the scope law: usable patterns, then every code file inside one. */
function scopeCoverageRefusal(record, codeFiles) {
  const declared = scopeOf(record);
  const patterns = declared.filter((p) => globRefusal(p) === null);
  const dropped = declared.length - patterns.length;
  if (patterns.length === 0) {
    const note = dropped > 0 ? ` (${dropped} recorded pattern(s) are malformed or over-broad and match nothing — fail closed)` : "";
    return {
      reason: `task '${record.id}' declares no usable scope${note} — a post-cutover task binds its code commits with declared blast radius, not a bearer footer`,
      remedy: `node tools/task-state.mjs scope ${record.id} --add "<glob>[,<glob>...]   (e.g. 'tools/**') — declare the blast radius the code will touch`,
    };
  }
  const outside = codeFiles.filter((f) => !pathInScope(f, patterns));
  if (outside.length > 0) {
    return {
      reason: `code outside task '${record.id}'s declared scope (${patterns.join(", ")}): ${outside.join(", ")}`,
      remedy: `widen the record (append-only, auditable): node tools/task-state.mjs scope ${record.id} --add "<the missing glob>"   — or move the change to the task that owns those files`,
    };
  }
  return null;
}

export function scopeRefusal(record, codeFiles, tierLawApplies = true) {
  if (!Array.isArray(codeFiles) || codeFiles.length === 0) return null;
  // Grandfathered records keep the law of their day; the tier law (fence-surface scope demands a
  // protected task with approval) is re-judged at BOTH transports through this seam — an
  // adversarial pass proved declaration-time-only enforcement was the escape. `tierLawApplies`
  // grandfathers commits that settled before the fence-side cutover (the mid-history-law cure);
  // the commit-msg gate always passes true.
  if (isGrandfatheredScope(record)) return null;
  const tier = tierLawApplies ? fenceSurfaceRefusal(record, scopeOf(record)) : null;
  if (tier) return tier;
  return scopeCoverageRefusal(record, codeFiles);
}

/**
 * Pure: the full citation law — one seam for the commit-msg gate and the push fence, so the two
 * transports cannot drift (an adversarial finding found exactly that drift shipped). For a NEW
 * commit, a finished task never authorizes code (the stale-done-master-key law the staged gate
 * already lives under). `isNewCommit` is the caller's transport fact: always true at commit-msg
 * time (the commit is being made NOW, against the working tree — deliberately the stricter
 * transport); at the fence it is judged against the SETTLED ANCHOR, the one input outside this
 * push, so a wave's own tail commits, written while the task was in flight, stay authorized
 * (see isNewCitation / anchorRecordPhase).
 */
export function citationRefusal(record, codeFiles, isNewCommit, tierLawApplies = true) {
  if (derivePhase(record.events ?? []) === "retired") {
    return {
      reason: `task '${record.id}' is retired — a retired task authorizes nothing, not even re-judged history (it never executed, so no commit ever lawfully cited it)`,
      remedy: `node tools/task-state.mjs new <new-id> --risk-class ${record.riskClass}   (the retirement's --because names the successor)`,
    };
  }
  if (isNewCommit && derivePhase(record.events ?? []) === "done") {
    return {
      reason: `task '${record.id}' is done — a finished task does not authorize new code`,
      remedy: `node tools/task-state.mjs new <new-id> --risk-class ${record.riskClass}   (done is terminal by design)`,
    };
  }
  return scopeRefusal(record, codeFiles, tierLawApplies);
}

function classRefusal(record) {
  if (!RISK_CLASSES.includes(record.riskClass)) return `unknown risk class: ${String(record.riskClass)} (hand-forged records refuse, they do not pass)`;
  if (IMPLEMENTATION_FORBIDDEN.has(record.riskClass)) return `risk class '${record.riskClass}' is implementation-forbidden`;
  if (APPROVAL_REQUIRED.has(record.riskClass)) {
    const approval = record.events?.find((e) => e.type === "approval");
    if (!approval) return `risk class '${record.riskClass}' carries no owner approval event`;
    if (!decisionHeadingExists(approval.decision)) {
      return `approval cites no decisions-register entry heading: ${String(approval.decision)}`;
    }
  }
  return null;
}

/** Pure: was this record's done transition stamped before the pin law existed? The stamp is
 *  client-authored plain JSON, so it is PARSED — malformed or missing is NOT grandfathered. */
function doneBeforePinLaw(events) {
  const doneAt = [...(events ?? [])].reverse().find((e) => e.type === "transition" && e.to === "done")?.at ?? "";
  const doneMs = Date.parse(doneAt);
  return Number.isFinite(doneMs) && STRICT_UTC_STAMP.test(doneAt) && doneMs < Date.parse(PIN_LAW_CUTOVER);
}

/** Pure: defense in depth — a DONE record that predates no pin law and carries no valid
 *  pin/exemption is a hand-edit or a forgery, and refuses at the fence. In-flight records are
 *  exempt: code commits land at executing, before the pin exists by design (verified is where
 *  pins bind). Records done before PIN_LAW_CUTOVER are grandfathered path-only evidence. */
function prePinLawDoneRefusal(record, phase) {
  if (phase !== "done" || hasValidPin(record) || hasPinExemption(record)) return null;
  if (!doneBeforePinLaw(record.events)) {
    return "done record carries no valid command pin (and no recorded exemption) — hand-edited records refuse at the fence";
  }
  return null;
}

/**
 * Pure: does this record authorize implementation? Returns null when yes, the violated law when no.
 * Fail-closed: a malformed record refuses rather than passes. `codeStaged` false (a footer on a
 * commit that stages no code) waives only the docs-only clause — a docs-only task may cite its
 * own docs commits, which the fence never judges (a review finding: the two transports
 * disagreed); every shape, class, and phase law still binds.
 */
export function recordRefusal(record, codeStaged = true) {
  if (!record || typeof record !== "object") return "record is not an object";
  if (record.schema !== "stallion/task-state@1") return `unknown schema: ${String(record?.schema)}`;
  const classLaw = classRefusal(record);
  if (classLaw) return classLaw;
  if (codeStaged && record.riskClass === "docs-only") return "risk class 'docs-only' writes docs, not code — a code change needs a runtime-code/protected/migration task";
  const phase = derivePhase(record.events ?? []);
  const pinLaw = prePinLawDoneRefusal(record, phase);
  if (pinLaw) return pinLaw;
  // The chain law, re-judged here because a hand-edited record must not sail through on the
  // append-time check alone (the same defense-in-depth as pin parity): a post-cutover record
  // with a broken or missing chain is tampering or a laundering attempt, and refuses.
  if (recordMustChain(record) && chainError(record.events ?? [])) {
    return `record chain broken or unadopted (chain law in force since ${CHAIN_CUTOVER}) — tamper-evident records refuse at the fence`;
  }
  const retireShape = retirementShapeRefusal(record.events ?? []);
  if (retireShape) return retireShape;
  if (phase === "retired") {
    return "task is 'retired' — a retired task authorizes nothing at the fence (the retirement's --because names the successor)";
  }
  if (PHASE_ORDER.indexOf(phase) < PHASE_ORDER.indexOf("executing")) {
    return `task is '${phase}' — code landed before the machine authorized executing`;
  }
  return null;
}

/**
 * Pure: the exact next command for a record recordRefusal refused — derived from the record in
 * recordRefusal's own order, so both transports print a fix that runs (a review finding: the
 * commonest refusal, a task still at planned, named no command at all). `codeStaged` is
 * recordRefusal's own: with no code staged the docs-only clause is waived, so a docs-only
 * refusal is a lifecycle one and its remedy must be too (a review finding).
 */
export function recordRemedy(record, id, codeStaged = true) {
  if (!record || record.schema !== "stallion/task-state@1") return restoreRemedy(id);
  if (classRefusal(record) || (codeStaged && record.riskClass === "docs-only")) return classRemedy(record, id);
  return lifecycleRemedy(record, id);
}

/** A hand-edited record is restored, never re-edited: the machine-written copy is in git. */
function restoreRemedy(id) {
  return `git log --oneline -- tasks/${id}.json   then: git checkout <last-machine-written-sha> -- tasks/${id}.json   (hand-edited records refuse; restore the one task-state wrote)`;
}

/** The class law's remedies: a class that never writes code needs a new task; a missing approval
 *  is recorded; an approval citing a vanished heading needs the register entry back. */
function classRemedy(record, id) {
  if (!APPROVAL_REQUIRED.has(record.riskClass)) return `node tools/task-state.mjs new <new-id> --risk-class runtime-code   (a '${String(record.riskClass)}' record never authorizes code)`;
  if (!record.events?.some((e) => e.type === "approval")) return `node tools/task-state.mjs approve ${id} --decision "<full ${DECISIONS_REL} entry heading, minus '## '>"`;
  return `restore the ${DECISIONS_REL} entry heading the approval cites (git log -p -- ${DECISIONS_REL}), or open a new approved task: node tools/task-state.mjs new <new-id> --risk-class ${record.riskClass}`;
}

/** The lifecycle's remedies, tamper first: a forged shape is restored, a retired task is
 *  succeeded, and a task short of executing advances one phase. */
function lifecycleRemedy(record, id) {
  const events = record.events ?? [];
  const phase = derivePhase(events);
  if (prePinLawDoneRefusal(record, phase) || (recordMustChain(record) && chainError(events)) || retirementShapeRefusal(events)) return restoreRemedy(id);
  if (phase === "retired") return `node tools/task-state.mjs new <new-id> --risk-class ${record.riskClass}   (a retired task authorizes nothing; its --because names the successor)`;
  return `node tools/task-state.mjs advance ${id} ${PHASE_ORDER[PHASE_ORDER.indexOf(phase) + 1]}   (one phase at a time to executing — code lands only once the machine authorized it)`;
}

/** Pure: the retirement's hand-forgery shapes. The command law refuses to append anything after
 *  a retired event (terminal) and refuses retirement past planned (a task with landed commits
 *  must finish honestly) — so a record carrying those shapes was written by hand, and the fence
 *  refuses it (fail closed, like every other shape law re-judged here). */
export function retirementShapeRefusal(events) {
  const list = events ?? [];
  const first = list.findIndex((e) => e?.type === "retired");
  if (first === -1) return null;
  if (list.length > first + 1) {
    return `an event follows the retired event at position ${first} — retired is terminal; a hand-edited record refuses`;
  }
  let phase = "intake";
  for (const e of list.slice(0, first)) if (e.type === "transition" && PHASE_ORDER.includes(e.to)) phase = e.to;
  if (PHASE_ORDER.indexOf(phase) > PHASE_ORDER.indexOf("planned")) {
    return `a retired event follows a '${phase}' transition — retirement is lawful only before executing; hand-edited records refuse`;
  }
  return null;
}


/** Pure: the docs/gates files that count as code for a commit given when it lands relative to the
 *  fence-surface cutover. Pre-cutover commits keep the classification of their day. */
export function fenceSurfaceFiles(files, preCutover) {
  return preCutover ? files.filter((f) => !f.startsWith("docs/gates/")) : files;
}

/** The commit where the fence-side TIER re-judgment took effect. The tier law itself
 *  (fence-surface scope demands a protected task with approval) is older at the declaration
 *  seam — but re-judging it at the push fence retroactively outlawed every settled commit whose
 *  record had lawfully declared .githooks/**, docs/**, or docs/gates/** under the first-segment
 *  law of its day (CI caught it live on the first push). Same cure as every mid-history law
 *  here: commits BEFORE this sha are judged under the old law, at and after under the new. */
export const FENCE_TIER_CUTOVER_COMMIT = "3bf3bac2b2b00fc1bd82c663faaf799a649a13b2";

function gitOut(...args) {
  // A staged diff or a history read past Node's 1 MiB default must not refuse as ENOBUFS.
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

/** A git path listing, read NUL-separated. Without -z git C-quotes any path holding a non-ASCII
 *  byte, '"', '\' or a control character ("tools/gat\303\251.mjs"), a spelling no code tree
 *  matched — footerless code crossed every transport (two review findings). core.quotePath=false
 *  alone still quotes the rest; -z is the one unambiguous form, placed before any pathspec. */
function gitPaths(subcommand, ...args) {
  return gitOut(subcommand, "-z", ...args).split("\0").filter(Boolean);
}

/** The staged paths as the fence will judge them — against HEAD, or `against` a merge parent.
 *  --no-renames: porcelain diff detects renames and lists only the destination, so moving code
 *  out of the code trees read as "no code staged" while the fence's plumbing saw the deletion (a
 *  review finding). */
function stagedPaths(...against) {
  return gitPaths("diff", "--cached", "--name-only", "--no-renames", ...against);
}

/** A commit's (or the index's) paths judged against each parent: `diffVs(rev)` lists where the tree
 *  differs from rev. A two-parent merge also carries `clean` — where it differs from git's own
 *  clean merge of the parents, plus every conflicted path — and, for the fallback law when git
 *  cannot merge them (before 2.38), each parent's changes since the merge base(s). No base (unrelated
 *  histories, a shallow clone) leaves changes null: every differing path is judged, the stricter
 *  reading. */
function mergeFacts(parents, diffVs) {
  const diffs = parents.map(diffVs);
  if (parents.length !== 2) return { diffs, changes: [], clean: null };
  let bases = [];
  try {
    bases = gitOut("merge-base", "--all", ...parents).split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    // no common ancestor git can see — every differing path is judged
  }
  if (bases.length === 0) return { diffs, changes: [null, null], clean: null };
  const merged = cleanMergeOf(parents);
  if (merged !== null) return { diffs, changes: [], clean: [...diffVs(merged.tree), ...merged.conflicted] };
  const since = (p) => [...new Set(bases.flatMap((b) => gitPaths("diff-tree", "--no-commit-id", "--name-only", "-r", "--no-renames", b, p)))];
  return { diffs, changes: parents.map(since), clean: null };
}

/** git's own merge of two parents: { tree, conflicted } — the tree it writes (conflict markers
 *  and all) and the paths it could not resolve — or null when git cannot say (no `merge-tree
 *  --write-tree` before 2.38): the caller falls back to the since-the-base law. */
function cleanMergeOf(parents) {
  const r = spawnSync("git", ["merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", ...parents], { cwd: ROOT, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  const [tree = "", ...conflicted] = String(r.stdout ?? "").split("\0").filter(Boolean);
  return (r.status === 0 || r.status === 1) && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(tree) ? { tree, conflicted } : null;
}

/**
 * Pure: the paths a commit ITSELF authors — one law for the fence and commit-msg. `parentDiffs[i]`:
 * where its tree differs from parent i. One parent: every differing path. A merge: a path
 * differing from EVERY parent (new content), plus `clean` when git could merge the two parents —
 * where the tree departs from git's own clean merge, and every conflicted path. What git merged
 * by itself is incoming, judged as each side's own commits; a side's STALE copy chosen over the
 * other side's change (a review finding: a footerless merge reverted fixed code through every
 * transport) departs from git's merge, and so does a side's change dropped. The fallback, with no
 * `clean`: `parentChanges[i]` — what parent i changed since the merge base(s), null when no base
 * resolves (every path counts as changed) — judges a path that DROPS such a change; it also
 * judged a side's change the other side already held (a cherry-pick), refusing a merge git wrote
 * untouched (a review finding), so it serves only where git cannot merge. An OCTOPUS answers for
 * everything it brings to its first parent: one base for three sides can predate a change one
 * side made after another forked, and a stale copy then passed as "unchanged since the base".
 */
export function mergeOwnFiles(parentDiffs, parentChanges, clean = null) {
  if (parentDiffs.length > 2) return [...new Set(parentDiffs[0])];
  const diffs = parentDiffs.map((d) => new Set(d));
  const differsFromEvery = (f) => diffs.every((d) => d.has(f));
  if (Array.isArray(clean)) return [...new Set([...parentDiffs.flat().filter(differsFromEvery), ...clean])];
  const changes = diffs.map((_, i) => (Array.isArray(parentChanges?.[i]) ? new Set(parentChanges[i]) : null));
  const dropsAChange = (f) => diffs.some((d, i) => d.has(f) && (changes[i] === null || changes[i].has(f)));
  return [...new Set(parentDiffs.flat())].filter((f) => differsFromEvery(f) || dropsAChange(f));
}

function revParseOk(rev) {
  try {
    execFileSync("git", ["rev-parse", "--verify", `${rev}^{commit}`], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitConfig(key) {
  try {
    return gitOut("config", "--get", key).trim() || null;
  } catch {
    return null;
  }
}

function currentBranch() {
  try {
    return gitOut("branch", "--show-current").trim();
  } catch {
    return "";
  }
}

/** The branch origin points at by default — the anchor for detached checkouts (CI), where
 *  branch --show-current is empty. */
function remoteHeadBranch() {
  try {
    const ref = gitOut("symbolic-ref", "--short", "refs/remotes/origin/HEAD").trim();
    return ref.startsWith("origin/") ? ref.slice("origin/".length) : "";
  } catch {
    return "";
  }
}

function rangeCount(base) {
  try {
    return Number(gitOut("rev-list", "--count", `${base}..HEAD`).trim());
  } catch {
    return -1; // a git failure is NOT an empty range — the caller must not coach a base change
  }
}

/** The committed content of a path (null when absent) — "committed" checks must read the tree
 *  git will serve to a fresh clone, not the working tree an adversarial pass caught certifying
 *  untracked hooks. */
function committedText(path) {
  try {
    return gitOut("show", `HEAD:${path}`);
  } catch {
    return null;
  }
}

function committedTextAt(rev, path) {
  try {
    return gitOut("show", `${rev}:${path}`);
  } catch {
    return null;
  }
}

/** The adoption-base pin as it actually passes every transport. .stallion-base is fence surface,
 *  so the pin commit sits inside the range it opens and needs a 'task:' footer from a protected,
 *  approved task scoped over it (a review finding: the bare commit this used to print was refused
 *  by the staged gate, commit-msg, and the fence alike). Every refusal that asks for a pin prints this one. */
export function pinBaseFix(rev) {
  const t = "node tools/task-state.mjs";
  return `${t} new <pin-id> --risk-class protected && ${t} approve <pin-id> --decision "<full ${DECISIONS_REL} entry heading>" && ${t} advance <pin-id> planned && ${t} scope <pin-id> --add .stallion-base && ${t} advance <pin-id> executing && git rev-parse ${rev} > .stallion-base && git add .stallion-base tasks/<pin-id>.json && git commit -m "chore: pin the stallion adoption base" -m "task: <pin-id>"`;
}

/** Pure: a committed .stallion-base value is one full 40-hex commit sha, nothing clever — null
 *  when it is, the refusal when not. */
export function adoptionBaseRefusal(value) {
  if (/^[0-9a-f]{40}$/.test(value)) return null;
  return `committed .stallion-base is malformed (expected one full 40-hex commit sha): ${JSON.stringify(String(value).slice(0, 60))}\n  rule: the adoption base is one full sha — a short or decorated value resolves to nothing an auditor can reproduce\n  fix: ${pinBaseFix("HEAD")}   (full sha, one line)`;
}

/**
 * The committed adoption base — travels with the clone, so CI (which cannot read a developer's
 *  local git config) still resolves a real range on the very first push of a branch. Strictly
 *  validated: one full 40-hex commit sha, nothing clever.
 */
function committedBase() {
  const text = committedText(".stallion-base");
  if (text === null) return null;
  const value = text.trim();
  const malformed = adoptionBaseRefusal(value);
  if (malformed) die(malformed);
  return value;
}

function loadRecord(id) {
  const path = `${STATE_DIR}/${id}.json`;
  if (!existsSync(path)) return { error: `no task record for '${id}' (expected ${path})` };
  try {
    return { record: JSON.parse(readFileSync(path, "utf8")) };
  } catch (e) {
    return { error: `task record '${id}' is not valid JSON: ${e.message}` };
  }
}

/**
 * Pure: does this citation need to answer the done-law? The record's phase comes from the
 * working tree; the ANCHOR PHASE is what the settled audit anchor (the explicit base, or
 * origin/<branch> — the one input outside this push) knew about the task; `commitSettled` says
 * the citing commit is at-or-behind the anchor (re-audited settled history, never accused).
 * A task the anchor already showed as DONE is finished settled work: a citing commit new since
 * that anchor is posthumous and refuses. A task first-landing at the anchor (or in flight
 * there) is landing in THIS push — its tail commits were written in flight and stay
 * authorized. No anchor skips the law (never a brick); an unreadable anchor copy fails closed.
 */
export function isNewCitation(recordPhase, anchorPhase, commitSettled) {
  if (recordPhase !== "done") return true;
  if (commitSettled) return false;
  if (anchorPhase === "settled-done" || anchorPhase === "unreadable") return true;
  return false; // first-landing, in-flight-there, no-anchor
}

/**
 * The task's phase as the settled audit anchor knows it. Presence is checked with ls-tree
 * (tree-only: survives shallow clones, where blobs of included trees are always present);
 * content is read with one git show. Never pickaxe — byte-coupled detectors break on
 * serialization (an adversarial finding proved the compact spelling matches nothing).
 */
function anchorRecordPhase(id, anchorRef) {
  if (!anchorRef) return "no-anchor";
  let listed;
  try {
    listed = gitOut("ls-tree", anchorRef, "--", `tasks/${id}.json`).trim();
  } catch {
    return "no-anchor";
  }
  if (listed === "") return "first-landing";
  try {
    const record = JSON.parse(gitOut("show", `${anchorRef}:tasks/${id}.json`));
    return derivePhase(record.events ?? []) === "done" ? "settled-done" : "in-flight-there";
  } catch {
    return "unreadable";
  }
}

/** The files a commit ITSELF introduces, as a list — one law for every commit shape:
 *  a ROOT answers against the empty tree (--root: plain diff-tree prints nothing for roots, so
 *  an orphan branch could land code no transport ever judged); a commit with ONE parent answers
 *  against it; a MERGE answers through mergeOwnFiles — what differs from every parent, plus where
 *  it departs from git's own merge of them (the stale-side reversion). Note: `-m
 *  --first-parent` proved to emit EACH-parent diffs, not the first-parent diff this code long
 *  claimed (git 2.43, isolated repro in issue #17) — it flagged every ordinary merge for the
 *  union of both sides' files, refusing legal merges of already-footered branches. */
function filesIntroducedBy(sha) {
  const parents = gitOut("show", "-s", "--format=%P", sha).trim().split(/\s+/).filter(Boolean);
  if (parents.length === 0) return gitPaths("diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha);
  const { diffs, changes, clean } = mergeFacts(parents, (p) => gitPaths("diff-tree", "--no-commit-id", "--name-only", "-r", "--no-renames", p, sha));
  return mergeOwnFiles(diffs, changes, clean);
}

/** The range check: every code commit in base..HEAD must carry an authorizing task footer. */
function checkRange(base, anchorRef = null) {
  const errors = [];
  const headSha = gitOut("rev-parse", "HEAD").trim();
  const commits = gitOut("rev-list", "--reverse", `${base}..HEAD`).trim().split("\n").filter(Boolean);
  const anchorPhaseCache = new Map();
  let anchorSkips = 0;
  for (const sha of commits) {
    const files = fenceSurfaceFiles(filesIntroducedBy(sha), commitPrecedes(sha, FENCE_SURFACE_CUTOVER_COMMIT));
    if (!files.some(isCodePath)) continue;
    const message = gitOut("log", "-1", "--format=%B", sha);
    const footer = taskFooterOf(message);
    const short = sha.slice(0, 8);
    if (!footer) {
      const fix = sha === headSha
        ? `git commit --amend --no-edit --trailer "task: <id>"`
        : `rebase to add the footer to ${short} (git rebase -i ${base}) or drop the code change — amend cannot reach a non-HEAD commit`;
      errors.push(`${short} touches code but carries no 'task: <id>' footer — future code is written only through the task-state lifecycle (task-state new)\n      fix: ${fix}`);
      continue;
    }
    const { record, error } = loadRecord(footer);
    if (error) { errors.push(`${short}: ${error}\n      fix: node tools/task-state.mjs new ${footer} --risk-class <class> && node tools/task-state.mjs advance ${footer} planned && node tools/task-state.mjs advance ${footer} executing`); continue; }
    const refusal = recordRefusal(record);
    if (refusal) { errors.push(`${short} (task ${footer}): ${refusal}\n      fix: ${recordRemedy(record, footer)}`); continue; }
    // The binding half of issue #8, through the ONE citation seam the commit-msg gate also
    // lives behind. The done-law is judged against the SETTLED ANCHOR (the one input outside
    // this push): a task the anchor already showed done refuses new citing commits, while a
    // task first-landing or in flight there authorizes its own tail. Commits at-or-behind the
    // anchor are re-audited settled history and are never accused. The named task's DECLARED
    // scope must cover every code file either way.
    let isNew = true;
    if (derivePhase(record.events ?? []) === "done") {
      const settled = Boolean(anchorRef) && isAncestorOrSelf(sha, anchorRef);
      const anchorPhase = anchorPhaseCache.get(footer) ?? anchorRecordPhase(footer, anchorRef);
      anchorPhaseCache.set(footer, anchorPhase);
      if (anchorPhase === "no-anchor" && !anchorRef) anchorSkips += 1;
      isNew = isNewCitation("done", anchorPhase, settled);
      if (anchorPhase === "unreadable" && !settled) {
        errors.push(`${short} (task ${footer}): the audit anchor's copy of the record is unreadable — a gate that cannot read state must not pass\n      fix: git fetch origin   (so the anchor's tasks/${footer}.json is readable), or push with an explicit --base <settled sha>`);
        continue;
      }
    }
    const citation = citationRefusal(record, files.filter(isCodePath), isNew, !commitPrecedes(sha, FENCE_TIER_CUTOVER_COMMIT));
    if (citation) { errors.push(`${short} (task ${footer}): ${citation.reason}\n      fix: ${citation.remedy}`); continue; }
  }
  if (anchorSkips > 0) console.log(`task-coverage: ~ done-citation law skipped for ${anchorSkips} citing commit(s) — no audit anchor resolvable (detached clone, no origin/<branch>); skip, never brick`);
  return errors;
}

/**
 * Pure: the refs a push carries that the HEAD-range fence cannot see. git hands the pre-push hook
 * one `<local-ref> <local-sha> <remote-ref> <remote-sha>` line per ref, and the range check judges
 * base..HEAD — so a pushed tip outside HEAD's history (`git push origin other-branch`, `--all`)
 * landed unjudged (a review finding). Deletions (an all-zero local sha) push no commits. The line
 * is parsed from the RIGHT: the local ref is the refspec's source expression verbatim, and git
 * allows spaces in it (`other^{/fix main bug}`), so a whitespace split read a word the pusher
 * chose as the sha — `main`, or `0` for a deletion — and the real tip went unjudged (a review
 * finding). A line that does not parse refuses, labelled as it arrived. Returns the refs to
 * refuse; `inHeadHistory(sha)` is the caller's git fact. Honest boundary: refusing is the whole
 * remedy — re-deriving each ref's own base and anchor is not attempted; push another branch
 * from its own checkout, where this fence judges it whole.
 */
export function unfencedPushTips(prePushInput, inHeadHistory) {
  return String(prePushInput ?? "").split("\n").filter((line) => line.trim().length > 0).flatMap((line) => {
    const m = /^(.+) ([0-9a-f]{40}|[0-9a-f]{64}) \S+ (?:[0-9a-f]{40}|[0-9a-f]{64})$/.exec(line);
    if (m === null) return [`unparseable ref line ${JSON.stringify(line)}`];
    return /^0+$/.test(m[2]) || inHeadHistory(m[2]) ? [] : [m[1]];
  });
}

/** The pre-push transport's extra fact: git's ref lines on stdin. Only the hook passes
 *  --pre-push, so CI and manual runs never block on a stdin nobody writes. */
function fencePushedRefs() {
  const outside = unfencedPushTips(readFileSync(0, "utf8"), (sha) => isAncestorOrSelf(sha, "HEAD"));
  if (outside.length > 0) {
    die(`✖ REFUSED — this push carries ref(s) outside the checked-out history: ${outside.join(", ")}\n  rule: the push fence judges base..HEAD — a pushed tip HEAD cannot reach would land unjudged, and a ref line it cannot parse refuses rather than guess\n  fix: git checkout <branch> && git push origin <branch>   (one branch per push, from its own checkout, so the fence judges it whole)`);
  }
}

function die(message) {
  console.error(`task-coverage: ${message}`);
  process.exit(1);
}

/**
 * The inner gate: code staged but no task at executing-or-later refuses BEFORE the commit is
 * made. Wire as a pre-commit hook, or as a Claude Code PreToolUse hook on Bash(git commit*) —
 * with the exit-code translation that vendor's contract requires (see docs/WIRING.md).
 */
function cmdStaged() {
  let files;
  try {
    files = stagedPaths();
  } catch (e) {
    die(`cannot read the staged file list — git diff --cached failed (${String(e.message).split("\n")[0]})\n  rule: a gate that cannot read state must not pass — this seam fails closed like every other\n  fix: make git work in this environment (PATH, safe.directory, readable index), then retry the commit`);
  }
  const records = [];
  if (existsSync(STATE_DIR)) {
    for (const f of readdirSync(STATE_DIR).filter((x) => x.endsWith(".json") && !x.includes(".findings."))) {
      try {
        records.push(JSON.parse(readFileSync(`${STATE_DIR}/${f}`, "utf8")));
      } catch {
        // a malformed record cannot authorize anything — it simply is not an active task
      }
    }
  }
  const refusal = stagedRefusal(files, records);
  if (!refusal) {
    const stagedCode = files.filter(isCodePath).length;
    return console.log(stagedCode === 0
      ? "task-coverage (staged): no code files staged."
      : `task-coverage (staged): ${stagedCode} code file(s) staged while a task is in flight (executing/verified/adversarial).`);
  }
  console.error(`task-coverage: ✖ REFUSED — code is staged but no in-flight task (executing/verified/adversarial) authorizes code`);
  console.error(`  rule: implementation happens only under a task the machine has authorized`);
  console.error(`  evidence: ${refusal.codeFiles.join(", ")}`);
  console.error(`  evidence: ${refusedEvidence(refusal.refused)}`);
  const t = "node tools/task-state.mjs";
  const fix = refusal.fenceSurface
    ? `${t} new <id> --risk-class protected && ${t} approve <id> --decision "<full ${DECISIONS_REL} entry heading>" && ${t} advance <id> planned && ${t} scope <id> --add "<the fence-surface paths>" && ${t} advance <id> executing   (fence surface is protected-tier)`
    : `${t} new <id> --risk-class runtime-code && ${t} advance <id> planned && ${t} advance <id> executing`;
  die(`  fix: ${fix}\n      (existing tasks: ${t} status)`);
}

/** The staged refusal's second evidence line: which in-flight records the record law refused, or
 *  that none is in flight at all. */
function refusedEvidence(refused) {
  return refused.length > 0 ? `in flight but refused by the record law — ${refused.join(" | ")}` : "no record is executing, verified, or adversarial";
}

/** Secret/`debugger` patterns for the staged scan (ECC's pre-bash-commit-quality, adapted):
 *  literal shapes first (prefixes are structural), then a narrow key=value shape with a
 *  placeholder whitelist — a scan that fires on "your_api_key_here" is a scan people disable. */
const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/, "Anthropic API key"],
  [/ghp_[A-Za-z0-9]{30,}/, "GitHub PAT"],
  [/gho_[A-Za-z0-9]{30,}/, "GitHub OAuth token"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key id"],
  [/sk-[A-Za-z0-9]{20,}/, "generic API key"],
];
/** Placeholder BODIES (the part after the structural prefix): the whitelist an adversarial
 *  pass proved was dead code in its ^-over-m[0] form — no placeholder is a prefix of sk-ant-.
 *  The body test makes redacted fixtures (sk-ant-XXXX…) pass while real keys refuse. */
const PLACEHOLDER_BODY = /^(?:[xX0*]{4,}|your|example|test|dummy|sample|changeme|redacted|placeholder|<[^>]*>|\$\{)/;

/**
 * Pure: scan ADDED diff lines for secrets and stray debugger statements. Returns null when
 * clean, or { reason } naming file, line, and what matched — the refusal an agent can act on.
 */
export function stagedScanRefusal(addedLines) {
  for (const { file, line, text } of addedLines ?? []) {
    for (const [pattern, name] of SECRET_PATTERNS) {
      const m = pattern.exec(text);
      const body = m ? m[0].replace(/^(?:sk-ant-|ghp_|gho_|AKIA|sk-)/i, "") : "";
      if (m && !PLACEHOLDER_BODY.test(body)) {
        return { reason: `staged content carries a ${name} at ${file}:${line} — secrets do not land in git; rotate the key and read it from the environment` };
      }
    }
    if (/^\s*debugger;?\s*$/.test(text)) {
      return { reason: `staged content carries a debugger statement at ${file}:${line} — remove it before committing` };
    }
  }
  return null;
}

/** Added diff lines as {file, line, text}, tracking hunk headers — the scan's input.
 *  Exported: an adversarial pass caught the doubles-without-adapter gap (the pure scan was
 *  pinned while the parser that feeds it had no test callers at all). */
export function addedDiffLines(diffText) {
  const out = [];
  let file = "";
  let line = 0;
  for (const raw of String(diffText ?? "").split("\n")) {
    const m = /^diff --git a\/(.*) b\/(.*)$/.exec(raw);
    if (m) { file = m[2]; continue; }
    const h = /^@@ -(?:\d+)(?:,\d+)? \+(\d+)/.exec(raw);
    if (h) { line = Number(h[1]); continue; }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      out.push({ file, line, text: raw.slice(1) });
      line += 1;
    } else if (!raw.startsWith("-")) {
      line += 1;
    }
  }
  return out;
}

/**
 * Pure: git's default commit-msg cleanup, applied before the footer is read. git runs the hook
 * BEFORE it strips comments, so an editor-composed message still ends in the '# Please enter…'
 * block (and, under -v, a scissors line and the diff) — read raw, that block was the last
 * paragraph and every editor-written footer refused (a review finding). The push fence reads
 * messages git already cleaned. Honest boundary: '#' only — a custom core.commentChar keeps its
 * lines here, and the fence re-judges the committed message (fail closed, never open).
 */
export function cleanCommitMessage(message) {
  return cutAtScissors(message).split("\n").filter((line) => !line.startsWith("#")).join("\n");
}

/** Pure: the message above git's scissors line — everything below it git never commits. */
function cutAtScissors(message) {
  const scissors = message.search(/^# -+ >8 -+$/m);
  return scissors === -1 ? message : message.slice(0, scissors);
}

/** Pure: the cleanup git will apply to the message it commits — "strip" (cut at the scissors line,
 *  drop '#' lines), "scissors" (cut, KEEP '#' lines), or "raw". Its default is 'strip' only when
 *  an editor ran — for -m/-F it is 'whitespace', which keeps '#' lines (git tells the hook by
 *  setting GIT_EDITOR=:) — and commit.cleanup overrides both; 'scissors' without an editor is
 *  'whitespace'. Stripping regardless passed a footer followed by a '#…' paragraph that the fence,
 *  reading the committed message, refused; reading scissors raw made git's template the last
 *  paragraph and refused every editor-written footer (two review findings). Honest boundary: a
 *  `--cleanup=` on the command line never reaches the hook — with an editor, `--cleanup=whitespace`
 *  or `verbatim` is read stripped here while git keeps its '#' template, and only the fence, which
 *  judges the committed message, refuses it. */
export function gitCleanupMode(editorUsed, cleanup) {
  if (cleanup === "strip") return "strip";
  if (cleanup === "scissors") return editorUsed === true ? "scissors" : "raw";
  if (cleanup && cleanup !== "default") return "raw";
  return editorUsed === true ? "strip" : "raw";
}

/** Pure: the message as git will commit it, under `gitCleanupMode`'s reading. */
const CLEANUPS = { strip: cleanCommitMessage, scissors: cutAtScissors, raw: (message) => message };

/** The refused commit was never made: its fix re-runs it from the message git saved. -v makes git
 *  cut that message at a verbose editor's scissors line — strip alone kept the diff tail, whose
 *  last paragraph the fence then read as footerless (a review finding). The strip cleanup rides
 *  in as `-c commit.cleanup=strip`, config git hands down to this hook, so the hook reads the
 *  re-run exactly as git will clean it (a --cleanup flag never reaches the hook). */
function reRunCommit(messageFile) {
  return `git -c commit.cleanup=strip commit -F ${messageFile} -v`;
}

/**
 * Pure: the commit-msg law, one seam the self-test drives end to end — the transport only
 * gathers git's facts. `facts`: { message, messageFile, files, mergeParents, editorUsed, cleanup,
 * addedLines, load } — `mergeParents` is null outside a merge, else mergeFacts over the parents
 * git will record, so a merge is judged by the fence's own law. Returns { refusal } (evidence,
 * rule, fix) or { ok } (the pass line). The staged scan runs FIRST, on every commit: a footerless
 * commit staging only .env or a config file is exactly where keys land (a review finding: the
 * scan once ran only after a footer had passed).
 */
export function commitMsgVerdict(facts) {
  const scan = stagedScanRefusal(facts.addedLines);
  if (scan) return { refusal: `✖ REFUSED — ${scan.reason}\n  rule: secrets and debugger statements do not land in git — every commit's staged diff is scanned\n  fix: remove the named line, git add the file, then re-run the commit: ${reRunCommit(facts.messageFile)}` };
  const codeFiles = (facts.mergeParents ? mergeOwnFiles(facts.mergeParents.diffs, facts.mergeParents.changes, facts.mergeParents.clean) : facts.files).filter(isCodePath);
  const footer = taskFooterOf(CLEANUPS[gitCleanupMode(facts.editorUsed, facts.cleanup)](facts.message));
  if (!footer) return footerlessVerdict(codeFiles, facts.messageFile);
  const { record, error } = facts.load(footer);
  if (error) {
    return { refusal: `✖ REFUSED — ${error}\n  rule: a footer names a task record this machine wrote\n  fix: node tools/task-state.mjs new ${footer} --risk-class <class> && node tools/task-state.mjs advance ${footer} planned && node tools/task-state.mjs advance ${footer} executing   (or correct the footer in ${facts.messageFile} and re-run: ${reRunCommit(facts.messageFile)})` };
  }
  return citedVerdict(record, footer, codeFiles);
}

/** A message with no footer: lawful only when no code is staged. The fix re-runs the refused
 *  commit — it was never made, so amending would fold the code into the PREVIOUS commit (a
 *  review finding: the printed fix rewrote a pushed commit). */
function footerlessVerdict(codeFiles, messageFile) {
  if (codeFiles.length === 0) return { ok: "task-coverage (commit-msg): no code staged — no task footer required." };
  const sample = codeFiles.slice(0, 3).join(", ") + (codeFiles.length > 3 ? ", …" : "");
  return { refusal: `✖ REFUSED — this commit stages code (${codeFiles.length} file(s): ${sample}) but the message carries no 'task: <id>' footer\n  rule: code lands only under a task this machine can name, within that task's declared scope\n  fix: ${reRunCommit(messageFile)} --trailer "task: <id>"   (re-run the refused commit with the footer; existing tasks: node tools/task-state.mjs status)` };
}

/** A footer naming a real record: the record and citation laws. */
function citedVerdict(record, footer, codeFiles) {
  const codeStaged = codeFiles.length > 0;
  const refusal = recordRefusal(record, codeStaged);
  if (refusal) return { refusal: `✖ REFUSED — task '${footer}' does not authorize this commit: ${refusal}\n  rule: a footer cites a task at executing or later whose class may write what is staged and whose record the machine wrote\n  fix: ${recordRemedy(record, footer, codeStaged)}` };
  const citation = citationRefusal(record, codeFiles, true);
  if (citation) return { refusal: `✖ REFUSED — ${citation.reason}\n  rule: a citation binds code to the cited task's declared scope, and a finished or retired task authorizes nothing new\n  fix: ${citation.remedy}` };
  return { ok: codeFiles.length === 0
    ? `task-coverage (commit-msg): footer cites in-flight task '${footer}' (no code staged).`
    : `task-coverage (commit-msg): ${codeFiles.length} code file(s) bound to in-flight task '${footer}' within its declared scope.` };
}

/** A file in the git dir (MERGE_HEAD, MERGE_MODE), as an absolute path. */
function gitDirFile(name) {
  const path = gitOut("rev-parse", "--git-path", name).trim();
  return path.startsWith("/") ? path : `${ROOT}${path}`;
}

/** The parents git will record for the commit being made — HEAD, then MERGE_HEAD's shas (one per
 *  line; several for an octopus), REDUCED as git reduces them (a parent another parent contains
 *  is dropped) unless MERGE_MODE is exactly 'no-ff'; null outside a merge. Taking MERGE_HEAD at
 *  its word judged a hand-written ancestor as a parent while git recorded an ordinary commit the
 *  fence then refused (a review finding). */
function pendingParents() {
  const mergeHead = gitDirFile("MERGE_HEAD");
  if (!existsSync(mergeHead)) return null;
  const heads = [gitOut("rev-parse", "HEAD").trim(), ...readFileSync(mergeHead, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)];
  const mergeMode = gitDirFile("MERGE_MODE");
  if (existsSync(mergeMode) && readFileSync(mergeMode, "utf8") === "no-ff") return heads;
  return gitOut("merge-base", "--independent", ...heads).split("\n").map((l) => l.trim()).filter(Boolean);
}

/** The merge law's facts for the commit being made — null outside a merge. A git failure narrows
 *  nothing: null again, and every staged file is judged, the stricter reading. */
function pendingMergeFacts() {
  try {
    const parents = pendingParents();
    return parents === null ? null : mergeFacts(parents, (p) => stagedPaths(p));
  } catch {
    return null;
  }
}

/**
 * The binding gate (issue #8): at commit-msg time the `task:` footer must name a REAL, IN-FLIGHT
 * task whose DECLARED scope covers the staged code. The refusal lands within one action of the
 * mistake; the push fence re-judges the same law from the pushed tree (a local hook is a
 * convenience — the fence is the control). Wire as a commit-msg hook:
 *   node tools/task-coverage.mjs --commit-msg "$1"
 */
function cmdCommitMsg(messageFile) {
  if (typeof messageFile !== "string" || messageFile.length === 0) {
    die(`--commit-msg requires the message file git passes the hook (usage: --commit-msg <file>, hook form: node tools/task-coverage.mjs --commit-msg "$1")`);
  }
  if (!existsSync(messageFile) && !existsSync(`${ROOT}${messageFile.replace(/^\//, "")}`)) {
    die(`cannot read the commit message file: ${messageFile}\n  rule: a gate that cannot read state must not pass\n  fix: this runs as a commit-msg hook — check core.hooksPath (.githooks) and that the hook passes "$1" through`);
  }
  const message = readFileSync(existsSync(messageFile) ? messageFile : `${ROOT}${messageFile.replace(/^\//, "")}`, "utf8");
  let files;
  try {
    files = stagedPaths();
  } catch (e) {
    die(`cannot read the staged file list — git diff --cached failed (${String(e.message).split("\n")[0]})\n  rule: a gate that cannot read state must not pass\n  fix: make git work in this environment (PATH, safe.directory, readable index), then retry the commit`);
  }
  let cachedDiff = "";
  try {
    // Config-neutral on purpose: repo-local color.ui AND the more specific color.diff slot
    // both lace the output (a sweep proved color.ui=never alone does not override
    // color.diff=always); external diff drivers and textconv blank or rewrite it entirely.
    cachedDiff = gitOut("-c", "color.ui=never", "-c", "color.diff=never", "-c", "diff.noprefix=false", "-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--cached");
  } catch (e) {
    die(`cannot read the staged diff — git diff --cached failed (${String(e.message).split("\n")[0]})\n  rule: a gate that cannot read state must not pass`);
  }
  // git sets GIT_EDITOR=: for the hook when no editor ran — the fact its cleanup default turns on.
  const verdict = commitMsgVerdict({ message, messageFile, files, mergeParents: pendingMergeFacts(), editorUsed: process.env.GIT_EDITOR !== ":", cleanup: gitConfig("commit.cleanup"), addedLines: addedDiffLines(cachedDiff), load: loadRecord });
  if (verdict.refusal) die(verdict.refusal);
  console.log(verdict.ok);
}

/**
 * The gate for the gate: prove the fence is WIRED in this clone, not just present in the repo.
 * Fail-closed on everything a clone can observe; the one clone-local setting CI cannot carry
 * (core.hooksPath) is scoped to local runs.
 */

/**
 * The gates-family law (2026-09-20 merge wave): every gate config under docs/gates/ must parse,
 * and the directory must not be empty — one derived check for the whole ported-gate family, the
 * same law as the battery derivation. Each gate tool fail-closes on its own config's SEMANTICS
 * (shape, honesty against the tree); the doctor catches the cheaper, earlier failure: a corrupted
 * or vanished JSON the gates would each have to rediscover. Kept out of cmdDoctor so neither the
 * doctor nor this helper crosses the complexity ratchet the wave itself installed.
 */
function gatesFamilyRefusal() {
  const gatesDir = `${ROOT}docs/gates`;
  try {
    const gateConfigs = readdirSync(gatesDir).filter((f) => f.endsWith(".json"));
    if (gateConfigs.length === 0) return "docs/gates/ holds no gate configs — the ported gates read their repo data from there (see docs/WIRING.md §the gates)";
    for (const f of gateConfigs) {
      try {
        JSON.parse(readFileSync(`${gatesDir}/${f}`, "utf8"));
      } catch (e) {
        return `docs/gates/${f} does not parse: ${e.message}`;
      }
    }
    return null;
  } catch (e) {
    return `docs/gates/ is unreadable: ${String(e.message).split("\n")[0]}`;
  }
}

/**
 * The battery's enforcement outside the battery: package.json carries `npm run selftest` yet is
 * NOT fence surface (it is every vendor's product manifest — a protected task per dependency bump
 * is out of proportion), so a footerless commit can drop or swallow a declared battery gate. The
 * doctor runs where the gated party cannot reach (pre-push and CI, both fence surface) and re-runs
 * the registry's both-direction check there. Returns null, or { evidence, fix }: the registry's own
 * lines, or — none vendored — one line and the vendoring fix (a loader stack trace under a
 * package.json fix was that refusal, and nothing pinned it; a review finding).
 */
function gateRegistryRefusal() {
  if (!existsSync(`${ROOT}tools/gate-registry.mjs`)) {
    return { evidence: "tools/gate-registry.mjs is absent — the battery (package.json) runs unguarded", fix: "vendor tools/gate-registry.mjs and docs/gates/gate-registry.json from stallion (docs/WIRING.md §11), then re-run: node tools/gate-registry.mjs" };
  }
  try {
    execFileSync(process.execPath, ["tools/gate-registry.mjs"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return null;
  } catch (e) {
    const lines = `${e.stdout ?? ""}${e.stderr ?? ""}`.split("\n").filter((l) => l.trim().length > 0);
    return { evidence: lines.length > 0 ? lines.join("\n    ") : String(e.message).split("\n")[0], fix: "bring the transports back to docs/gates/gate-registry.json — restore every declared battery gate to package.json's selftest script as one clean && chain (git log -p -- package.json names the commit that dropped it) — then re-run: node tools/gate-registry.mjs" };
  }
}

function cmdDoctor() {
  const results = [];
  const check = (name, ok, fix, evidence = null) => results.push({ name, ok, fix, evidence });

  // Wiring checks read the COMMITTED tree and demand the right MODE per transport: the bare
  // fence for CI, --pre-push for the pre-push hook (the pushed-refs law runs only under it), the
  // staged gate AND the detached-head guard for pre-commit (the hook is the guard's only live
  // run) — the doctor's own step line must not be able to certify the doctor.
  const committedPrePush = committedText(".githooks/pre-push") ?? "";
  const committedPreCommit = committedText(".githooks/pre-commit") ?? "";
  const committedCommitMsg = committedText(".githooks/commit-msg") ?? "";
  check("pre-push hook committed and invoking the push fence", invokesMode(committedPrePush, "pre-push"), "commit .githooks/pre-push that runs 'node tools/task-coverage.mjs --pre-push || exit 1' (docs/WIRING.md)");
  check("pre-commit staged gate committed", invokesMode(committedPreCommit, "staged"), "commit .githooks/pre-commit that runs 'node tools/task-coverage.mjs --staged || exit 1'");
  check("pre-commit detached-head guard committed", invokesMode(committedPreCommit, "detached-head-guard"), "commit .githooks/pre-commit that also runs 'node tools/detached-head-guard.mjs || exit 1' (docs/WIRING.md §5)");
  check("commit-msg binding gate committed", invokesMode(committedCommitMsg, "commit-msg"), "commit .githooks/commit-msg that runs 'node tools/task-coverage.mjs --commit-msg \"$1\" || exit 1' (docs/WIRING.md)");

  // Activation is clone-local config CI cannot carry — scoped honestly instead of faked:
  // locally it is checked for real (and value-checked, not just set); in CI it is SKIPPED,
  // visibly, never silently passed.
  const hooksPath = gitConfig("core.hooksPath");
  if (process.env.CI === "true") {
    console.log("task-coverage doctor: ~ core.hooksPath activation — not observable in a CI clone (clone-local config); enforced by local doctor runs and the push fence");
  } else {
    const dir = hooksPath && hooksPath.startsWith("/") ? hooksPath.replace(/\/$/, "") : hooksPath ? `${ROOT}${hooksPath.replace(/^\//, "").replace(/\/$/, "")}` : null;
    const livePrePush = dir && existsSync(`${dir}/pre-push`) ? readFileSync(`${dir}/pre-push`, "utf8") : "";
    const livePreCommit = dir && existsSync(`${dir}/pre-commit`) ? readFileSync(`${dir}/pre-commit`, "utf8") : "";
    const liveCommitMsg = dir && existsSync(`${dir}/commit-msg`) ? readFileSync(`${dir}/commit-msg`, "utf8") : "";
    check("core.hooksPath points at a wired pre-push", invokesMode(livePrePush, "pre-push"), "git config core.hooksPath .githooks   (must point at the committed hooks)");
    check("core.hooksPath points at a wired pre-commit", invokesMode(livePreCommit, "staged"), "git config core.hooksPath .githooks");
    check("core.hooksPath points at a pre-commit running the detached-head guard", invokesMode(livePreCommit, "detached-head-guard"), "git config core.hooksPath .githooks   (the committed pre-commit runs the guard)");
    check("core.hooksPath points at a wired commit-msg", invokesMode(liveCommitMsg, "commit-msg"), "git config core.hooksPath .githooks");
  }

  const committedWorkflows = (() => {
    try {
      return gitPaths("ls-files", ".github/workflows").filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    } catch {
      return []; // git that cannot list the committed tree cannot show it either — the CI check fails closed
    }
  })();
  let selftestScript = "";
  try {
    selftestScript = JSON.parse(committedText("package.json") ?? "{}")?.scripts?.selftest ?? "";
  } catch {
    selftestScript = "";
  }
  // The tool list is DERIVED from the tree (every tools/**/*.mjs that offers a --self-test,
  // searched RECURSIVELY — nested members like bench/grade.mjs and zcode-plugin/lib/gate-law.mjs
  // are battery members too), so the check cannot go stale when a new tool appears anywhere
  // under tools/: the battery must run them all. An UNREADABLE tools directory fails the
  // check — a gate that cannot read state must not pass (the same law the staged gate lives
  // under), never an empty-list vacuous pass.
  let toolsListingError = null;
  const selfTestingTools = (() => {
    const found = [];
    const walk = (abs, rel) => {
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(`${abs}/${entry.name}`, entryRel);
        // Membership is the ENTRY law, not a mention: the file must DISPATCH on --self-test,
        // in any of the dispatch idioms (`.includes("--self-test")`, `=== "--self-test"`,
        // indexOf). A mere mention is a lie in the tree — bench/setup.mjs writes battery
        // strings into sandboxes; and a review caught the single-idiom form blind to
        // task-gate.mjs's `===` spelling, leaving the law unenforceable for its own tool.
        // Membership derivation reads STRIPPED source — a comment naming the dispatch idiom is a
        // mention, not a dispatch (the twice-in-one-day incident class test-lint exists for; its
        // first act on landing here was catching this exact read unstripped).
        else if (entry.name.endsWith(".mjs") && dispatchesSelfTest(stripComments(readFileSync(`${abs}/${entry.name}`, "utf8")))) found.push(entryRel);
      }
    };
    try {
      walk(`${ROOT}tools`, "");
      return found;
    } catch (e) {
      toolsListingError = String(e.message).split("\n")[0];
      return null;
    }
  })();
  const notRun = selfTestingTools === null ? null : missingSelfTests(selftestScript, selfTestingTools);
  check(
    "the selftest battery runs every self-testing tool in tools/",
    notRun !== null && notRun.length === 0,
    notRun !== null && notRun.length > 0
      ? `add to the selftest SCRIPT in package.json: ${notRun.map((f) => `node tools/${f} --self-test`).join(" && ")} — a self-test the battery never runs is a silent skip (issue #16)`
      : `cannot list tools/ to derive the battery's members (${toolsListingError}) — a gate that cannot read state must not pass`,
  );

  // Issue #14's acceptance, closed late by the review: "doctor sees it." The battery proves the
  // gate's LAW runs; this proves the gate's WIRING exists — a deleted or de-fanged hook
  // registration (matcher that covers no edit tool, missing banner event, unparseable manifest)
  // refuses here, not at the first silently-ungated edit; and the paths the manifest dispatches
  // must resolve — registered-to-fire-at-nothing is not wired (a second review caught that half
  // unwired; an adversarial lane caught the existence fact judging a basename against a fixed
  // directory, so it now resolves THE DISPATCHED PATH through the manifest's own
  // ${ZCODE_PLUGIN_ROOT} variable, failing closed on spellings it cannot answer). Like every
  // other wiring check here, it reads the COMMITTED tree — the doctor is the only transport
  // that judges plugin wiring, and a de-fanged manifest committed with the working tree
  // restored must not certify (the same smuggle the hooks/CI checks above refuse).
  const PLUGIN_ROOT_VAR = "${ZCODE_PLUGIN_ROOT}/";
  const committedPluginBase = "tools/zcode-plugin";
  const committedManifest = committedText(`${committedPluginBase}/hooks/hooks.json`);
  const committedDispatchResolves = (dispatched) => typeof dispatched === "string" && dispatched.startsWith(PLUGIN_ROOT_VAR) && committedText(`${committedPluginBase}/${dispatched.slice(PLUGIN_ROOT_VAR.length)}`) !== null;
  const wiringRefusal = committedManifest === null
    ? `${committedPluginBase}/hooks/hooks.json is not in the committed tree — the enforcement plugin's wiring certifies nothing a clone will receive while its law is still a battery member`
    : pluginWiringRefusal(committedManifest, committedDispatchResolves);
  check("the enforcement plugin's authoring gate is wired and its scripts on disk", wiringRefusal === null, `restore the committed manifest: git log --oneline -- ${committedPluginBase}/hooks/hooks.json   then: git checkout <last-good-sha> -- ${committedPluginBase}/hooks/hooks.json && git commit   (or repair it until every edit tool and banner event dispatches a script on disk)`, wiringRefusal);

  const ciOk = committedWorkflows.some((f) => invokesMode(committedText(f) ?? "", "fence"));
  check("CI re-runs the push fence", ciOk, "add a bare 'node tools/task-coverage.mjs' step to .github/workflows (docs/WIRING.md) and commit it");

  // THE GATES FAMILY (2026-09-20 merge wave) — see gatesFamilyRefusal for the law.
  const gatesConfigRefusal = gatesFamilyRefusal();
  check("every gate config under docs/gates/ parses", gatesConfigRefusal === null, "repair the named config until it parses, or restore it: git checkout HEAD -- docs/gates/<the named file>   (docs/gates/ is fence surface: committing a change needs a protected task's footer)", gatesConfigRefusal);
  const registryRefusal = gateRegistryRefusal();
  check("the gate registry holds — every declared gate carried by its transports, the battery (package.json) included", registryRefusal === null, registryRefusal?.fix, registryRefusal?.evidence);

  let trackedFiles = [];
  try {
    trackedFiles = gitPaths("ls-files");
  } catch {
    // not a git repo — nothing is classified
  }
  check("CODE_TREES/CODE_EXTS classify at least one tracked file", trackedFiles.some(isCodePath), trackedFiles.length > 0 ? "edit CODE_TREES/CODE_EXTS in tools/task-coverage.mjs to match this repo's layout — a gate matching nothing covers nothing" : "commit some files first");

  // The fence's own resolver — the doctor cannot certify a base the fence would refuse.
  const pushBase = resolvePushBase(null);
  check("push base resolves and fences a non-empty range (local overrides are widen-only)", !pushBase.refusal, pushBase.refusal?.fix, pushBase.refusal?.evidence);

  const register = committedText(DECISIONS_REL) ?? "";
  check("decisions register exists with entry headings", registerHeadingCount(register) > 0, `create ${DECISIONS_REL} with at least one '## ' entry heading`);

  const checklist = committedText(CHECKLIST_REL) ?? "";
  check("adversarial checklist parses to exactly 8 lanes", checklistLaneCount(checklist) === 8, "keep exactly eight '### N. Title' escape-class headings (or change the runner's count pin deliberately)");

  const failed = printDoctorResults(results);
  if (failed > 0) die(`doctor: ${failed} check(s) failed — the fence is not fully wired; fixes printed above`);
  console.log("task-coverage doctor: all checks pass — the fence is wired end to end");
}

/** Print the doctor's verdicts: the check's name is the rule, then its evidence when it has
 *  any, then the fix — evidence never rides in the fix slot. Returns the failure count. */
function printDoctorResults(results) {
  let failed = 0;
  for (const r of results) {
    if (r.ok) {
      console.log(`task-coverage doctor: ✔ ${r.name}`);
      continue;
    }
    failed += 1;
    console.error(`task-coverage doctor: ✖ ${r.name}`);
    if (r.evidence) console.error(`    evidence: ${r.evidence}`);
    console.error(`    fix: ${r.fix}`);
  }
  return failed;
}

/** Pure: the widen-only law. A local stallion.push-base may widen the audit or match the committed
 *  adoption base, never narrow it: a config base newer than the committed base shrinks the fence
 *  below the repo's baseline, invisibly to any reviewer (an adversarial finding). Advancing the
 *  base is a deliberate edit of the committed file, two-step. `isAncestor` is the caller's git
 *  fact; either side absent cannot narrow. */
export function baseNarrows(config, committed, isAncestor) {
  return Boolean(config && committed && config !== committed && !isAncestor(config, committed));
}

/** Pure: the widen-only refusal — a narrowing local override is unset or matched, and advancing
 *  the committed base itself is a pin. */
export function narrowingRefusal(config, committed) {
  return { evidence: `local stallion.push-base (${config}) narrows the fence below the committed adoption base (${committed.slice(0, 8)})`, rule: "local overrides widen the audit or match it — never shrink it", fix: `git config --unset stallion.push-base, or match it: git config stallion.push-base ${committed}\n       to ADVANCE the adoption base: ${pinBaseFix("<new-rev>")}\n       then push once with --base <old>` };
}

/**
 * Where the push range starts, and whether it may: --base, then the local stallion.push-base
 * (widen-only), then the committed .stallion-base, then the current branch's remote-tracking ref.
 * Returns { base } or { refusal: { evidence, rule, fix } } — ONE resolver for the fence and the
 * doctor, so the doctor cannot certify a base the fence refuses (a review finding: the widen-only
 * law was spelled twice, untested). Unresolvable, narrowing, unresolving, uncountable, and empty
 * all REFUSE — never skip: the first push of a branch is exactly when unreviewed history must not
 * sail through.
 */
function resolvePushBase(explicit) {
  const branch = currentBranch();
  const originCurrent = branch && revParseOk(`origin/${branch}`) ? `origin/${branch}` : null;
  const config = gitConfig("stallion.push-base");
  const committed = committedBase();
  const base = pickBase(explicit, config, committed, originCurrent);
  if (!base) {
    return { refusal: { evidence: "no resolvable push base — refusing rather than guessing a range", rule: "a first push must not fail open", fix: `${pinBaseFix("HEAD")}   (committed — CI resolves from it)\n       or: git config stallion.push-base <rev>   (local override, widen-only)\n       or run with an explicit --base <rev>` } };
  }
  if (!explicit && baseNarrows(config, committed, isAncestorOrSelf)) {
    return { refusal: narrowingRefusal(config, committed) };
  }
  if (!revParseOk(base)) {
    return { refusal: { evidence: `base revision does not resolve: ${base}`, rule: "the range is judged from a commit this clone holds", fix: `pass --base <rev>, or update the committed adoption base: ${pinBaseFix("<rev>")}\n       (a fresh repo with one commit has no parent to diff against — pin the adoption base explicitly)` } };
  }
  const count = rangeCount(base);
  if (count === -1) {
    return { refusal: { evidence: `cannot count the range ${base}..HEAD — git rev-list failed`, rule: "a gate that cannot read state must not pass", fix: "this is a git failure, not a configuration problem — check the repository (permissions, safe.directory, object store) and retry" } };
  }
  if (count === 0) {
    return { refusal: { evidence: `base ${base} fences an empty range — ${base}..HEAD contains no commits`, rule: "a range that audits nothing is not coverage (the vacuous-base escape, refused)", fix: `pin the base to an ancestor before HEAD: ${pinBaseFix("<earlier-rev>")}` } };
  }
  return { base };
}

/** Is sha STRICTLY before the cutover commit (an ancestor, not the commit itself)? */
function commitPrecedes(sha, cutoverSha) {
  return sha !== cutoverSha && isAncestorOrSelf(sha, cutoverSha);
}

function isAncestorOrSelf(rev, maybeDescendant) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", rev, maybeDescendant], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const BOOLEAN_FLAGS = new Set(["--self-test", "--staged", "--doctor", "--pre-push"]);
const USAGE = "task-coverage.mjs [--base <rev>] [--pre-push] [--staged] [--doctor] [--commit-msg <file>] (--self-test to self-test)";

/** Strict flags: --base and --commit-msg take values (both `--flag x` and `--flag=x`, non-empty);
 *  --staged, --doctor, --commit-msg, and --pre-push are exclusive modes (a silent winner masked
 *  the others); unknown flags refuse. --pre-push is the fence reading git's pushed refs on stdin
 *  (the hook form); bare, the fence judges base..HEAD only. */
function parseFlags(argv) {
  const flags = {};
  const seen = new Set();
  const once = (name) => {
    if (seen.has(name)) die(`--${name} given more than once — a repeated flag silently keeping the last value is the escape task-state's parser already refuses`);
    seen.add(name);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (BOOLEAN_FLAGS.has(a)) {
      once(a.slice(2));
      flags[a.slice(2)] = true;
      continue;
    }
    if (a === "--base" || a.startsWith("--base=") || a === "--commit-msg" || a.startsWith("--commit-msg=")) {
      const eq = a.indexOf("=");
      const inline = eq !== -1;
      const key = a.slice(2, eq === -1 ? undefined : eq);
      once(key);
      if (inline && a.slice(eq + 1).length === 0) die(`--${key} requires a non-empty value`);
      if (inline) { flags[key] = a.slice(eq + 1); continue; }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--") || next.length === 0) die(`--${key} requires a non-empty value (usage: ${USAGE})`);
      flags[key] = next;
      i += 1;
      continue;
    }
    die(`unknown flag: ${a} — usage: ${USAGE}`);
  }
  const modes = ["staged", "doctor", "commit-msg", "pre-push"].filter((mode) => flags[mode]);
  if (modes.length > 1) die(`--${modes.join(" and --")} are separate invocations — running one silently would mask the other`);
  return flags;
}

/** Self-test helper: every declared fence surface classifies as code at the fence (one surface,
 *  two seams — the tier law in task-state and the footer law here). */
function everyFenceSurfaceIsCode() {
  const sample = (root) => (root === ".github" ? ".github/workflows/x.yml" : `${root}/x.json`);
  return FENCE_SURFACE.files.every((f) => isCodePath(f)) && FENCE_SURFACE.roots.every((r) => isCodePath(sample(r)));
}

/** Self-test helper: a staged refusal's refused-record lines (none when there is no refusal). */
function refusedLines(refusal) {
  return refusal?.refused ?? [];
}

/** Self-test helper: the staged verdict, or the crash that replaced it — a gate that throws
 *  prints a stack trace, not a rule and a fix. */
function stagedVerdict(stagedFiles, records) {
  try {
    return stagedRefusal(stagedFiles, records);
  } catch (e) {
    return { crashed: String(e.message) };
  }
}

/** Self-test helper: does gitOut carry output past Node's 1 MiB default buffer? The staged diff
 *  of one large lockfile once refused a footerless commit with ENOBUFS (a review finding). */
function gitOutCarriesLargeOutput() {
  const dir = mkdtempSync(`${tmpdir()}/task-coverage-`);
  try {
    writeFileSync(`${dir}/big.txt`, "x\n".repeat(700000));
    return gitOut("-C", dir, "grep", "--no-index", "-h", "-e", "x", "--", "big.txt").length > 1024 * 1024;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Self-test: the refusals ARE the feature — every guard proven both directions. */
export function selfTest() {
  const failures = [];
  const fail = (m) => failures.push(m);
  const record = (riskClass, phases, extraEvents = []) => ({
    schema: "stallion/task-state@1",
    id: "t",
    riskClass,
    events: [
      { type: "created", at: "2026-09-17T00:00:00.000Z" },
      { type: "red-check", command: "npm test -- the-pin.test.ts", at: "2026-09-19T00:00:00.000Z", exitCode: 1, outputDigest: "abc" },
      ...phases.map((to) => ({ type: "transition", to })),
      ...extraEvents,
    ],
  });

  const codeCases = [
    ["apps source is code", isCodePath("apps/api/src/main.ts")],
    ["packages source is code", isCodePath("packages/db/src/schema.ts")],
    ["harness tools are code", isCodePath("tools/harness/task-state.mjs")],
    ["deploy scripts are code", isCodePath("deploy/push.sh")],
    ["web tsx is code", isCodePath("apps/web/src/routes/page.tsx")],
    ["docs are not code", !isCodePath("docs/README.md")],
    ["markdown under apps is not code", !isCodePath("apps/web/README.md")],
    ["json state is not code", !isCodePath("tasks/x.json")],
    ["root package.json is not code", !isCodePath("package.json")],
    ["generated artifacts are not code", !isCodePath("artifacts/graph.json")],
    [".mts is code", isCodePath("tools/dev/constants.d.mts")],
    [".css is code", isCodePath("apps/web/src/style.css")],
    ["Dockerfile is code", isCodePath("apps/api/Dockerfile")],
    ["deploy Caddyfile is code", isCodePath("deploy/Caddyfile")],
    ["sql is exempt by default", !isCodePath("db/migrations/0001_init.sql")],
    ["the adoption-base file is code (it IS the fence)", isCodePath(".stallion-base")],
    ["committed hooks are code (they ARE the fence)", isCodePath(".githooks/pre-push")],
    ["CI workflows are code (they carry the fence)", isCodePath(".github/workflows/selftest.yml")],
    ["gate configs are code (they ARE the fence's law — an adversarial finding)", isCodePath("docs/gates/complexity.json")],
    ["every declared fence surface is code at the fence (one surface, two seams)", everyFenceSurfaceIsCode()],
    ["pre-cutover commits keep the law of their day: docs/gates files are not code for them", fenceSurfaceFiles(["docs/gates/x.json", "tools/a.mjs"], true).join() === "tools/a.mjs"],
    ["post-cutover commits see docs/gates as fence surface", fenceSurfaceFiles(["docs/gates/x.json", "tools/a.mjs"], false).length === 2],
    ["every gate config path is fence surface", isCodePath("docs/gates/gate-registry.json") && isCodePath("docs/gates/debt-register.md")],
    ["docs under .github are not code", !isCodePath(".github/ISSUE_TEMPLATE.md")],
  ];
  for (const [name, passes] of codeCases) if (!passes) fail(`task-coverage: ${name}`);

  const footerCases = [
    ["own-line footer extracted", taskFooterOf("fix: x\n\ntask: my-task") === "my-task"],
    ["last-line footer extracted", taskFooterOf("fix: x\n\ntask: my-task\n") === "my-task"],
    ["mid-sentence 'task:' is not a footer", taskFooterOf("fix: the task: went nowhere") === null],
    ["missing footer is null", taskFooterOf("fix: x") === null],
    ["a quoted example in the body does not authorize", taskFooterOf("docs: explain the convention\n\nThe convention is:\n\n```\ntask: enforce-task-coverage\n```\n\nThat is all.") === null],
    ["non-kebab id rejected", taskFooterOf("fix: x\n\ntask: My_Task") === null],
  ];
  for (const [name, passes] of footerCases) if (!passes) fail(`task-coverage: ${name}`);

  const authCases = [
    ["executing runtime-code authorizes", recordRefusal(record("runtime-code", ["planned", "executing"])) === null],
    ["done authorizes", recordRefusal(record("runtime-code", ["planned", "executing", "verified", "adversarial", "done"])) === null],
    ["planning-only never authorizes", recordRefusal(record("planning-only", ["planned", "executing"])) !== null],
    ["intake does not authorize", recordRefusal(record("runtime-code", [])) !== null],
    ["planned does not authorize", recordRefusal(record("runtime-code", ["planned"])) !== null],
    ["protected without approval refused", recordRefusal(record("protected", ["planned", "executing"])) !== null],
    // A REAL decisions-register heading: the cross-check reads the live register, so the fixture cites it.
    ["protected with a real decision authorizes", recordRefusal(record("protected", ["planned", "executing"], [{ type: "approval", decision: "2026-01-15 — ADOPTION: this repository runs its code through the task lifecycle" }])) === null],
    ["protected with an invented decision refused", recordRefusal(record("protected", ["planned", "executing"], [{ type: "approval", decision: "2026-01-16 — I NEVER SAID THIS" }])) !== null],
    ["unknown risk class refused (hand-forged record)", recordRefusal(record("totally-made-up-class", ["planned", "executing"])) !== null],
    ["docs-only cannot authorize code", recordRefusal(record("docs-only", ["planned", "executing"])) !== null],
    ["a pin-less done record is refused at the fence (hand-edit parity)", recordRefusal({ schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created", at: "2026-09-17T00:00:00.000Z" }, { type: "transition", to: "planned" }, { type: "transition", to: "executing" }, { type: "transition", to: "verified" }, { type: "transition", to: "adversarial" }, { type: "transition", to: "done", at: "2026-09-19T00:00:00.000Z" }] }) !== null],
    ["a pin-less in-flight record passes the fence (pins bind at verified, commits land at executing)", recordRefusal({ schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created", at: "2026-09-17T00:00:00.000Z" }, { type: "transition", to: "planned" }, { type: "transition", to: "executing" }] }) === null],
    ["a pre-cutover done record is grandfathered at the fence", recordRefusal({ schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created", at: "2026-09-17T00:00:00.000Z" }, { type: "transition", to: "planned" }, { type: "transition", to: "executing" }, { type: "transition", to: "verified" }, { type: "transition", to: "adversarial" }, { type: "transition", to: "done", at: "2026-09-18T15:00:00.000Z" }] }) === null],
    ["a post-chain-cutover record with a broken chain refuses at the fence", recordRefusal({ schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created", at: "2026-09-19T03:00:00.000Z", type2: "created" }, { type: "transition", to: "planned" }, { type: "transition", to: "executing" }] }) !== null],
    ["a post-chain-cutover record with an intact chain passes the fence chain law", (() => {
      const stamped = chainStampEvents([{ type: "created", at: "2026-09-19T03:00:00.000Z" }, { type: "transition", to: "planned", at: "2026-09-19T03:00:01.000Z" }, { type: "transition", to: "executing", at: "2026-09-19T03:00:02.000Z" }]);
      return recordRefusal({ schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: stamped }) === null;
    })()],
    ["a pre-chain-cutover record stays chain-grandfathered at the fence", recordRefusal({ schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created", at: "2026-09-18T12:00:00.000Z" }, { type: "transition", to: "planned" }, { type: "transition", to: "executing" }] }) === null],
    ["malformed record refused", recordRefusal(null) !== null],
    ["wrong schema refused", recordRefusal({ schema: "nope" }) !== null],
  ];
  for (const [name, passes] of authCases) if (!passes) fail(`task-coverage: ${name}`);

  const stagedCases = [
    ["no code staged passes", stagedRefusal(["docs/x.md", "package.json"], [record("runtime-code", [])]) === null],
    ["code staged with an executing task passes", stagedRefusal(["apps/a.ts"], [record("runtime-code", ["planned", "executing"])]) === null],
    ["code staged with no tasks refuses and lists the code files", stagedRefusal(["apps/a.ts", "docs/x.md"], []).codeFiles?.length === 1],
    ["code staged under a planning-only task still refuses", stagedRefusal(["tools/x.mjs"], [record("planning-only", ["planned", "executing"])]) !== null],
    ["a done task does not keep the staged gate open", stagedRefusal(["apps/a.ts"], [record("runtime-code", ["planned", "executing", "verified", "adversarial", "done"])]) !== null],
    ["a docs-only task does not keep the staged gate open", stagedRefusal(["apps/a.ts"], [record("docs-only", ["planned", "executing"])]) !== null],
    ["staged fence surface with no task names the protected remedy", stagedRefusal([".stallion-base"], []).fenceSurface === true],
    ["staged ordinary code with no task names the runtime-code remedy", stagedRefusal(["apps/a.ts"], []).fenceSurface === false],
    ["an in-flight task the record law refuses is named with its reason, never reported as no task in flight", refusedLines(stagedRefusal(["apps/a.ts"], [record("docs-only", ["planned", "executing"])])).some((line) => line.startsWith("t (executing): "))],
    ["with nothing in flight the refusal names no refused record", stagedRefusal(["apps/a.ts"], [record("runtime-code", ["planned"])]).refused?.length === 0],
    ["a malformed record beside an executing task is simply not in flight, never a stack trace", stagedVerdict(["apps/a.ts"], [null, { id: "x", events: {} }, { schema: "x", events: [null] }, record("runtime-code", ["planned", "executing"])]) === null],
    ["malformed records alone still refuse staged code with its evidence", stagedVerdict(["apps/a.ts"], [null, { events: 5 }])?.codeFiles?.length === 1],
  ];
  for (const [name, passes] of stagedCases) if (!passes) fail(`task-coverage: ${name}`);

  const doctorCases = [
    ["lane count delegates to the enforcement parser", checklistLaneCount("### 1. A\nbody\n### 2. B\nbody") === 2],
    ["the fence detector matches a bare range-check step", invokesMode("      run: node tools/task-coverage.mjs --base \"$BASE\"", "fence")],
    ["the doctor's own step does not certify the fence", !invokesMode("      run: node tools/task-coverage.mjs --doctor", "fence")],
    ["an echo line mentioning the tool wires nothing", !invokesMode("      run: echo node tools/task-coverage.mjs\n", "fence")],
    ["a sh -c wrapped staged hook certifies staged (Claude Code form)", invokesMode("sh -c 'node tools/task-coverage.mjs --staged || exit 2'", "staged")],
    ["a --staged-only hook does not certify the fence", !invokesMode("#!/bin/sh\nnode tools/task-coverage.mjs --staged || exit 1\n", "fence")],
    ["the pre-push hook's --pre-push form certifies the fence", invokesMode("#!/bin/sh\nnode tools/task-coverage.mjs --pre-push || exit 1\n", "fence")],
    ["a self-test-only hook or CI step does not certify the fence", !["#!/bin/sh\nnode tools/task-coverage.mjs --self-test || exit 1\n", "      run: node tools/task-coverage.mjs --self-test"].some((hook) => invokesMode(hook, "fence"))],
    ["a self-test flag touching a shell operator or quote does not certify the fence", !["node tools/task-coverage.mjs --self-test||exit 1", "node tools/task-coverage.mjs --self-test&&true", 'node tools/task-coverage.mjs "--self-test" || exit 1'].some((hook) => invokesMode(hook, "fence"))],
    ["the staged detector requires --staged on a live line", invokesMode("#!/bin/sh\nnode tools/task-coverage.mjs --staged || exit 1\n", "staged")],
    ["a commented-out pre-commit hook wires nothing", !invokesMode("#!/bin/sh\n# node tools/task-coverage.mjs --staged\nexit 0\n", "staged")],
    ["register heading counter counts '## ' only", registerHeadingCount("## A\n### a\n## B") === 2],
    ["battery completeness derives from the tool list, not a pinned name", missingSelfTests("node tools/a.mjs --self-test", ["a.mjs", "b.mjs"]).length === 1],
    ["a complete battery reports nothing missing", missingSelfTests("node tools/a.mjs --self-test && node tools/b.mjs --self-test", ["a.mjs", "b.mjs"]).length === 0],
    ["a missing script fails every tool closed", missingSelfTests("", ["a.mjs"]).length === 1],
    ["nested members are matched by their nested path", missingSelfTests("node tools/bench/grade.mjs --self-test", ["bench/grade.mjs", "zcode-plugin/lib/gate-law.mjs"]).length === 1],
    ["dispatch detection covers the .includes spelling", dispatchesSelfTest('if (argv.includes("--self-test")) x();')],
    ["dispatch detection covers the === spelling (task-gate's own)", dispatchesSelfTest('if (a === "--self-test") { args["self-test"] = true; }')],
    ["dispatch detection covers indexOf", dispatchesSelfTest('if (argv.indexOf("--self-test") !== -1) x();')],
    ["loose == is not a dispatch idiom (the tightened equality arm)", !dispatchesSelfTest('if (a == "--self-test") x();')],
    ["a negated !== is not a dispatch idiom (its == tail never was one)", !dispatchesSelfTest('if (a !== "--self-test") return;')],
    ["a bare mention inside a written string is NOT a member (bench/setup.mjs)", !dispatchesSelfTest('writeFileSync(p, "node tools/task-findings.mjs --self-test && node tools/task-gate.mjs --self-test")')],
    ["the real task-gate.mjs source dispatches (the regression the review caught)", dispatchesSelfTest(stripComments(readFileSync(new URL("./task-gate.mjs", import.meta.url), "utf8")))],
    ["a dispatch idiom mentioned only in a comment is NOT a member (the strip law)", !dispatchesSelfTest(stripComments("// if (argv.includes(\"--self-test\")) selfTest();\nfunction x() {}\n"))],
    ...(() => {
      // In THIS tree the plugin is law and its manifest is judged; a vendored harness without
      // the plugin skips the manifest cases with a visible note instead of crashing the
      // battery on ENOENT (a sweep caught the unconditional read breaking exactly that port).
      // The cases are declared once as data and the skip note COUNTS the list — a review
      // caught the note hard-coding "four" while five cases ran, so the note now derives.
      // The default predicate resolves the DISPATCHED PATH like the hook runtime does — each
      // disk check is also witnessed ALONE (adversarial lanes caught a () => false pin
      // passing whichever single check survived, and an early return skipping the banner law).
      const manifestUrl = new URL("./zcode-plugin/hooks/hooks.json", import.meta.url);
      const PLUGIN_ROOT_VAR = "${ZCODE_PLUGIN_ROOT}/";
      const resolves = (dispatched) => typeof dispatched === "string" && dispatched.startsWith(PLUGIN_ROOT_VAR) && existsSync(new URL(`./zcode-plugin/${dispatched.slice(PLUGIN_ROOT_VAR.length)}`, import.meta.url));
      const manifestCases = [
        ["the plugin manifest as shipped passes the wiring judge", (m, se) => pluginWiringRefusal(m, se) === null],
        ["a matcher covering no edit tool refuses", (m, se) => { const x = JSON.parse(m); x.hooks.PreToolUse[0].matcher = "NoSuchTool"; return pluginWiringRefusal(x, se) !== null; }],
        ["a missing banner event refuses", (m, se) => { const x = JSON.parse(m); delete x.hooks.UserPromptSubmit; return pluginWiringRefusal(x, se) !== null; }],
        ["a gate script nothing dispatches refuses", (m, se) => { const x = JSON.parse(m); x.hooks.PreToolUse[0].hooks[0].args = ["${ZCODE_PLUGIN_ROOT}/hooks/somewhere-else.mjs"]; return pluginWiringRefusal(x, se) !== null; }],
        ["a re-pointed decoy path refuses while the real script stays on disk", (m, se) => { const x = JSON.parse(m); x.hooks.PreToolUse[0].hooks[0].args = ["${ZCODE_PLUGIN_ROOT}/hooks/decoy/authoring-gate.mjs"]; return pluginWiringRefusal(x, se) !== null; }],
        ["a path spelling the resolver cannot answer refuses (fail closed)", (m) => { const x = JSON.parse(m); x.hooks.PreToolUse[0].hooks[0].args = ["hooks/authoring-gate.mjs"]; return pluginWiringRefusal(x, resolves) !== null; }],
        ["the gate's disk check is witnessed alone (banner present)", (m) => pluginWiringRefusal(m, (p) => typeof p === "string" && !p.includes("authoring-gate.mjs")) !== null],
        ["the banner's disk check is witnessed alone (gate present)", (m) => pluginWiringRefusal(m, (p) => typeof p === "string" && !p.includes("banner.mjs")) !== null],
        ["total script absence refuses", (m) => pluginWiringRefusal(m, () => false) !== null],
        ["a matcher-omitted manifest still answers for the banner's script", (m) => { const x = JSON.parse(m); delete x.hooks.PreToolUse[0].matcher; return pluginWiringRefusal(x, (p) => typeof p === "string" && p.includes("authoring-gate.mjs")) !== null; }],
        ["an omitted matcher with every script on disk still passes (omission matches everything)", (m, se) => { const x = JSON.parse(m); delete x.hooks.PreToolUse[0].matcher; return pluginWiringRefusal(x, se) === null; }],
        ["the judge called without the script-existence fact refuses (no fs fact, no pass)", (m) => pluginWiringRefusal(m) !== null],
        ["an unparseable manifest refuses", () => pluginWiringRefusal("{ nope", resolves) !== null],
      ];
      if (!existsSync(manifestUrl)) return [[`(plugin absent in this tree — its ${manifestCases.length} wiring cases skip visibly)`, true]];
      const manifest = readFileSync(manifestUrl, "utf8");
      return manifestCases.map(([name, run]) => [name, run(manifest, resolves)]);
    })(),
  ];
  for (const [name, passes] of doctorCases) if (!passes) fail(`task-coverage: ${name}`);

  // A direction-bearing ancestry stub ("older" precedes "old", nothing else): a swapped
  // isAncestor(committed, config) inverts the widen-only law, and only this stub sees it.
  const olderIsAncestor = (a, b) => a === "older" && b === "old";
  const baseCases = [
    ["explicit base wins over everything", pickBase("HEAD~1", "cfg", "sha-c", "origin/x") === "HEAD~1"],
    ["local config overrides the committed adoption base", pickBase(null, "cfg", "sha-c", "origin/x") === "cfg"],
    ["the committed adoption base beats origin tracking", pickBase(null, null, "sha-c", "origin/x") === "sha-c"],
    ["origin tracking is the last fallback", pickBase(null, null, null, "origin/main") === "origin/main"],
    ["nothing resolvable is null (fail closed, never skip)", pickBase(null, null, null, null) === null],
    ["an adoption base moved inside the audited range is flagged", baseMovedInRange("aaa\n", "bbb\n")],
    ["an unchanged adoption base passes", !baseMovedInRange("aaa\n", "aaa\n")],
    ["a base file absent at range start passes (first adoption)", !baseMovedInRange(null, "aaa\n")],
    ["an unmoved base needs no old-base audit", movedBaseVerdict(null, "old\n", "old\n") === null],
    ["a moved base audited from the OLD base passes", movedBaseVerdict("old", "old\n", "new\n") === null],
    ["a moved base audited from the NEW base is refused", movedBaseVerdict("new", "old\n", "new\n") === "old-base"],
    ["a moved base with no explicit base is refused", movedBaseVerdict(null, "old\n", "new\n") === "old-base"],
    ["no anchor, no accusation (detached clones skip visibly)", movedBaseVerdict(null, null, "new\n") === null],
    ["deleting the anchor is a move, never exempt", movedBaseVerdict(null, "old\n", null) === "old-base"],
    ["a short-sha spelling of the old base is refused (byte equality)", movedBaseVerdict("abc123", "abc123def456\n", "new\n") === "old-base"],
    ["a local base newer than the committed base narrows the fence (widen-only law)", baseNarrows("new", "old", olderIsAncestor)],
    ["a local base older than the committed base widens, never narrows", !baseNarrows("older", "old", olderIsAncestor)],
    ["a local base equal to the committed base does not narrow", !baseNarrows("old", "old", () => false)],
    ["no local config cannot narrow", !baseNarrows(null, "old", () => false)],
    ["no committed base cannot narrow", !baseNarrows("new", null, () => false)],
    ["a full 40-hex adoption base is accepted", adoptionBaseRefusal("a".repeat(40)) === null],
    ["a short-sha adoption base is refused with the pin flow as its fix", String(adoptionBaseRefusal("abc123")).includes(pinBaseFix("HEAD"))],
    ["the printed adoption-base pin names a protected task and footers the pin commit", ["--risk-class protected", '-m "task: '].every((part) => pinBaseFix("HEAD").includes(part))],
    ["the narrowing refusal's advance route prints the pin flow, never a bare edit of fence surface", narrowingRefusal("new", "a".repeat(40)).fix.includes(pinBaseFix("<new-rev>"))],
    ["the narrowing refusal's local override matches the committed base", /match it: git config stallion\.push-base a{40}/.test(narrowingRefusal("new", "a".repeat(40)).fix)],
    ["the narrowing refusal never calls its local override a pin", !/pin the older/.test(narrowingRefusal("new", "a".repeat(40)).fix)],
  ];
  for (const [name, passes] of baseCases) if (!passes) fail(`task-coverage: ${name}`);

  const scopedPost = { schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created", at: "2026-09-19T00:00:00.000Z" }, { type: "scope", patterns: ["tools/**"] }] };
  const unscopedPost = { schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created", at: "2026-09-19T00:00:00.000Z" }, { type: "transition", to: "executing" }] };
  const unscopedPre = { schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created", at: "2026-09-18T12:00:00.000Z" }, { type: "transition", to: "executing" }] };
  const globCases = [
    ["a tree glob matches at any depth", pathInScope("tools/a/b/c.mjs", ["tools/**"])],
    ["a star matches one segment", pathInScope("tools/a.mjs", ["tools/*"])],
    ["a star stays inside one segment", !pathInScope("tools/a/b.mjs", ["tools/*"])],
    ["a literal segment matches exactly", pathInScope("package.json", ["package.json"])],
    ["a double-star segment matches zero segments", pathInScope("docs/x.md", ["docs/**/x.md"])],
    ["a double-star segment matches many segments", pathInScope("docs/a/b/x.md", ["docs/**/x.md"])],
    ["? matches exactly one non-separator char", pathInScope("tools/a1.mjs", ["tools/a?.mjs"]) && !pathInScope("tools/a12.mjs", ["tools/a?.mjs"])],
    ["regex metacharacters in a pattern are literal", pathInScope("tools/a.b.mjs", ["tools/a.b.mjs"]) && !pathInScope("tools/axb.mjs", ["tools/a.b.mjs"])],
    ["no scope means nothing matches (fail closed)", !pathInScope("tools/a.mjs", [])],
    ["a path outside every pattern refuses", !pathInScope("apps/x.ts", ["tools/**", ".githooks/*"])],
  ];
  for (const [name, passes] of globCases) if (!passes) fail(`task-coverage: ${name}`);

  const scopeCases = [
    ["a post-cutover task with covering scope passes", scopeRefusal(scopedPost, ["tools/a.mjs"]) === null],
    ["the tier law is RE-JUDGED at the seam — a runtime-code record scoped over docs/gates refuses here too (the declaration-time-only escape)", scopeRefusal({ ...unscopedPost, events: [...unscopedPost.events, { type: "scope", patterns: ["docs/gates/*.json"] }] }, ["docs/gates/x.json"]) !== null],
    ["the seam's tier refusal demands the protected class with approval", scopeRefusal({ ...unscopedPost, events: [...unscopedPost.events, { type: "scope", patterns: ["docs/gates/*.json"] }] }, ["docs/gates/x.json"]).remedy?.includes("--risk-class protected")],
    ["a protected record WITH approval scopes the fence surface cleanly at the seam", scopeRefusal({ schema: "stallion/task-state@1", id: "t", riskClass: "protected", events: [{ type: "created", at: "2026-09-19T00:00:00.000Z" }, { type: "scope", patterns: [".githooks/**"] }, { type: "approval", decision: "d" }] }, [".githooks/pre-push"]) === null],
    ["a PRE-CUTOVER commit citing a fence-surface-scoped record is grandfathered at the seam — settled history keeps the law of its day", scopeRefusal({ ...unscopedPost, events: [{ type: "created", at: "2026-09-19T00:00:00.000Z" }, { type: "scope", patterns: ["docs/gates/**"] }] }, ["docs/gates/x.json"], false) === null],
    ["a post-cutover task with no declared scope refuses", scopeRefusal(unscopedPost, ["tools/a.mjs"]) !== null],
    ["code outside the declared scope refuses", scopeRefusal(scopedPost, ["apps/x.ts"]) !== null],
    ["the outside-scope refusal names the offending files", scopeRefusal(scopedPost, ["apps/x.ts", "packages/y.js"]).reason.includes("apps/x.ts")],
    ["no code files means no scope question", scopeRefusal(unscopedPost, []) === null],
    ["a pre-cutover task is grandfathered without scope", scopeRefusal(unscopedPre, ["tools/a.mjs", "apps/x.ts"]) === null],
    ["the no-scope refusal carries the exact fix command", scopeRefusal(unscopedPost, ["tools/a.mjs"]).remedy?.includes("scope t --add")],
    ["the outside-scope refusal carries the amendment fix", scopeRefusal(scopedPost, ["apps/x.ts"]).remedy?.includes("scope t --add")],
    ["an UNDATED record is NOT grandfathered (fail closed)", !isGrandfatheredScope({ events: [{ type: "created" }] })],
    ["a malformed timestamp is NOT grandfathered (fail closed)", !isGrandfatheredScope({ events: [{ type: "created", at: "0000" }] })],
    ["an offset-spelled post-cutover instant is NOT grandfathered", !isGrandfatheredScope({ events: [{ type: "created", at: "2026-09-18T19:00:00.000-05:00" }] })],
    ["a parseable pre-cutover instant IS grandfathered", isGrandfatheredScope(unscopedPre)],
    ["a hand-edited everything-pattern fails closed — the tier law answers it first (it covers the fence's own surface)", scopeRefusal({ ...unscopedPost, events: [{ type: "created", at: "2026-09-19T00:00:00.000Z" }, { type: "scope", patterns: ["**"] }] }, ["tools/a.mjs"]).reason.includes("fence's own surface")],
    ["a record mixing good and malformed patterns keeps only the good", scopeRefusal({ ...unscopedPost, events: [{ type: "created", at: "2026-09-19T00:00:00.000Z" }, { type: "scope", patterns: ["/tools/**", "tools/**"] }] }, ["tools/a.mjs"]) === null],
  ];
  for (const [name, passes] of scopeCases) if (!passes) fail(`task-coverage: ${name}`);

  const citationCases = [
    ["a NEW commit citing a done task refuses at the seam", (() => {
      const donePost = { ...unscopedPost, events: [...unscopedPost.events, { type: "transition", to: "verified" }, { type: "transition", to: "adversarial" }, { type: "transition", to: "done" }] };
      return citationRefusal(donePost, ["tools/a.mjs"], true) !== null && citationRefusal(donePost, ["tools/a.mjs"], true).remedy?.includes("new <new-id>");
    })()],
    ["re-judged settled history citing a done task falls through to the scope law", citationRefusal(unscopedPre, ["tools/a.mjs"], false) === null],
    ["a scoped retired task still authorizes nothing (the retire law)", citationRefusal({ ...scopedPost, events: [...scopedPost.events, { type: "retired", because: "superseded by x" }] }, ["tools/a.mjs"], true) !== null],
    ["a new commit citing an in-flight scoped task passes the seam", citationRefusal(scopedPost, ["tools/a.mjs"], false) === null && citationRefusal({ ...scopedPost, events: [...scopedPost.events, { type: "transition", to: "executing" }] }, ["tools/a.mjs"], true) === null],
    ["a malformed doneAt stamp does not grandfather the pin law", recordRefusal({ schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created", at: "2026-09-17T00:00:00.000Z" }, { type: "transition", to: "planned" }, { type: "transition", to: "executing" }, { type: "transition", to: "verified" }, { type: "transition", to: "adversarial" }, { type: "transition", to: "done", at: "not-a-date" }] }) !== null],
  ];
  for (const [name, passes] of citationCases) if (!passes) fail(`task-coverage: ${name}`);

  const anchorCases = [
    ["a task settled-done at the anchor refuses a commit new since that anchor", isNewCitation("done", "settled-done", false) === true],
    ["a task first-landing at the anchor authorizes its own tail commits", isNewCitation("done", "first-landing", false) === false],
    ["a task in flight at the anchor authorizes its finishing push", isNewCitation("done", "in-flight-there", false) === false],
    ["no anchor skips the done-law rather than bricking", isNewCitation("done", "no-anchor", false) === false],
    ["an unreadable anchor copy fails closed", isNewCitation("done", "unreadable", false) === true],
    ["a commit already settled at the anchor is re-audited, never accused", isNewCitation("done", "settled-done", true) === false],
    ["an in-flight record never trips the done-law", isNewCitation("executing", "settled-done", false) === true],
    ["an adversarial-phase record never trips the done-law", isNewCitation("adversarial", "first-landing", false) === true],
  ];
  for (const [name, passes] of anchorCases) if (!passes) fail(`task-coverage: ${name}`);

  const scanCases = [
    ["a staged Anthropic key refuses with file and line", stagedScanRefusal([{ file: "apps/api/k.ts", line: 3, text: `const k = "${["sk", "ant"].join("-")}-0123456789abcdef0123"` }])?.reason.includes("apps/api/k.ts:3")],
    ["a placeholder key passes", stagedScanRefusal([{ file: "a.ts", line: 1, text: 'const k = "your_api_key_here_xxxxxxxxxxxxx"' }]) === null],
    ["a debugger statement refuses", stagedScanRefusal([{ file: "a.ts", line: 9, text: "  debugger;" }]) !== null],
    ["ordinary code passes", stagedScanRefusal([{ file: "a.ts", line: 1, text: "const x = 1;" }]) === null],
    ["a short sk- word is not a key", stagedScanRefusal([{ file: "a.ts", line: 1, text: "const sk = ski trip" }]) === null],
    ["a REDACTED structural key passes (the body whitelist works)", stagedScanRefusal([{ file: "docs/runbook.md", line: 4, text: "set KEY=sk-ant-XXXXXXXXXXXXXXXXXXXX" }]) === null],
    ["a real key after a placeholder-shaped prefix still refuses", stagedScanRefusal([{ file: "a.ts", line: 2, text: `k = "${["sk", "ant"].join("-")}-real0123456789abcdef"` }]) !== null],
    ["the adapter parses a real diff shape: file, hunk header, added lines counted", (() => {
      const parsed = addedDiffLines([
        "diff --git a/apps/api/k.ts b/apps/api/k.ts",
        "index 111..222 100644",
        "--- a/apps/api/k.ts",
        "+++ b/apps/api/k.ts",
        "@@ -10,3 +10,4 @@ context()",
        " unchanged line",
        "-removed line",
        "+const keep = 1;",
        "+const bad = 2; // carries the scan target",
        "+another added",
      ].join("\n"));
      return parsed.length === 3 && parsed[0].file === "apps/api/k.ts" && parsed[0].line === 11 && parsed[2].line === 13;
    })()],
  ];
  for (const [name, passes] of scanCases) if (!passes) fail(`task-coverage: ${name}`);

  const retireSeamCount = selfTestRetirementSeamCases(fail, record, scopedPost);
  const retireShapeCount = selfTestRetirementShapeCases(fail);
  const commitMsgCount = selfTestCommitMsgCases(fail);
  const remedyCount = selfTestRemedyCases(fail, record);
  const pushCount = selfTestPushCases(fail);
  const flagCount = selfTestFlagCases(fail);
  const transportCount = selfTestTransportCases(fail);
  const shapeCount = selfTestCommitShapeCases(fail);
  const mergeLawCount = selfTestMergeLawCases(fail);
  const hookLineCount = selfTestHookLineCases(fail) + selfTestErrexitCases(fail);

  const bannerCounts = `${codeCases.length} path + ${footerCases.length} footer + ${authCases.length} authorization + ${stagedCases.length} staged + ${doctorCases.length} doctor + ${baseCases.length} base + ${globCases.length} glob + ${scopeCases.length} scope + ${citationCases.length} citation + ${retireSeamCount + retireShapeCount} retirement + ${anchorCases.length} anchor + ${scanCases.length} scan + ${commitMsgCount} commit-msg + ${remedyCount} remedy + ${pushCount} push + ${flagCount} flag + ${shapeCount} commit-shape + ${mergeLawCount} merge-law + ${hookLineCount} hook-line + ${transportCount} transport cases — all counts derived`;
  console.log(failures.length === 0 ? `task-coverage self-test: OK (${bannerCounts} — group counts derived where arrays are local)` : `task-coverage self-test: FAILED\n  ${failures.join("\n  ")}`);
  return failures.length === 0;
}

/** Self-test helper: the commit-msg seam over fixture records — an in-flight scoped task `t`, a
 *  docs-only `d`, and planned `p`/`dp` — with an editor-composed, non-merge commit by default. */
function commitMsgFixture() {
  const scopedExec = { schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created", at: "2026-09-19T00:00:00.000Z" }, { type: "transition", to: "planned" }, { type: "scope", patterns: ["tools/**"] }, { type: "transition", to: "executing" }] };
  const planned = { ...scopedExec, id: "p", events: scopedExec.events.slice(0, 3) };
  const records = { t: scopedExec, d: { ...scopedExec, id: "d", riskClass: "docs-only" }, p: planned, dp: { ...planned, id: "dp", riskClass: "docs-only" } };
  const load = (id) => (records[id] ? { record: records[id] } : { error: `no task record for '${id}'` });
  return (message, files, facts = {}) => commitMsgVerdict({ message, messageFile: ".git/COMMIT_EDITMSG", files, mergeParents: null, editorUsed: true, cleanup: null, addedLines: [], load, ...facts });
}

/** The commit-msg seam's reading of git's own shapes: the cleanup git will apply to the message. */
function selfTestCommitShapeCases(fail) {
  const verdict = commitMsgFixture();
  const scissorsTemplate = "\n# ------------------------ >8 ------------------------\n# Do not modify or remove the line above.\n# Everything below it will be ignored.\n#\n# On branch main\n# Changes to be committed:\n#\tnew file:   tools/a.mjs\n#\n";
  const cases = [
    ["with no editor git keeps '#' lines, so a '#' paragraph after the footer refuses at commit-msg as the fence will", verdict("fix: x\n\ntask: t\n\n#123 follow-up", ["tools/a.mjs"], { editorUsed: false }).refusal !== undefined
      && verdict("fix: x\n\ntask: t\n\n#123 follow-up", ["tools/a.mjs"], { editorUsed: false, cleanup: "strip" }).ok !== undefined],
    ["commit.cleanup=scissors with an editor cuts git's template at the scissors line and keeps the '#' lines above it", verdict(`fix: x\n\ntask: t\n${scissorsTemplate}`, ["tools/a.mjs"], { cleanup: "scissors" }).ok !== undefined
      && verdict(`fix: x\n\ntask: t\n\n#123 follow-up\n${scissorsTemplate}`, ["tools/a.mjs"], { cleanup: "scissors" }).refusal !== undefined],
  ];
  for (const [name, passes] of cases) if (!passes) fail(`task-coverage: ${name}`);
  return cases.length;
}

/** The merge law (mergeOwnFiles) the fence and commit-msg share: git's own merge when it can
 *  make one, the since-the-base fallback when it cannot, and the octopus's first-parent reading. */
function selfTestMergeLawCases(fail) {
  const cases = [
    ["a merge that keeps a stale side's copy over a change the other side made since the base is the merge's own — the stale-side reversion", mergeOwnFiles([["tools/pathspec.mjs"], []], [["tools/pathspec.mjs"], []]).join() === "tools/pathspec.mjs"
      && mergeOwnFiles([["tools/a.mjs"], []], [[], ["tools/a.mjs"]]).length === 0
      && mergeOwnFiles([["tools/evil.mjs", "tools/a.mjs"], ["tools/evil.mjs"]], [[], ["tools/a.mjs"]]).join() === "tools/evil.mjs"],
    ["under git's own merge a file differing from both parents stays the merge's own, and a side's change the other side held is not", mergeOwnFiles([["tools/both.mjs", "tools/a.mjs"], ["tools/both.mjs"]], [], []).join() === "tools/both.mjs"
      && mergeOwnFiles([[], ["tools/a.mjs"]], [[], ["tools/a.mjs"]], []).length === 0 && mergeOwnFiles([["tools/a.mjs"], []], [], ["tools/a.mjs"]).join() === "tools/a.mjs"],
    ["a merge with no resolvable base judges every differing path, and an octopus answers for all it brings its first parent", mergeOwnFiles([["tools/a.mjs"], []], null).join() === "tools/a.mjs"
      && mergeOwnFiles([["tools/a.mjs"], [], ["tools/a.mjs"]], [[], [], []]).join() === "tools/a.mjs"],
  ];
  for (const [name, passes] of cases) if (!passes) fail(`task-coverage: ${name}`);
  return cases.length;
}

/** The hook-line model the doctor certifies wiring with: the mode each transport needs, and a
 *  verdict that actually reaches git. */
function selfTestHookLineCases(fail) {
  const cases = [
    ["a bare fence hook does not certify the pre-push transport — the pushed-refs law runs only under --pre-push", !invokesMode("#!/bin/sh\nnode tools/task-coverage.mjs || exit 1\n", "pre-push") && invokesMode("#!/bin/sh\nnode tools/task-coverage.mjs --pre-push || exit 1\n", "pre-push")],
    ["an unknown mode certifies nothing — fail closed, never the bare fence", !invokesMode("#!/bin/sh\nnode tools/task-coverage.mjs || exit 1\n", "no-such-mode")],
    ["the detached-head guard's hook line certifies the guard and no task-coverage line does", invokesMode("#!/bin/sh\nnode tools/task-coverage.mjs --staged || exit 1\nnode tools/detached-head-guard.mjs || exit 1\n", "detached-head-guard") && !invokesMode("#!/bin/sh\nnode tools/task-coverage.mjs --staged || exit 1\n", "detached-head-guard")],
    ["a verdict the shell throws away certifies nothing — a non-final bare hook line, '; exit 0', '|| echo', a trailing '&'", ![
      ["#!/bin/sh\nnode tools/task-coverage.mjs --staged\nnode tools/detached-head-guard.mjs || exit 1\n", "staged"],
      ["#!/bin/sh\nnode tools/task-coverage.mjs --pre-push\nnode tools/task-coverage.mjs --doctor || exit 1\n", "pre-push"],
      ["node tools/task-coverage.mjs --staged; exit 0", "staged"],
      ['node tools/task-coverage.mjs --commit-msg "$1" || echo x', "commit-msg"],
      ["      run: node tools/task-coverage.mjs || echo fence-failed", "fence"],
      ["      run: node tools/task-coverage.mjs &", "fence"],
    ].some(([text, mode]) => invokesMode(text, mode))],
    ["a verdict sh never hands git certifies nothing — '|| exit 0', '|| exit 256' (sh folds it to 0), a non-final sh -c wrapper, set -e undone by set +e", ![
      ["#!/bin/sh\nnode tools/task-coverage.mjs --pre-push || exit 0\n", "pre-push"],
      ["#!/bin/sh\nnode tools/task-coverage.mjs --pre-push || exit 256\n", "pre-push"],
      ["#!/bin/sh\nnode tools/task-coverage.mjs --staged || exit 512\n", "staged"],
      ['#!/bin/sh\nsh -c "node tools/task-coverage.mjs --pre-push || exit 1"\necho pushed\n', "pre-push"],
      ["#!/bin/sh\nset -e\nset +e\nnode tools/task-coverage.mjs --pre-push\nnode tools/task-coverage.mjs --doctor || exit 1\n", "pre-push"],
      ["#!/bin/sh\nset -eu\nset +o errexit\nnode tools/task-coverage.mjs --staged\necho staged\n", "staged"],
    ].some(([text, mode]) => invokesMode(text, mode)) && invokesMode("#!/bin/sh\nset -e\nset +x\nnode tools/task-coverage.mjs --staged\necho staged\n", "staged")
      && invokesMode("#!/bin/sh\nnode tools/task-coverage.mjs --pre-push || exit 257\necho pushed\n", "pre-push")],
    ["a bare line still certifies where the shell carries its status — the hook's last command, after set -e, a CI step under bash -e", [
      ['#!/bin/sh\nnode tools/task-coverage.mjs --commit-msg "$1"\n', "commit-msg"],
      ["#!/bin/sh\nset -eu\nnode tools/task-coverage.mjs --staged\nnode tools/detached-head-guard.mjs\n", "staged"],
      ['      run: |\n          node tools/task-coverage.mjs --base "$BASE"\n          echo fenced\n', "fence"],
      ['sh -c "node tools/task-coverage.mjs --staged || exit 2"', "staged"],
    ].every(([text, mode]) => invokesMode(text, mode))],
  ];
  for (const [name, passes] of cases) if (!passes) fail(`task-coverage: ${name}`);
  return cases.length;
}

/** The errexit reading behind a bare hook line: which `set` turns errexit on, and which undoes it. */
function selfTestErrexitCases(fail) {
  const cases = [
    ["a set -e that may never run, or one a later set +e undoes anywhere, certifies nothing — indented in an if-branch or a function body, 'true; set +e', 'then set +o errexit', 'set -- -e', '|| exit 256' under set -e", ![
      ["#!/bin/sh\nif false; then\n  set -e\nfi\nnode tools/task-coverage.mjs --pre-push\nnode tools/task-coverage.mjs --doctor || exit 1\n", "pre-push"],
      ["#!/bin/sh\nstrict() {\n\tset -e\n}\nnode tools/task-coverage.mjs --staged\necho staged\n", "staged"],
      ["#!/bin/sh\nset -e\ntrue; set +e\nnode tools/task-coverage.mjs --staged\necho staged\n", "staged"],
      ["#!/bin/sh\nset -e\nif true; then set +o errexit; fi\nnode tools/task-coverage.mjs --pre-push\necho pushed\n", "pre-push"],
      ["#!/bin/sh\nset -- -e\nnode tools/task-coverage.mjs --staged\necho staged\n", "staged"],
      ["#!/bin/sh\nset -e\nnode tools/task-coverage.mjs --pre-push || exit 256\necho pushed\n", "pre-push"],
    ].some(([text, mode]) => invokesMode(text, mode)) && invokesMode("#!/bin/sh\nset -eu\n{ set -x; }\nnode tools/task-coverage.mjs --staged\necho staged\n", "staged")],
    ["a set +e in a condition, a negation, a case arm or behind a prefix word still undoes set -e — 'if', 'elif', 'while', 'until', '!', 'x)', 'command', 'eval', 'FOO=1'", ![
      "if set +e; then :; fi", "if false; then :; elif set +e; then :; fi", "while set +e; do break; done", "until set +e; do :; done",
      "! set +e", "case x in x) set +e;; esac", "command set +e", "eval set +e", "FOO=1 set +e",
    ].some((body) => invokesMode(`#!/bin/sh\nset -e\n${body}\nnode tools/task-coverage.mjs --staged\necho staged\n`, "staged"))],
    ["a column-0 set -e the shell reads as data turns nothing on — inside a multi-line quote, after a trailing backslash", ![
      '#!/bin/sh\necho "\nset -e\n"\nnode tools/task-coverage.mjs --staged\necho staged\n',
      "#!/bin/sh\necho '\nset -e\n'\nnode tools/task-coverage.mjs --staged\necho staged\n",
      "#!/bin/sh\necho \\\nset -e\nnode tools/task-coverage.mjs --staged\necho staged\n",
    ].some((text) => invokesMode(text, "staged")) && invokesMode("#!/bin/sh\necho \"a\nb\" # it's closed\nset -e\nnode tools/task-coverage.mjs --staged\necho staged\n", "staged")],
  ];
  for (const [name, passes] of cases) if (!passes) fail(`task-coverage: ${name}`);
  return cases.length;
}

/** The commit-msg law at its seam, driven end to end with git's facts as data — the transport
 *  only gathers them, so every verdict below is the one the hook prints. */
function selfTestCommitMsgCases(fail) {
  const verdict = commitMsgFixture();
  const key = `${["sk", "ant"].join("-")}-real0123456789abcdef`;
  const editorTail = "\n\n# Please enter the commit message for your changes. Lines starting\n# with '#' will be ignored, and an empty message aborts the commit.\n";
  const scissorsTail = "\n\n# ------------------------ >8 ------------------------\n# Do not modify or remove the line above.\ndiff --git a/tools/a.mjs b/tools/a.mjs\n+x\n";
  const refusalOf = (v) => v.refusal ?? "";
  const reRuns = (v) => refusalOf(v).includes("git -c commit.cleanup=strip commit -F .git/COMMIT_EDITMSG") && !refusalOf(v).includes("--amend");
  const cases = [
    ["commit-msg scans a footerless no-code commit for secrets", (verdict("chore: env", [".env.production"], { addedLines: [{ file: ".env.production", line: 1, text: `ANTHROPIC_API_KEY=${key}` }] }).refusal ?? "").includes(".env.production:1")],
    ["commit-msg refusals re-run the refused commit and never print --amend", reRuns(verdict("fix: x", ["tools/a.mjs"])) && reRuns(verdict("fix: x\n\ntask: nosuch", ["tools/a.mjs"]))],
    // mergeParents: per recorded parent (HEAD first), where the index differs and what that parent changed since the base.
    ["a merge staging only incoming code needs no footer while merge-own code still refuses", verdict("Merge branch 'feat'", ["tools/a.mjs"], { mergeParents: { diffs: [["tools/a.mjs"], ["docs/x.md"]], changes: [["docs/x.md"], ["tools/a.mjs"]] } }).ok !== undefined && verdict("Merge branch 'feat'", ["tools/a.mjs", "tools/evil.mjs"], { mergeParents: { diffs: [["tools/a.mjs", "tools/evil.mjs"], ["docs/x.md", "tools/evil.mjs"]], changes: [["docs/x.md"], ["tools/a.mjs"]] } }).refusal !== undefined],
    ["an editor-composed footer survives git's comment block and the scissors tail", verdict(`fix: x\n\ntask: t${editorTail}`, ["tools/a.mjs"]).ok !== undefined && verdict(`fix: x\n\ntask: t${scissorsTail}`, ["tools/a.mjs"]).ok !== undefined],
    ["a record refusal at commit time prints its rule and the exact advance", ["\n  rule: ", "\n  fix: node tools/task-state.mjs advance p executing"].every((part) => (verdict("fix: x\n\ntask: p", ["tools/a.mjs"]).refusal ?? "").includes(part))],
    ["the staged scan refusal prints its rule and the re-run", ["\n  rule: ", "\n  fix: remove the named line"].every((part) => (verdict("chore: x", ["a.ts"], { addedLines: [{ file: "a.ts", line: 9, text: "  debugger;" }] }).refusal ?? "").includes(part))],
    ["a docs-only task cites its own no-code commit while code under it still refuses", verdict("docs: x\n\ntask: d", ["CONTEXT.md"]).ok !== undefined && verdict("docs: x\n\ntask: d", ["tools/a.mjs"]).refusal !== undefined],
    ["a planned docs-only task cited on a no-code commit is told to advance, not to open a code task", refusalOf(verdict("docs: x\n\ntask: dp", ["CONTEXT.md"])).includes("\n  fix: node tools/task-state.mjs advance dp executing")],
    ["the re-run of a verbose editor's refused commit cuts the scissors tail (-v), so the fence reads the footer commit-msg read", refusalOf(verdict(`fix: x${scissorsTail}`, ["tools/a.mjs"])).includes("git -c commit.cleanup=strip commit -F .git/COMMIT_EDITMSG -v --trailer")],
    ["the commit-msg transport reads a staged diff past Node's 1 MiB default buffer", gitOutCarriesLargeOutput()],
  ];
  for (const [name, passes] of cases) if (!passes) fail(`task-coverage: ${name}`);
  return cases.length;
}

/** Every record refusal names its exact next command, derived in recordRefusal's own order. */
function selfTestRemedyCases(fail, record) {
  const pinlessDone = { schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created", at: "2026-09-17T00:00:00.000Z" }, { type: "transition", to: "planned" }, { type: "transition", to: "executing" }, { type: "transition", to: "verified" }, { type: "transition", to: "adversarial" }, { type: "transition", to: "done", at: "2026-09-19T00:00:00.000Z" }] };
  const lawfulRetired = { schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created", at: "2026-09-17T00:00:00.000Z" }, { type: "transition", to: "planned" }, { type: "retired", because: "x" }] };
  const cases = [
    ["an intake record's remedy advances it to planned", recordRemedy(record("runtime-code", []), "t").includes("advance t planned")],
    ["a planned record's remedy advances it to executing", recordRemedy(record("runtime-code", ["planned"]), "t").includes("advance t executing")],
    ["an unapproved protected record's remedy records the approval", recordRemedy(record("protected", ["planned", "executing"]), "t").includes("approve t --decision")],
    ["a protected record citing a vanished heading names the register, not a second approval", recordRemedy(record("protected", ["planned", "executing"], [{ type: "approval", decision: "2026-01-16 — I NEVER SAID THIS" }]), "t").includes("git log -p -- docs/decisions/DECISIONS.md")],
    ["a class that never writes code names a new runtime-code task", recordRemedy(record("planning-only", ["planned", "executing"]), "t").includes("--risk-class runtime-code")],
    ["a docs-only record cited for code names a new runtime-code task", recordRemedy(record("docs-only", ["planned", "executing"]), "t").includes("--risk-class runtime-code")],
    ["a docs-only record with no code staged gets its lifecycle remedy", recordRemedy(record("docs-only", ["planned"]), "t", false).includes("advance t executing")],
    ["a hand-edited record's remedy restores the machine-written copy", recordRemedy(pinlessDone, "t").includes("git checkout <last-machine-written-sha> -- tasks/t.json")],
    ["a wrong-schema record's remedy restores the machine-written copy", recordRemedy({ schema: "nope" }, "t").includes("git checkout")],
    ["a retired record's remedy names a successor task", recordRemedy(lawfulRetired, "t").includes("new <new-id>")],
  ];
  for (const [name, passes] of cases) if (!passes) fail(`task-coverage: ${name}`);
  return cases.length;
}

/** The flag parser's refusals, driven through the real CLI — parseFlags dies by design, so its
 *  witness is the exit code and the refusal it prints. */
function selfTestFlagCases(fail) {
  const refuses = (args, text) => {
    try {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
      return false;
    } catch (e) {
      return e.status === 1 && String(e.stderr).includes(text);
    }
  };
  const cases = [
    ["an unknown flag refuses with the usage", refuses(["--bogus"], "unknown flag: --bogus — usage:")],
    ["a repeated flag refuses", refuses(["--base", "HEAD", "--base", "HEAD"], "--base given more than once")],
    ["an empty inline value refuses", refuses(["--base="], "--base requires a non-empty value")],
    ["two modes in one invocation refuse", refuses(["--staged", "--doctor"], "are separate invocations")],
  ];
  for (const [name, passes] of cases) if (!passes) fail(`task-coverage: ${name}`);
  return cases.length;
}

/** The push fence's seams that read more than the range: the refs git is pushing. */
function selfTestPushCases(fail) {
  const zeros = "0".repeat(40);
  const input = `refs/heads/smuggle ${"1".repeat(40)} refs/heads/smuggle ${zeros}\nrefs/heads/main ${"2".repeat(40)} refs/heads/main ${"3".repeat(40)}\n(delete) ${zeros} refs/heads/old ${"4".repeat(40)}\n`;
  const cases = [
    ["a pushed ref outside HEAD's history is refused while HEAD's own history and deletions pass", unfencedPushTips(input, (sha) => sha.startsWith("2")).join() === "refs/heads/smuggle"],
    // git hands the hook the refspec's SOURCE verbatim, spaces included; `main` resolves in HEAD's
    // history exactly as it would for the real ancestry fact.
    ["a spaced refspec source cannot steer the sha the pre-push fence checks, and a line it cannot parse refuses", (() => {
      const inHistory = (rev) => rev === "main" || rev.startsWith("2");
      const outside = "1".repeat(40);
      return unfencedPushTips(`other^{/fix main bug} ${outside} refs/heads/main ${"3".repeat(40)}\n`, inHistory).join() === "other^{/fix main bug}"
        && unfencedPushTips(`other^{/revert 0 regressions} ${outside} refs/heads/y ${zeros}\n`, inHistory).length === 1
        && unfencedPushTips("garbled\n", inHistory).length === 1;
    })()],
  ];
  for (const [name, passes] of cases) if (!passes) fail(`task-coverage: ${name}`);
  return cases.length;
}

/** Self-test helper: a scratch git repo in `dir` that vendors this harness (tools/*.mjs, excluded
 *  from git so it never stages) and runs its CLI there — the transports judged against git's REAL
 *  output, not facts handed over as data. GIT_* is scrubbed (a hook's GIT_INDEX_FILE would aim
 *  these writes at the real index) and so is the user's config (a global hooksPath or signing key
 *  must not run here); CI too, which would skip the doctor's live checks. */
function scratchRepo(dir) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_") && k !== "CI")), HOME: dir, XDG_CONFIG_HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const git = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (path, text) => {
    mkdirSync(`${dir}/${path}`.replace(/\/[^/]*$/, ""), { recursive: true });
    writeFileSync(`${dir}/${path}`, text);
  };
  git("init", "-q");
  git("symbolic-ref", "HEAD", "refs/heads/main");
  for (const f of readdirSync(`${ROOT}tools`).filter((x) => x.endsWith(".mjs"))) write(`tools/${f}`, readFileSync(`${ROOT}tools/${f}`, "utf8"));
  write(".git/info/exclude", "tools/\n");
  const commit = (path, text, message) => {
    write(path, text);
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const message = (text) => {
    write(".git/STALLION_MSG", text);
    return `${dir}/.git/STALLION_MSG`;
  };
  const run = (args, extraEnv = {}, input = "") => {
    const r = spawnSync(process.execPath, [`${dir}/tools/task-coverage.mjs`, ...args], { cwd: dir, env: { ...env, ...extraEnv }, input, encoding: "utf8" });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  return { dir, git, write, commit, message, run };
}

/** Self-test helper: one scenario in a fresh scratch repo — a scenario that throws fails. */
function inScratchRepo(scenario) {
  const dir = mkdtempSync(`${tmpdir()}/task-coverage-repo-`);
  try {
    return scenario(scratchRepo(dir)) === true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A path git C-quotes: a new code file with a non-ASCII byte in its name, footerless. */
function quotedPathIsCode(r) {
  const root = r.commit("README.md", "x\n", "docs: root");
  r.write("apps/gaté.mjs", "export {};\n");
  r.git("add", "-A");
  const staged = r.run(["--staged"]);
  const commitMsg = r.run(["--commit-msg", r.message("feat: add a gate\n")]);
  r.git("commit", "-q", "-m", "feat: add a gate");
  const fence = r.run(["--base", root]);
  return staged.status === 1 && staged.out.includes("apps/gaté.mjs") && commitMsg.status === 1 && fence.status === 1 && fence.out.includes("touches code but carries no");
}

/** A rename out of the code trees: porcelain diff lists only the destination unless told not to. */
function renameOutIsCode(r) {
  r.commit("apps/gate.mjs", "export {};\n", "chore: root");
  r.write("docs/.keep", "");
  r.git("mv", "apps/gate.mjs", "docs/gate.txt");
  const staged = r.run(["--staged"]);
  const commitMsg = r.run(["--commit-msg", r.message("chore: move a file\n")]);
  return staged.status === 1 && staged.out.includes("apps/gate.mjs") && commitMsg.status === 1 && commitMsg.out.includes("apps/gate.mjs");
}

/** The stale-side reversion through plain porcelain: a side branch forked before a fix is merged,
 *  and the merge takes the side's (pre-fix) copy of the fixed file — with no footer. */
function staleSideMergeRefuses(r) {
  r.commit("apps/gate.mjs", "export const v = 1;\n", "chore: root");
  r.git("checkout", "-q", "-b", "side");
  r.commit("NOTE.md", "side\n", "docs: a side note");
  r.git("checkout", "-q", "main");
  const fix = r.commit("apps/gate.mjs", "export const v = 2;\n", "chore: the fix, settled before the base");
  r.git("merge", "-q", "--no-ff", "--no-commit", "side");
  const incoming = r.run(["--commit-msg", r.message("Merge branch 'side'\n")]);
  r.git("checkout", "side", "--", "apps/gate.mjs");
  const reverted = r.run(["--commit-msg", r.message("Merge branch 'side'\n")]);
  r.git("commit", "-q", "-m", "Merge branch 'side'");
  const fence = r.run(["--base", fix]);
  return incoming.status === 0 && reverted.status === 1 && reverted.out.includes("apps/gate.mjs") && fence.status === 1 && fence.out.includes("touches code but carries no");
}

/** A merge git resolves cleanly, committed as git wrote it, where one side's change already sits
 *  in the other (a cherry-pick): nothing in it is the merge's own — only the side's commit is
 *  judged, as its own. */
function subsumedChangeMergePasses(r) {
  const gate = (a, b) => `export const a = ${a};\n\n\n\n\n\nexport const b = ${b};\n`;
  r.commit("apps/gate.mjs", gate(1, 1), "chore: root");
  r.git("checkout", "-q", "-b", "side");
  const side = r.commit("apps/gate.mjs", gate(2, 1), "fix: a");
  r.git("checkout", "-q", "main");
  r.git("cherry-pick", "-x", side);
  r.commit("apps/gate.mjs", gate(2, 2), "fix: b");
  r.git("merge", "-q", "--no-ff", "--no-commit", "side");
  const commitMsg = r.run(["--commit-msg", r.message("Merge branch 'side'\n")]);
  r.git("commit", "-q", "-m", "Merge branch 'side'");
  const fence = r.run(["--base", "HEAD^1"]);
  return commitMsg.status === 0 && fence.out.includes(`✖ ${side.slice(0, 8)} touches code`) && !fence.out.includes(`✖ ${r.git("rev-parse", "HEAD").slice(0, 8)}`);
}

/** A conflict's resolution is the merge's own: a file the mainline deleted, restored from the side
 *  that modified it — the copy git leaves in its own merged tree, so only the conflict marks it. */
function conflictResolutionIsOwn(r) {
  r.commit("apps/old.mjs", "export const v = 1;\n", "chore: root");
  r.git("checkout", "-q", "-b", "side");
  r.commit("apps/old.mjs", "export const v = 2;\n", "fix: side");
  r.git("checkout", "-q", "main");
  r.git("rm", "-q", "apps/old.mjs");
  r.git("commit", "-q", "-m", "chore: retire old");
  const tip = r.git("rev-parse", "HEAD");
  try {
    r.git("merge", "-q", "--no-ff", "--no-commit", "side");
  } catch {
    // modify/delete: git stops for the resolution this scenario makes
  }
  r.git("add", "apps/old.mjs");
  const commitMsg = r.run(["--commit-msg", r.message("Merge branch 'side'\n")]);
  r.git("commit", "-q", "-m", "Merge branch 'side'");
  const fence = r.run(["--base", tip]);
  return commitMsg.status === 1 && commitMsg.out.includes("apps/old.mjs") && fence.out.includes(`✖ ${r.git("rev-parse", "HEAD").slice(0, 8)} touches code`);
}

/** A merge with no base git can see (unrelated histories, a shallow clone's cut): every path that
 *  differs from a parent is judged — the orphan side's stale copy of a mainline file included. */
function baselessMergeJudgesEveryDifference(r) {
  const tip = r.commit("apps/gate.mjs", "export const v = 2;\n", "chore: root");
  r.git("checkout", "-q", "--orphan", "old");
  r.commit("apps/gate.mjs", "export const v = 1;\n", "chore: an unrelated root");
  r.git("checkout", "-q", "main");
  r.git("merge", "-q", "--no-commit", "--allow-unrelated-histories", "-s", "ours", "old");
  r.git("checkout", "old", "--", "apps/gate.mjs");
  const commitMsg = r.run(["--commit-msg", r.message("Merge branch 'old'\n")]);
  r.git("commit", "-q", "-m", "Merge branch 'old'");
  const fence = r.run(["--base", tip]);
  return commitMsg.status === 1 && commitMsg.out.includes("apps/gate.mjs") && fence.out.includes(`✖ ${r.git("rev-parse", "HEAD").slice(0, 8)} touches code`);
}

/** Hand-written MERGE_HEADs git reduces away: an ancestor alone (git records one parent), and an
 *  octopus whose ancestor parent git drops while the file it last touched differs from both kept
 *  parents — commit-msg must judge the parents git will record. */
function reducedParentsNarrowNothing(r) {
  const root = r.commit("apps/gate.mjs", "export const v = 1;\n", "chore: root");
  r.commit("apps/gate.mjs", "export const v = 2;\n", "chore: the fix");
  r.git("checkout", root, "--", "apps/gate.mjs");
  r.write(".git/MERGE_HEAD", `${root}\n`);
  const ancestor = r.run(["--commit-msg", r.message("Merge branch 'registry'\n")]);
  r.git("reset", "-q", "--hard");
  r.git("checkout", "-q", "-b", "other", root);
  const other = r.commit("NOTE.md", "other\n", "docs: other");
  r.git("checkout", "-q", "main");
  const q = r.commit("apps/gate.mjs", "export const v = 3;\n", "chore: q");
  r.commit("apps/gate.mjs", "export const v = 1;\n", "chore: s restores v1");
  r.git("merge", "-q", "--no-commit", other);
  r.git("checkout", q, "--", "apps/gate.mjs");
  r.write(".git/MERGE_HEAD", `${q}\n${other}\n`);
  const octopus = r.run(["--commit-msg", r.message("Merge q and other\n")]);
  return ancestor.status === 1 && ancestor.out.includes("apps/gate.mjs") && octopus.status === 1 && octopus.out.includes("apps/gate.mjs");
}

/** An octopus git records whole (MERGE_MODE no-ff): its one base predates the mainline's fix,
 *  so only the first-parent reading sees the stale copy an ancestor parent brings back. */
function octopusAnswersToFirstParent(r) {
  const root = r.commit("apps/gate.mjs", "export const v = 1;\n", "chore: root");
  r.git("checkout", "-q", "-b", "other", root);
  const other = r.commit("NOTE.md", "other\n", "docs: other");
  r.git("checkout", "-q", "main");
  const q = r.commit("apps/gate.mjs", "export const v = 3;\n", "chore: q");
  const s = r.commit("apps/gate.mjs", "export const v = 1;\n", "chore: s fixes q");
  r.git("merge", "-q", "--no-commit", other);
  r.git("checkout", q, "--", "apps/gate.mjs");
  r.write(".git/MERGE_HEAD", `${q}\n${other}\n`);
  r.write(".git/MERGE_MODE", "no-ff");
  const commitMsg = r.run(["--commit-msg", r.message("Merge q and other\n")]);
  r.git("commit", "-q", "-m", "Merge q and other");
  const fence = r.run(["--base", s]);
  return commitMsg.status === 1 && r.git("show", "-s", "--format=%P").split(" ").length === 3 && fence.status === 1 && fence.out.includes("touches code but carries no");
}

/** A porcelain octopus from a HEAD both heads contain: git drops HEAD and records a two-parent
 *  merge, so commit-msg judges that merge — incoming code from a side is not the merge's own.
 *  Under MERGE_MODE no-ff git keeps HEAD, records the octopus, and the octopus law applies. */
function porcelainOctopusIsJudgedAsRecorded(r) {
  const root = r.commit("README.md", "x\n", "docs: root");
  r.git("checkout", "-q", "-b", "x");
  const x = r.commit("apps/a.mjs", "export {};\n", "feat: a, judged as its own commit");
  r.git("checkout", "-q", "-b", "y", root);
  const y = r.commit("docs/y.md", "y\n", "docs: y");
  r.git("checkout", "-q", "main");
  r.git("merge", "-q", "--no-commit", x, y);
  const reduced = r.run(["--commit-msg", r.message("Merge x and y\n")]);
  r.write(".git/MERGE_MODE", "no-ff");
  const kept = r.run(["--commit-msg", r.message("Merge x and y\n")]);
  return reduced.status === 0 && kept.status === 1 && kept.out.includes("apps/a.mjs");
}

/** git's cleanup as the hook sees it: no editor (GIT_EDITOR=:) keeps '#' lines; commit.cleanup=strip,
 *  handed down through `git -c`, strips them. */
function noEditorKeepsHashLines(r) {
  r.commit("README.md", "x\n", "docs: root");
  r.write("apps/a.mjs", "export {};\n");
  r.git("add", "-A");
  const msg = r.message("fix: x\n\ntask: nosuch\n\n#123 follow-up\n");
  const raw = r.run(["--commit-msg", msg], { GIT_EDITOR: ":" });
  const strip = r.run(["--commit-msg", msg], { GIT_EDITOR: ":", GIT_CONFIG_PARAMETERS: "'commit.cleanup=strip'" });
  return raw.status === 1 && raw.out.includes("carries no 'task: <id>' footer") && strip.status === 1 && strip.out.includes("no task record for 'nosuch'");
}

/** The pre-push transport itself: git's stdin lines, the real ancestry fact, the dispatch. */
function prePushTransport(r) {
  const root = r.commit("README.md", "x\n", "docs: root");
  r.git("checkout", "-q", "-b", "side");
  const side = r.commit("NOTE.md", "side\n", "docs: side");
  r.git("checkout", "-q", "main");
  r.commit("CHANGES.md", "y\n", "docs: main");
  const zeros = "0".repeat(40);
  const push = (line) => r.run(["--pre-push", "--base", root], {}, `${line}\n`);
  const ancestor = push(`refs/heads/old ${root} refs/heads/old ${zeros}`);
  const outside = push(`refs/heads/side ${side} refs/heads/side ${zeros}`);
  return ancestor.status === 0 && outside.status === 1 && outside.out.includes("outside the checked-out history: refs/heads/side");
}

/** The doctor over committed and live hooks as this harness wires them: a bare pre-push and a
 *  pre-commit without the detached-head guard are refused, the wired forms certified. */
function doctorSeesHookControls(r) {
  const writeHooks = (prePush, preCommit) => {
    r.write(".githooks/pre-push", `#!/bin/sh\n${prePush}\n`);
    r.write(".githooks/pre-commit", `#!/bin/sh\n${preCommit}\n`);
    r.write(".githooks/commit-msg", '#!/bin/sh\nnode tools/task-coverage.mjs --commit-msg "$1" || exit 1\n');
    r.git("add", "-A");
    r.git("commit", "-q", "-m", "chore: hooks");
    r.git("config", "core.hooksPath", ".githooks");
    const out = r.run(["--doctor"]).out;
    r.git("config", "--unset", "core.hooksPath");
    return out;
  };
  const stale = writeHooks("node tools/task-coverage.mjs || exit 1", "node tools/task-coverage.mjs --staged || exit 1");
  const wired = writeHooks("node tools/task-coverage.mjs --pre-push || exit 1", "node tools/task-coverage.mjs --staged || exit 1\nnode tools/detached-head-guard.mjs || exit 1");
  const checks = ["pre-push hook committed and invoking the push fence", "pre-commit detached-head guard committed", "core.hooksPath points at a wired pre-push", "core.hooksPath points at a pre-commit running the detached-head guard"];
  return checks.every((name) => stale.includes(`✖ ${name}`) && wired.includes(`✔ ${name}`));
}

/** The real registry's contract over doctorRunsGateRegistry's one-gate fixture: silent exit 0 while
 *  the battery chain is clean, its refusal line and exit 1 once an `||` breaks it. */
const GATE_REGISTRY_DOUBLE = `import { readFileSync } from "node:fs";
if (JSON.parse(readFileSync("package.json", "utf8")).scripts.selftest.includes("||")) {
  console.error("gate-registry: gate 'lint' is declared to run in battery (package.json scripts.selftest) but the file does not carry it");
  process.exit(1);
}
`;

/** The doctor re-runs the gate registry: package.json, the battery's transport, is no fence
 *  surface, so a battery gate swallowed in a footerless commit must refuse where the gated party
 *  cannot reach — the doctor's pre-push and CI runs — with the registry's own lines as evidence.
 *  The vendored registry runs live; a harness that vendors none (the bench kit's minimal arm, whose
 *  battery must be green on day one) gets a double honouring the real CLI's contract here. */
function doctorRunsGateRegistry(r) {
  if (!existsSync(`${r.dir}/tools/gate-registry.mjs`)) r.write("tools/gate-registry.mjs", GATE_REGISTRY_DOUBLE);
  r.write("docs/gates/gate-registry.json", JSON.stringify({ gates: [{ id: "lint", invocation: "node tools/test-lint.mjs tools", transports: ["battery"], why: "x" }] }));
  for (const hook of ["pre-commit", "commit-msg", "pre-push"]) r.write(`.githooks/${hook}`, "#!/bin/sh\n");
  const doctor = (selftest) => {
    r.commit("package.json", JSON.stringify({ scripts: { selftest } }), "chore: battery");
    return r.run(["--doctor"]).out;
  };
  const check = "the gate registry holds — every declared gate carried by its transports, the battery (package.json) included";
  const kept = doctor("node tools/test-lint.mjs tools");
  const swallowed = doctor("node tools/test-lint.mjs tools || true");
  return kept.includes(`✔ ${check}`) && swallowed.includes(`✖ ${check}`) && swallowed.includes("evidence: gate-registry: gate 'lint' is declared to run in battery") && swallowed.includes("fix: bring the transports back to docs/gates/gate-registry.json");
}

/** A harness that vendors no registry has a battery nothing guards: the doctor refuses in one line
 *  and names the vendoring fix — never a loader stack trace, never a pass. */
function doctorRefusesAbsentRegistry(r) {
  rmSync(`${r.dir}/tools/gate-registry.mjs`, { force: true });
  r.commit("package.json", JSON.stringify({ scripts: { selftest: "node tools/test-lint.mjs tools" } }), "chore: battery");
  const out = r.run(["--doctor"]).out;
  return out.includes("✖ the gate registry holds") && out.includes("evidence: tools/gate-registry.mjs is absent — the battery (package.json) runs unguarded\n") && out.includes("fix: vendor tools/gate-registry.mjs and docs/gates/gate-registry.json") && !out.includes("Cannot find module");
}

/** The transports end to end, in scratch repos: the pure seams take git's facts as data, so only
 *  here do git's quoting, rename detection, merge state, cleanup, and pre-push stdin reach them. */
function selfTestTransportCases(fail) {
  const cases = [
    ["a code path git C-quotes, non-ASCII, is code at the staged gate, commit-msg, and the fence", inScratchRepo(quotedPathIsCode)],
    ["a rename out of the code trees is judged as the code deletion it is at the staged gate and commit-msg", inScratchRepo(renameOutIsCode)],
    ["a merge that takes a stale side's copy over the mainline's fix refuses at commit-msg and the fence", inScratchRepo(staleSideMergeRefuses)],
    ["a clean merge whose side change the mainline already holds (a cherry-pick) is not the merge's own at commit-msg or the fence", inScratchRepo(subsumedChangeMergePasses)],
    ["a merge with no resolvable base judges every differing path at commit-msg and the fence — an orphan side's stale copy refuses", inScratchRepo(baselessMergeJudgesEveryDifference)],
    ["a conflict's resolution is the merge's own at commit-msg and the fence, even where it matches git's merged tree", inScratchRepo(conflictResolutionIsOwn)],
    ["a hand-written MERGE_HEAD parent git will reduce away narrows nothing at commit-msg", inScratchRepo(reducedParentsNarrowNothing)],
    ["an octopus answers for everything it brings its first parent at commit-msg and the fence", inScratchRepo(octopusAnswersToFirstParent)],
    ["a porcelain octopus is judged as the merge git records: HEAD dropped, a two-parent merge; no-ff, the octopus", inScratchRepo(porcelainOctopusIsJudgedAsRecorded)],
    ["commit-msg reads the message git will commit: no editor keeps '#' lines, commit.cleanup=strip drops them", inScratchRepo(noEditorKeepsHashLines)],
    ["the pre-push transport judges git's stdin refs through the real ancestry fact", inScratchRepo(prePushTransport)],
    ["the doctor refuses a bare pre-push and a guardless pre-commit, committed and live, and certifies the wired forms", inScratchRepo(doctorSeesHookControls)],
    ["the doctor runs the gate registry: a battery gate swallowed in package.json refuses with the registry's lines, the carried battery passes", inScratchRepo(doctorRunsGateRegistry)],
    ["the doctor refuses an absent gate registry in one line with a vendoring fix", inScratchRepo(doctorRefusesAbsentRegistry)],
  ];
  for (const [name, passes] of cases) if (!passes) fail(`task-coverage: ${name}`);
  return cases.length;
}

/** The retire law at the seams: citation, record naming, and the staged gate's master-key inverse.
 *  Named selfTest* so reader-existence's corpus cut treats its fixtures as tests, not production
 *  uses — a run*-named helper once suppressed the RISK_CLASSES.runtime-code verdict and its
 *  accepted row was pruned as stale by the very wave that blinded it (an adversarial finding). */
function selfTestRetirementSeamCases(fail, record, scopedPost) {
  // The DISCRIMINATING staged-gate shape: executing-then-retired. A planned-then-retired fixture
  // proves nothing — planned already refused pre-retirement, so the case passed against the
  // broken seam too (an adversarial finding: a vacuous pin).
  const retiredRecord = record("runtime-code", ["planned", "executing"], [{ type: "retired", because: "superseded by x" }]);
  const cases = [
    ["a retired task refuses re-judged history too — no commit ever lawfully cited it", citationRefusal({ ...scopedPost, events: [...scopedPost.events, { type: "retired", because: "x" }] }, ["tools/a.mjs"], false) !== null],
    ["recordRefusal names the retirement instead of the pre-executing line", (recordRefusal(retiredRecord) ?? "").includes("retired")],
    ["a retired task does not keep the staged gate open (the master-key inverse)", stagedRefusal(["apps/a.ts"], [retiredRecord]) !== null],
  ];
  for (const [name, passes] of cases) if (!passes) fail(`task-coverage: ${name}`);
  return cases.length;
}

/** The retire law's hand-forgery shapes, re-judged at the fence like every other shape law. */
function selfTestRetirementShapeCases(fail) {
  const cases = [
    ["an event after retirement is a hand-forged shape", (recordRefusal({ schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created", at: "2026-09-17T00:00:00.000Z" }, { type: "transition", to: "planned" }, { type: "retired", because: "x" }, { type: "scope", patterns: ["tools/**"] }] }) ?? "").includes("follows the retired event")],
    ["retirement past planned is a hand-forged shape", (retirementShapeRefusal([{ type: "created" }, { type: "transition", to: "planned" }, { type: "transition", to: "executing" }, { type: "retired", because: "x" }]) ?? "").includes("lawful only before executing")],
    ["a double retirement is caught by the once-only shape law", (retirementShapeRefusal([{ type: "created" }, { type: "retired", because: "a" }, { type: "retired", because: "b" }]) ?? "").includes("follows the retired event")],
    ["a lawful retirement record carries a clean shape", retirementShapeRefusal([{ type: "created" }, { type: "transition", to: "planned" }, { type: "retired", because: "x" }]) === null],
    ["a lawful retired record refuses at the fence with the authorizes-nothing reason", (() => {
      const lawful = { schema: "stallion/task-state@1", id: "t", riskClass: "runtime-code", events: [{ type: "created", at: "2026-09-17T00:00:00.000Z" }, { type: "transition", to: "planned" }, { type: "retired", because: "x" }] };
      return (recordRefusal(lawful) ?? "").includes("authorizes nothing");
    })()],
    ["records without retirement events never trip the shape law", retirementShapeRefusal([{ type: "created" }, { type: "transition", to: "executing" }]) === null],
  ];
  for (const [name, passes] of cases) if (!passes) fail(`task-coverage: ${name}`);
  return cases.length;
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
  const flags = parseFlags(process.argv.slice(2));
  if (flags["self-test"]) process.exit(selfTest() ? 0 : 1);
  if (flags["commit-msg"]) { cmdCommitMsg(flags["commit-msg"]); process.exit(0); }
  if (flags.staged) { cmdStaged(); process.exit(0); }
  if (flags.doctor) { cmdDoctor(); process.exit(0); }
  if (flags["pre-push"]) fencePushedRefs();
  const { base, refusal: baseRefusal } = resolvePushBase(flags.base ?? null);
  if (baseRefusal) die(`${baseRefusal.evidence}\n  rule: ${baseRefusal.rule}\n  fix: ${baseRefusal.fix}`);
  // The moved-base law: a push that moves .stallion-base is judged exactly once, from the OLD
  // base (the remote tip's copy). Only an explicit base EQUAL to the old value skips the
  // refusal — a tier-wide exemption let config=NEW-base skip the audit entirely (an
  // adversarial replay proved the smuggle). With no anchor, skip visibly; never fall back to
  // the base-commit copy, which always predates the move and bricked detached clones forever.
  // The audit anchor — the settled remote tip (or the explicit base a CI fence step supplies):
  // the one input outside this push. It anchors BOTH the moved-base audit and the done-citation
  // law. No anchor = visible skips, never silent bricks.
  const guardBranch = [currentBranch(), remoteHeadBranch()].find((c) => c && revParseOk(`origin/${c}`))
    ?? [currentBranch(), remoteHeadBranch()].find(Boolean) ?? "";
  const originOk = revParseOk(`origin/${guardBranch}`);
  if (originOk) {
    const oldBaseRequired = movedBaseVerdict(flags.base ?? gitConfig("stallion.push-base"), committedTextAt(`origin/${guardBranch}`, ".stallion-base"), committedText(".stallion-base"));
    if (oldBaseRequired !== null) {
      die(`the adoption base moves in THIS push and is not being audited from the OLD base\n  rule: a base move is judged exactly once, from the old base\n  fix: git config stallion.push-base <old-base-sha>   — the EXACT value in origin's copy of .stallion-base, byte-for-byte — then push, then unset`);
    }
  } else {
    console.log("task-coverage: ~ moved-base check skipped — no remote tip anchor resolvable (no origin/<branch>, no origin/HEAD)");
  }
  const anchorRef = flags.base ?? (originOk ? `origin/${guardBranch}` : null);
  const errors = checkRange(base, anchorRef);
  if (errors.length > 0) {
    for (const e of errors) console.error(`task-coverage: ✖ ${e}`);
    die("CODE LANDED OUTSIDE THE LIFECYCLE — nothing was pushed. Record the task (task-state new), advance it, and carry 'task: <id>' in the commit message.");
  }
  console.log(`task-coverage: every code commit in ${base}..HEAD carries an authorizing task record.`);
}
