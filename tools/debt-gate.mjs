#!/usr/bin/env node
/**
 * debt-gate — the register reader: fails when an OPEN row of docs/gates/debt-register.md is past
 * its commit budget.
 *
 * WHY THIS EXISTS (ported from the Antitube harness 2026-09-20; the incident shape stays because
 * it is the whole argument). Upstream, a 2026-07-15 RCA correctly diagnosed 67 accumulated
 * findings and issued 13 prioritized process fixes. ONE shipped. 168 commits later a fresh audit
 * produced 25 MORE findings, dominated by exactly the classes the unshipped 12 targeted. The
 * register existed the whole time — as a document nothing read. Process debt was the only debt
 * with no owner and no due date, so a correct diagnosis decayed into prose. This gate is the
 * reader: "forgotten" becomes a failing check instead of a silent state. A row leaves the
 * register only by shipping (SHIPPED, citing the commit) or by an explicit drop decision recorded
 * verbatim (DROPPED, citing it) — never by being forgotten.
 *
 * CLOCK SEMANTICS (documented in the register itself): budgets count COMMITS SINCE the baseline
 * recorded in the register's own `gate-baseline:` line — reset that line whenever rows ship.
 * Pre-gate elapsed debt lives in the register's prose; the executable clock exists to stop FUTURE
 * decay, not to re-litigate the past on day one with an unpayable red.
 *
 * PARSING LAW — PER-LINE, NEVER DOTALL. A lazy `.*?` across `gms` bleeds one row into the next
 * and swallows the documented `SHIPPED (<date>: <citation>)` annotation form — the gate would
 * misread the register it exists to read. Cells are split literally and read by POSITION (id
 * first, due-by and status last); status matches by PREFIX so citations ride along. And a gate
 * that parses FEWER rows than exist reads green for the wrong reason: the parsed-row count must
 * equal the row-line count, and a register with ZERO rows is a
 * GATE_DEFECT, not an all-clear — an empty register means nobody maintains it, which is the exact
 * decay this gate exists to catch.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const REGISTER_PATH = `${ROOT}docs/gates/debt-register.md`;

/**
 * Pure: parse the register text.
 *
 * Returns `{ baseline, rows }` on success, or `{ defect }` the moment anything is off — a
 * defective gate must not limp along reading half a register green.
 */
export function parseRegister(text) {
  const baselineMatch = /gate-baseline:\s*([0-9a-f]{7,40})/.exec(text);
  if (baselineMatch === null) {
    return { defect: "carries no 'gate-baseline: <commit>' line; the gate cannot count" };
  }
  const baseline = baselineMatch[1];

  // Candidates are WIDER than the row shape: any table line (indented or not) naming a PD id. Each
  // must parse or the register is a defect, so the parsed count equals the row-line count by
  // construction — a row the parser cannot read never silently drops out of the count.
  const rowLines = text.split("\n").filter((line) => /^\s*\|/.test(line) && /\bPD-\d+\b/.test(line));
  const rows = [];
  for (const line of rowLines) {
    const row = parseRow(line);
    if (row === null) return { defect: `unparseable register row: ${line.trim().slice(0, 120)}` };
    rows.push(row);
  }
  // Zero rows is an unmaintained register, not an all-clear one.
  if (rows.length === 0) return { defect: "parsed 0 register rows" };
  return { baseline, rows };
}

/** Pure: one row, read by POSITION — id first, due-by second to last, status last (the register's
 *  fixed shape). A first-match scan let an item cell opening "DROPPED …" pose as the status, so an
 *  OPEN row read closed and never went overdue. null = unparseable. */
function parseRow(line) {
  const cells = line.trim().split("|").slice(1).map((cell) => cell.trim());
  if (cells.at(-1) === "") cells.pop();
  const [id, budgetCell, statusCell] = [cells[0], cells.at(-2), cells.at(-1)];
  if (!/^PD-\d+$/.test(id) || !/^next \d+ commits$/.test(budgetCell) || !/^(OPEN|SHIPPED|DROPPED)\b/.test(statusCell)) return null;
  return { id, budget: Number(/\d+/.exec(budgetCell)[0]), status: /^(OPEN|SHIPPED|DROPPED)/.exec(statusCell)[1] };
}

/** Pure: OPEN rows past their commit budget. The budget is a floor — commit N of "next N" is
 *  inside it; one more is overdue. SHIPPED and DROPPED rows can never go overdue: they left the
 *  clock the honest way. */
export function overdueRows(rows, commitsSince) {
  return rows.filter((row) => row.status === "OPEN" && commitsSince > row.budget);
}

/** Row-shape cases: cells are read by POSITION, and every table line naming a PD id is counted.
 *  The status is the LAST cell, never the first cell that happens to start with a keyword — an
 *  item reading "DROPPED events…" once posed as the status, and the OPEN row never went overdue. */
function rowShapeCases() {
  const register = (...rows) => parseRegister(["gate-baseline: af4fd70dec9d", ...rows, ""].join("\n"));
  return [
    ["an OPEN row whose item starts with DROPPED still reads OPEN and goes overdue", overdueRows(register("| PD-1 | DROPPED events are never retried | audit | P1 | next 5 commits | OPEN |").rows ?? [], 6).map((r) => r.id).join() === "PD-1"],
    ["an indented table row is still a row, counted and parsed", register("  | PD-1 | x | next 5 commits | OPEN |").rows?.length === 1],
    ["a table line naming a PD id outside a clean id cell is a defect, never a silently skipped row", register("| PD-1 | x | next 5 commits | OPEN |", "| **PD-2** | x | next 5 commits | OPEN |").defect !== undefined],
  ];
}

