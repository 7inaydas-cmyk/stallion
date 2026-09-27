#!/usr/bin/env node
/** Hidden-acceptance grading for the benchmark.
 *
 *  grade.mjs <dir> <taskId>   — runs the task's HIDDEN test suite against the sandbox at <dir>
 *                              (writes the suite, judge frozen first, to a FRESH
 *                              <dir>/.bench-acceptance.mjs, runs node --test, prints one JSON
 *                              line {taskId, passed, failed, total, expected, ungradable[,
 *                              cause]}, removes what it wrote). An incomplete run also prints
 *                              its refusal on stderr and exits 1; the exit code is the grade.
 *  grade.mjs --self-test      — the kit's battery member. Proves both suites DISCRIMINATE (the
 *                              reference passes everything, the seeded code fails at least one
 *                              test), drives each refusal, and builds both arms with setup.mjs
 *                              for the vendored harness to judge. A grader that cannot fail is
 *                              not a grader.
 */
import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { greenVerdictOf } from "../task-state.mjs";
import { derivedBattery } from "./setup.mjs";
import { TASKS, taskById } from "./tasks.mjs";

const SETUP = fileURLToPath(new URL("./setup.mjs", import.meta.url));
const GRADE = fileURLToPath(import.meta.url);

/** The judge is frozen before the graded module loads. The suite and the module under test share
 *  one realm, and the suite reads assert.equal/deepEqual/throws off the shared node:assert objects
 *  when each test runs — a module that swapped them for no-ops at import forged 8/8 on a seed that
 *  fails 7 (the lane-1/2 finding). The freeze is the suite file's FIRST import, so it evaluates
 *  before the module's graph; a tamper then throws at import (ESM is strict) and grades as a run
 *  cut short. BOUNDARY: this closes the assertion channel, not the realm — full isolation needs
 *  the module run out of process with outputs compared as data. */
const JUDGE_FREEZE = 'import a from "node:assert"; Object.freeze(a); Object.freeze(a.strict);';

/** The grader's output ceiling. execFileSync's 1MB default killed a correct module that logs
 *  heavily and blamed "no TAP results" (a sweep caught it); a run past this one is refused as the
 *  buffer kill it is. */
const MAX_OUTPUT = 64 * 1024 * 1024;

function runSuite(testCode, runDir, timeout = 60_000, maxBuffer = MAX_OUTPUT) {
  // ABSOLUTE: the child runs with cwd=<dir>, so a relative <dir> joined here would resolve twice
  // and every relative grade would refuse as "Could not find" (a sweep caught it).
  const file = join(resolve(runDir), ".bench-acceptance.mjs");
  const refused = writeSuite(file, `import 'data:text/javascript,${JUDGE_FREEZE}';\n${testCode}`);
  if (refused !== null) return refused;
  try {
    const out = execFileSync("node", ["--test", "--test-reporter=tap", file], { cwd: runDir, encoding: "utf8", timeout, maxBuffer, stdio: ["ignore", "pipe", "pipe"] });
    return tally(out);
  } catch (e) {
    // node --test exits nonzero when any test fails — the TAP output still counts. But a run
    // that never delivered a verdict (timeout, buffer kill, signal, spawn failure) or produced no
    // tally is a REFUSAL, not a grade: a grader that cannot read state must not pass (a sweep
    // caught the empty-tally fail-open; this task made the killed half live instead of
    // computed-and-dropped). The refusal carries its REAL tally and its cause — a later sweep
    // caught it inventing {failed:1,total:1} and dropping why. Streams join on a newline (the glue
    // law). A timeout reads as ETIMEDOUT and a buffer kill as ENOBUFS, both with a null signal
    // (node --test traps the SIGTERM), and a spawnSync error never carries `killed` — sweeps
    // caught hung and noisy runs both blamed on "no TAP".
    const killed = ["ETIMEDOUT", "ENOBUFS"].includes(e.code) || Boolean(e.signal);
    const result = tally(`${e.stdout ?? ""}\n${e.stderr ?? ""}`);
    if (killed || e.code === "ENOENT" || result.total === 0) return { ...result, ungradable: true, cause: ungradableCause(killed, e, maxBuffer) };
    return result;
  } finally {
    rmSync(file, { force: true });
  }
}

