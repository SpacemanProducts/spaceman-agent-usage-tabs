import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMilk, milkStep, milkPolicy, milkPrompt, MILK_STEPS, DEFAULT_MILK, MILK_LAST_LINE } from "./constance-milk.mjs";

// The module is pure (settings object in, policy/prompt out), so nothing touches the
// real home folder; a mktemp HOME is set anyway per the job rules.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "constance-milk-"));
process.env.HOME = home;

// MILK_STEPS: five labeled steps, ascending values 0/25/50/75/100, each with a
// one-line plain description.
assert.equal(MILK_STEPS.length, 5, "five steps");
assert.deepEqual(MILK_STEPS.map((s) => s.value), [0, 25, 50, 75, 100], "step values");
assert.deepEqual(MILK_STEPS.map((s) => s.name), ["Max delegation", "Lean", "Balanced", "Thorough", "Max lead"], "step names");
for (const s of MILK_STEPS) {
  assert.ok(s.description && s.description.length > 10, `description for ${s.name}`);
}

// readMilk: a number in range is used as-is, missing or garbage falls back to the
// default, out-of-range is clamped. (Snapping happens in milkStep/milkPolicy.)
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

// The default is 25 = Lean.
assert.equal(DEFAULT_MILK, 25);
assert.equal(milkStep(DEFAULT_MILK).name, "Lean");
assert.equal(milkPolicy(readMilk({})).step, "Lean", "default setting lands on Lean");

// milkStep: values between steps snap to the nearest step.
const snaps = [
  [0, "Max delegation"], [10, "Max delegation"], [12, "Max delegation"],
  [13, "Lean"], [24, "Lean"], [25, "Lean"], [37, "Lean"], [38, "Balanced"],
  [49, "Balanced"], [50, "Balanced"], [62, "Balanced"], [63, "Thorough"],
  [74, "Thorough"], [75, "Thorough"], [87, "Thorough"], [88, "Max lead"],
  [99, "Max lead"], [100, "Max lead"],
  [-5, "Max delegation"], [150, "Max lead"], ["abc", "Max delegation"],
];
for (const [v, name] of snaps) {
  assert.equal(milkStep(v).name, name, `milkStep(${String(v)})`);
  assert.equal(milkPolicy(v).step, name, `milkPolicy(${String(v)}).step`);
}

// Each step's full policy: planning text, review depth, job size, selfEdit.
const cases = [
  [0, "Max delegation", "milk", "report", 6, "one short plan, queue everything at once", false],
  [25, "Lean", "milk", "report", 5, "one plan up front, then let the queue run", false],
  [50, "Balanced", "balanced", "skim", 4, "plan up front and re-check the plan once between waves", false],
  [75, "Thorough", "quality", "full", 3, "plan each wave carefully and adjust the plan as results come in", true],
  [100, "Max lead", "quality", "full", 2, "plan carefully and re-plan after each wave", true],
];
for (const [v, stepName, bandName, depth, maxFiles, planning, selfEdit] of cases) {
  const p = milkPolicy(v);
  assert.equal(p.value, v, `value ${v}`);
  assert.equal(p.step, stepName, `step at ${v}`);
  assert.equal(p.band, bandName, `band at ${v}`);
  assert.equal(p.reviewDepth, depth, `reviewDepth at ${v}`);
  assert.equal(p.maxFilesPerTask, maxFiles, `maxFilesPerTask at ${v}`);
  assert.equal(p.planning, planning, `planning at ${v}`);
  assert.equal(p.selfEdit, selfEdit, `selfEdit at ${v}`);
}

// Between every pair of neighbouring steps, planning, review depth or job size
// must change — no two neighbours share the same whole policy.
for (let i = 0; i < MILK_STEPS.length - 1; i++) {
  const a = milkPolicy(MILK_STEPS[i].value);
  const b = milkPolicy(MILK_STEPS[i + 1].value);
  assert.ok(
    a.planning !== b.planning || a.reviewDepth !== b.reviewDepth || a.maxFilesPerTask !== b.maxFilesPerTask,
    `policy changes between ${a.step} and ${b.step}`,
  );
}
// And the five planning texts are all distinct.
assert.equal(new Set(cases.map((c) => c[5])).size, 5, "five distinct planning texts");

// selfEdit only for Thorough and Max lead.
for (const v of [0, 25, 50]) assert.equal(milkPolicy(v).selfEdit, false, `no selfEdit at ${v}`);
for (const v of [75, 100]) assert.equal(milkPolicy(v).selfEdit, true, `selfEdit at ${v}`);

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

// The prompt describes the policy, names the step on its first line, and always
// ends with the sandbox/guardrails line.
for (const [v, stepName] of cases.map((c) => [c[0], c[1]])) {
  const prompt = milkPrompt(v);
  const first = prompt.split("\n")[0];
  assert.ok(first.includes(`Lead Chef intensity is at ${v}`), `prompt names the value at ${v}`);
  assert.ok(first.includes(stepName), `prompt names the step ${stepName} at ${v}`);
  assert.ok(prompt.includes(MILK_LAST_LINE), `prompt carries the guardrails line at ${v}`);
  assert.equal(prompt.trimEnd().endsWith(MILK_LAST_LINE), true, `last line at ${v}`);
}
assert.match(milkPrompt(0), /Leave the editing to the free agents/, "delegation leaves editing to the agents");
assert.match(milkPrompt(100), /hard parts yourself/, "max lead does the hard parts herself");
assert.match(milkPrompt(75), /hard parts yourself/, "thorough may edit hard parts herself");
assert.match(milkPrompt(50), /Leave the editing to the free agents/, "balanced leaves editing to the agents");

fs.rmSync(home, { recursive: true, force: true });
console.log("constance-milk: tests passed");
