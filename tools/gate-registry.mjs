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
 * command (not a comment, an echo, or a swallowed verdict). Failures come in both directions:
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

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const REGISTRY_PATH = "docs/gates/gate-registry.json";

/** The transports a gate can be declared to run in. Paths are repo-relative. The doctor is
 *  deliberately NOT a transport: its own file mentions every invocation in usage strings, and a
 *  checker must grep surfaces that CARRY commands, not files that DESCRIBE them. The doctor's
 *  gate-config health is its own derived check inside cmdDoctor. The names are git's, GitHub's and
 *  npm's, not this repo's data: `ci` is EVERY workflow file (a host's CI file is not always named
 *  selftest.yml, and a second workflow carrying a gate is exactly the one nobody watches), and
 *  `battery` is package.json's scripts. A new transport KIND is a graft to this map, recorded at
 *  vendor time (docs/WIRING.md §1), not a config edit. */
const TRANSPORTS = {
  "pre-commit": ".githooks/pre-commit",
  "commit-msg": ".githooks/commit-msg",
  "pre-push": ".githooks/pre-push",
  ci: ".github/workflows/*.yml",
  battery: "package.json",
};
const WORKFLOWS_DIR = ".github/workflows";

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
  if (shapeError !== null) die(`${REGISTRY_PATH}: ${shapeError}\n  fix: repair ${REGISTRY_PATH} (shape: {"gates":[{"id","invocation","transports":[...],"why"}]})`);
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
  if (!Array.isArray(gate.transports) || gate.transports.length === 0) return `gate '${gate.id}' declares no transports — a gate carried by nothing is not wired`;
  const unknown = gate.transports.find((t) => !(t in TRANSPORTS));
  return unknown === undefined ? null : `gate '${gate.id}' declares unknown transport '${unknown}' (known: ${Object.keys(TRANSPORTS).join(", ")} — the set is TRANSPORTS in tools/gate-registry.mjs; a new kind is a graft recorded at vendor time)`;
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

function transportText(name) {
  if (name === "ci") return workflowsText(`${ROOT}${WORKFLOWS_DIR}`);
  const path = `${ROOT}${TRANSPORTS[name]}`;
  if (!existsSync(path)) die(`transport '${name}' is missing its file: ${TRANSPORTS[name]}\n  fix: restore the wiring (docs/WIRING.md)`);
  const text = readFileSync(path, "utf8");
  return name === "battery" ? batteryScripts(text) : text;
}

/** The ci transport: every workflow file under `dir`, concatenated. None at all reads as empty, so
 *  a gate declared for ci is reported missing — fail closed where it matters. */
function workflowsText(dir) {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  return files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}

/** The battery transport is package.json's SCRIPTS — the commands npm runs, one per line. */
function batteryScripts(text) {
  try {
    return Object.values(JSON.parse(text).scripts).join("\n");
  } catch (e) {
    return die(`package.json has no readable "scripts" object: ${e.message}\n  fix: repair package.json`);
  }
}

/** The text a shell would RUN: `#` comments stripped per line (a whole-line comment, or a trailing
 *  one after whitespace). A mention inside a comment carries nothing. */
