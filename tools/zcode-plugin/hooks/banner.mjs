#!/usr/bin/env node
/**
 * The banner (SessionStart + UserPromptSubmit): re-inject the live governed state every turn,
 * including after compaction — the cure for instruction decay is transport, not a longer
 * prompt. Fail-OPEN by design: the banner is advisory context, and a broken banner must never
 * brick a session (the authoring gate is the law; this is the voice).
 */
import { findHarnessRoot, loadLaw } from "../lib/law-source.mjs";
import { bannerContext, readRecords } from "../lib/gate-law.mjs";

async function main() {
  try {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    let cwd = process.cwd();
    try {
      const payload = JSON.parse(raw);
      if (typeof payload.cwd === "string" && payload.cwd.length > 0) cwd = payload.cwd;
    } catch {
      // an unreadable banner payload degrades to the process cwd — advisory, never fatal
    }
    const layout = findHarnessRoot(cwd);
    if (!layout) return; // not a harness repo: stay silent
    const law = await loadLaw(layout);
    if (!law.ok) return;
    const text = bannerContext(law, readRecords(law.stateDir));
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } }));
  } catch {
    // fail open: no output, exit 0
  }
}

main();
