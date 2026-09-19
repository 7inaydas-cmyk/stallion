#!/usr/bin/env node
/**
 * Transport-agreement contract test (issue #21) — the three transports that judge one law.
 *
 * The staged gate (pre-commit) asks "does ANY active task exist". The citation seam
 * (commit-msg + push fence) asks "does THIS record cover THIS file". The authoring gate
 * (PreToolUse hook) asks the citation question one action earlier. They share functions by
 * discipline; this test makes the agreement MECHANICAL: one fixture matrix drives the REAL law
 * (resolved through law-source, so the same test runs against stallion and any vendored
 * layout) and asserts the three relations that must hold — so a refactor that drifts any
 * transport fails the battery instead of silently allowing.
 *
 * The relations (granularity differences are law, not drift):
 *   1. FILTER AGREEMENT — a record alone satisfies the staged gate exactly when the authoring
 *      gate counts it active (same authorizing window, derived from the repo's own PHASES,
 *      same recordRefusal discipline — which is why the fixtures carry a REAL chain: unstamped
 *      post-cutover records are refused by every transport alike, and a matrix where nothing
 *      is active proves nothing).
 *   2. SCOPE AGREEMENT — for an active, non-done record, the authoring gate allows a code file
 *      exactly when scopeRefusal(record, [file]) is null (the citation seam's own question).
 *   3. CLASSIFICATION AGREEMENT — non-code files never need a task, on either transport.
 */
import { findHarnessRoot, loadLaw } from "./law-source.mjs";
import { authoringDecision, authorizingPhases } from "./gate-law.mjs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL("./", import.meta.url));

/** A synthetic but law-valid record: schema-honest, post-cutover, CHAIN-STAMPED, with scope. */
function record(chainStampEvents, id, phase, scope) {
  return {
    schema: "stallion/task-state@1",
    id,
    riskClass: "runtime-code",
    events: chainStampEvents([
      { type: "created", at: "2026-09-19T12:00:00.000Z" },
      ...(scope ? [{ type: "scope", patterns: scope }] : []),
      { type: "transition", to: "planned", at: "2026-09-19T12:01:00.000Z" },
      { type: "transition", to: "executing", at: "2026-09-19T12:02:00.000Z" },
      ...(phase === "executing" ? [] : [
        { type: "transition", to: "verified", at: "2026-09-19T12:03:00.000Z" },
        ...(phase === "verified" ? [] : [
          { type: "transition", to: "adversarial", at: "2026-09-19T12:04:00.000Z" },
          ...(phase === "adversarial" ? [] : [{ type: "transition", to: "done", at: "2026-09-19T12:05:00.000Z" }]),
        ]),
      ]),
      { type: "red-check", command: "node --test synthetic.test.mjs", exitCode: 1, outputDigest: "abc", at: "2026-09-19T12:02:30.000Z" },
    ]),
  };
}

