#!/usr/bin/env node
/** Sandbox setup for the two-arm benchmark.
 *
 *  setup.mjs <arm> <taskId> <dir>
 *    arm = treatment | control
 *
 *  Both arms get the same seed: TASK.md (the task's spec, word for word — the agent's brief,
 *  delivered by the kit rather than a hand copy from the answer-key file), apps/lib/<module>.mjs
 *  + the visible test, git-initialized, one seed commit. TREATMENT additionally gets the
 *  COMMIT-TIME subset of docs/WIRING.md: the lifecycle tools (§2's six core members closed over
 *  their imports — today that closure also carries §11's pathspec, retrospective and
 *  test-lint — plus the §7 ZCode plugin), a selftest battery DERIVED from what was vendored (the
 *  doctor's own membership law — THE BATTERY LAW forbids a hand-kept list), .githooks/ with the
 *  staged + commit-msg gates wired via core.hooksPath, the empty tasks/ state dir, the decisions
 *  register, the adversarial checklist, and the AGENTS.md law stanza. Deliberately OMITTED, so
 *  the doctor still reports them: the push side (pre-push, CI, .stallion-base — the benchmark
 *  measures commit-time behavior) and the rest of the §11 gates family with docs/gates/
 *  (repo-specific config, and complexity-gate's TypeScript peer, that would hand the arm a
 *  battery red on day one).
 *  CONTROL gets none of it: a plain repo. The only difference between arms is the harness. */
import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dispatchesSelfTest } from "../task-coverage.mjs";
import { stripComments } from "../test-lint.mjs";
import { taskById } from "./tasks.mjs";

const STALLION_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** WIRING §2's basic vendoring — the six core members. The treatment arm carries these, what
 *  they import, and the plugin; tools/bench/ never rides along (it holds every hidden suite and
 *  reference — a sweep caught the answer key shipping with the arm). */
const CORE = ["task-findings.mjs", "task-state.mjs", "adversarial-runner.mjs", "task-workspace.mjs", "task-coverage.mjs", "task-gate.mjs"];

/** The stanza's red-check line pins the TAP reporter, as the grader does: Node 23+ defaults
 *  `node --test` to spec even when piped, and spec never prints the TAP summary the pin expects.
 *  Its signature is that summary's failure count, "# fail [1-9]": a bare "not ok" also matches a
 *  PASSING run's failing test.todo ("not ok N - … # TODO", exit 0, "# fail 0"), which `done`
 *  re-runs as a vacuous green and refuses (a sweep caught it). */
const AGENTS_STANZA = `# AGENTS.md

Code in this repo is written under the stallion task lifecycle.

- Before planning: \`node tools/task-state.mjs status\`
- Code lands only under a task: \`node tools/task-state.mjs new <id> --risk-class runtime-code\`,
  advanced one phase at a time (intake → planned → executing → verified → adversarial → done).
- Declare the blast radius when planning: \`node tools/task-state.mjs scope <id> --add "apps/lib/**"\`.
- Commits that touch code carry a \`task: <id>\` footer on its own line, in the final trailer
  block of the message.
- \`verified\` needs a command pin: run \`node tools/task-state.mjs red-check <id> --command "node --test --test-reporter=tap apps/lib/<module>.test.mjs" --expect "# fail [1-9]"\`
  while the tests still FAIL, before you fix the code.
- \`done\` needs a clean adversarial pass (the operator dispatches it) and every pin re-run GREEN.
- Refusals print the rule, the evidence, and an exact fix command. Run the fix. Do not work
  around a refusal.
- Verify with \`npm run selftest\`.
`;

/** The caller's env without its GIT_* — inside a git hook GIT_DIR/GIT_INDEX_FILE name the HOST
 *  repo, and a sandbox inheriting them inits, stages and commits into it (vendor-feedback-wave4).
 *  Read at call time: the grader's self-test sets a hook env on process.env. */
export const fixtureEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));

function git(dir, ...args) {
  execFileSync("git", args, { cwd: dir, env: fixtureEnv(), stdio: ["ignore", "pipe", "pipe"] });
}

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

/** CORE closed over its static relative imports, read comment-stripped (a commented-out import
 *  is not a dependency) — derived, so a core member that grows an import vendors it too. */
function lifecycleClosure() {
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const source = stripComments(readFileSync(`${STALLION_ROOT}tools/${name}`, "utf8"));
    for (const [, dep] of source.matchAll(/^import [^;]*? from "\.\/([\w-]+\.mjs)";$/gm)) visit(dep);
  };
  CORE.forEach(visit);
  return [...seen];
}

