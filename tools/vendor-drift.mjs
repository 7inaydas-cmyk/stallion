#!/usr/bin/env node
/**
 * VENDOR-DRIFT — the vendoring lineage gate. A vendored harness tree carries a manifest naming
 * its upstream stallion commit and the sha256 of every vendored file; this gate refuses silent
 * divergence in either direction.
 *
 * WHY THIS EXISTS (the 2026-09-20 evaluation, gap 3, 24/24 claims fact-checked): the vendored
 * tree in the target repo had NO provenance marker — static 0.1.0 stamps compared by nothing —
 * so a vendor could not recall which stallion wave it descended from, and WIRING.md's
 * "superseded by re-vendoring, not by patching" was prose with no tool behind it. Two trees
 * that cannot state their relationship drift silently until a refusal in one names a path that
 * no longer exists in the other.
 *
 * THE MANIFEST (committed by the vendor at tools/harness/VENDOR.json):
 *   schema    "stallion/vendor-manifest@1"
 *   upstream  the 40-hex stallion commit the tree descends from
 *   vendored  the corpus DIRECTORY (e.g. "tools/harness") — every file beneath it, the manifest
 *             itself excepted, must be declared
 *   files     host path → { source: the upstream path, sha256: digest of the VENDORED bytes,
 *             adapted: whether grafts were applied }. The digest is of the bytes as they stand
 *             in the host, so an honest re-vendor regenerates it and a local patch trips it.
 *   docs      upstream law-doc path → the host path carrying it, so refusal remedies name paths
 *             that exist in the host (the "remedies point at docs/decisions which does not
 *             exist here" lesson).
 *
 * MODES. Bare (host): the manifest is law — a missing manifest, a bad shape, a corpus the
 * executing gate does not live in (born-scoped), an undeclared file under the corpus, a patched
 * or deleted vendored file, or a mapped doc that does not exist each refuse with a re-vendor
 * remedy. A deleted manifest is NOT an escape: bare mode fails closed on absence. `--upstream`:
 * for stallion's own battery — asserts this tree carries no vendor manifest anywhere (default
 * path plus a tracked-file sweep), because stallion does not vendor itself and a manifest here
 * would be a forged provenance marker. `--freshness <path>`: wave-intake law — points at a local
 * clone of the upstream repo and answers "has upstream moved past our pin, and did anything
 * VENDORED move with it"; a moved vendored source owes a re-vendor before the wave proceeds,
 * an upstream that moved only its own task registers owes nothing. `--manifest <path>` overrides
 * the location for every mode.
 *
 * HONEST LIMIT (the lane-1 finding): `upstream` is recorded provenance, verified by shape only —
 * a host without stallion's git history cannot machine-check the sha offline. Every refusal
 * prints it so a human re-checks it against the stallion remote at re-vendor time; the corpus
 * anchor (the gate must ship in the tree it polices) is the part that IS machine-checked.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_MANIFEST = "tools/harness/VENDOR.json";
const SCHEMA = "stallion/vendor-manifest@1";
/** loadManifestFacts' absence verdict — host and freshness modes both render it through refuseMissingManifest. */
const MISSING_MANIFEST = "missing-manifest";

/** sha256 of bytes as hex. The empty-input digest is pinned by the self-test below. */
export function digestOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Provenance clauses: the manifest must be an object with the right schema and a real upstream sha. */
export function provenanceShapeRefusal(manifest) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return `manifest must be a JSON object, got ${Array.isArray(manifest) ? "an array" : typeof manifest}`;
  }
  if (manifest.schema !== SCHEMA) {
    return `manifest.schema must be "${SCHEMA}", got ${JSON.stringify(manifest.schema)}`;
  }
  if (typeof manifest.upstream !== "string" || !/^[0-9a-f]{40}$/.test(manifest.upstream)) {
    return `manifest.upstream must be a 40-hex stallion commit sha, got ${JSON.stringify(manifest.upstream)}`;
  }
  return null;
}

/** Corpus clauses: the manifest must name a vendored directory and declare at least one file. */
export function corpusShapeRefusal(manifest) {
  if (typeof manifest.vendored !== "string" || manifest.vendored.length === 0) {
    return `manifest.vendored must name the vendored corpus directory, got ${JSON.stringify(manifest.vendored)}`;
  }
  if (typeof manifest.files !== "object" || manifest.files === null || Array.isArray(manifest.files)) {
    return "manifest.files must be an object of host path → { source, sha256, adapted }";
  }
  if (Object.keys(manifest.files).length === 0) {
    return "manifest.files is empty — a vendoring with no files is a manifest that forgot its tree";
  }
  return Object.entries(manifest.files).map(([path, entry]) => entryShapeRefusal(path, entry)).find((r) => r !== null) ?? null;
}

/** Entry clauses: every declared file is { source, sha256, adapted } — an entry without a source
 *  is never counted as moved (freshness failed OPEN through it), and a null entry crashed the verdict. */
