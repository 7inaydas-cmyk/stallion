#!/usr/bin/env node
/**
 * GATE-REGISTRY — stallion's gate invocations, declared once, drift-checked everywhere.
 *
 * A concept rewrite of the Antitube harness's gate-registry (2026-09-20): upstream, the eight
 * push gates lived in pre-push bash and the registry existed because "= EIGHT" came to enumerate
 * seven for months while three separate surfaces (pre-push, ci.yml, a live-doc sentinel) each
 * hand-copied the list. Stallion's gates live in different transports — git hooks, CI, the
 * battery script, the doctor — and the same drift class applies: a transport silently dropping
 * an invocation is indistinguishable, from the outside, from it never having been wired.
 *
 * THE LAW: every gate invocation is declared ONCE in docs/gates/gate-registry.json, with the
 * transports that must carry it. The checker reads each transport for the invocation as a LIVE
 * command whose exit status still decides the transport (not a comment, an echo, or a swallowed
 * verdict — see carries() for the shapes it accepts, every other shape failing closed, and the
 * residuals it states). A gate declared `"advisory": true` is the one exception: its verdict may
 * be swallowed on purpose. The battery, whose bare self-tests no row declares, must be one clean
 * `&&` chain. Failures come in both directions:
 *   1. a declared gate missing from a transport that must carry it   (the drift upstream paid for)
 *   2. a transport carrying an invocation the registry does not declare (an unwired shadow gate
 *      — code that LOOKS like enforcement but is registered nowhere, so no one checks it runs)
 *
 * Deliberately NOT a generator. Upstream's registry can emit the gate list for pre-push to
 * source; stallion's transports are readable one-liners, and a checker that greps the REAL
 * files catches drift a generator cannot (a hand-edit away from the generated form).
 *
 * Usage:
 *   node tools/gate-registry.mjs             check every declaration against every transport
 *   node tools/gate-registry.mjs --self-test prove the checker discriminates
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const REGISTRY_PATH = "docs/gates/gate-registry.json";

/** The transports a gate can be declared to run in, each read from its repo-relative file. The
 *  doctor is deliberately NOT a transport: its own file mentions every invocation in usage
 *  strings, and a checker must grep surfaces that CARRY commands, not files that DESCRIBE them.
 *  The doctor's gate-config health is its own derived check inside cmdDoctor. The names are
 *  git's, GitHub's and npm's, not this repo's data: `ci` is EVERY workflow file for the shadow
 *  sweep (a host's CI file is not always named selftest.yml, and a second workflow carrying a gate
 *  is exactly the one nobody watches), but a gate is CARRIED in ci only by a tracked workflow
 *  that runs on push or pull_request and cannot swallow a failed step (CARRIED_CI) — a
 *  dispatch-only, scheduled or scratch workflow runs on no push. `battery` is the ONE script
 *  `npm run selftest` runs (CI's battery step and task-state's verified boundary); `npm-alias` is
 *  every other package.json script — a runnable spelling nothing invokes on its own, so it
 *  carries no battery gate. A new transport KIND is a graft to this map, recorded at vendor time
 *  (docs/WIRING.md §1), not a config edit. The values are the labels refusals print. */
const TRANSPORTS = {
  "pre-commit": ".githooks/pre-commit",
  "commit-msg": ".githooks/commit-msg",
  "pre-push": ".githooks/pre-push",
  ci: ".github/workflows/*.{yml,yaml}",
  battery: "package.json scripts.selftest",
  "npm-alias": "package.json scripts other than selftest",
};
const WORKFLOWS_DIR = ".github/workflows";
/** What a ci gate's MISSING refusal names: direction 1 reads narrower than the shadow sweep. */
const CARRIED_CI = `${TRANSPORTS.ci} tracked by git, triggered on push or pull_request, with no continue-on-error and no always-false if:`;
/** How a transport's text runs as shell. A git hook or the battery is ONE `sh` script, errexit off
 *  unless its shebang says `-e` (a `set -e` counts from its own line on — errexitAt); every npm
 *  alias is an `sh` script of one line; a workflow is YAML whose `run:` values each run under CI's
 *  default `bash -e`. */
