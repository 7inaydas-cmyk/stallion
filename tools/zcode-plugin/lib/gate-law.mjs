/**
 * Gate law — the pure decision core of the enforcement plugin.
 *
 * The problem it exists for: agents stop invoking the lifecycle after a handful of turns —
 * prompts lose influence under context pressure (instruction decay), and an advisory AGENTS.md
 * cannot hold. The fix class is transport, not prose: a PreToolUse hook that DENIES the edit
 * itself, within one action of the mistake, using the repo's own vendored law so the gate can
 * never drift from the staged gate and the push fence that re-judge the same file later.
 *
 * The contract (mirrors the fence's own words): a CODE edit is allowed only when an IN-FLIGHT
 * task (executing / verified / adversarial — done does not authorize new code) whose DECLARED
 * scope covers the file exists in the repo's task records. Everything else refuses with the
 * rule, the evidence, and an exact fix command. Refusal is the feature; allow is the exception
 * the lifecycle grants.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The phases that authorize code — DERIVED from whatever taxonomy the edited repo's own
 * task-state declares (never re-typed here): the window runs from "executing" up to
 * (excluding) "done". The anchors are law stated once; the set is a slice, so a repo that
 * adds a phase gets it honored by this gate without this file changing.
 */
export const authorizingPhases = (PHASES) => new Set(PHASES.slice(PHASES.indexOf("executing"), PHASES.indexOf("done")));

/**
 * Parse a PreToolUse hook payload (the stdin JSON). Returns { ok, toolName, filePath, cwd } or
 * { ok: false, reason }. Edit/Write carry file_path; runtimes that spell it path or filePath
 * are accepted — a gate that cannot name the file it is asked to bless must refuse, not guess.
 */
export function parseEditPayload(payload) {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "hook payload is not an object" };
  const toolName = typeof payload.tool_name === "string" && payload.tool_name.length > 0 ? payload.tool_name : "(unknown tool)";
  const raw = payload.tool_input?.file_path ?? payload.tool_input?.filePath ?? payload.tool_input?.path;
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: `cannot determine the target file of the ${toolName} edit — a gate that cannot name the file refuses` };
  }
  const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : process.cwd();
  return { ok: true, toolName, filePath: raw, cwd };
}

/** Read every parsable task record in the state dir — malformed records authorize nothing. */
export function readRecords(stateDir) {
  const records = [];
  let files = [];
  try {
    files = readdirSync(stateDir).filter((f) => f.endsWith(".json") && !f.includes(".findings."));
  } catch {
    return records;
  }
  for (const f of files) {
    try {
      records.push(JSON.parse(readFileSync(join(stateDir, f), "utf8")));
    } catch {
      // a malformed record cannot authorize anything — it simply is not an active task
    }
  }
  return records;
}

/**
 * The authoring decision, pure over (payload facts, law module, records). The law module is
 * the repo's OWN imported harness (see law-source.mjs) — never a copy. Returns
 * { decision: "allow", hint } or { decision: "deny", reason }.
 */