/** The suite is written EXCLUSIVELY (O_CREAT|O_EXCL): a path already there — a symlink an agent
 *  planted to aim the grader's write (and, via the realpathed main module, which code it grades),
 *  or a stale file — is refused, never written through, and never removed: it is evidence. Only
 *  a file this grader created is cleaned up. Returns null once written, else the refusal. */
function writeSuite(file, code) {
  try {
    writeFileSync(file, code, { flag: "wx" });
    return null;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    return {
      passed: 0,
      failed: 0,
      total: 0,
      ungradable: true,
      cause: `${file} already exists — the grader writes its suite only to a path it creates, never through one it did not`,
      fix: `see what sits there, remove it, then re-grade: ls -l ${file} && rm ${file}`,
    };
  }
}

function ungradableCause(killed, e, maxBuffer) {
  if (e.code === "ENOBUFS") return `the run printed past the grader's ${maxBuffer}-byte output buffer and was killed before it delivered a verdict`;
  if (killed) return `the run was killed (${e.signal ?? "timeout"}) before it delivered a verdict`;
  return e.code === "ENOENT" ? "node could not be spawned (ENOENT: is it on PATH?)" : "the run printed no TAP results";
}

/** Pure: the grade. An ungradable run, an empty tally, or a tally short of the suite's declared
 *  tests is a REFUSAL, never a pass: the suite's own test( count is the expected total, and a run
 *  that never reached it certifies nothing (a module that exits at import makes node --test print
 *  one file-level `ok` — only the count catches it). Declared tests are counted by LINE-ANCHORED
 *  test( calls — RegExp.prototype.test( inside assertions must not inflate the expectation (the
 *  run showed 9-vs-8 from exactly that). */
function verdict(suite, run) {
  const expected = (suite.match(/^test\(/gm) ?? []).length;
  const incomplete = run.ungradable === true || run.total === 0 || run.total < expected;
  return { expected, incomplete, pass: run.failed === 0 && !incomplete };
}

/** An incomplete grade's refusal: the rule, the evidence (its real tally and cause), and a
 *  command that shows what stopped the runner — the module loaded as the grader loads it, judge
 *  frozen first, so a tamper that throws only under the freeze shows its throw. */
function ungradableRefusal(task, dir, run, expected) {
  const cause = run.cause ?? `the run reported ${run.total} of the suite's ${expected} declared tests`;
  const module = pathToFileURL(join(resolve(dir), "apps", "lib", `${task.module}.mjs`)).href;
  return [
    `grade: REFUSED — ${task.id} is ungradable: ${cause}`,
    "  rule: a run that never delivered a full verdict grades nothing — an incomplete tally is a refusal, never a pass",
    `  fix: ${run.fix ?? `load the module under test as the grader does to see what stops the runner: node --input-type=module -e '${JUDGE_FREEZE} await import("${module}");'`}`,
  ].join("\n");
}

function tally(tap) {
  let passed = 0;
  let failed = 0;
  for (const line of tap.split("\n")) {
    if (/^ok \d+/.test(line)) passed += 1;
    if (/^not ok \d+/.test(line)) failed += 1;
  }
  return { passed, failed, total: passed + failed };
}

/** Runs a command to completion and returns its status with both streams joined by a newline
 *  (the capture seam's glue law: two streams concatenated bare can fuse a TAP line). */
function capture(command, args, cwd) {
  const r = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
  return { status: r.status, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

/** Node 23+ defaults `node --test` to the spec reporter even when piped (Node 22 and older print
 *  TAP there), and spec never prints "not ok". A command that names no reporter runs as Node 23+
 *  would run it; one that pins its reporter runs as written. */
const underSpecDefault = (command) =>
  (/--test-reporter/.test(command) ? command : command.replace("node --test ", "node --test --test-reporter=spec "));

/** Writes <source> as <dir>/apps/lib/<module>.mjs — the layout every suite imports from. */
function plantModule(dir, module, source) {
  mkdirSync(join(dir, "apps", "lib"), { recursive: true });
  writeFileSync(join(dir, "apps", "lib", `${module}.mjs`), source);
}

/** The grade the CLI applies, with every declared test reported: the self-test certifies a
 *  reference through verdict() itself — a looser tally check stayed green over a suite whose
 *  declared count the live grade could never reach (the sweep's pass-path findings). */
const certifies = (suite, run) => verdict(suite, run).pass && verdict(suite, run).expected === run.total;

const scriptsOf = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts ?? {};

/** Runs <fn> with node:fs's own readdirSync as Node 18.0–18.16 has it — `recursive` silently
 *  ignored — patched on the builtin, live ESM bindings synced, then restored. The real
 *  derivedBattery path is judged, never a seam it could bypass (a review caught the injected
 *  readdir staying green over the old recursive call). */
function underLegacyReaddir(fn) {
  const real = fs.readdirSync;
  fs.readdirSync = (path, options) => real(path, options !== null && typeof options === "object" ? { ...options, recursive: false } : options);
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    fs.readdirSync = real;
    syncBuiltinESMExports();
  }
}

/** Every file under <dir> but its .git — the answer-key scan reads them all. */
const filesUnder = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === ".git" ? [] : e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));

