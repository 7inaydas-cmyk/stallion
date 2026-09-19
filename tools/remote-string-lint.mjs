#!/usr/bin/env node
/**
 * REMOTE-STRING LINT — a backtick inside a double-quoted shell string is COMMAND SUBSTITUTION.
 *
 * WHY THIS EXISTS (origin-repo incident, lesson kept on port). A deploy script builds the commands
 * it runs on the live host as double-quoted strings, because it has to interpolate local values
 * (the image name, the SHA, the compose flags) before shipping them. Everything else inside those
 * strings is then also subject to expansion — including comments. A comment reading
 *
 *     # `manifest inspect` answers the real question
 *
 * made bash run `manifest` LOCALLY at the moment the string was BUILT, not on the host, and killed
 * the preflight with "manifest: command not found" before it ever reached the machine.
 *
 * THE PART THAT MATTERS: the bug was written days earlier and no gate saw it. `bash -n` parses it
 * as valid (it IS valid, it just does something else), and a deploy freeze meant the block had
 * never once executed. It was found by running the code, which is the only thing that ever finds
 * this class. So this lint is the standing replacement for "somebody runs it".
 *
 * WHAT IT CHECKS. Inside a double-quoted block opened by `--command "` or `<NAME>_REMOTE="` and
 * closed by a line that is a lone `"`:
 *   - an UNESCAPED backtick        → command substitution, evaluated locally. ERROR.
 *   - an UNESCAPED `$(`            → same. ERROR.
 * `\`` and `\$(` are correct and pass: they reach the host literally.
 *
 * THE CORPUS IS CONFIGURED, NOT CODED. The walked glob and the floors live in
 * docs/gates/remote-string.json (see `loadConfig`). If that file is missing or unparseable the
 * gate FAILS CLOSED — a gate that cannot read its own state must not pass.
 *
 * Run: node tools/remote-string-lint.mjs [--self-test]
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { matches } from "./pathspec.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = resolve(ROOT, "docs/gates/remote-string.json");
const CONFIG_REL = "docs/gates/remote-string.json";
const DEFAULT_CONFIG_SHAPE = '{"walk": "deploy/**/*.sh", "minScripts": 0, "minDispatchers": 0}';

/**
 * Load the corpus config. Returns `{ ok: true, config }` or `{ ok: false, reason }` — never throws
 * to the caller, because the failure IS the verdict: missing file, unparseable JSON, or a wrong
 * shape all mean this gate cannot know what it is supposed to guard, and must not pass.
 *
 * Keys: `walk` (required — a pathspec glob matched against repo-relative paths),
 * `minScripts` / `minDispatchers` (optional integers >= 0, default 0). Keys starting with `_` are
 * comment-keys and are ignored; JSON has no comments and the config needs one.
 */
