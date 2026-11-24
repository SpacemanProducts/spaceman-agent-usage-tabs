import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "chip-meters.js"), "utf8").replace(/^\.pragma library\s*$/m, "");
const ctx = {}; vm.createContext(ctx); vm.runInContext(src, ctx);
const cm = (limits) => JSON.parse(JSON.stringify(ctx.chipMeters({ limits })));
const L = (title, percent) => ({ title, percent });

assert.deepEqual(cm([L("Session", 0.92), L("Weekly", 0.38)]), { session: 0.92, weekly: 0.38 }, "Claude: both distinct");
assert.deepEqual(cm([L("Claude/GPT Weekly", 0.99)]), { session: 0.99, weekly: 0.99 }, "one meter -> both");
assert.deepEqual(cm([L("Session", 0.5)]), { session: 0.5, weekly: 0.5 }, "session only -> both");
assert.deepEqual(cm([L("Monthly", 0.2)]), { session: 0.2, weekly: 0.2 }, "monthly only -> both");
assert.deepEqual(cm([L("Daily", 0.1), L("Weekly", 0.3), L("Prompt credits", 0.9)]), { session: 0.3, weekly: 0.3 }, "weekly present, no session: weekly for both; credits ignored");
assert.deepEqual(cm([L("Monthly", 0.1), L("Auto models Monthly", 0.6), L("Named models Monthly", 0.3)]), { session: 0.6, weekly: 0.6 }, "only other meters: fullest for both");
assert.deepEqual(cm([L("Gemini Session", 0.2), L("Gemini Weekly", 0.7), L("Claude/GPT Session", 0.4), L("Claude/GPT Weekly", 0.1)]), { session: 0.4, weekly: 0.7 }, "fullest of each kind");
assert.deepEqual(cm([]), { session: -1, weekly: -1 }, "no meters -> no data");
assert.deepEqual(cm([L("Session", "x"), L("Weekly", null)]), { session: -1, weekly: -1 }, "non-numeric ignored");
assert.deepEqual(JSON.parse(JSON.stringify(ctx.chipMeters(null))), { session: -1, weekly: -1 });
assert.deepEqual(JSON.parse(JSON.stringify(ctx.chipMeters({ limits: [L("Session", 0.2), L("Weekly", 0.2)], accounts: [{ limits: [L("Session", 0.9), L("Weekly", 0.1)] }, { limits: [L("Session", 0.3), L("Weekly", 0.7)] }] }))), { session: 0.9, weekly: 0.7 }, "worst meter across accounts");
console.log("chip-meters: all tests passed");
// A limit Grok reported hitting turns the chip red even beside a 0% Weekly.
assert.deepEqual(cm([{ title: "Free grok-4.7 (24 h)", percent: 1, hitAt: "2026-11-23T01:18:32Z" }, L("Weekly", 0)]), { session: 1, weekly: 1 }, "hit limit colors both");
assert.deepEqual(cm([L("Session", 0.2), L("Weekly", 0.1), L("Monthly", 1)]), { session: 1, weekly: 1 }, "any full limit colors both");
assert.deepEqual(cm([{ title: "Free grok-4.7 (24 h)", percent: 0.7, cap: true }, L("Weekly", 0.1)]), { session: 0.7, weekly: 0.7 }, "a cap colors both");

// barReadings: the bar icon's reading — value is the worst session/weekly meter
// (the same meters the tab chip colors from), session/weekly are the real
// titled ones for the tooltip, and other/otherTitle name a driving meter of
// another kind (cap, monthly, credits) instead of inventing a session/weekly.
const br = (agent) => JSON.parse(JSON.stringify(ctx.barReadings(agent)));
const A = (limits, accounts) => ({ limits, accounts });

