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

// barLevel: the one shared severity table — color and label come from it together.
const lvl = (v) => { const l = ctx.barLevel(v); return l ? l.color + ":" + l.showPercent : "none" };
assert.equal(lvl(-1), "none"); assert.equal(lvl(NaN), "none"); assert.equal(lvl("x"), "none");
assert.equal(lvl(0), "green:false"); assert.equal(lvl(0.32), "green:false", "Claude weekly 32% -> green, no label");
assert.equal(lvl(0.59), "green:false");
assert.equal(lvl(0.6), "amber:false", "60% boundary -> amber"); assert.equal(lvl(0.89), "amber:false");
assert.equal(lvl(0.9), "red:true", "90% boundary -> red and the percentage");
assert.equal(lvl(0.94), "red:true", "Copilot 94% -> red with percentage");
assert.equal(lvl(0.99), "red:true", "Antigravity 99% -> red with percentage");
assert.equal(lvl(1), "red:true", "100% -> red with percentage");

// barWorst: the fullest meter across an agent's accounts, with its title.
const bw = (agent) => JSON.parse(JSON.stringify(ctx.barWorst(agent)));
assert.deepEqual(bw(null), { percent: -1, title: "" });
assert.deepEqual(bw({ limits: [] }), { percent: -1, title: "" });
assert.deepEqual(bw({ limits: [L("Session", 0.2), L("Weekly", 0.9), L("Monthly", 0.5)] }), { percent: 0.9, title: "Weekly" }, "fullest limit wins");
assert.deepEqual(bw({ limits: [L("Chat and agent requests", 0.943), L("Editor autocomplete", 0)] }), { percent: 0.943, title: "Chat and agent requests" }, "a 0% meter never overrides the real one");
assert.deepEqual(bw({ limits: [L("Session", 0.1)], accounts: [{ limits: [L("Weekly", 0.95)] }] }), { percent: 0.95, title: "Weekly" }, "accounts count");
assert.deepEqual(bw({ limits: [{ title: "Cursor limit", percent: 1, cap: true, hitAt: "x" }] }), { percent: 1, title: "Cursor limit" }, "a capped limit is the worst");
assert.deepEqual(bw({ limits: [L("Session", "x"), L("Weekly", null)] }), { percent: -1, title: "" }, "non-numeric ignored");

// The panel wires the shared table to the icon and the label.
const qml = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "Panel.qml"), "utf8");
assert.match(qml, /ChipMeters\.barWorst\(barAgent\)/, "the bar reads the worst reported limit");
assert.match(qml, /ChipMeters\.barLevel\(barWorst\)/, "the bar level comes from the shared table");
assert.match(qml, /barShowPercent[\s\S]*?labelText: root\.barShowPercent/, "the percentage label follows the table");
assert.match(qml, /tooltipText: root\.barTooltip/, "the tooltip names the agent the bar represents");
assert.match(qml, /"Bar shows " \+ defaultAgentName/, "the tooltip says which agent the bar shows");
console.log("bar-meters: all tests passed");
