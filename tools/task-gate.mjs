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
 *   --bash <command> two classes: BYPASS (--no-verify, -c core.hooksPath= on gate-carrying git
 *                    commands) refuses ALWAYS — it is a law, not a fact request; DESTRUCTIVE
 *                    commands (rm -rf, reset --hard, push --force, commit --amend, SQL drops…)
 *                    deny-once per session with a rollback demand. Quote-aware: a flag-looking
 *                    VALUE inside quotes is not a flag.
 *   --stdin          read the PreToolUse hook payload (tool_input.file_path / .command,
 *                    session_id) instead of argv — the runtime's own contract, no env guessing.
 *   --self-test      the refusals are the feature; every classifier proven both directions.
 *
 * Denial dampening (ECC's empirical find): identical repeated denials push models into loops,
 * so denials condense after the third FULL demand shown (the once-per-session rollback demand
 * excepted) and always carry an ordinal — bypass refusals included, though they never count
 * toward condensing — never textually identical twice. And a hook
 * sees one call at a time: edit denials say the batch truth out loud ("other edits in this
 * batch may already be applied — re-read the file").
 *
 * State: .stallion/gate-state-<session>.json — repo-local (stallion gets vendored; session
 * state must not leak across repos), atomic writes through the shared task-findings lock,
 * 30-minute TTL, bounded to 500 targets. The directory is gitignored; nothing here is law.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
const INTERPRETER = "(?:[\\w./-]*\\/)?(?:[a-z]{0,6}sh\\d?|eval)";
/** THE payload extractor — one law, no drift: a review caught this regex maintained in two
 *  places while the comment claimed one dialect. Both call sites build from this source. */
const PAYLOAD_REGEX_SRC = `(?:^|[\\s;&|])${INTERPRETER}\\s+(?:-{1,2}[a-zA-Z][\\w-]*\\s+){0,8}('([^']*)'|"((?:[^"\\\\]|\\\\.)*)"|\\$'([^']*)'|\\\$"((?:[^"\\\\]|\\\\.)*)")`;

/** Every interpreter/eval payload in the raw text, decoded — the ONE capture both the classifier
 *  and the splitter read (the loop was copied into each under a no-drift comment). */
function interpreterPayloads(raw) {
  return [...raw.matchAll(new RegExp(PAYLOAD_REGEX_SRC, "g"))].map((m) => {
    const inner = m[2] ?? m[3] ?? m[4] ?? m[5] ?? "";
    return m[0].includes("$'") ? decodeAnsiC(inner) : inner;
  });
}

/** Decode ANSI-C escapes inside $'…' — bash decodes these before argv exists. */
function decodeAnsiC(text) {
  return text
    .replace(/\\x([0-9a-fA-F]{1,2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\([\\'"])/g, "$1");
}

/**
 * The classifier's view of a command — ONE quote-aware scan, not stacked regex passes (the
 * stacked passes corrupted quote boundaries an adversarial pass caught). Walks the raw text:
 * single/double/locale quotes yield their content as a token when it is a single token, and
 * vanish when it is a payload or value; ANSI-C quotes decode their escapes first; backslashes
 * outside quotes are their characters (git reset \\-\-hard IS --hard); interpreter/eval
 * payloads are appended whole as commands, one level deep. This models COMMON quoting — it is
 * friction that demands facts, not a shell parser; the push fence is the control.
 */
export function classifiedText(command) {
  const raw = String(command ?? "");
  const payloads = interpreterPayloads(raw);
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (c === "\\") {
      out += raw[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (c === "'") {
      const end = raw.indexOf("'", i + 1);
      const inner = end === -1 ? raw.slice(i + 1) : raw.slice(i + 1, end);
      if (!/\s/.test(inner.trim())) out += inner;
      i = end === -1 ? raw.length : end;
      continue;
    }
    if (c === '"' || (c === "$" && raw[i + 1] === '"')) {
      const q = c === "$" ? i + 1 : i;
      let inner = "";
      let j = q + 1;
      while (j < raw.length && raw[j] !== '"') {
        if (raw[j] === "\\" && (raw[j + 1] === '"' || raw[j + 1] === "\\")) {
          inner += raw[j + 1];
          j += 2;
        } else {
          inner += raw[j];
          j += 1;
        }
      }
      if (!/\s/.test(inner.trim())) out += inner;
      i = j;
      continue;
    }
    if (c === "$" && raw[i + 1] === "'") {
      const end = raw.indexOf("'", i + 2);
      const inner = end === -1 ? raw.slice(i + 2) : raw.slice(i + 2, end);
      const decoded = decodeAnsiC(inner);
      if (!/\s/.test(decoded.trim())) out += decoded;
      i = end === -1 ? raw.length : end;
      continue;
    }
    out += c;
  }
  return [out, ...payloads].join("\n");
}

const GIT_HOOKED = /(?:^|\s)(?:commit|merge|cherry-pick|rebase|am|push)(?:\s|$)/;

/** Pure: does ONE segment skip the hooks? Judged per segment, never over the whole compound: a
 *  `git commit` beside an unrelated `-n` (git log -n, head -n) is not `commit -n` (a review
 *  caught the whole-string join refusing the common commit-then-log compound on every retry). */
function skipsHooks(segment) {
  const s = classifiedText(segment);
  return GIT_HOOKED.test(s) && (/(?:^|\s)--no-verify(?:\s|$)/.test(s) || (/(?:^|\s)commit\s/.test(s) && /(?:^|\s)-n(?:\s|$)/.test(s)));
}

/** Pure: does this command attempt to bypass the gates? ALWAYS refused — not a fact request. */
export function bypassRefusal(command) {
  const t = classifiedText(command);
  const rawText = String(command ?? "");
  const git = /(?:^|\s)git\s+/.test(t) || /GIT_CONFIG_KEY_\d+=core\.hooksPath/i.test(rawText);
  if (!git) return null;
  if (commandSegments(command).some(skipsHooks)) {
    return "this command bypasses the commit hooks (--no-verify / commit -n) — the hooks ARE the gates; run them";
  }
  if (/(?:^|\s)-c\s+core\.hooksPath=/.test(t) || /GIT_CONFIG_KEY_\d+=core\.hooksPath/i.test(rawText)) {
    return "this command re-points core.hooksPath — the hooks are the fence; do not move them to run without them";
  }
  if (/core\.hooksPath\s*(?:""|'')/.test(rawText)) {
    return "setting core.hooksPath to an empty value deactivates every committed hook — if you mean to re-activate, set it to .githooks";
  }
  if (/git\s+config\s+(?:--[\w-]+\s+)*(?:--unset(?:-all)?\s+core\.hooksPath|--remove-section\s+core)\b/.test(t)) {
    return "unsetting core.hooksPath deactivates every committed hook for this clone — if you mean to re-activate, set it back to .githooks instead";
  }
  // EVERY hooksPath write is judged, not just the first (a sweep caught the legal activation
  // laundering a trailing re-point); machine-wide scope flags and non-.githooks values refuse.
  for (const m of t.matchAll(/git\s+config\s+((?:--[\w-]+\s+)*)core\.hooksPath(?:\s+(\S+))?/g)) {
    const flags = m[1] ?? "";
    const value = (m[2] ?? "").replace(/^['"]|['"]$/g, "");
    if (value === "" || value === undefined) continue; // a bare read prints, it does not write
    if (/--(global|system|file)\b/.test(flags)) {
      return "setting core.hooksPath with a machine-wide scope flag — the activation is local (git config core.hooksPath .githooks) and must stay local";
    }
    if (value !== ".githooks") {
      return "this command re-points core.hooksPath somewhere other than the committed .githooks — the hooks are the fence; only the documented activation (git config core.hooksPath .githooks) is legal";
    }
  }
  return null;
}

/** [pattern, name, where]: FLAG-shaped dangers match the UNQUOTED command (a flag-looking
 *  value inside quotes is not a flag); CONTENT-shaped dangers (SQL payloads) match the RAW
 *  command, because the payload lives inside the quotes. */
const DESTRUCTIVE = [
  // rm's flag must START a token — a hyphen inside a file name (rm old-report.txt) is not -r
  // (a review caught single-file removes spending the session's one destructive ask). These rows
  // judge `git rm` too; its own unanchored row only ever matched a hyphen in a path or --dry-run.
  [/\brm\s+(?:[^;|&]*\s)?-[a-zA-Z]*(?:[rR][a-zA-Z]*f|f[a-zA-Z]*[rR])/, "recursive forced delete", "unquoted"],
  [/\brm\s+(?:[^;|&]*\s)?(?:-[a-zA-Z]*[rR]|--recursive\b)/, "recursive delete", "unquoted"],
  [/git\s+reset\s+--hard/, "hard reset (uncommitted work is unrecoverable)", "unquoted"],
  [/git\s+(?:checkout\s+--|checkout\s+\.|restore\s+(?!--staged))/, "discard working-tree changes", "unquoted"],
  [/git\s+clean\s+-[a-zA-Z]*f/, "clean -f (untracked files are unrecoverable)", "unquoted"],
  [/git\s+push\s+[^;|&]*(?:--force(?:\s|$|=)|(?:^|\s)-f(?:\s)|\+refs\/)/, "force push (rewrites remote history)", "unquoted"],
  [/git\s+commit\s+[^;|&]*--amend/, "amend (rewrites an existing commit)", "unquoted"],
  [/git\s+switch\s+[^;|&]*(?:-f|-C)\s/, "forced branch switch (discards local changes)", "unquoted"],
  [/find\s+[^;|&]*-exec\s+rm/, "find -exec rm", "unquoted"],
  [/\bdd\s+[^;|&]*if=/, "dd (raw device write)", "unquoted"],
  [/\b(?:DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i, "bulk SQL data loss", "raw"],
];

/** Split a compound at SEPARATOR characters OUTSIDE quotes — a pipe inside a quoted message
 *  is data, and splitting on it stranded flags from their command heads (a regression a sweep
 *  caught: git commit -m "a|b" --amend stopped classifying as an amend). */
export function quoteAwareSplit(raw) {
  const parts = [""];
  let quote = null; // "'", '"', "$'", '$"'
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (quote) {
      parts[parts.length - 1] += c;
      if (quote !== "'" && c === "\\") {
        parts[parts.length - 1] += raw[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'") { quote = "'"; parts[parts.length - 1] += c; continue; }
    if (c === '"') { quote = '"'; parts[parts.length - 1] += c; continue; }
    if (c === "$" && (raw[i + 1] === "'" || raw[i + 1] === '"')) { quote = "$" + raw[i + 1]; parts[parts.length - 1] += c; continue; }
    const two = raw.slice(i, i + 2);
    const atSeparator = c === "\n" || c === ";" || c === "&" || two === "&&" || two === "||" || two === "|&" || c === "|";
    if (atSeparator) {
      if (parts[parts.length - 1].trim() !== "") parts.push("");
      if (two === "&&" || two === "||" || two === "|&") i += 1;
      continue;
    }
    parts[parts.length - 1] += c;
  }
  return parts.map((x) => x.trim()).filter(Boolean);
}

export function commandSegments(command) {
  const raw = String(command ?? "");
  // interpreter/eval payloads are commands too — appended as their own segments, one level
  // deep; the SAME capture as classifiedText (one law, no drift).
  return [...quoteAwareSplit(raw), ...interpreterPayloads(raw)];
}

/** Pure: is this command destructive? Returns the human name of the danger, or null.
 *  Compounds are judged SEGMENT by segment (an adversarial pass caught the whole-string
 *  lease exemption nullifying a chained rm -rf); --force-with-lease exempts only its own
 *  segment — the lease is that push's safety, not the compound's. */
export function destructiveAs(command) {
  for (const segment of commandSegments(command)) {
    if (/git\s+push\s+[^;|&]*--force-with-lease/.test(segment)) continue;
    for (const [pattern, name, where] of DESTRUCTIVE) {
      if (pattern.test(where === "raw" ? segment : classifiedText(segment))) return name;
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
    "rule: the first touch of a file investigates before it edits — the act of investigation creates the awareness self-evaluation never did",
    "fix: present the facts in your reply, then retry the edit",
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
    "rule: irreversible commands owe a rollback line before they run — asked once per session",
    "fix: state the above in your reply, then retry the command",
  ].join("\n");
}

function statePath(session) {
  const safe = String(session ?? "default").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
  return `${STATE_DIR}/gate-state-${safe}.json`;
}

/** Load a session's state, TTL applied at the read: stale entries drop and a stale ordinal
 *  counter resets. Exported for the self-test — the TTL and re-ask laws are pinned, not trusted. */
export function loadState(path, nowMs) {
  if (!existsSync(path)) return { version: 1, entries: {} };
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (state && typeof state === "object" && state.entries && typeof state.entries === "object") {
      for (const key of Object.keys(state.entries)) {
        if (typeof state.entries[key]?.askedAt !== "number" || nowMs - state.entries[key].askedAt > TTL_MS) {
          delete state.entries[key];
        }
      }
      return { version: 1, ...freshCounters(state, nowMs), entries: state.entries };
    }
  } catch {
    // unreadable state re-asks — a gate that cannot read state errs toward asking again
  }
  return { version: 1, entries: {} };
}

/** A count field, or 0 when absent or malformed — unreadable counts re-ask, never condense. */
function countOf(value) {
  return typeof value === "number" ? value : 0;
}

/** The session counters, zeroed once their TTL lapses with everything else — a session months
 *  later gets full demands again, never a condensed line citing denials it never saw (a sweep finding). */
function freshCounters(state, nowMs) {
  if (typeof state.sessionDenialsAt !== "number" || nowMs - state.sessionDenialsAt > TTL_MS) return { sessionDenials: 0, fullShown: 0 };
  return { sessionDenials: countOf(state.sessionDenials), fullShown: countOf(state.fullShown), sessionDenialsAt: state.sessionDenialsAt };
}

/** Pure: the state stays bounded — past MAX_TARGETS, the oldest asks are evicted first. */
export function boundTargets(entries) {
  const keys = Object.keys(entries);
  if (keys.length <= MAX_TARGETS) return entries;
  keys.sort((a, b) => entries[a].askedAt - entries[b].askedAt);
  return Object.fromEntries(keys.slice(keys.length - MAX_TARGETS).map((key) => [key, entries[key]]));
}

function saveState(path, state) {
  mkdirSync(STATE_DIR, { recursive: true });
  atomicWriteJson(path, { ...state, entries: boundTargets(state.entries) });
}

/**
 * The deny-once decision, pure over the state object. Per target: first fresh touch REFUSES
 * with the full demand; the retry (and every later touch until the TTL expires) passes. The
 * dampening counter is SESSION-wide (ECC's shape): every refusal carries a strictly increasing
 * ordinal — so no two denial texts are ever identical — and once three FULL demands have been
 * shown, the message condenses to one line pointing back at them. The count is of full demands,
 * not the ordinal: bypass refusals ride the ordinal, and counting them condensed a session's
 * first edit demand to a line citing demands never shown (a review finding). The destructive
 * demand never condenses: its one ask per session is the only time the danger and the rollback
 * are named, and three earlier EDIT demands are not that demand (a review caught a hard reset
 * after three first edits getting a condensed line, and the retry running with no rollback ever
 * stated). It refuses at most once per TTL, so it cannot feed the loop dampening exists for.
 */
export function gateDecision(state, target, fullDemand, nowMs) {
  const entry = state.entries[target];
  const fresh = entry && typeof entry.askedAt === "number" && nowMs - entry.askedAt <= TTL_MS;
  if (fresh) return { refuse: false, text: `asked — proceeding (${target})`, next: state };
  const n = countOf(state.sessionDenials) + 1;
  const shown = countOf(state.fullShown);
  const full = shown < 3 || target === destructiveTarget();
  const text = full
    ? `${fullDemand}\n[denial #${n} this session]`
    : `${target}: denial #${n} this session — present the facts and retry, or change the plan; the full demands were already shown ${shown} times this session`;
  return { refuse: true, text, next: { ...state, sessionDenials: n, fullShown: full ? shown + 1 : shown, sessionDenialsAt: nowMs, entries: { ...state.entries, [target]: { askedAt: nowMs } } } };
}

/** The gate target for a destructive command: ONE key per session regardless of danger class
 *  (the spec's ask-once-per-session shape) — exported so the pin drives the DISPATCH law, not
 *  just gateDecision's unchanged same-key semantics (a sweep caught the vacuous form). */
export function destructiveTarget() {
  return "bash:destructive";
}

function die(message) {
  console.error(`task-gate: ✖ REFUSED — ${message}`);
  process.exit(1);
}

/**
 * A bypass refusal is LAW — refused every time, never deny-once — yet it rides the same session
 * ordinal, so a retried bypass never reads textually identical twice (a review caught bypass
 * denials skipping the counter: the loop-feeding repeat the dampening exists to prevent). It
 * leaves fullShown alone — a bypass is not a fact demand, so it never condenses the next one.
 */
export function bypassDecision(state, refusal, nowMs) {
  const n = countOf(state.sessionDenials) + 1;
  return { refuse: true, text: `${refusal}\n[denial #${n} this session]`, next: { ...state, sessionDenials: n, sessionDenialsAt: nowMs } };
}

/** Load, decide, save — under the shared lock; `decide` is a pure (state, nowMs) decision. */
function decideUnderLock(session, decide) {
  const path = statePath(session);
  mkdirSync(STATE_DIR, { recursive: true }); // the lockfile lives here before any state does
  const nowMs = Date.now();
  let outcome;
  withLock(path, () => {
    outcome = decide(loadState(path, nowMs), nowMs);
    saveState(path, outcome.next);
  });
  return outcome;
}

function runGate(target, fullDemand, session) {
  const outcome = decideUnderLock(session, (state, nowMs) => gateDecision(state, target, fullDemand, nowMs));
  if (outcome.refuse) die(outcome.text);
  console.log(`task-gate: facts presented for ${target} — proceeding.`);
}

/**
 * Map a PreToolUse stdin payload (Claude Code's hook contract: tool_input + session_id) onto the
 * argv laws — a file path is an edit, a command is a bash judgment. That runtime sets no env var
 * carrying the file or the command, so wiring that read env blocked every edit and passed every
 * command (a review finding); the payload IS the contract. A payload naming neither judges
 * nothing, and nothing-to-judge refuses.
 */
export function argsFromHookPayload(payload) {
  const input = payload?.tool_input ?? {};
  const edit = input.file_path ?? input.filePath ?? input.path;
  return { edit: typeof edit === "string" ? edit : undefined, bash: typeof input.command === "string" ? input.command : undefined, session: payload?.session_id };
}

/** The --stdin payload, or a refusal: a gate that cannot read its input never guesses a pass. */
function readHookPayload() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch (e) {
    return die(`the --stdin hook payload is not readable JSON (${e.message})\n  rule: a gate that cannot read its input refuses — it never guesses a pass\n  fix: pipe the runtime's PreToolUse payload on stdin ({"tool_input":{"file_path" or "command"},"session_id"}), or pass --edit <file> / --bash <command> explicitly`);
  }
}

const USAGE = "usage: task-gate.mjs --edit <file> | --bash <command> [--session <id>] | --stdin (the PreToolUse payload) (--self-test)";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--self-test" || a === "--stdin") { args[a.slice(2)] = true; continue; }
    if (["--edit", "--bash", "--session"].includes(a)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        console.error(`task-gate: --${a.slice(2)} requires a value`);
        process.exit(1);
      }
      args[a.slice(2)] = next;
      i += 1;
      continue;
    }
    console.error(`task-gate: unknown flag: ${a} — ${USAGE}`);
    process.exit(1);
  }
  return args;
}

/** Run this tool's own CLI — the entry dispatch, not just the pure core — for the live cases. */
function cli(args, input) {
  return spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { encoding: "utf8", input });
}

/** The state-law cases: TTL at load, re-ask on unreadable state, the bound — driven through the
 *  real loadState over fixture files, so a regression in the load path fails the battery. */
function stateCases() {
  const dir = mkdtempSync(join(tmpdir(), "task-gate-state-"));
  const fixture = (name, text) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  const load = (name, state, nowMs) => loadState(fixture(name, JSON.stringify(state)), nowMs);
  try {
    return [
      ["a stale ordinal counter loads as zero: a later session's first denial is #1 with the full demand", (() => {
        const s = load("stale-counter.json", { sessionDenials: 7, fullShown: 3, sessionDenialsAt: 0, entries: {} }, TTL_MS + 1);
        return s.sessionDenials === 0 && s.sessionDenialsAt === undefined && gateDecision(s, "f", "FULL", TTL_MS + 1).text === "FULL\n[denial #1 this session]";
      })()],
      ["a fresh ordinal counter and full-demand count survive the load", (() => {
        const s = load("fresh-counter.json", { sessionDenials: 2, fullShown: 1, sessionDenialsAt: 1000, entries: {} }, 2000);
        return s.sessionDenials === 2 && s.fullShown === 1 && s.sessionDenialsAt === 1000;
      })()],
      ["stale entries drop at load while fresh ones stay", (() => {
        const s = load("entries.json", { entries: { old: { askedAt: 0 }, recent: { askedAt: TTL_MS } } }, TTL_MS + 1);
        return !("old" in s.entries) && "recent" in s.entries;
      })()],
      ["unreadable state loads empty, so the gate asks again", (() => {
        try {
          return Object.keys(loadState(fixture("torn.json", '{"entries":{"edit:a":{"askedAt":1'), 1000).entries).length === 0;
        } catch {
          return false;
        }
      })()],
      ["past the bound, the oldest asks are evicted first", (() => {
        const entries = Object.fromEntries(Array.from({ length: MAX_TARGETS + 1 }, (_, i) => [`t${i}`, { askedAt: i + 1 }]));
        const bounded = boundTargets(entries);
        return Object.keys(bounded).length === MAX_TARGETS && !("t0" in bounded) && `t${MAX_TARGETS}` in bounded;
      })()],
    ];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The state laws through the real CLI — load, decide, SAVE — so the wiring between the pure
 *  pieces is pinned too (a review dropped the counter's timestamp at the load, and the eviction
 *  call from saveState, and the battery stayed green both times). */
function liveStateCases() {
  const inSession = (tag, body) => {
    const session = `selftest-${tag}-${process.pid}-${Date.now()}`;
    try {
      return body(session);
    } finally {
      rmSync(statePath(session), { force: true });
    }
  };
  return [
    ["the ordinal keeps rising across a passing retry (the counter's timestamp survives the load)", inSession("ordinal", (session) => {
      const bypass = ["--bash", "git commit --no-verify -m x"];
      const runs = [bypass, ["--edit", "a.mjs"], ["--edit", "a.mjs"], bypass].map((flags) => cli([...flags, "--session", session]));
      return runs[2].status === 0 && runs[3].stderr.includes("[denial #3 this session]");
    })],
    ["saving a session's state evicts past the bound (saveState calls boundTargets)", inSession("bound", (session) => {
      const now = Date.now();
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(statePath(session), JSON.stringify({ version: 1, entries: Object.fromEntries(Array.from({ length: MAX_TARGETS + 1 }, (_, i) => [`edit:t${i}`, { askedAt: now - i }])) }));
      cli(["--edit", "x.mjs", "--session", session]);
      const entries = JSON.parse(readFileSync(statePath(session), "utf8")).entries;
      return Object.keys(entries).length === MAX_TARGETS && "edit:x.mjs" in entries;
    })],
  ];
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
    ["git push --no-verify is a bypass (it skips the pre-push fence)", bypassRefusal("git push --no-verify origin main") !== null],
    ["destructive asks once per session regardless of the command's danger class (the dispatch law, not just same-key semantics)", (() => {
      const key = destructiveTarget(); // ONE key for every destructive spelling — the danger class is not an input to the target
      const first = gateDecision({ entries: {} }, key, "F1: forced amend", 1000);
      const second = gateDecision(first.next, key, "F2: recursive delete", 2000);
      return first.refuse && !second.refuse && bashFactDemand("rm -rf x", "recursive forced delete").includes("recursive forced delete");
    })()],
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
    ["unsetting hooksPath refuses", bypassRefusal("git config --unset core.hooksPath") !== null],
    ["--unset-all refuses (the -all spelling)", bypassRefusal("git config --unset-all core.hooksPath") !== null],
    ["--remove-section core refuses", bypassRefusal("git config --remove-section core") !== null],
    ["an empty-value re-point refuses", bypassRefusal('git config core.hooksPath ""') !== null],
    ["a LEGAL activation followed by a re-point still refuses (every write judged)", bypassRefusal("git config core.hooksPath .githooks && git config core.hooksPath /tmp/nohooks && git commit -m x") !== null],
    ["a --global activation refuses (machine scope)", bypassRefusal("git config --global core.hooksPath .githooks") !== null],
    ["the GIT_CONFIG env protocol refuses", bypassRefusal("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp/x git commit -m y") !== null],
    ["ANSI-C escape-decoded flags are their flags", bypassRefusal("git commit $'\\x2d\\x2dno-verify' -m x") !== null],
    ["path-prefixed interpreter payloads are classified", bypassRefusal("/bin/bash -c 'git commit --no-verify -m x'") !== null],
    ["a pipe inside a quoted message does not strand the amend flag", destructiveAs('git commit -m "fix a|b" --amend') !== null],
    ["rm -rf is destructive", destructiveAs("rm -rf build/") !== null],
    ["rm single file is not classed destructive", destructiveAs("rm notes.tmp") === null],
    ["git reset --hard is destructive", destructiveAs("git reset --hard HEAD~1") !== null],
    ["push --force is destructive", destructiveAs("git push --force origin main") !== null],
    ["git commit --amend is destructive", destructiveAs('git commit --amend -m "x"') !== null],
    ["DELETE FROM is destructive", destructiveAs('psql -c "DELETE FROM users"') !== null],
    ["echo is routine", destructiveAs("echo hi") === null],
    ["a commit beside an unrelated -n (git log -n, head -n) is not a bypass — judged per segment", ['git commit -m "wip" && git log --oneline -n 3', "git add -A && git commit -m fix && head -n 5 CHANGELOG.md"].every((c) => bypassRefusal(c) === null)],
    ["a real commit -n in a later segment still refuses", bypassRefusal("git commit -m x && git commit -n -m y") !== null],
    ["the rollback demand shows in full even after three earlier denials (destructive never condenses)", (() => {
      const d = gateDecision({ sessionDenials: 3, fullShown: 3, entries: {} }, destructiveTarget(), bashFactDemand("git reset --hard HEAD~3", "hard reset"), 1000);
      return d.refuse && d.text.includes("rollback") && d.text.includes("#4 this session");
    })()],
    ["a retried bypass never reads identical and names the command as evidence (the ordinal rides law refusals too)", (() => {
      const session = `selftest-bypass-${process.pid}-${Date.now()}`;
      try {
        const runs = [1, 2].map(() => cli(["--bash", "git commit --no-verify -m x", "--session", session]));
        return runs.every((r) => r.status === 1 && r.stderr.includes("evidence: git commit --no-verify -m x")) && runs[0].stderr !== runs[1].stderr;
      } finally {
        rmSync(statePath(session), { force: true });
      }
    })()],
    ["a hyphenated single-file rm is not a recursive delete (the flag must start a token)", ["rm tools/adversarial-runner.mjs", "rm -f old-report.txt"].every((c) => destructiveAs(c) === null)],
    ["rm's recursive flag after the path, capitalized, or spelled long still classifies", ["rm build/ -rf", "rm -Rf build/", "rm --recursive build/"].every((c) => destructiveAs(c) !== null)],
    ["rm -r is named a recursive delete", destructiveAs("rm -r build/") === "recursive delete"],
    ["rm -fr is named a recursive forced delete", destructiveAs("rm -fr build/") === "recursive forced delete"],
    ["a hyphenated single-file git rm, a --cached rm, or a dry run is not destructive", ["git rm tools/adversarial-runner.mjs", "git rm --cached tools/x-ray.mjs", "git rm --dry-run notes.md"].every((c) => destructiveAs(c) === null)],
    ["a real recursive git rm still classifies (-r, -rf, flag after the path)", ["git rm -r dir/", "git rm -rf dir/", "git rm dir/ -r"].every((c) => destructiveAs(c) !== null)],
    ["an empty --bash value fails closed, never routine (a miswired hook is loud)", cli(["--bash", ""]).status !== 0],
    ["--stdin reads the PreToolUse payload: a bypass command refuses, a file path is an edit", (() => {
      const session = `selftest-stdin-${process.pid}-${Date.now()}`;
      try {
        const bash = cli(["--stdin"], JSON.stringify({ session_id: session, tool_name: "Bash", tool_input: { command: "git commit --no-verify -m x" } }));
        const edit = cli(["--stdin"], JSON.stringify({ session_id: session, tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }));
        return bash.status === 1 && bash.stderr.includes("bypasses the commit hooks") && edit.status === 1 && edit.stderr.includes("Before editing src/a.ts");
      } finally {
        rmSync(statePath(session), { force: true });
      }
    })()],
    ["--stdin with an unreadable payload fails closed", cli(["--stdin"], "not json").status !== 0],
    ["the edit demand names the file and the batch truth", editFactDemand("src/a.ts").includes("src/a.ts") && editFactDemand("src/a.ts").includes("already be applied")],
    ["the bash demand names the danger and the rollback", bashFactDemand("rm -rf build/", "recursive forced delete").includes("rollback")],
    ["first touch refuses with the full demand and the session ordinal", (() => { const d = gateDecision({ entries: {} }, "f", "FULL", 1000); return d.refuse && d.text === "FULL\n[denial #1 this session]"; })()],
    ["the retry passes (deny-ONCE)", (() => { const d1 = gateDecision({ entries: {} }, "f", "FULL", 1000); const d2 = gateDecision(d1.next, "f", "FULL", 2000); return !d2.refuse; })()],
    ["later touches keep passing until the TTL expires", (() => { const d1 = gateDecision({ entries: {} }, "f", "FULL", 1000); const d3 = gateDecision(d1.next, "f", "FULL", 1000 + TTL_MS - 1); return !d3.refuse; })()],
    ["a stale entry re-asks after the TTL", (() => { const d1 = gateDecision({ entries: {} }, "f", "FULL", 1000); const d3 = gateDecision(d1.next, "f", "FULL", 1000 + TTL_MS + 1); return d3.refuse && d3.text.includes("FULL"); })()],
    ["the denial after three full demands condenses to one line", (() => {
      const d = gateDecision({ sessionDenials: 3, fullShown: 3, entries: {} }, "f", "FULL", 1000);
      return d.refuse && d.text.includes("#4 this session") && !d.text.startsWith("FULL");
    })()],
    ["three bypass refusals never condense the first edit demand (condensing counts full demands shown, not the ordinal)", (() => {
      let state = { entries: {} };
      for (const at of [1, 2, 3]) state = bypassDecision(state, "B", at).next;
      const d = gateDecision(state, "edit:f", editFactDemand("f"), 4);
      return d.refuse && d.text.startsWith(editFactDemand("f")) && d.text.includes("#4 this session");
    })()],
    ["a condensed line never cites ordinals that were not full demands", (() => {
      const d = gateDecision({ sessionDenials: 5, fullShown: 3, entries: {} }, "f", "FULL", 1000);
      return d.refuse && !d.text.startsWith("FULL") && d.text.includes("#6 this session") && !d.text.includes("denials 1-3");
    })()],
    ...stateCases(),
    ...liveStateCases(),
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
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args["self-test"]) process.exit(selfTest() ? 0 : 1);
  if (args.stdin) Object.assign(args, argsFromHookPayload(readHookPayload()));
  if (args.edit) {
    runGate(`edit:${args.edit}`, editFactDemand(args.edit), args.session);
    process.exit(0);
  }
  // An EMPTY command judges nothing and falls through to the refusal below — never "routine"
  // (a miswired hook that passes "" must be loud, the way an empty --edit already is).
  if (args.bash) {
    const bypass = bypassRefusal(args.bash);
    if (bypass) {
      const refusal = `${bypass}\n  rule: gates are not optional — a bypass is refused every time, never asked once\n  evidence: ${args.bash}\n  fix: run the command without the bypass (drop --no-verify / commit -n; leave core.hooksPath at .githooks) and let the hooks judge`;
      die(decideUnderLock(args.session, (state, nowMs) => bypassDecision(state, refusal, nowMs)).text);
    }
    const danger = destructiveAs(args.bash);
    if (danger) {
      // Once per SESSION (the spec's shape): the first destructive command of any class asks;
      // the session's remaining destructive commands proceed. The demand names the danger.
      runGate(destructiveTarget(), bashFactDemand(args.bash, danger), args.session);
      process.exit(0);
    }
    console.log("task-gate: routine command — proceeding.");
    process.exit(0);
  }
  console.error(`task-gate: nothing to judge — ${USAGE}`);
  process.exit(1);
}