export function authoringDecision({ filePath, cwd }, law, records) {
  const { isCodePath, recordRefusal, scopeRefusal, citationRefusal } = law.coverage;
  const { derivePhase, scopeOf } = law.state;
  const absolute = isAbsolute(filePath) ? filePath : join(cwd, filePath);
  const relPath = relative(law.root, absolute);
  if (relPath.startsWith("..")) {
    return {
      decision: "deny",
      reason: `the edit targets ${filePath}, outside the harness repo at ${law.root} — the lifecycle governs that repo's code; edit it from a session rooted there`,
    };
  }
  if (!isCodePath(relPath)) return { decision: "allow", hint: `${relPath} is not lifecycle-governed code` };
  const active = records.filter((record) => {
    if (recordRefusal(record) !== null) return false;
    return authorizingPhases(law.state.PHASES).has(derivePhase(record.events ?? []));
  });
  if (active.length === 0) {
    return {
      decision: "deny",
      reason: [
        `REFUSED — the edit touches lifecycle-governed code (${relPath}) but no task is in flight (executing/verified/adversarial).`,
        `  rule: code lands only under a task the machine has authorized, within its declared scope`,
        `  fix: node ${relative(law.root, join(law.root, law.shape === "vendored" ? "tools/harness/task-state.mjs" : "tools/task-state.mjs"))} new <id> --risk-class runtime-code   then advance it to executing, declare scope, and retry the edit`,
      ].join("\n"),
    };
  }
  for (const record of active) {
    const refusal = citationRefusal(record, [relPath], true) ?? scopeRefusal(record, [relPath]);
    if (!refusal) {
      return { decision: "allow", hint: `${relPath} is within task '${record.id}'s declared scope (${derivePhase(record.events ?? [])})` };
    }
  }
  const inFlightIds = active.map((record) => `${record.id} (${derivePhase(record.events ?? [])})`).join(", ");
  return {
    decision: "deny",
    reason: [
      `REFUSED — the edit touches ${relPath}, which is outside every in-flight task's declared scope.`,
      `  rule: a task binds its code commits and edits with declared blast radius, not a bearer intent`,
      `  evidence: in-flight tasks: ${inFlightIds || "(none)"}; their scopes: ${active.map((record) => `${record.id}: ${scopeOf(record).join(", ") || "(none)"}`).join(" | ") || "(none)"}`,
      `  fix: widen the record (append-only, auditable): node ${relative(law.root, join(law.root, law.shape === "vendored" ? "tools/harness/task-state.mjs" : "tools/task-state.mjs"))} scope <id> --add "<the missing glob>"   — or open the task that owns ${relPath}`,
    ].join("\n"),
  };
}

/** The next command the banner prescribes for a task, by phase. Pure. */
function nextCommand(phase, stateTool, id) {
  if (phase === "executing") return `pin the RED check, fix, then: node ${stateTool} advance ${id} verified`;
  if (phase === "verified") return `sweep the change, then: node ${stateTool} advance ${id} adversarial`;
  return `verdict clean, then: node ${stateTool} advance ${id} done`;
}

/**
 * The banner text: one glance of the live governed state, re-injected every turn so the
 * lifecycle survives context pressure. Pure over the law module and records.
 *
 * `facts` (optional) carries the SITREP derivation (see sitrepFacts) — the gap-2 cure: recall
 * surfaces were in-flight-only, so a cold session hand-read a megabyte of control docs to learn
 * what three derived numbers now say. Absent facts leave the banner exactly as it was.
 */
export function bannerContext(law, records, facts = null) {
  const { derivePhase, scopeOf, PHASES } = law.state;
  const active = records.filter((record) => authorizingPhases(PHASES).has(derivePhase(record.events ?? [])));
  const stateTool = relative(law.root, join(law.root, law.shape === "vendored" ? "tools/harness/task-state.mjs" : "tools/task-state.mjs"));
  const lines = ["[stallion] this repo writes code under the task lifecycle — refusals print the rule, the evidence, and the fix; run the fix, never work around it."];
  if (active.length === 0) {
    lines.push(`[stallion] no task in flight — code edits will refuse until one is: node ${stateTool} new <id> --risk-class runtime-code`);
  } else {
    for (const record of active) {
      const phase = derivePhase(record.events ?? []);
      const scope = scopeOf(record).join(", ") || "(none declared)";
      lines.push(`[stallion] task '${record.id}' — ${phase} (scope: ${scope}) — next: ${nextCommand(phase, stateTool, record.id)}`);
    }
  }
  const sitrep = sitrepLine(facts);
  if (sitrep !== "") lines.push(sitrep);
  return lines.join("\n");
}

/** The timestamp of a record's done transition, or null — the newest `to: "done"` event's `at`. */
export function doneAtOf(record) {
  let at = null;
  for (const event of record.events ?? []) {
    if (event?.to === "done" && typeof event.at === "string") at = event.at;
  }
  return at;
}

