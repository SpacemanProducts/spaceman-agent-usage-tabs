// The goal checklist: a goal splits into its numbered/bulleted items (preamble and closing lines are not
// items; indented lines continue one), jobs tag their items, and an item ticks only when one of its
// jobs is merged and none is still open, or when she ticked it herself.
import assert from "node:assert/strict";
import { parseItems, parseItemArg, jobItems, checklist } from "./constance-checklist.mjs";

const goalText = `Four small Bulk Radar improvements. Don't deploy.
1. Book page title: rename it.
2) Top 10 pick: cap big-ticket items
   at 3 and fill the rest.
3. Trip mode savings.
4. Add a rules file.
Split across Devin copies. Tests for each, commit.`;
assert.deepEqual(parseItems(goalText), ["Book page title: rename it.", "Top 10 pick: cap big-ticket items at 3 and fill the rest.", "Trip mode savings.", "Add a rules file."]);
assert.deepEqual(parseItems("- a\n* b\n• c"), ["a", "b", "c"], "bullets work too");
assert.deepEqual(parseItems("Add a dark mode\nswitch to settings"), ["Add a dark mode switch to settings"], "no list: the whole goal is one item");
assert.deepEqual(parseItems("Fix it:\n1. only one"), ["Fix it: 1. only one"], "a one-entry list is just the goal");
assert.deepEqual(parseItems(""), []);
assert.deepEqual(parseItems("1.5 seconds is too slow\n2. b\n3. c"), ["b", "c"], "a number needs . or ) and a space");

assert.deepEqual(parseItemArg("3,1, 3"), [1, 3]);
assert.deepEqual(parseItemArg(""), []);
assert.deepEqual(parseItemArg([2, "x", 0]), [2]);
assert.deepEqual(jobItems({ items: [2, 9] }, 4), [2], "out-of-range tags are dropped");
assert.deepEqual(jobItems({}, 4), [], "no tag, several items: no guess");
assert.deepEqual(jobItems({}, 1), [1], "a one-item goal owns every job");

const goal = { id: "g1", text: goalText };
const job = (id, items, status, extra = {}) => ({ id, goal: "g1", items, status, ...extra });
const jobs = [
  job(1, [1], "accepted"),                       // merged -> item 1 done
  job(2, [2], "accepted"), job(3, [2], "running"), // a merged job but another still open -> working
  job(4, [3], "sent back"), job(5, [3], "finished"), // waiting for her review
  job(6, [4], "conflict"),                        // merge conflict
  job(7, [4], "accepted", { goal: "old" }),       // another goal's job doesn't count
];
let c = checklist(goal, jobs);
assert.deepEqual(c.items.map((x) => x.state), ["done", "working", "review", "problem"]);
assert.equal(c.line, "1 of 4 done");
assert.deepEqual(c.items[1].jobs, [2, 3]);

// Sent back then redone and merged: done. She ticks item 4 herself: done, by her.
jobs[2].status = "accepted"; jobs[4].status = "accepted";
c = checklist({ ...goal, checked: { 4: "did it myself" } }, jobs);
assert.deepEqual(c.items.map((x) => x.state), ["done", "done", "done", "done"]);
assert.equal(c.items[3].by, "constance"); assert.equal(c.items[0].by, "jobs");
assert.equal(c.line, "4 of 4 done");

// Practice runs never tick anything; nothing done yet is "todo".
c = checklist({ id: "g2", text: "1. a\n2. b" }, [{ id: 1, goal: "g2", items: [1], status: "accepted", summary: "(practice run: the prompt is in the log, nothing was launched)" }]);
assert.deepEqual(c.items.map((x) => x.state), ["todo", "todo"]);
assert.equal(c.line, "0 of 2 done");
// Items stored on the goal at start win over re-parsing its text.
assert.equal(checklist({ id: "g3", text: "ignored", items: ["x", "y", "z"] }, []).total, 3);
assert.deepEqual(checklist(null, []), { items: [], done: 0, total: 0, line: "" });
console.log("constance-checklist: ok");
