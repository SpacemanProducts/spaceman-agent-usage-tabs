import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMilk, milkPolicy, milkPrompt, DEFAULT_MILK, MILK_LAST_LINE } from "./constance-milk.mjs";

// The module is pure (settings object in, policy/prompt out), so nothing touches the
// real home folder; a mktemp HOME is set anyway per the job rules.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "constance-milk-"));
process.env.HOME = home;

// readMilk: a number in range is used as-is, missing or garbage falls back to the
// default, out-of-range is clamped.
assert.equal(readMilk({ constanceMilk: 0 }), 0);
assert.equal(readMilk({ constanceMilk: 25 }), 25);
assert.equal(readMilk({ constanceMilk: 33 }), 33);
assert.equal(readMilk({ constanceMilk: 34 }), 34);
assert.equal(readMilk({ constanceMilk: 66 }), 66);
assert.equal(readMilk({ constanceMilk: 67 }), 67);
assert.equal(readMilk({}), DEFAULT_MILK, "missing falls back to the default");
assert.equal(readMilk(null), DEFAULT_MILK);
assert.equal(readMilk({ constanceMilk: "abc" }), DEFAULT_MILK, "not a number falls back");
assert.equal(readMilk({ constanceMilk: -5 }), 0, "below range clamps to 0");
assert.equal(readMilk({ constanceMilk: 150 }), 100, "above range clamps to 100");

// Bands and the policy fields for each edge value.
const cases = [
  [0, "milk", "report", 6, "one short plan, queue everything at once", false],
  [25, "milk", "report", 6, "one short plan, queue everything at once", false],
  [33, "milk", "report", 6, "one short plan, queue everything at once", false],
  [34, "balanced", "skim", 4, "plan up front, check the plan once", false],
  [66, "balanced", "skim", 4, "plan up front, check the plan once", false],
  [67, "quality", "full", 2, "plan carefully and re-plan after each wave", true],
  [100, "quality", "full", 2, "plan carefully and re-plan after each wave", true],
];
for (const [v, bandName, depth, maxFiles, planning, selfEdit] of cases) {
  const p = milkPolicy(v);
  assert.equal(p.value, v, `value ${v}`);
  assert.equal(p.band, bandName, `band at ${v}`);
  assert.equal(p.reviewDepth, depth, `reviewDepth at ${v}`);
  assert.equal(p.maxFilesPerTask, maxFiles, `maxFilesPerTask at ${v}`);
  assert.equal(p.planning, planning, `planning at ${v}`);
  assert.equal(p.selfEdit, selfEdit, `selfEdit at ${v}`);
}

// Sandbox and guardrails stay on at EVERY setting, 0 through 100.
for (let v = 0; v <= 100; v++) {
  const p = milkPolicy(v);
  assert.equal(p.sandbox, true, `sandbox at ${v}`);
  assert.equal(p.guardrails, true, `guardrails at ${v}`);
}
// Even odd inputs never weaken them.
for (const v of [-5, 150, "abc", NaN, undefined]) {
  const p = milkPolicy(v);
  assert.equal(p.sandbox, true, `sandbox at ${String(v)}`);
  assert.equal(p.guardrails, true, `guardrails at ${String(v)}`);
}

// The prompt describes the policy and always ends with the sandbox/guardrails line.
for (const v of [0, 25, 34, 67, 100]) {
  const prompt = milkPrompt(v);
  assert.match(prompt, new RegExp(`Milk Opus is at ${milkPolicy(v).value}`), `prompt names the value at ${v}`);
  assert.ok(prompt.includes(MILK_LAST_LINE), `prompt ends with the guardrails line at ${v}`);
  assert.equal(prompt.trimEnd().endsWith(MILK_LAST_LINE), true, `last line at ${v}`);
}
assert.match(milkPrompt(0), /Leave the editing to the free agents/, "milk leaves editing to the agents");
assert.match(milkPrompt(100), /hard parts yourself/, "quality does the hard parts herself");

fs.rmSync(home, { recursive: true, force: true });
console.log("constance-milk: tests passed");
