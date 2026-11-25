// Deep edge-case pass for bin/catalog.mjs on top of catalog.test.mjs (which
// covers the real catalog's contents, entry shape, the missing-file path and
// the hide-uninstalled switch end to end).
//
// catalog.mjs is a small synchronous, stateless module: loadCatalog(file)
// parses one JSON file and filters `agents`, tabNote(entry, types) builds a
// string, catalogIds() maps ids. There is no clock, cache, env lookup or
// shared state, so there is no timing surface to race — every case here is
// in-process with node:assert over synthetic catalog files.
//
// Tests that pin down QUIRKS / SUSPECTED BUGS assert the current behaviour
// and say so in a comment (or sit commented out under "// BUG:"); nothing is
// fixed - this job is test-only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadCatalog, tabNote, USAGE_TYPES, catalogIds } from "./catalog.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-deep-"));
// catalog.mjs resolves its default file from import.meta.url and never looks
// at HOME/XDG_*, but point them at the scratch dir anyway so nothing here can
// touch the real home folder.
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  const d = path.join(tmp, k.toLowerCase());
  fs.mkdirSync(d, { recursive: true });
  process.env[k] = d;
}

const EMPTY = { types: {}, agents: [], dropped: {} };
let seq = 0;
// Write `content` (a string, or an object serialised to JSON) to a fresh file
// inside tmp and return its path.
function catalogFile(content, name = "catalog") {
  const p = path.join(tmp, `${String(++seq).padStart(3, "0")}-${name}.json`);
  fs.writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  return p;
}
const valid = (extra = {}) => ({ id: "x", name: "X", bins: ["x-bin"], usageType: "no_usage_data", ...extra });

