// constance-last-goal.js: the idle panel's one "Last goal" line (status, checklist,
// when it ended), its dot color, and the report kept one click away. Panel.qml
// folds a finished goal into this line and shows the new-goal box first.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "constance-last-goal.js"), "utf8").replace(/^\.pragma library\s*$/m, "");
const ctx = {}; vm.createContext(ctx); vm.runInContext(src, ctx);
const { finished, ago, title, statusWord, summary, tone, report } = ctx;

const now = Date.UTC(2026, 10, 26, 21, 0, 0);
const H = 3600e3;

// Only an ended goal folds; running, paused and none don't.
for (const s of ["done", "stopped", "failed"]) assert.equal(finished({ status: s }), true, s);
for (const g of [null, undefined, { status: "running" }, { status: "paused" }, {}]) assert.equal(finished(g), false, JSON.stringify(g));

// When it ended.
assert.equal(ago(now - 20e3, now), "just now");
assert.equal(ago(now - 5 * 60e3, now), "5 min ago");
assert.equal(ago(now - 14 * H, now), "14 h ago");
assert.equal(ago(now - 47 * H, now), "47 h ago");
assert.equal(ago(now - 3 * 24 * H, now), "3 d ago");
assert.equal(ago(now + 60e3, now), "just now", "a clock a little ahead never says negative time");
for (const bad of [undefined, null, 0, "x", NaN]) assert.equal(ago(bad, now), "", String(bad));

// The title is the goal's first line, without a list marker.
assert.equal(title({ text: "This is for the plugin.\n1. run tests" }), "This is for the plugin.");
assert.equal(title({ text: "1. add f6\n2. add f7" }), "add f6");
assert.equal(title({ text: "- tidy the log" }), "tidy the log");
assert.equal(title({ text: "   " }), "(no goal text)");
assert.equal(title(null), "(no goal text)");

// The summary: status, checklist, age. Nothing for a goal still on.
const done = { status: "done", finishedAt: now - 14 * H, text: "x" };
assert.equal(summary(done, 7, 7, now), "Done · 7/7 · 14 h ago");
assert.equal(summary(done, 0, 0, now), "Done · 14 h ago", "no checklist, no count");
assert.equal(summary({ status: "failed" }, 1, 3, now), "Couldn't finish · 1/3", "no finish time, no age");
assert.equal(summary({ status: "stopped", finishedAt: now - 60e3 }, 2, 5, now), "Stopped · 2/5 · 1 min ago");
assert.equal(summary({ status: "done", needsOwner: true, finishedAt: now - 2 * H }, 1, 5, now), "Needs you · 1/5 · 2 h ago");
assert.equal(summary({ status: "running" }, 1, 2, now), "");
assert.equal(summary(null, 0, 0, now), "");

// The dot's color follows the meter palette's words.
assert.equal(tone(done), "green");
assert.equal(tone({ status: "stopped" }), "amber");
assert.equal(tone({ status: "failed" }), "red");
assert.equal(tone({ status: "done", needsOwner: true }), "amber");
assert.equal(tone({ status: "stopped", needsOwner: true }), "amber");
assert.equal(statusWord({ status: "stopped", needsOwner: true }), "Stopped", "Stop wins over needs-you");
assert.equal(tone({ status: "paused" }), "");

// The report stays whole (one click away), else the fail reason.
const long = "Report line\n".repeat(400);
assert.equal(report({ report: long }), long.trim(), "never clipped");
assert.equal(report({ report: "  ", failReason: "Claude exited 3 times" }), "Claude exited 3 times");
assert.equal(report({}), "");
assert.equal(report(null), "");

// Panel.qml wiring (static): the fold follows LastGoal.finished, the panel opens
// folded with the goal box first when she is idle, the goal-era blocks hide
// while folded, and Show report fetches the whole report through `C report`.
{
  const qml = fs.readFileSync(path.join(root, "Panel.qml"), "utf8");
  assert.match(qml, /import "constance-last-goal\.js" as LastGoal/);
  assert.match(qml, /readonly property bool constanceFinished: LastGoal\.finished\(constance\.goal\)/);
  assert.match(qml, /property bool constanceLastOpen: false/, "folded by default");
  assert.match(qml, /constanceError = ""\n\s*constanceLastOpen = false/, "folded again every time her panel opens");
  assert.match(qml, /readonly property bool goalFirst: !root\.constanceActive/, "idle puts the goal box first");
  assert.match(qml, /id: constanceHead\n\s*visible: root\.constanceActive/, "the stat tiles only while a goal is on");
  assert.match(qml, /label: root\.constanceLastOpen \? "Hide" : "Show report"/);
  assert.match(qml, /onClicked: root\.toggleLastGoal\(\)/);
  assert.match(qml, /command: \["node", root\.pluginDir \+ "\/bin\/constance\.mjs", "report"\]/, "Show report fetches the whole report");
  for (const what of ["checklist.total > 0 && (!root.constanceFinished || root.constanceLastOpen)", "(root.constanceBoard.cards || []).length > 0 && (!root.constanceFinished || root.constanceLastOpen)"])
    assert.ok(qml.includes(what), "folds with the goal: " + what);
}

console.log("constance-last-goal: tests passed");
