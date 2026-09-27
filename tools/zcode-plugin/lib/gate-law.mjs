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
import { appendFileSync, cpSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { layoutAt } from "./law-source.mjs";

/**
 * The phases that authorize code — DERIVED from whatever taxonomy the edited repo's own
 * task-state declares (never re-typed here): the window runs from "executing" up to
 * (excluding) "done". The anchors are law stated once; the set is a slice, so a repo that
 * adds a phase gets it honored by this gate without this file changing.
 */
export const authorizingPhases = (PHASES) => new Set(PHASES.slice(PHASES.indexOf("executing"), PHASES.indexOf("done")));

const PAYLOAD_FIX = "if the runner's payload shape changed, update parseEditPayload in tools/zcode-plugin/lib/gate-law.mjs deliberately";
const NOT_AN_OBJECT = [
  "the hook payload is not an object",
  "  rule: a gate that cannot read its input refuses the edit it was asked to bless",
  `  fix: this hook reads the standard PreToolUse stdin payload (an object carrying tool_input); ${PAYLOAD_FIX}`,
].join("\n");

/** The refusal for a payload that names no file: the rule, what the payload DID carry, the fix. */
function unnamedFileReason(toolName, input) {
  const keys = input && typeof input === "object" ? Object.keys(input).join(", ") || "(none)" : "(no tool_input)";
  return [
    `cannot determine the target file of the ${toolName} edit — a gate that cannot name the file refuses`,
    "  rule: a gate that cannot name the file it is asked to bless refuses the edit, never guesses",
    `  evidence: tool_input keys: ${keys}`,
    `  fix: retry the edit naming its file in tool_input.file_path; ${PAYLOAD_FIX}`,
  ].join("\n");
}

/**
 * Parse a PreToolUse hook payload (the stdin JSON). Returns { ok, toolName, filePath, cwd } or
 * { ok: false, reason }. Edit/Write carry file_path; runtimes that spell it path or filePath
 * are accepted — a gate that cannot name the file it is asked to bless must refuse, not guess.
 */
export function parseEditPayload(payload) {
  if (!payload || typeof payload !== "object") return { ok: false, reason: NOT_AN_OBJECT };
  const toolName = typeof payload.tool_name === "string" && payload.tool_name.length > 0 ? payload.tool_name : "(unknown tool)";
  const raw = payload.tool_input?.file_path ?? payload.tool_input?.filePath ?? payload.tool_input?.path;
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: unnamedFileReason(toolName, payload.tool_input) };
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

/** The harness's task-state CLI, repo-relative — from the layout law-source resolved, never
 *  re-derived here from a layout name (three ternaries once each re-typed the layout table). */
const stateToolOf = (law) => join(law.harnessDir, "task-state.mjs");

/**
 * One record's standing: null outside the authorizing window, else { record, id, phase, refusal }
 * where a null refusal means it authorizes. A record the law THROWS on (a hand-edited events
 * shape) authorizes nothing and never crashes the gate — the hook must not fail open on an
 * exit 1, and one junk file must not block every other task either (a review finding).
 */
function standingOf(law, record) {
  try {
    const phase = law.state.derivePhase(record.events ?? []);
    if (!authorizingPhases(law.state.PHASES).has(phase)) return null;
    return { record, id: record.id, phase, refusal: law.coverage.recordRefusal(record) };
  } catch (e) {
    return { record, id: String(record?.id ?? "(no id)"), phase: "unjudgeable", refusal: `the law throws on this record (${e?.message ?? e}) — repair or remove it` };
  }
}

/** Every in-window record's standing, in record order. Pure over the law module. */
const standingsOf = (law, records) => records.map((record) => standingOf(law, record)).filter((s) => s !== null);

/**
 * The new-task fix for relPath. A path on the fence's own surface is protected-tier blast radius:
 * a runtime-code task can never scope over it, so printing that fix walked the agent straight
 * into the tier law's refusal (a review finding). Optional call — a harness predating the tier
 * law has no fenceSurfaceRefusal, and its fix stays runtime-code.
 */
function newTaskFix(law, relPath) {
  const stateTool = stateToolOf(law);
  const tier = law.state.fenceSurfaceRefusal?.({ riskClass: "runtime-code", events: [] }, [relPath]);
  return tier
    ? `node ${stateTool} new <id> --risk-class protected   then: node ${stateTool} approve <id> --decision "<full DECISIONS.md heading>", advance it to executing, declare scope, and retry the edit`
    : `node ${stateTool} new <id> --risk-class runtime-code   then advance it to executing, declare scope, and retry the edit`;
}

/**
 * The no-task refusal. It states the repo's OWN window (derived, never re-typed), names every
 * in-window record the law refused WITH the law's reason — so the gate never claims "nothing in
 * flight" while the banner shows a task — and carries a machine-readable code, so a consumer
 * never reads the verdict out of the prose.
 */
function noActiveTaskDenial(law, relPath, standings) {
  const window = [...authorizingPhases(law.state.PHASES)].join("/");
  const refused = standings.map((s) => `${s.id} (${s.phase}): ${s.refusal}`).join(" | ");
  return {
    decision: "deny",
    code: "no-active-task",
    reason: [
      `REFUSED — the edit touches lifecycle-governed code (${relPath}) but no in-flight task authorizes code (in flight: ${window}).`,
      "  rule: code lands only under a task the machine has authorized, within its declared scope",
      `  evidence: ${refused || `no record is ${window}`}`,
      `  fix: ${newTaskFix(law, relPath)}`,
    ].join("\n"),
  };
}

/**
 * The authoring decision, pure over (payload facts, law module, records). The law module is
 * the repo's OWN imported harness (see law-source.mjs) — never a copy. Returns
 * { decision: "allow", hint } or { decision: "deny", reason, code? }.
 */
export function authoringDecision({ filePath, cwd }, law, records) {
  const { isCodePath, scopeRefusal, citationRefusal } = law.coverage;
  const { scopeOf } = law.state;
  const absolute = isAbsolute(filePath) ? filePath : join(cwd, filePath);
  const relPath = relative(law.root, absolute);
  if (relPath.startsWith("..")) {
    return {
      decision: "deny",
      reason: [
        `REFUSED — the edit targets ${filePath}, outside the harness repo at ${law.root}.`,
        "  rule: this gate judges only the repo whose law it loaded — the lifecycle governs that repo's code from a session rooted there",
        `  fix: start the session in the repo that owns ${filePath} (its own harness judges the edit), then retry`,
      ].join("\n"),
    };
  }
  if (!isCodePath(relPath)) return { decision: "allow", hint: `${relPath} is not lifecycle-governed code` };
  const standings = standingsOf(law, records);
  const active = standings.filter((s) => s.refusal === null);
  if (active.length === 0) return noActiveTaskDenial(law, relPath, standings);
  for (const { record, phase } of active) {
    const refusal = citationRefusal(record, [relPath], true) ?? scopeRefusal(record, [relPath]);
    if (!refusal) {
      return { decision: "allow", hint: `${relPath} is within task '${record.id}'s declared scope (${phase})` };
    }
  }
  const inFlightIds = active.map((s) => `${s.id} (${s.phase})`).join(", ");
  return {
    decision: "deny",
    reason: [
      `REFUSED — the edit touches ${relPath}, which is outside every in-flight task's declared scope.`,
      `  rule: a task binds its code commits and edits with declared blast radius, not a bearer intent`,
      `  evidence: in-flight tasks: ${inFlightIds || "(none)"}; their scopes: ${active.map((s) => `${s.id}: ${scopeOf(s.record).join(", ") || "(none)"}`).join(" | ") || "(none)"}`,
      `  fix: widen the record (append-only, auditable): node ${stateToolOf(law)} scope <id> --add "<the missing glob>"   — or open the task that owns ${relPath}: ${newTaskFix(law, relPath)}`,
    ].join("\n"),
  };
}

/** The next command the banner prescribes: the phase's own obligation, then the advance to the
 *  NEXT phase in the repo's own PHASES — a declared phase is never skipped (the chain was once
 *  re-typed here and sent a task at a new phase straight to a done the machine refuses). Pure. */
function nextCommand(PHASES, phase, stateTool, id) {
  const prep = { executing: "pin the RED check, fix", verified: "sweep the change", adversarial: "verdict clean" }[phase] ?? `meet ${phase}'s obligations`;
  return `${prep}, then: node ${stateTool} advance ${id} ${PHASES[PHASES.indexOf(phase) + 1]}`;
}

/** One banner line per in-window record — a record the law refuses is shown as authorizing
 *  NOTHING, with the law's reason, so the banner and the gate never contradict each other. */
function bannerLine(law, { record, id, phase, refusal }) {
  if (refusal !== null) return `[stallion] task '${id}' — ${phase} — authorizes NO code: ${refusal}`;
  const scope = law.state.scopeOf(record).join(", ") || "(none declared)";
  return `[stallion] task '${id}' — ${phase} (scope: ${scope}) — next: ${nextCommand(law.state.PHASES, phase, stateToolOf(law), id)}`;
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
  const standings = standingsOf(law, records);
  const lines = ["[stallion] this repo writes code under the task lifecycle — refusals print the rule, the evidence, and the fix; run the fix, never work around it."];
  lines.push(...standings.map((s) => bannerLine(law, s)));
  if (!standings.some((s) => s.refusal === null)) {
    lines.push(`[stallion] no task in flight authorizes code — code edits will refuse until one does: node ${stateToolOf(law)} new <id> --risk-class runtime-code`);
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
  const facts = { doneCount: 0, lastDone: null, ahead: null };
  try {
    Object.assign(facts, doneFactsOf(law, records));
  } catch {
    // a record the law cannot read costs the done facts, never the banner (it stays advisory)
  }
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

/** A throwaway directory holding `files` ({ relative path: content }), for driving the hooks as
 *  processes — so their exit-code contract is pinned, not assumed. */
function withTree(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "gate-law-harness-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A harness whose law THROWS. PHASES is empty on purpose: nothing here is taxonomy. */
const withThrowingHarness = (fn) => withTree({
  "tools/task-coverage.mjs": 'const boom = () => { throw new TypeError("events is not iterable"); };\nexport { boom as isCodePath, boom as recordRefusal, boom as scopeRefusal, boom as citationRefusal };\n',
  "tools/task-state.mjs": 'export const PHASES = [];\nexport const derivePhase = () => "intake";\nexport const scopeOf = () => [];\n',
}, fn);

/** A well-formed harness with no task records: tools/ is code, and nothing authorizes it. */
const withQuietHarness = (fn) => withTree({
  "tools/task-coverage.mjs": 'const none = () => null;\nexport const isCodePath = (p) => p.startsWith("tools/");\nexport { none as recordRefusal, none as scopeRefusal, none as citationRefusal };\n',
  "tools/task-state.mjs": 'export const PHASES = ["intake", "planned", "executing", "verified", "adversarial", "done"];\nexport const derivePhase = () => "intake";\nexport const scopeOf = () => [];\n',
}, fn);

/** Run one of the plugin's hooks as the runner does: the payload on stdin (an object is sent as
 *  its JSON, a string as-is), the verdict in the exit. `hooksDir` runs a copied plugin's hooks. */
function runHook(name, payload, hooksDir = fileURLToPath(new URL("../hooks/", import.meta.url))) {
  return spawnSync(process.execPath, [join(hooksDir, name)], { input: typeof payload === "string" ? payload : JSON.stringify(payload), encoding: "utf8" });
}

/** An Edit payload for `file` under `dir`, as the runner sends it. */
const editIn = (dir, file) => ({ tool_name: "Edit", cwd: dir, tool_input: { file_path: join(dir, file) } });

/**
 * The authoring hook's exit-code contract, one case per path that blocks: 2 BLOCKS, while 1 is a
 * non-blocking error the runner lets through — so each refusal path is driven as a process (only
 * the crash path once was, and flipping any other exit(2) left the battery green: a review finding).
 */
function hookExitCases() {
  const refuses = (run, text) => run.status === 2 && run.stderr.includes(text);
  return [
    ["the authoring hook refuses (exit 2) a payload that is not JSON", refuses(runHook("authoring-gate.mjs", "{"), "not JSON")],
    ["the authoring hook refuses (exit 2) a payload that names no file", refuses(runHook("authoring-gate.mjs", { tool_name: "Edit", tool_input: {} }), "fix:")],
    ["the authoring hook refuses (exit 2) where no harness is found", withTree({}, (dir) => refuses(runHook("authoring-gate.mjs", editIn(dir, "tools/x.mjs")), "no stallion harness found"))],
    ["the authoring hook refuses (exit 2) a harness missing the law's exports", withTree({ "tools/task-coverage.mjs": "export const x = 1;\n", "tools/task-state.mjs": "export const y = 1;\n" }, (dir) => refuses(runHook("authoring-gate.mjs", editIn(dir, "tools/x.mjs")), "does not export"))],
    ["the authoring hook's ordinary deny exits 2 with the fix, and a non-code edit exits 0", withQuietHarness((dir) => refuses(runHook("authoring-gate.mjs", editIn(dir, "tools/x.mjs")), "fix:") && runHook("authoring-gate.mjs", editIn(dir, "README.md")).status === 0)],
    ["the authoring hook fails CLOSED (exit 2) when one of its own modules cannot load", withTree({}, (dir) => {
      cpSync(fileURLToPath(new URL("../", import.meta.url)), dir, { recursive: true });
      appendFileSync(join(dir, "lib/gate-law.mjs"), "\nexport const broken = ;\n");
      return refuses(runHook("authoring-gate.mjs", editIn(dir, "tools/x.mjs"), join(dir, "hooks")), "rule:");
    })],
  ];
}

/** The hook's event name as the banner answered it, or null when it printed nothing parseable. */
function bannerEvent(payload) {
  try {
    return JSON.parse(runHook("banner.mjs", payload).stdout).hookSpecificOutput.hookEventName;
  } catch {
    return null;
  }
}

/** The fail-closed and evidence case family: a law that throws, a record the law refuses, a
 *  path the tier law reserves, and the hooks' own contracts over a throwing harness. */
function failClosedCases(fakeLaw, task) {
  const code = { filePath: "/repo/tools/x.mjs", cwd: "/repo" };
  const refused = { schema: "nope", id: "t-docs", events: [{ to: "executing" }], scope: ["tools/**"] };
  const fenceLaw = {
    ...fakeLaw,
    coverage: { ...fakeLaw.coverage, isCodePath: (p) => p.startsWith(".githooks/") || fakeLaw.coverage.isCodePath(p) },
    state: { ...fakeLaw.state, fenceSurfaceRefusal: (r, patterns) => (patterns.some((p) => p.startsWith(".githooks/")) ? { reason: "fence surface" } : null) },
  };
  return [
    ["a record the law throws on authorizes nothing and never crashes the gate", (() => {
      const bomb = { ...task("executing", ["tools/**"]), id: "t-bomb", bomb: true };
      const law = { ...fakeLaw, coverage: { ...fakeLaw.coverage, recordRefusal: (r) => (r.bomb ? r.events.x.y : fakeLaw.coverage.recordRefusal(r)) } };
      try {
        const alone = authoringDecision(code, law, [bomb]);
        const beside = authoringDecision(code, law, [bomb, task("executing", ["tools/**"])]);
        return alone.decision === "deny" && alone.reason.includes("t-bomb") && beside.decision === "allow";
      } catch {
        return false;
      }
    })()],
    ["the authoring hook fails CLOSED (exit 2, with the rule) when the law itself throws", withThrowingHarness((dir) => {
      const run = runHook("authoring-gate.mjs", { tool_name: "Edit", cwd: dir, tool_input: { file_path: join(dir, "tools/x.mjs") } });
      return run.status === 2 && run.stderr.includes("rule:") && run.stderr.includes("fix:");
    })],
    ["the banner answers the hook event it was fired for (SessionStart names SessionStart)", withThrowingHarness((dir) => bannerEvent({ hook_event_name: "SessionStart", cwd: dir }) === "SessionStart" && bannerEvent({ cwd: dir }) === "UserPromptSubmit")],
    ["the no-task refusal names each in-window record the law refused, with the law's reason", (() => {
      const d = authoringDecision(code, fakeLaw, [refused]);
      return d.decision === "deny" && d.reason.includes("evidence:") && d.reason.includes("t-docs") && d.reason.includes("bad schema");
    })()],
    ["the banner never lists a law-refused record as authorizing", (() => {
      const b = bannerContext(fakeLaw, [refused]);
      return b.includes("t-docs") && b.includes("authorizes NO code") && !b.includes("pin the RED check");
    })()],
    ["a fence-surface path's fix opens a protected task, not a runtime-code dead end", (() => {
      const d = authoringDecision({ filePath: "/repo/.githooks/pre-push", cwd: "/repo" }, fenceLaw, []);
      return d.decision === "deny" && d.reason.includes("--risk-class protected") && !d.reason.includes("--risk-class runtime-code");
    })()],
    ["an ordinary code path's fix stays the runtime-code task", authoringDecision(code, fenceLaw, []).reason.includes("--risk-class runtime-code")],
    ["readRecords reads task records only — findings registers and malformed files are not tasks", (() => {
      const dir = mkdtempSync(join(tmpdir(), "gate-law-records-"));
      try {
        writeFileSync(join(dir, "t.json"), JSON.stringify({ id: "t" }));
        writeFileSync(join(dir, "t.findings.json"), JSON.stringify({ id: "register" }));
        writeFileSync(join(dir, "torn.json"), "{");
        writeFileSync(join(dir, "notes.md"), "{}");
        const ids = readRecords(dir).map((r) => r.id);
        return ids.length === 1 && ids[0] === "t";
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })()],
    ["a payload without a file path refuses with the rule, the evidence, and a fix", (() => {
      const r = parseEditPayload({ tool_name: "Edit", tool_input: { content: "x" } }).reason;
      return ["rule:", "evidence:", "fix:"].every((k) => r.includes(k));
    })()],
    ["an edit outside the harness repo refuses with the rule and a fix", (() => {
      const d = authoringDecision({ filePath: "/elsewhere/x.mjs", cwd: "/repo" }, fakeLaw, []);
      return d.decision === "deny" && d.reason.includes("rule:") && d.reason.includes("fix:");
    })()],
  ];
}

/**
 * The tier law through the REAL harness beside the plugin. newTaskFix calls fenceSurfaceRefusal
 * optionally (a harness predating the tier law lacks it), so a rename in task-state fell back to
 * the runtime-code dead end with every fake-law case green (a review finding). A copied plugin
 * has no tree beside it: nothing to pin there, the same skip the frozen-law pins take.
 */
function realTierPin() {
  const layout = layoutAt(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));
  if (layout === null) return true;
  const code = `const { loadLaw } = await import(${JSON.stringify(new URL("./law-source.mjs", import.meta.url).href)});
const { authoringDecision } = await import(${JSON.stringify(import.meta.url)});
const law = await loadLaw(${JSON.stringify(layout)});
const d = law.ok ? authoringDecision({ filePath: ${JSON.stringify(join(layout.root, ".githooks/pre-push"))}, cwd: law.root }, law, []) : null;
process.exit(d?.reason?.includes("--risk-class protected") ? 0 : 1);`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" }).status === 0;
}

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
    ["sitrepFacts survives a record the law cannot read — a junk record costs the done facts, never the banner", (() => {
      try {
        return sitrepFacts(fakeLaw, [null], () => 2).ahead === 2 && bannerContext(fakeLaw, [null], sitrepFacts(fakeLaw, [null], () => 2)).includes("tip 2 commit(s) ahead");
      } catch {
        return false;
      }
    })()],
  ];
}

/** Self-test: the refusals ARE the feature — every law both directions, over a FAKE law module
 *  that implements the same export contract the real harnesses do (the live probes exercise
 *  the real ones). */
export function selfTest() {
  const failures = [];
  const fail = (m) => failures.push(m);
  const fakeLaw = {
    root: "/repo",
    harnessDir: "tools",
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
  const shippingLaw = { ...fakeLaw, state: { ...fakeLaw.state, PHASES: [...fakeLaw.state.PHASES.slice(0, -1), "shipping", "done"] } };
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
      // Layout-aware (f5): probe every base through law-source's OWN layout table and loader — the
      // very resolution the hooks run, so neither the layout dirs nor the export lists are
      // re-typed here — and SKIP where no harness tree is present, so a copied-plugin install
      // never sees a false red. Anti-vacuous (f10): when the plugin DOES sit in a repo, the probe
      // must actually find a tree: the skip note in an in-repo run is a vacuous pass and fails.
      const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
      const inRepo = layoutAt(pluginRoot) !== null;
      const lawSource = JSON.stringify(new URL("./law-source.mjs", import.meta.url).href);
      const bases = [pluginRoot, process.cwd()].map((b) => JSON.stringify(b));
      const code = `const { layoutAt, loadLaw } = await import(${lawSource});
let checked = 0;
for (const base of [${bases.join(", ")}]) {
  const layout = layoutAt(base);
  if (layout === null) continue;
  checked++;
  const law = await loadLaw(layout);
  if (!law.ok) { console.error(law.reason); process.exit(1); }
}
if (checked === 0) console.error("(no harness tree found from the plugin location or cwd — pins unchecked here)");`;
      const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
      if (run.status !== 0) return false;
      return !inRepo || !run.stderr.includes("pins unchecked here");
    })()],
    ["the real law's tier export still reaches the gate — a fence-surface path's fix opens a protected task", realTierPin()],
    ["file_path, filePath, and path spellings are all read", parseEditPayload({ tool_input: { file_path: "a" } }).ok && parseEditPayload({ tool_input: { filePath: "a" } }).ok && parseEditPayload({ tool_input: { path: "a" } }).ok],
    ["a non-object payload refuses", parseEditPayload(null).ok === false],
    ["the banner names the in-flight task, its phase, and the next command", (() => { const b = bannerContext(fakeLaw, [task("executing", ["tools/**"])]); return b.includes("t-executing") && b.includes("advance") && b.includes("tools/**"); })()],
    ["the banner with no tasks names the new-task command", bannerContext(fakeLaw, []).includes("new <id>")],
    ["the banner's first line states the law", bannerContext(fakeLaw, []).startsWith("[stallion] this repo writes code under the task lifecycle")],
    ["the authorizing window follows the repo's own PHASES (derive, don't declare)", (() => {
      const rec = { schema: "stallion/task-state@1", id: "t-ship", events: [{ to: "shipping" }], scope: ["tools/**"] };
      return authoringDecision({ filePath: "/repo/tools/x.mjs", cwd: "/repo" }, shippingLaw, [rec]).decision === "allow";
    })()],
    ["the banner's next step follows the repo's own PHASES (a declared phase is the next advance, never a skip to done)", bannerContext(shippingLaw, [task("adversarial", ["tools/**"])]).includes("advance t-adversarial shipping")],
    ["the no-task refusal states the repo's own authorizing window", authoringDecision({ filePath: "/repo/tools/x.mjs", cwd: "/repo" }, shippingLaw, []).reason.includes("shipping")],
    ...failClosedCases(fakeLaw, task),
    ...hookExitCases(),
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

// Both sides canonical: Node realpaths the main module unless --preserve-symlinks-main, and
// argv[1] may be a symlink or name no file at all (node -e) — then this module is not the entry.
const isEntry = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isEntry && process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
