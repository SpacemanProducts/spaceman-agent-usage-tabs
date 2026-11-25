// Deeper edge-case tests for bin/constance-model.mjs: regex boundaries, input
// coercion of wrong types, and error paths. The module is pure (no fs, env,
// state or clock), so there is nothing to put in a mkdtemp dir and no timing
// race to exercise — every input goes straight into the three functions.
// Same style as constance-model.test.mjs: plain asserts, exits non-zero on
// failure. Anything the base test already pins is not repeated here.
import assert from "node:assert/strict";
import { MODELS, modelRejected, nextModel, modelName } from "./constance-model.mjs";

const REJECT = "There's an issue with the selected model (opus). It may not exist or you may not have access to it.";
const PREFIX = "There's an issue with the selected model";

// ---- modelRejected: the gap between "selected model" and the closer is
// {0,200} chars, counted in UTF-16 code units (astral chars count double).
{
  assert.ok(modelRejected(PREFIX + "x".repeat(200) + "may not exist"), "a 200-char gap still matches");
  assert.ok(!modelRejected(PREFIX + "x".repeat(201) + "may not exist"), "a 201-char gap is too far");
  assert.ok(modelRejected(PREFIX + "x".repeat(200) + "may not have access to it"), "the 200-char boundary holds for the other closer too");
  assert.ok(modelRejected(PREFIX + "😀".repeat(100) + "may not exist"), "100 astral chars = 200 code units: still in range");
  assert.ok(!modelRejected(PREFIX + "😀".repeat(101) + "may not exist"), "101 astral chars = 202 code units: out of range");
  assert.ok(modelRejected(PREFIX + "\n\n  \t" + "may not exist"), "the gap may contain newlines and tabs");
  // Order matters: the closer must come AFTER "selected model".
  assert.ok(!modelRejected("may not exist — " + PREFIX), "a closer before the phrase never matches");
  // A second "selected model" gives the regex a fresh, closer anchor.
  assert.ok(modelRejected(PREFIX + "x".repeat(500) + PREFIX + " may not exist"), "the nearest 'selected model' anchors the match");
  assert.ok(!modelRejected(PREFIX + "x".repeat(500) + "may not exist"), "one far anchor is not enough");
  // Realistic Claude Code output: noise before and after still matches.
  assert.ok(modelRejected("Error: API request failed.\n" + REJECT + "\nRetrying..."), "embedded in a larger report it still matches");
  // Near-misses on the literal wording.
  assert.ok(!modelRejected("There is an issue with the selected model x may not exist"), "'there is' is not 'there's'");
  assert.ok(!modelRejected("There's an issue with the selected-model x may not exist"), "a hyphen is not the literal space");
  assert.ok(!modelRejected("There's an issue with a selected model x may not exist"), "'a selected model' lacks 'the'");
  assert.ok(!modelRejected("There's an issue with the selected model x may possibly not exist"), "'may possibly not exist' is not the closer");
}

// ---- modelRejected: wrong input types are coerced with String(report || "").
{
  for (const bad of [null, undefined, 0, false, NaN, {}, [], 42, ""]) {
    assert.equal(modelRejected(bad), false, `must not match: ${String(bad)}`);
  }
  assert.equal(modelRejected("0"), false, "a truthy non-matching string stays false");
  // Coercion goes through String(), so anything stringifying to the reject
  // text counts — arrays join, objects use toString.
  assert.ok(modelRejected(["There's an issue with the selected model x may not exist"]), "a single-element array coerces to its text");
  assert.ok(modelRejected({ toString: () => "There's an issue with the selected model x may not exist" }), "an object with toString coerces too");
  assert.ok(!modelRejected(["a", "b"]), "a multi-element array joins with commas, not the reject text");
  assert.equal(modelRejected(Symbol("x")), false, "symbols coerce without throwing");
  // ...but a toString that throws propagates — there is no try/catch.
  assert.throws(() => modelRejected({ toString: () => { throw new Error("boom"); } }), /boom/, "a throwing toString is not swallowed");
  // A huge report still scans linearly (the quantifier is bounded): no hang.
  assert.ok(modelRejected("y".repeat(1_000_000) + REJECT), "a megabyte of noise before the reject still matches");
}

// ---- nextModel: `used` must be an exact MODELS entry; anything else is null.
{
  for (const used of [null, undefined, 0, false, {}, [], "Opus", "OPUS", " opus", "opus ", "opus\n"]) {
    assert.equal(nextModel(used, REJECT), null, `nextModel(${JSON.stringify(used) || String(used)}, reject) must be null`);
  }
  assert.equal(nextModel(new String("opus"), REJECT), null, "a String object is not === to the primitive");
  // Case matters in the other direction too: only lowercase entries advance.
  assert.equal(nextModel("SONNET", REJECT), null, "uppercase 'SONNET' is not in MODELS");
  // MODELS itself is not mutated by calls.
  nextModel("opus", REJECT); nextModel("haiku", REJECT);
  assert.deepEqual(MODELS, ["opus", "sonnet", "haiku"], "calls leave MODELS untouched");
  // A reject report for an unknown model still fails honestly instead of guessing.
  assert.equal(nextModel("claude-opus-4", REJECT), null);
}

// BUG: MODELS is a plain exported array — nothing freezes it, so any importer
// that pushes to it silently rewrites the fallback chain:
//   MODELS.push("extra"); nextModel("haiku", REJECT) === "extra" (should be null).
// Not fixed here; flagged for the owner to decide whether MODELS should be frozen.

// ---- modelName: falsy input falls back to "Opus"; truthy non-strings throw.
{
  assert.equal(modelName(), "Opus", "undefined falls back");
  assert.equal(modelName(null), "Opus");
  assert.equal(modelName(0), "Opus", "0 is falsy, not a crash");
  assert.equal(modelName(false), "Opus");
  assert.equal(modelName("opus"), "Opus", "the default model's own name");
  assert.equal(modelName("OPUS"), "OPUS", "only the first char is uppercased; the rest pass through");
  assert.equal(modelName("o"), "O", "single-char names don't break slice");
  assert.equal(modelName(" sonnet"), " sonnet", "the first char is uppercased — a space stays a space");
  assert.equal(modelName(new String("haiku")), "Haiku", "a String object indexes and slices fine");
  for (const bad of [42, {}, [], Symbol("x")]) {
    assert.throws(() => modelName(bad), TypeError, `modelName(${String(bad)}) must throw`);
  }
  // In practice callers only pass `model || "opus"`, so the throw is unreachable
  // today — pinned here so a future caller knows the contract.
}

console.log("constance-model.deep: tests passed");