function shellOf(transport, text) {
  if (transport === "ci") return { errexit: true, yaml: true };
  if (transport === "npm-alias") return { errexit: false, lineScripts: true };
  return { errexit: /^#!\S+[ \t]+-[A-Za-z]*e/.test(text) };
}

function die(message) {
  console.error(`gate-registry: ${message}`);
  process.exit(1);
}

function loadRegistry() {
  const path = `${ROOT}${REGISTRY_PATH}`;
  if (!existsSync(path)) die(`${REGISTRY_PATH} is missing — an undeclared gate list checks nothing\n  fix: restore it (see the vendor template at docs/gates/)`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    die(`${REGISTRY_PATH} does not parse: ${e.message}\n  fix: repair the JSON`);
  }
  const shapeError = registryShapeError(parsed);
  if (shapeError !== null) die(`${REGISTRY_PATH}: ${shapeError}\n  fix: repair ${REGISTRY_PATH} (shape: {"gates":[{"id","invocation","transports":[...],"advisory"?: true,"why"}]})`);
  return parsed.gates;
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Pure: the config-shape law, split per gate so the checker itself stays under its own bar. A
 *  malformed value refuses with the rule — never a TypeError with no fix line. */
function registryShapeError(parsed) {
  if (!isPlainObject(parsed)) return "the registry must be a JSON object with a 'gates' array";
  if (!Array.isArray(parsed.gates) || parsed.gates.length === 0) return "field 'gates' must be a non-empty array";
  for (const gate of parsed.gates) {
    const gateError = isPlainObject(gate) ? gateShapeError(gate) : "every entry in 'gates' must be an object";
    if (gateError !== null) return gateError;
  }
  return duplicateError(parsed.gates);
}

function gateShapeError(gate) {
  if (typeof gate.id !== "string" || gate.id.length === 0) return "a gate has no id";
  if (typeof gate.invocation !== "string" || gate.invocation.length === 0) return `gate '${gate.id}' has no invocation text`;
  return transportsShapeError(gate) ?? advisoryShapeError(gate);
}

function transportsShapeError(gate) {
  if (!Array.isArray(gate.transports) || gate.transports.length === 0) return `gate '${gate.id}' declares no transports — a gate carried by nothing is not wired`;
  const unknown = gate.transports.find((t) => !(t in TRANSPORTS));
  return unknown === undefined ? null : `gate '${gate.id}' declares unknown transport '${unknown}' (known: ${Object.keys(TRANSPORTS).join(", ")} — the set is TRANSPORTS in tools/gate-registry.mjs; a new kind is a graft recorded at vendor time)`;
}

/** `advisory` is the one declared licence to swallow a verdict, so it must be exactly a boolean —
 *  a string "false" read as truthy would license it silently. */
function advisoryShapeError(gate) {
  return gate.advisory === undefined || typeof gate.advisory === "boolean" ? null : `gate '${gate.id}' has a non-boolean "advisory" (${JSON.stringify(gate.advisory)}) — true declares a deliberately non-blocking wiring; omit it otherwise`;
}

/** "Declared ONCE" is the law the success line prints: a repeated id or invocation is refused,
 *  or two rows could disagree about which one is the law while the output claims one. */
function duplicateError(gates) {
  const ids = new Set();
  const invocations = new Set();
  for (const gate of gates) {
    if (ids.has(gate.id)) return `gate id '${gate.id}' is declared twice — one row per gate`;
    if (invocations.has(gate.invocation)) return `invocation '${gate.invocation}' is declared twice (again as gate '${gate.id}') — a gate is declared ONCE`;
    ids.add(gate.id);
    invocations.add(gate.invocation);
  }
  return null;
}

function transportText(name, root = ROOT) {
  if (name === "ci") return workflowsText(join(root, WORKFLOWS_DIR));
  const file = name === "battery" || name === "npm-alias" ? "package.json" : TRANSPORTS[name];
  const path = join(root, file);
  if (!existsSync(path)) die(`transport '${name}' is missing its file: ${file}\n  fix: restore the wiring (docs/WIRING.md)`);
  const text = readFileSync(path, "utf8");
  return file === "package.json" ? packageScripts(text, name) : text;
}

/** Every transport's text as the shadow sweep reads it, and the narrower texts a declared gate must
 *  be CARRIED by — direction 1's ci read keeps only the workflows a push actually runs. */
function transportTextsAt(root = ROOT) {
  const texts = Object.fromEntries(Object.keys(TRANSPORTS).map((t) => [t, transportText(t, root)]));
  return { texts, carried: { ...texts, ci: carriedWorkflowsText(join(root, WORKFLOWS_DIR), trackedWorkflows(root)) } };
}

/** The ci transport: the workflow files under `dir` that `keep(file, text)` admits, concatenated.
 *  None at all reads as empty, so a gate declared for ci is reported missing — fail closed. */
function workflowsText(dir, keep = () => true) {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  return files.map((f) => [f, readFileSync(join(dir, f), "utf8")]).filter(([f, text]) => keep(f, text)).map(([, text]) => text).join("\n");
}

/** Direction 1's ci read: a workflow CARRIES a gate only when git tracks it (an untracked scratch
 *  file runs in no CI), it triggers on push or pull_request (a dispatch-only or scheduled workflow
 *  judges no push — the registry's own `why` for the battery is "on every push"), and it cannot
 *  swallow a failed step. The shadow sweep still reads every workflow. */
function carriedWorkflowsText(dir, tracked) {
  return workflowsText(dir, (file, text) => tracked.has(file) && runsOnPush(text) && !swallowsSteps(text));
}

/** The workflow file names git's index holds under root. A git failure is not "none tracked". */
function trackedWorkflows(root, env = process.env) {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--", WORKFLOWS_DIR], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return new Set(out.split("\0").filter(Boolean).map((f) => f.slice(WORKFLOWS_DIR.length + 1)));
  } catch (e) {
    return die(`cannot list the tracked workflows — git ls-files failed (${String(e.message).split("\n")[0]})\n  rule: a ci transport that cannot tell a tracked workflow from a scratch file must not pass\n  fix: run from a git checkout of this repo (or repair git here), then retry`);
  }
}

/** A trigger name at a YAML boundary: a scalar, a flow-list member, or a block key / list item. */
const PUSH_EVENT = /(?:^|[\s,[])["']?(?:push|pull_request)["']?(?=[\s,\]:]|$)/;

/** Pure: does a workflow's top-level `on:` name push or pull_request — as a scalar, a flow list,
 *  or a key of its block? A name nested deeper (a workflow_run's `types: [push]`) is no trigger. */
function runsOnPush(text) {
  const on = /^["']?on["']?:([^\n]*)((?:\n(?:[ \t][^\n]*)?)*)/m.exec(liveText(text, { yaml: true }));
  if (on === null) return false;
  return PUSH_EVENT.test(on[1]) || blockKeys(on[2]).some((key) => PUSH_EVENT.test(key));
}

/** The keys (or list items) at a YAML block's own first indentation — nothing nested. */
function blockKeys(block) {
  const lines = block.split("\n").filter((line) => line.trim() !== "");
  const depth = (line) => line.length - line.trimStart().length;
  const top = Math.min(...lines.map(depth));
  return lines.filter((line) => depth(line) === top).map((line) => line.trim().replace(/^-\s*/, ""));
}

/** Pure: can the workflow swallow a failed step — continue-on-error set to anything but a literal
 *  false (an expression may be true), or an always-false `if:`? Judged per FILE, failing closed:
 *  optional work belongs in a workflow that carries no gate. */
function swallowsSteps(text) {
  const live = liveText(text, { yaml: true });
  return /^[ \t]*(?:-[ \t]+)?continue-on-error:[ \t]*(?!false\b)\S/m.test(live) || /^[ \t]*(?:-[ \t]+)?if:[ \t]*(?:\$\{\{[ \t]*)?false\b/m.test(live);
}

/** package.json's scripts, split by what RUNS: `battery` is the one chain `npm run selftest`
 *  executes; `npm-alias` is every other script, one per line. */
function packageScripts(text, transport = "battery") {
  let scripts;
  try {
    scripts = JSON.parse(text).scripts;
  } catch (e) {
    return die(`package.json does not parse: ${e.message}\n  fix: repair package.json`);
  }
  if (!isPlainObject(scripts)) return die(`package.json has no "scripts" object\n  fix: repair package.json`);
  if (transport === "battery") return typeof scripts.selftest === "string" ? scripts.selftest : "";
  return Object.entries(scripts).filter(([name]) => name !== "selftest").map(([, command]) => command).join("\n");
}

/** Pure: the quote a shell still holds open at the end of `prefix`, given the one open at its
 *  start, or null. `'` quotes everything to the next `'`; `"` honours backslash escapes; outside
 *  quotes `\` escapes one char. */
function openQuote(prefix, quote = null) {
  let open = quote;
  for (let i = 0; i < prefix.length; i += 1) {
    const c = prefix[i];
    if (c === "\\" && open !== "'") i += 1;
    else if (open === null && "'\"".includes(c)) open = c;
    else if (c === open) open = null;
  }
  return open;
}

/** Pure: each line as a shell reads it — `live` (cut at the first `#` that starts a word OUTSIDE
 *  quotes: a `#` inside `"…"` is data the shell runs past, the lint gates' law, 8957fba), the
 *  `quote` open at its start, the `unit` (the one script it belongs to) and its `start` offset in
 *  the joined live text. A quote spans lines within one script — cut per line, `echo "…\n #42"`
 *  hid what followed it: an sh transport is one script; an npm alias one line; in workflow YAML a
 *  single-line `run:` is one script and a `run: |` block runs to its first line indented no deeper
 *  than its key (YAML's rule, whatever the shell's quotes), while every other line is YAML prose
 *  whose quotes span nothing (`complexity-gate's` in a step name). Stated residual: a heredoc body
 *  reads as shell — an apostrophe there holds a quote open (fail closed: what follows reads as
 *  quoted, never carried, and uncut for the shadow sweep). */
function shellLines(text, { yaml = false, lineScripts = false } = {}) {
  const lines = [];
  let [quote, unit, blockKey, start] = [null, 0, -1, 0];
  for (const raw of text.split("\n")) {
    const inBlock = inRunBlock(raw, blockKey);
    if (lineScripts || (yaml && !inBlock)) [quote, unit, blockKey] = [null, unit + 1, -1];
    const live = liveLine(raw, quote);
    lines.push({ live, quote, unit, start });
    [quote, start] = [openQuote(live, quote), start + live.length + 1];
    if (yaml && !inBlock) blockKey = runBlockKey(live);
  }
  return lines;
}

/** Is the line still inside the `run: |` block whose key sits at `blockKey` (-1: none open)? */
const inRunBlock = (line, blockKey) => blockKey !== -1 && (line.trim() === "" || line.length - line.trimStart().length > blockKey);

/** The column of a `run: |` (or `>`) block scalar's key on its line, or -1. */
function runBlockKey(line) {
  const header = /^[ \t]*(?:-[ \t]+)?(?=run:[ \t]*[|>])/.exec(line);
  return header === null ? -1 : header[0].length;
}

/** The text a shell would RUN (shellLines), joined. */
function liveText(text, shell = {}) {
  return shellLines(text, shell).map((line) => line.live).join("\n");
}

function liveLine(line, quote = null) {
  for (let at = line.indexOf("#"); at !== -1; at = line.indexOf("#", at + 1)) {
    if ((at === 0 || /\s/.test(line[at - 1])) && openQuote(line.slice(0, at), quote) === null) return line.slice(0, at);
  }
  return line;
}

/** Where a command can start: a line (after a YAML `- ` / `run:`), or after `&&`, `;`, `then`,
 *  `do`, `else` — optionally behind `if` / `!` / `sh -c '`, environment assignments and `exec`.
 *  `echo <invocation>` starts nothing, and a start inside an open quote is echo text (carries()). */
const COMMAND_START = `(?:^|&&|;|\\bthen\\b|\\bdo\\b|\\belse\\b)\\s*(?:-\\s+)?(?:run:\\s*)?(?<cond>(?:(?:if|!)\\s+)*)(?:sh\\s+-c\\s+(?<q>['"]))?(?:[A-Za-z_]\\w*=(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s'"|&;]*)[ \\t]+)*(?:exec[ \\t]+)?`;
/** One shell word: quoted strings and plain characters, glued (`--x="a b"`). */
const WORD = `(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s|&;<>'"()])+`;
/** Arguments and redirections (`2>&1`, `>"/tmp/log"`): neither changes whose status decides. */
const ARGS = `(?:[ \\t]*\\d*(?:>&\\d+|(?:&>|>>?|<)[ \\t]*${WORD})|[ \\t]+${WORD})*`;
/** Further commands joined by `&&` alone. */
const AND_CHAIN = `(?:[ \\t]*&&\\s*${WORD}${ARGS})*`;
/** A failing exit status: 1-255 (the status is taken modulo 256 — `exit 256` exits 0). */
const EXIT_CODE = `(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d?)`;
/** The one fallback that keeps a failed verdict: `|| exit` with a failing status, or the failed
 *  command's own (`exit`, `exit $?`). */
const EXIT_NONZERO = `\\|\\|[ \\t]*exit(?:[ \\t]+(?:${EXIT_CODE}|"?\\$\\?"?))?(?=[\\s;'"]|$)`;
/** An if-probe: the condition's arguments, then the body up to its `fi`. */
const IF_PROBE = new RegExp(`^${ARGS}[ \\t]*[;\\n]\\s*then\\b(?<body>[\\s\\S]*?)\\bfi\\b`);

/** The rest of a command when its verdict survives: arguments, a clean `&&` chain, and at most an
 *  `|| exit <failing>` that runs in THIS shell — followed by nothing but a `;` (`|| exit 1 &` and
 *  `|| exit 1 | tee` exit a subshell). No other `||`, no pipe (no pipefail: the status is tee's),
 *  no `;` or `&` before it. An `sh -c` script must be such a chain to its closing quote, and the
 *  outer tail is judged again: `sh -c '… || exit 1' || true` swallows the inner shell's exit. */
function chainTail(q) {
  const inner = q === undefined ? "" : `${ARGS}${AND_CHAIN}(?:[ \\t]*${EXIT_NONZERO})?[ \\t]*${q}`;
  return new RegExp(`^${inner}${ARGS}(?<and>${AND_CHAIN})[ \\t]*(?:(?<exit>${EXIT_NONZERO})[ \\t]*(?:;[^\\n]*)?)?(?:\\n|$)`);
}

/**
 * Does the transport text carry the invocation AS A LIVE, WHOLE, BLOCKING COMMAND? Collision
 * classes, all pinned in the self-test: a plain substring test makes `node tools/task-coverage.mjs`
 * (the fence) appear inside `node tools/task-coverage.mjs --staged` (a different gate), and a mere
 * trailing word-boundary still matches a flag continuation — so the invocation must be followed by
 * neither a word character nor a flag. A mention is not a run: the invocation must START a command
 * on a live (uncommented) line, outside any quote — a quote opened on an earlier line of the same
 * script included. And a run whose status is thrown away decides nothing: an ALLOWLIST, not a list
 * of banned spellings (the denylist missed `2>&1 || true`, `|| echo`, `| tee`, `; true`) — see
 * keepsVerdict. Options: `advisory` (a declared gate's licence) accepts any tail; `errexit` is the
 * script's initial state (errexitAt decides it per line); `yaml` / `lineScripts` say what one
 * script is (shellLines). Stated residuals: a shell construct beyond these shapes (`|| { …; exit
 * 1; }`, a subshell, a loop) reads as not carried — fail closed; CI's step-level shell is assumed
 * to be the default `bash -e`; and REACHABILITY is not judged — a run behind an earlier `exit 0`,
 * in a dead branch (`if false`), in a function nothing calls, or after a command whose failure
 * skips it (`false && node …`) reads as carried. Escaped, never interpreted: invocation text is data.
 */
export function carries(text, invocation, options = {}) {
  const shell = { advisory: false, errexit: true, ...options };
  const lines = shellLines(text, shell);
  const live = lines.map((line) => line.live).join("\n");
  const starts = new RegExp(`${COMMAND_START}${wholeInvocation(invocation)}`, "gm");
  return [...live.matchAll(starts)].some((m) => runCarries(live, lines, m, shell));
}

/** One command-start match: outside any quote, and — unless advisory — its verdict kept to the end
 *  of its own script. */
function runCarries(live, lines, m, shell) {
  const at = lines.findLast((line) => line.start <= m.index);
  const prefix = live.slice(at.start, m.index);
  if (openQuote(prefix, at.quote) !== null) return false;
  if (shell.advisory) return true;
  const script = lines.filter((line) => line.unit === at.unit);
  const last = script[script.length - 1];
  const errexit = errexitAt(script.filter((line) => line.start < at.start), prefix, at.quote, shell.errexit);
  return keepsVerdict(live.slice(m.index + m[0].length, last.start + last.live.length), m.groups, errexit);
}

/** A `set` command and its options, where a command can start. */
const SET_COMMAND = /(?:^|[;&|({]|\b(?:then|do|else)\b)[ \t]*set((?:[ \t]+[^\s;&|]+)*)/g;

/** Pure: is errexit on where a command starts? The script's initial state, then every `set` before
 *  it in order: `set +e` (or `+o errexit`) anywhere turns it off; `set -e` (or `-o errexit`) turns
 *  it on only at column 0 outside any quote — indented it may sit in a branch or a function that
 *  never runs, and after the line it guards nothing. Both readings fail closed. */
function errexitAt(before, prefix, quote, initial) {
  let on = initial;
  for (const [text, open] of [...before.map((line) => [line.live, line.quote]), [prefix, quote]]) {
    for (const m of text.matchAll(SET_COMMAND)) on = setsErrexit(m, open) ?? on;
  }
  return on;
}

/** One `set`'s effect on errexit: false, true, or null (none). Options end at `--`. */
function setsErrexit(m, quote) {
  const options = ` ${m[1].split(/[ \t]--(?:[ \t]|$)/)[0]}`;
  if (/\s\+(?:[A-Za-z]*e|o[ \t]+errexit\b)/.test(options)) return false;
  const topLevel = m.index === 0 && m[0].startsWith("set") && quote === null;
  return topLevel && /\s-(?:[A-Za-z]*e|o[ \t]+errexit\b)/.test(options) ? true : null;
}

/** Does the command's exit status still decide its script (`rest` runs to the script's end)? An
 *  if-probe must exit with a failing status in a branch; any other run must be a clean chain
 *  (chainTail) that ends in `|| exit`, ends its script, or runs under errexit — which stops only on
 *  a failed command neither `!`-inverted nor followed by `&&` (POSIX `set -e`: `sh -e -c 'false &&
 *  :'` runs on). */
function keepsVerdict(rest, { cond, q }, errexit) {
  if (/\bif\b/.test(cond)) {
    const probe = IF_PROBE.exec(rest);
    return probe !== null && exitsNonzero(probe.groups.body);
  }
  const tail = chainTail(q).exec(rest);
  if (tail === null) return false;
  const stops = errexit && !cond.includes("!") && tail.groups.and === "";
  return stops || tail.groups.exit !== undefined || rest.slice(tail[0].length).trim() === "";
}

/** Pure: does an if-probe's body run `exit N` (1-255) as a command, outside any quote? A bare
 *  `exit` there exits with the condition's status — 0 when the branch ran on success. */
function exitsNonzero(body) {
  const exits = new RegExp(`(?:^|[;\\n]|&&|\\bthen\\b|\\belse\\b)[ \\t]*exit[ \\t]+${EXIT_CODE}(?=[\\s;]|$)`, "g");
  return [...body.matchAll(exits)].some((m) => openQuote(body.slice(0, m.index)) === null);
}

/** The invocation, escaped (invocation text is data), followed by neither a word character nor a flag. */
function wholeInvocation(invocation) {
  return `${invocation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\s*--)(?![-\\w])`;
}

/** Does the (live, canonical) text MENTION the invocation anywhere? The shadow direction's test: a
 *  prefix (`FORCE_COLOR=0`, `exec`, a quoted `run:`) or a swallowed verdict keeps a gate out of
 *  carries(), and must not keep it out of the undeclared-transport report too. */
function mentions(text, invocation) {
  return new RegExp(wholeInvocation(invocation)).test(text);
}

/** Every spelling node runs a tools/ script by, rewritten to the canonical `node tools/X.mjs`:
 *  node's own options, a `./` or `$VAR/` prefix, or quotes must not hide a shadow gate. Stated
 *  residual: any other prefix (an absolute path, `$(dirname "$0")/..`) stays unswept. */
function canonicalSpellings(text) {
  return text.replace(/\bnode(?:[ \t]+-[^\s|&;'"]+)*[ \t]+(["']?)(?:\.\/|\$\{?\w+\}?\/)?(tools\/[\w./-]+\.mjs)\1/g, "node $2");
}

/**
 * Pure: the drift verdict. Returns error strings for (1) declared gates missing from their
 * transports and (2) an invocation appearing in a transport that does not declare it — an
 * undeclared invocation is a shadow gate, code that looks like enforcement but is registered
 * nowhere. The shadow sweep visits EVERY transport, not just ones that already carry a declared
 * gate: a transport carrying nothing but shadows is exactly the one nobody is watching. Direction
 * 1 reads `carriedTexts` (the ci read there is narrower — transportTextsAt), direction 2 the rest;
 * and the battery, whose self-test members no row declares, must be one clean chain.
 */
export function checkDeclarations(gates, transportTexts, carriedTexts = transportTexts) {
  return [...missingErrors(gates, carriedTexts), ...shadowErrors(gates, transportTexts), ...batteryChainErrors(transportTexts.battery)];
}

/** Direction 1: a declared gate missing from a transport that must carry it — the drift upstream paid for. */
function missingErrors(gates, transportTexts) {
  const errors = [];
  for (const gate of gates) {
    for (const transport of gate.transports) {
      const text = transportTexts[transport] ?? "";
      if (!carries(text, gate.invocation, carryOptions(gate, transport, text))) {
        errors.push(`gate '${gate.id}' is declared to run in ${transport} (${transport === "ci" ? CARRIED_CI : TRANSPORTS[transport]}) but the file does not carry it as a live command whose failure fails the transport: ${gate.invocation}`);
      }
    }
  }
  return errors;
}

/** The liveness law's per-gate inputs: an ADVISORY gate may swallow its verdict, and the transport
 *  says how its text runs as shell (shellOf). */
function carryOptions(gate, transport, text) {
  return { ...shellOf(transport, text), advisory: gate.advisory === true };
}

/** One clean `&&` chain: commands (none `!`-inverted) with their arguments and redirections. */
const CLEAN_CHAIN = new RegExp(`^(?!!\\s)${WORD}${ARGS}(?:[ \\t]*&&\\s*(?!!\\s)${WORD}${ARGS})*`);

/** The battery's members are exempt from REGISTRATION (the doctor's missingSelfTests governs its
 *  bare --self-test runs), never from the liveness law. `npm run selftest` is one sh script whose
 *  status is its last command's, so a `|| true`, `;`, `|`, `&` or `!` anywhere lets every member
 *  before it fail unseen — the self-tests no row declares included (a review finding: only the
 *  declared gates' tails were judged). The whole script must be one clean `&&` chain. */
function batteryChainErrors(battery = "") {
  const live = liveText(battery).trim();
  const clean = CLEAN_CHAIN.exec(live)?.[0] ?? "";
  if (clean.length === live.length) return [];
  return [`${TRANSPORTS.battery} is not one clean && chain — it breaks at '${live.slice(clean.length).trim().slice(0, 60)}', so a member that fails before that point fails nothing\n  fix: join every member with && alone (no ||, ;, |, & or !); optional work belongs in an npm alias`];
}

/** Direction 2: a transport carrying an invocation registered nowhere — a shadow gate. Visits
 *  EVERY transport, and BOTH shapes: a DECLARED invocation appearing where it is not declared,
 *  and a WHOLLY-unregistered invocation (an adversarial finding: the first draft swept only
 *  declared invocations, so wiring a new gate into pre-push without registering it — the exact
 *  multi-surface drift this tool exists for — stayed green). It reads the live text in canonical
 *  spelling, so neither a quoted `#` nor a `./` prefix hides a command the shell runs. */
function shadowErrors(gates, transportTexts) {
  const errors = [];
  for (const [transport, raw] of Object.entries(transportTexts)) {
    const text = canonicalSpellings(liveText(raw, shellOf(transport, raw)));
    for (const gate of gates) {
      if (!gate.transports.includes(transport) && mentions(text, gate.invocation)) {
        errors.push(`${TRANSPORTS[transport]} carries '${gate.invocation}' but gate '${gate.id}' does not declare the ${transport} transport — an undeclared invocation is a shadow gate`);
      }
    }
    for (const invocation of new Set(unregisteredInvocations(gates, transport, text))) {
      errors.push(`${TRANSPORTS[transport]} invokes '${invocation}' which no gate declares — register it (docs/gates/gate-registry.json) or remove the invocation; an unregistered gate is a shadow gate`);
    }
  }
  return errors;
}

/**
 * Every `node tools/X.mjs [args]` command in a (live, canonical) transport text that no gate
 * accounts for. The whole command is captured up to a shell operator — a flag does NOT hide it (an
 * adversarial finding: the first sweep skipped every `--` continuation, so `node tools/new-gate.mjs
 * --check` wired into pre-push stayed green). Exempt: exactly `node tools/X.mjs --self-test` in the
 * BATTERY, which the doctor's missingSelfTests governs — nowhere else, and no other spelling
 * (`--self-test=off` is a real run to a tool that tests argv for the whole flag). A command is
 * accounted for when it IS a declared invocation, or extends one with arguments in a transport that
 * gate declares (CI's `--base "$BASE"` is the push fence). Stated residual: extra arguments on a
 * gate, in a transport it declares, pass as that gate.
 */
function unregisteredInvocations(gates, transport, text) {
  const commands = [...text.matchAll(/node\s+(tools\/[\w./-]+\.mjs(?:[ \t]+[^\s|&;]+)*)/g)].map((m) => `node ${m[1]}`);
  return commands.filter((invocation) => !batterySelfTest(transport, invocation) && !gates.some((gate) => accountsFor(gate, transport, invocation)));
}

const batterySelfTest = (transport, invocation) => transport === "battery" && /^node \S+ --self-test$/.test(invocation);

function accountsFor(gate, transport, invocation) {
  return new RegExp(`^${wholeInvocation(gate.invocation)}`).test(invocation) || (gate.transports.includes(transport) && invocation.startsWith(`${gate.invocation} `));
}

const FIXTURE_GATES = [
  { id: "a", invocation: "node tools/a.mjs", transports: ["pre-commit", "ci"] },
  { id: "b", invocation: "node tools/b.mjs", transports: ["pre-push"] },
];
const FIXTURE_GOOD = { "pre-commit": "node tools/a.mjs || exit 1", ci: "run: node tools/a.mjs", "pre-push": "node tools/b.mjs || exit 1" };

function selfTestFixtures(fail) {
  const gates = FIXTURE_GATES;
  const good = FIXTURE_GOOD;
  if (checkDeclarations(gates, good).length !== 0) fail("a fully-wired declaration set was reported");
  const missing = { ...good, ci: "run: something-else" };
  if (checkDeclarations(gates, missing).length !== 1 || !checkDeclarations(gates, missing)[0].includes("gate 'a'")) fail("a gate missing from a declared transport was not caught");
  const shadow = { ...good, battery: "node tools/a.mjs && node tools/b.mjs --self-test" };
  if (checkDeclarations(gates, shadow).length !== 1 || !checkDeclarations(gates, shadow)[0].includes("shadow")) fail("an undeclared invocation in a transport was not caught as a shadow gate");
  // A flag-suffixed spelling is a DIFFERENT command, not the bare one: prefix-colliding
  // invocations (the fence vs its own --staged form) must not shadow-report each other. The
  // fixture puts the bare invocation's TEXT inside a flag-suffixed command in a transport the
  // bare gate does NOT declare — the collision the first draft reported.
  const suffixed = { ...good, battery: "node tools/a.mjs --self-test && node tools/b.mjs --self-test" };
  const unregistered = { ...good, "pre-commit": "node tools/a.mjs || exit 1\nnode tools/brand-new-gate.mjs || exit 1" };
  if (checkDeclarations(gates, unregistered).length !== 1 || !checkDeclarations(gates, unregistered)[0].includes("brand-new-gate")) fail("a wholly-unregistered invocation in a transport was invisible to the shadow sweep");
  if (checkDeclarations(gates, suffixed).length !== 0) fail("a flag-suffixed spelling was reported as carrying the bare invocation");
  // The registry's own config must be honest against the real tree right now.
  const { texts, carried } = transportTextsAt();
  const live = checkDeclarations(loadRegistry(), texts, carried);
  if (live.length !== 0) fail(`the committed registry does not describe this tree:\n    ${live.join("\n    ")}`);
}

/** Carried means a LIVE command: a comment, an echo argument, or a swallowed verdict (`|| true`)
 *  runs nothing, and a transport reduced to one is a dropped gate wearing the invocation's text. */
function selfTestLiveness(fail) {
  const decoys = [
    ["a commented-out invocation counted as carried", "#  run: node tools/a.mjs"],
    ["a command start inside a comment counted as carried", "# retry; node tools/a.mjs"],
    ["an echoed invocation counted as carried", "run: echo node tools/a.mjs"],
    ["a trailing-comment mention counted as carried", "run: echo skipped  # node tools/a.mjs"],
    ["a swallowed verdict counted as carried", "node tools/a.mjs || true"],
    ["a redirected swallowed verdict counted as carried", "node tools/a.mjs 2>&1 || true"],
    ["a redirected swallowed verdict counted as carried (>&2)", "node tools/a.mjs >&2 || true"],
    ["a swallowed verdict behind a quoted # counted as carried", 'node tools/a.mjs >"/tmp/ #x.log" || true'],
    ["an echo fallback counted as carried", 'node tools/a.mjs || echo "refused, continuing"'],
    ["a piped verdict counted as carried", "node tools/a.mjs | tee a.log"],
    ["a verdict sequenced away counted as carried", "node tools/a.mjs; true"],
    ["a backgrounded run counted as carried", "node tools/a.mjs &"],
    ["a chain swallowed at its end counted as carried", "node tools/a.mjs && node tools/b.mjs || true"],
    ["an if-probe that ignores its verdict counted as carried", "if node tools/a.mjs; then :; fi"],
    ["a command start inside an echoed string counted as carried", 'echo "fix: stage it, then node tools/a.mjs"'],
    ["a command start inside an echoed string counted as carried (;)", 'echo "hint; node tools/a.mjs || exit 1"'],
    ["a command start inside an echoed string counted as carried (&&)", 'echo "x && node tools/a.mjs"'],
    ["a command start inside a multi-line echo counted as carried", 'echo "hint\nnode tools/a.mjs || exit 1"'],
    ["an exit-0 fallback counted as carried", "node tools/a.mjs || exit 0"],
    ["a no-op fallback counted as carried", "node tools/a.mjs || :"],
    ["an exit backgrounded after || exit counted as carried", "node tools/a.mjs || exit 1 &"],
    ["an exit piped after || exit counted as carried", "node tools/a.mjs || exit 1 | tee a.log"],
    ["an exit status of 256 (it exits 0) counted as nonzero", "node tools/a.mjs || exit 256"],
    ["a quoted exit in an if-probe body counted as carried", 'if node tools/a.mjs; then echo "exit 1 would follow"; fi'],
    ["a bare exit in an if-probe body (it exits 0) counted as carried", "if node tools/a.mjs; then exit; fi"],
    ["a swallowed sh -c status counted as carried", "sh -c 'node tools/a.mjs || exit 1' || true"],
  ];
  for (const [name, text] of decoys) if (carries(text, "node tools/a.mjs")) fail(name);
  const live = [
    ["a hook line", "node tools/a.mjs || exit 1"],
    ["a YAML run step", "      - run: node tools/a.mjs"],
    ["an if-probe", "if node tools/a.mjs x; then exit 1; fi"],
    ["a multi-line refusal probe", 'if node tools/a.mjs x; then\n  echo "accepted: decoration"; exit 1\nfi'],
    ["an &&-chained battery segment", "node tools/b.mjs --self-test && node tools/a.mjs"],
    ["a quoted argument", 'node tools/a.mjs "$1" || exit 1'],
    ["a redirected blocking run", "node tools/a.mjs >/dev/null 2>&1 || exit 1"],
    ["a closed echo before a real separator", 'echo "done"; node tools/a.mjs'],
    ["an sh -c run", "sh -c 'node tools/a.mjs' || exit 1"],
    ["an env-prefixed run", "      - run: FORCE_COLOR=0 node tools/a.mjs"],
    ["an exec'd run", "exec node tools/a.mjs"],
    ["a command sequenced after || exit", "node tools/a.mjs || exit 1; echo next"],
    ["an exit status of 255", "node tools/a.mjs || exit 255"],
    ["an if-probe exiting from its else branch", "if node tools/a.mjs; then :; else exit 1; fi"],
  ];
  for (const [name, text] of live) if (!carries(text, "node tools/a.mjs")) fail(`a live invocation was not carried: ${name}`);
}

/** A bare hook line is live only when it ends the script or `set -e` is on — sh without errexit
 *  carries on past a failed command. A gate declared ADVISORY may swallow its own verdict. */
function selfTestHookSemantics(fail) {
  const gates = [{ id: "a", invocation: "node tools/a.mjs", transports: ["pre-commit"] }];
  const errorsFor = (hook, declared = gates) => checkDeclarations(declared, { "pre-commit": hook }).length;
  if (errorsFor("node tools/a.mjs\necho done") !== 1) fail("a bare non-final hook line (no set -e) counted as carried");
  if (errorsFor("set -e\nnode tools/a.mjs\necho done") !== 0) fail("a bare hook line under set -e was not carried");
  if (errorsFor("echo start\nnode tools/a.mjs") !== 0) fail("a hook's final bare line was not carried");
  if (errorsFor("node tools/a.mjs || true\necho done", [{ ...gates[0], advisory: true }]) !== 0) fail("a declared advisory gate's swallowed verdict was not carried");
  if (errorsFor("node tools/a.mjs || true") !== 1) fail("a swallowed verdict carried a gate not declared advisory");
}

/** errexit is decided where the line runs, and it stops only on a failed command that is neither
 *  `!`-inverted nor followed by `&&` (POSIX `set -e`; `sh -e -c 'false && :'` runs on). */
function selfTestErrexit(fail) {
  const errorsFor = (hook) => checkDeclarations([{ id: "a", invocation: "node tools/a.mjs", transports: ["pre-commit"] }], { "pre-commit": hook }).length;
  const runsOn = [
    ["a set -e after the line counted as errexit", "#!/bin/sh\nnode tools/a.mjs\nset -e\necho done"],
    ["a non-final &&-continued line under set -e counted as carried", "#!/bin/sh\nset -e\nnode tools/a.mjs && echo ok\necho done"],
    ["an inverted line under set -e counted as carried", "set -e\n! node tools/a.mjs\necho done"],
    ["a set +e before the line left errexit on", "set -e\nset +e\nnode tools/a.mjs\necho done"],
    ["an indented set -e (a branch that may never run) counted as errexit", "if false; then\n  set -e\nfi\nnode tools/a.mjs\necho done"],
  ];
  for (const [name, hook] of runsOn) if (errorsFor(hook) !== 1) fail(name);
  const stops = [
    ["a -e shebang did not count as errexit", "#!/bin/sh -e\nnode tools/a.mjs\necho done"],
    ["an &&-continued line kept by || exit under set -e was not carried", "set -e\nnode tools/a.mjs && echo ok || exit 1\necho done"],
    ["a line after set -e on its own line was not carried", "set -eu\necho start && node tools/a.mjs\necho done"],
  ];
  for (const [name, hook] of stops) if (errorsFor(hook) !== 0) fail(name);
}

/** The shadow sweep reads what the shell runs: a quoted `#` is data, not a comment; `--self-test`
 *  is exempt only as the battery's whole command; and a `./`, `$ROOT/`, quoted or node-optioned
 *  spelling of a tools/ script is still that script. */
function selfTestShadowSpellings(fail) {
  const hidden = [
    ["an invocation after a quoted # was cut from the shadow sweep", 'echo "wiring #42" && node tools/brand-new-gate.mjs || exit 1'],
    ["a --self-test spelling outside the battery hid an unregistered gate", "node tools/brand-new-gate.mjs --self-test || exit 1"],
    ["a prefixed, quoted or optioned spelling hid a shadow gate (./)", "node ./tools/brand-new-gate.mjs || exit 1"],
    ["a prefixed, quoted or optioned spelling hid a shadow gate ($ROOT)", 'node "$ROOT/tools/brand-new-gate.mjs" || exit 1'],
    ["a prefixed, quoted or optioned spelling hid a shadow gate (quoted)", 'node "tools/brand-new-gate.mjs" || exit 1'],
    ["a prefixed, quoted or optioned spelling hid a shadow gate (option)", "node --no-warnings tools/brand-new-gate.mjs || exit 1"],
    ["a prefixed, quoted or optioned spelling hid a shadow gate (declared elsewhere)", "node ./tools/a.mjs || exit 1"],
    ["a quote spanning lines hid an unregistered gate", 'echo "multi\n #42" && node tools/brand-new-gate.mjs || exit 1'],
  ];
  for (const [name, line] of hidden) {
    if (checkDeclarations(FIXTURE_GATES, { ...FIXTURE_GOOD, "pre-push": `node tools/b.mjs || exit 1\n${line}` }).length !== 1) fail(name);
  }
  if (checkDeclarations(FIXTURE_GATES, { ...FIXTURE_GOOD, ci: "run: node tools/a.mjs\nrun: node tools/brand-new-gate.mjs --self-test" }).length !== 1) fail("a --self-test spelling outside the battery hid an unregistered gate (ci)");
  if (checkDeclarations(FIXTURE_GATES, { ...FIXTURE_GOOD, battery: "node tools/brand-new-gate.mjs --self-test=off --check" }).length !== 1) fail("a --self-test= spelling hid an unregistered gate in the battery");
}

/** The battery is the chain `npm run selftest` runs: an npm alias runs only when someone types it,
 *  so a live gate carried by nothing but an alias is missing from the battery. */
function selfTestBattery(fail) {
  const pkg = JSON.stringify({ scripts: { selftest: "node tools/b.mjs --self-test", live: "node tools/a.mjs" } });
  const gates = [{ id: "a", invocation: "node tools/a.mjs", transports: ["battery"] }];
  if (checkDeclarations(gates, { battery: packageScripts(pkg) }).length !== 1) fail("a live gate carried only by an npm alias passed as a battery member");
  const aliased = [{ ...gates[0], transports: ["npm-alias"] }];
  if (checkDeclarations(aliased, { battery: packageScripts(pkg), "npm-alias": packageScripts(pkg, "npm-alias") }).length !== 0) fail("a gate declared for npm-alias was not carried by its alias");
  // Every alias is a script of its own: its last command's status is its own, whatever follows it.
  const chained = JSON.stringify({ scripts: { first: "node tools/a.mjs && echo ok", second: "echo 'x" } });
  if (checkDeclarations(aliased, { "npm-alias": packageScripts(chained, "npm-alias") }).length !== 0) fail("an alias's last command was judged against the next alias");
  if (!checkDeclarations([], { "npm-alias": packageScripts(pkg, "npm-alias") })[0]?.includes("node tools/a.mjs")) fail("an unregistered npm alias escaped the shadow sweep");
  // One swallow anywhere in the chain frees every member before it — the bare self-tests included,
  // which no row declares (a review finding: only declared gates' tails were judged).
  const swallows = [
    "node tools/c.mjs --self-test && node tools/b.mjs --self-test || true && node tools/a.mjs",
    "node tools/c.mjs --self-test && node tools/b.mjs --self-test 2>&1 || true && node tools/a.mjs",
    "! node tools/b.mjs --self-test && node tools/a.mjs",
    "node tools/b.mjs --self-test; node tools/a.mjs",
  ];
  for (const battery of swallows) {
    if (!checkDeclarations(gates, { battery }).some((e) => e.includes("clean && chain"))) fail(`a swallowed self-test verdict in the battery chain passed: ${battery}`);
  }
  if (checkDeclarations(gates, { battery: "node tools/b.mjs --self-test && FORCE_COLOR=0 node tools/a.mjs 2>&1" }).length !== 0) fail("a clean && battery chain was refused");
}

/** transportText reads the ci transport at ANY root — every workflow, `.yaml` included (a
 *  selftest.yml-only read passed while this tree had one workflow) — and trackedWorkflows asks
 *  git's index, never the disk. Driven in a scratch repo with git's inherited GIT_* env removed. */
function selfTestCiAtRoot(fail) {
  const host = mkdtempSync(join(tmpdir(), "gate-registry-host-"));
  try {
    const flows = join(host, WORKFLOWS_DIR);
    mkdirSync(flows, { recursive: true });
    writeFileSync(join(flows, "selftest.yml"), "on: push\n      - run: node tools/a.mjs\n");
    writeFileSync(join(flows, "release.yaml"), "      - run: node tools/brand-new-gate.mjs\n");
    if (!transportText("ci", host).includes("brand-new-gate")) fail("transportText('ci') did not read every workflow file at its root");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    execFileSync("git", ["init", "-q"], { cwd: host, env, stdio: "ignore" });
    execFileSync("git", ["add", join(WORKFLOWS_DIR, "selftest.yml")], { cwd: host, env, stdio: "ignore" });
    if ([...trackedWorkflows(host, env)].join(",") !== "selftest.yml") fail("trackedWorkflows counted a workflow git does not track");
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
}

/** A ci gate is CARRIED only by a tracked workflow that runs on push or pull_request and cannot
 *  swallow a failed step; the shadow direction still reads every workflow. */
function selfTestCiCarriage(fail) {
  const STEPS = "jobs:\n  x:\n    steps:\n";
  const RUN = `${STEPS}      - run: node tools/a.mjs\n`;
  const cases = [
    ["a ci gate carried only by a workflow_dispatch workflow passed as carried", "on: workflow_dispatch\n" + RUN, true, 1],
    ["a ci gate carried only by an untracked workflow passed as carried", "on: push\n" + RUN, false, 1],
    ["a ci gate carried by a continue-on-error workflow passed as carried", "on: push\n" + RUN + "        continue-on-error: true\n", true, 1],
    ["a ci gate carried by an if: false step passed as carried", "on: push\n" + RUN + "        if: false\n", true, 1],
    ["a ci gate carried only by a push named below the on: keys passed as carried", "on:\n  workflow_run:\n    types: [push]\n" + RUN, true, 1],
    ["a block on: push workflow did not carry", "on:\n  push:\n    branches: [main]\n  pull_request:\n" + RUN, true, 0],
    ["a flow-list on: workflow did not carry", "on: [pull_request, workflow_dispatch]\n" + RUN, true, 0],
    ["a quoted on: key workflow did not carry", '"on":\n  pull_request:\n' + RUN, true, 0],
    // A run block is one `bash -e` script: errexit skips a line followed by `&&` unless it ends the
    // block; a quote spans its lines, and YAML prose (`doctor's`) quotes nothing.
    ["a non-final &&-continued ci run-block line counted as carried", `on: push\n${STEPS}      - run: |\n          node tools/a.mjs && echo "a passed"\n          echo done\n`, true, 1],
    ["a command start inside a multi-line echo in a run block counted as carried", `on: push\n${STEPS}      - run: |\n          echo "hint\n          node tools/a.mjs || exit 1"\n`, true, 1],
    ["a bare non-final ci run-block line (bash -e) did not carry", `on: push\n${STEPS}      - run: |\n          node tools/a.mjs\n          echo done\n`, true, 0],
    ["a run block's last &&-continued line did not carry", `on: push\n${STEPS}      - run: |\n          echo start\n          node tools/a.mjs && echo ok\n      - run: echo next\n`, true, 0],
    ["a prose apostrophe leaked a quote over the next step", `on: push\n${STEPS}      - name: the doctor's check\n        run: node tools/a.mjs && echo ok\n      - run: echo next\n`, true, 0],
  ];
  const dir = mkdtempSync(join(tmpdir(), "gate-registry-ci-"));
  try {
    for (const [i, [name, body, tracked, expected]] of cases.entries()) {
      const flows = join(dir, String(i));
      mkdirSync(flows);
      writeFileSync(join(flows, "flow.yml"), body);
      const texts = { ...FIXTURE_GOOD, ci: workflowsText(flows) };
      if (checkDeclarations(FIXTURE_GATES, texts, { ...texts, ci: carriedWorkflowsText(flows, new Set(tracked ? ["flow.yml"] : [])) }).length !== expected) fail(name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The shadow sweep sees every flagged spelling but the battery's bare --self-test runs: a flag
 *  does not make an unregistered gate invisible, nor a declared gate's flagged form in a transport
 *  it skips. */
function selfTestFlaggedShadow(fail) {
  const flagged = { ...FIXTURE_GOOD, "pre-push": "node tools/b.mjs || exit 1\nnode tools/brand-new-gate.mjs --check || exit 1" };
  const errors = checkDeclarations(FIXTURE_GATES, flagged);
  if (errors.length !== 1 || !errors[0].includes("brand-new-gate")) fail("a flag-carrying unregistered invocation was invisible to the shadow sweep");
  const elsewhere = { ...FIXTURE_GOOD, "pre-push": "node tools/b.mjs || exit 1\nnode tools/a.mjs --strict || exit 1" };
  if (checkDeclarations(FIXTURE_GATES, elsewhere).length !== 1) fail("a flagged spelling of a declared gate in an undeclared transport was invisible to the shadow sweep");
  // A shadow is any live MENTION, not only a command-start one: a prefix or a swallowed verdict
  // hides a declared gate from carries(), and the sweep accounts it to that gate — neither loop saw it.
  const prefixed = ["FORCE_COLOR=0 node tools/b.mjs || exit 1", "node tools/b.mjs || true", "exec node tools/b.mjs", "run: 'node tools/b.mjs'", "( node tools/b.mjs ) || exit 1"];
  for (const line of prefixed) {
    if (checkDeclarations(FIXTURE_GATES, { ...FIXTURE_GOOD, "pre-commit": `node tools/a.mjs || exit 1\n${line}` }).length !== 1) fail(`a prefixed or swallowed declared gate in an undeclared transport escaped both shadow loops: ${line}`);
  }
  // Allowance: arguments on a gate declared in THIS transport are that gate (CI's `--base "$BASE"`).
  const argued = { ...FIXTURE_GOOD, ci: 'run: node tools/a.mjs\nrun: node tools/a.mjs --base "$BASE"' };
  if (checkDeclarations(FIXTURE_GATES, argued).length !== 0) fail("an argument-extended spelling of a gate declared in that transport was reported");
}

/** The ci transport is EVERY workflow: a host's CI file named ci.yml is read, and a second
 *  workflow carrying an unregistered gate is swept like the first. */
function selfTestWorkflows(fail) {
  const dir = mkdtempSync(join(tmpdir(), "gate-registry-"));
  try {
    const flows = join(dir, "workflows");
    mkdirSync(flows);
    writeFileSync(join(flows, "ci.yml"), "      - run: node tools/a.mjs\n");
    writeFileSync(join(flows, "notes.md"), "run: node tools/not-a-workflow.mjs\n");
    if (checkDeclarations(FIXTURE_GATES, { ...FIXTURE_GOOD, ci: workflowsText(flows) }).length !== 0) fail("a CI workflow not named selftest.yml was not read as the ci transport");
    writeFileSync(join(flows, "release.yaml"), "      - run: node tools/brand-new-gate.mjs\n");
    const errors = checkDeclarations(FIXTURE_GATES, { ...FIXTURE_GOOD, ci: workflowsText(flows) });
    if (errors.length !== 1 || !errors[0].includes("brand-new-gate")) fail("an unregistered gate in a second workflow was not swept");
    if (!String(errors[0]).includes("yaml")) fail("the ci refusal names a glob that excludes the .yaml workflow it found");
    if (workflowsText(join(dir, "absent")) !== "") fail("a missing workflows directory must read as an empty ci transport");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every shape refusal, driven: a malformed registry must refuse with the rule, never crash. */
function selfTestShapes(fail) {
  const g = (over) => ({ id: "a", invocation: "node tools/a.mjs", transports: ["ci"], ...over });
  const badShapes = [
    ["a null registry", null],
    ["a non-object registry", []],
    ["an empty gates list", { gates: [] }],
    ["a null gate entry", { gates: [null] }],
    ["a gate with no id", { gates: [g({ id: "" })] }],
    ["a gate with no invocation", { gates: [g({ invocation: undefined })] }],
    ["a gate with no transports", { gates: [g({ transports: [] })] }],
    ["an unknown transport", { gates: [g({ transports: ["nope"] })] }],
    ["a non-boolean advisory flag", { gates: [g({ advisory: "yes" })] }],
    ["a duplicated id", { gates: [g(), g({ invocation: "node tools/b.mjs" })] }],
    ["a duplicated invocation", { gates: [g(), g({ id: "b" })] }],
  ];
  for (const [name, body] of badShapes) {
    let refusal;
    try {
      refusal = registryShapeError(body);
    } catch {
      fail(`shape refusal crashed instead of refusing: ${name}`);
      continue;
    }
    if (typeof refusal !== "string") fail(`shape refusal missing: ${name}`);
  }
  if (registryShapeError({ gates: [g(), g({ id: "b", invocation: "node tools/b.mjs" })] }) !== null) fail("a well-shaped registry was refused");
}

export function selfTest() {
  let ok = true;
  const fail = (msg) => {
    console.error(`gate-registry SELF-TEST FAIL: ${msg}`);
    ok = false;
  };
  selfTestFixtures(fail);
  selfTestLiveness(fail);
  selfTestHookSemantics(fail);
  selfTestErrexit(fail);
  selfTestFlaggedShadow(fail);
  selfTestShadowSpellings(fail);
  selfTestShapes(fail);
  selfTestWorkflows(fail);
  selfTestCiCarriage(fail);
  selfTestCiAtRoot(fail);
  selfTestBattery(fail);
  console.log(ok ? `gate-registry self-test: OK (${loadRegistry().length} gate(s), ${Object.keys(TRANSPORTS).length} transports)` : "gate-registry self-test: FAILED");
  return ok;
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
  if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  const gates = loadRegistry();
  const { texts, carried } = transportTextsAt();
  const errors = checkDeclarations(gates, texts, carried);
  if (errors.length > 0) {
    for (const error of errors) console.error(`gate-registry: ${error}`);
    die(`FAILED (${errors.length}) — the declared gate list and the transports have parted; decide which side is right and bring them together. See ${REGISTRY_PATH}.`);
  }
  console.log(`gate-registry: OK — ${gates.length} gate(s) declared once, every transport in agreement`);
  process.exit(0);
}