/** The answer key never rides along: no tools/bench, and no file anywhere in the arm carries a
 *  hidden suite or a reference (a sweep caught the key shipping with the treatment arm). */
function answerKeyAbsent(arm) {
  const keys = TASKS.flatMap((t) => [t.hiddenTest, t.reference]);
  const carriesKey = (file) => {
    const text = readFileSync(file, "utf8");
    return keys.some((key) => text.includes(key));
  };
  return !existsSync(join(arm, "tools", "bench")) && !filesUnder(arm).some(carriesKey);
}

/** The commit-time gates must be ACTIVE, not merely present: core.hooksPath points at them, and
 *  a code commit with no task footer is refused by the wired hooks. */
function ungatedCommitRefused(arm, task) {
  const hooksPath = capture("git", ["config", "core.hooksPath"], arm).output.trim();
  writeFileSync(join(arm, "apps", "lib", `${task.module}.mjs`), "export const ungated = 1;\n", { flag: "a" });
  const commit = capture("git", ["commit", "-qam", "feat: no task, no footer"], arm);
  return hooksPath === ".githooks" && commit.status !== 0;
}

/** The GREEN half of the stanza's pin, judged by the law `done` re-runs it under: the reference
 *  installed and a failing test.todo appended is a PASSING run (exit 0, no failure) that still
 *  prints "not ok … # TODO" — the recorded signature must not read it as a vacuous green. */
function stanzaGreenVerdict(arm, task, stanzaPin) {
  const [, command, expect] = stanzaPin.match(/--command "([^"]+)" --expect "([^"]+)"/) ?? [];
  if (command === undefined) return "the AGENTS stanza carries no red-check --command/--expect line";
  plantModule(arm, task.module, task.reference);
  writeFileSync(join(arm, "apps", "lib", `${task.module}.test.mjs`), `${task.visibleTest}test.todo("later", () => assert.equal(1, 2));\n`);
  const runs = [0, 1].map(() => capture("sh", ["-c", command], arm)).map((r) => ({ exitCode: r.status, output: r.output }));
  return greenVerdictOf({ command, expect }, runs);
}

/** The kit's sandboxes, built by the real setup CLI and judged by the vendored harness itself:
 *  the treatment battery must be the doctor's derived one and green on day one (else `advance
 *  verified` is dead), the checklist must ride along (else `adversarial-runner prepare`
 *  crashes and `done` is unreachable), the stanza's red-check line must record a pin exactly
 *  as written, on Node 23+'s spec default too, and clear GREEN at done (else every treatment
 *  run opens or ends with a refusal the kit wrote), the hooks must be committed AND active,
 *  both arms must carry the same spec, and neither the answer key nor harness residue may
 *  ride along. chunk-generator, because its module name is not its task id. */
