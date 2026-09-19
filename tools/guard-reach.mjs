#!/usr/bin/env node
/**
 * GUARD-REACH — does each guard actually SEE a new file in the corpus it claims to police?
 *
 * WHY THIS EXISTS (ported from the Antitube harness, 2026-09-20; the incident is the whole
 * argument, so it travels with the port). On 2026-08-28, `remote-string-lint.mjs` was found
 * reporting **"4 remote-command script(s), no local expansion inside a remote string"** and
 * exiting 0 on a repo containing the exact defect it was written for — a comment reading
 * ``# `manifest inspect` ...`` inside a remote command string, the same shape that killed the
 * deploy preflight on 2026-08-18. Its own 15-case self-test passed the whole time.
 *
 * The lint was not wrong. Its corpus was a **hand-maintained four-file list**, and
 * `deploy/migrate-live.sh` — which ships three multi-line command blocks to the live host,
 * including the pg_dump taken before a migration — had never been added to it. §7: *a control
 * that cannot see the file cannot fire.*
 *
 * THE GAP THIS CLOSES is in the SELF-TEST CONVENTION, not in one lint. Every guard here carries a
 * `--self-test` and every one is invoked. But a self-test drives the guard's matching function over
 * synthetic inputs — it proves the guard can RECOGNISE a violation. It says nothing about whether the
 * guard is LOOKING anywhere real. Those are different claims, and only the second one failed.
 *
 * So this runs the other half: plant a file that genuinely violates a guard, in the directory a new
 * file would really live in, and require the guard to FAIL **naming that file**. RULE 10 EXTENDED —
 * *"a gate is verified by watching it FAIL"* — mechanised for the one dimension that broke.
 *
 * ── WHAT AN ADVERSARIAL AUDIT OF THE ORIGINAL FOUND (2026-08-28), and what changed ─────────────────
 *
 * The first version proved "something exited non-zero", which is not the same claim at all. Fifteen
 * findings, each executed; the five that changed the design:
 *
 *  1. ANY non-zero exit counted as "reachable" — so a guard that CRASHED on the probe was certified,
 *     and **the registered script did not even have to exist**: renaming it to a typo still printed
 *     "3 guard(s) proven". Now the script must exist, the output is captured and must NAME the probe,
 *     and a crash is reported as GATE_DEFECT rather than success.
 *  2. NO CLEAN BASELINE — a guard already red for an unrelated reason (a failing self-test, a bad
 *     baseline row, a broken symlink) was certified without the probe contributing anything. Now every
 *     guard runs BEFORE planting and a pre-existing red is INCONCLUSIVE, never "reachable".
 *  3. `walks: disk|index` WAS HAND-MAINTAINED METADATA — the same class of hand-maintained metadata
 *     that caused the failure this whole tool exists for, and it was already wrong: `complexity-gate`
 *     was registered `index` while it actually enumerates `git ls-files --cached --others
 *     --exclude-standard` and sees untracked files. Because we staged anyway, a regression back to
 *     plain `ls-files` — literally the incident cited above — was invisible. **The field is gone.**
 *     Reach is DERIVED: try unstaged first, fall back to staged only if unstaged passes, and report
 *     which mode was needed. An observation, not an assertion.
 *  4. The self-test's fixtures were content-blind, and one case CODIFIED defect 1 by asserting that a
 *     script which always exits 1 is "REACHABLE". Fixtures are content-aware now, and the crashing and
 *     always-failing cases assert GATE_DEFECT and INCONCLUSIVE.
 *  5. Fixed probe paths with no locking meant two concurrent runs deleted each other's probes, and
 *     `finally` does not run on SIGTERM, so an interrupted hook left residue that then made the NEXT
 *     run report a defect that did not exist. Paths are per-pid and signals are handled.
 *
 * ── THE STALLION PORT: the registry became CONFIG ─────────────────────────────────────────────────
 *
 * In the origin harness the guards list was INLINE in this file, so registering a guard meant
 * editing the meta-guard. Here the registry lives at docs/gates/guard-reach.json — append-only in
 * spirit, because stallion is vendored: a host repo adds ITS guards to the config without touching
 * the tool. The loader FAILS CLOSED on a missing, unparseable, or wrongly-shaped registry (a typo'd
 * key the loader would silently ignore is how a real registry goes vacant — the same law
 * gate-coverage's map loader lives under), and refuses unknown keys per entry. The observed reach
 * modes live beside it at docs/gates/guard-reach-modes.json.
 *
 * THE BAR FOR AN ENTRY, stated so it cannot erode: the entry's probe must be an unambiguous
 * violation of THAT guard alone, in the obvious place a new file of its kind would live, checkable
 * TODAY with a green baseline. A guard whose probe result depends on live task state (the staged
 * gate is OPEN by design while a task executes), or that judges ARGUMENTS or commit RANGES rather
 * than a file corpus, is recorded under `notRegistered` with its reason — stated, never faked.
 *
 * Run: node tools/guard-reach.mjs [--self-test]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

// resolve() so ROOT carries NO trailing slash — validateEntry's inside-the-repo test is
// `startsWith(ROOT + sep)`, and a URL-derived path would double the separator and refuse
// every probe. (Proven by the port's own self-test, which is what self-tests are for.)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The guards registry — external config since the stallion port; fail closed on anything but a
 *  well-shaped file. The append-only-in-spirit vendor surface: a host repo adds its guards here. */
