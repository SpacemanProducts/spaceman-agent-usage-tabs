// Constance's screen header and Milk Opus slider: four big-number tiles (done,
// copies running, her Session % used, her per-1% leverage), a 0..100 slider that
// snaps to the five steps (0/25/50/75/100), captions the current step's name and
// one-line description, and saves constanceMilk through settings-set.mjs; each
// history row's leverage.label. Source-level checks on Panel.qml and
// bin/constance.mjs's status milk object plus applyMilk and a CLI round-trip
// with a mktemp fake HOME — nothing touches the real home folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyMilk } from "./settings-set.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "constance-milk-panel-"));
process.env.HOME = home;
const stateHome = path.join(home, "state");
const env = { ...process.env, HOME: home, XDG_STATE_HOME: stateHome };

const here = path.dirname(fileURLToPath(import.meta.url));
const qml = fs.readFileSync(path.join(here, "..", "Panel.qml"), "utf8");
const mjs = fs.readFileSync(path.join(here, "constance.mjs"), "utf8");

// The four tiles: labels, values and their color rules.
for (const label of ['label: "done"', 'label: "copies"', 'label: "session"', 'label: "per 1%"'])
  assert.ok(qml.includes(label), `tile ${label} exists`);
assert.ok(qml.includes("id: constanceHead"), "header row exists");
assert.match(qml, /readonly property int constanceChecklistDone/, "done tile reads the checklist");
assert.match(qml, /readonly property int constanceRunningCount/, "copies tile counts running jobs");
assert.match(qml, /js\[i\] && js\[i\]\.status === "running"/, "copies counts jobs, not copies rows");
assert.match(qml, /w\.title === "Session"/, "session tile finds the Session window");
assert.match(qml, /root\.meterColor\(root\.constanceSessionUsed\)/, "session tile uses the panel's meter colors");
assert.match(qml, /root\.constancePerPctText/, "per-1% tile text exists");
assert.match(qml, /root\.fmtTokens\(p\)/, "per-1% uses the panel's token formatting");
assert.match(qml, /Number\(l\.vsTarget\) >= 1 \? root\.green : root\.amber/, "per-1% is green at/above target, amber below");
assert.match(qml, /if \(!l \|\| !isFinite\(Number\(l\.perPct\)\)\) return root\.dim/, "per-1% is gray when null");
assert.ok(qml.includes("font.pixelSize: Style.font.body * 1.8"), "tile numbers are about 2x the normal font");
assert.ok(qml.includes("font.bold: true"), "tile numbers are bold");

// The old checklist progress line is gone (the done tile replaced it).
assert.ok(!qml.includes("root.constanceBoard.checklist.line"), "checklist line text is hidden");

// The Lead Chef intensity slider: labels, band word, five-step snapping, step caption,
// saving through settings-set.
assert.ok(qml.includes('|| "Lead Chef intensity"'), "slider title falls back to Lead Chef intensity");
assert.ok(qml.includes('text: "more delegation"'), "more-delegation end label exists");
assert.ok(!qml.includes('text: "less Opus"'), "the less-Opus label is gone");
assert.ok(qml.includes("more delegation hands almost everything"), "tooltip uses lead-neutral wording");
assert.ok(qml.includes('name: "Max lead"'), "top step is named Max lead");
assert.ok(!qml.includes('name: "Max Opus"'), "the Max Opus step name is gone");
assert.ok(qml.includes('text: "more quality · " + root.constanceMilkBand'), "more-quality end shows the band word");
assert.ok(qml.includes('text: "Sandbox and guardrails always on."'), "guardrails line exists");
assert.match(qml, /readonly property int constanceMilk:/, "constanceMilk property exists");
assert.match(qml, /readonly property string constanceMilkBand:/, "constanceMilkBand property exists");
assert.match(qml, /constance\.milk/, "the slider prefers status.milk when present");
assert.ok(qml.includes('root.writeSetting(["constanceMilk", String(pending)])'), "releasing it writes constanceMilk");
// The knob snaps to the five steps only: quarter turns of the rail, nothing finer.
assert.ok(qml.includes("Math.round(f * 4) * 25"), "the slider snaps to 0/25/50/75/100");
assert.ok(!qml.includes("Math.round(f * 20) * 5"), "the old step-5 snapping is gone");
for (const v of [0, 25, 50, 75, 100]) assert.ok(qml.includes(`value: ${v}`), `step ${v} is in the panel's step list`);
// The caption under the slider shows the step name and its one-line description,
// following the pending drag value while moving.
assert.match(qml, /readonly property var constanceMilkSteps:/, "the five steps are exposed to the caption");
assert.match(qml, /function constanceMilkStepAt\(v\)/, "a value maps to its step");
assert.match(qml, /readonly property var constanceMilkStep:/, "the current step is tracked");
assert.match(qml, /milkArea\.pending >= 0 \? milkArea\.pending : root\.constanceMilk/, "dragging shows the pending step");
assert.match(qml, /readonly property string constanceMilkStepText:/, "step name + description text exists");
assert.ok(qml.includes("text: root.constanceMilkStepText"), "the caption Text under the slider uses it");