function selfTestSandboxes() {
  const root = mkdtempSync(join(tmpdir(), "bench-arms-"));
  try {
    const task = taskById("chunk-generator");
    const [treatment, control] = [join(root, "treatment"), join(root, "control")];
    capture("node", [SETUP, "treatment", task.id, treatment]);
    capture("node", [SETUP, "control", task.id, control]);
    const doctor = capture("node", ["tools/task-coverage.mjs", "--doctor"], treatment).output;
    const stanzaPin = readFileSync(join(treatment, "AGENTS.md"), "utf8").match(/`(node tools\/task-state\.mjs red-check [^`]+)`/)?.[1] ?? "";
    capture("node", ["tools/task-state.mjs", "new", "bench-probe", "--risk-class", "runtime-code"], treatment);
    const pin = capture("sh", ["-c", stanzaPin.replace("<id>", "bench-probe")], treatment).output;
    capture("node", ["tools/task-state.mjs", "new", "bench-probe-spec", "--risk-class", "runtime-code"], treatment);
    const specPin = capture("sh", ["-c", underSpecDefault(stanzaPin.replace("<id>", "bench-probe-spec"))], treatment).output;
    const battery = capture("npm", ["run", "selftest"], treatment);
    const keyAbsent = answerKeyAbsent(treatment);
    const specOf = (arm) => (existsSync(join(arm, "TASK.md")) ? readFileSync(join(arm, "TASK.md"), "utf8") : null);
    const sameSpec = [treatment, control].every((arm) => specOf(arm) === `${task.spec}\n`);
    const ungatedRefused = ungatedCommitRefused(treatment, task);
    const green = stanzaGreenVerdict(treatment, task, stanzaPin);
    return [
      ["treatment: the sandbox battery runs every vendored self-testing tool (the doctor's membership law)", doctor.includes("✔ the selftest battery runs every self-testing tool")],
      ["treatment: the derived battery keeps its nested members when node:fs readdirSync ignores `recursive` (Node 18.0–18.16)", underLegacyReaddir(() => derivedBattery(treatment)) === scriptsOf(treatment).selftest],
      ["treatment: the sandbox battery is green on day one (advance verified is reachable)", battery.status === 0],
      ["treatment: the adversarial checklist is vendored (the doctor parses its lanes)", doctor.includes("✔ adversarial checklist parses to exactly 8 lanes")],
      ["treatment: both commit-time gates are committed and invoke their modes (the doctor's hook lines)", doctor.includes("✔ pre-commit staged gate committed") && doctor.includes("✔ commit-msg binding gate committed")],
      ["treatment: the hooks are active (core.hooksPath is .githooks) and refuse an ungated code commit", ungatedRefused],
      ["treatment: the AGENTS stanza's red-check line records a RED pin as written", pin.includes("command pin recorded RED")],
      ["treatment: the AGENTS stanza's red-check line records a RED pin under Node 23+'s spec default reporter", specPin.includes("command pin recorded RED")],
      ["treatment: the AGENTS stanza's pin clears GREEN at done on a passing run with a failing test.todo", green === null],
      ["treatment: the answer key never rides along (no tools/bench, no hidden suite or reference anywhere in the arm)", keyAbsent],
      ["both arms carry the task's spec word for word as TASK.md (the kit delivers it, not a hand copy)", sameSpec],
      ["control: the sandbox carries no harness selftest script", !Object.hasOwn(scriptsOf(control), "selftest")],
    ];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A graded module that tries to disarm the judge: every method of node:assert and
 *  node:assert/strict swapped for a no-op at import (each try swallowed, so the module still
 *  loads), against a suite whose two assertions must fail. */
const DISARM = `import plain from "node:assert";
import strict from "node:assert/strict";
for (const judge of [plain, strict]) for (const k of Object.keys(judge)) try { judge[k] = () => {}; } catch { /* frozen */ }
`;
const DISARM_SUITE = `import { test } from "node:test";
import plain from "node:assert";
import strict from "node:assert/strict";
import "./apps/lib/disarm.mjs";
test("strict", () => strict.equal(1, 2));
test("plain", () => plain.equal(1, 2));
`;

/** The grade's refusals, each driven on its own clause: an empty tally against a suite that
 *  declares nothing (only `total === 0` catches it), a run cut short (a module that exits at
 *  import prints one file-level `ok` and no failure — only the declared count catches it) — by
 *  the CLI too, whose exit code is the grade — an ungradable run that printed every passing
 *  line before it died, and a module that disarms the judge's assertions (the lane-1/2 forge:
 *  8/8 on a seed that fails 7). */
function selfTestVerdicts() {
  const task = taskById("chunk-generator");
  const dir = mkdtempSync(join(tmpdir(), "bench-verdict-"));
  let cutShort;
  let cli;
  let disarmed;
  try {
    plantModule(dir, task.module, "export function chunk() {}\nprocess.exit(0);\n");
    cutShort = runSuite(task.hiddenTest, dir);
    cli = capture("node", [GRADE, dir, task.id]);
    plantModule(dir, "disarm", DISARM);
    disarmed = runSuite(DISARM_SUITE, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const expected = verdict(task.hiddenTest, { passed: 0, failed: 0, total: 0 }).expected;
  return [
    ["an empty tally never passes, even against a suite that declares no tests", !verdict("", { passed: 0, failed: 0, total: 0 }).pass],
    ["a run cut short never passes (a module that exits at import fails nothing)", cutShort.failed === 0 && !verdict(task.hiddenTest, cutShort).pass],
    ["the CLI refuses a run cut short: exit 1 and the stderr refusal", cli.status === 1 && cli.output.includes("grade: REFUSED")],
    ["an ungradable run never passes, whatever it printed", !verdict(task.hiddenTest, { passed: expected, failed: 0, total: expected, ungradable: true }).pass],
    ["the graded module cannot disarm the judge (node:assert and node:assert/strict are frozen before it loads)", disarmed.failed === 2 && disarmed.total === 2],
  ];
}

/** The grader's own seams: a relative <dir> must grade like an absolute one, the CLI must pass
 *  a reference (exit 0, a complete grade), a run that cannot even spawn node is ungradable with
 *  its REAL (empty) tally and cause — never an invented {failed:1,total:1} that drops why — and
 *  a run the grader times out (a 2s timeout here, not the live 60s) names the kill as its cause. */
function selfTestGraderSeams() {
  const task = TASKS[0];
  const root = mkdtempSync(join(tmpdir(), "bench-seam-"));
  const dir = join(root, "sandbox");
  const [cwd, path] = [process.cwd(), process.env.PATH];
  let relativeRun;
  let cli;
  let noNode;
  let hung;
  try {
    plantModule(dir, task.module, task.reference);
    process.chdir(root);
    relativeRun = runSuite(task.hiddenTest, "sandbox");
    process.chdir(cwd);
    cli = capture("node", [GRADE, dir, task.id]);
    process.env.PATH = join(root, "no-node-here");
    noNode = runSuite(task.hiddenTest, dir);
    process.env.PATH = path;
    hung = runSuite('import { test } from "node:test";\ntest("hangs", () => new Promise((r) => setTimeout(r, 20_000)));\n', dir, 2_000);
  } finally {
    process.chdir(cwd);
    process.env.PATH = path;
    rmSync(root, { recursive: true, force: true });
  }
  return [
    ["a relative sandbox dir grades like an absolute one (the reference passes)", certifies(task.hiddenTest, relativeRun)],
    ["the CLI passes the reference: exit 0 and a complete grade", cli.status === 0 && cli.output.includes('"ungradable":false')],
    ["a run that cannot spawn node is ungradable with its real empty tally and cause", noNode.ungradable === true && noNode.total === 0 && /ENOENT/.test(noNode.cause ?? "")],
    ["a run the grader times out is refused as killed, not as printing no TAP results", hung.ungradable === true && /killed \(timeout\)/.test(hung.cause ?? "")],
  ];
}

/** An agent-planted .bench-acceptance.mjs, symlinked at an operator file outside the sandbox:
 *  the grade must refuse it, write nothing through it, and leave the link as evidence. */
function plantedRun(root, dir, task) {
  const target = join(root, "operator-data.txt");
  const link = join(dir, ".bench-acceptance.mjs");
  writeFileSync(target, "operator data\n");
  symlinkSync(target, link);
  const run = runSuite(task.hiddenTest, dir);
  return { run, untouched: readFileSync(target, "utf8") === "operator data\n" && lstatSync(link).isSymbolicLink() };
}

/** The grader's limits: a correct module that logs heavily still grades (execFileSync's 1MB
 *  default killed one as "no TAP results"), a run past the buffer is refused as the buffer kill
 *  it is (a 64KB buffer here) — at import, and after every ok line, where only the kill clause
 *  stands between a complete tally and a pass — and a planted suite path is refused, never
 *  written through. */
function selfTestGraderLimits() {
  const task = TASKS[0];
  const root = mkdtempSync(join(tmpdir(), "bench-limits-"));
  const [dir, noisy, lateNoisy] = [join(root, "sandbox"), join(root, "noisy"), join(root, "late-noisy")];
  let loud;
  let overflow;
  let late;
  let planted;
  try {
    plantModule(dir, task.module, task.reference);
    plantModule(noisy, task.module, `${task.reference}console.log("x".repeat(2 * 1024 * 1024));\n`);
    plantModule(lateNoisy, task.module, `${task.reference}process.on("exit", () => process.stdout.write("x".repeat(256 * 1024)));\n`);
    loud = runSuite(task.hiddenTest, noisy);
    overflow = runSuite(task.hiddenTest, noisy, 60_000, 64 * 1024);
    late = runSuite(task.hiddenTest, lateNoisy, 60_000, 64 * 1024);
    planted = plantedRun(root, dir, task);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return [
    ["a correct module that logs heavily still grades (the grader's buffer outlasts its log)", certifies(task.hiddenTest, loud)],
    ["a run past the grader's output buffer is refused as a buffer kill, not as printing no TAP results", overflow.ungradable === true && /output buffer/.test(overflow.cause ?? "")],
    ["a run the buffer kills after every ok line is still refused as a buffer kill (a complete tally is no verdict)", late.total === verdict(task.hiddenTest, late).expected && late.ungradable === true && /output buffer/.test(late.cause ?? "")],
    ["a planted .bench-acceptance.mjs is refused, never written through, and left as evidence", planted.run.ungradable === true && planted.untouched],
  ];
}

function selfTest() {
  const failures = [];
  const fail = (m) => failures.push(m);
  const cases = TASKS.flatMap((task) => {
    // reference passes everything; seed fails something — per task, in a scratch dir whose
    // apps/lib layout matches what the hidden suite imports.
    const refDir = mkdtempSync(join(tmpdir(), `bench-ref-`));
    const seedDir = mkdtempSync(join(tmpdir(), `bench-seed-`));
    const results = [];
    try {
      plantModule(refDir, task.module, task.reference);
      plantModule(seedDir, task.module, task.seed);
      const ref = runSuite(task.hiddenTest, refDir);
      const seed = runSuite(task.hiddenTest, seedDir);
      results.push([`${task.id}: the reference passes every hidden test`, certifies(task.hiddenTest, ref)]);
      results.push([`${task.id}: the seed fails at least one hidden test (the suite discriminates)`, seed.failed > 0]);
      // The VISIBLE suite is the RED an honest treatment agent pins: it must fail on the seed and
      // pass on the reference, run where the sandbox puts it (next to the module). A reference
      // that passes proves its `./<module>.mjs` import resolves, so the seed's failure is an
      // assertion, never the MODULE_NOT_FOUND RED that flawed the first run.
      const visRef = runSuite(task.visibleTest, join(refDir, "apps", "lib"));
      const visSeed = runSuite(task.visibleTest, join(seedDir, "apps", "lib"));
      results.push([`${task.id}: the reference passes every visible test`, certifies(task.visibleTest, visRef)]);
      results.push([`${task.id}: the seed fails at least one visible test (a real RED)`, visSeed.failed > 0]);
    } finally {
      rmSync(refDir, { recursive: true, force: true });
      rmSync(seedDir, { recursive: true, force: true });
    }
    return results;
  });
  const shape = [
    ["four tasks defined", TASKS.length === 4],
    ["every task has spec, seed, both suites, and a reference", TASKS.every((t) => t.spec && t.seed && t.visibleTest && t.hiddenTest && t.reference)],
    ["every spec names its module's path", TASKS.every((t) => t.spec.includes(`apps/lib/${t.module}.mjs`))],
    ["chunk-generator: the spec states the call-time RangeError its hidden suite grades", /throws as soon as chunk\(\) is called, before any iteration/.test(taskById("chunk-generator").spec)],
  ];
  const all = [...shape, ...cases, ...selfTestVerdicts(), ...selfTestGraderSeams(), ...selfTestGraderLimits(), ...selfTestSandboxes()];
  for (const [name, passes] of all) if (!passes) fail(`bench: ${name}`);
  console.log(failures.length === 0
    ? `bench grade self-test: OK (${all.length} cases over ${TASKS.length} tasks; both suites discriminate, the refusals fire, the sandboxes pass their own harness)`
    : `bench grade self-test: FAILED\n  ${failures.join("\n  ")}`);
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
if (isEntry) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  const [dir, taskId] = argv;
  const task = taskById(taskId ?? "");
  if (!dir || !task) {
    console.error("usage: grade.mjs <dir> <taskId> (--self-test to self-test)");
    process.exit(1);
  }
  const run = runSuite(task.hiddenTest, dir);
  const { expected, incomplete, pass } = verdict(task.hiddenTest, run);
  console.log(JSON.stringify({ taskId, passed: run.passed, failed: run.failed, total: run.total, expected, ungradable: incomplete, ...(run.cause ? { cause: run.cause } : {}) }));
  if (incomplete) console.error(ungradableRefusal(task, dir, run, expected));
  process.exit(pass ? 0 : 1);
}
