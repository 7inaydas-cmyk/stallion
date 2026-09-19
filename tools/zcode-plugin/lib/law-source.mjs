/**
 * Law source — resolve the session repo's OWN vendored harness and import its law.
 *
 * The gate must never carry a second copy of the lifecycle law (two copies drift; that is this
 * repo's founding lesson). Instead it locates the harness that ships inside the repo being
 * edited and imports the very functions the staged gate and the push fence live on:
 * isCodePath / recordRefusal / scopeRefusal / citationRefusal from task-coverage, and
 * PHASES / derivePhase / scopeOf from task-state. Two layouts are known:
 *   stallion shape:   tools/task-coverage.mjs        + tasks/<id>.json
 *   vendored shape:   tools/harness/task-coverage.mjs + docs/harness/task-state/<id>.json
 * Anything else refuses (fail closed): a repo without the harness has no law to enforce, and
 * the refusal says exactly how to get one.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The harness shapes this plugin knows, checked walking upward from the session's cwd. */
const LAYOUTS = [
  { marker: "tools/task-coverage.mjs", harnessDir: "tools", stateDir: "tasks", shape: "stallion" },
  { marker: "tools/harness/task-coverage.mjs", harnessDir: "tools/harness", stateDir: "docs/harness/task-state", shape: "vendored" },
];

/** Pure: which layout (if any) a directory carries. */
export function layoutAt(dir) {
  for (const layout of LAYOUTS) {
    if (existsSync(join(dir, layout.marker))) return { ...layout, root: dir };
  }
  return null;
}

/** Walk upward from startDir to the filesystem root; the first harness-carrying dir wins. */
export function findHarnessRoot(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    const found = layoutAt(dir);
    if (found) return found;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const LAW_EXPORTS = ["isCodePath", "recordRefusal", "scopeRefusal", "citationRefusal"];
const STATE_EXPORTS = ["PHASES", "derivePhase", "scopeOf"];

/**
 * Import the law from a located harness. Returns { ok, ... } — never throws past this seam, so
 * the gate can refuse with a precise message instead of dying to an import error.
 */
export async function loadLaw(layout) {
  if (!layout) return { ok: false, reason: "no harness layout" };
  try {
    const coverage = await import(pathToFileURL(join(layout.root, layout.harnessDir, "task-coverage.mjs")).href);
    const state = await import(pathToFileURL(join(layout.root, layout.harnessDir, "task-state.mjs")).href);
    const missing = [
      ...LAW_EXPORTS.filter((name) => typeof coverage[name] !== "function").map((name) => `task-coverage.mjs:${name}`),
      ...STATE_EXPORTS.filter((name) => state[name] === undefined).map((name) => `task-state.mjs:${name}`),
    ];
    if (missing.length > 0) {
      return { ok: false, reason: `the vendored harness at ${join(layout.root, layout.harnessDir)} does not export: ${missing.join(", ")} — update the vendored copy to the current stallion cut` };
    }
    return { ok: true, coverage, state, stateDir: join(layout.root, layout.stateDir), root: layout.root, shape: layout.shape };
  } catch (e) {
    return { ok: false, reason: `cannot import the vendored harness at ${layout ? join(layout.root, layout.harnessDir) : "(none)"}: ${e.message}` };
  }
}
