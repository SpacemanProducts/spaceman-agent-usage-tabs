// Guards the theme work: Panel.qml must keep taking colors from the theme
// (qs.Commons Color/Style), the meter palettes live in usage-colors.js (tested
// in usage-colors.test.mjs), and the celebration palettes still switch on the
// surface's lightness so resets read on every theme.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const qml = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "Panel.qml"), "utf8");

assert.match(qml, /foreground: Color\.popups\.text/, "text color comes from the theme");
assert.match(qml, /panelBackground: Color\.popups\.background/, "background comes from the theme");
assert.match(qml, /readonly property var panelUsage: UsageColors\.palette\(panelBackground, Color\.background\)/, "panel meters get a per-surface palette");
assert.match(qml, /readonly property var barUsage: UsageColors\.palette\(Color\.bar\.background, Color\.background\)/, "bar meters get the bar surface's palette");
assert.match(qml, /readonly property bool lightPanel: panelUsage\.light/, "celebrations key off the panel palette's lightness");
assert.match(qml, /readonly property bool lightBar: barUsage\.light/, "the bar palette reports its own lightness");

// The celebration palettes keep a dark-surface and a light-surface variant each.
for (const name of ["surpriseConfetti", "scheduledConfetti", "surpriseSparkles", "scheduledSparkles", "gold"]) {
  assert.match(qml, new RegExp("readonly property (?:color|var) " + name + ": lightPanel"), name + " switches on lightPanel");
}
assert.match(qml, /surpriseConfetti: lightPanel\s*\?\s*\[/, "surprise confetti has a light variant");
assert.match(qml, /scheduledConfetti: lightPanel\s*\?\s*\[/, "scheduled confetti has a light variant");
assert.ok(!/Qt\.darker\(foreground/.test(qml), "dim text must not use darker() (it vanishes on light themes)");
console.log("theme-colors: all tests passed");
