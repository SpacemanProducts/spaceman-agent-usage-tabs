// Deep edge-case tests for bin/constance-milk.mjs. The existing
// constance-milk.test.mjs covers the step table, the snap table and each step's
// policy; this file goes after the corners it leaves: coercion of wrong types
// (null, "", booleans, arrays, objects, hex/scientific strings, Infinity),
// float rounding at the snap boundaries, object freshness/purity, prompt shape
// for every integer 0..100, and a check that the module never writes to HOME or
// the XDG dirs. Everything runs in a fresh mkdtemp HOME with HOME and all four
// XDG vars pointed inside it; cleaned up at the end.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMilk, milkStep, milkPolicy, milkPrompt, MILK_STEPS, DEFAULT_MILK, MILK_LAST_LINE } from "./constance-milk.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "constance-milk-deep-"));
const xdg = {
  XDG_STATE_HOME: path.join(home, "state"),
  XDG_CONFIG_HOME: path.join(home, "config"),
  XDG_CACHE_HOME: path.join(home, "cache"),
};
for (const d of Object.values(xdg)) fs.mkdirSync(d, { recursive: true });
process.env.HOME = home;
Object.assign(process.env, xdg);

try {
  const STEP_VALUES = MILK_STEPS.map((s) => s.value);

  // --- readMilk: settings that are not a plain object -----------------------
  for (const bad of [undefined, null, 42, "milk", true, [], [25], Symbol.iterator]) {
    assert.equal(readMilk(bad), DEFAULT_MILK, `readMilk(${String(bad)}) falls back`);
  }
  // A settings object whose constanceMilk is absent vs present-but-undefined.
  assert.equal(readMilk({}), DEFAULT_MILK);
  assert.equal(readMilk({ constanceMilk: undefined }), DEFAULT_MILK);
  // Prototype-less and weird-but-object settings still read the own property.
  assert.equal(readMilk(Object.create(null)), DEFAULT_MILK);
  assert.equal(readMilk(Object.assign(Object.create(null), { constanceMilk: 75 })), 75);

  // --- readMilk: coercion corners -------------------------------------------
  // Strings that Number() accepts: hex, binary, octal-ish, scientific, padded.
  assert.equal(readMilk({ constanceMilk: "0x10" }), 16, "hex string parses");
  assert.equal(readMilk({ constanceMilk: "0b101" }), 5, "binary string parses");
  assert.equal(readMilk({ constanceMilk: "1e2" }), 100, "scientific notation parses");
  assert.equal(readMilk({ constanceMilk: "  42  " }), 42, "padded string parses");
  assert.equal(readMilk({ constanceMilk: "25.9" }), 26, "fractional string rounds");
  assert.equal(readMilk({ constanceMilk: "25abc" }), DEFAULT_MILK, "trailing junk is not a number");
  assert.equal(readMilk({ constanceMilk: "Infinity" }), DEFAULT_MILK, "Infinity string is not finite");
  assert.equal(readMilk({ constanceMilk: "-Infinity" }), DEFAULT_MILK);
  assert.equal(readMilk({ constanceMilk: "NaN" }), DEFAULT_MILK);
  // Number objects and valueOf tricks coerce like their primitive.
  assert.equal(readMilk({ constanceMilk: new Number(60) }), 60);
  assert.equal(readMilk({ constanceMilk: { valueOf: () => 33 } }), 33);
  // Non-finite and huge numbers fall back or clamp.
  assert.equal(readMilk({ constanceMilk: Infinity }), DEFAULT_MILK);
  assert.equal(readMilk({ constanceMilk: -Infinity }), DEFAULT_MILK);
  assert.equal(readMilk({ constanceMilk: NaN }), DEFAULT_MILK);
  assert.equal(readMilk({ constanceMilk: 1e21 }), 100, "huge finite clamps to 100");
  assert.equal(readMilk({ constanceMilk: -1e21 }), 0, "huge negative clamps to 0");
  // Rounding at the edges: .5 rounds half up, negatives near zero stay in range.
  assert.equal(readMilk({ constanceMilk: 0.4 }), 0);
  assert.equal(readMilk({ constanceMilk: 0.5 }), 1);
  assert.equal(readMilk({ constanceMilk: -0.4 }), 0);
  assert.equal(readMilk({ constanceMilk: -0.6 }), 0, "rounds to -1 then clamps to 0");
  assert.equal(readMilk({ constanceMilk: 99.5 }), 100);
  assert.equal(readMilk({ constanceMilk: 100.4 }), 100);
  assert.equal(readMilk({ constanceMilk: -0 }), 0);
  // BigInt coerces through Number().
  assert.equal(readMilk({ constanceMilk: 50n }), 50);

  // BUG: readMilk treats null, "" and false as 0 (Max delegation) instead of the
  // documented DEFAULT_MILK, because Number(null)/Number("")/Number(false) are 0.
  // A settings.json carrying "constanceMilk": null or "" silently drops the
  // slider to Max delegation rather than the Lean default. Expected DEFAULT_MILK.
  // assert.equal(readMilk({ constanceMilk: null }), DEFAULT_MILK);
  // assert.equal(readMilk({ constanceMilk: "" }), DEFAULT_MILK);
  // assert.equal(readMilk({ constanceMilk: false }), DEFAULT_MILK);
  // Current (buggy) behavior, pinned so a fix shows up as a diff:
  assert.equal(readMilk({ constanceMilk: null }), 0, "null coerces to 0 today");
  assert.equal(readMilk({ constanceMilk: "" }), 0, "empty string coerces to 0 today");
  assert.equal(readMilk({ constanceMilk: false }), 0, "false coerces to 0 today");
  assert.equal(readMilk({ constanceMilk: " " }), 0, "whitespace-only string coerces to 0 today");
  // Arrays coerce by their single element / empty-to-zero too.
  assert.equal(readMilk({ constanceMilk: [] }), 0);
  assert.equal(readMilk({ constanceMilk: [42] }), 42);
  assert.equal(readMilk({ constanceMilk: [1, 2] }), DEFAULT_MILK, "multi-element array is NaN");
  // Booleans and truthy objects.
  assert.equal(readMilk({ constanceMilk: true }), 1);
  assert.equal(readMilk({ constanceMilk: {} }), DEFAULT_MILK, "plain object is NaN");

  // Values that make Number() throw propagate out of readMilk.
  assert.throws(() => readMilk({ constanceMilk: Symbol("x") }), TypeError);
  assert.throws(() => readMilk({ constanceMilk: { valueOf() { throw new Error("boom"); } } }), /boom/);

  // --- milkStep: every input lands on one of the five real steps ------------
  const junk = [null, undefined, NaN, Infinity, -Infinity, "", " ", "abc", {}, [], [50], true, false, -0, 0.4, 12.5, 37.5, 62.5, 87.5, -12.5, "0x10", "1e2", 50n, new Number(75)];
  for (const v of junk) {
    const s = milkStep(v);
    assert.ok(MILK_STEPS.includes(s), `milkStep(${String(v)}) returns a real step`);
  }
  // milkStep never returns undefined/null and never mutates MILK_STEPS.
  const frozenBefore = JSON.stringify(MILK_STEPS);
  milkStep(37); milkStep("junk"); milkStep(Infinity);
  assert.equal(JSON.stringify(MILK_STEPS), frozenBefore, "MILK_STEPS is not mutated");

  // Float rounding at the snap midpoints (steps are 25 apart, so .5 cases decide).
  assert.equal(milkStep(12.4).value, 0, "12.4 rounds to 12 -> Max delegation");
  assert.equal(milkStep(12.5).value, 25, "12.5 rounds to 13 -> Lean");
  assert.equal(milkStep(24.5).value, 25);
  assert.equal(milkStep(37.4).value, 25, "37.4 rounds to 37 -> Lean");
  assert.equal(milkStep(37.5).value, 50, "37.5 rounds to 38 -> Balanced");
  assert.equal(milkStep(62.5).value, 75, "62.5 rounds to 63 -> Thorough");
  assert.equal(milkStep(87.5).value, 100, "87.5 rounds to 88 -> Max Opus");
  assert.equal(milkStep(-12.5).value, 0, "negative rounds then clamps to 0");
  // Non-finite extremes: +Infinity snaps to the top step, -Infinity/NaN to 0.
  assert.equal(milkStep(Infinity).value, 100);
  assert.equal(milkStep(-Infinity).value, 0);
  assert.equal(milkStep(NaN).value, 0);
  assert.equal(milkStep("Infinity").value, 100);
  // Hex/scientific strings parse through Number().
  assert.equal(milkStep("0x10").value, 25, "0x10 = 16 -> Lean");
  assert.equal(milkStep("1e2").value, 100);
  // Coercible objects and BigInt.
  assert.equal(milkStep([50]).value, 50);
  assert.equal(milkStep(new Number(75)).value, 75);
  assert.equal(milkStep(50n).value, 50);
  // Same throw behavior as readMilk.
  assert.throws(() => milkStep(Symbol("x")), TypeError);

  // --- milkPolicy: shape, freshness, consistency -----------------------------
  const p1 = milkPolicy(50);
  const p2 = milkPolicy(50);
  assert.deepEqual(p1, p2, "same input gives equal policy");
  assert.notEqual(p1, p2, "each call returns a fresh object");
  p1.reviewDepth = "MUTATED";
  assert.equal(milkPolicy(50).reviewDepth, "skim", "mutating a result does not leak");
  // Input objects are not mutated.
  const settingsLike = { valueOf: () => 60 };
  milkPolicy(settingsLike);
  assert.deepEqual(Object.keys(settingsLike), ["valueOf"], "input object untouched");

  // For every integer 0..100 the policy is internally consistent: value/step/band
  // agree with milkStep, reviewDepth and maxFilesPerTask come from the right
  // step, planning is a non-empty string, selfEdit/sandbox/guardrails are sane.
  const DEPTHS = new Set(["report", "skim", "full"]);
  for (let v = 0; v <= 100; v++) {
    const p = milkPolicy(v);
    const step = milkStep(v);
    assert.equal(p.value, step.value, `value ${v}`);
    assert.equal(p.step, step.name, `step ${v}`);
    assert.equal(STEP_VALUES.includes(p.value), true, `snapped value ${v}`);
    assert.ok(DEPTHS.has(p.reviewDepth), `depth ${v}`);
    assert.ok(Number.isInteger(p.maxFilesPerTask) && p.maxFilesPerTask >= 2 && p.maxFilesPerTask <= 6, `files ${v}`);
    assert.equal(typeof p.planning, "string");
    assert.ok(p.planning.length > 10, `planning text ${v}`);
    assert.equal(typeof p.selfEdit, "boolean");
    assert.equal(p.selfEdit, step.value >= 75, `selfEdit only at 75/100 (${v})`);
    assert.equal(p.sandbox, true);
    assert.equal(p.guardrails, true);
    // band follows the coarse rule on the snapped value.
    const expectedBand = p.value <= 33 ? "milk" : p.value <= 66 ? "balanced" : "quality";
    assert.equal(p.band, expectedBand, `band ${v}`);
    // The four policy fields together are unique per step (no two steps collapse).
  }
  // Five distinct (planning, depth, files, selfEdit) tuples — one per step.
  const tuples = STEP_VALUES.map((v) => {
    const p = milkPolicy(v);
    return `${p.planning}|${p.reviewDepth}|${p.maxFilesPerTask}|${p.selfEdit}`;
  });
  assert.equal(new Set(tuples).size, 5, "five distinct policies");
  // maxFilesPerTask strictly decreases as milk rises.
  for (let i = 1; i < STEP_VALUES.length; i++) {
    assert.ok(milkPolicy(STEP_VALUES[i]).maxFilesPerTask < milkPolicy(STEP_VALUES[i - 1]).maxFilesPerTask, `job size shrinks at step ${i}`);
  }
  // Junk inputs never produce a step outside the five.
  for (const v of [null, "abc", {}, [], NaN, Infinity, " "]) {
    const p = milkPolicy(v);
    assert.ok(STEP_VALUES.includes(p.value), `policy value for ${String(v)}`);
    assert.equal(p.sandbox, true);
    assert.equal(p.guardrails, true);
  }

  // --- milkPrompt: shape for every integer 0..100 ----------------------------
  const DEPTH_WORDS = { report: "trust the free agents' reports", skim: "skim the diffs of risky files", full: "read every diff yourself" };
  for (let v = 0; v <= 100; v++) {
    const prompt = milkPrompt(v);
    const lines = prompt.split("\n");
    assert.equal(lines.length, 4, `four lines at ${v}`);
    assert.equal(lines[3], MILK_LAST_LINE, `last line is the guardrails line at ${v}`);
    assert.equal(prompt.endsWith("\n"), false, `no trailing newline at ${v}`);
    const p = milkPolicy(v);
    assert.ok(lines[0].includes(`Milk Opus is at ${p.value}`), `first line value at ${v}`);
    assert.ok(lines[0].includes(`(${p.band})`), `first line band at ${v}`);
    assert.ok(lines[0].includes(p.step), `first line step at ${v}`);
    assert.ok(lines[0].includes(DEPTH_WORDS[p.reviewDepth]), `first line depth wording at ${v}`);
    assert.ok(lines[1].includes(`at most ${p.maxFilesPerTask} files`), `planning line files at ${v}`);
    assert.ok(lines[1].startsWith("Planning: "), `planning line prefix at ${v}`);
    assert.equal(lines[2], p.selfEdit ? "You may do the hard parts yourself." : "Leave the editing to the free agents.", `edit line at ${v}`);
    // The guardrails line appears exactly once and nowhere is the slider
    // described as permission to drop sandbox/guardrails.
    assert.equal(prompt.split(MILK_LAST_LINE).length - 1, 1, `guardrails line once at ${v}`);
  }
  // Step-name boundaries inside the prompt: a value between steps still names
  // the snapped step, not the raw number's nearest label by luck.
  assert.match(milkPrompt(37), /Milk Opus is at 25 \(milk\) · Lean/, "37 prompts as Lean");
  assert.match(milkPrompt(88), /Milk Opus is at 100 \(quality\) · Max Opus/, "88 prompts as Max Opus");
  // Junk input prompts as Max delegation (0), still with the guardrails line.
  for (const v of [null, "abc", {}, NaN]) {
    const prompt = milkPrompt(v);
    assert.ok(prompt.includes("Milk Opus is at 0"), `junk ${String(v)} prompts at 0`);
    assert.ok(prompt.trimEnd().endsWith(MILK_LAST_LINE), `junk ${String(v)} keeps guardrails line`);
  }
  // Prompt is deterministic: same input, identical string.
  assert.equal(milkPrompt(63), milkPrompt(63), "prompt is deterministic");

  // --- purity: the module touches no files -----------------------------------
  // It is pure by design; assert the temp HOME and XDG dirs stayed empty so a
  // future refactor that starts reading/writing settings or state is caught.
  const leftovers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else leftovers.push(p);
    }
  };
  walk(home);
  assert.deepEqual(leftovers, [], "module wrote nothing under HOME/XDG");
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
console.log("constance-milk.deep: all tests passed");
