// Batch review of self-merged jobs: batches() picks merged, unreviewed jobs
// oldest first in chunks of five; batchPrompt() packs id, a 300-char task
// summary and a 4000-char diff per job with the one-line reply contract;
// parseVerdicts() maps "ID ok" / "ID fail: reason" lines onto exactly the
// requested ids (missing or garbled -> fail "no verdict"); applyVerdicts()
// reverts fails and marks every job reviewed through injected fakes.
import assert from "node:assert/strict";
import { BATCH_SIZE, batches, batchPrompt, parseVerdicts, applyVerdicts } from "./constance-batchreview.mjs";

const job = (id, extra = {}) => ({ id, status: "merged", task: `task ${id}`, mergedAt: 1000 + id, ...extra });

// batches: only status "merged" counts, oldest merge first, chunked by size.
assert.equal(BATCH_SIZE, 5);
const mixed = [
  job(3, { mergedAt: 3000 }), job(1, { mergedAt: 1000 }),
  { id: 2, status: "accepted", mergedAt: 500 }, { id: 4, status: "finished" },
  job(5, { mergedAt: 2000, finishedAt: 900 }),
];
const bs = batches(mixed);
assert.equal(bs.length, 1);
assert.deepEqual(bs[0].map((j) => j.id), [1, 5, 3], "merged only, oldest mergedAt first");
const many = Array.from({ length: 12 }, (_, i) => job(i + 1, { mergedAt: (12 - i) * 10 }));
const chunks = batches(many);
assert.deepEqual(chunks.map((c) => c.length), [5, 5, 2]);
assert.deepEqual(chunks[0].map((j) => j.id), [12, 11, 10, 9, 8], "reverse-sorted input still comes out oldest first");
assert.deepEqual(batches([], 3), []);
assert.deepEqual(batches(many, 0).map((c) => c.length), [5, 5, 2], "bad size falls back to 5");
assert.deepEqual(batches(many, 20).map((c) => c.length), [12]);

// batchPrompt: every job's id, clipped task and clipped diff, plus the contract.
const diffs = { 1: "d1", 2: "d2" };
const prompt = batchPrompt([job(1, { task: "x".repeat(400) }), job(2, { task: "", summary: "short summary" })], { diffOf: (j) => diffs[j.id] });
assert.ok(prompt.includes("<job id> ok"), "reply contract for ok");
assert.ok(prompt.includes("<job id> fail: <reason>"), "reply contract for fail");
assert.ok(prompt.includes("== Job 1 ==") && prompt.includes("== Job 2 =="));
assert.ok(prompt.includes("Task: " + "x".repeat(299) + "…"), "task clipped to 300 chars");
assert.ok(prompt.includes("Task: short summary"), "summary used when no task");
assert.ok(prompt.includes("Diff:\nd1") && prompt.includes("Diff:\nd2"));
const bigDiff = batchPrompt([job(1)], { diffOf: () => "y".repeat(5000) });
const diffLine = bigDiff.split("\n").find((l) => l.startsWith("y"));
assert.equal(diffLine.length, 4000, "diff clipped to 4000 chars");
assert.ok(diffLine.endsWith("…"), "clip marks the cut");
assert.ok(batchPrompt([job(1)]).includes("Diff:\n"), "missing diffOf gives an empty diff");

// parseVerdicts: ok/fail lines, optional colon, missing and invented ids.
const reply = [
  "Here are my verdicts:",
  "12 ok",
  "13 fail: tests broke",
  "14 fail no colon reason",
  "99 ok",
  "not a verdict line",
  "15 maybe",
].join("\n");
const v = parseVerdicts(reply, [12, 13, 14, 16]);
assert.deepEqual(v["12"], { ok: true, reason: "" });
assert.deepEqual(v["13"], { ok: false, reason: "tests broke" });
assert.deepEqual(v["14"], { ok: false, reason: "no colon reason" });
assert.deepEqual(v["16"], { ok: false, reason: "no verdict" }, "missing id counts as fail");
assert.equal(v["99"], undefined, "unrequested id ignored");
const malformed = parseVerdicts("garbage\n\n13 ok ok ok\n14 FAIL: case matters\n", [13, 14, 15]);
assert.equal(malformed["13"].ok, true, "extra words after ok still count");
assert.equal(malformed["14"].ok, false, "FAIL is not a verdict");
assert.equal(malformed["14"].reason, "no verdict");
assert.equal(malformed["15"].reason, "no verdict", "fully malformed reply fails every id");
assert.deepEqual(parseVerdicts(null, [1]), { "1": { ok: false, reason: "no verdict" } });

// applyVerdicts: fails revert then mark "reverted", oks just mark "ok",
// a failed revert leaves the job unmarked and lands in revertFailed.
const calls = [];
const batch = [job(1), job(2), job(3), job(4)];
const revert = (j) => { calls.push(["revert", j.id]); return j.id === 4 ? { ok: false, output: "conflict" } : { ok: true }; };
const markReviewed = (j, verdict) => calls.push(["mark", j.id, verdict]);
const summary = applyVerdicts(parseVerdicts("1 ok\n2 fail: bad diff\n4 fail: also bad\n", batch.map((j) => j.id)), { jobs: batch, revert, markReviewed });
assert.deepEqual(summary, { total: 4, ok: 1, reverted: 2, revertFailed: [4] });
assert.deepEqual(calls, [
  ["mark", 1, "ok"],
  ["revert", 2], ["mark", 2, "reverted"],
  ["revert", 3],           // "no verdict" counts as a fail and is reverted
  ["mark", 3, "reverted"],
  ["revert", 4],           // failed revert: no markReviewed
]);

// Entries that already carry their job work without the jobs lookup.
const calls2 = [];
const s2 = applyVerdicts([{ job: job(7), ok: true }, { job: job(8), ok: false, reason: "x" }], {
  revert: (j) => calls2.push(["revert", j.id]),
  markReviewed: (j, v) => calls2.push(["mark", j.id, v]),
});
assert.deepEqual(s2, { total: 2, ok: 1, reverted: 1, revertFailed: [] });
assert.deepEqual(calls2, [["mark", 7, "ok"], ["revert", 8], ["mark", 8, "reverted"]]);

console.log("constance-batchreview: tests passed");
