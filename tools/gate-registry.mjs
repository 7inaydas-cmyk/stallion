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
 * transports that must carry it. The checker greps each declared transport file for the
 * invocation's text. Failures come in both directions:
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

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const REGISTRY_PATH = "docs/gates/gate-registry.json";

/** The transport files a gate can be declared to run in. Paths are repo-relative. The doctor is
 *  deliberately NOT a transport: its own file mentions every invocation in usage strings, and a
 *  checker must grep surfaces that CARRY commands, not files that DESCRIBE them. The doctor's
 *  gate-config health is its own derived check inside cmdDoctor. */
const TRANSPORTS = {
  "pre-commit": ".githooks/pre-commit",
  "commit-msg": ".githooks/commit-msg",
  "pre-push": ".githooks/pre-push",
  ci: ".github/workflows/selftest.yml",
  battery: "package.json",
};

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
  if (shapeError !== null) die(`${REGISTRY_PATH}: ${shapeError}\n  fix: repair the config`);
  return parsed.gates;
}

/** Pure: the config-shape law, split per gate so the checker itself stays under its own bar. */
function registryShapeError(parsed) {
  if (!Array.isArray(parsed.gates) || parsed.gates.length === 0) return "field 'gates' must be a non-empty array";
  for (const gate of parsed.gates) {
    const gateError = gateShapeError(gate);
    if (gateError !== null) return gateError;
  }
  return null;
}

function gateShapeError(gate) {
  if (typeof gate.id !== "string" || gate.id.length === 0) return "a gate has no id";
  if (typeof gate.invocation !== "string" || gate.invocation.length === 0) return `gate '${gate.id}' has no invocation text`;
  if (!Array.isArray(gate.transports) || gate.transports.length === 0) return `gate '${gate.id}' declares no transports — a gate carried by nothing is not wired`;
  const unknown = gate.transports.find((t) => !(t in TRANSPORTS));
  return unknown === undefined ? null : `gate '${gate.id}' declares unknown transport '${unknown}' (known: ${Object.keys(TRANSPORTS).join(", ")})`;
}

function transportText(name) {
  const path = `${ROOT}${TRANSPORTS[name]}`;
  if (!existsSync(path)) die(`transport '${name}' is missing its file: ${TRANSPORTS[name]}\n  fix: restore the wiring (docs/WIRING.md)`);
  return readFileSync(path, "utf8");
}

/**
 * Does the transport text carry the invocation AS A WHOLE COMMAND? Two collision classes, both
 * pinned in the self-test: a plain substring test makes `node tools/task-coverage.mjs` (the
 * fence) appear inside `node tools/task-coverage.mjs --staged` (a different gate), and a mere
 * trailing word-boundary still matches a flag continuation. The invocation must be followed by
 * neither a word character nor a flag: `invocation(?!\\s*--)(?![-\\w])`. Escaped, never
 * interpreted: invocation text is data.
 */
export function carries(text, invocation) {
  const escaped = invocation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(?!\\s*--)(?![-\\w])`).test(text);
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
 *  EVERY transport, not just ones that already carry a declared gate: a transport carrying
 *  nothing but shadows is exactly the one nobody is watching. */
function shadowErrors(gates, transportTexts) {
  const errors = [];
  for (const [transport, text] of Object.entries(transportTexts)) {
    for (const gate of gates) {
      if (!gate.transports.includes(transport) && carries(text, gate.invocation)) {
        errors.push(`${TRANSPORTS[transport]} carries '${gate.invocation}' but gate '${gate.id}' does not declare the ${transport} transport — an undeclared invocation is a shadow gate`);
      }
    }
  }
  return errors;
}

function selfTestFixtures(fail) {
  const gates = [
    { id: "a", invocation: "node tools/a.mjs", transports: ["pre-commit", "ci"] },
    { id: "b", invocation: "node tools/b.mjs", transports: ["pre-push"] },
  ];
  const good = { "pre-commit": "node tools/a.mjs || exit 1", ci: "run: node tools/a.mjs", "pre-push": "node tools/b.mjs || exit 1" };
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
  if (checkDeclarations(gates, suffixed).length !== 0) fail("a flag-suffixed spelling was reported as carrying the bare invocation");
  // The registry's own config must be honest against the real tree right now.
  const live = checkDeclarations(loadRegistry(), Object.fromEntries(Object.keys(TRANSPORTS).map((t) => [t, transportText(t)])));
  if (live.length !== 0) fail(`the committed registry does not describe this tree:\n    ${live.join("\n    ")}`);
}

export function selfTest() {
  let ok = true;
  const fail = (msg) => {
    console.error(`gate-registry SELF-TEST FAIL: ${msg}`);
    ok = false;
  };
  selfTestFixtures(fail);
  console.log(ok ? `gate-registry self-test: OK (${loadRegistry().length} gate(s), ${Object.keys(TRANSPORTS).length} transports)` : "gate-registry self-test: FAILED");
  return ok;
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
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
