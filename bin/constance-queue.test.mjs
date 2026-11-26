// Constance's ready-task queue: per-project, in her state folder. Tasks queue
// oldest-first, peek doesn't consume, finish marks them handed with the job id,
// remove drops one, and the view the panel/status shows lists only pending.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addTask, pendingTasks, peekNext, readyTasks, finishTask, removeTask, queueView, queueFile, expireTasks } from "./constance-queue.mjs";

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "constance-queue-home-"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-queue-"));
const projA = "/home/u/proj-a", projB = "/home/u/proj-b";

assert.deepEqual(pendingTasks(projA, dir), [], "empty to start");
assert.throws(() => addTask(projA, { task: "  " }, dir), /needs a task/);

const t1 = addTask(projA, { task: "add tests", files: ["a.test.js"], agent: "grok" }, dir);
const t2 = addTask(projA, { task: "update readme", files: [] }, dir);
const t3 = addTask(projB, { task: "other project task" }, dir);
assert.equal(t1.id, 1); assert.equal(t2.id, 2); assert.equal(t3.id, 3, "ids are global across projects");
assert.equal(t1.status, "pending");
assert.deepEqual(t1.files, ["a.test.js"]); assert.equal(t1.agent, "grok");

// Per-project: A sees its two, B sees its own.
assert.deepEqual(pendingTasks(projA, dir).map((t) => t.id), [1, 2]);
assert.deepEqual(pendingTasks(projB, dir).map((t) => t.id), [3]);
assert.equal(peekNext(projA, dir).id, 1, "oldest first");

// peek does not consume; finish marks handed with the job id.
assert.equal(peekNext(projA, dir).id, 1);
finishTask(projA, 1, 42, dir);
assert.deepEqual(pendingTasks(projA, dir).map((t) => t.id), [2], "handed tasks leave the pending list");
const all = JSON.parse(fs.readFileSync(queueFile(dir), "utf8"));
assert.equal(all.projects[projA].find((t) => t.id === 1).jobId, 42);
assert.equal(all.projects[projA].find((t) => t.id === 1).status, "handed");

// The view shows pending only, with files and agent.
const view = queueView(projA, dir);
assert.equal(view.length, 1);
assert.deepEqual(view[0], { id: 2, task: "update readme", files: [], agent: "" });

// remove drops a task; removing the last one cleans the project key.
assert.equal(removeTask(projA, 2, dir), true);
assert.equal(removeTask(projA, 2, dir), false, "already gone");
assert.equal(pendingTasks(projA, dir).length, 0);
assert.ok(projA in JSON.parse(fs.readFileSync(queueFile(dir), "utf8")).projects, "handed history keeps the project key");
assert.equal(removeTask(projB, 3, dir), true);
assert.ok(!(projB in JSON.parse(fs.readFileSync(queueFile(dir), "utf8")).projects), "a fully emptied project key is dropped");

// State survives a "restart" (fresh read from disk).
addTask(projA, { task: "persisted" }, dir);
assert.equal(pendingTasks(projA, dir)[0].task, "persisted");

// readyTasks: skips tasks touching busy files, tasks already claimed by an
// earlier pick, and honours the limit; read-only tasks are always eligible.
const projR = "/home/u/proj-r";
const r1 = addTask(projR, { task: "write a.js", files: ["a.js"] }, dir);
const r2 = addTask(projR, { task: "read only" }, dir);
const r3 = addTask(projR, { task: "write b.js", files: ["b.js"] }, dir);
const r4 = addTask(projR, { task: "share a.js", files: ["a.js"] }, dir);
assert.deepEqual(readyTasks(projR, {}, dir).map((t) => t.id), [r1.id, r2.id, r3.id], "r4 shares a.js with r1, so it is not picked");
assert.deepEqual(readyTasks(projR, { busyFiles: ["a.js"] }, dir).map((t) => t.id), [r2.id, r3.id], "busy file skips r1 and the later r4 that shares it");
assert.deepEqual(readyTasks(projR, { limit: 2 }, dir).map((t) => t.id), [r1.id, r2.id], "limit caps the result");
// Two queued tasks sharing a file: the first picked claims it, the second is skipped.
const projS = "/home/u/proj-s";
const s1 = addTask(projS, { task: "first a.js", files: ["a.js", "shared.js"] }, dir);
const s2 = addTask(projS, { task: "second shared.js", files: ["shared.js"] }, dir);
const s3 = addTask(projS, { task: "third c.js", files: ["c.js"] }, dir);
assert.deepEqual(readyTasks(projS, {}, dir).map((t) => t.id), [s1.id, s3.id], "no two picked tasks share a file");
assert.deepEqual(readyTasks(projR, {}, dir), pendingTasks(projR, dir).filter((t) => t.id !== r4.id), "returns the same task objects pendingTasks returns");

// Tasks belong to the goal they were queued in: only that goal sees them, and
// expireTasks retires everything pending that isn't the running goal's.
{
  const projG = "/home/u/proj-g";
  const a = addTask(projG, { task: "goal A task", files: ["a.txt"], goal: "A", items: [1] }, dir);
  const b = addTask(projG, { task: "goal B task", files: ["b.txt"], goal: "B" }, dir);
  const u = addTask(projG, { task: "untagged task", files: ["u.txt"] }, dir);
  assert.equal(a.goal, "A"); assert.equal(u.goal, undefined, "no goal, no field");
  assert.deepEqual(pendingTasks(projG, dir).map((t) => t.id), [a.id, b.id, u.id], "without a goal filter every pending task shows (older callers)");
  assert.deepEqual(pendingTasks(projG, dir, "B").map((t) => t.id), [b.id], "goal B sees only its own task");
  assert.deepEqual(readyTasks(projG, { goal: "B" }, dir).map((t) => t.id), [b.id]);
  assert.equal(peekNext(projG, dir, "B").id, b.id);
  assert.deepEqual(queueView(projG, dir, "B").map((t) => t.id), [b.id]);
  for (const g of ["", null]) assert.deepEqual(pendingTasks(projG, dir, g), [], `goal ${JSON.stringify(g)} matches nothing`);
  assert.equal(peekNext(projG, dir, "C"), null, "a goal with no tasks gets none of the others'");
  assert.deepEqual(expireTasks(projG, "", dir), [], "no goal: nothing expires");
  const gone = expireTasks(projG, "B", dir);
  assert.deepEqual(gone.map((t) => t.id).sort(), [a.id, u.id].sort(), "goal A's and the untagged task expire while B runs");
  assert.deepEqual(pendingTasks(projG, dir).map((t) => t.id), [b.id], "only B's task is still pending");
  const all = JSON.parse(fs.readFileSync(queueFile(dir), "utf8")).projects[projG];
  assert.ok(all.filter((t) => t.status === "expired").every((t) => t.expiredAt > 0), "expired tasks are kept with the time");
  assert.deepEqual(expireTasks(projG, "B", dir), [], "a second expiry finds nothing");
  finishTask(projG, b.id, 99, dir);
  assert.deepEqual(expireTasks(projG, "C", dir), [], "a handed task never expires");
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("constance-queue: tests passed");
