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
 * MODES. Bare (host): the manifest is law — a missing manifest, a bad shape, an undeclared file
 * under the corpus, a patched or deleted vendored file, or a mapped doc that does not exist
 * each refuse with a re-vendor remedy. A deleted manifest is NOT an escape: bare mode fails
 * closed on absence. `--upstream`: for stallion's own battery — asserts this tree does NOT
 * carry a vendor manifest, because stallion does not vendor itself and a manifest here would
 * be a forged provenance marker. `--manifest <path>` overrides the location for both modes.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_MANIFEST = "tools/harness/VENDOR.json";
const SCHEMA = "stallion/vendor-manifest@1";

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
  return null;
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

/**
 * The whole drift law, pure: every fact is injected so the self-test can reach every branch
 * with no filesystem. `digests` maps host path → hex digest (null = unreadable, which reads as
 * a patch, fail closed); `corpusFiles` is what was found under the vendored directory;
 * `existingDocs` is the set of host doc paths that exist.
 */
export function driftVerdict({ manifest, corpusFiles, digests, existingDocs }) {
  const reasons = [
    ...corpusReasons(manifest, corpusFiles),
    ...fileReasons(manifest, corpusFiles, digests),
    ...docReasons(manifest, existingDocs),
  ];
  return { refuse: reasons.length > 0, reasons };
}

/** Every file under `root` (recursively), as root-relative POSIX paths. The manifest's own path is skipped. */
export function walkCorpus(root, manifestPath) {
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else {
        const rel = relative(root, full).split(/[\\/]/).join("/");
        if (rel !== manifestPath) found.push(rel);
      }
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
  let failures = shape.failures + drift.failures;
  // The hasher is pinned to a known vector: sha256("") — if this ever changes, every manifest digest silently stops comparing.
  const empty = digestOf(new Uint8Array(0));
  if (empty !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") {
    failures += 1;
    console.error(`vendor-drift SELF-TEST FAIL: sha256("") = ${empty} — the hasher drifted`);
  }

  console.log(
    failures === 0
      ? `vendor-drift self-test: OK (${shape.count} shape + ${drift.count} drift cases + remedy + hasher)`
      : `vendor-drift self-test: FAILED (${failures} failure(s))`,
  );
  return failures === 0;
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

/**
 * Gather every fact the verdict needs from disk, or the one refusal that stops before a verdict
 * exists. Split from runHost so each holds one concern: this reads, that decides and prints.
 */
function loadManifestFacts(manifestPath) {
  if (!existsSync(manifestPath)) {
    return { refusal: "missing-manifest", manifest: null, corpusFiles: [], digests: {}, existingDocs: [] };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return { refusal: `the manifest does not parse as JSON — ${String(error.message ?? error)}`, manifest: null, corpusFiles: [], digests: {}, existingDocs: [] };
  }
  const shape = manifestShapeRefusal(manifest);
  if (shape !== null) return { refusal: shape, manifest: null, corpusFiles: [], digests: {}, existingDocs: [] };
  if (!existsSync(manifest.vendored)) {
    return { refusal: `the manifest names corpus directory ${manifest.vendored}, which does not exist`, manifest: null, corpusFiles: [], digests: {}, existingDocs: [] };
  }
  const corpusFiles = walkCorpus(manifest.vendored, manifestPath);
  return {
    refusal: null,
    manifest,
    corpusFiles,
    digests: digestCorpus(manifest.vendored, corpusFiles),
    existingDocs: Object.values(manifest.docs ?? {}).filter((p) => existsSync(p)),
  };
}

/** Host mode: the manifest is law. Fails closed on a missing manifest — deleting it is not an escape. */
function runHost(manifestPath) {
  const facts = loadManifestFacts(manifestPath);
  if (facts.refusal === "missing-manifest") {
    process.stderr.write(
      `\x1b[31m✖ vendor-drift: no vendor manifest at ${manifestPath}.\x1b[0m\n\n` +
        `  A vendored harness tree must carry its lineage. Deleting the manifest is not an escape —\n` +
        `  bare mode fails closed on absence. Commit a manifest (schema "${SCHEMA}", see WIRING §1)\n` +
        `  or point --manifest at it.\n\n`,
    );
    process.exit(1);
  }
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

/** Upstream mode, for stallion's own battery: this tree must NOT carry a vendor manifest. */
function runUpstream(manifestPath) {
  if (existsSync(manifestPath)) {
    process.stderr.write(
      `\x1b[31m✖ vendor-drift: an upstream tree carries a vendor manifest at ${manifestPath}.\x1b[0m\n\n` +
        `  stallion does not vendor itself — a manifest here is a forged provenance marker.\n` +
        `  Delete it, or this check is lying about which tree is upstream.\n\n`,
    );
    process.exit(1);
  }
  console.log(`vendor-drift: OK — no vendor manifest at ${manifestPath} (upstream tree; stallion does not vendor itself)`);
}

/**
 * CLI, guarded by an entry-module check (the pathspec lesson: a bare argv check fires on import
 * and exits before an importer's own self-test can run).
 */
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  const manifestPath = flagValue("--manifest") ?? DEFAULT_MANIFEST;
  if (process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  // Mode-exclusive: upstream returns its own verdicts and must never fall through to host mode.
  if (process.argv.includes("--upstream")) runUpstream(manifestPath);
  else runHost(manifestPath);
}
