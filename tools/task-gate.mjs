#!/usr/bin/env node
/**
 * Task gate — the intervention layer (from the ECC study, issues #14; built 2026-09-19).
 *
 * stallion's other gates refuse at TRANSPORT boundaries (commit, push). This one refuses at
 * ACT boundaries, inside the agent's own tool loop, on the pattern ECC's GateGuard proved:
 * asking "are you sure?" gets "yes"; demanding concrete FACTS gets investigation, and the act
 * of investigation creates the awareness self-evaluation never did.
 *
 * Three laws, one small surface:
 *   --edit <file>    deny-once per file per session: the FIRST mutating touch refuses with a
 *                    fact demand (importers, affected surface, the user's instruction verbatim);
 *                    the retry passes. Marked asked; state TTLs out so a stale session re-asks.
 *   --bash <command> two classes: BYPASS (--no-verify, -c core.hocksPath= on gate-carrying git
 *                    commands) refuses ALWAYS — it is a law, not a fact request; DESTRUCTIVE
 *                    commands (rm -rf, reset --hard, push --force, commit --amend, SQL drops…)
 *                    deny-once per session with a rollback demand. Quote-aware: a flag-looking
 *                    VALUE inside quotes is not a flag.
 *   --self-test      the refusals are the feature; every classifier proven both directions.
 *
 * Denial dampening (ECC's empirical find): identical repeated denials push models into loops,
 * so denials condense after the third and always carry an ordinal — never textually identical
 * twice. And a hook sees one call at a time: edit denials say the batch truth out loud ("other
 * edits in this batch may already be applied — re-read the file").
 *
 * State: .stallion/gate-state-<session>.json — repo-local (stallion gets vendored; session
 * state must not leak across repos), atomic writes through the shared task-findings lock,
 * 30-minute TTL, bounded to 500 targets. The directory is gitignored; nothing here is law.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { atomicWriteJson, withLock } from "./task-findings.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STATE_DIR = `${ROOT}.stallion`;
const TTL_MS = 30 * 60 * 1000;
const MAX_TARGETS = 500;

/**
 * The classifier's view of a command, closing the parser differential an adversarial pass
 * caught: a SINGLE-TOKEN quoted segment is the token itself (git commit '--no-verify' means
 * --no-verify — the shell strips those quotes), while a MULTI-token quoted segment is a payload
 * or value (a -m message) and is removed. And a quoted payload following sh/bash (with any
 * short flags) IS a command: it is appended for classification, one level deep — nested
 * wrappers beyond that are the documented boundary, not a solved problem.
 */
export function classifiedText(command) {
  const raw = String(command ?? "");
  // Payloads worth classifying as commands: any *sh (sh, bash, zsh, dash, ksh…) and eval,
  // each with up to a few flags, then ONE quoted payload. One level deep — the boundary.
  const payloadRegex = /(?:^|[\s;&|])(?:[a-z]{0,6}sh\d?|eval)\s+(?:-{1,2}[a-zA-Z][\w-]*\s+){0,3}('([^']*)'|"((?:[^"\\]|\\.)*)"|\$'([^']*)')/g;
  const payloads = [];
  for (const m of raw.matchAll(payloadRegex)) payloads.push(m[2] ?? m[3] ?? m[4] ?? "");
  // Backslash-escaped characters are their characters to the shell: git reset \-\-hard IS
  // --hard. Normalized BEFORE quote handling (an escaped quote stays structural).
  const unescaped = raw.replace(/\\(.)/g, "$1");
  const unwrapped = unescaped.replace(/\$?'([^']*)'|"((?:[^"\\]|\\.)*)"/g, (whole, sq, dq) => {
    const inner = sq !== undefined ? sq.replace(/^\$/, "") : dq;
    return /\s/.test(inner) ? " " : inner;
  });
  return [unwrapped, ...payloads].join("\n");
}

/** Back-compat alias: the single-view form (tests and callers). */
export const unquoted = classifiedText;

const GIT_HOOKED = /(?:^|\s)(?:commit|merge|cherry-pick|rebase|am)(?:\s|$)/;

