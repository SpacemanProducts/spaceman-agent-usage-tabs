// Constance's screen: the "Copy summary" chip in the LOG header (copies
// `constance.mjs summary` to the clipboard) and the Brain picker above the Lead
// Chef intensity slider (constanceBrain "claude"/"antigravity" chips, status.brain caption,
// milkLabel slider title). Source-level checks on Panel.qml — nothing touches the
// real home folder; there is no CLI run in this test.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "constance-brain-panel-"));
process.env.HOME = home;
process.env.XDG_STATE_HOME = path.join(home, "state");

const here = path.dirname(fileURLToPath(import.meta.url));
const qml = fs.readFileSync(path.join(here, "..", "Panel.qml"), "utf8");

// A) Copy summary chip: next to Copy all in the LOG header, runs `summary` piped to wl-copy.
assert.ok(qml.includes("function copyConstanceSummary()"), "copyConstanceSummary exists");
assert.ok(qml.includes('node "$1" summary | wl-copy'), "summary is piped to wl-copy");
assert.ok(qml.includes('"copy-summary"'), "the detached run is named copy-summary");
assert.ok(qml.includes("Quickshell.execDetached"), "copy uses execDetached like copyConstanceLog");
assert.ok(qml.includes("id: copySummaryChip"), "copySummaryChip exists");
assert.ok(qml.includes('label: "Copy summary"'), "summary chip label");
assert.ok(qml.includes("Copy a short report: goals, checklist, failed jobs, leverage and the last 30 log lines"), "summary chip tip");
assert.ok(qml.includes("onCopy: root.copyConstanceSummary()"), "chip calls copyConstanceSummary");
const sumIdx = qml.indexOf("id: copySummaryChip");
assert.ok(sumIdx > 0, "copySummaryChip is in the file");
const sumBlock = qml.slice(sumIdx, sumIdx + 900);
assert.ok(sumBlock.includes("anchors.right: copyAllChip.left"), "summary chip is anchored left of Copy all");
assert.ok(qml.includes("anchors.right: copySummaryChip.left"), "LOG title ends at the summary chip");
const allIdx = qml.indexOf("id: copyAllChip");
assert.ok(allIdx > sumIdx, "Copy all still comes after Copy summary");
assert.ok(qml.slice(allIdx, allIdx + 400).includes("anchors.right: parent.right"), "Copy all stays at the right edge");

// B) Brain picker above the Lead Chef intensity slider: a MiniChip per brain id writing constanceBrain.
assert.ok(qml.includes('text: "Brain"'), "Brain row title exists");
for (const [label, id] of [
  ["Claude Code", "claude"],
  ["Antigravity", "antigravity"],
  ["Grok", "grok"],
  ["Codex", "codex"],
  ["Copilot", "copilot"],
]) {
  assert.ok(qml.includes(`label: "${label}"`), `${label} chip exists`);
  assert.ok(qml.includes(`on: root.constanceBrain === "${id}"`), `${id} chip shows picked state`);
  assert.ok(qml.includes(`root.writeSetting(["constanceBrain", "${id}"])`), `${id} chip writes constanceBrain`);
}
assert.ok(qml.indexOf('label: "Claude Code"') < qml.indexOf("id: milkTitle"), "picker sits above the Milk slider");

// The picked value: userSettings first, then the setting, default "claude" — like constanceMilk.
assert.match(
  qml,
  /readonly property string constanceBrain: userSettings\.constanceBrain !== undefined\s*\? String\(userSettings\.constanceBrain\) : String\(root\.setting\("constanceBrain", "claude"\)\)/,
  "constanceBrain reads userSettings.constanceBrain with a claude default",
);

// The caption: brain.why when ok is false, "Runs on <name> · <model>" when a model is reported.
assert.ok(qml.includes("b.ok === false"), "caption shows the not-ok branch");
assert.ok(qml.includes("String(b.why)"), "caption uses brain.why");
assert.ok(qml.includes('"Runs on "'), "caption has the Runs on prefix");
assert.ok(qml.includes("String(b.model)"), "caption uses brain.model");
assert.ok(qml.includes("wrapMode: Text.WordWrap"), "caption wraps");
assert.ok(qml.includes("text: root.constanceBrainCaption"), "caption text is bound");

// The Milk slider title and tooltip lead with brain.milkLabel, falling back to "Lead Chef intensity".
assert.ok(qml.includes("constance.brain.milkLabel"), "milkLabel is read from status.brain");
assert.ok(qml.includes('|| "Lead Chef intensity"'), "Lead Chef intensity is the fallback");
assert.ok(!qml.includes('|| "Milk Opus"'), "the Milk Opus fallback is gone");
assert.ok(qml.includes("text: root.constanceMilkLabel"), "slider title uses the brain-aware label");
assert.ok(qml.includes('root.constanceMilkLabel + " " + root.constanceMilk'), "tooltip leads with the same label");

// The lead caption under the slider title: the brain's name and exact model,
// hidden when either is missing.
assert.match(qml, /readonly property string constanceLeadCaption:/, "constanceLeadCaption exists");
assert.ok(qml.includes('"Lead: "'), "lead caption prefix");
assert.ok(qml.includes("root.constanceBrainInfo"), "lead caption reads constance.brain");
assert.ok(qml.includes('n === "" || m === "" ? ""'), "lead caption hides when name or model is missing");
assert.ok(qml.includes("text: root.constanceLeadCaption"), "lead caption Text is bound");
assert.ok(qml.includes('visible: root.constanceLeadCaption !== ""'), "lead caption visibility guard");

// The share underline under the slider track: visible only when board.rev.share
// is a finite number in 0..1; nothing shows when share is null.
assert.match(qml, /readonly property real constanceRevShare:/, "constanceRevShare exists");
assert.ok(qml.includes("isFinite(s) && s >= 0 && s <= 1"), "share must be finite and in 0..1");
assert.ok(qml.includes("visible: isFinite(root.constanceRevShare)"), "underline visibility guard");
assert.ok(qml.includes("% of this goal's tokens"), "share caption wording");

const opens = (qml.match(/\{/g) || []).length;
const closes = (qml.match(/\}/g) || []).length;
assert.equal(opens, closes, "Panel.qml braces are balanced");

fs.rmSync(home, { recursive: true, force: true });
console.log("constance-brain-panel: all tests passed");
