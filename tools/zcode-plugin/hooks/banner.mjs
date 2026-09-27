#!/usr/bin/env node
/**
 * The banner (SessionStart + UserPromptSubmit): inject the live governed state at session start
 * and re-inject it every turn — the per-turn injection is what carries it past compaction; the
 * cure for instruction decay is transport, not a longer prompt. The output names the event it
 * answers: a SessionStart reply labelled UserPromptSubmit is rejected by a strict client, and
 * the fail-open banner then vanishes silently (a review finding). Fail-OPEN by design: the
 * banner is advisory context, and a broken banner must never brick a session (the authoring
 * gate is the law; this is the voice).
 */
import { findHarnessRoot, loadLaw } from "../lib/law-source.mjs";
import { bannerContext, readRecords, sitrepFacts } from "../lib/gate-law.mjs";
import { readStdin } from "../lib/io.mjs";

async function main() {
  try {
    const raw = await readStdin();
    let cwd = process.cwd();
    let event = "UserPromptSubmit";
    try {
      const payload = JSON.parse(raw);
      if (typeof payload.cwd === "string" && payload.cwd.length > 0) cwd = payload.cwd;
      if (payload.hook_event_name === "SessionStart") event = "SessionStart"; // only the two wired events are ever echoed
    } catch {
      // an unreadable banner payload degrades to the process cwd — advisory, never fatal
    }
    const layout = findHarnessRoot(cwd);
    if (!layout) return; // not a harness repo: stay silent
    const law = await loadLaw(layout);
    if (!law.ok) return;
    const records = readRecords(law.stateDir);
    const text = bannerContext(law, records, sitrepFacts(law, records));
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
  } catch {
    // fail open: no output, exit 0
  }
}

main();
