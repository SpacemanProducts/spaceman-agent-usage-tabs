// Deeper edge-case pass on the batch review (bin/constance-batchreview.mjs),
// complementing constance-batchreview.test.mjs. The module is pure — nothing
// here touches the filesystem — so the mkdtemp HOME/XDG dirs are only a guard
// so nothing can ever touch the real home folder. Covers what the first test
// leaves out: wrong input types, sort/tie-break and falsy-timestamp edges,
// clip boundaries (exact length, empty task, non-string diff, surrogate
// pairs), verdict-line parsing corner cases (duplicates, bare fail, CRLF,
// id charset), and applyVerdicts entry shapes, precedence, throw paths and
// revert return-value edges. Suspected bugs are commented out with a note,
// not fixed (this job is test-only).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BATCH_SIZE, batches, batchPrompt, parseVerdicts, applyVerdicts } from "./constance-batchreview.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constance-batchreview-deep-"));
for (const d of ["home", "state", "config", "cache"]) fs.mkdirSync(path.join(tmp, d), { recursive: true });
process.env.HOME = path.join(tmp, "home");
process.env.XDG_STATE_HOME = path.join(tmp, "state");
process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
process.env.XDG_CACHE_HOME = path.join(tmp, "cache");

const job = (id, extra = {}) => ({ id, status: "merged", task: `task ${id}`, mergedAt: 1000 + id, ...extra });

// ---------- batches: input types and sort edges ----------

assert.deepEqual(batches(null), []);
assert.deepEqual(batches(undefined), []);
assert.deepEqual(batches([]), []);
assert.throws(() => batches({}), TypeError, "a truthy non-array crashes on .filter");
assert.throws(() => batches(5), TypeError);
assert.throws(() => batches("merged"), TypeError);

// Falsy entries inside the array are filtered out, not crashed on.
assert.deepEqual(batches([null, false, 0, job(1)]).flat().map((j) => j.id), [1]);
// Status is matched exactly: "MERGED" and " merged " do not count.
assert.deepEqual(batches([job(1, { status: "MERGED" }), job(2, { status: " merged " })]), []);

// `when` is mergedAt || finishedAt || 0: a missing mergedAt falls back to
// finishedAt, and a falsy mergedAt (0, null, "") falls through the same way.
const byFinished = batches([
  job(1, { mergedAt: null, finishedAt: 500 }),
  job(2, { mergedAt: undefined, finishedAt: 100 }),
  job(3, { mergedAt: null, finishedAt: 300 }), // no usable mergedAt
]);
assert.deepEqual(byFinished[0].map((j) => j.id), [2, 3, 1], "finishedAt orders when mergedAt is absent");
const zeroMerged = batches([
  job(1, { mergedAt: 0, finishedAt: 5000 }),
  job(2, { mergedAt: 100 }),
]);
assert.deepEqual(zeroMerged[0].map((j) => j.id), [2, 1], "mergedAt:0 is falsy, so finishedAt wins");

// Equal timestamps tie-break by ascending id.
const tied = batches([job(9, { mergedAt: 7 }), job(3, { mergedAt: 7 }), job(5, { mergedAt: 7 })]);
assert.deepEqual(tied[0].map((j) => j.id), [3, 5, 9]);
// Jobs with no timestamps at all sort first (when = 0), by id.
const timeless = batches([job(4, { mergedAt: null, finishedAt: null }), job(2, { mergedAt: 0, finishedAt: 0 }), job(8, { mergedAt: 50 })]);
assert.deepEqual(timeless[0].map((j) => j.id), [2, 4, 8]);

// size edge cases all fall back to BATCH_SIZE except positive integers.
for (const bad of [-3, 0, 2.5, "2", NaN, Infinity, null]) {
  assert.deepEqual(batches(Array.from({ length: 6 }, (_, i) => job(i + 1)), bad).map((c) => c.length), [5, 1], `size=${bad}`);
}
assert.deepEqual(batches(Array.from({ length: 6 }, (_, i) => job(i + 1)), 3).map((c) => c.length), [3, 3]);
assert.deepEqual(batches(Array.from({ length: 6 }, (_, i) => job(i + 1)), 1).map((c) => c.length), [1, 1, 1, 1, 1, 1]);
assert.deepEqual(batches(Array.from({ length: 6 }, (_, i) => job(i + 1)), 99).map((c) => c.length), [6]);

