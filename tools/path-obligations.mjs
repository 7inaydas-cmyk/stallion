#!/usr/bin/env node
/**
 * PATH-OBLIGATIONS — the harness's own incident list, as an EXECUTABLE path-keyed checklist.
 *
 * The engine is graduated from the vendor repo's PD-17 tool (2026-09-20): prose lessons do not
 * fire — a session reads "one law, two transports", agrees, and then changes one transport. This
 * turns the lessons into obligations keyed by the PATHS touched, printed at commit time. The
 * ENGINE is the shared vendor surface; the RULES and CONTEXT CLASSES are host-local by design —
 * each repo's incidents are its own, and a rule that cites a path this repo does not have arms
 * nothing while looking diligent (the exact failure class the negative self-test cases pin).
 *
 * ADVISORY BY DESIGN: it prints, it never blocks. The obligations it names are judgement calls a
 * human/agent must discharge (or consciously decline); a hook that guesses wrong and blocks a
 * commit teaches people to pass --no-verify, which is the one habit this repo cannot afford.
 * Run it against a change set at commit time (wiring it into pre-commit is documented in
 * docs/WIRING.md) or by hand at wave intake — see WIRING for both invocations.
 *
 * Usage:  node tools/path-obligations.mjs [--staged | <path>...]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explain, matches } from "./pathspec.mjs";
import { fenceSurfaceRefusal } from "./task-state.mjs";
import { fileURLToPath } from "node:url";

/** The tier law's own question asked of one path: would a runtime-code self-serve scope over it
 *  refuse? DERIVED from task-state, never re-typed — the hand-typed roots drifted twice (blind to
 *  docs/gates until 2026-09-20, then to .stallion-base, the adoption base). */
const SELF_SERVE = { riskClass: "runtime-code", events: [] };
const fenceSurface = (p) => fenceSurfaceRefusal(SELF_SERVE, [p]) !== null;

/** The one law's transports: the staged gate, the citation seam, and the authoring gate — its hook
 *  entry, the seam that imports the shared law into it, gate-law, and the agreement matrix. Arming
 *  on gate-law alone left a law-source change (where the authoring gate stops sharing) silent. */
const ONE_LAW_PATHS = new Set([
  "tools/task-state.mjs",
  "tools/task-coverage.mjs",
  "tools/zcode-plugin/lib/gate-law.mjs",
  "tools/zcode-plugin/lib/law-source.mjs",
  "tools/zcode-plugin/lib/agreement-check.mjs",
  "tools/zcode-plugin/hooks/authoring-gate.mjs",
]);
const toolSource = (p) => p.startsWith("tools/") && p.endsWith(".mjs");

