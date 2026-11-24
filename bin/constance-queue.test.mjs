// Constance's ready-task queue: per-project, in her state folder. Tasks queue
// oldest-first, peek doesn't consume, finish marks them handed with the job id,
// remove drops one, and the view the panel/status shows lists only pending.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addTask, pendingTasks, peekNext, finishTask, removeTask, queueView, queueFile } from "./constance-queue.mjs";

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

fs.rmSync(dir, { recursive: true, force: true });
console.log("constance-queue: tests passed");