// Each installed agent's real limit shape -> the number the robot shows.
assert.equal(br(A([L("Session", 0.51), L("Weekly", 0.37)])).value, 0.51, "Claude: session wins");
assert.deepEqual(br(A([L("Claude/GPT Weekly", 0.9937)])), { value: 0.9937, session: -1, weekly: 0.9937, other: -1, otherTitle: "" }, "Antigravity: weekly only");
assert.deepEqual(br(A([{ title: "Free grok-4.7 (24 h)", percent: 1, hitAt: "x", cap: true }])).otherTitle, "Free grok-4.7 (24 h)", "Grok: the cap is named, not called session/weekly");
assert.equal(br(A([{ title: "Free grok-4.7 (24 h)", percent: 1, hitAt: "x", cap: true }])).value, 1, "Grok: 100% cap -> 100%");
assert.equal(br(A([{ title: "Cursor limit", percent: 1, hitAt: "x", cap: true }])).value, 1, "Cursor: 100% cap -> 100%");
assert.equal(br(A([L("Chat and agent requests", 0.943), L("Editor autocomplete", 0)])).value, 0.943, "Copilot: requests meter -> 94%");
assert.equal(br(A([L("Monthly", 1)])).value, 1, "Codex: monthly only still reaches the bar through the chip fallback");
assert.equal(br(A([L("Daily", 0), L("Weekly", 0), L("Prompt credits", 0), L("Flow credits", 0)])).value, 0, "Devin: reported zeros are data");
assert.deepEqual(br(A([])), { value: -1, session: -1, weekly: -1, other: -1, otherTitle: "" }, "no meters -> no data");
assert.deepEqual(br(null), { value: -1, session: -1, weekly: -1, other: -1, otherTitle: "" });
assert.equal(br(A([L("Session", "x"), L("Weekly", null)])).value, -1, "non-numeric ignored");
assert.equal(br(A([L("Session", 0.1)], [{ limits: [L("Weekly", 0.95)] }])).value, 0.95, "accounts count");

// The percentages the bar must label: 51, 94, 99, 100 — value is what the label shows.
for (const pct of [0.51, 0.94, 0.99, 1]) {
  assert.equal(br(A([L("Session", pct), L("Weekly", pct / 2)])).value, pct, pct * 100 + "% -> value " + pct);
}
// Weekly can be the closer one: it wins the value when it is fuller.
assert.equal(br(A([L("Session", 0.37), L("Weekly", 0.51)])).value, 0.51, "weekly wins when fuller");

// The color table is meterColorFor in Panel.qml — the same one the tab's limit
// bars use. Evaluate the real functions so the thresholds can't drift apart.
const qml = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "Panel.qml"), "utf8");
const mctx = {}; vm.createContext(mctx);
for (const name of ["greenFor", "amberFor", "redFor", "meterColorFor"]) {
  const m = qml.match(new RegExp("function " + name + "\\([^)]*\\) \\{[^}]*\\}"));
  assert.ok(m, "Panel.qml defines " + name);
  vm.runInContext(m[0], mctx);
}
const colorOf = (p) => vm.runInContext("meterColorFor(" + p + ", false)", mctx);
assert.equal(colorOf(0.51), "#4caf50", "51% -> green, same as the tab bar");
assert.equal(colorOf(0.94), "#e5484d", "94% -> red, same as the tab bar");
assert.equal(colorOf(0.99), "#e5484d", "99% -> red");
assert.equal(colorOf(1), "#e5484d", "100% -> red");
assert.equal(colorOf(0.6), "#f2a900", "60% boundary -> amber");
assert.equal(colorOf(0.85), "#f2a900", "85% stays amber (> 85% is red)");
assert.equal(colorOf(0.851), "#e5484d", "just over 85% -> red, matching the tab");

// The panel wires the shared reading to the icon, the label and the tooltip.
assert.match(qml, /ChipMeters\.barReadings\(barAgent\)/, "the bar reads the shared session/weekly meters");
assert.match(qml, /meterColorFor\(root\.barValue, root\.lightBar\)/, "the robot color uses the tab's threshold table");
assert.match(qml, /labelText: root\.barHasData/, "the percentage label shows whenever the agent reports a limit");
assert.doesNotMatch(qml, /BAR_LEVELS|barLevel\(|barWorst|barShowPercent/, "the divergent severity table is gone");
assert.match(qml, /tooltipText: root\.barTooltip/, "the tooltip names the agent the bar represents");
assert.match(qml, /" — session "/, "the tooltip shows session and weekly");
console.log("bar-meters: all tests passed");
