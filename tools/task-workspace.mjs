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
 *   Never move your trunk bookmark from a workspace. Landing protocol: in the workspace, export
 *   the diff (jj diff --git — the default color-words output is no patch, and a secondary
 *   workspace has no .git for git diff); in the PRIMARY copy, apply it and `git commit` so the
 *   hooks fire; then push through your gated push path, never from the workspace.
 *
 * Pure guard functions are exported and self-tested; the jj shell refuses early if jj is absent
 * (CI has no jj — the guards are still proven there, and the live jj path prints its own law).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRecord } from "./task-coverage.mjs";
import { IMPLEMENTATION_FORBIDDEN as DRAFT_FORBIDDEN, derivePhase, PHASES, TASK_ID } from "./task-state.mjs";

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
 * Pure: the revisions bounding a task's WHOLE draft stack — the fork point between the workspace
 * and the primary copy, to the workspace's working copy (`<name>@`; `<name>@workspace` would be
 * read as a remote bookmark). `-r 'task-<id>@'`, like a bare `jj diff`, is the tip commit alone:
 * a draft split by `jj commit` landed only its tip and still verified. Landing re-applies the
 * patch as a new git commit, so the fork point stays at the draft's base after a correct landing.
 */
export function draftRange(id) {
  return { from: `fork_point(task-${id}@ | @)`, to: `task-${id}@` };
}

/**
 * Pure guard for workspace removal. Forgetting a workspace whose commits never landed orphans
 * them, so the operator says which it is — --landed or --yes-discard-unlanded-work (abandon
 * knowingly); neither flag is exactly the refusal. --landed is CHECKED, never trusted: `landing`
 * is landingCheck's result, and only a HEAD that holds the whole draft stack forgets.
 */
export function canForgetWorkspace(mode, id = "<id>", landing = null) {
  const { from, to } = draftRange(id);
  const law = `jj diff --git --from '${from}' --to '${to}'`;
  if (mode === "discard") return { ok: true };
  if (mode === "landed" && landing?.held === true) return { ok: true };
  if (mode === "landed") {
    return {
      ok: false,
      reason: `refusing to forget workspace 'task-${id}' — the primary copy's HEAD does not hold its whole draft stack, and forgetting unlanded drafts orphans them
  evidence: ${landing?.evidence ?? "no landing check ran"}
  fix: in the PRIMARY copy, ${law} > /tmp/task-${id}.patch && git -C "$(git rev-parse --show-toplevel)" apply --index /tmp/task-${id}.patch && git commit, then, still in the PRIMARY copy, node tools/task-workspace.mjs forget ${id} --landed   (or node tools/task-workspace.mjs forget ${id} --yes-discard-unlanded-work to abandon it knowingly)`,
    };
  }
  return {
    ok: false,
    reason: `refusing to forget workspace 'task-${id}' without a landing claim — forgetting unlanded drafts orphans them
  evidence: the draft stack is ${law}   (run it in the PRIMARY copy to see what would be orphaned)
  fix: in the PRIMARY copy, node tools/task-workspace.mjs forget ${id} --landed   (checks that HEAD holds that whole stack, and refuses unless it does), or node tools/task-workspace.mjs forget ${id} --yes-discard-unlanded-work   (to abandon it knowingly)`,
  };
}

/**
 * Does the primary copy's HEAD hold the task's whole draft stack? The check `forget --landed` RUNS
 * (it used to print one and trust the flag). It snapshots the workspace first — the primary copy
 * sees only its last snapshot, so edits made after the workspace's last jj command were invisible —
 * then reverse-applies the draftRange patch against HEAD's tree in a scratch index: not the working
 * tree (an applied but uncommitted patch is not landed), and at `root`, never the caller's cwd
 * (git apply in a subdirectory skips every path outside it and exits 0). Run from the workspace's
 * own copy, `@` IS `task-<id>@`: the range was empty, the forget passed over unlanded drafts —
 * a tip at or below `@` refuses before the empty-stack pass can read it as nothing to land.
 */