/** Every file under <abs>, relative to it — the doctor's own traversal (withFileTypes, dot
 *  entries skipped), never readdir's `recursive` option, which Node 18.0–18.16 silently ignores:
 *  there the battery lost every nested member while package.json still promises Node >=18. */
function toolFiles(abs, rel) {
  return readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".")) return [];
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
    return entry.isDirectory() ? toolFiles(`${abs}/${entry.name}`, entryRel) : [entryRel];
  });
}

/** The sandbox battery, DERIVED from the vendored tree with the doctor's own membership test:
 *  every vendored .mjs, at any depth, that dispatches on --self-test. A hand-kept list drifted
 *  to six of twenty-two vendored members while the doctor inside the sandbox refused it. */
export function derivedBattery(dir) {
  return toolFiles(`${dir}/tools`, "")
    .filter((f) => f.endsWith(".mjs") && dispatchesSelfTest(stripComments(readFileSync(`${dir}/tools/${f}`, "utf8"))))
    .sort()
    .map((f) => `node tools/${f} --self-test`)
    .join(" && ");
}

function vendorHarness(dir, task, pkg) {
  mkdirSync(`${dir}/tools`, { recursive: true });
  for (const name of lifecycleClosure()) cpSync(`${STALLION_ROOT}tools/${name}`, `${dir}/tools/${name}`);
  cpSync(`${STALLION_ROOT}tools/zcode-plugin`, `${dir}/tools/zcode-plugin`, { recursive: true });
  // The selftest script the AGENTS law mandates exists on day one (a sweep caught the stanza
  // pointing at a missing script — a remediation tax billed to the wrong arm), and in THIS arm
  // only: control has no tools/ for it to run.
  writeJson(`${dir}/package.json`, { ...pkg, scripts: { ...pkg.scripts, selftest: derivedBattery(dir) } });
  mkdirSync(`${dir}/.githooks`, { recursive: true });
  writeFileSync(`${dir}/.githooks/pre-commit`, "#!/bin/sh\nnode tools/task-coverage.mjs --staged || exit 1\n");
  writeFileSync(`${dir}/.githooks/commit-msg`, "#!/bin/sh\nnode tools/task-coverage.mjs --commit-msg \"$1\" || exit 1\n");
  execFileSync("chmod", ["+x", `${dir}/.githooks/pre-commit`, `${dir}/.githooks/commit-msg`]);
  // EMPTY task state: the gates judge only this sandbox's own records. (A sweep caught the
  // live records riding along — including an in-flight vendor task that held the staged gate
  // permanently open, an uncontrolled variable in a benchmark claiming arms differ only in
  // the harness.)
  mkdirSync(`${dir}/tasks`, { recursive: true });
  writeFileSync(`${dir}/AGENTS.md`, AGENTS_STANZA.replaceAll("<module>", task.module));
  writeFileSync(`${dir}/.gitignore`, ".stallion/\n");
  // task-coverage's own self-test cross-reads the decisions register, and the adversarial
  // runner reads the checklist — without it `prepare` crashes and `done` is unreachable.
  mkdirSync(`${dir}/docs/decisions`, { recursive: true });
  cpSync(`${STALLION_ROOT}docs/decisions/DECISIONS.md`, `${dir}/docs/decisions/DECISIONS.md`);
  cpSync(`${STALLION_ROOT}docs/ADVERSARIAL-CHECKLIST.md`, `${dir}/docs/ADVERSARIAL-CHECKLIST.md`);
  // The harness commit lands BEFORE the hooks activate — the gates bind the task work that
  // follows, not their own vendoring (the same bootstrap every adoption has).
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "chore: vendor the stallion harness");
  git(dir, "config", "core.hooksPath", ".githooks");
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
  writeFileSync(`${dir}/TASK.md`, `${task.spec}\n`);
  writeFileSync(`${dir}/apps/lib/${task.module}.mjs`, task.seed);
  writeFileSync(`${dir}/apps/lib/${task.module}.test.mjs`, task.visibleTest);
  const pkg = { name: `bench-${arm}-${taskId}`, type: "module", private: true, scripts: { test: `node --test apps/lib/${task.module}.test.mjs` } };
  writeJson(`${dir}/package.json`, pkg);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "bench@localhost");
  git(dir, "config", "user.name", `bench-${arm}`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "chore: seed the task");
  if (arm === "treatment") vendorHarness(dir, task, pkg);
  console.log(`${arm}/${taskId}: sandbox ready at ${dir} — the agent's brief is ${dir}/TASK.md`);
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
