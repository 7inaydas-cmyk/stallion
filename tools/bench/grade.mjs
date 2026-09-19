#!/usr/bin/env node
/** Hidden-acceptance grading for the benchmark.
 *
 *  grade.mjs <dir> <taskId>   — runs the task's HIDDEN test suite against the sandbox at <dir>
 *                              (writes the suite to <dir>/.bench-acceptance.mjs, runs
 *                              node --test, prints one JSON line {taskId, passed, failed,
 *                              total}, cleans up).
 *  grade.mjs --self-test      — proves the suite DISCRIMINATES: the reference implementation
 *                              passes everything, the seeded (buggy/TODO) code fails at least
 *                              one test, and every task has a spec/seed/tests. A grader that
 *                              cannot fail is not a grader.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASKS, taskById } from "./tasks.mjs";

function runSuite(testCode, runDir) {
  const file = join(runDir, ".bench-acceptance.mjs");
  writeFileSync(file, testCode);
  try {
    const out = execFileSync("node", ["--test", "--test-reporter=tap", file], { cwd: runDir, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    return tally(out);
  } catch (e) {
    // node --test exits nonzero when any test fails — the TAP output still counts. But a
    // KILLED run (timeout/signal) has no verdict: a grader that cannot read state must not
    // pass (a sweep caught the empty-tally fail-open).
    const killed = e.killed === true || (typeof e.signal === "string" && e.signal !== "SIGTERM" ? true : e.killed === true);
    const result = tally(`${e.stdout ?? ""}${e.stderr ?? ""}`);
    if (e.code === "ENOENT" || result.total === 0) return { passed: 0, failed: 1, total: 1, ungradable: true };
    return result;
  }
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
    } finally {
      rmSync(refDir, { recursive: true, force: true });
      rmSync(seedDir, { recursive: true, force: true });
    }
    return results;
  });
  const shape = [
    ["four tasks defined", TASKS.length === 4],
    ["every task has spec, seed, both suites, and a reference", TASKS.every((t) => t.spec && t.seed && t.visibleTest && t.hiddenTest && t.reference)],
  ];
  for (const [name, passes] of [...shape, ...cases]) if (!passes) fail(`bench: ${name}`);
  console.log(failures.length === 0
    ? `bench grade self-test: OK (${TASKS.length} tasks; reference passes all, seed fails at least one — the grader discriminates)`
    : `bench grade self-test: FAILED\n  ${failures.join("\n  ")}`);
  return failures.length === 0;
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isEntry) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  const [dir, taskId] = argv;
  const task = taskById(taskId ?? "");
  if (!dir || !task) {
    console.error("usage: grade.mjs <dir> <taskId> (--self-test to self-test)");
    process.exit(1);
  }
  const { passed, failed, total, ungradable } = runSuite(task.hiddenTest, dir);
  const file = join(dir, ".bench-acceptance.mjs");
  try { rmSync(file, { force: true }); } catch { /* best effort */ }
  // An ungradable or empty run is a REFUSAL, not a pass: the suite's own plan line is the
  // expected count, and a tally that never saw it cannot certify anything.
  // Count declared tests by LINE-ANCHORED test( calls — RegExp.prototype.test( inside assertions
  // must not inflate the expectation (the run just showed 9-vs-8 from exactly that).
  const expected = (task.hiddenTest.match(/^test\(/gm) ?? []).length;
  const incomplete = ungradable || total === 0 || total < expected;
  console.log(JSON.stringify({ taskId, passed, failed, total, expected, ungradable: Boolean(incomplete) }));
  process.exit(failed === 0 && !incomplete ? 0 : 1);
}
