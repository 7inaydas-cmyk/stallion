#!/usr/bin/env node
/** Sandbox setup for the two-arm benchmark.
 *
 *  setup.mjs <arm> <taskId> <dir>
 *    arm = treatment | control
 *
 *  Both arms get the same seed: apps/lib/<task>.mjs + the visible test, git-initialized, one
 *  seed commit. TREATMENT additionally gets stallion vendored (tools/, .githooks/ with the
 *  staged + commit-msg gates wired via core.hooksPath, the tasks/ state dir) and the AGENTS.md
 *  law stanza — exactly the adoption path docs/WIRING.md prescribes. CONTROL gets none of it:
 *  a plain repo. The only difference between arms is the harness. */
import { cpSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { taskById } from "./tasks.mjs";

const STALLION_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const AGENTS_STANZA = `# AGENTS.md

Code in this repo is written under the stallion task lifecycle.

- Before planning: \`node tools/task-state.mjs status\`
- Code lands only under a task: \`node tools/task-state.mjs new <id> --risk-class runtime-code\`,
  advanced one phase at a time (intake → planned → executing → verified → adversarial → done).
- Declare the blast radius when planning: \`node tools/task-state.mjs scope <id> --add "apps/lib/**"\`.
- Commits that touch code carry a \`task: <id>\` footer on its own line, in the final trailer
  block of the message.
- \`verified\` needs a command pin: run \`node tools/task-state.mjs red-check <id> --command "node --test apps/lib/<task>.test.mjs"\`
  while the tests still FAIL, before you fix the code.
- \`done\` needs a clean adversarial pass (the operator dispatches it) and every pin re-run GREEN.
- Refusals print the rule, the evidence, and an exact fix command. Run the fix. Do not work
  around a refusal.
- Verify with \`npm run selftest\`.
`;

function git(dir, ...args) {
  execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
}

function setup(arm, taskId, dir) {
  const task = taskById(taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (arm !== "treatment" && arm !== "control") throw new Error(`unknown arm: ${arm}`);
  mkdirSync(`${dir}/apps/lib`, { recursive: true });
  // ONE module name across spec, visible test, seed, hidden grader, AND the npm test script
  // (a sweep caught all four disagreeing for the feature tasks — spec-faithful work graded
  // against a stub; then scripts.test still naming taskId while the file is <module>.test.mjs,
  // leaving `npm test` pointing at nothing for chunk-generator and csv-fields).
  writeFileSync(`${dir}/apps/lib/${task.module}.mjs`, task.seed);
  writeFileSync(`${dir}/apps/lib/${task.module}.test.mjs`, task.visibleTest);
  // The selftest script the AGENTS law mandates must exist on day one (a sweep caught the
  // stanza pointing at a missing script — a remediation tax billed to the wrong arm).
  writeFileSync(`${dir}/package.json`, `${JSON.stringify({ name: `bench-${arm}-${taskId}`, type: "module", private: true, scripts: { test: `node --test apps/lib/${task.module}.test.mjs`, selftest: `node tools/task-findings.mjs --self-test && node tools/task-state.mjs --self-test && node tools/adversarial-runner.mjs --self-test && node tools/task-workspace.mjs --self-test && node tools/task-coverage.mjs --self-test && node tools/task-gate.mjs --self-test` } }, null, 2)}\n`);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "bench@localhost");
  git(dir, "config", "user.name", `bench-${arm}`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "chore: seed the task");
  if (arm === "treatment") {
    // Vendor the harness WITHOUT the benchmark's own answer key: tools/bench/ holds every
    // hidden suite and reference implementation, and a graded treatment agent walks tools/
    // from its first lifecycle command (a sweep finding: the key shipped with the arm).
    cpSync(`${STALLION_ROOT}tools`, `${dir}/tools`, { recursive: true, filter: (src) => !src.includes(`${STALLION_ROOT}tools/bench`) });
    mkdirSync(`${dir}/.githooks`, { recursive: true });
    writeFileSync(`${dir}/.githooks/pre-commit`, "#!/bin/sh\nnode tools/task-coverage.mjs --staged || exit 1\n");
    writeFileSync(`${dir}/.githooks/commit-msg`, "#!/bin/sh\nnode tools/task-coverage.mjs --commit-msg \"$1\" || exit 1\n");
    execFileSync("chmod", ["+x", `${dir}/.githooks/pre-commit`, `${dir}/.githooks/commit-msg`]);
    // EMPTY task state: the gates judge only this sandbox's own records. (A sweep caught the
    // live records riding along — including an in-flight vendor task that held the staged gate
    // permanently open, an uncontrolled variable in a benchmark claiming arms differ only in
    // the harness.)
    mkdirSync(`${dir}/tasks`, { recursive: true });
    writeFileSync(`${dir}/AGENTS.md`, AGENTS_STANZA);
    writeFileSync(`${dir}/.gitignore`, ".stallion/\n");
    // task-coverage's own self-test cross-reads the decisions register; a verified battery
    // that includes it needs the register present (the second friction the run surfaced).
    mkdirSync(`${dir}/docs/decisions`, { recursive: true });
    cpSync(`${STALLION_ROOT}docs/decisions/DECISIONS.md`, `${dir}/docs/decisions/DECISIONS.md`);
    // .stallion-base is not needed: the commit-msg gate does not resolve a push base, and the
    // benchmark measures commit-time behavior, not push behavior.
    // The harness commit lands BEFORE the hooks activate — the gates bind the task work that
    // follows, not their own vendoring (the same bootstrap every adoption has).
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "chore: vendor the stallion harness");
    git(dir, "config", "core.hooksPath", ".githooks");
  }
  console.log(`${arm}/${taskId}: sandbox ready at ${dir}`);
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isEntry) {
  const [arm, taskId, dir] = process.argv.slice(2);
  if (!arm || !taskId || !dir) {
    console.error("usage: setup.mjs <treatment|control> <taskId> <dir>");
    process.exit(1);
  }
  try {
    setup(arm, taskId, dir);
  } catch (e) {
    console.error(`setup: ${e.message}`);
    process.exit(1);
  }
}