/** The newer of (current last-done, this record's done transition) — nulls never win. Pure. */
function newerLastDone(current, record, at) {
  if (at === null) return current;
  if (current === null || at > current.at) {
    return { id: record.id, title: typeof record.title === "string" && record.title.length > 0 ? record.title : record.id, at };
  }
  return current;
}

/** Done-count and last-done facts, derived from records. Pure over the law module. */
export function doneFactsOf(law, records) {
  const facts = { doneCount: 0, lastDone: null };
  for (const record of records) {
    if (law.state.derivePhase(record.events ?? []) !== "done") continue;
    facts.doneCount += 1;
    facts.lastDone = newerLastDone(facts.lastDone, record, doneAtOf(record));
  }
  return facts;
}

/**
 * The sitrep facts: how many tasks are done, the most recent one (id, title, date), and how far
 * the tip sits ahead of the remote. Every fact is independently guarded — the banner is advisory
 * and must fail open, and one missing fact must never cost the rest.
 */
export function sitrepFacts(law, records, aheadOf = defaultAheadOf) {
  const facts = { ...doneFactsOf(law, records), ahead: null };
  try {
    facts.ahead = aheadOf(law.root);
  } catch {
    // ahead is optional
  }
  return facts;
}

/** The remote-ahead count, or null where git cannot answer. Pure injectable for the tests. */
function defaultAheadOf(root) {
  const count = (range) => {
    const run = spawnSync("git", ["-C", root, "rev-list", "--count", range], { encoding: "utf8" });
    return run.status === 0 ? Number(run.stdout.trim()) : null;
  };
  const ahead = count("@{upstream}..HEAD");
  return ahead !== null ? ahead : count("origin/main..HEAD");
}

/** Pure rendering: absent facts drop their clause; every fact absent drops the line entirely. */
export function sitrepLine(facts) {
  if (facts === null || typeof facts !== "object") return "";
  const parts = [];
  if (facts.doneCount > 0) {
    parts.push(`${facts.doneCount} done`);
    if (facts.lastDone !== null) {
      parts.push(`last: ${facts.lastDone.id} — ${facts.lastDone.title} (${facts.lastDone.at.slice(0, 10)})`);
    }
  }
  if (typeof facts.ahead === "number" && facts.ahead > 0) parts.push(`tip ${facts.ahead} commit(s) ahead of the remote`);
  return parts.length === 0 ? "" : `[stallion] sitrep: ${parts.join("; ")}`;
}

/** Self-test: the refusals ARE the feature — every law both directions, over a FAKE law module
 *  that implements the same export contract the real harnesses do (the live probes exercise
 *  the real ones). */
/** The sitrep case family, split from selfTest so the ratchet keeps its word on both. */
function sitrepCases(fakeLaw) {
  return [
    ["the sitrep line renders done count, last done, and ahead", sitrepLine({ doneCount: 7, lastDone: { id: "t-x", title: "The frozen contract", at: "2026-09-20T01:02:03Z" }, ahead: 3 }).includes("7 done") && sitrepLine({ doneCount: 7, lastDone: { id: "t-x", title: "T", at: "2026-09-20T01:02:03Z" }, ahead: 3 }).includes("tip 3 commit(s) ahead")],
    ["the sitrep line drops absent clauses and vanishes when every fact is absent", sitrepLine({ doneCount: 0, lastDone: null, ahead: 0 }) === "" && sitrepLine(null) === ""],
    ["the banner with facts gains the sitrep line; without facts it is unchanged", bannerContext(fakeLaw, [], { doneCount: 2, lastDone: { id: "t-d", title: "T", at: "2026-09-20T00:00:00Z" }, ahead: 1 }).includes("[stallion] sitrep:") && !bannerContext(fakeLaw, []).includes("sitrep")],
    ["doneAtOf takes the newest done transition", doneAtOf({ events: [{ to: "planned", at: "2026-09-01T00:00:00Z" }, { to: "done", at: "2026-09-02T00:00:00Z" }, { to: "done", at: "2026-09-03T00:00:00Z" }] }) === "2026-09-03T00:00:00Z" && doneAtOf({ events: [] }) === null],
    ["sitrepFacts derives done facts from records and ahead from the injected reader", (() => {
      const done = { id: "t-d1", title: "T", events: [{ to: "done", at: "2026-09-19T00:00:00Z" }] };
      const facts = sitrepFacts(fakeLaw, [done, { id: "t-e", events: [{ to: "executing" }] }], () => 4);
      return facts.doneCount === 1 && facts.lastDone.id === "t-d1" && facts.ahead === 4;
    })()],
    ["sitrepFacts fails open on a throwing ahead reader", sitrepFacts(fakeLaw, [], () => { throw new Error("no git"); }).doneCount === 0],
  ];
}

