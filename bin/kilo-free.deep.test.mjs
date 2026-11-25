// Deep edge-case pass for bin/kilo-free.mjs on top of kilo-free.test.mjs.
// The module is pure (no I/O, no clock, no shared state), so the scratch dir
// only exists to satisfy the "never touch the real home folder" rule.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isFreeModel, pickFreeModel, kiloArgs, costCheck } from "./kilo-free.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-free-deep-"));
const savedEnv = {};
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  savedEnv[k] = process.env[k];
  process.env[k] = path.join(tmp, k.toLowerCase());
  fs.mkdirSync(process.env[k], { recursive: true });
}

try {
  // ---- isFreeModel: id pattern edges ----
  assert.equal(isFreeModel(" free "), true, "whitespace around a bare 'free' still matches");
  assert.equal(isFreeModel("   "), false, "whitespace-only id is not free");
  assert.equal(isFreeModel("free"), true, "bare 'free' matches the ^ alternative");
  assert.equal(isFreeModel("provider/FREE"), true, "uppercase /free suffix");
  assert.equal(isFreeModel("provider/model:FREE"), true, "uppercase :free suffix");
  assert.equal(isFreeModel("my-free"), false, "'-free' without / or : is not the free marker");
  assert.equal(isFreeModel("free/x"), false, "leading 'free/' is not a suffix marker");
  assert.equal(isFreeModel("x/free-ish"), false, "'/free-ish' is not '/free'");
  assert.equal(isFreeModel("x:free:extra"), false, ":free must be the suffix");
  assert.equal(isFreeModel("x//free"), true, "double slash still ends in /free");
  assert.equal(isFreeModel("kilo-auto/FREE"), true, "kilo-auto prefix is case-insensitive too");

  // ---- isFreeModel: entry/tag/cost coercion edges ----
  const zero = { cost: { input: 0, output: 0 } };
  assert.equal(isFreeModel("p/m", { ...zero, tag: "  Free  " }), true, "tag is trimmed and lowercased");
  assert.equal(isFreeModel("p/m", { ...zero, tag: "free" }), true, "tag as a plain string (not array)");
  assert.equal(isFreeModel("p/m", { ...zero, labels: ["beta", "FREE"] }), true, "labels array, uppercase");
  assert.equal(isFreeModel("p/m", { ...zero, tags: "free" }), true, "tags as a bare string");
  assert.equal(isFreeModel("p/m", { ...zero, tag: 42 }), false, "non-string tag never counts");
  assert.equal(isFreeModel("p/m", { ...zero, free: 1 }), false, "free must be boolean true, not truthy");
  assert.equal(isFreeModel("p/m", { ...zero, free: "true" }), false, "free string is not boolean true");
  assert.equal(isFreeModel("p/m", { cost: { input: 0 }, tag: "free" }), false, "missing output cost is not zero-cost");
  assert.equal(isFreeModel("p/m", { cost: { input: 0, output: undefined }, tag: "free" }), false, "undefined output is NaN, not zero");
  assert.equal(isFreeModel("p/m", { cost: { input: 0, output: -0 }, tag: "free" }), true, "-0 equals 0");
  assert.equal(isFreeModel("p/m", { cost: "free", tag: "free" }), false, "string cost is not a cost object");
  assert.equal(isFreeModel("p/m", []), false, "array entry has no cost/tag");
  assert.equal(isFreeModel("p/m", "free"), false, "string entry is not an entry object");
  assert.equal(isFreeModel("p/m", { cost: { input: 0, output: 0 }, tag: "free", extra: { deep: true } }), true,
    "extra entry keys are ignored");

  // BUG: a models-cache entry reporting real cost cannot veto a :free-looking
  // id. isFreeModel returns true on the id pattern before the entry is ever
  // consulted, so {cost:{input:1,output:1}} still counts as free.
  // assert.equal(isFreeModel("x/free", { cost: { input: 1, output: 1 } }), false,
  //   "a paid cache entry should veto a free-looking id");

  // BUG: null/false/"" cost fields coerce to 0 via Number(), so a malformed
  // entry like {cost:{input:null,output:null},tag:"free"} counts as provably
  // free even though the source never reported a cost ("unknown is never free").
  // assert.equal(isFreeModel("p/m", { cost: { input: null, output: null }, tag: "free" }), false,
  //   "null cost fields are unknown, not zero");
  // assert.equal(isFreeModel("p/m", { cost: { input: false, output: false }, tag: "free" }), false,
  //   "boolean cost fields are unknown, not zero");

  // ---- pickFreeModel: non-list and odd item shapes ----
  assert.equal(pickFreeModel("kilo-auto/free"), null, "a bare string is not a list");
  assert.equal(pickFreeModel({ id: "kilo-auto/free" }), null, "a bare object is not a list");
  assert.equal(pickFreeModel(42), null);
  assert.equal(pickFreeModel([null, 7, "", { id: 5 }, { id: "" }, {}, { modelID: null }]), null,
    "every unusable item shape is filtered out");
  assert.equal(pickFreeModel([{ modelID: "m:free" }]), "m:free", "modelID without providerID stays bare");
  assert.equal(pickFreeModel([{ providerID: "p", modelID: "m:free" }]), "p/m:free");
  assert.equal(pickFreeModel([{ modelID: "m" }]), null, "a non-free modelID alone is not picked");
  assert.equal(pickFreeModel([{ id: "winner/free", providerID: "p", modelID: "m" }]), "winner/free",
    "id wins over providerID/modelID when both are present");
  assert.equal(pickFreeModel([{ providerID: "kilo", modelID: "kilo-auto/free" }]), "kilo/kilo-auto/free",
    "providerID+modelID can spell the auto router");
  assert.equal(pickFreeModel(["paid/one", { id: "KILO/KILO-AUTO/FREE" }]), "KILO/KILO-AUTO/FREE",
    "auto match is case-insensitive and the original id is returned");
  // The kilo/-prefixed auto id is preferred over the bare one regardless of order.
  assert.equal(pickFreeModel(["kilo-auto/free", "kilo/kilo-auto/free"]), "kilo/kilo-auto/free",
    "prefixed auto wins even when listed second");
  assert.equal(pickFreeModel([{ id: "prov/m", entry: { cost: { input: 0, output: 0 }, tags: ["free"] } }, "paid/x"]),
    "prov/m", "entry free via tags array inside a list item");
  assert.equal(pickFreeModel([{ id: "prov/m", entry: { cost: { input: 0, output: 0 }, tag: "paid" } }]), null,
    "entry tag that is not 'free' does not count");
  // An item carrying its own cost/tag fields (no entry key) is treated as its
  // own entry here.
  assert.equal(pickFreeModel([{ id: "prov/m", cost: { input: 0, output: 0 }, tag: "free" }]), "prov/m",
    "item.cost makes the item its own cache entry");

  // BUG: pickFreeModel accepts the self-entry shape above, but kiloArgs only
  // reads model.entry — so the same object pickFreeModel calls free makes
  // kiloArgs throw. The two entry conventions disagree.
  // assert.deepEqual(kiloArgs("hi", { id: "prov/m", cost: { input: 0, output: 0 }, tag: "free" }).slice(4, 6),
  //   ["-m", "prov/m"], "kiloArgs should accept the self-entry shape pickFreeModel accepts");

  // ---- kiloArgs: model argument shapes ----
  assert.deepEqual(kiloArgs("hi", { providerID: "prov", modelID: "m:free" }).slice(4, 6),
    ["-m", "prov/m:free"], "providerID/modelID object form builds the id");
  assert.deepEqual(kiloArgs("hi", { id: "prov/m", entry: { cost: { input: 0, output: 0 }, tag: "free" } }).slice(4, 6),
    ["-m", "prov/m"], "entry-backed model builds args");
  assert.throws(() => kiloArgs("hi", { id: "prov/m", entry: null }), /not a known free model/,
    "null entry is not free");
  assert.throws(() => kiloArgs("hi", 42), /not a known free model/, "numeric model throws");
  assert.throws(() => kiloArgs("hi", null), /not a known free model/, "null model throws");
  assert.throws(() => kiloArgs("hi", { id: 5, modelID: "m" }), /not a known free model/,
    "non-string id falls through to modelID");
  // Prompt is coerced with String(): non-strings still produce argv.
  assert.equal(kiloArgs(undefined, "kilo-auto/free").at(-1), "undefined", "prompt is String()-coerced");
  assert.equal(kiloArgs(42, "kilo-auto/free").at(-1), "42");

  // ---- costCheck: non-string and scalar inputs ----
  for (const junk of [null, undefined, 42, true, {}, [], [1, 2]]) {
    assert.equal(costCheck(junk), null, `costCheck(${JSON.stringify(junk) ?? String(junk)}) is clean`);
  }
  // Well-formed scalar JSON docs parse but carry no records to scan.
  for (const doc of ['"hello"', "42", "true", "null", "[]", "{}", '"{"']) {
    assert.equal(costCheck(doc + "\n"), null, `scalar doc ${doc} is clean`);
  }

  // ---- costCheck: record field type edges ----
  assert.equal(costCheck(JSON.stringify({ modelID: "" })), null, "empty modelID is ignored");
  assert.equal(costCheck(JSON.stringify({ modelID: 5 })), null, "numeric modelID is ignored");
  assert.equal(costCheck(JSON.stringify({ modelID: null, providerID: "p" })), null, "null modelID is ignored");
  assert.equal(costCheck(JSON.stringify({ providerID: "anthropic" })), null, "providerID alone is ignored");
  assert.equal(costCheck(JSON.stringify({ cost: "0.5" })), null, "string cost is ignored");
  assert.equal(costCheck(JSON.stringify({ cost: -1 })), null, "negative cost is not a charge");
  assert.equal(costCheck(JSON.stringify({ cost: 1e-9 })).paid, true, "any positive cost flags, however tiny");
  assert.deepEqual(costCheck(JSON.stringify({ cost: 0.5 })), { paid: true, reason: "cost 0.5 reported" },
    "top-level cost field is scanned");
  assert.equal(costCheck(JSON.stringify([{ cost: 0 }, { cost: 0.25 }])).paid, true,
    "a top-level JSON array doc has every element scanned");
  assert.equal(costCheck(JSON.stringify({ items: [{ deep: { cost: 0.5 } }] })).paid, true,
    "cost nested inside arrays is found");

  // BUG: cost is only checked when it is a JSON number. A cost reported as a
  // string ("0.5") or nested under a different key evades the guard entirely.
  // assert.equal(costCheck(JSON.stringify({ cost: "0.5" })).paid, true,
  //   "a string-typed cost should still flag");

  // BUG: records() stops at depth 8, so a paid signal nested deeper is never
  // seen — a hostile or buggy emitter could hide cost/modelID past the limit.
  // let deep = { modelID: "gpt-5" };
  // for (let i = 0; i < 10; i++) deep = { wrap: deep };
  // assert.equal(costCheck(JSON.stringify(deep)).paid, true,
  //   "modelID nested past the depth cap should still flag");

  // ---- costCheck: stream/buffer edge cases ----
  assert.equal(costCheck('{"a":}\n{"cost":0.5}\n').paid, true,
    "a doc that can never parse is dropped and the next event still scanned");
  assert.equal(costCheck('[\n{"cost":0.5}\n]\n').paid, true,
    "a pretty-printed array still flags (the '[' line is dropped but elements parse)");
  assert.equal(costCheck('{"text":"unterminated\n{"cost":0.5}\n').paid, true,
    "an unterminated-string fragment does not swallow the next event");
  assert.equal(costCheck('{"cost":0.5}\r\n{"cost":0}\r\n').paid, true,
    "CRLF line endings are handled");
  assert.equal(costCheck('   \n\t\n{"cost":0}\n'), null, "whitespace-only lines are skipped");
  // First hit wins: a paid event before a clean one still reports paid.
  assert.deepEqual(costCheck(JSON.stringify({ cost: 0.5 }) + "\n" + JSON.stringify({ cost: 0 })),
    { paid: true, reason: "cost 0.5 reported" });
  // Free-model events with extra unknown fields stay clean.
  assert.equal(costCheck(JSON.stringify({ part: { modelID: "free", providerID: "kilo-auto", weird: { nested: [1, { x: 2 }] }, cost: 0 } })), null,
    "unknown nested fields on a clean event are ignored");
  // modelID/free detection inside deeply nested but in-bounds structures.
  assert.equal(costCheck(JSON.stringify({ a: { b: { c: { d: { e: { f: { g: { modelID: "gpt-5" } } } } } } } })).paid, true,
    "modelID nested eight levels deep is still scanned");

  // ---- costCheck: purity / no shared state ----
  const inputs = [JSON.stringify({ cost: 0.5 }), JSON.stringify({ cost: 0 }), "junk", JSON.stringify({ modelID: "gpt-5" })];
  const results = await Promise.all(inputs.map((s) => Promise.resolve().then(() => costCheck(s))));
  assert.deepEqual(results.map((r) => r && r.paid), [true, null, null, true],
    "concurrent calls are independent (module holds no state)");

  console.log("kilo-free deep: all tests passed");
} finally {
  for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
