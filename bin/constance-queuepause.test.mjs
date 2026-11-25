// The owner's "Pause queue" (constance-goalqueue.mjs holdQueue/releaseQueue): no goal comes off a
// paused queue (not even with Start next's force), goals can still be added, edited, reordered and
// removed, the pause is kept in the file, and it is separate from a stop for the owner. Plus the
// board's Now line and the job cards' stuck / Give it to Opus fields.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readGoalQueue, addGoal, removeGoal, editGoal, moveGoal, takeNext, pauseQueue, holdQueue, releaseQueue } from "./constance-goalqueue.mjs";
import { cards, nowLine } from "./constance-board.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-qpause-"));
const a = addGoal(dir, { text: "goal A", dir: "/p" }, 1);
const b = addGoal(dir, { text: "goal B", dir: "/p" }, 2);

let q = holdQueue(dir, 1234);
assert.equal(q.ownerPaused, true); assert.equal(q.ownerPausedAt, 1234);
assert.equal(holdQueue(dir, 9999).ownerPausedAt, 1234, "pausing twice keeps the first time");
assert.equal(takeNext(dir), null, "nothing starts from a paused queue");
assert.equal(takeNext(dir, { force: true }), null, "not even Start next's force");
assert.equal(readGoalQueue(dir).goals.length, 2, "nothing was taken");

// Still editable while paused.
const c = addGoal(dir, { text: "goal C", dir: "/p" });
editGoal(dir, a.id, { text: "goal A, edited" });
moveGoal(dir, c.id, "top");
removeGoal(dir, b.id);
q = readGoalQueue(dir);
assert.deepEqual(q.goals.map((g) => g.text), ["goal C", "goal A, edited"]);
assert.equal(q.ownerPaused, true, "edits keep the pause");

// Kept in the file (a restart reads it back), and separate from a stop for the owner.
assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "goal-queue.json"), "utf8")).ownerPaused, true);
pauseQueue(dir, "job 3 hit a merge conflict");
q = releaseQueue(dir);
assert.equal(q.ownerPaused, false); assert.equal(q.ownerPausedAt, 0);
assert.equal(q.paused, "job 3 hit a merge conflict", "resuming doesn't clear a stop for the owner");
assert.equal(takeNext(dir), null, "still stopped for the owner");
assert.equal(takeNext(dir, { force: true }).text, "goal C", "Start next clears the owner stop");
assert.equal(takeNext(dir).text, "goal A, edited");
// A malformed flag never reads as paused.
fs.writeFileSync(path.join(dir, "goal-queue.json"), JSON.stringify({ goals: [], ownerPaused: "yes", ownerPausedAt: 5 }));
assert.deepEqual(readGoalQueue(dir), { goals: [], paused: "", ownerPaused: false, ownerPausedAt: 0 });
fs.rmSync(dir, { recursive: true, force: true });

// Now line.
const queued = [{ id: "x", text: "t", dir: "/p" }, { id: "y", text: "u", dir: "/p" }];
assert.equal(nowLine({ goal: null, goalQueue: queued, queueHeld: true }), "Queue paused: 2 goals wait for Resume queue.");
assert.equal(nowLine({ goal: null, goalQueue: queued.slice(0, 1), queueHeld: true }), "Queue paused: 1 goal waits for Resume queue.");
assert.match(nowLine({ goal: { id: "g", status: "running" }, jobs: [], goalQueue: queued, queueHeld: true }), /2 goals queued \(queue paused\)\.$/);
assert.match(nowLine({ goal: { id: "g", status: "running" }, jobs: [], goalQueue: queued }), /2 goals queued\.$/);

// Cards: Give it to Opus on running cards, stuck reason, and who Opus replaced.
const goal = { id: "g", text: "x" };
const cs = cards({ goal, jobs: [
  { id: 1, goal: "g", agent: "devin", worker: "Devin 1", status: "running", task: "a", files: ["a"] },
  { id: 2, goal: "g", agent: "grok", status: "running", task: "b", files: ["b"], stuck: { reason: "no file changes and no log output for 15 min" } },
  { id: 3, goal: "g", agent: "claude", worker: "Opus", status: "running", task: "c", files: ["c"], handedFrom: { agent: "devin", worker: "Devin 2" } },
  { id: 4, goal: "g", agent: "grok", status: "finished", task: "d", files: [], stuck: { reason: "old" } },
], names: (id) => id[0].toUpperCase() + id.slice(1) });
assert.deepEqual(cs.map((x) => x.canTakeOver), [true, true, false, false]);
assert.deepEqual(cs.map((x) => x.stuck), ["", "no file changes and no log output for 15 min", "", ""], "only a running job shows stuck");
assert.equal(cs[2].worker, "Opus"); assert.equal(cs[2].handedFrom, "Devin 2");
assert.equal(cs[0].handedFrom, "");
console.log("constance-queuepause: ok");
