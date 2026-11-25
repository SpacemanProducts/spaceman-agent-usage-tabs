// Constance's screen header and Milk Opus slider: four big-number tiles (done,
// copies running, her Session % used, her per-1% leverage), a 0..100 step-5
// slider that saves constanceMilk through settings-set.mjs, and each history
// row's leverage.label. Source-level checks on Panel.qml plus applyMilk and a
// CLI round-trip with a mktemp fake HOME — nothing touches the real home folder.
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

// The Milk Opus slider: labels, band word, step-5 saving through settings-set.
assert.ok(qml.includes('text: "Milk Opus"'), "slider title exists");
assert.ok(qml.includes('text: "less Opus"'), "less-Opus end label exists");
assert.ok(qml.includes('text: "more quality · " + root.constanceMilkBand'), "more-quality end shows the band word");
assert.ok(qml.includes('text: "Sandbox and guardrails always on."'), "guardrails line exists");
assert.match(qml, /readonly property int constanceMilk:/, "constanceMilk property exists");
assert.match(qml, /readonly property string constanceMilkBand:/, "constanceMilkBand property exists");
assert.match(qml, /constance\.milk/, "the slider prefers status.milk when present");
assert.ok(qml.includes('root.writeSetting(["constanceMilk", String(v)])'), "moving it writes constanceMilk");
assert.ok(qml.includes("Math.round(f * 20) * 5"), "the slider steps by 5 over 0..100");

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