/** Each rule: which paths arm it, and the obligation that follows — traceable to the incident. */
const RULES = [
  {
    spec: fenceSurface,
    obligation:
      "PROTECTED-TIER FENCE SURFACE — you touched the fence's own law. This is protected blast radius: open a protected task with a recorded DECISIONS.md approval BEFORE declaring the scope (the tier law refuses the self-serve amendment; it was blind to docs/gates until the halves reunified, 2026-09-20).",
  },
  {
    spec: (p) => p.startsWith("tasks/") && p.endsWith(".json"),
    obligation:
      "APPEND-ONLY CHAIN — task records are event logs; the tool appends, hands never do. Post-cutover records are hash-chained and a broken chain refuses at every gate. The git history of the record file IS the tamper evidence — edit events and the diff is the confession.",
  },
  {
    spec: (p) => ONE_LAW_PATHS.has(p),
    obligation:
      "ONE LAW, THREE TRANSPORTS — the staged gate, the citation seam (commit-msg gate + push fence) and the authoring gate (the plugin's hook, its law-source seam and gate-law) judge one law through seams shared by import. A change to the law or to any transport must hold all three in agreement; a drifted copy of the law in one transport is an adversarial finding that has SHIPPED here before. Run task-state's, task-coverage's and agreement-check's self-tests (the agreement matrix); add the case to the seam that owns the law.",
  },
  {
    spec: (p) => p === "docs/gates/guard-reach.json" || p === "docs/gates/guard-reach-modes.json",
    obligation:
      "PROBE-PROVEN REGISTRATION — a guard entry is law only with a probe that fails NAMING the probe file (a crash is GATE_DEFECT, not reach). A disk->index modes downgrade is a finding: if deliberate, update the ratchet in the same commit.",
  },
  {
    spec: (p) => p === "docs/gates/complexity-baseline.json",
    obligation:
      "CEILING, NOT ALLOWANCE — the baseline is a ratchet. Raising a row without splitting the function in the same commit is a self-serve defang; if a split is genuinely impossible, the justification rides the task's register.",
  },
  {
    // Armed by the tools too: a tool gaining a dispatch is the change that forgets package.json.
    spec: (p) => p === "package.json" || toolSource(p),
    obligation:
      "BATTERY COMPLETENESS — every tool's --self-test dispatch must appear in the selftest chain in the spelling the tool actually answers to; a dispatch spelling the battery cannot invoke passes vacuously (the dispatch-spelling finding). Adding a tools/*.mjs — or a --self-test to one — without wiring it in package.json in the same commit ships an unproven tool (`node tools/task-coverage.mjs --doctor` names the missing member).",
  },
  {
    spec: toolSource,
    obligation:
      "RED→GREEN PIN — a behavior change owes a command pin recorded RED against pre-fix source with --expect assertion evidence (an uncollectable failure red-pins nothing); done re-runs every pin twice. Prefer a seam self-test case over a grep: a structural pin asserts the wiring, never a bare count.",
  },
];

/**
 * CONTEXT SELECTION — the minimum high-signal context for a change set, derived from the paths
 * touched rather than from memory. Same engine as the vendor repo's selector; the classes are
 * this repo's. Advisory: the point is that a session need not hold the whole harness in working
 * memory to know that touching docs/gates/ means the owning gate runs green in the same commit.
 */
const CONTEXT_CLASSES = [
  {
    class: "Task lifecycle state machine",
    specs: ["tools/task-state.mjs", "tools/task-workspace.mjs", "tasks/**"],
    docs: ["docs/TASK-LIFECYCLE.md"],
    gates: ["task-state --self-test", "the fence re-judges record shapes (task-coverage recordRefusal family)"],
    forbidden: ["hand-edit a record's events", "bypass the hooks (--no-verify, commit -n, re-pointing core.hooksPath)"],
  },
  {
    class: "Fence transports",
    specs: [".githooks/**", ".github/workflows/**", ".stallion-base", "tools/task-coverage.mjs"],
    docs: ["docs/WIRING.md"],
    gates: ["commit-msg gate against a fixture message", "push fence against the settled anchor"],
    forbidden: ["--no-verify (the push fence re-judges what slips past)", "weaken one transport's copy of a shared seam"],
  },
  {
    class: "Gate configs / ratchets",
    specs: ["docs/gates/**"],
    docs: ["docs/gates/reader-existence.json's $comment (the baseline law in its own words)"],
    gates: ["the gate that owns the config must run green in the same commit"],
    forbidden: [
      "raise a baseline row without a same-commit split or recorded justification",
      "delete an accepted row to go green — trace the SUPPRESSED line first (the manufactured-staleness finding, 2026-09-20)",
    ],
  },
  {
    class: "Vendor lineage",
    specs: ["tools/vendor-drift.mjs"],
    docs: ["docs/WIRING.md §1"],
    gates: ["host bare mode (the manifest is law)", "--freshness at every wave's intake"],
    forbidden: ["patch a vendored file instead of re-vendoring and regenerating the manifest in the same commit"],
  },
  {
    class: "Adversarial pass machinery",
    specs: ["tools/adversarial-runner.mjs", "docs/ADVERSARIAL-CHECKLIST.md", "adversarial/**"],
    docs: ["docs/ADVERSARIAL-CHECKLIST.md"],
    gates: ["prepared register, clean aggregate, resolve evidence that exists on disk"],
    forbidden: ["manufactured findings (the primary failure mode of LLM reviewers)", "resolve without live evidence paths"],
  },
];