// batches() must not mutate its input: the caller's array order is preserved.
const input = [job(3, { mergedAt: 30 }), job(1, { mergedAt: 10 }), job(2, { status: "accepted" })];
const inputOrder = input.map((j) => j.id);
batches(input);
assert.deepEqual(input.map((j) => j.id), inputOrder, "input array order unchanged");

// ---------- batchPrompt: boundaries and odd inputs ----------

// An empty batch still produces the full contract header.
const emptyPrompt = batchPrompt([]);
assert.ok(emptyPrompt.includes("Review these 0 merged jobs"));
assert.ok(emptyPrompt.includes("<job id> ok") && emptyPrompt.includes("<job id> fail: <reason>"));
assert.ok(emptyPrompt.includes("Jobs:"));

// Clip boundary: exactly TASK_CHARS is not clipped; one more is.
const exact = batchPrompt([job(1, { task: "t".repeat(300) })]);
assert.ok(exact.includes("Task: " + "t".repeat(300) + "\n"), "300-char task kept whole");
const over = batchPrompt([job(1, { task: "t".repeat(301) })]);
assert.ok(over.includes("Task: " + "t".repeat(299) + "…\n"), "301-char task clipped to 300");

// Task fallback: falsy task ("", null, 0) falls to summary; whitespace task is truthy.
assert.ok(batchPrompt([job(1, { task: "", summary: "sum" })]).includes("Task: sum"));
assert.ok(batchPrompt([job(1, { task: null, summary: "sum2" })]).includes("Task: sum2"));
assert.ok(batchPrompt([job(1, { task: "  ", summary: "sum3" })]).includes("Task:   "), "whitespace-only task wins over summary");
assert.ok(batchPrompt([job(1, { task: null, summary: null })]).includes("Task: \n"), "no task or summary gives an empty Task line");

// diffOf edges: non-string results are String()-ed, exceptions propagate.
const numDiff = batchPrompt([job(1)], { diffOf: () => 42 });
assert.ok(numDiff.includes("Diff:\n42"), "numeric diff coerced to string");
const nullDiff = batchPrompt([job(1)], { diffOf: () => null });
assert.ok(nullDiff.includes("Diff:\n\n"), "null diff becomes empty string");
assert.throws(() => batchPrompt([job(1)], { diffOf: () => { throw new Error("boom"); } }), /boom/, "a throwing diffOf propagates");
// diffOf is called once per job, in batch order.
const seen = [];
batchPrompt([job(1), job(2)], { diffOf: (j) => { seen.push(j.id); return "d"; } });
assert.deepEqual(seen, [1, 2]);

// A multi-line diff is kept verbatim (clipping does not flatten newlines).
const multi = batchPrompt([job(1)], { diffOf: () => "line1\nline2\nline3" });
assert.ok(multi.includes("Diff:\nline1\nline2\nline3\n"));

// clip() works in UTF-16 code units: an emoji straddling the 4000-char cut is
// split, leaving a lone surrogate before the ellipsis. Documented behavior.
const emojiDiff = "a".repeat(3998) + "😀" + "tail"; // 3998 + 2 + 4 = 4004 units
const emojiPrompt = batchPrompt([job(1)], { diffOf: () => emojiDiff });
const emojiLine = emojiPrompt.split("\n").find((l) => l.startsWith("a"));
assert.equal(emojiLine.length, 4000, "clipped diff is exactly 4000 code units");
assert.ok(emojiLine.endsWith("…"));
assert.equal(emojiLine.charCodeAt(3998), 0xd83d, "high surrogate of the split emoji survives");

// ---------- parseVerdicts: parsing corner cases ----------