/** Pure: does this command attempt to bypass the gates? ALWAYS refused — not a fact request. */
export function bypassRefusal(command) {
  const t = unquoted(command);
  const git = /(?:^|\s)git\s+/.test(t);
  if (!git) return null;
  if (GIT_HOOKED.test(t) && (/(?:^|\s)--no-verify(?:\s|$)/.test(t) || (/(?:^|\s)commit\s/.test(t) && /(?:^|\s)-n(?:\s|$)/.test(t)))) {
    return "this command bypasses the commit hooks (--no-verify / commit -n) — the hooks ARE the gates; run them";
  }
  if (/(?:^|\s)-c\s+core\.hooksPath=/.test(t)) {
    return "this command re-points core.hooksPath — the hooks are the fence; do not move them to run without them";
  }
  const cfg = /git\s+config\s+(?:--[\w-]+\s+)*core\.hooksPath\s+(\S+)/.exec(t);
  if (cfg && cfg[1] !== ".githooks") {
    return "this command re-points core.hooksPath somewhere other than the committed .githooks — the hooks are the fence; only the documented activation (git config core.hooksPath .githooks) is legal";
  }
  if (/git\s+config\s+(?:--[\w-]+\s+)*--unset\s+core\.hooksPath/.test(t)) {
    return "unsetting core.hooksPath deactivates every committed hook for this clone — if you mean to re-activate, set it back to .githooks instead";
  }
  return null;
}

/** [pattern, name, where]: FLAG-shaped dangers match the UNQUOTED command (a flag-looking
 *  value inside quotes is not a flag); CONTENT-shaped dangers (SQL payloads) match the RAW
 *  command, because the payload lives inside the quotes. */
const DESTRUCTIVE = [
  [/\brm\s+[^;|&]*-(?:[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r|[a-zA-Z]*r)/, "recursive forced delete", "unquoted"],
  [/\brm\s+-[a-zA-Z]*r/, "recursive delete", "unquoted"],
  [/git\s+reset\s+--hard/, "hard reset (uncommitted work is unrecoverable)", "unquoted"],
  [/git\s+(?:checkout\s+--|checkout\s+\.|restore\s+(?!--staged))/, "discard working-tree changes", "unquoted"],
  [/git\s+clean\s+-[a-zA-Z]*f/, "clean -f (untracked files are unrecoverable)", "unquoted"],
  [/git\s+push\s+[^;|&]*(?:--force(?:\s|$|=)|(?:^|\s)-f(?:\s)|\+refs\/)/, "force push (rewrites remote history)", "unquoted"],
  [/git\s+commit\s+[^;|&]*--amend/, "amend (rewrites an existing commit)", "unquoted"],
  [/git\s+rm\s+[^;|&]*-r/, "recursive git rm", "unquoted"],
  [/git\s+switch\s+[^;|&]*(?:-f|-C)\s/, "forced branch switch (discards local changes)", "unquoted"],
  [/find\s+[^;|&]*-exec\s+rm/, "find -exec rm", "unquoted"],
  [/\bdd\s+[^;|&]*if=/, "dd (raw device write)", "unquoted"],
  [/\b(?:DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i, "bulk SQL data loss", "raw"],
];

/** Pure: is this command destructive? Returns the human name of the danger, or null.
 *  Compounds are judged SEGMENT by segment (an adversarial pass caught the whole-string
 *  lease exemption nullifying a chained rm -rf); --force-with-lease exempts only its own
 *  segment — the lease is that push's safety, not the compound's. */
export function commandSegments(command) {
  const raw = String(command ?? "");
  const segments = raw.split(/[\n;]|&&|\|\||\|&|\||&/).map((x) => x.trim()).filter(Boolean);
  // sh -c payloads are commands too — appended as their own segments, one level deep
  const payloadRegex = /(?:^|[\s;&|])(?:\ba|ba)?sh\s+(?:-[a-zA-Z]+\s+){0,3}('([^']*)'|"((?:[^"\\]|\\.)*)")/g;
  for (const m of raw.matchAll(payloadRegex)) segments.push(m[2] ?? m[3] ?? "");
  return segments;
}

export function destructiveAs(command) {
  for (const segment of commandSegments(command)) {
    if (/git\s+push\s+[^;|&]*--force-with-lease/.test(segment)) continue;
    for (const [pattern, name, where] of DESTRUCTIVE) {
      if (pattern.test(where === "raw" ? segment : unquoted(segment))) return name;
    }
  }
  return null;
}

/** Pure: the full fact demand for a first touch. The facts are the point — not the refusal. */
export function editFactDemand(path) {
  return [
    `Before editing ${path}, present these facts:`,
    "1. List the files that import, require, or reference this file (search the tree — grep/glob, then read the hits).",
    "2. Name the public surface affected: the functions, types, or files callers see.",
    "3. If this file reads or writes data, name the fields, their shape, and their date format.",
    "4. Quote the user's current instruction verbatim, and name the in-flight task whose scope covers this file.",
    "Other edits in this batch may already be applied — re-read the file before retrying.",
  ].join("\n");
}

/** Pure: the fact demand for a first destructive command. */
export function bashFactDemand(command, danger) {
  return [
    `This command is a ${danger}: ${command}`,
    "Before running it, state:",
    "1. Every file, branch, or data row this command will modify or delete.",
    "2. A one-line rollback procedure for each.",
    "3. The user's current instruction, verbatim, that authorizes exactly this.",
  ].join("\n");
}

function statePath(session) {
  const safe = String(session ?? "default").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
  return `${STATE_DIR}/gate-state-${safe}.json`;
}

function loadState(path, nowMs) {
  if (!existsSync(path)) return { version: 1, entries: {} };
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (state && typeof state === "object" && state.entries && typeof state.entries === "object") {
      for (const key of Object.keys(state.entries)) {
        if (typeof state.entries[key]?.askedAt !== "number" || nowMs - state.entries[key].askedAt > TTL_MS) {
          delete state.entries[key];
        }
      }
      // The ordinal counter TTLs with everything else — a session months later gets full
      // demands again, never a condensed line citing denials it never saw (a sweep finding).
      const counterAge = typeof state.sessionDenialsAt === "number" ? nowMs - state.sessionDenialsAt : Infinity;
      const denials = counterAge <= TTL_MS && typeof state.sessionDenials === "number" ? state.sessionDenials : 0;
      return { version: 1, sessionDenials: denials, sessionDenialsAt: counterAge <= TTL_MS ? state.sessionDenialsAt : undefined, entries: state.entries };
    }
  } catch {
    // unreadable state re-asks — a gate that cannot read state errs toward asking again
  }
  return { version: 1, entries: {} };
}

