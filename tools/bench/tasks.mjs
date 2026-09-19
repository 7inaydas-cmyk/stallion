/** The benchmark's task corpus: four small, zero-dependency code tasks, each with a spec,
 *  a seeded source (bug-fix tasks carry planted defects), VISIBLE failing tests (the RED an
 *  honest treatment agent pins), a reference implementation, and HIDDEN acceptance tests that
 *  grade the output. The visible and hidden suites are deliberately different: visible tests
 *  prove the bug exists; hidden tests measure how completely the agent closed it.
 *
 *  Seeds live under apps/lib/ in the sandbox so the treatment arm's commit-msg gate binds
 *  (CODE_TREES covers apps/**) — the harness must gate the exact code under measurement. */

export const TASKS = [
  {
    id: "parse-duration",
    module: "parse-duration",
    kind: "bugfix",
    spec: `Fix the duration parser in apps/lib/parse-duration.mjs so parseDuration(text) returns
milliseconds for strings like "1h30m", "500ms", "2d", "1.5h", "90s", and combinations in any
unit order ("30m1h" is 5400000). Supported units: ms, s, m, h, d. Whitespace between terms is
allowed ("1h 30m"). Numbers may be fractional ("1.5h"). An empty or whitespace-only string
returns 0. An unsupported unit ("1x") throws RangeError with a message containing the offending
unit. A term with no number ("h") throws RangeError too. The visible tests in
apps/lib/parse-duration.test.mjs currently fail — they are the minimum bar, not the whole bar.`,
    seed: `export function parseDuration(text) {
  const UNITS = { ms: 1, s: 1000, m: 60, h: 3600, d: 86400 };
  let total = 0;
  for (const m of String(text).matchAll(/(\\d+)\\s*(ms|s|m|h|d)/g)) {
    total += Number(m[1]) * UNITS[m[2]];
  }
  return total;
}
`,
    visibleTest: `import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "./parse-duration.mjs";

test("compound durations add up", () => assert.equal(parseDuration("1h30m"), 5400000));
test("milliseconds", () => assert.equal(parseDuration("500ms"), 500));
test("days", () => assert.equal(parseDuration("2d"), 172800000));
`,
    hiddenTest: `import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "./apps/lib/parse-duration.mjs";

test("fractional values", () => assert.equal(parseDuration("1.5h"), 5400000));
test("unit order does not matter", () => assert.equal(parseDuration("30m1h"), 5400000));
test("whitespace between terms", () => assert.equal(parseDuration("1h 30m"), 5400000));
test("empty and whitespace-only return 0", () => {
  assert.equal(parseDuration(""), 0);
  assert.equal(parseDuration("   "), 0);
});
test("unsupported unit throws RangeError naming it", () => {
  assert.throws(() => parseDuration("1x"), (e) => e instanceof RangeError && /1x/.test(e.message));
});
test("numberless term throws RangeError", () => {
  assert.throws(() => parseDuration("h"), RangeError);
});
test("seconds and compound with seconds", () => {
  assert.equal(parseDuration("90s"), 90000);
  assert.equal(parseDuration("1m30s"), 90000);
});
test("all units together", () => assert.equal(parseDuration("1d2h3m4s500ms"), 93784500));
`,
    reference: `export function parseDuration(text) {
  const UNITS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const s = String(text);
  if (s.trim() === "") return 0;
  const re = /(\\d+(?:\\.\\d+)?)\\s*(ms|s|m|h|d)/g;
  let total = 0;
  let matched = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    total += Number(m[1]) * UNITS[m[2]];
    matched += 1;
  }
  const stripped = s.replace(/(\\d+(?:\\.\\d+)?)\\s*(ms|s|m|h|d)/g, "").trim();
  if (matched === 0 || stripped !== "") {
    throw new RangeError(\`unsupported duration term in "\${s}\" (near "\${stripped || s}\")\`);
  }
  return total;
}
`,
  },
  {
    id: "lru-cache",
    module: "lru-cache",
    kind: "bugfix",
    spec: `Fix the LRU cache in apps/lib/lru-cache.mjs. new LRUCache(capacity) with get(key),
set(key, value), has(key), delete(key), and size (a getter). get() returns the value or
undefined AND refreshes the key's recency (most recently used). set() on a full cache evicts
the least recently used key. delete() removes a key; size reflects live keys. set() on an
existing key updates the value and refreshes recency. The visible tests currently fail.`,
    seed: `export class LRUCache {
  #map = new Map();
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError("capacity must be a positive integer");
    this.capacity = capacity;
  }
  get(key) {
    return this.#map.get(key);
  }
  set(key, value) {
    if (this.#map.size >= this.capacity && !this.#map.has(key)) {
      this.#map.delete(this.#map.keys().next().value);
    }
    this.#map.set(key, value);
    return this;
  }
  has(key) {
    return this.#map.has(key);
  }
  delete(key) {
    return this.#map.delete(key);
  }
  get size() {
    return this.#map.size;
  }
}
`,
    visibleTest: `import { test } from "node:test";
import assert from "node:assert/strict";
import { LRUCache } from "./lru-cache.mjs";

test("evicts the least recently used key at capacity", () => {
  const c = new LRUCache(2);
  c.set("a", 1).set("b", 2).set("c", 3);
  assert.equal(c.get("a"), undefined);
  assert.equal(c.get("c"), 3);
});
test("get refreshes recency", () => {
  const c = new LRUCache(2);
  c.set("a", 1).set("b", 2);
  c.get("a");
  c.set("c", 3);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("b"), undefined);
});
`,
    hiddenTest: `import { test } from "node:test";
import assert from "node:assert/strict";
import { LRUCache } from "./apps/lib/lru-cache.mjs";

test("set on existing key updates value and refreshes recency", () => {
  const c = new LRUCache(2);
  c.set("a", 1).set("b", 2);
  c.set("a", 9);
  c.set("c", 3);
  assert.equal(c.get("a"), 9);
  assert.equal(c.get("b"), undefined);
});
test("delete frees capacity: the next set evicts nothing", () => {
  const c = new LRUCache(2);
  c.set("a", 1).set("b", 2);
  assert.equal(c.size, 2);
  assert.equal(c.delete("a"), true);
  assert.equal(c.size, 1);
  c.set("c", 3);
  assert.equal(c.size, 2);
  assert.equal(c.get("b"), 2);
  assert.equal(c.get("c"), 3);
});
test("has does not refresh recency (only get and set do)", () => {
  const c = new LRUCache(2);
  c.set("a", 1).set("b", 2);
  c.has("a");
  c.set("c", 3);
  assert.equal(c.get("a"), undefined);
});
test("get of a missing key returns undefined", () => {
  const c = new LRUCache(1);
  assert.equal(c.get("nope"), undefined);
});
test("capacity 1 thrash", () => {
  const c = new LRUCache(1);
  c.set("a", 1);
  assert.equal(c.get("a"), 1);
  c.set("b", 2);
  assert.equal(c.get("a"), undefined);
  assert.equal(c.get("b"), 2);
});
test("constructor rejects bad capacity", () => {
  assert.throws(() => new LRUCache(0), RangeError);
  assert.throws(() => new LRUCache(1.5), RangeError);
});
`,
    reference: `export class LRUCache {
  #map = new Map();
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError("capacity must be a positive integer");
    this.capacity = capacity;
  }
  get(key) {
    if (!this.#map.has(key)) return undefined;
    const value = this.#map.get(key);
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }
  set(key, value) {
    if (this.#map.has(key)) this.#map.delete(key);
    else if (this.#map.size >= this.capacity) this.#map.delete(this.#map.keys().next().value);
    this.#map.set(key, value);
    return this;
  }
  has(key) {
    return this.#map.has(key);
  }
  delete(key) {
    return this.#map.delete(key);
  }
  get size() {
    return this.#map.size;
  }
}
`,
  },
  {
    id: "chunk-generator",
    module: "chunk",
    kind: "feature",
    spec: `Implement the chunk generator in apps/lib/chunk.mjs: chunk(iterable, n) yields arrays of
exactly n items, in order, with a final partial array holding the remainder (or nothing if the
length divides evenly). n must be a positive integer — otherwise throw RangeError with a
message containing "n". Works over any iterable (arrays, generators, strings — strings chunk
by code unit). The visible tests are the starting bar.`,
    seed: `export function chunk(iterable, n) {
  // TODO: implement
  throw new Error("not implemented");
}
`,
    visibleTest: `import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk } from "./chunk.mjs";

test("chunks an array", () => {
  assert.deepEqual([...chunk([1, 2, 3, 4, 5], 2)], [[1, 2], [3, 4], [5]]);
});
test("even division has no empty tail", () => {
  assert.deepEqual([...chunk([1, 2, 3, 4], 2)], [[1, 2], [3, 4]]);
});
`,
    hiddenTest: `import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk } from "./apps/lib/chunk.mjs";

test("lazy: nothing is pulled before the first next()", () => {
  let pulled = 0;
  function* src() { for (let i = 0; i < 3; i += 1) { pulled += 1; yield i; } }
  const it = chunk(src(), 2);
  assert.equal(pulled, 0);
  assert.deepEqual(it.next().value, [0, 1]);
  assert.equal(pulled, 2);
});
test("works over generators end to end", () => {
  function* nat() { for (let i = 1; i <= 7; i += 1) yield i; }
  assert.deepEqual([...chunk(nat(), 3)], [[1, 2, 3], [4, 5, 6], [7]]);
});
test("strings chunk by code unit", () => {
  assert.deepEqual([...chunk("abcde", 2)], ["ab", "cd", "e"]);
});
test("empty iterable yields nothing", () => {
  assert.deepEqual([...chunk([], 3)], []);
});
test("n larger than the iterable yields one partial", () => {
  assert.deepEqual([...chunk([1, 2], 10)], [[1, 2]]);
});
test("bad n throws RangeError naming n", () => {
  assert.throws(() => chunk([1], 0), (e) => e instanceof RangeError && /n/.test(e.message));
  assert.throws(() => chunk([1], -1), RangeError);
  assert.throws(() => chunk([1], 1.5), RangeError);
});
test("Sets are iterable too", () => {
  assert.deepEqual([...chunk(new Set([1, 2, 3]), 2)], [[1, 2], [3]]);
});
`,
    reference: `export function chunk(iterable, n) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new RangeError(\`n must be a positive integer (got \${n})\`);
  }
  return (function* generate() {
    const isString = typeof iterable === "string";
    let buf = [];
    for (const item of iterable) {
      buf.push(item);
      if (buf.length === n) {
        yield isString ? buf.join("") : buf;
        buf = [];
      }
    }
    if (buf.length > 0) yield isString ? buf.join("") : buf;
  })();
}
`,
  },
  {
    id: "csv-fields",
    module: "csv",
    kind: "feature",
    spec: `Implement CSV field escaping in apps/lib/csv.mjs: escapeField(value) returns the minimal
escaping per RFC 4180 — a field is quoted iff it contains a comma, a double quote, or any of
CR or LF; embedded quotes double. parseLine(line) is its inverse: splits one CSV line (no
record splitting) into the original values, throwing SyntaxError on an unterminated quote or a
quote inside an unquoted field. escapeField and parseLine must round-trip: for any value v,
parseLine([a, v, b].map(escapeField).join(",")) deep-equals [a, v, b]. The visible tests are
the starting bar.`,
    seed: `export function escapeField(value) {
  // TODO: implement
  throw new Error("not implemented");
}

export function parseLine(line) {
  // TODO: implement
  throw new Error("not implemented");
}
`,
    visibleTest: `import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeField, parseLine } from "./csv.mjs";

test("plain fields need no quotes", () => {
  assert.equal(escapeField("hello"), "hello");
});
test("quotes escape by doubling inside quotes", () => {
  assert.equal(escapeField('say "hi"'), '"say ""hi"""');
});
test("parse round-trip", () => {
  assert.deepEqual(parseLine("a,b,c"), ["a", "b", "c"]);
});
`,
    hiddenTest: `import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeField, parseLine } from "./apps/lib/csv.mjs";

test("commas force quoting", () => assert.equal(escapeField("a,b"), '"a,b"'));
test("newlines force quoting", () => {
  assert.equal(escapeField("a\\nb"), '"a\\nb"');
  assert.equal(escapeField("a\\rb"), '"a\\rb"');
});
test("empty field stays empty unquoted", () => assert.equal(escapeField(""), ""));
test("parse handles quoted fields with commas and doubled quotes", () => {
  assert.deepEqual(parseLine('a,"b,c","d""e"'), ["a", "b,c", 'd"e']);
});
test("parse handles empty fields and quoted empties", () => {
  assert.deepEqual(parseLine("a,,c"), ["a", "", "c"]);
  assert.deepEqual(parseLine('a,"",c'), ["a", "", "c"]);
});
test("unterminated quote throws SyntaxError", () => {
  assert.throws(() => parseLine('a,"b'), SyntaxError);
});
test("bare quote inside unquoted field throws SyntaxError", () => {
  assert.throws(() => parseLine('a,b"c'), SyntaxError);
});
test("full round-trip incl. hard values", () => {
  const values = ["plain", "with,comma", 'with "quotes"', "with\\nnewline", "", "123"];
  const line = values.map(escapeField).join(",");
  assert.deepEqual(parseLine(line), values);
});
`,
    reference: `const MUST_QUOTE = /[",\\r\\n]/;

export function escapeField(value) {
  const s = String(value);
  if (!MUST_QUOTE.test(s)) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

export function parseLine(line) {
  const out = [];
  let i = 0;
  const s = String(line);
  while (i < s.length) {
    if (s[i] === '"') {
      let value = "";
      i += 1;
      for (;;) {
        const q = s.indexOf('"', i);
        if (q === -1) throw new SyntaxError("unterminated quoted field");
        if (s[q + 1] === '"') {
          value += s.slice(i, q) + '"';
          i = q + 2;
          continue;
        }
        value += s.slice(i, q);
        i = q + 1;
        if (s[i] === ",") {
          i += 1;
          out.push(value);
          break;
        }
        if (i === s.length) {
          out.push(value);
          return out;
        }
        throw new SyntaxError("unexpected data after quoted field");
      }
    } else {
      const c = s.indexOf(",", i);
      const piece = c === -1 ? s.slice(i) : s.slice(i, c);
      if (piece.includes('"')) throw new SyntaxError("quote inside unquoted field");
      if (c === -1) {
        out.push(piece);
        return out;
      }
      out.push(piece);
      i = c + 1;
    }
    if (i === s.length) {
      out.push("");
      return out;
    }
  }
  if (out.length === 0 && s.length === 0) return [""];
  return out;
}
`,
  },
];

export function taskById(id) {
  return TASKS.find((t) => t.id === id) ?? null;
}
