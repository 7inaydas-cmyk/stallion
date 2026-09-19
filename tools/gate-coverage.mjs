#!/usr/bin/env node
/**
 * GATE COVERAGE CENSUS — every tracked source file must be visible to at least one declared gate.
 *
 * WHY THIS EXISTS (ported from the Antitube harness's tools/harness/gate-coverage.mjs,
 * 2026-09-19). The recurring failure is not a broken gate — it is a HEALTHY gate nobody pointed
 * at the code. In the source harness on 2026-08-12, three of six dead controls had exactly that
 * shape: `biome` did not lint `tools/**` — 52 files, including a gate and the §6 fence itself;
 * `knip` could not see any `packages/*` export; a path class globbed `apps/web/src/**` while the
 * defect lived in `apps/web/public/**`; and earlier `sw.js` sat outside every static gate until
 * it caused an incident. In every case the gate was green and the answer was "nobody asked it
 * about that file." Generalized, that is the law here: REACH IS A PROPERTY YOU CHECK, NOT ONE
 * YOU ASSUME. A file added to a directory no gate names is invisible from birth, and invisible
 * files can be wrong forever.
 *
 * WHAT COUNTS AS COVERED is deliberately poorer than Antitube's biome/tsc — stallion has no
 * linter and no typechecker. The gates that actually see this repo's files are the harness's
 * own: the selftest battery (which runs every tools/**\/*.mjs dispatcher and whose membership is
 * derived from the tree by task-coverage's doctor), and the push fence (which counts .githooks/**
 * and .github/workflows/** as code). Those claims live WHERE THEY CAN BE FALSIFIED —
 * docs/gates/coverage.json — not inline in this file. In Antitube the reach globs sat inline
 * next to the matcher, so editing the repo's gates never edited the census's map of them; here
 * the map is config, and this tool FAILS CLOSED on a missing, unparseable, or wrongly-shaped
 * map: a census that cannot read its map covers nothing, vacuously, and must not pass.
 *
 * MODE: fast only. Antitube had --strict, which ran tsc/biome for real to catch the fast
 * matcher's drift; stallion has no such tools to ask, and whether the two gates above are WIRED
 * is task-coverage --doctor's job, not this census's. One mode, one claim of reach, no drift
 * between two descriptions of the same thing.
 *
 * --self-test proves the loader fails closed and the matcher discriminates, against FIXTURE
 * configs in a temp dir — never the live docs/gates/coverage.json, which this repo edits and a
 * self-test must not depend on (the original held the same discipline: it tested the matcher's
 * own constants, never the repo's live gate list).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { firstMatch, matches } from "./pathspec.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CONFIG_PATH = fileURLToPath(new URL("../docs/gates/coverage.json", import.meta.url));

/** Tracked-file extensions this census walks. Hook scripts carry no extension at all and the CI
 *  workflow is YAML, yet both ARE code in this repo's own law (task-coverage's isCodePath: "the
 *  committed hooks ARE the fence") — an extension filter alone would make the fence's own
 *  transport invisible to the census, the 2026-08-12 lesson in miniature. */
const SOURCE_RE = /\.(ts|tsx|mjs|cjs|js)$/;
const HOOKS_PREFIX = ".githooks/";
const WORKFLOW_RE = /^\.github\/workflows\/.*\.(yml|yaml)$/;

/** Pure: does a tracked path count as a source file the census must place under a gate? */
export function isSource(path) {
  return path.startsWith(HOOKS_PREFIX) || WORKFLOW_RE.test(path) || SOURCE_RE.test(path);
}

/** A string-or-array-of-strings field, normalized to a validated array; null = malformed. */
function globList(value) {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0 || list.some((s) => typeof s !== "string" || s.length === 0)) return null;
  return list;
}

/**
 * Load + validate the reach map. Every refusal is a string naming the PATH with a fix line —
 * fail closed: a missing map, an unparseable map, or a map shaped almost like a map (a typo'd
 * key this loader would silently ignore is how a real map goes vacant) covers NOTHING.
 */
