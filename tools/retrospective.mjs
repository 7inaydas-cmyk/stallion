#!/usr/bin/env node
/**
 * RETROSPECTIVE — the cross-task lessons index, DERIVED from the committed findings registers,
 * never stored. The 2026-09-20 Letta evaluation's gap 1 (24/24 claims fact-checked): 209
 * findings across the registers, but every findings reader was per-task and both task
 * enumerations excluded findings files — so 31 WONT-FIX boundaries (including the
 * backdated-record escape and the push --no-verify fence skip) bound every future session and
 * surfaced nowhere. The repo paid for that knowledge once per finding and then buried it.
 *
 * WHAT IT DERIVES (and prints, or emits as --json):
 *   wontFix      every live WONT-FIX boundary — task, lane, severity, claim, justification —
 *                the accepted-risk contract a fresh session must know before it repeats the
 *                escape someone already paid to learn
 *   tokenCounts  the recurring vocabulary of past findings (claims + justifications, stopwords
 *                out) — where the escapes keep coming from
 *   laneTotals   findings per escape class — which lane keeps earning its keep
 *
 * WHERE IT FEEDS: `adversarial prepare` injects the compact block into every lane bundle (the
 * lanes read what past lanes learned), and `task-state status` prints the one-line summary.
 * Nothing is written to the repo: the index is a derivation over committed registers, so it can
 * never drift from them.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadFindings } from "./task-findings.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
/** Anchored to the MODULE ROOT, like every sibling state tool: the advertised command must give
 * the same answer from any cwd, never a confident empty index (the lane-1 finding). */
const STATE_DIR = `${ROOT}tasks`;

/** Severity rank for ordering: CRITICAL first, LOW last — the lane-5 finding was a lexicographic
 * sort quietly preferring LOW over MEDIUM in every lane bundle. */
const SEVERITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const STOPWORDS = new Set(
  ("about after again against because before being below between both every from further have into just more most " +
    "other over same some such than that the their them then there these they this those through under until very " +
    "when where which while with without would could should must will your were does been also only ever never still " +
    "cannot files file path").split(" "),
);

/** Every live WONT-FIX boundary across the registers, most severe first (then task, then id). */
export function wontFixOf(registers) {
  const rows = [];
  for (const { task, register } of registers) {
    for (const finding of register.findings) {
      if (finding.status === "WONT-FIX") {
        rows.push({
          task,
          id: finding.id,
          lane: finding.lane,
          severity: finding.severity,
          claim: finding.claim,
          justification: finding.justification ?? "(no justification recorded)",
        });
      }
    }
  }
  return rows.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.task < b.task ? -1 : a.task > b.task ? 1 : a.id < b.id ? -1 : 1));
}