function entryShapeRefusal(path, entry) {
  const ok = entry !== null && typeof entry === "object" && typeof entry.source === "string" && entry.source.length > 0 && typeof entry.sha256 === "string" && typeof entry.adapted === "boolean";
  return ok ? null : `manifest.files[${JSON.stringify(path)}] must be { source: string, sha256: string, adapted: boolean }, got ${JSON.stringify(entry)}`;
}

/**
 * Shape law, pure. A manifest that fails any clause fails CLOSED — an unparseable or
 * half-written manifest proves nothing, so it must never read as a clean tree.
 */
export function manifestShapeRefusal(manifest) {
  return provenanceShapeRefusal(manifest) ?? corpusShapeRefusal(manifest);
}

/** The undeclared law: everything under the corpus directory must be declared in the manifest. */
function corpusReasons(manifest, corpusFiles) {
  const declared = new Set(Object.keys(manifest.files));
  return corpusFiles
    .filter((found) => !declared.has(found))
    .map(
      (found) =>
        `undeclared: ${found} lives under the vendored corpus but no manifest entry declares it — ` +
        `vendored code is superseded by re-vendoring, not patching; re-vendor from upstream ` +
        `${manifest.upstream.slice(0, 10)} or move the file out of ${manifest.vendored}`,
    );
}

/** The patch law: every declared file exists on disk and hashes to its recorded digest. */
function fileReasons(manifest, corpusFiles, digests) {
  const reasons = [];
  for (const [path, entry] of Object.entries(manifest.files)) {
    if (!corpusFiles.includes(path)) {
      reasons.push(
        `deleted: ${path} is declared in the manifest but missing from ${manifest.vendored} — ` +
          `restore it or re-vendor from upstream ${manifest.upstream.slice(0, 10)}`,
      );
      continue;
    }
    const got = digests[path] ?? null;
    if (got === null || got !== entry.sha256) {
      reasons.push(
        `patched: ${path} sha256 ${got ?? "unreadable"} ≠ manifest ${entry.sha256} — a local edit to ` +
          `vendored code; re-vendor from upstream ${manifest.upstream.slice(0, 10)} and regenerate the ` +
          `manifest rather than patching (source: ${entry.source})`,
      );
    }
  }
  return reasons;
}

/** The doc law: every mapped host doc must exist, so remedies name paths that exist in the host. */
function docReasons(manifest, existingDocs) {
  const docs = new Set(existingDocs);
  return Object.entries(manifest.docs ?? {})
    .filter(([, hostDoc]) => !docs.has(hostDoc))
    .map(
      ([upstreamDoc, hostDoc]) =>
        `doc: upstream ${upstreamDoc} maps to ${hostDoc}, which does not exist in this tree — remedies ` +
        `must name paths that exist; commit the mapped doc or fix the mapping and re-vendor`,
    );
}

/** The scope law: a corpus that does not contain its own running gate is born-scoped, not law. */
function scopeReason(manifest) {
  return (
    `scope: the executing vendor-drift.mjs does not live under ${manifest.vendored} — the gate ships ` +
    `inside the tree it polices, so a corpus that excludes it is a born-scoped manifest naming a ` +
    `corpus it does not govern; point vendored at the directory the gate runs from`
  );
}

/**
 * The whole drift law, pure: every fact is injected so the self-test can reach every branch
 * with no filesystem. `digests` maps host path → hex digest (null = unreadable, which reads as
 * a patch, fail closed); `corpusFiles` is what was found under the vendored directory;
 * `existingDocs` is the set of host doc paths that exist; `gateInsideCorpus` anchors the corpus
 * to the tree the gate itself shipped in (default true — the pure cases assume an honest corpus).
 */
export function driftVerdict({ manifest, corpusFiles, digests, existingDocs, gateInsideCorpus = true }) {
  const reasons = [
    ...(gateInsideCorpus ? [] : [scopeReason(manifest)]),
    ...corpusReasons(manifest, corpusFiles),
    ...fileReasons(manifest, corpusFiles, digests),
    ...docReasons(manifest, existingDocs),
  ];
  return { refuse: reasons.length > 0, reasons };
}

/**
 * Pure: the wave-intake freshness derivation — has the upstream repo moved past our pin, and did
 * anything VENDORED (a file source, or a mapped doc) move with it? A pin at HEAD is fresh; a pin
 * behind with nothing vendored touched is fresh-for-the-wave (upstream's own task registers are
 * not our corpus); a pin behind with vendored sources moved names exactly what a re-vendor owes.
 * The shape law runs first: a manifest without a usable pin never answers a freshness question.
 */
export function freshnessVerdict({ manifest, upstreamHead, upstreamChanged }) {
  const shape = manifestShapeRefusal(manifest);
  if (shape !== null) return { refuse: true, reason: shape };
  const sources = new Set([...Object.values(manifest.files).map((e) => e.source), ...Object.keys(manifest.docs ?? {})]);
  const moved = [...sources].filter((s) => upstreamChanged.includes(s));
  return { fresh: manifest.upstream === upstreamHead, moved, pin: manifest.upstream, head: upstreamHead };
}