const CONFIG_PATH = join(ROOT, "docs/gates/guard-reach.json");
/** OBSERVED reach modes, written by this tool; a disk->index downgrade FAILS (see the ratchet). */
const MODES_PATH = join(ROOT, "docs/gates/guard-reach-modes.json");

/** Replaced in `content` with the real (per-pid) probe path — for probes that must name themselves. */
const PATH_TOKEN = "__PROBE_PATH__";

const OUTCOME = {
  REACHABLE: "REACHABLE",
  UNREACHABLE: "UNREACHABLE",
  INCONCLUSIVE: "INCONCLUSIVE",
  GATE_DEFECT: "GATE_DEFECT",
  PROBE_MISCONFIGURED: "PROBE_MISCONFIGURED",
};

/**
 * Load + validate the registry. Every refusal prints the rule, the evidence, and an exact fix —
 * fail closed: a missing, unparseable, or almost-right registry proves nothing and must not pass.
 * Called by the REAL run only; the self-test never reads live config (a self-test that depends on
 * the config it guards certifies the config by reading it).
 */
function loadRegistry(path) {
  const die = (message) => {
    console.error(`guard-reach: ✖ ${message}`);
    console.error(`  rule: a meta-guard that cannot read its registry proves nothing — this seam fails closed like every other`);
    process.exit(1);
  };
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    die(`the guards registry is missing or unreadable: ${path}
  fix: restore it, or recreate it — shape: {"guards":[{"name","script","args?","probe","content","expect?","why"}],"notRegistered":[{"name","reason"}]}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    die(`the guards registry at ${path} is not valid JSON: ${e.message}
  fix: repair ${path} — the parse error above names the position`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    die(`the guards registry at ${path} must be a JSON object
  fix: {"guards":[...],"notRegistered":[...]}`);
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "$comment" && key !== "guards" && key !== "notRegistered") {
      die(`unknown key '${key}' in ${path} (known: guards, notRegistered, $comment) — a key the loader ignores is how a real registry goes vacant
  fix: remove or rename it in ${path}`);
    }
  }
  if (!Array.isArray(parsed.guards) || parsed.guards.length === 0) {
    die(`${path} registers no guards — an empty registry certifies nothing while printing a clean zero
  fix: add at least one {"name","script","probe","content","why"} entry, or record the guards you deliberately skip under notRegistered`);
  }
  const guards = [];
  const names = new Set();
  const entryKeys = ["name", "script", "args", "probe", "content", "expect", "why"];
  for (const [i, g] of parsed.guards.entries()) {
    const where = `${path} guards[${i}]`;
    if (g === null || typeof g !== "object" || Array.isArray(g)) die(`${where} must be an object`);
    for (const key of Object.keys(g)) {
      if (!entryKeys.includes(key)) die(`${where} carries unknown key '${key}' (known: ${entryKeys.join(", ")})`);
    }
    if (typeof g.name !== "string" || g.name.length === 0) die(`${where} needs a non-empty "name"`);
    if (names.has(g.name)) die(`${where}: duplicate guard name '${g.name}' — results are printed by name; an ambiguous name is drift`);
    names.add(g.name);
    if (typeof g.script !== "string" || g.script.length === 0 || g.script.startsWith("/")) {
      die(`${where} ('${g.name}') needs "script": a repo-relative path like tools/thing.mjs`);
    }
    if (typeof g.probe !== "string" || g.probe.length === 0 || g.probe.startsWith("/") || g.probe.split("/").includes("..")) {
      die(`${where} ('${g.name}') needs "probe": a repo-relative path inside the repository`);
    }
    if (g.args !== undefined && (!Array.isArray(g.args) || g.args.some((a) => typeof a !== "string"))) {
      die(`${where} ('${g.name}') "args" must be an array of strings`);
    }
    if (g.expect !== undefined && (typeof g.expect !== "string" || g.expect.length === 0)) {
      die(`${where} ('${g.name}') "expect" must be a non-empty string — the attribution this entry settles for`);
    }
    if (typeof g.why !== "string" || g.why.length === 0) {
      die(`${where} ('${g.name}') needs a non-empty "why" — the violation the probe plants, in words`);
    }
    // Content: an array of lines (the inline-list style the origin harness wrote) or one string.
    let content;
    if (Array.isArray(g.content)) {
      if (g.content.length === 0 || g.content.some((l) => typeof l !== "string")) die(`${where} ('${g.name}') "content" as an array must be non-empty lines of strings`);
      content = g.content.join("\n");
    } else if (typeof g.content === "string" && g.content.length > 0) {
      content = g.content;
    } else {
      die(`${where} ('${g.name}') needs "content": the probe file body — a string or an array of lines`);
    }
    guards.push({ name: g.name, script: g.script, args: g.args ?? [], probe: g.probe, content, expect: g.expect, why: g.why });
  }
  const notRegistered = [];
  const list = parsed.notRegistered ?? [];
  if (!Array.isArray(list)) die(`"notRegistered" in ${path} must be an array of {"name","reason"} entries`);
  for (const [i, e] of list.entries()) {
    const where = `${path} notRegistered[${i}]`;
    if (e === null || typeof e !== "object" || Array.isArray(e)) die(`${where} must be an object`);
    for (const key of Object.keys(e)) {
      if (key !== "name" && key !== "reason") die(`${where} carries unknown key '${key}' (known: name, reason)`);
    }
    if (typeof e.name !== "string" || e.name.length === 0) die(`${where} needs a non-empty "name"`);
    if (typeof e.reason !== "string" || e.reason.length === 0) {
      die(`${where} needs a "reason" — an absence without a reason reads as an oversight, which is how registries rot`);
    }
    notRegistered.push({ name: e.name, reason: e.reason });
  }
  return { guards, notRegistered };
}

/**
 * A WHOLE-RUN exclusive lock.
 *
 * Per-pid probe paths stop two runs deleting each other's FILES and do nothing about the real
 * contention, which is the guards' CORPORA: every registered guard walks a directory or the whole
 * repo, so a sibling run's probe is inside its corpus by construction. Measured at the origin
 * harness: 7 of 10 two-way concurrent runs failed, each blaming the detector rather than the
 * collision.
 *
 * The lock also sweeps residue from a run that was killed before its `finally` — an interrupted hook
 * used to leave a probe that reddened the NEXT run permanently, with a message that named neither
 * the file nor the cause.
 */
const LOCK = join(tmpdir(), "stallion-guard-reach.lock");

function acquireLock(probeDirs) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(LOCK, `${process.pid}\n`, { flag: "wx" });
      return true;
    } catch {
      // Held — but by a live process, or by a corpse?
      let holder = 0;
      try {
        holder = Number.parseInt(readFileSync(LOCK, "utf8").trim(), 10);
      } catch {
        holder = 0;
      }
      let alive = false;
      try {
        process.kill(holder, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (alive) return false;
      // Stale: the holder is gone. Sweep its residue as well as its lock, because a killed run is
      // exactly the case that leaves probes behind.
      rmSync(LOCK, { force: true });
      sweepResidue(probeDirs);
    }
  }
  return false;
}

/** Remove any `zz-guard-reach-*` probe left by a dead run, anywhere a registered probe can land. */
function sweepResidue(probeDirs) {
  for (const dir of probeDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith("zz-guard-reach-")) rmSync(join(dir, entry), { force: true });
    }
  }
}

/** In-flight probe paths, so a SIGTERM/SIGINT can clean up — `finally` does not run on a signal. */
const inFlight = new Set();

function cleanupInFlight() {
  try {
    rmSync(LOCK, { force: true });
  } catch {
    // Best effort.
  }
  for (const path of inFlight) {
    try {
      rmSync(path, { force: true });
    } catch {
      // Best effort — we are already unwinding.
    }
  }
  inFlight.clear();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cleanupInFlight();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

/**
 * Make a probe path unique to this process, so two concurrent runs cannot delete each other's files.
 *
 * The pid goes on the STEM, before every extension: `x.test.mjs` must stay `*.test.mjs` or
 * test-lint's `/\.(test|spec)\.(ts|tsx|mjs|js|cjs)$/` discovery filter stops matching and the probe
 * silently tests nothing.
 */
function pidPath(rel) {
  const dir = dirname(rel);
  const base = basename(rel);
  const dot = base.indexOf(".");
  const stem = dot === -1 ? base : base.slice(0, dot);
  const rest = dot === -1 ? "" : base.slice(dot);
  const name = `${stem}-${process.pid}${rest}`;
  // A root-level probe (no directory) must not become "./x" — git prints repo-relative paths
  // without the prefix, and "./x" would never match the guard's own output.
  return dir === "." ? name : `${dir}/${name}`;
}

/** Run a guard, capturing BOTH streams. The output is what lets us tell a catch from a crash. */
function runGuard(script, env, args = []) {
  try {
    const stdout = execFileSync("node", [script, ...args], { cwd: ROOT, env, encoding: "utf8", stdio: "pipe" });
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: typeof error.status === "number" ? error.status : 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/**
 * Did the guard CRASH rather than report a finding?
 *
 * A crash also exits non-zero, and reading exit codes alone is what let a guard whose script had been
 * RENAMED still be certified as reachable.
 */
function looksLikeCrash(output) {
  if (/MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/.test(output)) return true;
  // An uncaught throw prints "SomeError: msg" followed by "    at ..." stack frames. (Also catches
  // the missing-export SyntaxError a mid-refactor tree throws — port note: proven live, 2026-09-20.)
  return /^\s{2,}at .+:\d+:\d+\)?$/m.test(output) && /^\w*Error(:| \[)/m.test(output);
}

let counter = 0;

/** Stage `rel` into a COPY of the index; the real index is never written. */
function stagedEnv(rel) {
  const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], { cwd: ROOT, encoding: "utf8" }).trim();
  // Honour an inherited GIT_INDEX_FILE: git sets it for hooks, and a PARTIAL commit points it at a
  // lock file rather than <git-dir>/index. Hard-coding the latter judged a different file set than
  // the one actually being committed.
  const source = process.env.GIT_INDEX_FILE ?? resolve(ROOT, gitDir, "index");
  const dir = join(tmpdir(), `stallion-guard-reach-${process.pid}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  const indexCopy = join(dir, "index");
  try {
    copyFileSync(source, indexCopy);
    const env = { ...process.env, GIT_INDEX_FILE: indexCopy };
    // Staging writes a loose object into the REAL object store (the index itself is untouched). One
    // per distinct probe content, unreferenced, collected by gc. Noted so nobody re-derives it.
    execFileSync("git", ["add", "--force", rel], { cwd: ROOT, env });
    return { env, dir };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Plant, run, and classify. Never throws for a guard-specific problem — the caller checks every
 * entry, so one bad entry must not skip the rest.
 *
 * The order is the whole design:
 *   1. the script must EXIST                  (a rename is a registry defect, not a pass)
 *   2. the probe path must be inside the repo, and free
 *   3. a CLEAN baseline run                   (already-red is INCONCLUSIVE, never "reachable")
 *   4. UNSTAGED, then STAGED                  (reach mode is DERIVED, never declared)
 *   5. the failure must NAME the probe        (a crash is GATE_DEFECT, not success)
 */
function checkReach(guard) {
  const problem = validateEntry(guard);
  if (problem !== null) return problem;

  const args = guard.args ?? [];
  const baseline = runGuard(guard.script, process.env, args);
  if (baseline.code !== 0) {
    return {
      outcome: OUTCOME.INCONCLUSIVE,
      detail: `${guard.name} was ALREADY failing before any probe was planted (exit ${baseline.code}) — fix that first`,
    };
  }

  const rel = pidPath(guard.probe);
  const abs = resolve(ROOT, rel);
  const dirExisted = existsSync(dirname(abs));
  let staged;
  try {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, guard.content.split(PATH_TOKEN).join(rel));
    inFlight.add(abs);

    // UNSTAGED first. A guard that sees the probe here walks the DISK (or `ls-files --others`), and
    // that is worth knowing: staging unconditionally would hide a regression to a tracked-only walk
    // — the ls-files-vs-untracked lesson the origin harness paid for (finding 3 in the header).
    let run = runGuard(guard.script, process.env, args);
    let mode = "disk";
    if (run.code === 0) {
      staged = stagedEnv(rel);
      run = runGuard(guard.script, staged.env, args);
      mode = "index";
    }
    return classify(guard, rel, run, mode);
  } catch (error) {
    return { outcome: OUTCOME.GATE_DEFECT, detail: `guard-reach itself threw while probing: ${error.message}` };
  } finally {
    cleanup(abs, rel, dirExisted, staged);
  }
}

/** Registry-shape problems, which are guard-reach's fault and never the guard's. */
function validateEntry(guard) {
  if (!existsSync(resolve(ROOT, guard.script))) {
    return { outcome: OUTCOME.GATE_DEFECT, detail: `registered script ${guard.script} does not exist — renamed or deleted?` };
  }
  const rel = pidPath(guard.probe);
  const abs = resolve(ROOT, rel);
  if (!abs.startsWith(ROOT + sep)) {
    return { outcome: OUTCOME.PROBE_MISCONFIGURED, detail: `probe path ${rel} resolves outside the repository` };
  }
  if (existsSync(abs)) {
    return { outcome: OUTCOME.PROBE_MISCONFIGURED, detail: `probe path ${rel} already exists — refusing to overwrite it` };
  }
  return null;
}

/**
 * What did the planted run actually prove?
 *
 * The baseline was green, so a non-zero here is caused by the probe — but "caused by" is not "saw
 * it", which is why a crash and an unattributable message are both refused rather than counted.
 */
function classify(guard, rel, run, mode) {
  if (run.code === 0) {
    return { outcome: OUTCOME.UNREACHABLE, detail: `exited 0 with a planted violation at ${rel} — it cannot see ${guard.why}` };
  }
  if (looksLikeCrash(run.output)) {
    return { outcome: OUTCOME.GATE_DEFECT, detail: "CRASHED on the probe rather than reporting it — a crash is not proof of reach" };
  }
  const expect = guard.expect ?? rel;
  if (!run.output.includes(expect)) {
    return {
      outcome: OUTCOME.UNREACHABLE,
      detail: `exited ${run.code} but never named ${expect} — the failure cannot be attributed to the probe`,
    };
  }
  return { outcome: OUTCOME.REACHABLE, mode };
}

/**
 * Remove the probe, the directory we created for it, and the staged index copy.
 *
 * Each step in its own try: a throw in one must not skip the others, and a cleanup error must never
 * mask the real failure it is unwinding from — a `rmSync` ENOTDIR once surfaced instead of the
 * `mkdirSync` that actually failed.
 */
function cleanup(abs, rel, dirExisted, staged) {
  inFlight.delete(abs);
  try {
    rmSync(abs, { force: true });
  } catch (error) {
    console.error(`  ! could not remove probe ${rel}: ${error.message}`);
  }
  if (!dirExisted) {
    try {
      if (existsSync(dirname(abs)) && readdirSync(dirname(abs)).length === 0) rmSync(dirname(abs), { recursive: true });
    } catch {
      // A directory we created but cannot remove is residue, not a failure.
    }
  }
  if (staged !== undefined) {
    try {
      rmSync(staged.dir, { recursive: true, force: true });
    } catch {
      // Temp dir under /tmp; the OS will take it.
    }
  }
}

/**
 * The self-test proves the DETECTOR discriminates — the same distinction this whole tool is about.
 *
 * The fixtures are CONTENT-AWARE on purpose. The previous version used `process.exit(0)` and
 * `process.exit(1)`, neither of which reads anything, and asserted the second was "REACHABLE" — which
 * codified the exact false pass the audit found. A script that sees nothing and always fails must be
 * INCONCLUSIVE, and one that throws must be GATE_DEFECT.
 *
 * The self-test NEVER reads the live registry: it manufactures its own entries, because a self-test
 * that depends on the config it polices can only pass while the config is shaped like the test.
 */
/** Manufacture a collision at the exact per-pid probe path, then confirm the refusal. */
function clobberOutcome(probe, script, marker) {
  const squatted = resolve(ROOT, pidPath(probe));
  mkdirSync(dirname(squatted), { recursive: true });
  writeFileSync(squatted, `# ${marker} squatter\n`);
  try {
    return checkReach({ name: "fixture", script, probe, content: `# ${marker}\n`, why: "the fixture case" }).outcome;
  } finally {
    rmSync(squatted, { force: true });
  }
}

function selfTest() {
  const dir = join(tmpdir(), `stallion-guard-reach-selftest-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const MARKER = "zz-guard-reach-marker";
  // tools/ is where this repo's scripts live — the probe directory a stallion guard would police.
  const probe = "tools/zz-guard-reach-selftest.mjs";

  const fixture = (name, body) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  };

  // Reads the planted file and names it — the only honest "reachable".
  const seeing = fixture(
    "seeing.mjs",
    [
      'import { readdirSync, readFileSync } from "node:fs";',
      'const hit = readdirSync("tools").find((f) => f.startsWith("zz-guard-reach-selftest"));',
      "if (hit === undefined) process.exit(0);",
      'if (!readFileSync(`tools/${hit}`, "utf8").includes(' + JSON.stringify(MARKER) + ")) process.exit(0);",
      "console.log(`violation at tools/${hit}`);",
      "process.exit(1);",
      "",
    ].join("\n"),
  );
  const blind = fixture("blind.mjs", "process.exit(0);\n");
  // Healthy at baseline, CRASHES once the probe appears. This is the F1 scenario that mattered — a
  // guard that always throws is caught earlier, at the baseline, as INCONCLUSIVE. The dangerous one
  // is the guard that looks fine until the probe trips it, because the old version read that crash
  // as proof of reach.
  const crashOnProbe = fixture(
    "crash-on-probe.mjs",
    [
      'import { readdirSync } from "node:fs";',
      'const hit = readdirSync("tools").find((f) => f.startsWith("zz-guard-reach-selftest"));',
      "if (hit === undefined) process.exit(0);",
      'throw new Error("boom");',
      "",
    ].join("\n"),
  );
  const alwaysCrashes = fixture("always-crashes.mjs", 'throw new Error("boom");\n');
  const alwaysFails = fixture("always-fails.mjs", "process.exit(1);\n");

  const entry = (script) => ({ name: "fixture", script, probe, content: `# ${MARKER}\n`, why: "the fixture case" });
  const cases = [
    ["a guard that READS the probe and names it is REACHABLE", checkReach(entry(seeing)).outcome, OUTCOME.REACHABLE],
    ["a guard that always exits 0 is UNREACHABLE", checkReach(entry(blind)).outcome, OUTCOME.UNREACHABLE],
    // The three the old self-test got wrong — and the reason it once certified a renamed script.
    [
      "a guard that CRASHES on the probe is a GATE_DEFECT, not proof of reach",
      checkReach(entry(crashOnProbe)).outcome,
      OUTCOME.GATE_DEFECT,
    ],
    ["a guard that crashes even at baseline is INCONCLUSIVE", checkReach(entry(alwaysCrashes)).outcome, OUTCOME.INCONCLUSIVE],
    ["a guard already red before the probe is INCONCLUSIVE", checkReach(entry(alwaysFails)).outcome, OUTCOME.INCONCLUSIVE],
    [
      "a registered script that does not exist is a GATE_DEFECT",
      checkReach(entry(join(dir, "no-such-guard.mjs"))).outcome,
      OUTCOME.GATE_DEFECT,
    ],
    // Clobber refusal. Per-pid paths make an accidental collision very unlikely, so the case has to
    // MANUFACTURE one — and it must be manufactured at the pid path, not at the template path.
    // Deliberately not pointed at some unrelated real file (the old case used a live deploy script,
    // which meant renaming it would fail the meta-guard for no reason).
    ["an existing path is refused, not overwritten", clobberOutcome(probe, blind, MARKER), OUTCOME.PROBE_MISCONFIGURED],
    ["the probe file is removed after a run", existsSync(resolve(ROOT, pidPath(probe))) ? "LEFT" : "GONE", "GONE"],
    ["probe paths are per-process, so concurrent runs cannot collide", pidPath(probe).includes(String(process.pid)), true],
    // `x.test.mjs` must stay `*.test.mjs` or test-lint's discovery filter silently stops matching.
    ["pidPath preserves a multi-part extension", pidPath("a/b.test.mjs").endsWith(".test.mjs"), true],
    // A root-level probe must stay repo-relative — git prints no "./" prefix, and the attribution
    // check reads the guard's own output (the stallion port's root-probe case).
    ["pidPath keeps a root-level probe repo-relative", pidPath("zz-probe.mjs"), `zz-probe-${process.pid}.mjs`],
  ];

  rmSync(dir, { recursive: true, force: true });

  const failed = cases.filter(([, got, want]) => got !== want);
  for (const [name, got, want] of failed) console.error(`  ✖ ${name}: got ${got}, expected ${want}`);
  if (failed.length > 0) {
    console.error(`guard-reach self-test: ${failed.length} case(s) FAILED`);
    return false;
  }
  console.log(`guard-reach self-test: OK (${cases.length} cases)`);
  return true;
}

/**
 * THE MODE RATCHET — and this is the half that was missing at the origin.
 *
 * Deleting the hand-maintained `walks` field removed a WRONG assertion and replaced it with NO
 * assertion: the derived mode was printed and compared against nothing. So a guard downgraded from
 * walking the DISK to walking only the git INDEX was still certified "proven to reach a newly-added
 * file" — guard-reach plants unstaged, sees a pass, stages, re-runs, and reports REACHABLE. The only
 * trace was the word `index` in a line nothing read.
 *
 * That is not academic: it is the ls-files-vs-untracked lesson from complexity-gate's FIRST
 * violation run — the metadata said `index` while the gate enumerated `--cached --others
 * --exclude-standard`, so the field was wrong in the direction that hid a plain-`ls-files`
 * regression, i.e. literally the 2026-08-12 incident class this tool's header cites.
 *
 * A downgrade disk -> index now FAILS. A widening index -> disk rewrites the row for free, because
 * seeing more is never a regression. The mode stays an OBSERVATION; what is enforced is that the
 * observation never narrows silently.
 */
function main() {
  if (!selfTest()) process.exit(1);

  const { guards, notRegistered } = loadRegistry(CONFIG_PATH);
  const probeDirs = [...new Set(guards.map((g) => dirname(resolve(ROOT, g.probe))))];

  if (!acquireLock(probeDirs)) {
    console.error("guard-reach: another run holds the lock — the guards' corpora cannot be shared. Try again.");
    process.exit(1);
  }

  const results = guards.map((guard) => ({ guard, ...checkReach(guard) }));
  const bad = results.filter((r) => r.outcome !== OUTCOME.REACHABLE);

  let recorded = {};
  try {
    recorded = JSON.parse(readFileSync(MODES_PATH, "utf8")).modes ?? {};
  } catch {
    recorded = {};
  }
  const downgrades = results.filter((r) => r.outcome === OUTCOME.REACHABLE && recorded[r.guard.name] === "disk" && r.mode === "index");
  if (downgrades.length > 0) {
    console.error(`\nguard-reach — ${downgrades.length} guard(s) DOWNGRADED from walking the disk to the index only:\n`);
    for (const r of downgrades) {
      console.error(`  ✖ ${r.guard.name}  disk -> index`);
      console.error("      It can no longer see an UNTRACKED new file. A probe is still found once staged,");
      console.error("      which is why the reach check alone reports success — that is the false pass this catches.");
    }
    console.error(`\n  If the narrowing is deliberate, update ${MODES_PATH} in the same commit.\n`);
    process.exit(1);
  }

  if (bad.length > 0) {
    console.error(`\nguard-reach — ${bad.length} of ${guards.length} guard(s) did not prove reach:\n`);
    for (const r of bad) {
      console.error(`  ✖ ${r.outcome}  ${r.guard.name}  (${r.guard.script})`);
      console.error(`      ${r.detail}`);
    }
    console.error(`
  UNREACHABLE          the guard cannot see a newly-added file in its own corpus. Usually a
                       hand-maintained file list a new path was never added to — exactly how
                       remote-string-lint missed deploy/migrate-live.sh at the origin. Fix the
                       guard's discovery.
  INCONCLUSIVE         the guard was already failing before the probe. Fix that first; nothing about
                       its reach has been tested.
  GATE_DEFECT          the guard crashed, or its registered script is missing. A crash exits non-zero
                       too, which is why exit codes alone prove nothing here.
  PROBE_MISCONFIGURED  guard-reach's own registry entry is wrong, or stale residue is in the way.
                       Nothing is wrong with the guard.
`);
    process.exit(1);
  }

  // Record the observation for the next run — widenings are absorbed silently, downgrades already failed.
  const modes = Object.fromEntries(results.map((r) => [r.guard.name, r.mode]));
  const next = JSON.stringify({ $comment: "OBSERVED reach modes, written by guard-reach.mjs. A disk->index downgrade FAILS; index->disk rewrites freely.", modes }, null, 2);
  try {
    if (!existsSync(MODES_PATH) || readFileSync(MODES_PATH, "utf8") !== `${next}\n`) writeFileSync(MODES_PATH, `${next}\n`);
  } catch {
    // A read-only checkout is not a reason to fail the gate.
  }
  try {
    rmSync(LOCK, { force: true });
  } catch {
    // Best effort.
  }

  console.log(`guard-reach — ${guards.length} guard(s) proven to reach a newly-added file in their corpus.`);
  console.log(`  reach mode OBSERVED, not declared: ${results.map((r) => `${r.guard.name}:${r.mode}`).join(" ")}`);
  if (notRegistered.length > 0) {
    console.log(`  no probeable file corpus or deliberately unregistered: ${notRegistered.map((e) => e.name).join(", ")}`);
  }
}

/**
 * CLI, guarded by an entry-module check (tools/pathspec.mjs's law): a bare argv test fires on
 * IMPORT and exits before an importing tool's own --self-test can run.
 */
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  if (process.argv.includes("--self-test")) {
    process.exit(selfTest() ? 0 : 1);
  }
  main();
}