/** The minimum context set for a change set — derived from the paths touched. */
export function selectContext(paths) {
  const hit = CONTEXT_CLASSES.filter((c) => paths.some((p) => c.specs.some((spec) => matches(p, spec))));
  const docs = [...new Set(hit.flatMap((c) => c.docs))];
  const gates = [...new Set(hit.flatMap((c) => c.gates))];
  const forbidden = [...new Set(hit.flatMap((c) => c.forbidden))];
  return { classes: hit.map((c) => c.class), docs, gates, forbidden };
}

/**
 * `stderr: "pipe"` is not tidiness: inherited, git's failure prints its ~200-line diff usage dump
 * and the refusal this module wants you to read scrolls off the top of it (vendor-repo lesson,
 * graduated with the engine). Every read is a -z path list split on NUL: a newline list C-quotes a
 * non-ASCII path ("tasks/\303\274.json"), which arms no obligation glob.
 */
function gitLines(args) {
  try {
    const out = execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, lines: out.split("\0").filter(Boolean) };
  } catch (error) {
    const first = String(error?.stderr ?? error?.message ?? error).split("\n").find((l) => l.trim() !== "");
    return { ok: false, lines: [], why: first ?? "git failed with no message" };
  }
}

/** The working-change-set half: tracked changes plus untracked files — silence about a
 *  brand-new file is the false-empty this tool exists to refuse. --no-renames: rename detection
 *  lists only a rename's NEW path, and an obligation keyed to the old one went silent. */
function workingPaths() {
  const wt = gitLines(["diff", "-z", "--name-only", "--no-renames", "HEAD"]);
  const untracked = gitLines(["ls-files", "-z", "--others", "--exclude-standard"]);
  if (!wt.ok) return { paths: null, why: wt.why };
  const paths = [...new Set([...wt.lines, ...(untracked.ok ? untracked.lines : [])])];
  return { paths, untracked: untracked.ok ? untracked.lines.length : 0 };
}

/**
 * The paths this change set touches. `--staged` means the changes about to be committed: under
 * git that is the index; an empty index falls through to the SAME working change set a bare run
 * reads, untracked included (the colocated-jj shape, where `git diff --cached` is always empty
 * and silence once read as "no obligations armed" — the vendor-repo incident this fallthrough
 * cures; a hand-rolled copy of the fallthrough dropped the untracked half and went silent again).
 */
export function changedPaths(argv) {
  const explicit = argv.filter((a) => !a.startsWith("--"));
  if (explicit.length > 0) return { paths: explicit, source: "arguments" };
  const stagedMode = argv.includes("--staged");
  if (stagedMode) {
    const staged = gitLines(["diff", "-z", "--cached", "--name-only", "--no-renames"]);
    if (staged.ok && staged.lines.length > 0) return { paths: staged.lines, source: "git index" };
  }
  const wt = workingPaths();
  if (wt.paths === null) return { paths: [], source: null, why: wt.why };
  const source = wt.untracked > 0 ? "working copy vs HEAD + untracked" : "working copy vs HEAD";
  return { paths: wt.paths, source: stagedMode ? `${source} (nothing staged)` : source };
}

/**
 * SELF-TEST — negative cases are the point. A rule whose matcher over-arms trains the reader to
 * skim past obligations, which is how the one that mattered gets missed; a rules list that
 * matches nothing passes every negative case and looks healthy. Both directions are asserted.
 */
export function selfTest() {
  let ok = true;
  const fail = (m) => {
    ok = false;
    console.error(m);
  };
  const obligationCount = selfTestObligationCases(fail);
  const contextCount = selfTestContextCases(fail);
  const { result: changeSetCount, leftovers } = inHostHook(() => selfTestChangeSetCases(fail));
  if (leftovers.length > 0) fail(`SELF-TEST FAIL (hook env): the change-set fixture escaped into the host repo a hook names (${leftovers.join(", ")})`);
  console.log(ok ? `path-obligations self-test: OK (${obligationCount} obligation + ${contextCount} context + ${changeSetCount} change-set cases)` : "path-obligations self-test: FAILED");
  return ok;
}