/**
 * Every file under `root` (recursively), as root-relative POSIX paths. The manifest's own path
 * is skipped, compared by RESOLVED ABSOLUTE PATH: the first cut compared a root-relative name
 * against a cwd-relative manifest path — coordinate systems that never coincide when the
 * manifest lives inside the corpus (the documented layout) — so the gate refused every honest
 * tree. Found by six adversarial lanes with /tmp fixtures; the end-to-end self-test below pins
 * the class.
 */
export function walkCorpus(root, manifestPath) {
  const manifestAbs = resolve(manifestPath);
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (resolve(full) !== manifestAbs) found.push(relative(root, full).split(/[\\/]/).join("/"));
    }
  };
  visit(root);
  return found.sort();
}

/** Shape cases: every malformation the shape law must catch, plus the one that must pass. */
function selfTestShape(upstream, good) {
  const cases = [
    [null, "non-object"],
    [["x"], "array"],
    [good({ schema: "other@1" }), "wrong schema"],
    [good({ upstream: "short" }), "malformed sha"],
    [good({ vendored: "" }), "empty corpus"],
    [good({ files: {} }), "empty files"],
    [good({ files: { x: { sha256: "aa", adapted: false } } }), "entry missing source"],
    [good({ files: { x: { source: "tools/x.mjs", adapted: false } } }), "entry missing sha256"],
    [good({ files: { x: null } }), "null entry"],
    [good(), null],
  ];
  let failures = 0;
  for (const [manifest, label] of cases) {
    if ((manifestShapeRefusal(manifest) === null) !== (label === null)) {
      failures += 1;
      console.error(`vendor-drift SELF-TEST FAIL: shape — ${label ?? "valid manifest"} misjudged`);
    }
  }
  return { failures, count: cases.length };
}

/** Drift cases: the subset law — every direction of divergence refuses, clean passes. */
function selfTestDrift(good, corpus, digests, docs) {
  const cases = [
    ["a clean declared tree passes", good(), corpus, digests, docs, false],
    ["an undeclared file under the corpus refuses", good(), [...corpus, "local-patch.mjs"], digests, docs, true],
    ["a deleted vendored file refuses", good(), ["pathspec.mjs"], digests, docs, true],
    ["a patched vendored file refuses", good(), corpus, { ...digests, "task-state.mjs": "zz" }, docs, true],
    ["an unreadable file reads as patched, fail closed", good(), corpus, { ...digests, "pathspec.mjs": null }, docs, true],
    ["a mapped doc that does not exist refuses", good(), corpus, digests, [], true],
    ["an empty docs map is legal", good({ docs: {} }), corpus, digests, [], false],
    ["a missing docs key is legal (older manifests)", good({ docs: undefined }), corpus, digests, docs, false],
  ];
  let failures = 0;
  for (const [label, manifest, files, digs, existingDocs, expectRefuse] of cases) {
    const verdict = driftVerdict({ manifest, corpusFiles: files, digests: digs, existingDocs });
    if (verdict.refuse !== expectRefuse) {
      failures += 1;
      console.error(`vendor-drift SELF-TEST FAIL: ${label} (expected refuse=${expectRefuse}) — ${verdict.reasons.join("; ")}`);
    }
    if (!verdict.refuse && verdict.reasons.length !== 0) {
      failures += 1;
      console.error(`vendor-drift SELF-TEST FAIL: ${label} — allow with reasons is incoherent`);
    }
  }
  // The refusal must name the re-vendor remedy — the reason the gate exists.
  const patched = driftVerdict({ manifest: good(), corpusFiles: corpus, digests: { ...digests, "task-state.mjs": "zz" }, existingDocs: docs });
  if (!patched.reasons.some((r) => r.includes("re-vendor"))) {
    failures += 1;
    console.error("vendor-drift SELF-TEST FAIL: a drift refusal must carry the re-vendor remedy");
  }
  return { failures, count: cases.length };
}

/** Scope cases: the corpus anchor — a manifest nominating a corpus its own gate does not live in. */
function selfTestScope(good, corpus, digests, docs) {
  const cases = [
    ["a corpus containing its running gate passes", { manifest: good(), corpusFiles: corpus, digests, existingDocs: docs, gateInsideCorpus: true }, false],
    ["a corpus excluding its running gate refuses (born-scoped manifest)", { manifest: good(), corpusFiles: corpus, digests, existingDocs: docs, gateInsideCorpus: false }, true],
  ];
  let failures = 0;
  for (const [label, input, expectRefuse] of cases) {
    const verdict = driftVerdict(input);
    if (verdict.refuse !== expectRefuse) {
      failures += 1;
      console.error(`vendor-drift SELF-TEST FAIL: ${label} (expected refuse=${expectRefuse}) — ${verdict.reasons.join("; ")}`);
    }
  }
  const scoped = driftVerdict({ manifest: good(), corpusFiles: corpus, digests, existingDocs: docs, gateInsideCorpus: false });
  if (!scoped.reasons.some((r) => r.includes("born-scoped"))) {
    failures += 1;
    console.error("vendor-drift SELF-TEST FAIL: the scope refusal must name the born-scoped shape");
  }
  return { failures, count: cases.length };
}

