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
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
  writeFileSync(`${dir}/apps/lib/${taskId.replace(/-/g, "-")}.mjs`, task.seed);
  writeFileSync(`${dir}/apps/lib/${taskId}.test.mjs`, task.visibleTest);
  writeFileSync(`${dir}/package.json`, `${JSON.stringify({ name: `bench-${arm}-${taskId}`, type: "module", private: true }, null, 2)}\n`);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "bench@localhost");
  git(dir, "config", "user.name", `bench-${arm}`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "chore: seed the task");
  if (arm === "treatment") {
    cpSync(`${STALLION_ROOT}tools`, `${dir}/tools`, { recursive: true });
    mkdirSync(`${dir}/.githooks`, { recursive: true });
    writeFileSync(`${dir}/.githooks/pre-commit`, "#!/bin/sh\nnode tools/task-coverage.mjs --staged || exit 1\n");
    writeFileSync(`${dir}/.githooks/commit-msg`, "#!/bin/sh\nnode tools/task-coverage.mjs --commit-msg \"$1\" || exit 1\n");
    execFileSync("chmod", ["+x", `${dir}/.githooks/pre-commit`, `${dir}/.githooks/commit-msg`]);
    // The staged gate needs no records; the commit-msg gate needs a scoped in-flight task —
    // both are exactly what the treatment agent's workflow produces.
    cpSync(`${STALLION_ROOT}tasks`, `${dir}/tasks`, { recursive: true });
    rmLocked(`${dir}/tasks`);
    writeFileSync(`${dir}/AGENTS.md`, AGENTS_STANZA);
    writeFileSync(`${dir}/.gitignore`, ".stallion/\n");
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

// The vendored tasks/ carry live records with hash chains bound to this clone's history is NOT
// required (chains verify independently) — but the lockfiles from a live repo must not ride
// along, and stale lockfiles would wedge the first mutation.
import { readdirSync, rmSync } from "node:fs";
function rmLocked(dir) {
  for (const f of readdirSync(dir)) if (f.endsWith(".lock") || f.endsWith(".tmp")) rmSync(`${dir}/${f}`, { force: true });
}

const isEntry = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
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
