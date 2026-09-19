#!/usr/bin/env node
/**
 * Refuse a bare `git commit` made while HEAD is DETACHED.
 *
 * WHY THIS EXISTS — proven, not theorised (2026-08-19, in the harness this guard was vendored
 * from; the incident shape is kept because it IS the argument). With Jujutsu colocated, every jj
 * command that creates or moves the working-copy commit (`jj new`, `jj commit`, `jj squash`)
 * leaves git HEAD detached at a jj-made commit that is not the trunk. A git commit then lands
 * there:
 *
 *     HEAD: <jj's wc commit>   main: <trunk tip>   detached: YES
 *     $ git commit …
 *     HEAD: <your new work>    main: <trunk tip>    <- the commit is NOT on main
 *
 * `git push origin main` afterwards carries nothing. The commit is not lost — it is reachable by
 * SHA until GC — but nothing says so, and the push reports success having pushed none of the
 * work. That is the silent half. A trunk-based repo whose push path is gated gives "committed
 * but not on the trunk" no legitimate resting place.
 *
 * WHAT IT DELIBERATELY DOES NOT BLOCK. Detached HEAD is normal and correct in the middle of
 * several git operations, and a guard that broke `git rebase` would be traded away within a day:
 *
 *   - an interactive or conflicted REBASE (.git/rebase-merge, .git/rebase-apply)
 *   - a CHERRY-PICK or REVERT being resolved (CHERRY_PICK_HEAD, REVERT_HEAD)
 *   - a MERGE being resolved (MERGE_HEAD)
 *   - a BISECT run (BISECT_LOG)
 *
 * In every one of those git put HEAD where it is, on purpose, and a commit is the expected next
 * move. The guard fires only for the case nobody chose: a plain commit onto a detached HEAD.
 *
 * SELF-TEST FIRST. The decision lives in a pure function below — no git, no filesystem, no
 * process — because this is the part with branches worth testing, and a guard whose logic can
 * only be exercised by constructing real repository states is a guard nobody re-tests after
 * changing it.
 *
 * ESCAPE HATCH: ALLOW_DETACHED_HEAD=1. Deliberate, documented, and greppable — the alternative
 * is a guard people route around with --no-verify, which disables every OTHER pre-commit check
 * too (the exact bypass this repo's AGENTS.md forbids outright). One narrow opt-out vs. teaching
 * --no-verify is the whole trade.
 */
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Git operations during which a detached HEAD is expected and a commit is legitimate. */
const IN_PROGRESS_MARKERS = [
  ["rebase-merge", "an interactive/merge rebase"],
  ["rebase-apply", "a rebase (am)"],
  ["CHERRY_PICK_HEAD", "a cherry-pick"],
  ["REVERT_HEAD", "a revert"],
  ["MERGE_HEAD", "a merge"],
  ["BISECT_LOG", "a bisect"],
];

/**
 * The whole decision, as a pure function — no git, no filesystem, no process.
 *
 * Kept separate from the state-reading below because this is the part with branches worth testing,
 * and a guard whose logic can only be exercised by constructing real repository states is a guard
 * nobody re-tests after changing it.
 */
export function detachedHeadVerdict({ detached, operation = null, override = false }) {
  if (override) {
    return { refuse: false, reason: "ALLOW_DETACHED_HEAD=1 — explicitly permitted" };
  }
  if (!detached) {
    return { refuse: false, reason: "HEAD is attached to a branch" };
  }
  if (operation !== null) {
    return { refuse: false, reason: `detached, but ${operation} is in progress — git put HEAD here` };
  }
  return { refuse: true, reason: "a bare commit onto a detached HEAD does not advance any branch" };
}

function gitDir() {
  return execFileSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
}