/**
 * The disk path, end to end, against a real temp tree — because the first cut shipped with the
 * entire host-mode io layer executed by nothing, and a coordinate bug in walkCorpus refused
 * every honest manifest in the documented layout while the whole battery stayed green (six
 * adversarial lanes reproduced it with fixtures; this test pins the class).
 */
function selfTestEndToEnd() {
  const tmp = mkdtempSync(join(tmpdir(), "vendor-drift-"));
  let failures = 0;
  try {
    const corpus = join(tmp, "tools", "harness");
    mkdirSync(corpus, { recursive: true });
    // Fixture names carry no source extension: the laws under test (walk, manifest-skip, digest,
    // corpus anchor) are extension-agnostic, and test-lint rightly demands comment-stripping for
    // any test that reads a source-named file to assert on its content.
    writeFileSync(join(corpus, "gate.bin"), "// the gate ships in the tree it polices\n");
    writeFileSync(join(corpus, "task-state.bin"), "body");
    writeFileSync(join(tmp, "LAW.md"), "doc");
    const manifestPath = join(corpus, "VENDOR.json");
    const gateUrl = pathToFileURL(join(corpus, "gate.bin")).href;
    const writeManifest = () =>
      writeFileSync(manifestPath, JSON.stringify({
        schema: SCHEMA,
        upstream: "b".repeat(40),
        vendored: corpus,
        files: {
          "gate.bin": { source: "tools/vendor-drift.mjs", sha256: digestOf(readFileSync(join(corpus, "gate.bin"))), adapted: false },
          "task-state.bin": { source: "tools/task-state.mjs", sha256: digestOf(readFileSync(join(corpus, "task-state.bin"))), adapted: true },
        },
        docs: { "docs/LAW.md": join(tmp, "LAW.md") },
      }));

    writeManifest();
    const clean = loadManifestFacts(manifestPath, gateUrl);
    const cleanVerdict = clean.refusal !== null ? { refuse: true, reasons: [clean.refusal] } : driftVerdict(clean);
    if (cleanVerdict.refuse) {
      failures += 1;
      console.error(`vendor-drift SELF-TEST FAIL: e2e — a clean tree at the documented layout refused: ${cleanVerdict.reasons.join("; ")}`);
    }
    if (clean.corpusFiles.includes("VENDOR.json")) {
      failures += 1;
      console.error("vendor-drift SELF-TEST FAIL: e2e — the manifest itself was swept into the corpus (the f1 class)");
    }

    writeFileSync(join(corpus, "task-state.bin"), "patched");
    const patched = loadManifestFacts(manifestPath, gateUrl);
    if (!driftVerdict(patched).refuse) {
      failures += 1;
      console.error("vendor-drift SELF-TEST FAIL: e2e — a patched vendored file passed");
    }

    writeFileSync(join(corpus, "task-state.bin"), "body");
    writeFileSync(join(corpus, "sneak.bin"), "x");
    const sneaked = loadManifestFacts(manifestPath, gateUrl);
    if (!driftVerdict(sneaked).refuse) {
      failures += 1;
      console.error("vendor-drift SELF-TEST FAIL: e2e — an undeclared file passed");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { failures, count: 3 };
}

/** Every branch of the law, reached with no filesystem. Negative cases are the point. */
export function selfTest() {
  const upstream = "a".repeat(40);
  const good = (extra = {}) => ({
    schema: SCHEMA,
    upstream,
    vendored: "tools/harness",
    files: {
      "task-state.mjs": { source: "tools/task-state.mjs", sha256: "aa", adapted: true },
      "pathspec.mjs": { source: "tools/pathspec.mjs", sha256: "bb", adapted: false },
    },
    docs: { "docs/TASK-LIFECYCLE.md": "docs/harness/TASK-LIFECYCLE.md" },
    ...extra,
  });
  const digests = { "task-state.mjs": "aa", "pathspec.mjs": "bb" };
  const corpus = ["pathspec.mjs", "task-state.mjs"];
  const docs = ["docs/harness/TASK-LIFECYCLE.md"];

  const shape = selfTestShape(upstream, good);
  const drift = selfTestDrift(good, corpus, digests, docs);
  const scope = selfTestScope(good, corpus, digests, docs);
  const e2e = selfTestEndToEnd();
  const freshness = selfTestFreshness(good);
  const { result: cli, leftovers } = inHostHook(selfTestCli);
  let failures = shape.failures + drift.failures + scope.failures + e2e.failures + freshness.failures + cli.failures;
  if (leftovers.length > 0) {
    failures += 1;
    console.error(`vendor-drift SELF-TEST FAIL: hook env — the cli fixtures escaped into the host repo a hook names (${leftovers.join(", ")})`);
  }
  // The hasher is pinned to a known vector: sha256("") — if this ever changes, every manifest digest silently stops comparing.
  const empty = digestOf(new Uint8Array(0));
  if (empty !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") {
    failures += 1;
    console.error(`vendor-drift SELF-TEST FAIL: sha256("") = ${empty} — the hasher drifted`);
  }

  console.log(
    failures === 0
      ? `vendor-drift self-test: OK (${shape.count} shape + ${drift.count} drift + ${scope.count} scope + ${e2e.count} e2e + ${freshness.count} freshness + ${cli.count} cli cases + remedy + hasher)`
      : `vendor-drift self-test: FAILED (${failures} failure(s))`,
  );
  return failures === 0;
}

/** The pin-freshness family: has the upstream repo moved past our pin, and did anything VENDORED
 *  move with it — the wave-intake law's derivation. */
function selfTestFreshness(good) {
  const pin = "a".repeat(40);
  const head = "b".repeat(40);
  let failures = 0;
  const fail = (m) => {
    failures += 1;
    console.error(`vendor-drift SELF-TEST FAIL: ${m}`);
  };
  const cases = [
    ["a manifest pinned to the upstream HEAD is fresh", typeof freshnessVerdict === "function" && freshnessVerdict({ manifest: good({ upstream: head }), upstreamHead: head, upstreamChanged: [] }).fresh],
    ["a moved upstream with NO vendored source touched owes nothing (fresh-for-the-wave)", (() => {
      if (typeof freshnessVerdict !== "function") return false;
      const v = freshnessVerdict({ manifest: good({ upstream: pin }), upstreamHead: head, upstreamChanged: ["tasks/x.json", "README.md"] });
      return !v.fresh && v.moved.length === 0;
    })()],
    ["a moved vendored source is named as owed", (() => {
      if (typeof freshnessVerdict !== "function") return false;
      const v = freshnessVerdict({ manifest: good({ upstream: pin }), upstreamHead: head, upstreamChanged: ["tools/task-state.mjs", "tasks/x.json"] });
      return !v.fresh && v.moved.join() === "tools/task-state.mjs";
    })()],
    ["a moved doc-map upstream doc is named as owed", (() => {
      if (typeof freshnessVerdict !== "function") return false;
      const v = freshnessVerdict({ manifest: good({ upstream: pin }), upstreamHead: head, upstreamChanged: ["docs/TASK-LIFECYCLE.md"] });
      return !v.fresh && v.moved.join() === "docs/TASK-LIFECYCLE.md";
    })()],
    ["a manifest with a null upstream pin refuses freshness (shape law first)", (() => {
      if (typeof freshnessVerdict !== "function") return false;
      const v = freshnessVerdict({ manifest: good({ upstream: null }), upstreamHead: head, upstreamChanged: [] });
      return v.refuse === true;
    })()],
  ];
  for (const [name, passes] of cases) if (!passes) fail(name);
  return { failures, count: cases.length };
}

/** The caller's env minus GIT_*, read at call time: inside a hook GIT_DIR / GIT_INDEX_FILE name the
 *  HOST repo, so a fixture that inherits them writes the host's index. */
function fixtureEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
}

/** Runs `family` inside a simulated git hook — GIT_DIR and GIT_INDEX_FILE name a HOST repo (a
 *  linked worktree's hook; `commit -a`), and a global core.hooksPath holds a pre-commit hook —
 *  and returns its result plus whatever it left in that host. Anything left there is a fixture
 *  that wrote the host's refs or index, or re-fired its hook; a crash under the hook's env is
 *  reported the same way, never as a stack trace. */
function inHostHook(family) {
  const host = mkdtempSync(join(tmpdir(), "vendor-drift-host-"));
  writeFileSync(join(host, "pre-commit"), `#!/bin/sh\ntouch "${join(host, "hook-fired")}"\n`, { mode: 0o755 });
  writeFileSync(join(host, ".gitconfig"), `[core]\n\thooksPath = ${host}\n`);
  const hookEnv = { HOME: host, GIT_DIR: join(host, "git"), GIT_INDEX_FILE: join(host, "index.lock") };
  const saved = Object.keys(hookEnv).map((k) => [k, process.env[k]]);
  const leftovers = () => ["git", "index.lock", "hook-fired"].filter((f) => existsSync(join(host, f)));
  Object.assign(process.env, hookEnv);
  try {
    const result = family();
    return { result, leftovers: leftovers() };
  } catch (error) {
    return { result: { failures: 0, count: 0 }, leftovers: [...leftovers(), `a crash: ${`${error.message}`.split("\n")[0]}`] };
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(host, { recursive: true, force: true });
  }
}

/** git in a throwaway fixture repo, identity pinned so the commit never depends on the caller's config. */
function fixtureGit(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=selftest", "-c", "user.email=selftest@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: fixtureEnv() }).trim();
}