function saveState(path, state, nowMs) {
  mkdirSync(STATE_DIR, { recursive: true });
  const keys = Object.keys(state.entries);
  if (keys.length > MAX_TARGETS) {
    keys.sort((a, b) => state.entries[a].askedAt - state.entries[b].askedAt);
    for (const key of keys.slice(0, keys.length - MAX_TARGETS)) delete state.entries[key];
  }
  atomicWriteJson(path, state);
}

/**
 * The deny-once decision, pure over the state object. Per target: first fresh touch REFUSES
 * with the full demand; the retry (and every later touch until the TTL expires) passes. The
 * dampening counter is SESSION-wide (ECC's shape): every refusal carries a strictly increasing
 * ordinal — so no two denial texts are ever identical — and from the fourth denial on, the
 * message condenses to one line pointing back at the full demands already shown.
 */
export function gateDecision(state, target, fullDemand, nowMs) {
  const prior = typeof state.sessionDenials === "number" ? state.sessionDenials : 0;
  const entry = state.entries[target];
  const fresh = entry && typeof entry.askedAt === "number" && nowMs - entry.askedAt <= TTL_MS;
  if (fresh) return { refuse: false, text: `asked — proceeding (${target})`, next: state };
  const n = prior + 1;
  const text = n <= 3
    ? `${fullDemand}\n[denial #${n} this session]`
    : `${target}: denial #${n} this session — present the facts and retry, or change the plan; the full demands were shown at denials 1-3`;
  return { refuse: true, text, next: { ...state, sessionDenials: n, sessionDenialsAt: nowMs, entries: { ...state.entries, [target]: { askedAt: nowMs } } } };
}