/** The obligation family: positive AND negative — each `false` is a path that must NOT arm. */
function selfTestObligationCases(fail) {
  const cases = [
    [".githooks/pre-push", "PROTECTED-TIER", true],
    [".stallion-base", "PROTECTED-TIER", true],
    [".stallion-base.bak", "PROTECTED-TIER", false],
    ["docs/gates/guard-reach.json", "PROTECTED-TIER", true],
    ["docs/gates/reader-existence.json", "PROTECTED-TIER", true],
    ["docs/TASK-LIFECYCLE.md", "PROTECTED-TIER", false],
    ["tasks/retire-law.json", "APPEND-ONLY", true],
    ["tasks/harness-merge-wave1.calibration.json", "APPEND-ONLY", true],
    ["package.json", "APPEND-ONLY", false],
    ["tools/task-state.mjs", "ONE LAW, THREE TRANSPORTS", true],
    ["tools/task-coverage.mjs", "ONE LAW, THREE TRANSPORTS", true],
    ["tools/zcode-plugin/lib/gate-law.mjs", "ONE LAW, THREE TRANSPORTS", true],
    // The authoring transport is its hook entry, the seam importing the shared law, and the
    // agreement matrix — not gate-law alone (a law-source change is where it stops sharing).
    ["tools/zcode-plugin/lib/law-source.mjs", "ONE LAW, THREE TRANSPORTS", true],
    ["tools/zcode-plugin/hooks/authoring-gate.mjs", "ONE LAW, THREE TRANSPORTS", true],
    ["tools/zcode-plugin/lib/agreement-check.mjs", "ONE LAW, THREE TRANSPORTS", true],
    ["tools/zcode-plugin/lib/io.mjs", "ONE LAW, THREE TRANSPORTS", false],
    ["tools/pathspec.mjs", "ONE LAW, THREE TRANSPORTS", false],
    ["docs/gates/complexity-baseline.json", "CEILING", true],
    ["package.json", "BATTERY COMPLETENESS", true],
    // A tool gaining a --self-test dispatch is where the battery goes incomplete, and package.json
    // is the file such a change forgets (the zz-head-glue-probe range tip failed the doctor).
    ["tools/zz-head-glue-probe.mjs", "BATTERY COMPLETENESS", true],
    ["docs/WIRING.md", "BATTERY COMPLETENESS", false],
    ["tools/vendor-drift.mjs", "RED→GREEN PIN", true],
    ["adversarial/some-lane.md", "RED→GREEN PIN", false],
  ];
  for (const [path, marker, expected] of cases) {
    const armed = explain(path, RULES).some((r) => r.obligation.includes(marker));
    if (armed !== expected) fail(`SELF-TEST FAIL: ${path} vs "${marker}" — expected ${expected} got ${armed}`);
  }
  if (explain("tools/task-state.mjs", RULES).length === 0) {
    fail("SELF-TEST FAIL: no rule armed by a path that must arm at least one");
  }
  return cases.length;
}

/** The context family: selection must be narrow, and unclassified paths select NOTHING. */
function selfTestContextCases(fail) {
  const ctxCases = [
    ["tools/task-state.mjs", "docs/TASK-LIFECYCLE.md", true],
    ["tools/task-state.mjs", "docs/WIRING.md §1", false],
    ["tools/vendor-drift.mjs", "docs/WIRING.md §1", true],
    ["docs/gates/complexity-baseline.json", "the gate that owns the config must run green in the same commit", true],
    [".githooks/pre-push", "docs/WIRING.md", true],
    [".stallion-base", "docs/WIRING.md", true],
    ["tasks/x.json", "docs/TASK-LIFECYCLE.md", true],
  ];
  for (const [path, item, expected] of ctxCases) {
    const ctx = selectContext([path]);
    const got = ctx.docs.includes(item) || ctx.gates.includes(item);
    if (got !== expected) fail(`SELF-TEST FAIL (context): ${path} → ${item} expected ${expected} got ${got}`);
  }
  const none = selectContext(["README.md"]);
  if (none.classes.length !== 0 || none.docs.length !== 0) {
    fail(`SELF-TEST FAIL (context): an unclassified path selected ${none.docs.length} doc(s)`);
  }
  return ctxCases.length;
}