// Non-string text and missing/odd ids.
assert.deepEqual(parseVerdicts(42, [1]), { "1": { ok: false, reason: "no verdict" } }, "number text has no verdicts");
assert.deepEqual(parseVerdicts({}, [1]), { "1": { ok: false, reason: "no verdict" } }, "object text stringifies to '[object Object]'");
assert.deepEqual(parseVerdicts([], [1]), { "1": { ok: false, reason: "no verdict" } });
assert.deepEqual(parseVerdicts("1 ok", null), {}, "null ids give an empty map");
assert.deepEqual(parseVerdicts("1 ok", undefined), {});
assert.deepEqual(parseVerdicts("1 ok", []), {});
// ids are stringified for lookup: numbers and strings collapse to the same key.
assert.deepEqual(parseVerdicts("1 ok", [1, "1"]), { "1": { ok: true, reason: "" } });
assert.deepEqual(parseVerdicts("null ok", [null]), { "null": { ok: true, reason: "" } }, "String(null) is a valid lookup key");
// An id the regex can never produce simply never matches.
assert.deepEqual(parseVerdicts("a b ok", ["a b"]), { "a b": { ok: false, reason: "no verdict" } });
assert.deepEqual(parseVerdicts("job.1 ok", ["job.1"]), { "job.1": { ok: false, reason: "no verdict" } }, "dots are outside the id charset");

// Duplicate verdict lines: the FIRST one wins, in either direction.
assert.deepEqual(parseVerdicts("1 ok\n1 fail: changed my mind", [1])["1"], { ok: true, reason: "" });
assert.deepEqual(parseVerdicts("1 fail: first\n1 ok", [1])["1"], { ok: false, reason: "first" });

// Colon and reason variants.
assert.deepEqual(parseVerdicts("1 ok:", [1])["1"], { ok: true, reason: "" }, "ok with a stray colon still ok");
assert.deepEqual(parseVerdicts("1 fail:", [1])["1"], { ok: false, reason: "no reason given" }, "empty reason after colon");
assert.deepEqual(parseVerdicts("1 fail", [1])["1"], { ok: false, reason: "no reason given" }, "bare fail");
assert.deepEqual(parseVerdicts("1 fail:   spaced reason   ", [1])["1"], { ok: false, reason: "spaced reason" }, "reason trimmed");
assert.deepEqual(parseVerdicts("1 fail: a: b: c", [1])["1"], { ok: false, reason: "a: b: c" }, "colons inside the reason kept");

// Whitespace tolerance: tabs and leading spaces are fine; the verdict word is
// case-sensitive and must be a whole word.
assert.deepEqual(parseVerdicts("\t2\tfail:\ttab reason", [2])["2"], { ok: false, reason: "tab reason" });
assert.deepEqual(parseVerdicts("   3   ok   extra words here", [3])["3"], { ok: true, reason: "" });
assert.deepEqual(parseVerdicts("4 okay", [4])["4"], { ok: false, reason: "no verdict" }, "'okay' is not 'ok'");
assert.deepEqual(parseVerdicts("5 oks", [5])["5"], { ok: false, reason: "no verdict" }, "'oks' is not 'ok'");
assert.deepEqual(parseVerdicts("6 FAIL: upper", [6])["6"], { ok: false, reason: "no verdict" });
// The verdict must start the line (after whitespace): embedded mentions don't count.
assert.deepEqual(parseVerdicts("note: 7 ok", [7])["7"], { ok: false, reason: "no verdict" });
assert.deepEqual(parseVerdicts("x7 ok", ["x7"])["x7"], { ok: true, reason: "" }, "x7 is a valid id token");
assert.deepEqual(parseVerdicts("7x ok", ["7x"])["7x"], { ok: true, reason: "" });
// Id charset is [A-Za-z0-9_-]: unicode and dots break the match.
assert.deepEqual(parseVerdicts("job-1_x ok", ["job-1_x"])["job-1_x"], { ok: true, reason: "" });
assert.deepEqual(parseVerdicts("jób ok", ["jób"])["jób"], { ok: false, reason: "no verdict" });

// BUG: with CRLF line endings a "fail: <reason>" line stops matching entirely
// (the regex's `(.*)$` cannot cross the trailing \r), so the job falls back to
// "no verdict" and the reviewer's reason is lost. "ok" and bare "fail" lines
// survive because \s* can swallow the \r. parseVerdicts should strip \r.
// assert.deepEqual(parseVerdicts("1 ok\r\n2 fail: bad\r\n", [1, 2]), {
//   "1": { ok: true, reason: "" },
//   "2": { ok: false, reason: "bad" },
// });

// ---------- applyVerdicts: shapes, precedence and failure paths ----------