/** Read the live repository state the verdict needs. */
export function readHeadState() {
  let detached = false;
  try {
    // --symbolic-full-name of HEAD is empty exactly when HEAD is detached. `git branch --show-current`
    // is the friendlier spelling and behaves identically, but is newer than the floor some CI images
    // ship, and this runs on every commit.
    const ref = execFileSync("git", ["symbolic-ref", "--quiet", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    detached = ref === "";
  } catch {
    detached = true; // non-zero exit from symbolic-ref IS the detached signal
  }

  let operation = null;
  if (detached) {
    const dir = gitDir();
    for (const [marker, label] of IN_PROGRESS_MARKERS) {
      if (existsSync(join(dir, marker))) {
        operation = label;
        break;
      }
    }
  }
  return { detached, operation };
}

/** The refusals are the feature: every case is a state where the wrong answer loses work silently. */
export function selfTest() {
  const cases = [
    [{ detached: false }, false, "attached -> allow"],
    [{ detached: false, operation: "a rebase (am)" }, false, "attached during an op -> allow"],
    [{ detached: true }, true, "detached, no operation -> REFUSE"],
    [{ detached: true, operation: null }, true, "explicit null operation -> REFUSE"],
    [{ detached: true, operation: "an interactive/merge rebase" }, false, "detached during a rebase -> allow"],
    [{ detached: true, operation: "a cherry-pick" }, false, "detached during a cherry-pick -> allow"],
    [{ detached: true, operation: "a revert" }, false, "detached during a revert -> allow"],
    [{ detached: true, operation: "a merge" }, false, "detached during a merge -> allow"],
    [{ detached: true, operation: "a bisect" }, false, "detached during a bisect -> allow"],
    [{ detached: true, override: true }, false, "override beats detached -> allow"],
    [{ detached: true, operation: null, override: true }, false, "override beats a refusal -> allow"],
    // The override must not be able to turn an ALLOW into a refusal, and must not depend on order.
    [{ detached: false, override: true }, false, "override on an attached HEAD -> still allow"],
  ];
  let failures = 0;
  for (const [input, expectRefuse, label] of cases) {
    const actual = detachedHeadVerdict(input).refuse;
    if (actual !== expectRefuse) {
      failures += 1;
      console.error(`detached-head-guard SELF-TEST FAIL: ${label} (expected refuse=${expectRefuse}, got ${actual})`);
    }
  }
  console.log(failures === 0 ? `detached-head-guard self-test: OK (${cases.length} cases)` : `detached-head-guard self-test: FAILED (${failures} failure(s))`);
  return failures === 0;
}

/**
 * The live gate. Reads real git state, decides with the pure function, and on refusal prints the
 * incident shape (HEAD vs trunk tip) plus the three legitimate ways out.
 */
function runGuard() {
  const { detached, operation } = readHeadState();
  const override = (process.env.ALLOW_DETACHED_HEAD ?? "") === "1";
  const verdict = detachedHeadVerdict({ detached, operation, override });

  if (!verdict.refuse) {
    process.exit(0);
  }

  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  let branchTip = "";
  try {
    branchTip = execFileSync("git", ["rev-parse", "--short", "main"], { encoding: "utf8" }).trim();
  } catch {
    branchTip = "(no main)";
  }

  process.stderr.write(
    `\n\x1b[31m✖ pre-commit: HEAD is DETACHED — refusing this commit.\x1b[0m\n\n` +
      `  HEAD is at ${head}; main is at ${branchTip}.\n` +
      `  A commit made here advances NO branch. It would not be on main, and a later\n` +
      "  `git push origin main` would report success having pushed none of it.\n\n" +
      "  This is what a colocated Jujutsu working copy leaves behind: `jj new`, `jj commit`\n" +
      "  and `jj squash` all detach git's HEAD.\n\n" +
      "  \x1b[1mPick one:\x1b[0m\n" +
      "    • back to git      \x1b[36mgit checkout main\x1b[0m   then commit as usual\n" +
      `    • stay in jj       \x1b[36mjj commit -m "…"\x1b[0m  or  \x1b[36mjj describe -m "…"\x1b[0m\n` +
      "                       then push through the repo's gated push path — never a bare\n" +
      "                       `jj git push`, which fires none of the git hooks\n" +
      "    • really meant it  \x1b[36mALLOW_DETACHED_HEAD=1 git commit …\x1b[0m\n\n" +
      "  Not blocked: rebase, cherry-pick, revert, merge and bisect — git put HEAD there on\n" +
      "  purpose and a commit is the expected next move.\n\n",
  );
  process.exit(1);
}

/**
 * CLI, guarded by an entry-module check.
 *
 * `process.argv.includes("--self-test")` alone is WRONG here: guards and battery runners IMPORT
 * this module for `detachedHeadVerdict`/`readHeadState`, and a bare argv check fires on IMPORT,
 * `process.exit()`ing before the importer's own self-test can run — a control disabled by the
 * very module added to make controls consistent. Same lesson pathspec carries.
 */
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  if (process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  runGuard();
}