export function landingCheck(id, root = ROOT, env = process.env) {
  const scratch = mkdtempSync(join(tmpdir(), "task-workspace-landing-"));
  const run = (cmd, args, cwd, extra = {}) => execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: "pipe", ...extra });
  try {
    const workspace = join(root, workspaceSiblingPath(root, id));
    if (existsSync(workspace)) run("jj", ["status"], workspace);
    const { from, to } = draftRange(id);
    if (run("jj", ["log", "--no-graph", "-r", `${to} & ::@`, "-T", "commit_id"], root).trim() !== "") {
      return { held: false, evidence: `${to} is the working copy the check runs in, or its ancestor — ${from}..${to} is empty by construction and checks nothing; run forget in the PRIMARY copy, never from the task's own workspace` };
    }
    const patch = run("jj", ["diff", "--git", "--from", from, "--to", to], root);
    if (patch.trim() === "") return { held: true, evidence: `the draft stack ${from}..${to} is empty — nothing to land` };
    const index = { ...env, GIT_INDEX_FILE: join(scratch, "index") };
    run("git", ["read-tree", "HEAD"], root, { env: index });
    run("git", ["apply", "--check", "--reverse", "--cached"], root, { env: index, input: patch });
    return { held: true, evidence: `HEAD holds ${from}..${to}` };
  } catch (e) {
    return { held: false, evidence: String(e.stderr || e.message).trim() };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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

/** A task's record as the workspace commands read it: { record }, or { error } naming why none,
 *  with its fix. Read through the fence's loadRecord law: a copied record (its id not the task
 *  its file names) carries another task's phase and scope, and opens or forgets nothing. A
 *  missing id is task-state's own "no such task": the fence's new-then-advance fix would send a
 *  typo (or a forget cleaning up) to mint a phantom task in flight (a review finding). */
function readTask(id, dir = STATE_DIR) {
  if (!existsSync(`${dir}/${id}.json`)) return { error: `no such task: ${id} (expected ${dir}/${id}.json)\n  fix: node tools/task-state.mjs status   — lists every recorded task (or correct the id)` };
  const { record, error, fix } = loadRecord(id, dir);
  if (error) return { error: `${error}\n  fix: ${fix}` };
  if (record.schema !== "stallion/task-state@1") return { error: `task record has unknown schema: ${String(record.schema)}` };
  return { record };
}

function loadTask(id) {
  if (!TASK_ID.test(id)) die(`task id must be kebab-case (a-z, 0-9, -): ${id} — a traversal-bearing id must never reach a path join`);
  const { record, error } = readTask(id);
  if (error) die(error);
  return record;
}

const LANDING_LAW = `
LANDING LAW (colocated jujutsu — this is the reason the tool exists):
  jj-native commits DO NOT run the git pre-commit hooks. Draft here; LAND in the primary copy:
    1. in this workspace:  jj status   (snapshots your last edits — the primary copy sees only a snapshot)
    2. in the PRIMARY copy: jj diff --git --from '${draftRange("<id>").from}' --to '${draftRange("<id>").to}' > /tmp/task-<id>.patch
       (the WHOLE draft stack — a bare 'jj diff' exports the tip commit alone)
    3. in the PRIMARY copy: git -C "$(git rev-parse --show-toplevel)" apply --index /tmp/task-<id>.patch, then 'git commit' — hooks fire, markers checked
    4. push only from the primary working copy, through your gated push path
    5. in the PRIMARY copy: node tools/task-workspace.mjs forget <id> --landed — re-runs step 2's range against HEAD, refuses unless HEAD holds it
  Never 'jj bookmark set' or push your trunk bookmark from a workspace.`;

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
  console.log(LANDING_LAW.replaceAll("<id>", id));
}

