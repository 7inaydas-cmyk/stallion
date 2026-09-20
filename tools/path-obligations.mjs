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
 *
 * Usage:  node tools/path-obligations.mjs [--staged | <path>...]
 */
import { execFileSync } from "node:child_process";
import { explain, matches } from "./pathspec.mjs";
import { pathToFileURL } from "node:url";

/** Each rule: which paths arm it, and the obligation that follows — traceable to the incident. */
const RULES = [
  {
    spec: (p) => p.startsWith(".githooks/") || p.startsWith(".github/workflows/") || p.startsWith("docs/gates/"),
    obligation:
      "PROTECTED-TIER FENCE SURFACE — you touched the fence's own law. This is protected blast radius: open a protected task with a recorded DECISIONS.md approval BEFORE declaring the scope (the tier law refuses the self-serve amendment; it was blind to docs/gates until the halves reunified, 2026-09-20).",
  },
  {
    spec: (p) => p.startsWith("tasks/") && p.endsWith(".json"),
    obligation:
      "APPEND-ONLY CHAIN — task records are event logs; the tool appends, hands never do. Post-cutover records are hash-chained and a broken chain refuses at every gate. The git history of the record file IS the tamper evidence — edit events and the diff is the confession.",
  },
  {
    spec: (p) => p === "tools/task-state.mjs" || p === "tools/task-coverage.mjs",
    obligation:
      "ONE LAW, TWO TRANSPORTS — the commit-msg gate and the push fence share the citation/scope seams by import. A change to either file must hold both transports in agreement; a drifted copy of the law in one transport is an adversarial finding that has SHIPPED here before. Run both self-tests; add the case to the seam that owns the law.",
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
    spec: (p) => p === "package.json",
    obligation:
      "BATTERY COMPLETENESS — every tool's --self-test dispatch must appear in the selftest chain in the spelling the tool actually answers to; a dispatch spelling the battery cannot invoke passes vacuously (the dispatch-spelling finding). Adding a tools/*.mjs without wiring its self-test ships an unproven tool.",
  },
  {
    spec: (p) => p.startsWith("tools/") && p.endsWith(".mjs"),
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
    specs: [".githooks/**", ".github/workflows/**", "tools/task-coverage.mjs"],
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
    specs: ["tools/vendor-drift.mjs", "tools/harness/**"],
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
 * graduated with the engine).
 */
function gitLines(args) {
  try {
    const out = execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, lines: out.split("\n").filter(Boolean) };
  } catch (error) {
    const first = String(error?.stderr ?? error?.message ?? error).split("\n").find((l) => l.trim() !== "");
    return { ok: false, lines: [], why: first ?? "git failed with no message" };
  }
}

/**
 * The paths this change set touches. `--staged` means the changes about to be committed: under
 * git that is the index; an empty index falls through to the working copy against HEAD (the
 * colocated-jj shape, where `git diff --cached` is always empty and silence once read as
 * "no obligations armed" — the vendor-repo incident this fallthrough cures).
 */
export function changedPaths(argv) {
  const explicit = argv.filter((a) => !a.startsWith("--"));
  if (explicit.length > 0) return { paths: explicit, source: "arguments" };
  if (!argv.includes("--staged")) {
    const wt = gitLines(["diff", "--name-only", "HEAD"]);
    return wt.ok ? { paths: wt.lines, source: "working copy vs HEAD" } : { paths: [], source: null, why: wt.why };
  }
  const staged = gitLines(["diff", "--cached", "--name-only"]);
  if (staged.ok && staged.lines.length > 0) return { paths: staged.lines, source: "git index" };
  const wt = gitLines(["diff", "--name-only", "HEAD"]);
  if (wt.ok) return { paths: wt.lines, source: "working copy vs HEAD (no git index — jj)" };
  return { paths: [], source: null, why: wt.why };
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
  console.log(ok ? `path-obligations self-test: OK (${obligationCount} obligation + ${contextCount} context cases)` : "path-obligations self-test: FAILED");
  return ok;
}

/** The obligation family: positive AND negative — each `false` is a path that must NOT arm. */
function selfTestObligationCases(fail) {
  const cases = [
    [".githooks/pre-push", "PROTECTED-TIER", true],
    ["docs/gates/guard-reach.json", "PROTECTED-TIER", true],
    ["docs/gates/reader-existence.json", "PROTECTED-TIER", true],
    ["docs/TASK-LIFECYCLE.md", "PROTECTED-TIER", false],
    ["tasks/retire-law.json", "APPEND-ONLY", true],
    ["tasks/harness-merge-wave1.calibration.json", "APPEND-ONLY", true],
    ["package.json", "APPEND-ONLY", false],
    ["tools/task-state.mjs", "ONE LAW, TWO TRANSPORTS", true],
    ["tools/task-coverage.mjs", "ONE LAW, TWO TRANSPORTS", true],
    ["tools/pathspec.mjs", "ONE LAW, TWO TRANSPORTS", false],
    ["docs/gates/complexity-baseline.json", "CEILING", true],
    ["package.json", "BATTERY COMPLETENESS", true],
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

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry && process.argv.includes("--self-test")) {
  process.exit(selfTest() ? 0 : 1);
}

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