/** Commit one file into a fixture repo; returns the new HEAD sha. */
function commitFile(repo, path, body) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), body);
  fixtureGit(repo, "add", path);
  fixtureGit(repo, "commit", "-q", "-m", `touch ${path}`);
  return fixtureGit(repo, "rev-parse", "HEAD");
}

/** This gate as a subprocess — the CLI's own refusals only exist past process.exit. */
function runCli(cwd, ...args) {
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { cwd, encoding: "utf8", env: fixtureEnv() });
  return { code: run.status, out: `${run.stdout}\n${run.stderr}` };
}

/**
 * The CLI end to end, against real git repos in a temp dir: the refusals that live past the pure
 * verdicts — the upstream sweep run from a SUBDIRECTORY, the freshness answer for an ABSENT
 * manifest, and a clone whose HEAD sits BEHIND the pin (fetched, never fast-forwarded) — plus the
 * allowance that an ancestor pin still answers.
 */
function selfTestCli() {
  const tmp = mkdtempSync(join(tmpdir(), "vendor-drift-cli-"));
  let failures = 0;
  const check = (label, ok) => {
    if (ok) return;
    failures += 1;
    console.error(`vendor-drift SELF-TEST FAIL: cli — ${label}`);
  };
  try {
    const forged = join(tmp, "forged");
    mkdirSync(forged);
    fixtureGit(forged, "init", "-q");
    commitFile(forged, "docs/x.md", "doc");
    commitFile(forged, DEFAULT_MANIFEST, "{}");
    check("--upstream run from a subdirectory must still see a tracked forged manifest", runCli(join(forged, "docs"), "--upstream").code === 1);

    const absent = runCli(tmp, "--freshness", forged, "--manifest", join(tmp, "absent.json"));
    check("--freshness on an absent manifest must print the commit-a-manifest remedy, not a raw token", absent.code === 1 && absent.out.includes("Commit a manifest") && !absent.out.includes("missing-manifest"));

    const upstream = join(tmp, "upstream");
    mkdirSync(upstream);
    fixtureGit(upstream, "init", "-q");
    const first = commitFile(upstream, "tools/x.mjs", "v1");
    const middle = commitFile(upstream, "README.md", "readme");
    const last = commitFile(upstream, "tools/x.mjs", "v2");
    const host = join(tmp, "host");
    mkdirSync(host);
    const manifestAt = (pin) => {
      writeFileSync(join(host, "VENDOR.json"), JSON.stringify({ schema: SCHEMA, upstream: pin, vendored: host, files: { "x.mjs": { source: "tools/x.mjs", sha256: "aa", adapted: false } } }));
      return join(host, "VENDOR.json");
    };
    fixtureGit(upstream, "checkout", "-q", "--detach", first);
    const behind = runCli(tmp, "--freshness", upstream, "--manifest", manifestAt(last));
    check("--freshness must refuse a clone whose HEAD is BEHIND the pin, never print a downgrade as the re-vendor", behind.code === 1 && behind.out.includes("behind") && !behind.out.includes("past the pin"));
    fixtureGit(upstream, "checkout", "-q", "--detach", middle);
    const ahead = runCli(tmp, "--freshness", upstream, "--manifest", manifestAt(first));
    check("--freshness with the pin an ancestor of HEAD must still answer (fresh for the wave)", ahead.code === 0 && ahead.out.includes("FRESH FOR THIS WAVE"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { failures, count: 4 };
}

function flagValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

/** Digest every corpus file; an unreadable one reads as null, which the verdict treats as a patch. */
function digestCorpus(corpusRoot, corpusFiles) {
  const digests = {};
  for (const rel of corpusFiles) {
    try {
      digests[rel] = digestOf(readFileSync(join(corpusRoot, rel)));
    } catch {
      digests[rel] = null;
    }
  }
  return digests;
}

/** True when the executing gate file sits inside `corpus` — the anchor that defeats born-scoped manifests. */
function gateInside(corpus, gateUrl) {
  const rel = relative(resolve(corpus), dirname(fileURLToPath(gateUrl)));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

/**
 * Gather every fact the verdict needs from disk, or the one refusal that stops before a verdict
 * exists. Split from runHost so each holds one concern: this reads, that decides and prints.
 * `gateUrl` is injectable so the end-to-end self-test can anchor a synthetic corpus.
 */
function loadManifestFacts(manifestPath, gateUrl = import.meta.url) {
  if (!existsSync(manifestPath)) {
    return { refusal: MISSING_MANIFEST, manifest: null, corpusFiles: [], digests: {}, existingDocs: [], gateInsideCorpus: false };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return { refusal: `the manifest does not parse as JSON — ${String(error.message ?? error)}`, manifest: null, corpusFiles: [], digests: {}, existingDocs: [], gateInsideCorpus: false };
  }
  const shape = manifestShapeRefusal(manifest);
  if (shape !== null) return { refusal: shape, manifest: null, corpusFiles: [], digests: {}, existingDocs: [], gateInsideCorpus: false };
  const anchored = gateInside(manifest.vendored, gateUrl);
  if (!existsSync(manifest.vendored)) {
    return { refusal: `the manifest names corpus directory ${manifest.vendored}, which does not exist`, manifest: null, corpusFiles: [], digests: {}, existingDocs: [], gateInsideCorpus: anchored };
  }
  const corpusFiles = walkCorpus(manifest.vendored, manifestPath);
  return {
    refusal: null,
    manifest,
    corpusFiles,
    digests: digestCorpus(manifest.vendored, corpusFiles),
    existingDocs: Object.values(manifest.docs ?? {}).filter((p) => existsSync(p)),
    gateInsideCorpus: anchored,
  };
}

/** The absent-manifest refusal, ONE rendering for every mode: freshness once printed the bare
 *  sentinel token, naming no rule and no remedy. */
function refuseMissingManifest(manifestPath) {
  process.stderr.write(
    `\x1b[31m✖ vendor-drift: no vendor manifest at ${manifestPath}.\x1b[0m\n\n` +
      `  A vendored harness tree must carry its lineage. Deleting the manifest is not an escape —\n` +
      `  host and freshness modes fail closed on absence. Commit a manifest (schema "${SCHEMA}", see WIRING §1)\n` +
      `  or point --manifest at it.\n\n`,
  );
  process.exit(1);
}

/** Host mode: the manifest is law. Fails closed on a missing manifest — deleting it is not an escape. */
function runHost(manifestPath) {
  const facts = loadManifestFacts(manifestPath);
  if (facts.refusal === MISSING_MANIFEST) refuseMissingManifest(manifestPath);
  const verdict = facts.refusal !== null
    ? { refuse: true, reasons: [facts.refusal] }
    : driftVerdict(facts);
  if (!verdict.refuse) {
    const adapted = Object.values(facts.manifest.files).filter((e) => e.adapted).length;
    console.log(
      `vendor-drift: OK — ${facts.corpusFiles.length} vendored file(s) match the manifest ` +
        `(upstream ${facts.manifest.upstream.slice(0, 10)}, ${adapted} adapted, ${Object.keys(facts.manifest.docs ?? {}).length} doc map(s))`,
    );
    return;
  }
  process.stderr.write(`\x1b[31m✖ vendor-drift: the vendored tree has drifted from its manifest.\x1b[0m\n\n`);
  for (const reason of verdict.reasons) process.stderr.write(`  ✖ ${reason}\n`);
  process.stderr.write(
    `\n  Vendored code is superseded by re-vendoring, not patching (WIRING §1).\n` +
      `  Re-vendor from stallion and regenerate ${manifestPath} in the same commit.\n\n`,
  );
  process.exit(1);
}

/**
 * Upstream mode, for stallion's own battery: this tree must NOT carry a vendor manifest —
 * anywhere. The default path is checked directly, and tracked *VENDOR.json files are swept
 * repo-wide, because the claim "stallion never carries a forged manifest" must not rest on
 * one existsSync. Repo-wide from ANY cwd: a bare pathspec sweeps only the cwd's subtree, so a
 * run from docs/ read a tracked forged manifest green — `:(top)` anchors it at the root. Falls
 * back to the path check alone where git is unavailable.
 */
function runUpstream(manifestPath) {
  const offenders = [];
  if (existsSync(manifestPath)) offenders.push(manifestPath);
  try {
    for (const tracked of execFileSync("git", ["ls-files", "--full-name", ":(top)*VENDOR.json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n")) {
      if (tracked.trim() !== "") offenders.push(tracked.trim());
    }
  } catch {
    // no git or no repo: the direct path check above already spoke
  }
  if (offenders.length > 0) {
    process.stderr.write(
      `\x1b[31m✖ vendor-drift: an upstream tree carries a vendor manifest:\x1b[0m\n\n` +
        offenders.map((p) => `  ✖ ${p}`).join("\n") +
        `\n\n  stallion does not vendor itself — a manifest here is a forged provenance marker.\n` +
        `  Delete it, or this check is lying about which tree is upstream.\n\n`,
    );
    process.exit(1);
  }
  console.log(`vendor-drift: OK — no vendor manifest anywhere in the tree (upstream; stallion does not vendor itself)`);
}

/**
 * Freshness mode — the wave-intake law. Answers "has upstream moved past our pin, and did
 * anything vendored move with it" by reading the upstream clone's git at `upstreamPath`. A pin
 * the upstream repo no longer knows (rewritten history, wrong remote) REFUSES: a freshness
 * answer computed against a tree that cannot see the pin is a guess wearing a verdict's clothes.
 */
function runFreshness(manifestPath, upstreamPath) {
  const facts = loadManifestFacts(manifestPath);
  if (facts.refusal === MISSING_MANIFEST) refuseMissingManifest(manifestPath);
  if (facts.refusal !== null) {
    process.stderr.write(
      `\x1b[31m✖ vendor-drift: the manifest cannot be read for a freshness answer.\x1b[0m\n\n  ✖ ${facts.refusal}\n` +
        `  fix: repair or re-vendor ${manifestPath} (schema "${SCHEMA}", WIRING §1), or point --manifest at the right file\n\n`,
    );
    process.exit(1);
  }
  const { head, changed } = readUpstreamSincePin(upstreamPath, facts.manifest.upstream);
  if (!pinIsAncestor(upstreamPath, facts.manifest.upstream)) refuseBehindPin(upstreamPath, facts.manifest.upstream, head);
  const verdict = freshnessVerdict({ manifest: facts.manifest, upstreamHead: head, upstreamChanged: changed });
  if (verdict.fresh) {
    console.log(`vendor-drift: FRESH — the manifest pin is the upstream HEAD (${head.slice(0, 10)}) as of the LOCAL clone at ${upstreamPath}; fetch before trusting recency`);
    return;
  }
  if (verdict.moved.length === 0) {
    console.log(`vendor-drift: FRESH FOR THIS WAVE — upstream moved past the pin (${verdict.pin.slice(0, 10)} -> ${head.slice(0, 10)}) but touched no vendored source; nothing is owed by re-vendor`);
    return;
  }
  process.stderr.write(
    `\x1b[31m✖ vendor-drift: upstream moved ${verdict.moved.length} vendored source(s) past the pin — this wave's intake owes a re-vendor.\x1b[0m\n\n` +
      verdict.moved.map((s) => `  ✖ ${s}`).join("\n") +
      `\n\n  pin ${verdict.pin.slice(0, 10)} -> upstream HEAD ${head.slice(0, 10)}\n` +
      `  fix: re-vendor from stallion at ${head.slice(0, 10)} and regenerate ${manifestPath} in the same\n` +
      `       commit (WIRING §1), before this wave's own work lands on the stale pin\n\n`,
  );
  process.exit(1);
}

/** The upstream clone's HEAD and every path changed from the pin to it — or the refusal when the
 *  clone cannot see the pin. */
function readUpstreamSincePin(upstreamPath, pin) {
  const git = (args) => execFileSync("git", ["-C", upstreamPath, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git(["rev-parse", "--verify", `${pin}^{commit}`]);
    const head = git(["rev-parse", "HEAD"]);
    // --no-renames: under default rename detection a renamed vendored source lists only its NEW
    // path, the old source matches nothing, and the wave reads FRESH-FOR-WAVE through a rename
    // (an adversarial pass proved it end-to-end). Both sides of a rename are owed.
    const changed = git(["diff", "--name-only", "--no-renames", `${pin}..HEAD`]).split("\n").map((l) => l.trim()).filter(Boolean);
    return { head, changed };
  } catch (error) {
    process.stderr.write(
      `\x1b[31m✖ vendor-drift: the upstream repo at ${upstreamPath} could not answer the pin.\x1b[0m\n\n` +
        `  ${String(error.stderr || error.message || error).trim().split("\n")[0]}\n` +
        `  rule: the pin commit must exist in that clone and HEAD must resolve — a freshness verdict\n` +
        `        computed against a tree that cannot see the pin is a guess, not a verdict\n` +
        `  fix: point --freshness at a current clone of the upstream (fetch and fast-forward it first —\n` +
        `       git -C ${upstreamPath} pull --ff-only — if the pin is new)\n\n`,
    );
    process.exit(1);
  }
}

/** Direction law: a two-dot diff has no direction. A clone BEHIND the pin (fetched, never
 *  fast-forwarded — the state the pin refusal's own remedy used to produce) listed the pin's own
 *  changes as upstream's and named its older HEAD as the re-vendor target: a downgrade. Only a
 *  HEAD that descends from the pin (or is the pin) can answer. Any git failure reads as NOT. */
function pinIsAncestor(upstreamPath, pin) {
  return spawnSync("git", ["-C", upstreamPath, "merge-base", "--is-ancestor", pin, "HEAD"], { stdio: "ignore" }).status === 0;
}

function refuseBehindPin(upstreamPath, pin, head) {
  process.stderr.write(
    `\x1b[31m✖ vendor-drift: the clone at ${upstreamPath} is behind (or diverged from) the manifest pin.\x1b[0m\n\n` +
      `  pin ${pin.slice(0, 10)} is not an ancestor of the clone's HEAD ${head.slice(0, 10)}\n` +
      `  rule: only a HEAD that descends from the pin can say what upstream changed since it — a diff\n` +
      `        against an older HEAD reads the pin's own changes as upstream's, and names a downgrade\n` +
      `        as the re-vendor\n` +
      `  fix: git -C ${upstreamPath} pull --ff-only   (or check out the upstream branch tip), then re-run\n\n`,
  );
  process.exit(1);
}

/**
 * CLI, guarded by an entry-module check (the pathspec lesson: a bare argv check fires on import
 * and exits before an importer's own self-test can run).
 */
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isEntry) {
  const manifestPath = flagValue("--manifest") ?? DEFAULT_MANIFEST;
  if (process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  const freshnessPath = flagValue("--freshness");
  if (process.argv.includes("--freshness") && !freshnessPath) {
    process.stderr.write("vendor-drift: --freshness requires the upstream clone's path — a flag without its value falls through to host mode and answers a different question (refused, not silently)\n");
    process.exit(1);
  }
  if (freshnessPath) runFreshness(manifestPath, freshnessPath);
  // Mode-exclusive: upstream returns its own verdicts and must never fall through to host mode.
  else if (process.argv.includes("--upstream")) runUpstream(manifestPath);
  else runHost(manifestPath);
}