/** The recurring vocabulary of past findings — where the escapes keep coming from. */
export function tokenCountsOf(registers) {
  const counts = new Map();
  for (const { register } of registers) {
    for (const finding of register.findings) {
      const text = `${finding.claim} ${finding.justification ?? ""}`.toLowerCase();
      // Hyphens stay INTRA-word: "self-test" and "vendor-drift" are the vocabulary units past
      // findings actually recur on, and splitting on the hyphen would shard them below the
      // length floor.
      for (const raw of text.split(/[^a-z-]+/)) {
        const token = raw.replace(/^-+|-+$/g, "");
        if (token.length >= 5 && !STOPWORDS.has(token)) counts.set(token, (counts.get(token) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

/** Findings per escape class — which lane keeps earning its keep. */
export function laneTotalsOf(registers) {
  const lanes = {};
  for (const { register } of registers) {
    for (const finding of register.findings) lanes[finding.lane] = (lanes[finding.lane] ?? 0) + 1;
  }
  return lanes;
}

/** The whole index, pure over parsed registers. */
export function lessonsIndex(registers) {
  return {
    registers: registers.length,
    findings: registers.reduce((n, { register }) => n + register.findings.length, 0),
    wontFix: wontFixOf(registers),
    tokenCounts: tokenCountsOf(registers),
    laneTotals: laneTotalsOf(registers),
  };
}

/** Read every findings register under `dir`; a malformed one is skipped and counted, never fatal. */
export function loadRegisters(dir = STATE_DIR) {
  const registers = [];
  let skipped = 0;
  let entries = [];
  try {
    entries = readdirSync(dir).filter((f) => f.includes(".findings."));
  } catch {
    return { registers, skipped };
  }
  for (const f of entries) {
    const { ok, register } = loadFindings(join(dir, f));
    if (!ok || register === null) skipped += 1;
    else registers.push({ task: register.task ?? f.replace(/\.findings\.json$/, ""), register });
  }
  return { registers, skipped };
}

/** One line for `task-state status` — the buried-knowledge counter. */
export function summaryLine(index) {
  if (index.registers === 0) return "no findings registers yet — nothing learned the hard way, nothing to recall";
  const top = index.tokenCounts.slice(0, 4).map(([token, n]) => `${token}×${n}`).join(", ");
  return `${index.findings} finding(s) across ${index.registers} register(s) — ${index.wontFix.length} WONT-FIX boundar${index.wontFix.length === 1 ? "y" : "ies"} live${top.length > 0 ? `; recurring: ${top}` : ""} (node tools/retrospective.mjs)`;
}

/**
 * The compact block every lane bundle carries: what past lanes learned. EVERY live WONT-FIX
 * boundary rides along — the lane-5 finding was a slice(0,12) under a lexicographic sort
 * quietly dropping all MEDIUM boundaries while the prose claimed exhaustiveness; the recall
 * surface is the one place a cap must never live.
 */
export function bundleBlock(index) {
  if (index.registers === 0) return "";
  const lines = [`### Standing lessons from ${index.findings} past finding(s) across ${index.registers} register(s)`];
  const top = index.tokenCounts.slice(0, 8).map(([token, n]) => `${token}×${n}`).join(", ");
  if (top.length > 0) lines.push(`Recurring escape vocabulary: ${top}.`);
  if (index.wontFix.length > 0) {
    lines.push(`All ${index.wontFix.length} accepted-risk boundaries a lane must NOT re-report as novel (they are recorded WONT-FIX):`);
    for (const w of index.wontFix) {
      lines.push(`- [${w.severity}] ${w.task} ${w.id}: ${trunc(w.claim, 160)} — ${trunc(w.justification, 140)}`);
    }
  }
  return lines.join("\n");
}

/** The human report. */
export function renderIndex(index, top = 12) {
  const lines = [
    `retrospective: ${index.findings} finding(s) across ${index.registers} register(s)`,
    `  lanes: ${Object.entries(index.laneTotals).sort((a, b) => a[0] - b[0]).map(([l, n]) => `${l}:${n}`).join("  ") || "(none)"}`,
    `  recurring: ${index.tokenCounts.slice(0, top).map(([t, n]) => `${t}×${n}`).join(", ") || "(none)"}`,
    `  WONT-FIX boundaries (${index.wontFix.length}) — accepted risk, recorded, binding future sessions:`,
  ];
  for (const w of index.wontFix) {
    lines.push(`  • [${w.severity}] ${w.task} ${w.id} (lane ${w.lane}): ${w.claim}`);
    lines.push(`      justification: ${w.justification}`);
  }
  if (index.wontFix.length === 0) lines.push("  (none)");
  return lines.join("\n");
}

const trunc = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The composition law: EVERY boundary rides along, severity-ranked — the lane-5 finding's shape. */
function bundleBlockCarriesAllRanked() {
  const many = [];
  for (let i = 0; i < 15; i += 1) many.push({ task: `t-${i}`, id: "f1", lane: 2, severity: i === 0 ? "CRITICAL" : i === 1 ? "HIGH" : i === 2 ? "MEDIUM" : "LOW", claim: "x".repeat(300), justification: "j", status: "WONT-FIX", recordedAt: "2026-09-01T00:00:00.000Z" });
  const index = lessonsIndex([{ task: "t", register: { schema: "stallion/task-findings@1", findings: many } }]);
  const rows = bundleBlock(index).split("\n").filter((l) => l.startsWith("- ["));
  return rows.length === 15 && rows[0].includes("[CRITICAL]") && rows[1].includes("[HIGH]") && rows[2].includes("[MEDIUM]") && rows.every((l) => l.length <= 400);
}

/** The case matrix, split from the runner so the ratchet keeps its word. */
function selfTestCases(registers) {
  return [
    ["wont-fix boundaries surface with task and justification", (() => {
      const i = lessonsIndex(registers);
      return i.wontFix.length === 1 && i.wontFix[0].task === "t-one" && i.wontFix[0].justification.includes("deliberate");
    })()],
    ["token counts rank findings vocabulary, stopwords out, ties alphabetical", (() => {
      const i = lessonsIndex(registers);
      const self = i.tokenCounts.find(([t]) => t === "self-test");
      const the = i.tokenCounts.find(([t]) => t === "about");
      return self !== undefined && self[1] === 3 && the === undefined;
    })()],
    ["lane totals count per escape class", lessonsIndex(registers).laneTotals["1"] === 2 && lessonsIndex(registers).laneTotals["3"] === 1],
    ["totals aggregate findings and registers", (() => { const i = lessonsIndex(registers); return i.findings === 3 && i.registers === 2; })()],
    ["an empty index is valid, not an error", lessonsIndex([]).findings === 0 && lessonsIndex([]).wontFix.length === 0],
    ["derivation is deterministic (same registers, same JSON)", JSON.stringify(lessonsIndex(registers)) === JSON.stringify(lessonsIndex(registers))],
    ["summaryLine counts boundaries and names the top classes", summaryLine(lessonsIndex(registers)).includes("1 WONT-FIX") && summaryLine(lessonsIndex(registers)).includes("self-test×3")],
    ["bundleBlock carries EVERY boundary ranked by severity, truncating long claims", bundleBlockCarriesAllRanked()],
    ["bundleBlock names wont-fix boundaries with task and id", bundleBlock(lessonsIndex(registers)).includes("t-one f1")],
    ["trunc appends the ellipsis only when cutting", trunc("abcdef", 3) === "abc…" && trunc("abc", 3) === "abc"],
  ];
}

/** The loader's own law: a malformed register is skipped AND COUNTED — never fatal, never silent. */
function selfTestLoader() {
  const dir = mkdtempSync(join(tmpdir(), "retrospective-"));
  let failures = 0;
  try {
    mkdirSync(join(dir, "sub"), { recursive: true }); // a directory among the files must not crash the walk
    const valid = { schema: "stallion/task-findings@1", task: "t-real", passStartedAt: "2026-01-01T00:00:00.000Z", findings: [] };
    writeFileSync(join(dir, "t-real.findings.json"), JSON.stringify(valid));
    writeFileSync(join(dir, "broken.findings.json"), "{ not json");
    const { registers, skipped } = loadRegisters(dir);
    if (registers.length !== 1 || registers[0].task !== "t-real") {
      failures += 1;
      console.error("retrospective SELF-TEST FAIL (loader): the valid register must load");
    }
    if (skipped !== 1) {
      failures += 1;
      console.error(`retrospective SELF-TEST FAIL (loader): the malformed register must be counted, got skipped=${skipped}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { failures, count: 2 };
}

/** Pure cases first; the loader gets real temp files (one malformed) — a vacuous sweep is visible here. */
export function selfTest() {
  const reg = (task, findings) => ({ task, register: { schema: "stallion/task-findings@1", task, findings } });
  const wont = (id, claim, justification) => ({ id, lane: 3, severity: "LOW", status: "WONT-FIX", claim, justification, recordedAt: "2026-09-01T00:00:00.000Z" });
  const open = (id, claim) => ({ id, lane: 1, severity: "HIGH", status: "UNRESOLVED", claim, recordedAt: "2026-09-01T00:00:00.000Z" });
  const registers = [
    reg("t-one", [wont("f1", "the refusal self-test drifts past the battery", "deliberate: pinned elsewhere"), open("f2", "self-test vacuous pass")]),
    reg("t-two", [open("f3", "the drift between refusal text and self-test")]),
  ];

  const cases = selfTestCases(registers);
  const loader = selfTestLoader();
  let failures = 0;
  for (const [name, passes] of cases) {
    if (!passes) {
      failures += 1;
      console.error(`retrospective SELF-TEST FAIL: ${name}`);
    }
  }
  failures += loader.failures;
  console.log(
    failures === 0 ? `retrospective self-test: OK (${cases.length} cases + ${loader.count} loader cases)` : `retrospective self-test: FAILED (${failures} failure(s))`,
  );
  return failures === 0;
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  if (process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  const topFlag = process.argv.indexOf("--top");
  const top = topFlag >= 0 ? Number(process.argv[topFlag + 1]) : 12;
  const { registers, skipped } = loadRegisters();
  const index = lessonsIndex(registers);
  if (process.argv.includes("--json")) console.log(JSON.stringify(index));
  else console.log(renderIndex(index, Number.isFinite(top) ? top : 12));
  if (skipped > 0) {
    console.error(`retrospective: skipped ${skipped} malformed register(s) — the count is visible, never silent`);
    process.exitCode = 1;
  }
}
