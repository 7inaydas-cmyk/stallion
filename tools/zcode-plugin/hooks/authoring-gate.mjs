#!/usr/bin/env node
/**
 * The authoring gate (PreToolUse, matcher Edit|Write|ApplyPatch).
 *
 * Exit-code contract (the hook runner's own): 0 passes, 2 BLOCKS the edit, anything else is an
 * error. The deny text on stderr reaches the model — so it carries the rule, the evidence, and
 * an exact fix command, the same shape every stallion refusal prints. The law is imported from
 * the repo being edited (law-source.mjs); a repo without the harness refuses closed, because a
 * gate that cannot read the law must not bless the edit.
 */
import { findHarnessRoot, loadLaw } from "../lib/law-source.mjs";
import { authoringDecision, parseEditPayload, readRecords } from "../lib/gate-law.mjs";
import { readStdin } from "../lib/io.mjs";

async function main() {
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
    process.stderr.write(`stallion authoring-gate: ${parsed.reason}.\n`);
    process.exit(2);
  }
  const layout = findHarnessRoot(parsed.cwd);
  if (!layout) {
    process.stderr.write(`stallion authoring-gate: no stallion harness found at or above ${parsed.cwd} — there is no lifecycle law to enforce for ${parsed.filePath}.\n  rule: a gate that cannot read the law refuses the edit\n  fix: vendor the harness (tools/task-coverage.mjs, stallion shape) into that repo, or uninstall this plugin there deliberately\n`);
    process.exit(2);
  }
  const law = await loadLaw(layout);
  if (!law.ok) {
    process.stderr.write(`stallion authoring-gate: ${law.reason}.\n  rule: a gate that cannot import the repo's own law refuses the edit\n`);
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

main();