/** Self-test where the refusals are the feature: most cases assert the gate BREAKS on a register
 *  that would otherwise read green. */
export function selfTest() {
  const valid = [
    "# Process-debt register",
    "",
    "gate-baseline: af4fd70dec9d",
    "",
    "| id | item | source | priority | due-by | status |",
    "|---|---|---|---|---|---|",
    "| PD-1 | a real open row | audit 2026-09-19 | P1 | next 10 commits | OPEN |",
    "| PD-2 | shipped with a long citation | audit 2026-09-19 | P2 | next 50 commits | SHIPPED (2026-09-20: `tools/x.mjs`, gate wired) |",
    "| PD-3 | dropped in writing, verbatim | audit 2026-09-19 | P3 | next 25 commits | DROPPED (2026-09-20: owner decision, verbatim) |",
    "",
    "Prose that names PD-4 but starts no pipe is not a row.",
  ].join("\n");

  const parsed = parseRegister(valid);
  const cases = [
    ["a well-formed register parses (3 rows, baseline captured)", parsed.defect === undefined && parsed.baseline === "af4fd70dec9d" && parsed.rows?.length === 3],
    ["status matches by PREFIX, so a SHIPPED citation still parses as SHIPPED", parsed.rows?.[1]?.status === "SHIPPED"],
    ["a DROPPED annotation parses as DROPPED, not OPEN", parsed.rows?.[2]?.status === "DROPPED"],
    ["the budget cell carries its number (next 50 commits -> 50)", parsed.rows?.[1]?.budget === 50],
    ["prose naming a PD id is NOT a row — only line-start pipes are", parseRegister(`${valid}\nPD-4 never started.\n`).rows?.length === 3],
    ["missing gate-baseline is a defect — the gate cannot count", parseRegister("# no baseline here\n| PD-1 | x | next 5 commits | OPEN |\n").defect !== undefined],
    ["a non-hex baseline (gate-baseline: HEAD) is a defect", parseRegister("gate-baseline: HEAD\n| PD-1 | x | next 5 commits | OPEN |\n").defect !== undefined],
    ["ZERO rows is a defect — an empty register is not an all-clear", parseRegister("gate-baseline: af4fd70dec9d\n\n| id | due-by | status |\n|---|---|---|\n").defect !== undefined],
    ["a row missing its budget cell is a defect", parseRegister("gate-baseline: af4fd70dec9d\n| PD-1 | no due-by | OPEN |\n").defect !== undefined],
    ["a row missing a status is a defect", parseRegister("gate-baseline: af4fd70dec9d\n| PD-1 | x | next 5 commits | status forgotten |\n").defect !== undefined],
    ["budget is a floor: commit 10 of 'next 10' is NOT overdue", overdueRows(parsed.rows ?? [], 10).length === 0],
    ["one commit past the budget IS overdue — and only the OPEN row", overdueRows(parsed.rows ?? [], 11).map((r) => r.id).join() === "PD-1"],
    ...rowShapeCases(),
  ];

  // The gate is config-driven, so the config itself is under test: the vendored register must parse.
  let live;
  try {
    live = parseRegister(readFileSync(REGISTER_PATH, "utf8"));
  } catch {
    live = { defect: `${REGISTER_PATH} unreadable` };
  }
  cases.push([`the live register parses with at least one row (${REGISTER_PATH})`, live.defect === undefined && live.rows?.length >= 1]);

  const failures = cases.filter(([, ok]) => !ok).map(([name]) => name);
  console.log(failures.length === 0 ? `debt-gate self-test: OK (${cases.length} cases — the defects are the point)` : `debt-gate self-test: FAILED\n  ${failures.join("\n  ")}`);
  return failures.length === 0;
}

/** The live gate: read the register, count commits since the baseline, refuse on any OPEN row
 *  past due. GATE_DEFECT (the gate itself is broken) exits nonzero exactly like a red verdict —
 *  a broken gate must never read green. */
function runGate() {
  let text;
  try {
    text = readFileSync(REGISTER_PATH, "utf8");
  } catch {
    console.error(`debt-gate GATE_DEFECT — cannot read ${REGISTER_PATH}`);
    process.exit(1);
  }

  const parsed = parseRegister(text);
  if (parsed.defect !== undefined) {
    console.error(`debt-gate GATE_DEFECT — ${REGISTER_PATH} ${parsed.defect}`);
    process.exit(1);
  }

  let commitsSince;
  try {
    commitsSince = Number(execFileSync("git", ["rev-list", "--count", `${parsed.baseline}..HEAD`], { cwd: ROOT, encoding: "utf8" }).trim());
  } catch {
    console.error(`debt-gate GATE_DEFECT — baseline ${parsed.baseline} does not resolve in this clone.`);
    process.exit(1);
  }

  const open = parsed.rows.filter((row) => row.status === "OPEN");
  const overdue = overdueRows(parsed.rows, commitsSince);

  console.log(`debt-gate — ${parsed.rows.length} rows (${open.length} OPEN), ${commitsSince} commits since baseline ${parsed.baseline.slice(0, 7)}.`);
  if (overdue.length > 0) {
    for (const row of overdue) {
      console.error(`  OVERDUE ${row.id}: budget ${row.budget} commits, ${commitsSince} elapsed — ship it, or drop it in writing (cite the decision in the row).`);
    }
    process.exit(1);
  }
  console.log("debt-gate — no OPEN row past due.");
}

/**
 * CLI, guarded by an entry-module check (the pathspec lesson): a bare argv scan fires on IMPORT —
 * the battery and any guard wanting `parseRegister`/`overdueRows` imports this module — and
 * `process.exit()`s before the importer's own self-test can run.
 */
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isEntry) {
  if (process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  runGate();
}
