#!/usr/bin/env node
/**
 * Task workspace — parallel task drafting in isolated jj workspaces .
 *
 * A single working copy means one task at a time; jj workspaces give each task its own
 * working-copy commit in the same repo. But colocated jujutsu has a trap this tool exists to make
 * impossible to forget: **jj-native commits (jj commit / jj describe + new) do NOT run the git
 * pre-commit hooks** — and the hooks are where your gates live: lint, tests, generated
 * artifacts, push controls. So the law this tool encodes:
 *
 *   A workspace DRAFTS. The PRIMARY working copy LANDS.
 *   Never move master from a workspace. Landing protocol: in the workspace, export the diff
 *   (jj diff / git diff); in the PRIMARY copy, apply it and `git commit` so the hooks fire; then
 *   push through your gated push path, never from the workspace.
 *
 * Pure guard functions are exported and self-tested; the jj shell refuses early if jj is absent
 * (CI has no jj — the guards are still proven there, and the live jj path prints its own law).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { IMPLEMENTATION_FORBIDDEN as DRAFT_FORBIDDEN, derivePhase, PHASES } from "./task-state.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STATE_DIR = `${ROOT}tasks`;
/** Derived, never re-typed: the drafting window is PHASES from planned up to (excluding)
 *  done — a future phase change flows through task-state's one taxonomy, not a copy here. */
const WORKSPACE_PHASES = new Set(PHASES.slice(PHASES.indexOf("planned"), PHASES.indexOf("done")));

/** Pure: the sibling dir a task's workspace lives in — derived from the repo's OWN name, so a
 *  vendored harness never stamps its brand on the host repo (issue #2). Phase derivation is
 *  task-state's exported law (issue #3): a forged or typo'd transition target is ignored. */
export function workspaceSiblingPath(rootPath, id) {
  const repo = rootPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "repo";
  return `../${repo}-task-${id}`;
}

/**
 * Pure guard for workspace creation. A workspace is for drafting a real implementation, so it
 * demands exactly what drafting demands: an existing task, in a phase where code is being written,
 * a risk class that writes code at all, and a destination that does not already exist.
 */
export function canAddWorkspace(record, dirExists) {
  if (!record || record.schema !== "stallion/task-state@1") return { ok: false, reason: "no task-state record — a workspace is opened FOR a task, never ad hoc" };
  if (DRAFT_FORBIDDEN.has(record.riskClass)) return { ok: false, reason: `risk class '${record.riskClass}' writes no code — nothing to draft in a workspace` };
  const phase = derivePhase(record.events);
  if (!WORKSPACE_PHASES.has(phase)) {
    return { ok: false, reason: `task is '${phase}' — a workspace opens at planned/executing/verified/adversarial, not before there is a spec or after done` };
  }
  if (dirExists) return { ok: false, reason: "workspace directory already exists — pick it up or remove it, never double-add" };
  return { ok: true };
}

/**
 * Pure guard for workspace removal. Forgetting a workspace whose commits never landed orphans
 * them — jj's `workspace list` text does not reliably carry reachability, so the operator asserts
 * it explicitly: --landed (verified against master) or --yes-discard-unlanded-work (abandon
 * knowingly). Neither flag is exactly the refusal.
 */
export function canForgetWorkspace(mode) {
  if (mode === "landed") return { ok: true };
  if (mode === "discard") return { ok: true };
  return { ok: false, reason: "refusing to forget without a landing claim — pass --landed (after verifying master holds the work: jj log -r 'master..task-<id>@workspace' is empty) or --yes-discard-unlanded-work to abandon it" };
}

function die(message) {
  console.error(`task-workspace: ${message}`);
  process.exit(1);
}

function jjOut(...args) {
  try {
    return execFileSync("jj", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch (e) {
    die(`jj ${args.join(" ")} failed: ${e.message}`);
  }
}

function loadTask(id) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) die(`task id must be kebab-case (a-z, 0-9, -): ${id} — a traversal-bearing id must never reach a path join`);
  const path = `${STATE_DIR}/${id}.json`;
  if (!existsSync(path)) die(`no such task: ${id} (expected ${path})`);
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (record.schema !== "stallion/task-state@1") die(`task record has unknown schema: ${String(record.schema)}`);
  return record;
}

function printLandingLaw() {
  console.log(`
LANDING LAW (colocated jujutsu — this is the reason the tool exists):
  jj-native commits DO NOT run the git pre-commit hooks. Draft here; LAND in the primary copy:
    1. in this workspace:  jj diff > /tmp/<task>.patch   (or git diff)
    2. in the PRIMARY copy: apply the patch, then 'git commit' — hooks fire, markers checked
    3. push only from the primary working copy, through your gated push path
  Never 'jj bookmark set' or push master from a workspace.`);
}