export function loadConfig(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { ok: false, reason: `cannot read ${path} (${error.code ?? error.message})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `unparseable JSON in ${path} (${error.message})` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `${path}: top level must be an object` };
  }
  if (typeof parsed.walk !== "string" || parsed.walk.length === 0) {
    return { ok: false, reason: `${path}: "walk" must be a non-empty glob string, e.g. "deploy/**/*.sh"` };
  }
  const floor = (v) =>
    v === undefined ? 0 : Number.isInteger(v) && v >= 0 ? v : null;
  const minScripts = floor(parsed.minScripts);
  const minDispatchers = floor(parsed.minDispatchers);
  if (minScripts === null || minDispatchers === null) {
    return { ok: false, reason: `${path}: "minScripts" and "minDispatchers" must be integers >= 0` };
  }
  return { ok: true, config: { walk: parsed.walk, minScripts, minDispatchers } };
}

/**
 * THE CORPUS IS DISCOVERED, NOT ENUMERATED.
 *
 * At the origin repo this was a hand-maintained four-file list — and a fifth script that shipped
 * THREE multi-line remote command blocks to the live host (including the one that took a `pg_dump`
 * before a migration) was never in it. It was unlinted from the day it was written. Measured
 * before the fix: planting the exact incident defect — a comment reading
 * ``# `manifest inspect` answers the real question`` — inside that script left this lint reporting
 * "no local expansion" and exiting 0. Its own self-test passed throughout, because the self-test
 * drove `scan()` on synthetic strings and never once asked whether the corpus was complete.
 *
 * That is "a control that cannot see the file cannot fire", and the list is why. Discovering the
 * corpus removes the failure mode rather than correcting one instance of it. The WALK PATTERN
 * comes from the config, so each repo states what its corpus is instead of inheriting ours.
 */
export function walkScripts(root, spec) {
  const out = [];
  const descend = (abs, rel) => {
    for (const entry of readdirSync(abs)) {
      if (entry === ".git" || entry === "node_modules") continue;
      const childAbs = join(abs, entry);
      const childRel = rel === "" ? entry : `${rel}/${entry}`;
      const stat = statSync(childAbs, { throwIfNoEntry: false });
      if (stat?.isDirectory()) descend(childAbs, childRel);
      else if (stat?.isFile() && matches(childRel, spec)) out.push(childRel);
    }
  };
  descend(root, "");
  return out.sort();
}

/**
 * The FLOORS, also from the config — a floor, not a list. If discovery ever returns fewer scripts
 * than this, something has broken in the walk and the lint must fail LOUDLY rather than quietly
 * scan less. It is deliberately not the set of files to check — that is discovered — only the
 * count below which "found nothing" is more likely than "the repo shrank".
 *
 * There is also a floor on the DISPATCHER count, and it is the more important of the two. At the
 * origin repo there was a loud floor on the number of scripts discovered and NONE on the number of
 * remote-dispatch wrappers found — so a collapse of the union disarmed the lint for the whole
 * corpus while it still printed a healthy-looking script count and exited 0. A single `}` used as
 * DATA inside a wrapper body is enough to do it — the brace reader is quote-blind, so the body is
 * truncated before its `ssh` and the wrapper drops out. The floor turns that from silence into a
 * GATE DEFECT.
 *
 * Both default to 0 in this repo's config: zero deploy scripts exist yet, and a floor above the
 * real corpus would make the gate unpassable. Raise them the moment the corpus exists — the
 * comment-key in the config says so.
 */
export function floorDefects({ scripts, wrappers = null }, config) {
  const defects = [];
  if (scripts.length < config.minScripts) {
    defects.push(
      `discovered only ${scripts.length} script(s) under ${config.walk}, expected at least ${config.minScripts}`,
    );
  }
  if (wrappers !== null && wrappers.length < config.minDispatchers) {
    defects.push(
      `only ${wrappers.length} remote-dispatch wrapper(s) found, expected at least ${config.minDispatchers} — ` +
        `the union collapsed, which disarms this lint for EVERY file (found: ${wrappers.join(", ") || "(none)"})`,
    );
  }
  return defects;
}

/**
 * Names of remote-dispatch WRAPPER functions defined in this file.
 *
 * The origin repo already used the pattern a migration plan proposed adopting repo-wide:
 *
 *     remote() { gcloud compute ssh "$VM_NAME" --zone "$VM_ZONE" --command "$1"; }
 *
 * A call to it opens a remote string with `remote "` — which matches NEITHER of the two static
 * openers below. So the wrapper form was invisible even where the file was scanned, and adopting
 * it everywhere would have switched this gate off for every file it currently protected, with
 * every gate still green.
 *
 * Detecting the wrapper by its BODY rather than its name is what makes this survive that
 * migration: a wrapper that shells out with plain `ssh` instead of `gcloud compute ssh` is found
 * too, and a rename from `remote` to anything else is found automatically.
 *
 * ⚠ SAME-FILE DETECTION IS NOT ENOUGH, and this was found by testing rather than by reading. A
 * plan proposed extracting the wrapper into a shared `lib/` and sourcing it everywhere. A caller
 * then contains NO wrapper definition, so per-file detection returns nothing and `remote_run "`
 * stops being an opener — measured: a planted backtick behind a sourced wrapper left this lint
 * printing "no local expansion" and exiting 0.
 *
 * So the names are unioned across the WHOLE corpus by `corpusWrapperNames`, not read per file. A
 * function that dispatches remotely is a remote dispatcher wherever it was declared, and the union
 * errs toward scanning MORE lines, which is the fail-safe direction.
 */
export function remoteWrapperNames(text) {
  const names = [];
  for (const { name, body } of shellFunctions(text)) {
    if (/\b(?:gcloud\s+compute\s+ssh|ssh)\b/.test(body)) names.push(name);
  }
  return [...new Set(names)];
}

/**
 * Every shell function in `text`, with its FULL body.
 *
 * Bodies are read to the matching brace, not to the end of the declaring line. The single-line form
 * was a real blind spot and it bit immediately: a shared lib declared `remote_run()` with a
 * multi-line `case` body, so a first-line-only scan found NO dispatchers in the whole corpus and
 * the union came back empty — silently, because an empty union simply means "no wrapper openers"
 * rather than an error.
 */
export function shellFunctions(text) {
  const out = [];
  // Comment lines are removed first: a `# ... ssh ...` line inside a body made an innocent function
  // look like a dispatcher, and a comment mentioning a wrapper name made prose an opener. The lint
  // must be derived from executable text only.
  text = text
    .split("\n")
    .map((line) => (/^\s*#/.test(line) ? "" : line))
    .join("\n");
  const re = /^[ \t]*([a-z_]\w*)\s*\(\)\s*\{/gm;
  let m = re.exec(text);
  while (m !== null) {
    const open = text.indexOf("{", m.index);
    let depth = 0;
    let end = text.length;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (m[1] !== undefined) out.push({ name: m[1], body: text.slice(open + 1, end) });
    m = re.exec(text);
  }
  return out;
}

/**
 * Every remote-dispatch wrapper name declared ANYWHERE in the corpus, unioned.
 *
 * Computed once per run and passed in, so a wrapper extracted into a shared lib still opens a block
 * in the files that source it. Falls back to same-file names when a caller passes nothing (the
 * self-test drives `scan()` on bare strings).
 */
export function corpusWrapperNames(files, read) {
  const texts = files.map((file) => read(file));
  const names = new Set();
  for (const text of texts) {
    for (const name of remoteWrapperNames(text)) names.add(name);
  }

  // TRANSITIVE CLOSURE — a function whose body calls a known dispatcher IS a dispatcher.
  //
  // Found by executing the very refactor this union was built for. Routing a script through the
  // shared seam turned its wrapper into
  //     remote() { remote_run "$1"; }
  // whose body contains no `ssh` at all, so direct detection lost it and the file's three
  // multi-line blocks stopped being scanned. The planted incident defect went green again — one
  // layer deeper than the same-file blindness, and invisible except that the "dispatching" count
  // fell by one.
  //
  // Iterated to a fixed point rather than one hop, because an indirection can be two deep and
  // stopping early would just move the blind spot.
  let grew = true;
  while (grew) {
    grew = false;
    for (const text of texts) {
      for (const name of indirectWrapperNames(text, names)) {
        if (!names.has(name)) {
          names.add(name);
          grew = true;
        }
      }
    }
  }
  return [...names];
}

/** Functions whose single-line body invokes one of the already-known dispatcher names. */
export function indirectWrapperNames(text, known) {
  const out = [];
  for (const { name, body } of shellFunctions(text)) {
    for (const candidate of known) {
      if (candidate !== name && new RegExp(`\\b${candidate}\\b`).test(body)) {
        out.push(name);
        break;
      }
    }
  }
  return out;
}

/** `--command "` or `NAME_REMOTE="` at end of line — the two static openers. */
const OPENS = /(--command\s+"|^[A-Z_]+_REMOTE=")\s*$/;
// The closers that actually occur: a lone `"`, `" | tee ...`, `" || fail ...`. A continuation line
// that merely STARTS with a quote (`  "https://..."`) is not a closer, which is why the quote must
// be followed by end-of-line or a pipe. Getting this wrong is not a small bug: an unclosed block
// makes every later line read as "inside", and the lint then reports the rest of the file.
const CLOSES = /^\s*"(\s*$|\s*\|\|?(\s|$))/;
// Deliberate local evaluation does exist — a script composes an optional command into the remote
// script on purpose. Marked, not guessed: an unmarked one is still an error.
const ALLOW = /lint-allow-local-expansion/;

/** Either static opener, or a call to a remote-dispatch wrapper this file defines. */
function opensBlock(line, wrapperOpens) {
  if (OPENS.test(line)) return true;
  return wrapperOpens !== null && wrapperOpens.test(line);
}

/**
 * The kind of LIVE expansion on this line, or null.
 *
 * Correctly-escaped forms are stripped first — `\``  and `\$(` reach the host literally and are
 * exactly what the fix for this class looks like — so whatever survives the strip is evaluated
 * locally when the string is BUILT.
 */
function liveExpansion(line) {
  const live = line.replace(/\\`/g, "").replace(/\\\$\(/g, "");
  if (live.includes("`")) return "backtick";
  if (live.includes("$(")) return "$(";
  return null;
}

/**
 * Findings for one script's text. Exported shape so the self-test drives the real function.
 *
 * Openers are the two static forms PLUS a call to any remote-dispatch wrapper this file defines
 * (see `remoteWrapperNames`), so the one-line-wrapper style is covered wherever it is adopted.
 */
export function scan(text, file = "<input>", corpusWrappers) {
  const out = [];
  // Corpus-wide names when we have them; the file's own otherwise.
  const wrappers = corpusWrappers ?? remoteWrapperNames(text);
  // `remote "` at end of line. A call that opens AND closes on one line (`remote "sha256sum x"`)
  // is not a block and must not open one, which is why the quote has to end the line.
  // NOT anchored to line start, deliberately. `OPENS` matches `--command "` anywhere on the line, so
  // the literal transport was caught behind any prefix; anchoring the wrapper form NARROWED the lint
  // at the exact moment call sites moved onto it. These shapes all occur and were silent:
  // `if remote_run "`, `OUT=$(remote_run "`, `printf x | remote_run "`.
  const wrapperOpens =
    wrappers.length > 0 ? new RegExp(`(?:^|[\\s;&|(]|\\$\\()(?:${wrappers.join("|")})\\s+"\\s*$`) : null;
  let inside = false;
  text.split("\n").forEach((line, i) => {
    if (!inside) {
      if (opensBlock(line, wrapperOpens)) inside = true;
      return;
    }
    if (CLOSES.test(line)) {
      inside = false;
      return;
    }
    if (ALLOW.test(line)) return;
    const kind = liveExpansion(line);
    if (kind !== null) out.push({ file, line: i + 1, kind, text: line.trim() });
  });
  return out;
}

function selfTest() {
  const cases = [
    // [name, input, expected finding count]
    ["a bare backtick in a remote comment is caught", 'x --command "\n  # `foo` bar\n"\n', 1],
    ["an escaped backtick is fine", 'x --command "\n  # \\`foo\\` bar\n"\n', 0],
    ["a bare $( in a remote line is caught", 'x --command "\n  A=$(date)\n"\n', 1],
    ["an escaped \\$( is fine", 'x --command "\n  A=\\$(date)\n"\n', 0],
    ["a backtick OUTSIDE any remote block is fine", "# `local comment`\necho hi\n", 0],
    ["NAME_REMOTE= opens a block too", 'PREFLIGHT_REMOTE="\n  # `x`\n"\n', 1],
    ["the block closes on a lone quote", 'x --command "\n  echo hi\n"\n# `after` is local\n', 0],
    ["two blocks are both scanned", 'a --command "\n  # `p`\n"\nb --command "\n  # `q`\n"\n', 2],
    ["escaped and bare on the same line still fires", 'x --command "\n  # \\`ok\\` and `bad`\n"\n', 1],
    ["a line with neither is silent", 'x --command "\n  echo plain\n"\n', 0],
    ['a `" || fail` closer really closes', 'x --command "\n  echo hi\n" || fail "boom"\n# `after` is local\n', 0],
    ['a `" | tee` closer really closes', 'x --command "\n  echo hi\n" | tee f\n# `after` is local\n', 0],
    ["a continuation line starting with a quote is NOT a closer", 'x --command "\n  \"https://h\" \\\n  # `bad`\n"\n', 1],
    ["an explicitly marked local expansion is allowed", 'x --command "\n  $( echo hi ) # lint-allow-local-expansion\n"\n', 0],
    ["an UNmarked local expansion beside a marked one still fires", 'x --command "\n  $( a ) # lint-allow-local-expansion\n  $( b )\n"\n', 1],
    // ── the wrapper-call opener. A script at the origin repo already dispatched this way and a
    // migration proposed adopting it repo-wide; before these cases the form opened no block at
    // all, so adopting it would have silently switched this gate off everywhere.
    [
      "a WRAPPER-opened block is scanned",
      'remote() { gcloud compute ssh "$V" --command "$1"; }\nremote "\n  # `bad`\n"\n',
      1,
    ],
    [
      "a wrapper defined with PLAIN ssh is detected too — this is what survives a transport migration",
      'remote() { ssh "$HOST" "$1"; }\nremote "\n  # `bad`\n"\n',
      1,
    ],
    [
      "a SINGLE-LINE wrapper call does not open a block",
      'remote() { ssh "$H" "$1"; }\nremote "sha256sum x"\n# `after` is local\n',
      0,
    ],
    [
      "`remote \"` is NOT an opener in a file that defines no such wrapper",
      'remote "\n  # `not a remote block`\n"\n',
      0,
    ],
    [
      "a renamed wrapper is still found — the name is discovered, not assumed",
      'on_host() { gcloud compute ssh "$V" --command "$1"; }\non_host "\n  # `bad`\n"\n',
      1,
    ],
    [
      "escaping inside a wrapper block is still correct and passes",
      'remote() { ssh "$H" "$1"; }\nremote "\n  A=\\$(date)\n"\n',
      0,
    ],
    // ── the CROSS-FILE union. The seam puts the wrapper in a shared lib and sources it, so the
    // CALLER declares nothing. Measured before the fix: a planted backtick behind a sourced
    // wrapper left the lint printing "no local expansion", exit 0.
    [
      "a wrapper CALL with no local definition is scanned when the corpus knows the name",
      'source "$(dirname "$0")/lib/remote.sh"\nremote_run "\n  # `bad`\n"\n',
      1,
      ["remote_run"],
    ],
    [
      "...and is NOT scanned without it — this is the blindness the union removes, pinned deliberately",
      'source "$(dirname "$0")/lib/remote.sh"\nremote_run "\n  # `bad`\n"\n',
      0,
    ],
    [
      "a corpus name does not make an unrelated quoted line an opener",
      'echo "hello"\n# `local comment`\n',
      0,
      ["remote_run"],
    ],
  ];
  let failed = 0;
  for (const [name, input, want, corpusWrappers] of cases) {
    const got = scan(input, "<input>", corpusWrappers).length;
    if (got !== want) {
      console.error(`  ✖ ${name}: expected ${want} finding(s), got ${got}`);
      failed += 1;
    }
  }
  // The unioner, driven directly: names must be collected across FILES, not just within one.
  const union = corpusWrapperNames(["a", "b"], (f) =>
    f === "a" ? 'remote_run() { ssh "$H" "$1"; }\n' : 'on_host() { gcloud compute ssh "$V" --command "$1"; }\n',
  );
  if (!union.includes("remote_run") || !union.includes("on_host")) {
    console.error("  ✖ corpusWrapperNames did not union wrapper names across files");
    failed += 1;
  }

  // ── the CONFIG, fail-closed: each of these is a way the gate could otherwise quietly pass
  // with no idea what it is guarding. Fixtures are real files in a temp dir, not parsed strings,
  // because the missing/unreadable cases are the point.
  const tmp = mkdtempSync(join(tmpdir(), "remote-string-lint-"));
  let extra = 0;
  const expect = (name, pass) => {
    extra += 1;
    if (!pass) {
      console.error(`  ✖ ${name}`);
      failed += 1;
    }
  };
  try {
    const write = (name, body) => writeFileSync(join(tmp, name), body);
    write("good.json", '{"_comment": "ignored", "walk": "deploy/**/*.sh", "minScripts": 2, "minDispatchers": 1}');
    const good = loadConfig(join(tmp, "good.json"));
    expect("a valid config parses with its floors and ignoring comment-keys", good.ok && good.config.walk === "deploy/**/*.sh" && good.config.minScripts === 2 && good.config.minDispatchers === 1);
    expect("a MISSING config fails closed", loadConfig(join(tmp, "absent.json")).ok === false);
    write("bad.json", "{not json");
    expect("an UNPARSEABLE config fails closed", loadConfig(join(tmp, "bad.json")).ok === false);
    write("nowalk.json", '{"minScripts": 1}');
    expect("a config with no walk glob fails closed", loadConfig(join(tmp, "nowalk.json")).ok === false);
    write("badfloor.json", '{"walk": "deploy/**/*.sh", "minScripts": "many"}');
    expect("a non-integer floor fails closed", loadConfig(join(tmp, "badfloor.json")).ok === false);

    // ── the DISCOVERY WALK: the corpus is discovered, so the walk itself needs a test that asks
    // whether files are FOUND, which the original self-test never did.
    mkdirSync(join(tmp, "deploy/lib"), { recursive: true });
    mkdirSync(join(tmp, "src"), { recursive: true });
    write("deploy/a.sh", "echo a\n");
    write("deploy/lib/b.sh", "echo b\n");
    write("src/c.sh", "echo c\n");
    const found = walkScripts(tmp, "deploy/**/*.sh");
    expect("the walk discovers scripts at every depth under the configured glob", found.join(",") === "deploy/a.sh,deploy/lib/b.sh");
    expect("the walk does not reach outside the configured glob", !found.some((f) => f.startsWith("src/")));

    // ── the FLOORS: below the floor is a GATE DEFECT, at or above it is not.
    const config = { walk: "deploy/**/*.sh", minScripts: 2, minDispatchers: 1 };
    expect("floors satisfied is not a defect", floorDefects({ scripts: ["a", "b"], wrappers: ["w"] }, config).length === 0);
    expect("too few discovered SCRIPTS is a defect", floorDefects({ scripts: ["a"], wrappers: ["w"] }, config).length === 1);
    expect("too few discovered DISPATCHERS is a defect", floorDefects({ scripts: ["a", "b"], wrappers: [] }, config).length === 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (failed) {
    console.error(`remote-string-lint self-test: ${failed} case(s) FAILED`);
    return false;
  }
  console.log(`remote-string-lint self-test: OK (${cases.length} cases + ${extra + 1} config/walk/floor checks)`);
  return true;
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest() ? 0 : 1;

  // The self-test runs BEFORE the lint on every gate run, not only on demand: a broken checker
  // must fail with an explicit self-test message naming the broken case, rather than emitting a
  // mysterious finding against innocent scripts. (Ordering lesson from the origin repo's
  // self-replacement incident: the repair path must never depend on the broken thing passing.)
  if (!selfTest()) {
    console.error("remote-string-lint — GATE DEFECT: self-test failed; the checker itself is broken.");
    return 1;
  }

  const loaded = loadConfig(CONFIG_PATH);
  if (!loaded.ok) {
    console.error(`\nremote-string-lint — GATE DEFECT: ${loaded.reason}.`);
    console.error("  A gate that cannot read its own state must not pass; this one fails closed.");
    console.error(`  fix: restore ${CONFIG_REL} — ${DEFAULT_CONFIG_SHAPE}\n`);
    return 1;
  }
  const config = loaded.config;

  const scripts = walkScripts(ROOT, config.walk);

  // Discovery breaking is a GATE DEFECT, not a pass. Before floors existed the walk could have
  // returned nothing and the lint would have printed "0 script(s) ... no local expansion" and
  // exited 0.
  const defects = floorDefects({ scripts }, config);
  if (defects.length > 0) {
    console.error(`\nremote-string-lint — GATE DEFECT: ${defects.join("; ")}.`);
    console.error("  Either the walk is broken or the scripts moved. Do not lower a floor to make this pass.\n");
    return 1;
  }

  // Unioned BEFORE the scan, so a wrapper in a shared lib is known to every caller that sources it.
  const wrappers = corpusWrapperNames(scripts, (rel) => readFileSync(resolve(ROOT, rel), "utf8"));
  const dispatcherDefects = floorDefects({ scripts, wrappers }, config).filter((d) => !defects.includes(d));
  if (dispatcherDefects.length > 0) {
    console.error(`\nremote-string-lint — GATE DEFECT: ${dispatcherDefects.join("; ")}.`);
    console.error("  Do not lower a floor to make this pass.\n");
    return 1;
  }

  let withRemoteBlocks = 0;
  let findings = [];
  for (const rel of scripts) {
    // NOT wrapped in try/continue. A discovered file that cannot be read is a broken walk,
    // and a silent `continue` meant a renamed script simply stopped being checked.
    const text = readFileSync(resolve(ROOT, rel), "utf8");
    const found = scan(text, rel, wrappers);
    if (OPENS.test(text) || text.includes("--command") || wrappers.some((w) => new RegExp(`^\\s*${w}\\s+"`, "m").test(text))) {
      withRemoteBlocks += 1;
    }
    findings = findings.concat(found);
  }

  if (findings.length > 0) {
    console.error(`\nremote-string-lint — ${findings.length} live expansion(s) inside a remote command string:\n`);
    for (const f of findings) {
      console.error(`  ✖ ${f.file}:${f.line}  unescaped ${f.kind}`);
      console.error(`      ${f.text.slice(0, 100)}`);
    }
    console.error(`
  A double-quoted string expands backticks and $( ) where it is BUILT, not where it is sent.
  Either escape them (\\\` , \\$( ) so they reach the host literally, or — better for prose —
  move the comment ABOVE the string, where a backtick is just a character.
`);
    return 1;
  }
  console.log(
    `remote-string-lint — ${scripts.length} script(s) discovered under ${config.walk}, ${withRemoteBlocks} dispatching remote commands; no local expansion inside a remote string.`,
  );
  return 0;
}

/**
 * CLI, guarded by an entry-module check (pathspec's lesson): this module exports its checks and
 * imports pathspec, so a bare argv test would fire the CLI on IMPORT — both this file's and
 * pathspec's — before any importer's own self-test could run.
 */
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  process.exit(main());
}