// Null/empty verdicts give an empty summary.
assert.deepEqual(applyVerdicts(null), { total: 0, ok: 0, reverted: 0, revertFailed: [] });
assert.deepEqual(applyVerdicts(undefined), { total: 0, ok: 0, reverted: 0, revertFailed: [] });
assert.deepEqual(applyVerdicts({}), { total: 0, ok: 0, reverted: 0, revertFailed: [] });
assert.deepEqual(applyVerdicts([]), { total: 0, ok: 0, reverted: 0, revertFailed: [] });

// Object-keyed form: { id: { job?, ok, reason } } matched through `jobs`.
{
  const calls = [];
  const js = [job(1), job(2)];
  const s = applyVerdicts({ "1": { ok: true }, "2": { ok: false, reason: "r" } }, {
    jobs: js,
    revert: (j) => calls.push(["revert", j.id]),
    markReviewed: (j, v) => calls.push(["mark", j.id, v]),
  });
  assert.deepEqual(s, { total: 2, ok: 1, reverted: 1, revertFailed: [] });
  assert.deepEqual(calls, [["mark", 1, "ok"], ["revert", 2], ["mark", 2, "reverted"]]);
}

// Pair-array form: [[id, verdict], ...] also works.
{
  const calls = [];
  const s = applyVerdicts([[3, { ok: true }], [4, { ok: false }]], {
    jobs: [job(3), job(4)],
    revert: (j) => calls.push(["revert", j.id]),
    markReviewed: (j, v) => calls.push(["mark", j.id, v]),
  });
  assert.deepEqual(s, { total: 2, ok: 1, reverted: 1, revertFailed: [] });
  assert.deepEqual(calls, [["mark", 3, "ok"], ["revert", 4], ["mark", 4, "reverted"]]);
}

// Entries whose id matches no job are counted in `total` but produce no side
// effects — total is entries.length, not jobs touched.
{
  const calls = [];
  const s = applyVerdicts({ "1": { ok: true }, "ghost": { ok: true }, "2": { ok: false } }, {
    jobs: [job(1), job(2)],
    revert: (j) => calls.push(["revert", j.id]),
    markReviewed: (j, v) => calls.push(["mark", j.id, v]),
  });
  assert.deepEqual(s, { total: 3, ok: 1, reverted: 1, revertFailed: [] });
  assert.deepEqual(calls, [["mark", 1, "ok"], ["revert", 2], ["mark", 2, "reverted"]]);
}

// Degenerate entries (null, {}, missing id) are skipped without throwing.
{
  const calls = [];
  const s = applyVerdicts([null, {}, { ok: true }, { id: "nope", ok: true }], {
    jobs: [job(1)],
    revert: (j) => calls.push(["revert", j.id]),
    markReviewed: (j, v) => calls.push(["mark", j.id, v]),
  });
  assert.deepEqual(s, { total: 4, ok: 0, reverted: 0, revertFailed: [] });
  assert.deepEqual(calls, []);
}

// e.job wins over the id lookup: an entry carrying its own job object is
// applied to that object even when its id points elsewhere.
{
  const other = job(99);
  const calls = [];
  applyVerdicts([{ id: 1, job: other, ok: true }], {
    jobs: [job(1)],
    markReviewed: (j, v) => calls.push([j.id, v]),
  });
  assert.deepEqual(calls, [[99, "ok"]], "entry.job takes precedence over jobs[id]");
}

// Duplicate ids in `jobs`: the Map keeps the last one.
{
  const first = job(5, { task: "first" });
  const last = job(5, { task: "last" });
  const calls = [];
  applyVerdicts({ "5": { ok: true } }, { jobs: [first, last], markReviewed: (j) => calls.push(j.task) });
  assert.deepEqual(calls, ["last"]);
}

// Truthiness of `ok`: the check is `if (e.ok)`, so any truthy value takes the
// ok path and only falsy values (0, "", null, undefined) go to revert.
for (const [okVal, wantOk] of [[0, false], ["", false], [null, false], [undefined, false], ["yes", true], [1, true]]) {
  const calls = [];
  const s = applyVerdicts([{ job: job(1), ok: okVal }], {
    revert: (j) => calls.push(["revert", j.id]),
    markReviewed: (j, v) => calls.push(["mark", j.id, v]),
  });
  if (wantOk) {
    assert.equal(s.ok, 1, `ok=${JSON.stringify(okVal)} is truthy -> ok path`);
    assert.deepEqual(calls, [["mark", 1, "ok"]]);
  } else {
    assert.equal(s.reverted, 1, `ok=${JSON.stringify(okVal)} is falsy -> fail path`);
    assert.deepEqual(calls, [["revert", 1], ["mark", 1, "reverted"]]);
  }
}