/** Run the matrix against the real law of the repo this file lives in. */
export async function checkAgreement(verbose = false) {
  const failures = [];
  const fail = (m) => failures.push(m);
  const layout = findHarnessRoot(realpathSync(`${HERE}../../..`));
  const law = await loadLaw(layout);
  if (!law.ok) return { failures: [`cannot resolve the real law from ${HERE}: ${law.reason}`] };
  let chainStampEvents;
  try {
    ({ chainStampEvents } = await import(pathToFileURL(join(layout.root, layout.harnessDir, "task-findings.mjs")).href));
  } catch (e) {
    return { failures: [`cannot import chainStampEvents from ${layout.root}: ${e.message}`] };
  }
  const { stagedRefusal, scopeRefusal, isCodePath, recordRefusal } = law.coverage;
  const { derivePhase, PHASES } = law.state;
  const window = [...authorizingPhases(PHASES)]; // the gate's own derivation, imported — never re-typed here
  const CODE = "tools/agreement-probe.mjs";
  const DOC = "docs/agreement-probe.md";
  if (!isCodePath(CODE) || isCodePath(DOC)) fail(`the real law must classify ${CODE} as code and ${DOC} as not-code (got ${isCodePath(CODE)}/${isCodePath(DOC)})`);

  const phases = ["intake", "planned", "executing", "verified", "adversarial", "done", "forged"];
  const scopeShapes = [["tools/**"], ["apps/**"], null];
  let checked = 0;
  let activeCount = 0;
  let coveredCount = 0;
  let uncoveredActiveCount = 0;
  for (const phase of phases) {
    for (const scope of scopeShapes) {
      const r = record(chainStampEvents, `probe-${phase}-${scope ? "scoped" : "bare"}`, phase === "forged" ? "executing" : phase, scope);
      if (phase === "forged") r.events.push({ type: "transition", to: "shipped" }); // derivePhase ignores unknown targets
      if (phase === "intake") r.events = chainStampEvents([r.events[0]]);
      if (phase === "planned") r.events = chainStampEvents([r.events[0], ...(scope ? [{ type: "scope", patterns: scope }] : []), { type: "transition", to: "planned", at: "2026-09-19T12:01:00.000Z" }]);
      const stagedPass = stagedRefusal([CODE], [r]) === null;
      const decision = authoringDecision({ filePath: `${law.root}/${CODE}`, cwd: law.root }, law, [r]);
      const gateActive = decision.reason ? !decision.reason.includes("no task is in flight") : true;
      checked += 1;
      const expectedActive = recordRefusal(r) === null && window.includes(derivePhase(r.events));
      if (expectedActive) activeCount += 1;
      if (expectedActive && phase !== "done" && scopeRefusal(r, [CODE]) === null) coveredCount += 1;
      if (expectedActive && phase !== "done" && scopeRefusal(r, [CODE]) !== null) uncoveredActiveCount += 1;
      // Relation 1: filter agreement (existence vs coverage granularity is deliberate law).
      if (stagedPass !== expectedActive) fail(`staged gate vs derived window disagree on ${r.id}: staged=${stagedPass} expected=${expectedActive}`);
      if (gateActive !== expectedActive) fail(`authoring gate vs derived window disagree on ${r.id}: gate=${gateActive} expected=${expectedActive}`);
      // Relation 2: scope agreement (only meaningful for active, non-done records).
      if (expectedActive && phase !== "done") {
        const covers = scopeRefusal(r, [CODE]) === null;
        const allows = decision.decision === "allow";
        if (covers !== allows) fail(`scope disagreement on ${r.id}: scopeRefusal covers=${covers} but gate allows=${allows}`);
      }
      // Relation 3: non-code never needs a task, on either transport.
      if (stagedRefusal([DOC], [r]) !== null) fail(`staged gate demanded a task for a non-code file (${r.id})`);
      const docDecision = authoringDecision({ filePath: `${law.root}/${DOC}`, cwd: law.root }, law, [r]);
      if (docDecision.decision !== "allow") fail(`authoring gate refused a non-code file (${r.id})`);
    }
  }
  // NON-VACUITY: an all-inactive matrix proves nothing — the sabotage that inspired this guard
  // passed the first version of this very test (unstamped fixtures refused everywhere, alike).
  if (activeCount === 0) fail("the matrix activated zero fixtures — every relation above was vacuous");
  if (coveredCount === 0) fail("no fixture exercised the scope-covered half of relation 2");
  if (uncoveredActiveCount === 0) fail("no fixture exercised the scope-uncovered half of relation 2");
  if (verbose) console.log(`agreement matrix: ${checked} fixtures (${activeCount} active, ${coveredCount} covered, ${uncoveredActiveCount} uncovered-active) through the real law at ${law.root}`);
  return { failures, checked }; // the counts are this test's own non-vacuity facts, not API — no caller reads them
}

export async function selfTest() {
  const { failures, checked } = await checkAgreement(true);
  console.log(failures.length === 0 ? `transport-agreement self-test: OK (${checked} fixtures × 3 transports through the real law — count derived, the agreement is mechanical)` : `transport-agreement self-test: FAILED\n  ${failures.join("\n  ")}`);
  return failures.length === 0;
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isEntry && process.argv.includes("--self-test")) process.exit((await selfTest()) ? 0 : 1);
