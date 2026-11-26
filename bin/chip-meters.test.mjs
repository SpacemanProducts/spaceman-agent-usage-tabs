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

// The bar's two readings are chipMeters' {session, weekly} — the percentage is
// the session meter, the robot the weekly one, each with the tab chip's own
// fallbacks (one meter serves both; session-only serves both; other-kind
// meters stand in only when neither exists).
const bm = (agent) => JSON.parse(JSON.stringify(ctx.chipMeters(agent)));
const A = (limits, accounts) => ({ limits, accounts });

// Each installed agent's real limit shape -> the pair the bar shows.
assert.deepEqual(bm(A([L("Session", 0.62), L("Weekly", 0.38)])), { session: 0.62, weekly: 0.38 }, "Claude: session and weekly are independent");
assert.deepEqual(bm(A([L("Claude/GPT Weekly", 0.99)])), { session: 0.99, weekly: 0.99 }, "Antigravity: one meter serves both");
assert.deepEqual(bm(A([{ title: "Free grok-4.7 (24 h)", percent: 1, hitAt: "x", cap: true }])), { session: 1, weekly: 1 }, "Grok: the cap is 100% for both");
assert.deepEqual(bm(A([{ title: "Cursor limit", percent: 1, hitAt: "x", cap: true }])), { session: 1, weekly: 1 }, "Cursor: the cap is 100% for both");
assert.deepEqual(bm(A([L("Chat and agent requests", 0.943), L("Editor autocomplete", 0)])), { session: 0.943, weekly: 0.943 }, "Copilot: the requests meter stands in for both");
assert.deepEqual(bm(A([L("Monthly", 1)])), { session: 1, weekly: 1 }, "Codex: monthly only still reaches the bar through the fallback");
assert.deepEqual(bm(A([L("Daily", 0), L("Weekly", 0), L("Prompt credits", 0), L("Flow credits", 0)])), { session: 0, weekly: 0 }, "Devin: reported zeros are data");
assert.deepEqual(bm(A([])), { session: -1, weekly: -1 }, "no meters -> no data");
assert.deepEqual(bm(null), { session: -1, weekly: -1 });
assert.deepEqual(bm(A([L("Session", "x"), L("Weekly", null)])), { session: -1, weekly: -1 }, "non-numeric ignored");
assert.deepEqual(bm(A([L("Session", 0.1)], [{ limits: [L("Weekly", 0.95)] }])), { session: 0.1, weekly: 0.95 }, "accounts count");
assert.deepEqual(bm(A([L("Session", 0.51)])), { session: 0.51, weekly: 0.51 }, "session only -> the one limit serves both");
assert.deepEqual(bm(A([L("Weekly", 0.37)])), { session: 0.37, weekly: 0.37 }, "weekly only -> the one limit serves both");

// The percentages the bar must label: 51, 94, 99, 100 — the session reading is
// what the label shows, the weekly reading colors the robot.
for (const pct of [0.51, 0.94, 0.99, 1]) {
  assert.equal(bm(A([L("Session", pct), L("Weekly", pct / 2)])).session, pct, "session " + pct * 100 + "%");
  assert.equal(bm(A([L("Session", pct / 2), L("Weekly", pct)])).weekly, pct, "weekly " + pct * 100 + "%");
}
// The user's example: 62% session, 38% weekly -> "62%" in 62%'s color, robot in 38%'s.
assert.deepEqual(bm(A([L("Session", 0.62), L("Weekly", 0.38)])), { session: 0.62, weekly: 0.38 }, "62/38 split");

// The color table is UsageColors.forLevel — the same one the tab's limit bars
// use, fed by the surface's palette. Evaluate the real module so the thresholds
// can't drift apart.
const ucsrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "usage-colors.js"), "utf8").replace(/^\.pragma library\s*$/m, "");
const uctx = {}; vm.createContext(uctx); vm.runInContext(ucsrc, uctx);
const { palette, forLevel } = uctx;
const darkPal = palette("#101315");   // a dark surface keeps the bright set
const colorOf = (p) => forLevel(p, darkPal);
assert.equal(colorOf(0), "#7af07a", "0% is the green end");
assert.equal(colorOf(1), "#f07a7a", "100% is the red end: a used-up robot is never green");
assert.notEqual(colorOf(0.6), colorOf(0.61), "the bar color moves smoothly with the reading");
assert.equal(uctx.levelOf(0.6), "mid", "60% boundary is still the middle band");
assert.equal(uctx.levelOf(0.85), "mid", "85% stays in the middle band");
assert.equal(uctx.levelOf(0.851), "high", "just over 85% is still the high band");

// The panel wires the two readings to the percent, the robot and the tooltip,
// mirroring the tab chip: the chip's outside border is the session meter and
// its inside fill the weekly one, so the bar's percentage and active state
// (its underline) take the session tint and the robot takes the weekly tint —
// both through the chip's own tintFor rule (unsure readings never go green).
const qml = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "Panel.qml"), "utf8");
assert.match(qml, /ChipMeters\.chipMeters\(barAgent\)/, "the bar reads the shared session/weekly meters");
assert.match(qml, /barUnsure && p < 0\.6 \? root\.unsureColor : root\.meterColorFor\(p, root\.barUsage\)/, "the bar tint is the chip's tintFor rule on the bar's palette");
assert.match(qml, /barSessionColor: barSession >= 0 \? barTintFor\(barSession\)/, "the percentage color is the session tint");
assert.match(qml, /barRobotColor: barWeekly >= 0 \? barTintFor\(barWeekly\)/, "the robot color is the weekly tint");
assert.match(qml, /color: root\.barRobotColor/, "the robot takes the weekly color");
assert.match(qml, /activeColor: root\.barSessionColor/, "the percentage and underline take the session (chip border) color");
assert.match(qml, /labelText: root\.barSession >= 0 \? Math\.round\(root\.barSession \* 100\) \+ "%"/, "the percentage is the session reading, drawn by the built-in label");
assert.doesNotMatch(qml, /BAR_LEVELS|barLevel\(|barWorst|barShowPercent|barReadings|barValue|barIconColor|Color\.urgent/, "the divergent severity paths are gone");
assert.match(qml, /tooltipText: root\.barTooltip/, "the tooltip names the agent the bar represents");
assert.match(qml, /" — session "/, "the tooltip shows session and weekly");
console.log("bar-meters: all tests passed");
