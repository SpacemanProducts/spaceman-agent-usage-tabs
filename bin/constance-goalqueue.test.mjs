// The owner's goal queue: add, edit, reorder and remove goals; take the next one; a stopped queue
// holds until forced; and needsOwner() says when a finished goal must stop the queue.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readGoalQueue, addGoal, removeGoal, editGoal, moveGoal, takeNext, pauseQueue, resumeQueue, needsOwner } from "./constance-goalqueue.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-goalqueue-"));
assert.deepEqual(readGoalQueue(dir), { goals: [], paused: "" });
assert.throws(() => addGoal(dir, { text: "  ", dir: "/p" }), /goal first/);
assert.throws(() => addGoal(dir, { text: "x" }), /folder/);
const a = addGoal(dir, { text: " A ", dir: "/p/a" }), b = addGoal(dir, { text: "B", dir: "/p/b" }), c = addGoal(dir, { text: "C", dir: "/p/c" });
assert.equal(a.text, "A");
const order = () => readGoalQueue(dir).goals.map((g) => g.text).join("");
assert.equal(order(), "ABC");
moveGoal(dir, c.id, "up"); assert.equal(order(), "ACB");
moveGoal(dir, a.id, "down"); assert.equal(order(), "CAB");
moveGoal(dir, b.id, "top"); assert.equal(order(), "BCA");
moveGoal(dir, b.id, "up"); assert.equal(order(), "BCA", "already first: stays");
moveGoal(dir, b.id, 9); assert.equal(order(), "CAB", "a position past the end means last");
assert.throws(() => moveGoal(dir, "nope", "up"), /No queued goal/);
assert.throws(() => moveGoal(dir, a.id, "sideways"), /up, down/);
editGoal(dir, a.id, { text: "A2", dir: "/p/a2" });
assert.deepEqual(readGoalQueue(dir).goals.find((g) => g.id === a.id), { ...a, text: "A2", dir: "/p/a2" });
assert.throws(() => editGoal(dir, a.id, { text: " " }), /empty/);
removeGoal(dir, c.id); assert.equal(order(), "A2B");
assert.throws(() => removeGoal(dir, c.id), /No queued goal/);

// Next comes off the front; a stopped queue gives nothing until forced (the owner's Start next).
pauseQueue(dir, "job 3 hit a merge conflict");
assert.equal(readGoalQueue(dir).paused, "job 3 hit a merge conflict");
assert.equal(takeNext(dir), null);
assert.equal(order(), "A2B", "nothing taken while stopped");
assert.equal(takeNext(dir, { force: true }).text, "A2");
assert.equal(readGoalQueue(dir).paused, "", "forcing clears the stop");
pauseQueue(dir, "x"); resumeQueue(dir);
assert.equal(takeNext(dir).text, "B");
assert.equal(takeNext(dir), null, "empty");

// needsOwner: what stops the queue.
const g = { id: "g", text: "1. a\n2. b", status: "done" };
const j = (id, status, items, extra = {}) => ({ id, goal: "g", status, items, ...extra });
assert.deepEqual(needsOwner(g, [j(1, "accepted", [1]), j(2, "accepted", [2]), j(3, "sent back", [2])]), [], "all merged, all reviewed: move on");
assert.deepEqual(needsOwner(g, [j(1, "accepted", [1])]), ["item 2 of the checklist not done"]);
assert.deepEqual(needsOwner(g, [j(1, "accepted", [1])], { practice: true }), [], "practice merges nothing, so the checklist doesn't stop it");
assert.deepEqual(needsOwner({ ...g, checked: { 2: "by her" } }, [j(1, "accepted", [1])]), [], "an item she ticked herself counts");
assert.deepEqual(needsOwner(g, [j(1, "accepted", [1]), j(2, "conflict", [2])]), ["job 2 hit a merge conflict", "item 2 of the checklist not done"]);
assert.deepEqual(needsOwner(g, [j(1, "finished", [1]), j(2, "finished", [2]), j(3, "held", [])], { practice: true }), ["jobs 1, 2 never got reviewed", "job 3 still running"]);
assert.deepEqual(needsOwner(g, [j(1, "finished", [1], { summary: "(practice run: the prompt is in the log, nothing was launched)" })], { practice: true }), [], "unreviewed practice jobs are fine");
assert.deepEqual(needsOwner({ ...g, status: "failed" }, [], { practice: true }), ["she couldn't finish the goal"]);
assert.deepEqual(needsOwner({ ...g, needsOwner: "Pick a color for the button" }, [j(1, "accepted", [1, 2])]), ["Pick a color for the button"], "her own flag");
assert.deepEqual(needsOwner({ id: "g", text: "one thing", status: "done" }, []), [], "a single-item goal with no jobs (she did it herself) moves on");
assert.deepEqual(needsOwner(g, [j(1, "accepted", [1]), { id: 5, goal: "other", status: "conflict" }], { practice: true }), [], "another goal's jobs don't count");
console.log("constance-goalqueue: ok");