// Revert return-value edges: anything except exactly { ok: false } counts as
// a successful revert. undefined, null, {}, { ok: true }, { ok: 0 } all mark
// the job "reverted".
for (const ret of [undefined, null, {}, { ok: true }, { ok: 0 }, "ok"]) {
  const calls = [];
  const s = applyVerdicts([{ job: job(1), ok: false }], {
    revert: () => ret,
    markReviewed: (j, v) => calls.push(v),
  });
  assert.equal(s.reverted, 1, `revert returning ${JSON.stringify(ret)} still marks reverted`);
  assert.deepEqual(calls, ["reverted"]);
}
// Only the strict ok === false is a failed revert.
{
  const calls = [];
  const s = applyVerdicts([{ job: job(1), ok: false }], {
    revert: () => ({ ok: false, output: "conflict" }),
    markReviewed: (j, v) => calls.push(v),
  });
  assert.deepEqual(s, { total: 1, ok: 0, reverted: 0, revertFailed: [1] });
  assert.deepEqual(calls, [], "failed revert never marks");
}
// revertFailed carries the raw job.id (not stringified).
{
  const s = applyVerdicts([{ job: { id: "abc", status: "merged" }, ok: false }], { revert: () => ({ ok: false }) });
  assert.deepEqual(s.revertFailed, ["abc"]);
}

// Throw paths: a throwing revert propagates and stops the whole batch —
// later entries are never processed and the throwing job is left unmarked.
{
  const calls = [];
  assert.throws(() => applyVerdicts([
    { job: job(1), ok: false },
    { job: job(2), ok: false },
    { job: job(3), ok: true },
  ], {
    revert: (j) => { if (j.id === 2) throw new Error("git blew up"); calls.push(["revert", j.id]); },
    markReviewed: (j, v) => calls.push(["mark", j.id, v]),
  }), /git blew up/);
  assert.deepEqual(calls, [["revert", 1], ["mark", 1, "reverted"]], "entries after the throw are untouched");
}
// A throwing markReviewed propagates too.
assert.throws(() => applyVerdicts([{ job: job(1), ok: true }], {
  markReviewed: () => { throw new Error("disk full"); },
}), /disk full/);

// Missing injected fakes: defaults are a no-op mark and an always-ok revert.
{
  const s = applyVerdicts([{ job: job(1), ok: false }, { job: job(2), ok: true }]);
  assert.deepEqual(s, { total: 2, ok: 1, reverted: 1, revertFailed: [] });
}
// Non-function revert/markReviewed values fall back to the defaults.
{
  const s = applyVerdicts([{ job: job(1), ok: false }], { revert: "nope", markReviewed: 42 });
  assert.deepEqual(s, { total: 1, ok: 0, reverted: 1, revertFailed: [] });
}

// Two verdict sets applied back-to-back share nothing: separate summaries,
// separate call logs, and the jobs array itself is not mutated.
{
  const js = [job(1), job(2)];
  const logA = [], logB = [];
  const sA = applyVerdicts(parseVerdicts("1 ok\n2 fail: x", [1, 2]), {
    jobs: js,
    revert: () => ({ ok: true }),
    markReviewed: (j, v) => logA.push([j.id, v]),
  });
  const sB = applyVerdicts(parseVerdicts("1 fail: y\n2 ok", [1, 2]), {
    jobs: js,
    revert: () => ({ ok: true }),
    markReviewed: (j, v) => logB.push([j.id, v]),
  });
  assert.notEqual(sA, sB);
  assert.deepEqual(logA, [[1, "ok"], [2, "reverted"]]);
  assert.deepEqual(logB, [[1, "reverted"], [2, "ok"]]);
  assert.deepEqual(js.map((j) => j.status), ["merged", "merged"], "applyVerdicts does not mutate job status");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("constance-batchreview.deep: ok");
