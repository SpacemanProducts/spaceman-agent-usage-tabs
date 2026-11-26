// Constance's backlog refill: only runs when the queue is low and slots are
// free, hands out open backlog items of kind test/docs/task/bug in that
// order, skips busy or already-claimed files and taken/done items, caps at
// freeSlots, and reports 'nothing worthwhile' instead of inventing work.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseBacklog } from "./constance-backlog.mjs";
import { REFILL_KINDS, refill } from "./constance-refill.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-refill-"));
fs.mkdirSync(path.join(dir, ".constance"), { recursive: true });

const sample = [
  "# Backlog",
  "- [ ] bug: fix the flaky collector (files: collect.mjs)",
  "- [ ] test: cover the queue handoff (files: queue.test.mjs)",
  "- [ ] review: check the diff before merge",
  "- [ ] docs: update the README",
  "- [ ] task: tidy the panel copy",
  "- [x] task: already done item",
  "- [ ] task: handed to a job (job 7)",
  "- [ ] docs: second docs item (files: busy.mjs)",
  "- [ ] design: rethink the layout",
].join("\n");
fs.writeFileSync(path.join(dir, ".constance", "backlog.md"), sample);
const items = parseBacklog(sample);

assert.deepEqual(REFILL_KINDS, ["test", "docs", "task", "bug"]);

// Gates: a full queue or no free slots hands out nothing.
assert.deepEqual(refill(dir, { queueLen: 3, freeSlots: 2 }), { tasks: [], reason: "the queue is not low" });
assert.deepEqual(refill(dir, { queueLen: 2, freeSlots: 0 }), { tasks: [], reason: "no free slots" });
assert.deepEqual(refill(dir, { queueLen: 2, freeSlots: -1 }), { tasks: [], reason: "no free slots" });
assert.equal(refill(dir, { queueLen: 0, freeSlots: 1, low: 1 }).tasks.length, 1, "low is configurable");

// Order and filtering: kinds go test, docs, task, bug; review/design,
// done and job-tagged items never come out; at most freeSlots tasks.
const r = refill(dir, { queueLen: 0, freeSlots: 10 });
assert.equal(r.reason, null);
assert.deepEqual(r.tasks.map((t) => t.kind), ["test", "docs", "docs", "task", "bug"], "kind priority order");
assert.deepEqual(r.tasks.map((t) => t.backlogId), [2, 4, 8, 5, 1]);
assert.equal(r.tasks[0].task, "cover the queue handoff");
assert.deepEqual(r.tasks[0].files, ["queue.test.mjs"]);
assert.deepEqual(r.tasks[4].files, ["collect.mjs"]);

// Cap at freeSlots, still in kind order.
const capped = refill(dir, { queueLen: 0, freeSlots: 2 });
assert.deepEqual(capped.tasks.map((t) => t.backlogId), [2, 4]);
assert.equal(capped.tasks.length, 2);

// busyFiles skips an item whose files touch a busy file; an item with no
// files is never blocked.
const busy = refill(dir, { queueLen: 0, freeSlots: 10, busyFiles: ["queue.test.mjs", "collect.mjs"] });
assert.deepEqual(busy.tasks.map((t) => t.backlogId), [4, 8, 5], "busy-file items skipped, fileless items kept");
assert.deepEqual(refill(dir, { queueLen: 0, freeSlots: 10, busyFiles: ["busy.mjs"] }).tasks.map((t) => t.backlogId),
  [2, 4, 5, 1], "a busy file only matters when an item claims it");

// backlog may be a parsed items array instead of a directory.
const viaItems = refill("unused-dir", { queueLen: 0, freeSlots: 1, backlog: items });
assert.deepEqual(viaItems.tasks.map((t) => t.kind), ["test"]);

// Two picks never share a file: the second claimant of collect.mjs is skipped.
const dup = parseBacklog(sample + "\n- [ ] bug: another collector fix (files: collect.mjs)\n- [ ] task: third collect fix (files: collect.mjs)\n");
const shared = refill(dir, { queueLen: 0, freeSlots: 10, backlog: dup, busyFiles: [] });
assert.equal(shared.tasks.filter((t) => t.files.includes("collect.mjs")).length, 1, "claimed files are not double-handed");

// Nothing suitable: empty backlog, only other kinds, or everything busy.
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-refill-empty-"));
assert.deepEqual(refill(emptyDir, { queueLen: 0, freeSlots: 3 }), { tasks: [], reason: "nothing worthwhile" });
assert.deepEqual(refill(dir, { queueLen: 0, freeSlots: 3, busyFiles: ["queue.test.mjs", "collect.mjs", "busy.mjs"] }).reason,
  null, "fileless items still refill");
const onlyReview = refill(dir, { queueLen: 0, freeSlots: 3, backlog: parseBacklog("- [ ] review: a\n- [ ] design: b\n") });
assert.deepEqual(onlyReview, { tasks: [], reason: "nothing worthwhile" });
const allBusy = refill(dir, { queueLen: 0, freeSlots: 3, backlog: parseBacklog("- [ ] task: x (files: f.mjs)\n"), busyFiles: ["f.mjs"] });
assert.deepEqual(allBusy, { tasks: [], reason: "nothing worthwhile" });

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(emptyDir, { recursive: true, force: true });
console.log("constance-refill: tests passed");
