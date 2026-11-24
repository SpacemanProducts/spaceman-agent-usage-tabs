// The second-try rule: one send-back is fine, two is not — unless the new
// proposal is a strict-subset split or read-only. againOf links and identical
// file sets both count, loops in againOf don't hang, and sendBackAdvice only
// speaks on the second send-back.
import assert from "node:assert/strict";
import { sameFiles, chain, secondTry, sendBackAdvice } from "./constance-retry.mjs";

const sentBack = (id, files, againOf) => ({ id, status: "sent back", files, ...(againOf != null ? { againOf } : {}) });
const other = (id, status, files, againOf) => ({ id, status, files, ...(againOf != null ? { againOf } : {}) });
const AB = ["a.txt", "b.txt"];

// sameFiles: same set, any order/duplicates, trimmed; empty never matches.
assert.equal(sameFiles([" a.txt ", "b.txt", "a.txt"], ["b.txt", "a.txt"]), true);
assert.equal(sameFiles(["a.txt"], ["a.txt", "b.txt"]), false);
assert.equal(sameFiles(["a.txt", "b.txt"], ["a.txt", "c.txt"]), false);
assert.equal(sameFiles([], ["a.txt"]), false);
assert.equal(sameFiles(["a.txt"], []), false);
assert.equal(sameFiles([], []), false);

// Two jobs sent back for the same work: 7 redoes 4 (through 5, which was
// accepted — links are followed through jobs of any status, only sent-back
// ids come back). 9 was sent back for unrelated files.
const jobs = [
  sentBack(4, AB),
  other(5, "accepted", AB, 4),
  sentBack(7, AB, 5),
  sentBack(9, ["c.txt"]),
];
assert.deepEqual(chain(jobs, { files: AB, againOf: 7 }), [4, 7], "7 -> 5 -> 4, plus same-files matches; sorted and sent-back only");
assert.deepEqual(chain(jobs, { files: AB }), [4, 7], "same files alone find both");
assert.deepEqual(chain(jobs, { files: ["c.txt"] }), [9]);
assert.deepEqual(chain(jobs, {}), []);
assert.deepEqual(chain(jobs, { files: ["zzz.txt"], againOf: 9 }), [9]);
assert.deepEqual(chain(jobs, { files: AB, againOf: 99 }), [4, 7], "a missing againOf target still matches by files");

// Loops in againOf don't hang and still report both sent-back jobs.
const loop = [sentBack(1, AB, 2), sentBack(2, AB, 1)];
assert.deepEqual(chain(loop, { files: AB, againOf: 1 }), [1, 2]);

// No block after one send-back.
const one = [sentBack(4, AB)];
assert.equal(secondTry(one, { files: AB }), null);
assert.equal(secondTry(one, { files: AB, againOf: 4 }), null);
assert.equal(secondTry(one, { files: ["a.txt"] }), null, "a split of untouched work is fine");

// Block after two send-backs, linked by againOf.
const linked = secondTry(jobs, { files: AB, againOf: 7 });
assert.deepEqual(linked.ids, [4, 7]);
assert.equal(linked.reason, "Jobs 4 and 7 were already sent back for this work. Don't resend it: split it into smaller jobs (fewer files each) or do it yourself.");

// Block after two send-backs matched only by identical file sets.
const sameSet = secondTry(jobs, { files: [" b.txt ", "a.txt", "b.txt"] });
assert.deepEqual(sameSet.ids, [4, 7]);
assert.equal(sameSet.reason, linked.reason);

// A strict-subset split passes: fewer files, all contained in every chain job.
assert.equal(secondTry(jobs, { files: ["a.txt"], againOf: 7 }), null);
assert.equal(secondTry(jobs, { files: ["a.txt"], againOf: 4 }), null);

// A superset or the same set is not a split and stays blocked.
assert.equal(secondTry(jobs, { files: [...AB, "c.txt"], againOf: 7 }).ids.join(), "4,7");
assert.equal(secondTry(jobs, { files: AB, againOf: 4 }).reason, linked.reason);

// A read-only proposal (no files) is never blocked, even pointing into a chain.
assert.equal(secondTry(jobs, { files: [], againOf: 7 }), null);
assert.equal(secondTry(jobs, {}), null);

// Three ids list with commas and 'and' before the last.
const three = [sentBack(4, AB), sentBack(7, AB, 4), sentBack(9, AB, 7)];
assert.equal(secondTry(three, { files: AB, againOf: 9 }).reason,
  "Jobs 4, 7 and 9 were already sent back for this work. Don't resend it: split it into smaller jobs (fewer files each) or do it yourself.");

// sendBackAdvice: empty on the first send-back, speaks on the second.
assert.equal(sendBackAdvice([], { id: 4, files: AB, againOf: null }), "");
assert.equal(sendBackAdvice(one, { id: 5, files: ["x.txt"], againOf: null }), "", "unrelated work stays quiet");
assert.equal(sendBackAdvice(one, { id: 7, files: AB, againOf: 4 }),
  "This work has now been sent back twice (jobs 4 and 7): split it into smaller jobs or do it yourself. A new handoff with the same files will be refused.");
assert.equal(sendBackAdvice(jobs, { id: 11, files: AB, againOf: 7 }),
  "This work has now been sent back twice (jobs 4, 7 and 11): split it into smaller jobs or do it yourself. A new handoff with the same files will be refused.");

console.log("constance-retry: tests passed");