/** The caller's env minus GIT_*, read at call time: inside a hook GIT_DIR / GIT_INDEX_FILE name the
 *  HOST repo, so a fixture that inherits them writes the host's index. Fixtures only — the real
 *  `--staged` must honour GIT_INDEX_FILE (a partial commit's index). */
function fixtureEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
}

/** Runs `family` inside a simulated git hook — GIT_DIR and GIT_INDEX_FILE name a HOST repo (a
 *  linked worktree's hook; `commit -a`), and a global core.hooksPath holds a pre-commit hook —
 *  and returns its result plus whatever it left in that host. Anything left there is a fixture
 *  that wrote the host's refs or index, or re-fired its hook; a crash under the hook's env is
 *  reported the same way, never as a stack trace. */
function inHostHook(family) {
  const host = mkdtempSync(join(tmpdir(), "path-obligations-host-"));
  writeFileSync(join(host, "pre-commit"), `#!/bin/sh\ntouch "${join(host, "hook-fired")}"\n`, { mode: 0o755 });
  writeFileSync(join(host, ".gitconfig"), `[core]\n\thooksPath = ${host}\n`);
  const hookEnv = { HOME: host, GIT_DIR: join(host, "git"), GIT_INDEX_FILE: join(host, "index.lock") };
  const saved = Object.keys(hookEnv).map((k) => [k, process.env[k]]);
  const leftovers = () => ["git", "index.lock", "hook-fired"].filter((f) => existsSync(join(host, f)));
  Object.assign(process.env, hookEnv);
  try {
    const result = family();
    return { result, leftovers: leftovers() };
  } catch (error) {
    return { result: 0, leftovers: [...leftovers(), `a crash: ${`${error.message}`.split("\n")[0]}`] };
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(host, { recursive: true, force: true });
  }
}

/** The change-set family, against a real throwaway repo: `--staged` with nothing staged falls
 *  through to the WHOLE working change set — untracked included — or a brand-new tool owes a pin
 *  while the tool reports nothing armed (the false-empty this module exists to refuse). */