function die(message) {
  console.error(`task-gate: ✖ REFUSED — ${message}`);
  process.exit(1);
}

function runGate(target, fullDemand, session) {
  const path = statePath(session);
  mkdirSync(STATE_DIR, { recursive: true }); // the lockfile lives here before any state does
  const nowMs = Date.now();
  let outcome;
  withLock(path, () => {
    const state = loadState(path, nowMs);
    outcome = gateDecision(state, target, fullDemand, nowMs);
    saveState(path, outcome.next, nowMs);
  });
  if (outcome.refuse) die(outcome.text);
  console.log(`task-gate: facts presented for ${target} — proceeding.`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--self-test") { args["self-test"] = true; continue; }
    if (a === "--edit" || a === "--bash" || a === "--session") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        console.error(`task-gate: --${a.slice(2)} requires a value`);
        process.exit(1);
      }
      args[a.slice(2)] = next;
      i += 1;
      continue;
    }
    console.error(`task-gate: unknown flag: ${a} — usage: task-gate.mjs --edit <file> | --bash <command> [--session <id>] (--self-test)`);
    process.exit(1);
  }
  return args;
}

/** Self-test: the refusals are the feature — classifiers and damping proven both directions. */
export function selfTest() {
  const failures = [];
  const fail = (m) => failures.push(m);
  const cases = [
    ["--no-verify on commit is a bypass", bypassRefusal(`git commit --no-verify -m "x"`) !== null],
    ["commit -n is a bypass (the deprecated spelling)", bypassRefusal("git commit -n -m msg") !== null],
    ["push -n is NOT a bypass (dry-run)", bypassRefusal("git push -n origin main") === null],
    ["a quoted --no-verify inside -m is not a flag", bypassRefusal(`git commit -m "--no-verify words"`) === null],
    ["re-pointing core.hooksPath is a bypass", bypassRefusal("git -c core.hooksPath=/x commit -m y") !== null],
    ["plain commit is not a bypass", bypassRefusal('git commit -m "real message"') === null],
    ["a SINGLE-TOKEN quoted flag IS the flag (the shell strips those quotes)", bypassRefusal("git commit '--no-verify' -m x") !== null],
    ["a quoted -c hooksPath value is still a re-point", bypassRefusal("git -c 'core.hooksPath=/tmp/x' commit -m y") !== null],
    ["an sh -c payload is classified as the command it runs", bypassRefusal('sh -c "git commit --no-verify -m x"') !== null],
    ["a bash -lc destructive payload is classified", destructiveAs("bash -lc \'git reset --hard HEAD~1\'") !== null],
    ["git config core.hooksPath (persistent) is a bypass", bypassRefusal("git config core.hooksPath /tmp/empty") !== null],
    ["a chained rm -rf under a force-with-lease push is still destructive", destructiveAs("rm -rf apps/ && git push --force-with-lease origin main") !== null],
    ["a bare force-with-lease push is exempt", destructiveAs("git push --force-with-lease origin main") === null],
    ["an ANSI-C quoted flag IS the flag", bypassRefusal("git commit $'--no-verify' -m x") !== null],
    ["backslash-escaped flags are their flags (git reset \\-\\-hard IS --hard)", destructiveAs("git reset \\-\\-hard HEAD~1") !== null],
    ["eval payloads are classified as the commands they run", bypassRefusal("eval 'git commit --no-verify -m x'") !== null],
    ["zsh and dash payloads are classified", destructiveAs("zsh -c 'git reset --hard HEAD~1'") !== null && destructiveAs("dash -c 'git reset --hard HEAD~1'") !== null],
    ["a lease push PIPED into a mass delete is destructive", destructiveAs("git push --force-with-lease origin main | xargs rm -rf apps/") !== null],
    ["the documented activation (git config core.hooksPath .githooks) is allowed", bypassRefusal("git config core.hooksPath .githooks") === null],
    ["re-pointing hooksPath elsewhere still refuses", bypassRefusal("git config core.hooksPath /tmp/empty") !== null],
    ["unsetting hooksPath refuses", bypassRefusal("git config --unset core.hooksPath") !== null],
    ["rm -rf is destructive", destructiveAs("rm -rf build/") !== null],
    ["rm single file is not classed destructive", destructiveAs("rm notes.tmp") === null],
    ["git reset --hard is destructive", destructiveAs("git reset --hard HEAD~1") !== null],
    ["push --force is destructive", destructiveAs("git push --force origin main") !== null],
    ["push --force-with-lease is NOT (the lease is the safety)", destructiveAs("git push --force-with-lease origin main") === null],
    ["git commit --amend is destructive", destructiveAs('git commit --amend -m "x"') !== null],
    ["DELETE FROM is destructive", destructiveAs('psql -c "DELETE FROM users"') !== null],
    ["echo is routine", destructiveAs("echo hi") === null],
    ["the edit demand names the file and the batch truth", editFactDemand("src/a.ts").includes("src/a.ts") && editFactDemand("src/a.ts").includes("already be applied")],
    ["the bash demand names the danger and the rollback", bashFactDemand("rm -rf build/", "recursive forced delete").includes("rollback")],
    ["first touch refuses with the full demand and the session ordinal", (() => { const d = gateDecision({ entries: {} }, "f", "FULL", 1000); return d.refuse && d.text === "FULL\n[denial #1 this session]"; })()],
    ["the retry passes (deny-ONCE)", (() => { const d1 = gateDecision({ entries: {} }, "f", "FULL", 1000); const d2 = gateDecision(d1.next, "f", "FULL", 2000); return !d2.refuse; })()],
    ["later touches keep passing until the TTL expires", (() => { const d1 = gateDecision({ entries: {} }, "f", "FULL", 1000); const d3 = gateDecision(d1.next, "f", "FULL", 1000 + TTL_MS - 1); return !d3.refuse; })()],
    ["a stale entry re-asks after the TTL", (() => { const d1 = gateDecision({ entries: {} }, "f", "FULL", 1000); const d3 = gateDecision(d1.next, "f", "FULL", 1000 + TTL_MS + 1); return d3.refuse && d3.text.includes("FULL"); })()],
    ["the fourth session denial condenses to one line", (() => {
      const d = gateDecision({ sessionDenials: 3, entries: {} }, "f", "FULL", 1000);
      return d.refuse && d.text.includes("#4 this session") && !d.text.startsWith("FULL");
    })()],
    ["no two denial texts are ever identical (the ordinal strictly increases)", (() => {
      const seen = new Set();
      let state = { entries: {} };
      for (const target of ["a", "b", "a-after-ttl", "c", "d"]) {
        const at = target === "a-after-ttl" ? 1000 + TTL_MS + 1 : 1000;
        const d = gateDecision(state, target.split("-")[0] === "a" ? "a" : target, "FULL", at);
        if (d.refuse) {
          if (seen.has(d.text)) return false;
          seen.add(d.text);
        }
        state = d.next;
      }
      return true;
    })()],
  ];
  for (const [name, passes] of cases) if (!passes) fail(`task-gate: ${name}`);
  // The count is DERIVED from the array it summarizes — a hand-maintained banner is count
  // drift waiting for the next sweep to catch (it caught this one twice).
  console.log(failures.length === 0 ? `task-gate self-test: OK (${cases.length} gate cases — count derived, not maintained)` : `task-gate self-test: FAILED\n  ${failures.join("\n  ")}`);
  return failures.length === 0;
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isEntry) {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args["self-test"]) process.exit(selfTest() ? 0 : 1);
  if (args.edit) {
    runGate(`edit:${args.edit}`, editFactDemand(args.edit), args.session);
    process.exit(0);
  }
  if (args.bash !== undefined) {
    const bypass = bypassRefusal(args.bash);
    if (bypass) die(`${bypass}\n  rule: gates are not optional; fix: run the command without the bypass flag and let the hooks judge`);
    const danger = destructiveAs(args.bash);
    if (danger) {
      runGate(`bash:${danger}`, bashFactDemand(args.bash, danger), args.session);
      process.exit(0);
    }
    console.log("task-gate: routine command — proceeding.");
    process.exit(0);
  }
  console.error("task-gate: nothing to judge — usage: task-gate.mjs --edit <file> | --bash <command> [--session <id>] (--self-test)");
  process.exit(1);
}