// The lead caption under the slider title: name + exact model from status.brain,
// hidden when either is missing.
assert.match(qml, /readonly property string constanceLeadCaption:/, "constanceLeadCaption exists");
assert.ok(qml.includes('"Lead: "'), "lead caption has the Lead prefix");
assert.ok(qml.includes("root.constanceBrainInfo"), "lead caption reads status.brain");
assert.ok(qml.includes("text: root.constanceLeadCaption"), "lead caption Text is bound");
assert.ok(qml.includes('visible: root.constanceLeadCaption !== ""'), "lead caption hides when empty");

// The share underline under the slider track and its caption show only when
// board.rev.share is a finite number in 0..1; nothing shows when share is null.
assert.match(qml, /readonly property real constanceRevShare:/, "constanceRevShare exists");
assert.match(qml, /root\.constanceRev \? Number\(root\.constanceRev\.share\) : NaN/, "share comes from constanceRev.share");
assert.ok(qml.includes("isFinite(s) && s >= 0 && s <= 1"), "share must be finite and in 0..1");
assert.ok(qml.includes("visible: isFinite(root.constanceRevShare)"), "underline and caption share the visibility guard");
assert.ok(qml.includes("parent.width * (isFinite(root.constanceRevShare) ? root.constanceRevShare : 0)"), "underline width is the share of the track width");
assert.ok(qml.includes('"lead uses "'), "share caption text exists");
assert.ok(qml.includes("% of this goal's tokens"), "share caption wording");
// status.milk carries the current step's name and description plus the steps list.
assert.match(mjs, /function milkStatus\(\)/, "status builds milk via milkStatus()");
assert.match(mjs, /milk: milkStatus\(\)/, "statusPayload uses milkStatus()");
assert.ok(mjs.includes("milkStep("), "status resolves the current step");
assert.ok(mjs.includes("MILK_STEPS"), "status lists the five steps");
assert.ok(mjs.includes("stepName:"), "status.milk carries the step name");
assert.ok(mjs.includes("stepDescription:"), "status.milk carries the step description");
assert.ok(mjs.includes("steps:"), "status.milk carries the steps list");

// History rows show leverage.label when the record carries it.
assert.ok(qml.includes("modelData.leverage && modelData.leverage.label"), "history shows leverage.label");

const opens = (qml.match(/\{/g) || []).length;
const closes = (qml.match(/\}/g) || []).length;
assert.equal(opens, closes, "Panel.qml braces are balanced");

// applyMilk: integers clamp into 0..100, non-integers are refused.
assert.equal(applyMilk({}, "42").constanceMilk, 42);
assert.equal(applyMilk({}, "0").constanceMilk, 0);
assert.equal(applyMilk({}, "100").constanceMilk, 100);
assert.equal(applyMilk({}, "-5").constanceMilk, 0, "below range clamps to 0");
assert.equal(applyMilk({}, "150").constanceMilk, 100, "above range clamps to 100");
assert.equal(applyMilk({ keep: 1 }, "7").keep, 1, "other settings are kept");
assert.throws(() => applyMilk({}, "abc"), /integer 0-100/);
assert.throws(() => applyMilk({}, "5.5"), /integer 0-100/);
assert.throws(() => applyMilk({}, ""), /integer 0-100/);

// The CLI writes settings.json under the fake state home and clamps the same way.
const set = (value) => execFileSync("node", [path.join(here, "settings-set.mjs"), "constanceMilk", value], { env, stdio: "pipe" });
const settingsFile = path.join(stateHome, "omarchy", "agent-usage-tabs", "settings.json");
const read = () => JSON.parse(fs.readFileSync(settingsFile, "utf8")).constanceMilk;
set("42"); assert.equal(read(), 42);
set("250"); assert.equal(read(), 100, "CLI clamps above 100");
set("-9"); assert.equal(read(), 0, "CLI clamps below 0");
assert.throws(() => execFileSync("node", [path.join(here, "settings-set.mjs"), "constanceMilk", "lots"], { env, stdio: "pipe" }), /integer 0-100|Command failed/);

fs.rmSync(home, { recursive: true, force: true });
console.log("constance-milk-panel: all tests passed");
