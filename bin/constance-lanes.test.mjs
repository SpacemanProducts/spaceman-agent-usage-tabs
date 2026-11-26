// Constance's lanes: read-only lead jobs over real .constance/backlog.md
// items. classifyLane maps backlog kinds plus text keywords onto the four
// lane kinds, pickLanes takes open untaken lane items oldest-first without
// padding, laneTask builds the read-only FIX-lines prompt, reportFile names
// the per-job report, and fixJobs parses FIX lines into worker tasks with
// file overlaps merged and oversized merges flagged big.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LANE_KINDS, classifyLane, pickLanes, laneTask, reportFile, fixJobs } from "./constance-lanes.mjs";

const item = (kind, text, extra = {}) => ({ id: 1, kind, text, files: [], job: null, done: false, line: 0, ...extra });

// --- LANE_KINDS / classifyLane ------------------------------------------------
assert.deepEqual(LANE_KINDS.map((k) => k.id), ["merge-review", "audit", "architecture", "hard-bug"]);
assert.equal(classifyLane(item("review", "deep review of the recent merge in collect.mjs")), "merge-review");
assert.equal(classifyLane(item("review", "review the merges that landed this week")), "merge-review", "plural keyword counts");
assert.equal(classifyLane(item("review", "security audit of the sandbox boundary")), "audit");
assert.equal(classifyLane(item("review", "audit the token handling")), "audit");
assert.equal(classifyLane(item("review", "check sandboxed launches escape nothing")), "audit", "sandboxed counts");
assert.equal(classifyLane(item("design", "architecture review of the job queue")), "architecture");
assert.equal(classifyLane(item("review", "is this architecture sound?")), "architecture", "reviews can be architecture lanes too");
assert.equal(classifyLane(item("bug", "hard intermittent race in the watcher")), "hard-bug");
assert.equal(classifyLane(item("bug", "flaky deadlock under load")), "hard-bug");
assert.equal(classifyLane(item("bug", "typo in the README")), null, "an easy bug is ordinary backlog work");
assert.equal(classifyLane(item("task", "merge the docs")), null, "kind must match: 'merge' on a task is not a lane");
assert.equal(classifyLane(item("docs", "document the audit")), null);
assert.equal(classifyLane(item("review", "check the emergency merge path")), "merge-review", "word boundary: 'emergency' does not match, 'merge' does");
assert.equal(classifyLane({ kind: "review" }), null, "no text");
assert.equal(classifyLane(null), null);
assert.equal(classifyLane("merge review"), null, "a bare string is not a backlog item");
// First match wins: a security audit of a merge is an audit only if audit is
// listed first — here merge-review is first, so 'merge' wins.
assert.equal(classifyLane(item("review", "audit the security of the recent merge")), "merge-review");

// --- pickLanes ----------------------------------------------------------------
const laneA = item("review", "review the merge of job store", { id: 1, line: 3 });
const laneB = item("review", "security audit of collectors", { id: 2, line: 5 });
const laneC = item("bug", "hard race in notify watch", { id: 3, line: 7 });
const plain = item("task", "tidy up comments", { id: 4, line: 4 });
const doneLane = item("review", "audit the queue", { id: 5, line: 6, done: true });
const takenLane = item("review", "architecture of pacing", { id: 6, line: 8, job: 12 });
const zeroJob = item("review", "sandbox audit", { id: 7, line: 9, job: 0 });
const backlog = [laneC, plain, laneA, doneLane, laneB, takenLane, zeroJob]; // deliberately unordered
assert.deepEqual(pickLanes(backlog, 10).map((x) => x.id), [1, 2, 3], "lane items only, oldest (line) first");
assert.deepEqual(pickLanes(backlog, 2).map((x) => x.id), [1, 2], "n caps the result");
assert.deepEqual(pickLanes(backlog, 0), [], "n=0 picks nothing");
assert.deepEqual(pickLanes(backlog, -3), []);
assert.deepEqual(pickLanes([], 5), [], "an empty backlog returns []");
assert.deepEqual(pickLanes([plain, doneLane, takenLane, zeroJob], 5), [], "no open lane items: no padding");
assert.deepEqual(pickLanes(null, 5), []);
assert.deepEqual(pickLanes(backlog, 1.9).map((x) => x.id), [1], "fractional n floors");
assert.equal(pickLanes(backlog, 2)[0], laneA, "returns the item objects themselves");