function cmdForget(args) {
  const id = args._[0];
  if (!id) die("usage: forget <task-id> --landed | --yes-discard-unlanded-work");
  loadTask(id); // the task must exist even to clean up its workspace
  const listing = jjOut("workspace", "list");
  if (!listing.includes(`task-${id}`)) die(`no workspace named 'task-${id}' — nothing to forget (${listing.split("\n").length} workspace(s) listed)`);
  const mode = args.landed === true ? "landed" : args["yes-discard-unlanded-work"] === true ? "discard" : "none";
  const guard = canForgetWorkspace(mode, id, mode === "landed" ? landingCheck(id) : null);
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

/** The git-hook env shapes the live cases re-run inside, each naming a throwaway HOST: a linked
 *  worktree's hook gets GIT_DIR and GIT_INDEX_FILE, a main-worktree `commit -a` hook gets
 *  GIT_INDEX_FILE alone (the commonest real shape — a fixture `git add` then stages into it). */
const HOOK_SHAPES = [
  ["a linked worktree's hook (GIT_DIR + GIT_INDEX_FILE)", (host) => ({ GIT_DIR: join(host, "git"), GIT_INDEX_FILE: join(host, "index") })],
  ["commit -a's hook (GIT_INDEX_FILE alone)", (host) => ({ GIT_INDEX_FILE: join(host, "index") })],
];

/** Run fn with `vars` set in process.env — where a hook's env reaches every child — then restore it. */
function withProcessEnv(vars, fn) {
  const saved = Object.keys(vars).map((k) => [k, process.env[k]]);
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The live cases re-run inside each HOOK_SHAPES env, one row per shape (the Antitube wave-4
 *  finding: a vendor's pre-commit runs this self-test, and a fixture inheriting the hook's GIT_*
 *  inits, stages and commits into the host). Every landing verdict must still hold there — a
 *  fixture command that leaked fails against the host, and a crash is a failed row — and the host
 *  must stay empty. Their verdicts were once thrown away: a leak past `git init` passed as clean. */
function hostHookCases() {
  return HOOK_SHAPES.map(([shape, envOf]) => {
    const host = mkdtempSync(join(tmpdir(), "task-workspace-host-"));
    try {
      const rows = withProcessEnv(envOf(host), liveLandingCases) ?? [["jj vanished between runs", false]];
      const failed = rows.filter(([, passes]) => !passes).map(([name]) => name);
      const wrote = readdirSync(host);
      return [`a live landing case run inside a git hook wrote into the HOST repo or failed there — ${shape}: ${[...failed, ...wrote.map((f) => `host gained ${f}`)].join("; ")}`, failed.length === 0 && wrote.length === 0];
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  });
}

const FIXTURE_WHO = { GIT_AUTHOR_NAME: "self-test", GIT_AUTHOR_EMAIL: "self-test@example.invalid", GIT_COMMITTER_NAME: "self-test", GIT_COMMITTER_EMAIL: "self-test@example.invalid", JJ_USER: "self-test", JJ_EMAIL: "self-test@example.invalid" };

/** The fixture's env, pure: the caller's minus every GIT_* — inside a git hook GIT_DIR and
 *  GIT_INDEX_FILE name the HOST repo, and a fixture inheriting them inits, stages and commits into
 *  it (the Antitube wave-4 finding) — plus the fixture's own identity and empty configs. */
function fixtureEnv(env, base) {
  const hostless = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("GIT_")));
  return { ...hostless, ...FIXTURE_WHO, JJ_CONFIG: join(base, "jj.toml"), GIT_CONFIG_GLOBAL: join(base, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
}

/**
 * The landing check against REAL jj and git — the refusal text alone was pinned as a string, and
 * its promise was false in three ordinary workflows. A two-commit draft landed tip-only, an
 * applied-but-uncommitted stack, and an edit made after the workspace's last jj command must all
 * refuse; the whole stack committed must pass. Driven from a subdirectory, where git apply skips
 * every path outside it. Returns null when jj is absent (CI) — the OK line says so, never silently.
 */
function liveLandingCases() {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" });
  } catch {
    return null;
  }
  const base = mkdtempSync(join(tmpdir(), "task-workspace-live-"));
  const cwd = process.cwd();
  const primary = join(base, "primary");
  const ws = join(base, "primary-task-t1");
  const env = fixtureEnv(process.env, base);
  const sh = (dir, cmd, ...args) => execFileSync(cmd, args, { cwd: dir, env, stdio: "pipe" });
  const put = (path, text) => writeFileSync(path, text);
  try {
    put(env.JJ_CONFIG, "");
    put(env.GIT_CONFIG_GLOBAL, "");
    mkdirSync(join(primary, "sub"), { recursive: true });
    put(join(primary, "f.txt"), "base\n");
    put(join(primary, "sub", "keep.txt"), "keep\n");
    sh(base, "git", "init", "-q", "-b", "main", primary);
    sh(primary, "git", "add", "-A");
    sh(primary, "git", "commit", "-qm", "base");
    sh(primary, "jj", "git", "init", "--colocate");
    sh(primary, "jj", "workspace", "add", "--name", "task-t1", ws);
    put(join(ws, "a.txt"), "part one\n");
    sh(ws, "jj", "commit", "-m", "part one");
    put(join(ws, "b.txt"), "part two\n"); // never snapshotted by hand: the check's own snapshot must see it
    process.chdir(join(primary, "sub"));
    const held = () => landingCheck("t1", primary, env).held;
    put(join(primary, "b.txt"), "part two\n");
    sh(primary, "git", "add", "b.txt");
    sh(primary, "git", "commit", "-qm", "tip only");
    const tipOnly = held();
    put(join(primary, "a.txt"), "part one\n");
    const uncommitted = held();
    sh(primary, "git", "add", "a.txt");
    sh(primary, "git", "commit", "-qm", "the rest");
    const whole = held();
    put(join(ws, "b.txt"), "part two\nlate edit\n");
    const late = held();
    const inside = landingCheck("t1", ws, env); // the tool's own copy in the workspace: there @ IS task-t1@
    sh(primary, "jj", "workspace", "add", "--name", "task-t2", join(base, "primary-task-t2"));
    const untouched = landingCheck("t2", primary, env).held;
    return [
      ["live jj: a two-commit draft landed tip-only refuses — the check covers the whole stack, run from a subdirectory", tipOnly === false],
      ["live jj: a stack applied to the working tree but never committed refuses — HEAD, not the working tree, must hold it", uncommitted === false],
      ["live jj: the whole stack committed in the primary copy passes", whole === true],
      ["live jj: an edit made after the workspace's last jj command refuses — the check snapshots the workspace first", late === false],
      ["live jj: forget --landed run from INSIDE the workspace refuses, naming the PRIMARY copy — there @ is the draft tip, so the range is empty by construction", inside.held === false && inside.evidence.includes("PRIMARY copy")],
      ["live jj: a workspace with no drafts forgets from the primary copy — its range is genuinely empty, nothing is orphaned", untouched === true],
    ];
  } catch (e) {
    return [[`live jj: the fixture repo builds (${String(e.stderr || e.message).trim().split("\n")[0]})`, false]];
  } finally {
    process.chdir(cwd);
    rmSync(base, { recursive: true, force: true });
  }
}

/** The live rows the self-test judges and the OK line's note on them, both derived from what ran:
 *  the landing cases, their re-runs inside every git-hook shape (a pin that stopped re-running
 *  once left the OK line unchanged — a review finding), or the SKIP when jj is absent. */
function selfTestLiveRows() {
  const live = liveLandingCases();
  if (live === null) return { rows: [], note: "live jj landing cases and their git-hook re-runs SKIPPED — jj is not on PATH" };
  const hook = hostHookCases();
  const reran = ["jj is on PATH, so the live cases re-ran inside every git-hook shape", hook.length === HOOK_SHAPES.length];
  return { rows: [...live, ...hook, reran], note: `${live.length} live jj landing cases, re-run inside ${hook.length} git-hook shapes` };
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
    ["forget --landed allowed once the landing check finds HEAD holds the whole stack", canForgetWorkspace("landed", "t1", { held: true, evidence: "HEAD holds it" }).ok],
    ["a --landed refusal carries the landing check's evidence", canForgetWorkspace("landed", "t1", { held: false, evidence: "error: a.txt: does not exist in index" }).reason?.includes("evidence: error: a.txt: does not exist in index") === true],
    ["forget discard acknowledged allowed", canForgetWorkspace("discard").ok],
    ["the forget refusal's verify command names the real workspace revision (task-t1@, never <name>@workspace or a hard-coded master) and its whole stack", (() => {
      const { reason } = canForgetWorkspace("none", "t1");
      return reason.includes("jj diff --git --from 'fork_point(task-t1@ | @)' --to 'task-t1@'") && !reason.includes("@workspace") && !reason.includes("master");
    })()],
    ["the landing law exports a patch git apply accepts (jj diff --git; a secondary workspace has no .git for git diff)", LANDING_LAW.includes("jj diff --git --from") && !LANDING_LAW.includes("git diff)")],
    ["forget --landed refuses when the landing check finds the draft not held — the claim is checked, never trusted", !canForgetWorkspace("landed", "t1", { held: false, evidence: "error: a.txt: patch does not apply" }).ok],
    ["the landing law's export covers the WHOLE draft stack (fork point to task-<id>@), never the tip commit alone", LANDING_LAW.includes("jj diff --git --from 'fork_point(task-<id>@ | @)' --to 'task-<id>@' > /tmp/task-<id>.patch") && !LANDING_LAW.includes("jj diff --git >")],
    ["the landing law applies the patch at the repo root and into the index — git apply in a subdirectory skips every path outside it, and an unstaged apply commits nothing", LANDING_LAW.includes(`git -C "$(git rev-parse --show-toplevel)" apply --index /tmp/task-<id>.patch`)],
    ["the landing law and both forget refusals say forget runs in the PRIMARY copy — from the workspace itself the range is empty by construction", (() => {
      const said = [
        [LANDING_LAW, "5. in the PRIMARY copy: node tools/task-workspace.mjs forget <id> --landed"],
        [canForgetWorkspace("landed", "t1", { held: false, evidence: "x" }).reason, "still in the PRIMARY copy, node tools/task-workspace.mjs forget t1 --landed"],
        [canForgetWorkspace("none", "t1").reason, "fix: in the PRIMARY copy, node tools/task-workspace.mjs forget t1 --landed"],
      ];
      return said.every(([text, clause]) => text.includes(clause));
    })()],
    ["workspace sibling derives from the repo's own name, not the harness's", workspaceSiblingPath("/x/clones/my-repo/", "t1") === "../my-repo-task-t1"],
    ["forged transition to an unknown phase is ignored (no fake-phase workspace)", canAddWorkspace({ ...mk("planned"), events: [...mk("planned").events, { type: "transition", to: "shipped" }] }, false).ok],
    ["a copied record (its id not the task its file names) opens and forgets no workspace, and the refusal prints task-state's rm-then-new exit", (() => {
      const dir = mkdtempSync(join(tmpdir(), "task-workspace-copy-"));
      try {
        writeFileSync(join(dir, "t.json"), JSON.stringify(mk("executing")));
        writeFileSync(join(dir, "copy.json"), JSON.stringify(mk("executing")));
        const copy = readTask("copy", dir);
        return readTask("t", dir).record?.id === "t" && copy.record === undefined && String(copy.error).includes("rm tasks/copy.json && node tools/task-state.mjs new copy");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })()],
    ["a missing task id refuses with task-state's status exit (a typo, or forget cleaning up), never a new-then-advance chain to executing", (() => {
      const dir = mkdtempSync(join(tmpdir(), "task-workspace-missing-"));
      try {
        const { record, error } = readTask("nope", dir);
        return record === undefined && String(error).includes("fix: node tools/task-state.mjs status") && !String(error).includes("advance nope executing");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })()],
    ["the fixture env drops every inherited GIT_* — inside a git hook they name the HOST repo (pure, so a run without jj pins it too)", (() => {
      const env = fixtureEnv({ PATH: "/bin", GIT_DIR: "/host/.git", GIT_INDEX_FILE: "/host/.git/index.lock", GIT_WORK_TREE: "/host", GIT_CONFIG_GLOBAL: "/host/gitconfig" }, "/b");
      return env.PATH === "/bin" && !["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"].some((k) => k in env) && env.GIT_CONFIG_GLOBAL === join("/b", "gitconfig");
    })()],
  ];
  const live = selfTestLiveRows();
  for (const [name, passes] of [...cases, ...live.rows]) if (!passes) fail(`task-workspace: ${name}`);
  console.log(failures.length === 0 ? `task-workspace self-test: OK (${cases.length} guard cases, ${live.note} — count derived)` : `task-workspace self-test: FAILED\n  ${failures.join("\n  ")}`);
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
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  const commands = { add: cmdAdd, forget: cmdForget, list: cmdList };
  if (!commands[cmd]) die("usage: task-workspace.mjs <add|forget|list> <task-id> (--self-test to self-test)");
  commands[cmd](args);
}