try {
  // ================================================================ file-level failures
  // Every read/parse failure collapses to the empty catalog, never a throw.
  {
    const dirAsFile = path.join(tmp, "a-directory");
    fs.mkdirSync(dirAsFile);
    assert.deepEqual(loadCatalog(dirAsFile), EMPTY, "a directory where the file should be");
  }
  {
    const p = catalogFile("", "empty");
    assert.deepEqual(loadCatalog(p), EMPTY, "zero-byte file");
  }
  for (const [name, raw] of [
    ["ws", "   \n\t  "],
    ["badjson", "{not json"],
    ["truncated", '{"agents": [{"id": "x"'],
    ["trailing", '{"agents": []} garbage'],
    // QUIRK: a UTF-8 BOM makes JSON.parse throw, so a BOM-saved catalog is
    // silently treated as missing entirely.
    ["bom", "\uFEFF" + JSON.stringify({ agents: [valid()] })],
  ]) {
    const p = catalogFile(raw, name);
    assert.deepEqual(loadCatalog(p), EMPTY, `${name}: unparseable -> empty catalog`);
  }
  {
    const p = catalogFile("{not json");
    fs.chmodSync(p, 0o000);
    try {
      assert.deepEqual(loadCatalog(p), EMPTY, "unreadable file -> empty catalog");
    } finally {
      fs.chmodSync(p, 0o644);
    }
  }
  {
    const target = path.join(tmp, "no-such-target.json");
    const link = path.join(tmp, "dangling-link.json");
    fs.symlinkSync(target, link);
    assert.deepEqual(loadCatalog(link), EMPTY, "dangling symlink -> empty catalog");
    const loopA = path.join(tmp, "loop-a.json");
    const loopB = path.join(tmp, "loop-b.json");
    fs.symlinkSync(loopB, loopA);
    fs.symlinkSync(loopA, loopB);
    assert.deepEqual(loadCatalog(loopA), EMPTY, "symlink loop -> empty catalog");
  }

  // ================================================================ top-level shapes
  // Valid JSON that is not an object, or an object without an agents array,
  // yields empty agents — but `types`/`dropped` still pass through when set.
  for (const raw of ["null", "42", "\"str\"", "true", "[]", "{}", "[1,2,3]"]) {
    const p = catalogFile(raw, "scalar");
    assert.deepEqual(loadCatalog(p), EMPTY, `top-level ${raw} -> empty catalog`);
  }
  for (const agents of ["x", 5, {}, null, true, 0]) {
    const p = catalogFile({ types: { t: { label: "L" } }, agents, dropped: { d: "why" } });
    const r = loadCatalog(p);
    assert.deepEqual(r.agents, [], `agents=${JSON.stringify(agents)} -> []`);
    assert.deepEqual(r.types, { t: { label: "L" } }, "types still returned");
    assert.deepEqual(r.dropped, { d: "why" }, "dropped still returned");
  }

  // ================================================================ agent filtering
  {
    const p = catalogFile({ agents: [valid(), null, false, 0, "", "str", 7, true, [], {}] });
    const r = loadCatalog(p);
    assert.equal(r.agents.length, 1, "only the fully-shaped entry survives");
    assert.equal(r.agents[0].id, "x");
  }
  {
    // Each required field, removed or wrong-typed, drops the entry.
    const bad = [
      { name: "X", bins: ["b"], usageType: "no_usage_data" },          // no id
      { id: "", name: "X", bins: ["b"], usageType: "no_usage_data" },   // empty id
      { id: 0, name: "X", bins: ["b"], usageType: "no_usage_data" },    // falsy id
      { id: "x", bins: ["b"], usageType: "no_usage_data" },             // no name
      { id: "x", name: "", bins: ["b"], usageType: "no_usage_data" },   // empty name
      { id: "x", name: "X", usageType: "no_usage_data" },               // no bins
      { id: "x", name: "X", bins: "x-bin", usageType: "no_usage_data" },// bins not array
      { id: "x", name: "X", bins: {}, usageType: "no_usage_data" },     // bins object
      { id: "x", name: "X", bins: null, usageType: "no_usage_data" },   // bins null
      { id: "x", name: "X", bins: ["b"] },                              // no usageType
      { id: "x", name: "X", bins: ["b"], usageType: "bogus" },          // unknown type
      { id: "x", name: "X", bins: ["b"], usageType: "Session_Weekly" }, // case-sensitive
      { id: "x", name: "X", bins: ["b"], usageType: 5 },                // non-string type
    ];
    for (const [i, a] of bad.entries()) {
      const p = catalogFile({ agents: [a] });
      assert.deepEqual(loadCatalog(p).agents, [], `bad[${i}] dropped: ${JSON.stringify(a).slice(0, 80)}`);
    }
  }
  {
    // Order is preserved and extra fields on a kept entry survive untouched.
    const a = valid({ id: "first", extra: { nested: [1, 2] }, note: "n" });
    const b = valid({ id: "second", bins: ["s1", "s2"], unsure: "why unsure" });
    const c = valid({ id: "third", usageType: "monthly_credits" });
    const p = catalogFile({ agents: [a, b, c] });
    const r = loadCatalog(p);
    assert.deepEqual(r.agents.map((x) => x.id), ["first", "second", "third"]);
    assert.deepEqual(r.agents[0].extra, { nested: [1, 2] }, "unknown fields kept verbatim");
    assert.equal(r.agents[1].unsure, "why unsure");
    assert.equal(r.agents[2].usageType, "monthly_credits");
  }
  // ---- quirks the filter lets through (truthiness, not shape)
  {
    // QUIRK: id/name only need to be truthy — a numeric id and boolean name
    // pass the filter and land in the catalog.
    const p = catalogFile({ agents: [
      { id: 5, name: true, bins: ["b"], usageType: "no_usage_data" },
      { id: "ok", name: "OK", bins: [], usageType: "no_usage_data" },   // empty bins array passes
      { id: "ok2", name: "OK2", bins: ["b", 5, null, {}], usageType: "no_usage_data" }, // bin names unchecked
      { id: "dup", name: "D1", bins: ["b"], usageType: "no_usage_data" },
      { id: "dup", name: "D2", bins: ["b"], usageType: "no_usage_data" }, // duplicate id kept
    ] });
    const r = loadCatalog(p);
    assert.equal(r.agents.length, 5, "quirky entries are kept");
    assert.equal(r.agents[0].id, 5, "QUIRK: numeric id survives");
    assert.equal(r.agents[0].name, true, "QUIRK: boolean name survives");
    assert.deepEqual(r.agents[1].bins, [], "QUIRK: empty bins array is a valid entry");
    assert.equal(r.agents[3].id, r.agents[4].id, "QUIRK: duplicate ids are not deduped");
  }
  {
    // An own "__proto__" key from JSON.parse is data, not pollution.
    const p = catalogFile('{"agents":[{"id":"p","name":"P","bins":["b"],"usageType":"no_usage_data","__proto__":{"polluted":true}}]}');
    const r = loadCatalog(p);
    assert.equal(r.agents.length, 1);
    assert.equal({}.polluted, undefined, "no prototype pollution");
    assert.equal(r.agents[0].__proto__.polluted, true, "the key is kept as own data");
  }

  // ================================================================ types / dropped passthrough
  {
    // `c.types || {}` and `c.dropped || {}` only replace falsy values: a truthy
    // non-object (array, string, number) is returned verbatim.
    for (const types of [[], "str", 5, true]) {
      const p = catalogFile({ types, agents: [] });
      const r = loadCatalog(p);
      assert.deepEqual(r.types, types, `QUIRK: types=${JSON.stringify(types)} passes through`);
    }
    for (const dropped of [[], "str", 5]) {
      const p = catalogFile({ dropped, agents: [] });
      const r = loadCatalog(p);
      assert.deepEqual(r.dropped, dropped, `QUIRK: dropped=${JSON.stringify(dropped)} passes through`);
    }
    for (const types of [null, 0, false, ""]) {
      const p = catalogFile({ types, agents: [] });
      assert.deepEqual(loadCatalog(p).types, {}, `falsy types=${JSON.stringify(types)} -> {}`);
    }
    const p = catalogFile({ agents: [valid()] });
    const r = loadCatalog(p);
    assert.deepEqual(r.types, {}, "missing types -> {}");
    assert.deepEqual(r.dropped, {}, "missing dropped -> {}");
  }

  // ================================================================ freshness / file argument forms
  {
    // No caching: rewriting the file between calls is picked up immediately.
    const p = catalogFile({ agents: [valid({ id: "v1" })] });
    assert.deepEqual(loadCatalog(p).agents.map((a) => a.id), ["v1"]);
    fs.writeFileSync(p, JSON.stringify({ agents: [valid({ id: "v2" })] }));
    assert.deepEqual(loadCatalog(p).agents.map((a) => a.id), ["v2"], "second read sees the new file");
  }
  {
    // A file: URL works as the `file` argument (fs.readFileSync accepts it).
    const p = catalogFile({ agents: [valid({ id: "via-url" })] });
    assert.deepEqual(loadCatalog(pathToFileURL(p)).agents.map((a) => a.id), ["via-url"]);
  }
  {
    // Two different files are independent; a bad one does not poison a good one.
    const good = catalogFile({ agents: [valid({ id: "good" })] });
    const bad = catalogFile("{oops");
    assert.equal(loadCatalog(good).agents.length, 1);
    assert.deepEqual(loadCatalog(bad), EMPTY);
    assert.equal(loadCatalog(good).agents.length, 1, "good file still loads after a bad one");
  }

  // ================================================================ tabNote
  {
    const types = { t: { label: "A label", tabNote: "type note" } };
    // tabText wins outright: returned verbatim, no label head, no unsure tail.
    assert.equal(tabNote({ tabText: "Fixed tab", usageType: "t", note: "n", unsure: "u" }, types), "Fixed tab");
    // QUIRK: tabText only needs to be truthy — a non-string is returned as-is.
    assert.equal(tabNote({ tabText: 42, note: "n" }, types), 42, "QUIRK: numeric tabText returned unstringified");
    assert.equal(tabNote({ tabText: { x: 1 }, note: "n" }, types).x, 1, "QUIRK: object tabText returned as-is");
    // Empty-string tabText is falsy -> falls through to the note path.
    assert.equal(tabNote({ tabText: "", usageType: "t", note: "the note" }, types), "A label. the note");
  }
  {
    const types = { t: { label: "A label" } };
    assert.equal(tabNote({ usageType: "t", note: "the note" }, types), "A label. the note");
    assert.equal(tabNote({ usageType: "t", note: "the note", unsure: "because" }, types),
      "A label. the note (Not fully verified: see agents-catalog.json.)");
    // `unsure` is a truthiness check: any truthy value appends the suffix.
    assert.match(tabNote({ usageType: "t", note: "n", unsure: true }, types), /Not fully verified/);
    assert.doesNotMatch(tabNote({ usageType: "t", note: "n", unsure: "" }, types), /Not fully verified/);
  }
  {
    // Missing/blank pieces degrade quietly.
    assert.equal(tabNote({ usageType: "unknown", note: "just a note" }, { t: { label: "L" } }), "just a note",
      "a usageType with no types entry has no heading");
    assert.equal(tabNote({ usageType: "t", note: "n" }, { t: {} }), "n", "no label -> no heading");
    assert.equal(tabNote({ usageType: "t", note: "n" }, { t: { label: "" } }), "n", "empty label -> no heading");
    assert.equal(tabNote({ usageType: "t" }, { t: { label: "L" } }), "L.", "missing note -> heading only");
    assert.equal(tabNote({}, {}), "", "empty entry and empty types -> empty string");
    // Non-string label/note are coerced by template/join, not rejected.
    assert.equal(tabNote({ usageType: "t", note: 7 }, { t: { label: 5 } }), "5. 7", "numbers stringified");
    assert.equal(tabNote({ usageType: "t", note: "n" }, { t: { label: "L", tabNote: "ignored here" } }), "L. n",
      "types[].tabNote is metadata for collect.mjs, not used by tabNote()");
    // Scalar `types` values don't throw: property access on a string/number is undefined.
    assert.equal(tabNote({ usageType: "t", note: "n" }, "scalar"), "n");
    assert.equal(tabNote({ usageType: "t", note: "n" }, 5), "n");
  }

  // ================================================================ catalogIds
  {
    // Fresh array every call: mutating the result cannot corrupt the next one.
    const first = catalogIds();
    assert.ok(Array.isArray(first) && first.every((id) => typeof id === "string"));
    first.push("injected");
    assert.ok(!catalogIds().includes("injected"), "catalogIds returns a new array each call");
    // It has no file parameter: it always reads the built-in agents-catalog.json,
    // so the missing/corrupt-file paths are only reachable through loadCatalog(file).
    assert.deepEqual(catalogIds(), loadCatalog().agents.map((a) => a.id));
  }

  // BUG (reported, not fixed): tabNote is not defensive about its arguments.
  // loadCatalog is careful to never return null types/entries, but tabNote is
  // exported and crashes on them:
  //   tabNote(null, {})        -> TypeError: Cannot read properties of null
  //   tabNote({usageType:"t"}, null) -> TypeError: Cannot read properties of null
  // A `types?.[entry?.usageType]`-style guard (or a JSDoc contract) would close it.
  // assert.throws(() => tabNote(null, {}), TypeError);
  // assert.throws(() => tabNote({ usageType: "t", note: "n" }, null), TypeError);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log("catalog.deep: all tests passed");
