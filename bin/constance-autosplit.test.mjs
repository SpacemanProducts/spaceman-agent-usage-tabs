// Autosplit: a goal's items become jobs with disjoint file lists (a new constance
// module brings its test file, an existing one doesn't), the cap follows the scorecard
// sizeHint, and short goals are padded with deeper-test jobs until `min`.
import assert from "node:assert/strict";
import { autosplit, overlaps } from "./constance-autosplit.mjs";

const FILES = [
  "bin/constance.mjs", "bin/constance-board.mjs", "bin/constance-board.test.mjs",
  "bin/constance-checklist.mjs", "bin/constance-checklist.test.mjs",
  "bin/constance-tokens.mjs", "bin/constance-tokens.deep.test.mjs",
  "bin/constance-pace.mjs", "bin/constance-pace.test.mjs",
  "manifest.json",
];

// --- one job per item, files from named modules -------------------------------
const goal = `Two small fixes. Don't deploy.
1. Add bin/constance-widget.mjs with a --dry flag.
2. Fix the board: bin/constance-board.mjs clips long titles, and constance-checklist.mjs too.
Tests for each, commit.`;
let jobs = autosplit(goal, { files: FILES, min: 15 });
assert.equal(jobs.length, 5, "2 item jobs + 3 deeper-test jobs (tokens already has one); candidates ran out before min");
assert.deepEqual(jobs[0], {
  title: "Add bin/constance-widget.mjs with a --dry flag.",
  task: "Add bin/constance-widget.mjs with a --dry flag.",
  files: ["bin/constance-widget.mjs", "bin/constance-widget.test.mjs"],
  item: 1,
});
assert.deepEqual(jobs[1].files, ["bin/constance-board.mjs", "bin/constance-checklist.mjs"], "existing modules: file only, both named");
assert.equal(jobs[1].item, 2);
assert.deepEqual(overlaps(jobs), [], "no two jobs share a file");

// --- duplicates drop with a note ----------------------------------------------
const dup = autosplit("1. bin/constance-pace.mjs is slow\n2. bin/constance-pace.mjs again\n3. bin/constance-pace.mjs once more", { files: FILES, min: 0 });
assert.deepEqual(dup.map((j) => j.files), [["bin/constance-pace.mjs"], [], []]);
assert.match(dup[1].notes[0], /stays with job 1/);
assert.match(dup[2].notes[0], /stays with job 1/);
assert.deepEqual(overlaps(dup), []);

// A new module named by two items: the second keeps only the unclaimed test file.
const dupNew = autosplit("1. add bin/constance-solo.mjs\n2. extend bin/constance-solo.mjs", { files: FILES, min: 0 });
assert.deepEqual(dupNew[0].files, ["bin/constance-solo.mjs", "bin/constance-solo.test.mjs"]);
assert.deepEqual(dupNew[1].files, []);
assert.match(dupNew[1].notes[0], /stays with job 1/);

// --- the scorecard cap ---------------------------------------------------------
const slow = [{ agent: "devin", name: "Devin", jobs: 3, accepted: 1, sentBack: 2, acceptRate: 1 / 3, avgTokens: null, avgMs: null }];
const capped = autosplit("1. add bin/constance-a.mjs and bin/constance-b.mjs", { files: FILES, scorecard: slow, agent: "devin", min: 0 });
assert.deepEqual(capped[0].files, ["bin/constance-a.mjs"], "acceptRate < 0.5 caps at one file");
assert.match(capped[0].notes[0], /capped at 1 file.*scorecard: Devin/);
const reliable = [{ agent: "grok", name: "Grok", jobs: 4, accepted: 4, sentBack: 0, acceptRate: 1, avgTokens: null, avgMs: null }];
const roomy = autosplit("1. add bin/constance-a.mjs and bin/constance-b.mjs", { files: FILES, scorecard: reliable, agent: "grok", min: 0 });
assert.deepEqual(roomy[0].files, ["bin/constance-a.mjs", "bin/constance-a.test.mjs", "bin/constance-b.mjs", "bin/constance-b.test.mjs"], "reliable agent gets 4");

// --- deeper-test padding ---------------------------------------------------------
// constance-tokens already has a deep test; the other three modules don't.
const pad = autosplit("1. tiny tweak", { files: FILES, min: 4 });
assert.equal(pad.length, 4);
assert.equal(pad[0].item, 1);
const added = pad.slice(1);
assert.ok(added.every((j) => j.item === null));
assert.deepEqual(added.map((j) => j.files), [
  ["bin/constance-board.mjs", "bin/constance-board.deep.test.mjs"],
  ["bin/constance-checklist.mjs", "bin/constance-checklist.deep.test.mjs"],
  ["bin/constance-pace.mjs", "bin/constance-pace.deep.test.mjs"],
], "repo order, tokens skipped (already deep-tested), *.mjs itself and *.test.mjs never candidates");
assert.match(added[0].task, /Added to reach the minimum of 4 jobs/);
assert.match(added[0].task, /constance-board\.deep\.test\.mjs/);
assert.deepEqual(overlaps(pad), []);

// No padding when min is already met or no candidates remain.
assert.equal(autosplit("1. a\n2. b\n3. c", { files: FILES, min: 3 }).length, 3);
assert.equal(autosplit("1. a", { files: ["bin/constance.mjs"], min: 15 }).length, 1, "constance.mjs and test files are not candidates");
assert.equal(autosplit("1. a", { files: [], min: 15 }).length, 1);

// A module claimed by a real job still gets its deep-test job, minus the shared file.
const mixed = autosplit("1. fix bin/constance-board.mjs\n2. tidy pace", { files: FILES, min: 3 });
const boardDeep = mixed.find((j) => j.title.startsWith("Deeper test: bin/constance-board"));
assert.deepEqual(boardDeep.files, ["bin/constance-board.deep.test.mjs"], "module file stays with job 1");
assert.match(boardDeep.notes[0], /stays with job 1/);
assert.deepEqual(overlaps(mixed), []);

// No list in the goal: the whole goal is one item/job.
const single = autosplit("Just fix the thing", { files: FILES, min: 0 });
assert.equal(single.length, 1);
assert.equal(single[0].item, 1);
assert.equal(single[0].task, "Just fix the thing");

console.log("constance-autosplit: ok");
