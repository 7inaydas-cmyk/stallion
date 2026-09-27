#!/usr/bin/env node
/**
 * The authoring gate (PreToolUse, matcher Edit|Write|ApplyPatch).
 *
 * Exit-code contract (the hook runner's own): 0 passes, 2 BLOCKS the edit, anything else is an
 * error. The deny text on stderr reaches the model — so it carries the rule, the evidence, and
 * an exact fix command, the same shape every stallion refusal prints. The law is imported from
 * the repo being edited (law-source.mjs); a repo without the harness refuses closed, because a
 * gate that cannot read the law must not bless the edit. The same holds for a gate that CRASHES:
 * an uncaught throw exits 1, which the runner treats as a non-blocking error — a fail-open (a
 * review finding: one malformed record turned the gate off for every edit), so every throw is
 * caught at the top and refused with exit 2. The gate's own modules load INSIDE main(), so a
 * module that fails to parse or link is a throw the catch refuses — a static import dies before
 * the catch exists, exit 1 (an adversarial finding). Only a defect in THIS file stays uncatchable.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The harness this run resolved (null before it is found) — the crash refusal's fix names it. */
let located = null;

async function main() {
  const { findHarnessRoot, loadLaw } = await import("../lib/law-source.mjs");
  const { authoringDecision, parseEditPayload, readRecords } = await import("../lib/gate-law.mjs");
  const { readStdin } = await import("../lib/io.mjs");
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stderr.write("stallion authoring-gate: the hook payload is not JSON — a gate that cannot read its input refuses the edit it was asked to bless.\n  fix: this hook reads the standard PreToolUse stdin payload; if the runner changed shape, update tools/zcode-plugin/hooks/authoring-gate.mjs deliberately.\n");
    process.exit(2);
  }
  const parsed = parseEditPayload(payload);
  if (!parsed.ok) {
    process.stderr.write(`stallion authoring-gate: ${parsed.reason}\n`);
    process.exit(2);
  }
  const layout = findHarnessRoot(parsed.cwd);
  located = layout;
  if (!layout) {
    process.stderr.write(`stallion authoring-gate: no stallion harness found at or above ${parsed.cwd} — there is no lifecycle law to enforce for ${parsed.filePath}.\n  rule: a gate that cannot read the law refuses the edit\n  fix: vendor the harness (tools/task-coverage.mjs, stallion shape) into that repo, or uninstall this plugin there deliberately\n`);
    process.exit(2);
  }
  const law = await loadLaw(layout);
  if (!law.ok) {
    process.stderr.write(`stallion authoring-gate: ${law.reason}.\n  rule: a gate that cannot import the repo's own law refuses the edit\n  fix: run node ${layout.harnessDir}/task-coverage.mjs --self-test in ${layout.root} to surface the import error, or update the vendored copy to the current stallion cut\n`);
    process.exit(2);
  }
  const decision = authoringDecision(parsed, law, readRecords(law.stateDir));
  if (decision.decision === "deny") {
    process.stderr.write(`stallion authoring-gate: ${decision.reason}\n`);
    process.exit(2);
  }
  if (decision.hint) process.stderr.write(`stallion authoring-gate: ${decision.hint}\n`);
  process.exit(0);
}

main().catch((e) => {
  const where = located ? `node ${join(located.root, located.harnessDir, "task-coverage.mjs")} --self-test` : "node tools/task-coverage.mjs --self-test (in the repo root)";
  const plugin = `node ${fileURLToPath(new URL("../lib/gate-law.mjs", import.meta.url))} --self-test`;
  process.stderr.write(`stallion authoring-gate: the gate crashed judging the edit (${e?.message ?? e}) — a gate that cannot judge refuses.\n  rule: a gate that cannot read the law must not bless the edit — a crash blocks, it never passes\n  fix: the crash reason (in parentheses above) names the defect; ${where} surfaces a broken law, ${plugin} a broken plugin module — repair it, then retry the edit\n`);
  process.exit(2);
});