function selfTestChangeSetCases(fail) {
  const dir = mkdtempSync(join(tmpdir(), "path-obligations-"));
  const git = (...args) => execFileSync("git", ["-c", "user.name=selftest", "-c", "user.email=selftest@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: fixtureEnv() });
  const obligations = (...flags) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...flags], { cwd: dir, encoding: "utf8", env: fixtureEnv() });
  try {
    git("init", "-q");
    mkdirSync(join(dir, "tasks"));
    writeFileSync(join(dir, "README.md"), "seed\n");
    writeFileSync(join(dir, "tasks", "old.json"), '{"renamed":"away"}\n');
    git("add", "README.md", "tasks/old.json");
    git("commit", "-q", "-m", "seed");
    mkdirSync(join(dir, "tools"));
    writeFileSync(join(dir, "tools", "new-gate.mjs"), "export {};\n");
    const run = obligations("--staged");
    if (!`${run.stdout}`.includes("armed by: tools/new-gate.mjs")) {
      fail(`SELF-TEST FAIL (change set): --staged with nothing staged is silent about an untracked new file — got: ${`${run.stdout}${run.stderr}`.trim().split("\n")[0]}`);
    }
    return 1 + selfTestPathSpellingCases(dir, git, obligations, fail);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The path-spelling family, one case per git read: a newline list C-quotes a non-ASCII path
 *  ("tasks/\303\274-new.json" arms no glob), and rename detection lists only a rename's NEW path,
 *  so an obligation keyed to the old one went silent. Each path here arms APPEND-ONLY alone. */
function selfTestPathSpellingCases(dir, git, obligations, fail) {
  const cases = [
    ["a staged rename arms its OLD path (diff --cached)", () => git("mv", "tasks/old.json", "docs-renamed.json"), ["--staged"], "tasks/old.json"],
    ["a working-copy rename arms its OLD path (diff HEAD)", () => {}, [], "tasks/old.json"],
    ["an untracked non-ASCII path arms (ls-files --others)", () => {
      git("commit", "-q", "-m", "rename");
      writeFileSync(join(dir, "tasks", "ü-new.json"), "{}\n");
    }, ["--staged"], "tasks/ü-new.json"],
    ["a staged non-ASCII path arms (diff --cached)", () => git("add", "tasks/ü-new.json"), ["--staged"], "tasks/ü-new.json"],
    ["a tracked non-ASCII change arms (diff HEAD)", () => {}, [], "tasks/ü-new.json"],
  ];
  for (const [label, arrange, flags, path] of cases) {
    arrange();
    const run = obligations(...flags);
    if (!`${run.stdout}`.includes(`armed by: ${path}`)) {
      const armed = `${run.stdout}${run.stderr}`.split("\n").filter((l) => l.includes("↳ armed by") || l.includes("failed")).map((l) => l.trim()).join(" | ");
      fail(`SELF-TEST FAIL (path spelling): ${label} — got: ${armed || "nothing armed"}`);
    }
  }
  return cases.length;
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
// The WHOLE CLI is entry-guarded (the pathspec lesson, paid for once already): an importer that
// pulls in selectContext or changedPaths must not have obligations printed at it or its process
// exited from under it (an adversarial pass proved the unguarded tail did exactly that).
if (isEntry && process.argv.includes("--self-test")) {
  process.exit(selfTest() ? 0 : 1);
}
if (isEntry) {
/**
 * SILENCE IS RESERVED FOR VERIFIED-EMPTY (the vendor-repo jj incident, graduated with the
 * engine): if this cannot determine the change set it REFUSES loudly and non-zero, because
 * silence here is indistinguishable from "no obligations armed".
 */
const { paths, source, why } = changedPaths(process.argv.slice(2));
if (source === null) {
  process.stderr.write(
    "\npath-obligations — CANNOT DETERMINE the change set, so it cannot tell you what is armed.\n" +
      `  git failed: ${why}\n` +
      "  This prints rather than exiting silently because silence here is indistinguishable from\n" +
      "  'no obligations armed' — which is exactly how this control once went dark.\n\n",
  );
  process.exit(1);
}
if (paths.length === 0) {
  process.stdout.write(`\npath-obligations — no changed paths (source: ${source}); nothing armed.\n\n`);
  process.exit(0);
}
const hits = new Map();
for (const path of paths) {
  // explain(), not a hand-rolled loop: multi-match is deliberate (one file can arm several
  // obligations), and pathspec is the single dialect every guard here shares.
  for (const rule of explain(path, RULES)) {
    const existing = hits.get(rule.obligation) ?? [];
    existing.push(path);
    hits.set(rule.obligation, existing);
  }
}

const context = selectContext(paths);
if (context.classes.length > 0) {
  process.stdout.write(`\ncontext-select — ${context.classes.length} path class(es) touched (advisory):\n`);
  process.stdout.write(`\n  classes:   ${context.classes.join(" · ")}\n`);
  if (context.docs.length > 0) process.stdout.write(`  read:      ${context.docs.join("\n             ")}\n`);
  if (context.gates.length > 0) process.stdout.write(`  gates:     ${context.gates.join("\n             ")}\n`);
  if (context.forbidden.length > 0) process.stdout.write(`  forbidden: ${context.forbidden.join("\n             ")}\n`);
}

if (hits.size === 0) {
  process.exit(0);
}
process.stdout.write(`\npath-obligations — ${hits.size} obligation(s) armed by this change set (advisory):\n`);
for (const [obligation, triggeredBy] of hits) {
  process.stdout.write(`\n  • ${obligation}\n    ↳ armed by: ${triggeredBy.slice(0, 3).join(", ")}${triggeredBy.length > 3 ? ` (+${triggeredBy.length - 3})` : ""}\n`);
}
process.stdout.write("\n");
process.exit(0);
}
