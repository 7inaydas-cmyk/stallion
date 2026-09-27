#!/usr/bin/env node
/** Hidden-acceptance grading for the benchmark.
 *
 *  grade.mjs <dir> <taskId>   — runs the task's HIDDEN test suite against the sandbox at <dir>
 *                              (writes the suite to <dir>/.bench-acceptance.mjs, runs
 *                              node --test, prints one JSON line {taskId, passed, failed,
 *                              total, expected, ungradable[, cause]}, cleans up). An
 *                              incomplete run also prints its refusal on stderr and exits 1.
 *  grade.mjs --self-test      — the kit's battery member. Proves both suites DISCRIMINATE (the
 *                              reference passes everything, the seeded code fails at least one
 *                              test), drives each refusal, and builds both arms with setup.mjs
 *                              for the vendored harness to judge. A grader that cannot fail is
 *                              not a grader.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS, taskById } from "./tasks.mjs";

const SETUP = fileURLToPath(new URL("./setup.mjs", import.meta.url));

function runSuite(testCode, runDir, timeout = 60_000) {
  // ABSOLUTE: the child runs with cwd=<dir>, so a relative <dir> joined here would resolve twice
  // and every relative grade would refuse as "Could not find" (a sweep caught it).
  const file = join(resolve(runDir), ".bench-acceptance.mjs");
  writeFileSync(file, testCode);
  try {
    const out = execFileSync("node", ["--test", "--test-reporter=tap", file], { cwd: runDir, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
    return tally(out);
  } catch (e) {
    // node --test exits nonzero when any test fails — the TAP output still counts. But a run
    // that never delivered a verdict (timeout, signal, spawn failure) or produced no tally is a
    // REFUSAL, not a grade: a grader that cannot read state must not pass (a sweep caught the
    // empty-tally fail-open; this task made the killed half live instead of computed-and-dropped).
    // The refusal carries its REAL tally and its cause — a later sweep caught it inventing
    // {failed:1,total:1} and dropping why. Streams join on a newline (the glue law). A timeout
    // reads as ETIMEDOUT with a null signal (node --test traps the SIGTERM and exits 1), and a
    // spawnSync error never carries `killed` — a sweep caught hung runs blamed on "no TAP".
    const killed = e.code === "ETIMEDOUT" || (typeof e.signal === "string" && e.signal.length > 0);
    const result = tally(`${e.stdout ?? ""}\n${e.stderr ?? ""}`);
    if (killed || e.code === "ENOENT" || result.total === 0) return { ...result, ungradable: true, cause: ungradableCause(killed, e) };
    return result;
  }
}

function ungradableCause(killed, e) {
  if (killed) return `the run was killed (${e.signal ?? "timeout"}) before it delivered a verdict`;
  return e.code === "ENOENT" ? "node could not be spawned (ENOENT: is it on PATH?)" : "the run printed no TAP results";
}

/** Pure: the grade. An ungradable run, an empty tally, or a tally short of the suite's declared
 *  tests is a REFUSAL, never a pass: the suite's own test( count is the expected total, and a run
 *  that never reached it certifies nothing (a module that exits at import makes node --test print
 *  one file-level `ok` — only the count catches it). Declared tests are counted by LINE-ANCHORED
 *  test( calls — RegExp.prototype.test( inside assertions must not inflate the expectation (the
 *  run showed 9-vs-8 from exactly that). */