// --- laneTask -------------------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-lanes-"));
const report = reportFile(dir, 42);
assert.equal(report, path.join(dir, "lanes", "report-42.txt"));
assert.equal(reportFile(dir, "a/b"), path.join(dir, "lanes", "report-a_b.txt"), "job ids are sanitized");
const task = laneTask(laneA, { reportPath: report });
assert.equal(task.readOnly, true);
assert.deepEqual(task.files, []);
assert.ok(task.text.includes("merge-review"), "names the lane");
assert.ok(task.text.includes("review the merge of job store"), "quotes the item");
assert.ok(task.text.includes("change nothing"), "read-only instruction");
assert.ok(task.text.includes(report), "points at the report path");
assert.ok(task.text.includes("FIX: path/a,path/b :: what to change"), "the FIX line format");

// --- fixJobs ---------------------------------------------------------------------
// Malformed lines and non-FIX lines are ignored.
assert.deepEqual(fixJobs("nothing here\nFIX: no separator\nFIX: :: no files\nFIX: a.mjs :: \nFIX: :: \n"), []);
assert.deepEqual(fixJobs(null), []);
assert.deepEqual(fixJobs(""), []);

// Basic parse: files split on commas, description kept whole.
const one = fixJobs("FIX: bin/a.mjs, bin/b.mjs :: tighten the check\n")[0];
assert.deepEqual(one.files, ["bin/a.mjs", "bin/b.mjs"]);
assert.equal(one.text, "tighten the check");
assert.equal(one.big, false);
assert.equal(fixJobs("prelude\n  FIX: ./x.mjs :: leading ./ stripped\n")[0].files[0], "x.mjs");

// Disjoint fixes stay separate tasks, in report order.
const two = fixJobs("FIX: a.mjs :: one\nFIX: b.mjs :: two\nFIX: c.mjs :: three\n");
assert.equal(two.length, 3);
assert.deepEqual(two.map((t) => t.files), [["a.mjs"], ["b.mjs"], ["c.mjs"]]);

// Overlapping files merge transitively into one task; no file in two tasks.
const merged = fixJobs("FIX: a.mjs,b.mjs :: first\nFIX: b.mjs,c.mjs :: second\nFIX: d.mjs :: third\n");
assert.equal(merged.length, 2);
assert.deepEqual(merged[0].files, ["a.mjs", "b.mjs", "c.mjs"], "union in first-seen order");
assert.equal(merged[0].text, "first; second");
assert.deepEqual(merged[1].files, ["d.mjs"]);
const allFiles = merged.flatMap((t) => t.files);
assert.equal(new Set(allFiles).size, allFiles.length, "no file appears in two tasks");

// A merged task over maxFiles is kept whole and flagged big; smaller ones are not.
const big = fixJobs("FIX: a.mjs,b.mjs,c.mjs,d.mjs :: wide\nFIX: e.mjs :: narrow\n", { maxFiles: 3 });
assert.equal(big.length, 2);
assert.equal(big[0].big, true);
assert.equal(big[0].files.length, 4, "kept whole, never split");
assert.equal(big[1].big, false);
const exact = fixJobs("FIX: a.mjs,b.mjs,c.mjs :: at the limit\n", { maxFiles: 3 });
assert.equal(exact[0].big, false, "maxFiles itself is not big");
assert.equal(fixJobs("FIX: a.mjs :: x\n", { maxFiles: 0 })[0].big, true, "maxFiles 0 flags everything");

// Duplicate FIX lines collapse to one task entry.
const dup = fixJobs("FIX: a.mjs :: same\nFIX: a.mjs :: same\n");
assert.equal(dup.length, 1);
assert.equal(dup[0].text, "same");

fs.rmSync(dir, { recursive: true, force: true });
console.log("constance-lanes: tests passed");