function cmdAdd(args) {
  const id = args._[0];
  if (!id) die("usage: add <task-id>");
  const record = loadTask(id);
  const sibling = workspaceSiblingPath(ROOT, id);
  const dir = `${ROOT}${sibling}`;
  const guard = canAddWorkspace(record, existsSync(dir));
  if (!guard.ok) die(`REFUSED — ${guard.reason}`);
  try {
    execFileSync("jj", ["--version"], { encoding: "utf8" });
  } catch {
    die("jj is not on PATH — install jujutsu or draft in the primary working copy");
  }
  jjOut("workspace", "add", "--name", `task-${id}`, dir);
  console.log(`workspace 'task-${id}' added at ${sibling} (task phase: ${derivePhase(record.events)})`);
  printLandingLaw();
}

function cmdForget(args) {
  const id = args._[0];
  if (!id) die("usage: forget <task-id> --landed | --yes-discard-unlanded-work");
  loadTask(id); // the task must exist even to clean up its workspace
  const listing = jjOut("workspace", "list");
  if (!listing.includes(`task-${id}`)) die(`no workspace named 'task-${id}' — nothing to forget (${listing.split("\n").length} workspace(s) listed)`);
  const mode = args.landed === true ? "landed" : args["yes-discard-unlanded-work"] === true ? "discard" : "none";
  const guard = canForgetWorkspace(mode);
  if (!guard.ok) die(`REFUSED — ${guard.reason}`);
  jjOut("workspace", "forget", `task-${id}`);
  console.log(`workspace 'task-${id}' forgotten (directory remains on disk until you delete it)`);
}

function cmdList() {
  try {
    console.log(execFileSync("jj", ["workspace", "list"], { cwd: ROOT, encoding: "utf8" }));
  } catch {
    die("jj is not on PATH — cannot list workspaces");
  }
}

/** Strict parser: BOOLEAN_FLAGS are the only valueless flags; everything else needs a value; duplicates refused. */
const BOOLEAN_FLAGS = new Set(["landed", "yes-discard-unlanded-work"]);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) { args._.push(a); continue; }
    const key = a.slice(2);
    if (args[key] !== undefined) die(`--${key} given more than once`);
    if (BOOLEAN_FLAGS.has(key)) { args[key] = true; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) die(`--${key} requires a value`);
    args[key] = next;
    i += 1;
  }
  return args;
}

export function selfTest() {
  const failures = [];
  const fail = (m) => failures.push(m);
  const mk = (phase, riskClass = "runtime-code") => ({
    schema: "stallion/task-state@1",
    id: "t",
    riskClass,
    events: [
      { type: "created" },
      ...["planned", "executing", "verified", "adversarial", "done"].slice(0, ["planned", "executing", "verified", "adversarial", "done"].indexOf(phase) + 1).map((to) => ({ type: "transition", to })),
    ],
  });

  const cases = [
    ["the drafting window is DERIVED from PHASES, never re-typed (a taxonomy change must flow through)", JSON.stringify([...WORKSPACE_PHASES]) === JSON.stringify(PHASES.slice(PHASES.indexOf("planned"), PHASES.indexOf("done")))],
    ["no record refused", !canAddWorkspace(null, false).ok],
    ["planning-only refused", !canAddWorkspace(mk("planned", "planning-only"), false).ok],
    ["intake refused", !canAddWorkspace(mk("intake"), false).ok],
    ["planned allowed", canAddWorkspace(mk("planned"), false).ok],
    ["executing allowed", canAddWorkspace(mk("executing"), false).ok],
    ["done refused", !canAddWorkspace(mk("done"), false).ok],
    ["existing dir refused", !canAddWorkspace(mk("planned"), true).ok],
    ["forget without a claim refused", !canForgetWorkspace("none").ok],
    ["forget landed allowed", canForgetWorkspace("landed").ok],
    ["forget discard acknowledged allowed", canForgetWorkspace("discard").ok],
    ["workspace sibling derives from the repo's own name, not the harness's", workspaceSiblingPath("/x/clones/my-repo/", "t1") === "../my-repo-task-t1"],
    ["forged transition to an unknown phase is ignored (no fake-phase workspace)", canAddWorkspace({ ...mk("planned"), events: [...mk("planned").events, { type: "transition", to: "shipped" }] }, false).ok],
  ];
  for (const [name, passes] of cases) if (!passes) fail(`task-workspace: ${name}`);

  console.log(failures.length === 0 ? `task-workspace self-test: OK (${cases.length} guard cases — count derived; live jj path prints its own landing law)` : `task-workspace self-test: FAILED\n  ${failures.join("\n  ")}`);
  return failures.length === 0;
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isEntry) {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  const commands = { add: cmdAdd, forget: cmdForget, list: cmdList };
  if (!commands[cmd]) die("usage: task-workspace.mjs <add|forget|list> <task-id> (--self-test to self-test)");
  commands[cmd](args);
}