function verdict(task, run) {
  const expected = (task.hiddenTest.match(/^test\(/gm) ?? []).length;
  const incomplete = run.ungradable === true || run.total === 0 || run.total < expected;
  return { expected, incomplete, pass: run.failed === 0 && !incomplete };
}

/** An incomplete grade's refusal: the rule, the evidence (its real tally and cause), and a
 *  command that shows what stopped the runner. */
function ungradableRefusal(task, dir, run, expected) {
  const cause = run.cause ?? `the run reported ${run.total} of the suite's ${expected} declared tests`;
  return [
    `grade: REFUSED — ${task.id} is ungradable: ${cause}`,
    "  rule: a run that never delivered a full verdict grades nothing — an incomplete tally is a refusal, never a pass",
    `  fix: load the module under test by hand to see what stops the runner: node ${join(resolve(dir), "apps", "lib", `${task.module}.mjs`)}`,
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

/** The kit's sandboxes, built by the real setup CLI and judged by the vendored harness itself:
 *  the treatment battery must be the doctor's derived one and green on day one (else `advance
 *  verified` is dead), the checklist must ride along (else `adversarial-runner prepare`
 *  crashes and `done` is unreachable), the stanza's red-check line must record a pin exactly
 *  as written, on Node 23+'s spec default too (else every treatment run opens with a refusal
 *  the kit wrote), and control must carry no harness residue. chunk-generator, because its module name is not its task id. */
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
    const controlScripts = JSON.parse(readFileSync(join(control, "package.json"), "utf8")).scripts ?? {};
    return [
      ["treatment: the sandbox battery runs every vendored self-testing tool (the doctor's membership law)", doctor.includes("✔ the selftest battery runs every self-testing tool")],
      ["treatment: the sandbox battery is green on day one (advance verified is reachable)", battery.status === 0],
      ["treatment: the adversarial checklist is vendored (the doctor parses its lanes)", doctor.includes("✔ adversarial checklist parses to exactly 8 lanes")],
      ["treatment: the AGENTS stanza's red-check line records a RED pin as written", pin.includes("command pin recorded RED")],
      ["treatment: the AGENTS stanza's red-check line records a RED pin under Node 23+'s spec default reporter", specPin.includes("command pin recorded RED")],
      ["control: the sandbox carries no harness selftest script", !Object.hasOwn(controlScripts, "selftest")],
    ];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The grade's refusals, each driven on its own clause: an empty tally against a suite that
 *  declares nothing (only `total === 0` catches it), a run cut short (a module that exits at
 *  import prints one file-level `ok` and no failure — only the declared count catches it), and
 *  an ungradable run that printed every passing line before it died. */
function selfTestVerdicts() {
  const task = taskById("chunk-generator");
  const dir = mkdtempSync(join(tmpdir(), "bench-verdict-"));
  let cutShort;
  try {
    mkdirSync(join(dir, "apps", "lib"), { recursive: true });
    writeFileSync(join(dir, "apps", "lib", `${task.module}.mjs`), "export function chunk() {}\nprocess.exit(0);\n");
    cutShort = runSuite(task.hiddenTest, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const expected = verdict(task, { passed: 0, failed: 0, total: 0 }).expected;
  return [
    ["an empty tally never passes, even against a suite that declares no tests", !verdict({ hiddenTest: "" }, { passed: 0, failed: 0, total: 0 }).pass],
    ["a run cut short never passes (a module that exits at import fails nothing)", cutShort.failed === 0 && !verdict(task, cutShort).pass],
    ["an ungradable run never passes, whatever it printed", !verdict(task, { passed: expected, failed: 0, total: expected, ungradable: true }).pass],
  ];
}

/** The grader's own seams: a relative <dir> must grade like an absolute one, a run that
 *  cannot even spawn node is ungradable with its REAL (empty) tally and cause — never an
 *  invented {failed:1,total:1} that drops why — and a run the grader times out (a 2s timeout
 *  here, not the live 60s) names the kill as its cause. */
function selfTestGraderSeams() {
  const task = TASKS[0];
  const root = mkdtempSync(join(tmpdir(), "bench-seam-"));
  const dir = join(root, "sandbox");
  const [cwd, path] = [process.cwd(), process.env.PATH];
  let relativeRun;
  let noNode;
  let hung;
  try {
    mkdirSync(join(dir, "apps", "lib"), { recursive: true });
    writeFileSync(join(dir, "apps", "lib", `${task.module}.mjs`), task.reference);
    process.chdir(root);
    relativeRun = runSuite(task.hiddenTest, "sandbox");
    process.chdir(cwd);
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
    ["a relative sandbox dir grades like an absolute one (the reference passes)", relativeRun.failed === 0 && relativeRun.total > 0],
    ["a run that cannot spawn node is ungradable with its real empty tally and cause", noNode.ungradable === true && noNode.total === 0 && /ENOENT/.test(noNode.cause ?? "")],
    ["a run the grader times out is refused as killed, not as printing no TAP results", hung.ungradable === true && /killed \(timeout\)/.test(hung.cause ?? "")],
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
      for (const dir of [refDir, seedDir]) {
        const lib = join(dir, "apps", "lib");
        mkdirSync(lib, { recursive: true });
        writeFileSync(join(lib, `${task.module}.mjs`), dir === refDir ? task.reference : task.seed);
      }
      const ref = runSuite(task.hiddenTest, refDir);
      const seed = runSuite(task.hiddenTest, seedDir);
      results.push([`${task.id}: the reference passes every hidden test`, ref.failed === 0 && ref.total > 0]);
      results.push([`${task.id}: the seed fails at least one hidden test (the suite discriminates)`, seed.failed > 0]);
      // The VISIBLE suite is the RED an honest treatment agent pins: it must fail on the seed and
      // pass on the reference, run where the sandbox puts it (next to the module). A reference
      // that passes proves its `./<module>.mjs` import resolves, so the seed's failure is an
      // assertion, never the MODULE_NOT_FOUND RED that flawed the first run.
      const visRef = runSuite(task.visibleTest, join(refDir, "apps", "lib"));
      const visSeed = runSuite(task.visibleTest, join(seedDir, "apps", "lib"));
      results.push([`${task.id}: the reference passes every visible test`, visRef.failed === 0 && visRef.total > 0]);
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
  ];
  const all = [...shape, ...cases, ...selfTestVerdicts(), ...selfTestGraderSeams(), ...selfTestSandboxes()];
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
  try { rmSync(join(dir, ".bench-acceptance.mjs"), { force: true }); } catch { /* best effort */ }
  const { expected, incomplete, pass } = verdict(task, run);
  console.log(JSON.stringify({ taskId, passed: run.passed, failed: run.failed, total: run.total, expected, ungradable: incomplete, ...(run.cause ? { cause: run.cause } : {}) }));
  if (incomplete) console.error(ungradableRefusal(task, dir, run, expected));
  process.exit(pass ? 0 : 1);
}