export function selfTest() {
  const failures = [];
  const fail = (m) => failures.push(m);
  const fakeLaw = {
    root: "/repo",
    shape: "stallion",
    coverage: {
      isCodePath: (p) => p.startsWith("tools/") && p.endsWith(".mjs"),
      recordRefusal: (r) => (r.schema !== "stallion/task-state@1" ? "bad schema" : null),
      scopeRefusal: (r, files) => (r.scope ?? []).some((glob) => files.every((f) => f.startsWith(glob.replace("/**", "/")))) ? null : { reason: "outside scope" },
      citationRefusal: (r, files, isNew) => (isNew && r.done ? { reason: "done task" } : null),
    },
    state: {
      PHASES: ["intake", "planned", "executing", "verified", "adversarial", "done"],
      derivePhase: (events) => events.at(-1)?.to ?? "intake",
      scopeOf: (r) => r.scope ?? [],
    },
  };
  const task = (phase, scope, done = false) => ({ schema: "stallion/task-state@1", id: `t-${phase}`, events: [{ to: phase }], scope, done });
  const cases = [
    ["a non-code path is allowed without any task", authoringDecision({ filePath: "/repo/README.md", cwd: "/repo" }, fakeLaw, []).decision === "allow"],
    ["a code path with no in-flight task is DENIED with rule and fix", (() => { const d = authoringDecision({ filePath: "/repo/tools/x.mjs", cwd: "/repo" }, fakeLaw, []); return d.decision === "deny" && d.reason.includes("fix:"); })()],
    ["a code path inside an executing task's scope is allowed", authoringDecision({ filePath: "/repo/tools/x.mjs", cwd: "/repo" }, fakeLaw, [task("executing", ["tools/**"])]).decision === "allow"],
    ["a code path outside every in-flight scope is denied and names the evidence", (() => { const d = authoringDecision({ filePath: "/repo/tools/x.mjs", cwd: "/repo" }, fakeLaw, [task("executing", ["apps/**"])]); return d.decision === "deny" && d.reason.includes("apps/**"); })()],
    ["a planning task does not authorize code", authoringDecision({ filePath: "/repo/tools/x.mjs", cwd: "/repo" }, fakeLaw, [task("planned", ["tools/**"])]).decision === "deny"],
    ["a done task does not authorize code (citationRefusal's done-law is consulted)", authoringDecision({ filePath: "/repo/tools/x.mjs", cwd: "/repo" }, fakeLaw, [task("executing", ["tools/**"], true)]).decision === "deny"],
    ["a record the fence itself would refuse does not authorize (recordRefusal consulted)", (() => { const forged = { schema: "nope", events: [{ to: "executing" }] }; return authoringDecision({ filePath: "/repo/tools/x.mjs", cwd: "/repo" }, fakeLaw, [forged]).decision === "deny"; })()],
    ["an edit outside the harness repo is denied, not guessed about", authoringDecision({ filePath: "/elsewhere/x.mjs", cwd: "/repo" }, fakeLaw, [task("executing", ["tools/**"])]).decision === "deny"],
    ["a relative file_path resolves against the payload cwd", authoringDecision({ filePath: "tools/x.mjs", cwd: "/repo" }, fakeLaw, [task("executing", ["tools/**"])]).decision === "allow"],
    ["a payload without a file path refuses (fail closed, not guess)", parseEditPayload({ tool_name: "Edit", tool_input: {} }).ok === false],
    ["the frozen law pins still resolve — a harness rename must fail the battery, not a live session", (() => {
      // Layout-aware (f5): probe every base × shape the plugin supports and SKIP where no harness
      // tree is present, so a copied-plugin install never sees a false red. Anti-vacuous (f10):
      // existsSync takes PATHS, not file:// URL strings (a URL string is a literal relative
      // pathname and never matches — the repair before this one silently checked nothing), and
      // when the plugin DOES sit in a repo, the probe must actually find a tree: the skip note in
      // an in-repo run is a vacuous pass and fails the case.
      const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
      const inRepo = ["tools", "tools/harness"].some((shape) => existsSync(join(pluginRoot, shape, "task-coverage.mjs")));
      const bases = [pluginRoot, process.cwd()].map((b) => JSON.stringify(b));
      const code = `const { existsSync } = await import("node:fs"); const { pathToFileURL: p } = await import("node:url");
const bases = [${bases.join(", ")}];
let checked = 0;
for (const base of bases) for (const shape of ["tools", "tools/harness"]) {
  const cov = base + "/" + shape + "/task-coverage.mjs";
  if (!existsSync(cov)) continue;
  checked++;
  const c = await import(p(cov).href);
  for (const n of ["isCodePath", "recordRefusal", "scopeRefusal", "citationRefusal"]) {
    if (typeof c[n] !== "function") { console.error("missing law export: " + n); process.exit(1); }
  }
}
if (checked === 0) console.error("(no harness tree found from the plugin location or cwd — pins unchecked here)");`;
      const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
      if (run.status !== 0) return false;
      return !inRepo || !run.stderr.includes("pins unchecked here");
    })()],
    ["file_path, filePath, and path spellings are all read", parseEditPayload({ tool_input: { file_path: "a" } }).ok && parseEditPayload({ tool_input: { filePath: "a" } }).ok && parseEditPayload({ tool_input: { path: "a" } }).ok],
    ["a non-object payload refuses", parseEditPayload(null).ok === false],
    ["the banner names the in-flight task, its phase, and the next command", (() => { const b = bannerContext(fakeLaw, [task("executing", ["tools/**"])]); return b.includes("t-executing") && b.includes("advance") && b.includes("tools/**"); })()],
    ["the banner with no tasks names the new-task command", bannerContext(fakeLaw, []).includes("new <id>")],
    ["the banner's first line states the law", bannerContext(fakeLaw, []).startsWith("[stallion] this repo writes code under the task lifecycle")],
    ["the authorizing window follows the repo's own PHASES (derive, don't declare)", (() => {
      const mutated = { ...fakeLaw, state: { ...fakeLaw.state, PHASES: [...fakeLaw.state.PHASES.slice(0, -1), "shipping", "done"] } };
      const rec = { schema: "stallion/task-state@1", id: "t-ship", events: [{ to: "shipping" }], scope: ["tools/**"] };
      return authoringDecision({ filePath: "/repo/tools/x.mjs", cwd: "/repo" }, mutated, [rec]).decision === "allow";
    })()],
    ["a phase the repo's PHASES does not declare still refuses", (() => {
      const rec = { schema: "stallion/task-state@1", id: "t-ship", events: [{ to: "shipping" }], scope: ["tools/**"] };
      return authoringDecision({ filePath: "/repo/tools/x.mjs", cwd: "/repo" }, fakeLaw, [rec]).decision === "deny";
    })()],
  ];
  const allCases = [...cases, ...sitrepCases(fakeLaw)];
  for (const [name, passes] of allCases) if (!passes) fail(`zcode-plugin gate-law: ${name}`);
  console.log(failures.length === 0 ? `zcode-plugin gate-law self-test: OK (${allCases.length} cases — count derived)` : `zcode-plugin gate-law self-test: FAILED\n  ${failures.join("\n  ")}`);
  return failures.length === 0;
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isEntry && process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