export function loadConfig(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {
      error:
        `the gate map is missing or unreadable: ${path}\n` +
        `  rule: a census that cannot read its map must not pass\n` +
        `  fix: restore ${path}, or recreate it — shape: {"gates":[{"name":"...","spec":"tools/**","sees":"what actually runs"}],"exempt":[{"spec":"...","why":"..."}]}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      error:
        `the gate map at ${path} is not valid JSON: ${e.message}\n` +
        `  fix: repair ${path} — the parse error above names the position`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: `the gate map at ${path} must be a JSON object\n  fix: {"gates":[...],"exempt":[...]}` };
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "$comment" && key !== "gates" && key !== "exempt") {
      return { error: `unknown key '${key}' in ${path} (known: gates, exempt, $comment) — a key the loader ignores is how a real map goes vacant\n  fix: remove or rename it in ${path}` };
    }
  }
  if (!Array.isArray(parsed.gates) || parsed.gates.length === 0) {
    return { error: `${path} declares no gates — an empty gate list makes the census vacuous\n  fix: add at least one {"name","spec","sees"} gate` };
  }
  const gates = [];
  const names = new Set();
  for (const [i, g] of parsed.gates.entries()) {
    const where = `${path} gates[${i}]`;
    if (g === null || typeof g !== "object" || Array.isArray(g)) return { error: `${where} must be an object` };
    for (const key of Object.keys(g)) {
      if (key !== "name" && key !== "spec" && key !== "sees" && key !== "exclude") {
        return { error: `${where} carries unknown key '${key}' (known: name, spec, sees, exclude)` };
      }
    }
    if (typeof g.name !== "string" || g.name.length === 0) return { error: `${where} needs a non-empty "name"` };
    if (names.has(g.name)) return { error: `${where}: duplicate gate name '${g.name}' — refusals name gates; an ambiguous name is drift` };
    names.add(g.name);
    if (typeof g.sees !== "string" || g.sees.length === 0) {
      return { error: `${where} ('${g.name}') needs a non-empty "sees" — the statement of what actually runs is what keeps a name+spec pair from being a fake gate` };
    }
    const specs = globList(g.spec);
    if (specs === null) return { error: `${where} ('${g.name}') needs "spec": a non-empty glob string or array of them, in the pathspec dialect (tools/**, tools/**/*.mjs)` };
    const exclude = g.exclude === undefined ? [] : globList(g.exclude);
    if (exclude === null) return { error: `${where} ('${g.name}') "exclude" must be a non-empty glob string or array of them` };
    gates.push({ name: g.name, sees: g.sees, specs, exclude });
  }
  const exempt = parsed.exempt === undefined ? [] : parsed.exempt;
  if (!Array.isArray(exempt)) return { error: `"exempt" in ${path} must be an array of {"spec","why"} entries` };
  for (const [i, e] of exempt.entries()) {
    const where = `${path} exempt[${i}]`;
    if (e === null || typeof e !== "object" || Array.isArray(e)) return { error: `${where} must be an object` };
    for (const key of Object.keys(e)) {
      if (key !== "spec" && key !== "why") return { error: `${where} carries unknown key '${key}' (known: spec, why)` };
    }
    if (typeof e.spec !== "string" || e.spec.length === 0) return { error: `${where} needs a non-empty "spec"` };
    if (typeof e.why !== "string" || e.why.length === 0) {
      return { error: `${where} needs a "why" — an exemption without a reason is "it is inconvenient", which is not one` };
    }
  }
  return { config: { gates, exempt } };
}

/** Pure: the first gate whose spec is pointed at this file (excludes subtract reach), or null.
 *  First hit wins so a refusal can NAME the gate — or name its absence. */
export function gateThatSees(config, file) {
  for (const gate of config.gates ?? []) {
    if (!gate.specs.some((s) => matches(file, s))) continue;
    if (gate.exclude.some((s) => matches(file, s))) continue;
    return gate;
  }
  return null;
}

/** Pure: the reason a file is deliberately outside every gate, or null. firstMatch over
 *  {spec, why} entries is exactly the pathspec entry shape — the reason travels with the hit. */
export function exemptReason(config, file) {
  const hit = firstMatch(file, config.exempt ?? []);
  return hit ? hit.why : null;
}

/**
 * Pure: the census over a file list. Exemptions are counted as FILES MATCHED, not entries — a
 * spec that matches nothing exempts nothing, and the summary's "N exempt" must mean N files.
 * gateHits feeds the dead-gate warning: a gate whose specs match no tracked source file is
 * config rot that over-claims the map.
 */
export function census(config, files) {
  const orphans = [];
  const exemptions = [];
  const gateHits = new Map((config.gates ?? []).map((g) => [g.name, 0]));
  for (const file of files ?? []) {
    const why = exemptReason(config, file);
    if (why !== null) {
      exemptions.push({ file, why });
      continue;
    }
    const gate = gateThatSees(config, file);
    if (gate) gateHits.set(gate.name, gateHits.get(gate.name) + 1);
    else orphans.push(file);
  }
  return { orphans, exemptions, gateHits };
}

/** The tracked file list this census walks. A git failure is NOT an empty repo — fail closed. */
function trackedSources() {
  let out;
  try {
    out = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    console.error(`gate-coverage: cannot list tracked files — git ls-files failed (${String(e.message).split("\n")[0]})`);
    console.error(`  rule: a census that cannot read the file list must not pass`);
    console.error(`  fix: run from a git checkout of this repo (or repair git here), then retry`);
    process.exit(1);
  }
  return out
    .split("\n")
    .filter(Boolean)
    .filter(isSource)
    .filter((f) => !f.includes("node_modules/") && !f.includes("/dist/"));
}

/**
 * Self-test: fixture configs in a temp dir, never the live map. The refusals are the feature —
 * every fail-closed arm of the loader, and both directions of the matcher: a census that
 * answers "covered" for everything certifies a hole.
 */
export function selfTest() {
  const failures = [];
  let checks = 0;
  const ok = (cond, msg) => {
    checks += 1;
    if (!cond) failures.push(msg);
  };
  const dir = mkdtempSync(join(tmpdir(), "gate-coverage-"));
  try {
    const write = (name, body) => {
      const p = join(dir, name);
      writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
      return p;
    };

    // The loader fails closed, NAMING THE PATH — the config seam is this port's new surface.
    const missingP = join(dir, "absent.json");
    const missing = loadConfig(missingP);
    ok(missing.error !== undefined, "a missing config must fail closed");
    ok(missing.error?.includes(missingP) ?? false, "the missing-config refusal must name the path");
    const brokenP = write("broken.json", "{ not json ]");
    const broken = loadConfig(brokenP);
    ok(broken.error !== undefined, "an unparseable config must fail closed");
    ok(broken.error?.includes(brokenP) ?? false, "the unparseable-config refusal must name the path");

    const badShapes = [
      ["top level must be an object", "[]"],
      ["an empty gates list is a vacuous census", { gates: [] }],
      ["gate without a name", { gates: [{ spec: "a/**", sees: "x" }] }],
      ["gate without a spec", { gates: [{ name: "g", sees: "x" }] }],
      ["gate with an empty spec array", { gates: [{ name: "g", spec: [], sees: "x" }] }],
      ["gate without 'sees' (a name+spec pair is not a gate)", { gates: [{ name: "g", spec: "a/**" }] }],
      ["duplicate gate names", { gates: [{ name: "g", spec: "a/**", sees: "x" }, { name: "g", spec: "b/**", sees: "y" }] }],
      ["exempt entry without a why", { gates: [{ name: "g", spec: "a/**", sees: "x" }], exempt: [{ spec: "a/b.js" }] }],
      ["a typo'd top-level key is refused, not ignored", { gates: [{ name: "g", spec: "a/**", sees: "x" }], exlude: [] }],
    ];
    for (const [name, body] of badShapes) {
      ok(loadConfig(write("shape.json", body)).error !== undefined, `shape refusal missing: ${name}`);
    }

    // The good fixture: discrimination, both directions.
    const goodP = write("good.json", {
      gates: [
        { name: "battery", spec: "tools/**/*.mjs", sees: "fixture: the battery" },
        { name: "fence", spec: [".githooks/**", ".github/workflows/**"], exclude: ["**/*.tmpl"], sees: "fixture: the fence" },
      ],
      exempt: [{ spec: "vendor/legacy.js", why: "vendored, frozen upstream — changes go upstream" }],
    });
    const { config, error } = loadConfig(goodP);
    ok(error === undefined, `the good fixture must load (got: ${String(error).split("\n")[0]})`);
    if (config) {
      const seen = [
        ["tools/task-state.mjs", true, "battery, ** spans zero segments"],
        ["tools/bench/grade.mjs", true, "battery, nested"],
        ["tools/zcode-plugin/lib/gate-law.mjs", true, "battery, deep"],
        [".githooks/pre-push", true, "fence, the hook tree"],
        [".github/workflows/selftest.yml", true, "fence, the workflow tree"],
        ["scripts/deploy-thing.mjs", false, "the classic orphan: a script dir no gate names"],
        ["tools/helper.ts", false, "the battery's spec is .mjs-only — narrowness stated, not widened"],
        [".githooks/pre-push.tmpl", false, "a gate's exclude subtracts its reach"],
        ["apps/web/src/x.ts", false, "a tree this fixture has no gate for"],
      ];
      for (const [file, expected, why] of seen) {
        const got = gateThatSees(config, file) !== null;
        ok(got === expected, `discrimination: ${why} — ${file} expected covered=${expected} got=${got}`);
      }
      ok(gateThatSees(config, "tools/task-state.mjs")?.name === "battery", "the matching gate must be reportable by name");
      ok(exemptReason(config, "vendor/legacy.js") === "vendored, frozen upstream — changes go upstream", "an exemption must surface its reason");
      ok(exemptReason(config, "tools/task-state.mjs") === null, "a covered file is not an exempt file");

      // Counting: "1 exempt" must mean one FILE, and per-gate hits feed the dead-gate warning.
      const c = census(config, ["tools/a.mjs", "tools/b/c.mjs", "vendor/legacy.js", "scripts/x.mjs"]);
      ok(c.orphans.join(",") === "scripts/x.mjs", `census must name exactly the orphan (got ${c.orphans})`);
      ok(c.exemptions.length === 1 && c.exemptions[0]?.file === "vendor/legacy.js", "census counts exempted FILES, not entries");
      const clean = census(config, ["tools/a.mjs", ".githooks/pre-commit", ".github/workflows/ci.yml"]);
      ok(clean.orphans.length === 0 && clean.exemptions.length === 0, "a fully-covered list must census clean");
      ok(clean.gateHits.get("battery") === 1 && clean.gateHits.get("fence") === 2, "per-gate hit counts must be attributable");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (failures.length > 0) for (const f of failures) console.error(`gate-coverage SELF-TEST FAIL: ${f}`);
  console.log(failures.length === 0 ? `gate-coverage self-test: OK (${checks} checks)` : "gate-coverage self-test: FAILED");
  return failures.length === 0;
}

function main(argv) {
  if (argv.includes("--self-test")) return selfTest() ? 0 : 1;
  if (argv.length > 0) {
    console.error(`gate-coverage: unknown argument(s): ${argv.join(" ")} — usage: node tools/gate-coverage.mjs [--self-test]`);
    return 1;
  }

  const { config, error } = loadConfig(CONFIG_PATH);
  if (error) {
    console.error(`gate-coverage: ✖ ${error}`);
    return 1;
  }

  const files = trackedSources();
  const { orphans, exemptions, gateHits } = census(config, files);

  console.log(`gate-coverage — ${files.length} tracked source file(s), ${exemptions.length} exempt, mode=fast.`);
  for (const e of exemptions) console.log(`  ~ exempt: ${e.file} — ${e.why}`);
  for (const g of config.gates) {
    if ((gateHits.get(g.name) ?? 0) === 0) {
      console.log(`  ~ gate '${g.name}' matches no tracked source file — dead entry, wrong tree, or the tree it names is gone`);
    }
  }

  if (orphans.length > 0) {
    console.error(`\n✖ ${orphans.length} source file(s) are visible to NO declared gate:`);
    for (const o of orphans) console.error(`  ✖ ${o}`);
    console.error(
      `\nEvery tracked source file must sit inside some gate's spec. A gate that is healthy but not\n` +
        `POINTED at the code is the recurring failure (2026-08-12: a linter that did not lint tools/**,\n` +
        `a knip that saw no packages/* export, a sw.js outside every gate).\n` +
        `  fix: add the tree to a gate's "spec" in ${CONFIG_PATH} — or, if the file genuinely belongs\n` +
        `        outside every gate, add an "exempt" entry there WITH a REASON.`,
    );
    return 1;
  }
  console.log("gate-coverage — every tracked source file is seen by at least one gate in docs/gates/coverage.json.");
  return 0;
}

/**
 * CLI, guarded by an entry-module check (the pathspec lesson, verbatim): this module exports
 * census primitives for import by other tools, and a bare argv scan would fire — and
 * process.exit — on import, disabling the importer's own --self-test. Importers call
 * selfTest()/census()/loadConfig() directly.
 */
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) process.exit(main(process.argv.slice(2)));