function liveText(text) {
  return text.replace(/(^|\s)#.*$/gm, "$1");
}

/** Where a command can start: a line (after a YAML `- ` / `run:`), or after `&&`, `;`, `then`,
 *  `do`, `else` — optionally behind `if` / `!` / `sh -c '`. `echo <invocation>` starts nothing. */
const COMMAND_START = `(?:^|&&|;|\\bthen\\b|\\bdo\\b|\\belse\\b)\\s*(?:-\\s+)?(?:run:\\s*)?(?:(?:if|!)\\s+)*(?:sh\\s+-c\\s+['"])?`;
/** A verdict swallowed in the same segment (`|| true`, `|| :`, `|| exit 0`) wires nothing — the
 *  doctor's invokesMode law, applied to every gate. `|| exit 1` stays a blocking outcome. */
const NOT_SWALLOWED = "(?![^\\n;&|]*\\|\\|\\s*(?:true|:|exit\\s+0)(?![\\w-]))";

/**
 * Does the transport text carry the invocation AS A LIVE, WHOLE COMMAND? Collision classes, all
 * pinned in the self-test: a plain substring test makes `node tools/task-coverage.mjs` (the
 * fence) appear inside `node tools/task-coverage.mjs --staged` (a different gate), and a mere
 * trailing word-boundary still matches a flag continuation — so the invocation must be followed
 * by neither a word character nor a flag. And a mention is not a run: the invocation must START
 * a command on a live (uncommented) line, with its verdict not swallowed — a CI step reduced to
 * `echo skipped # npm run selftest` still contains the text and runs nothing. Escaped, never
 * interpreted: invocation text is data.
 */
export function carries(text, invocation) {
  return new RegExp(`${COMMAND_START}${wholeInvocation(invocation)}${NOT_SWALLOWED}`, "m").test(liveText(text));
}

/** The invocation, escaped (invocation text is data), followed by neither a word character nor a flag. */
function wholeInvocation(invocation) {
  return `${invocation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\s*--)(?![-\\w])`;
}

/** Does a live (uncommented) line MENTION the invocation anywhere? The shadow direction's test: a
 *  prefix (`FORCE_COLOR=0`, `exec`, a quoted `run:`) or a swallowed verdict keeps a gate out of
 *  carries(), and must not keep it out of the undeclared-transport report too. */
function mentions(text, invocation) {
  return new RegExp(wholeInvocation(invocation)).test(liveText(text));
}

/**
 * Pure: the drift verdict. Returns error strings for (1) declared gates missing from their
 * transports and (2) an invocation appearing in a transport that does not declare it — an
 * undeclared invocation is a shadow gate, code that looks like enforcement but is registered
 * nowhere. The shadow sweep visits EVERY transport, not just ones that already carry a declared
 * gate: a transport carrying nothing but shadows is exactly the one nobody is watching.
 */
export function checkDeclarations(gates, transportTexts) {
  return [...missingErrors(gates, transportTexts), ...shadowErrors(gates, transportTexts)];
}

/** Direction 1: a declared gate missing from a transport that must carry it — the drift upstream paid for. */
function missingErrors(gates, transportTexts) {
  const errors = [];
  for (const gate of gates) {
    for (const transport of gate.transports) {
      if (!carries(transportTexts[transport] ?? "", gate.invocation)) {
        errors.push(`gate '${gate.id}' is declared to run in ${transport} (${TRANSPORTS[transport]}) but the file does not carry: ${gate.invocation}`);
      }
    }
  }
  return errors;
}

/** Direction 2: a transport carrying an invocation registered nowhere — a shadow gate. Visits
 *  EVERY transport, and BOTH shapes: a DECLARED invocation appearing where it is not declared,
 *  and a WHOLLY-unregistered invocation (an adversarial finding: the first draft swept only
 *  declared invocations, so wiring a new gate into pre-push without registering it — the exact
 *  multi-surface drift this tool exists for — stayed green). */
function shadowErrors(gates, transportTexts) {
  const errors = [];
  for (const [transport, text] of Object.entries(transportTexts)) {
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
 * Every live `node tools/X.mjs [args]` command in a transport that no gate accounts for. The whole
 * command is captured up to a shell operator — a flag does NOT hide it (an adversarial finding: the
 * first sweep skipped every `--` continuation, so `node tools/new-gate.mjs --check` wired into
 * pre-push stayed green). Only the battery's `--self-test` runs are exempt: the doctor's
 * missingSelfTests already governs them. A command is accounted for when it carries a declared
 * invocation, or extends one with arguments in a transport that gate declares (CI's
 * `--base "$BASE"` is the push fence). Stated residual: extra arguments on a gate, in a
 * transport it declares, pass as that gate.
 */
function unregisteredInvocations(gates, transport, text) {
  const commands = [...liveText(text).matchAll(/node\s+(tools\/[\w./-]+\.mjs(?:[ \t]+[^\s|&;]+)*)/g)].map((m) => `node ${m[1]}`);
  return commands.filter((invocation) => !/^node \S+ --self-test(?![-\w])/.test(invocation) && !gates.some((gate) => accountsFor(gate, transport, invocation)));
}

function accountsFor(gate, transport, invocation) {
  return carries(invocation, gate.invocation) || (gate.transports.includes(transport) && invocation.startsWith(`${gate.invocation} `));
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
  const live = checkDeclarations(loadRegistry(), Object.fromEntries(Object.keys(TRANSPORTS).map((t) => [t, transportText(t)])));
  if (live.length !== 0) fail(`the committed registry does not describe this tree:\n    ${live.join("\n    ")}`);
}

/** Carried means a LIVE command: a comment, an echo argument, or a swallowed verdict (`|| true`)
 *  runs nothing, and a transport reduced to one is a dropped gate wearing the invocation's text. */
function selfTestLiveness(fail) {
  const decoys = [
    ["a commented-out invocation counted as carried", "#  run: node tools/a.mjs"],
    ["an echoed invocation counted as carried", "run: echo node tools/a.mjs"],
    ["a trailing-comment mention counted as carried", "run: echo skipped  # node tools/a.mjs"],
    ["a swallowed verdict counted as carried", "node tools/a.mjs || true"],
  ];
  for (const [name, text] of decoys) if (carries(text, "node tools/a.mjs")) fail(name);
  const live = [
    ["a hook line", "node tools/a.mjs || exit 1"],
    ["a YAML run step", "      - run: node tools/a.mjs"],
    ["an if-probe", "if node tools/a.mjs x; then exit 1; fi"],
    ["an &&-chained battery segment", "node tools/b.mjs --self-test && node tools/a.mjs"],
  ];
  for (const [name, text] of live) if (!carries(text, "node tools/a.mjs")) fail(`a live invocation was not carried: ${name}`);
}

/** The shadow sweep sees EVERY spelling but the battery's --self-test runs: a flag does not make
 *  an unregistered gate invisible, nor a declared gate's flagged form in a transport it skips. */
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
  selfTestFlaggedShadow(fail);
  selfTestShapes(fail);
  selfTestWorkflows(fail);
  console.log(ok ? `gate-registry self-test: OK (${loadRegistry().length} gate(s), ${Object.keys(TRANSPORTS).length} transports)` : "gate-registry self-test: FAILED");
  return ok;
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isEntry) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  const gates = loadRegistry();
  const transportTexts = Object.fromEntries(Object.keys(TRANSPORTS).map((t) => [t, transportText(t)]));
  const errors = checkDeclarations(gates, transportTexts);
  if (errors.length > 0) {
    for (const error of errors) console.error(`gate-registry: ${error}`);
    die(`FAILED (${errors.length}) — the declared gate list and the transports have parted; decide which side is right and bring them together. See ${REGISTRY_PATH}.`);
  }
  console.log(`gate-registry: OK — ${gates.length} gate(s) declared once, every transport in agreement`);
  process.exit(0);
}
