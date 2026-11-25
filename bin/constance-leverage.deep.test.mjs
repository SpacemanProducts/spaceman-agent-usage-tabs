// Deeper edge-case tests for constance-leverage.mjs: the MIN_SPENT_PCT
// boundary, float dust, non-finite inputs, malformed sample lines, the exact
// MAX_LINES cap, bucket/verdict/token edges in handoffReturns, and the
// bestReturnLesson minimums. Anything found that looks like a real bug is a
// commented-out test with a note — the module itself is not changed here.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "constance-leverage-deep-home-"));
process.env.HOME = home;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-leverage-deep-"));

const { sessionSpent, leverage, addSample, readSamples, handoffReturns, bestReturnLesson } =
  await import("./constance-leverage.mjs");

// ---------------------------------------------------------------- sessionSpent

// The first reading only sets the baseline; equal readings spend nothing.
assert.equal(sessionSpent([{ used: 0.9 }, { used: 0.9 }]), 0);
assert.equal(sessionSpent([{ used: 0.9 }, { used: 0.95 }]), 5);

// Float dust is rounded away: 0.13 - 0.07 is 0.06000...004 in binary.
assert.equal(sessionSpent([{ used: 0.07 }, { used: 0.13 }]), 6);

// `at` plays no role — only `used` and its order matter.
assert.equal(sessionSpent([{ at: 1, used: 0.1 }, { at: 0, used: 0.5 }]), 40);

// Several resets in a row each count the new reading from 0.
assert.equal(
  sessionSpent([{ used: 0.5 }, { used: 0.1 }, { used: 0.4 }, { used: 0.05 }, { used: 0.15 }]),
  55, // +10 (reset to 0.1) +30 (rise) +5 (reset to 0.05) +10 (rise)
);

// used is not clamped to 0..1: out-of-range readings are taken at face value.
assert.equal(sessionSpent([{ used: 0 }, { used: 1.5 }]), 150);
assert.equal(sessionSpent([{ used: -0.5 }, { used: 0.5 }]), 100);

// null/undefined spend nothing; a string iterates its chars, all junk -> 0.
assert.equal(sessionSpent(undefined), 0);
assert.equal(sessionSpent("junk"), 0);

// Infinity readings are non-finite and ignored without moving the baseline.
assert.equal(sessionSpent([{ used: 0.1 }, { used: Infinity }, { used: -Infinity }, { used: 0.4 }]), 30);

// Non-number `used` types (bigint, Number object, boolean) are all ignored.
assert.equal(sessionSpent([{ used: 0.1 }, { used: 5n }, { used: new Number(0.9) }, { used: true }, { used: 0.3 }]), 20);

// More float dust: 0.58 - 0.29 is 0.28999...996 in binary, rounded to 29.
assert.equal(sessionSpent([{ used: 0.29 }, { used: 0.58 }]), 29);
// Repeating-decimal inputs round at 1e9, not to a friendly number.
assert.equal(sessionSpent([{ used: 1 / 3 }, { used: 2 / 3 }]), 33.333333333);

// A tiny downward drift still counts as a reset: any u < prev resets, and the
// ~50-point result rounds back to exactly 50 at 1e9 precision.
assert.equal(sessionSpent([{ used: 0.5 }, { used: 0.5 - Number.EPSILON }]), 50);

// Non-iterable `samples` throws; an iterable non-array (string) is walked.
assert.throws(() => sessionSpent(5), TypeError);
assert.throws(() => sessionSpent({}), TypeError);
assert.equal(sessionSpent("ab"), 0);

// ---------------------------------------------------------------- leverage

// Boundary: exactly MIN_SPENT_PCT (0.5) measures; a hair under does not.
const edge = leverage({ tokens: 10e6, spentPct: 0.5 });
assert.equal(edge.perPct, 20e6);
assert.equal(edge.label, "20M per 1% (target 5M)");
assert.equal(leverage({ tokens: 10e6, spentPct: 0.499999 }).perPct, null);

// spentPct must be a finite number; strings, NaN, infinities and negatives
// all collapse to "not enough spent" (negatives included).
for (const spentPct of ["12", NaN, Infinity, -Infinity, null, undefined, -5]) {
  const l = leverage({ tokens: 10e6, spentPct });
  assert.equal(l.perPct, null, `spentPct=${spentPct}`);
  assert.equal(l.label, "not enough Opus spent to measure yet", `spentPct=${spentPct}`);
}

// tokens must be finite too; 0 is a real measurement, not "unknown".
const zero = leverage({ tokens: 0, spentPct: 10 });
assert.equal(zero.perPct, 0);
assert.equal(zero.perSession, 0);
assert.equal(zero.vsTarget, 0);
assert.equal(zero.label, "0 per 1% (target 5M)");
for (const tokens of [NaN, Infinity, -Infinity, "5", null, true]) {
  assert.equal(leverage({ tokens, spentPct: 10 }).label, "no worker tokens to measure yet", `tokens=${tokens}`);
}
// Negative tokens are finite, so they produce a negative perPct and sort as
// the "cheapest" possible handoff — see the suspected-bugs note below.
assert.equal(leverage({ tokens: -5, spentPct: 10 }).perPct, -0.5);

// The returned spentPct is the normalized 0, not the junk input.
assert.equal(leverage({ tokens: 1, spentPct: "12" }).spentPct, 0);
assert.equal(leverage({ tokens: 1, spentPct: 12.5 }).spentPct, 12.5);

// `name` only appears in the not-enough label, never in the no-tokens one.
assert.equal(leverage({ tokens: "x", spentPct: 0.1, name: "Sonnet" }).label, "not enough Sonnet spent to measure yet");
assert.equal(leverage({ tokens: "x", spentPct: 12, name: "Sonnet" }).label, "no worker tokens to measure yet");

// perSession extrapolates perPct across a whole 100% window.
const big = leverage({ tokens: 2e9, spentPct: 50 });
assert.equal(big.perPct, 40e6);
assert.equal(big.perSession, 4e9);
assert.equal(big.vsTarget, 8);
assert.equal(big.label, "40M per 1% (target 5M)");
const frac = leverage({ tokens: 1, spentPct: 3 });
assert.ok(Math.abs(frac.perPct - 1 / 3) < 1e-12);
assert.ok(Math.abs(frac.perSession - 100 / 3) < 1e-9);

// ---------------------------------------------------------------- samples file

// addSample creates missing parent directories.
const nested = path.join(dir, "a", "b", "samples.jsonl");
addSample(nested, { at: 1, used: 0.2 });
assert.equal(readSamples(nested).length, 1);

// Without sinceAt every parseable object comes back, even with no usable `at`.
const sf = path.join(dir, "since.jsonl");
addSample(sf, { at: 100, used: 0.1 });
addSample(sf, { at: 200, used: 0.2 });
addSample(sf, { used: 0.3 });                                  // no `at` at all
fs.appendFileSync(sf, "{\"at\":\"x\",\"used\":0.4}\n");          // non-numeric `at`
assert.equal(readSamples(sf).length, 4);
// With sinceAt only finite `at >= sinceAt` survive; missing/NaN `at` drops out.
assert.deepEqual(readSamples(sf, 0).map((s) => s.at), [100, 200]);
assert.deepEqual(readSamples(sf, 150).map((s) => s.at), [200]);
assert.deepEqual(readSamples(sf, 200).map((s) => s.at), [200], "sinceAt boundary is inclusive");

// sinceAt must be a finite number; anything else silently disables the filter.
for (const sinceAt of [NaN, Infinity, -Infinity, "200", null, undefined]) {
  assert.equal(readSamples(sf, sinceAt).length, 4, `sinceAt=${sinceAt}`);
}

// A missing file, an empty file, whitespace-only lines and a directory all
// read as no samples.
assert.deepEqual(readSamples(path.join(dir, "nope.jsonl")), []);
const empty = path.join(dir, "empty.jsonl");
fs.writeFileSync(empty, "\n  \n\t\n");
assert.deepEqual(readSamples(empty), []);
assert.deepEqual(readSamples(dir), [], "a directory reads as []");

// Non-object JSON lines are skipped; objects without `used` still parse back.
const types = path.join(dir, "types.jsonl");
fs.writeFileSync(types, "123\n\"str\"\ntrue\nnull\n[1,2]\n{}\n{\"used\":0.5}\n");
const got = readSamples(types);
assert.equal(got.length, 3);
assert.deepEqual(got[2], { used: 0.5 });
// SUSPECTED BUG (commented out, not fixed): JSON arrays and empty objects pass
// the `typeof s === "object"` check and are returned as "samples". Harmless
// today because sessionSpent ignores entries with no numeric `used`, but the
// filter probably meant to reject them.
// assert.deepEqual(got.filter((s) => Array.isArray(s) || Object.keys(s).length === 0), []);

// CRLF line endings still parse (JSON.parse tolerates the trailing \r).
const crlf = path.join(dir, "crlf.jsonl");
fs.writeFileSync(crlf, "{\"at\":1,\"used\":0.1}\r\n{\"at\":2,\"used\":0.2}\r\n");
assert.deepEqual(readSamples(crlf).map((s) => s.at), [1, 2]);

// Exactly at the cap nothing is trimmed; one line over trims to the newest.
const cap = path.join(dir, "cap.jsonl");
for (let i = 0; i < 2000; i++) addSample(cap, { at: i, used: 0 });
assert.equal(readSamples(cap).length, 2000);
assert.equal(readSamples(cap)[0].at, 0, "exactly MAX_LINES: nothing evicted");
addSample(cap, { at: 2000, used: 0 });
const capped = readSamples(cap);
assert.equal(capped.length, 2000);
assert.equal(capped[0].at, 1, "line 2001 evicts only the oldest");
assert.equal(capped[1999].at, 2000);

// NOTE: if the file's last line lacks a trailing newline, the next addSample
// merges into it and that sample is lost to the broken-line skip. Only
// reachable if something outside addSample wrote the file, so left as a note:
// const nonl = path.join(dir, "nonl.jsonl");
// fs.writeFileSync(nonl, "x");
// addSample(nonl, { at: 1, used: 0.5 });
// assert.equal(readSamples(nonl).length, 1); // currently 0 — merged into "x{...}"

// addSample with no fields writes a bare "{}" line, which readSamples keeps
// (an object with no usable fields — see suspected bug 3 above).
const noargs = path.join(dir, "noargs.jsonl");
addSample(noargs);
assert.equal(fs.readFileSync(noargs, "utf8"), "{}\n");
assert.deepEqual(readSamples(noargs), [{}]);

// readSamples preserves file order; it never sorts by `at`.
const unsorted = path.join(dir, "unsorted.jsonl");
addSample(unsorted, { at: 300, used: 0.3 });
addSample(unsorted, { at: 100, used: 0.1 });
assert.deepEqual(readSamples(unsorted).map((s) => s.at), [300, 100]);

// sinceAt coerces `at` with Number(): null -> 0, true -> 1, "250" -> 250.
// A null `at` survives sinceAt=0 but not sinceAt=1.
const coerce = path.join(dir, "coerce.jsonl");
fs.writeFileSync(coerce, "{\"at\":null,\"used\":0}\n{\"at\":true,\"used\":0}\n{\"at\":\"250\",\"used\":0}\n");
assert.deepEqual(readSamples(coerce, 0).map((s) => s.at), [null, true, "250"]);
assert.deepEqual(readSamples(coerce, 1).map((s) => s.at), [true, "250"]);
assert.deepEqual(readSamples(coerce, 251).map((s) => s.at), []);

// A file of pure binary garbage reads as [] without throwing; a valid line
// after the garbage still parses.
const bin = path.join(dir, "bin.jsonl");
fs.writeFileSync(bin, Buffer.from([0xff, 0xfe, 0x00, 0x0a, 0x7b, 0x7d, 0x0a]));
assert.deepEqual(readSamples(bin), [{}]);

// An unreadable file (mode 000) reads as [] — the read error is swallowed
// like a missing file. Skipped when running as root, which can read anyway.
const locked = path.join(dir, "locked.jsonl");
fs.writeFileSync(locked, "{\"at\":1,\"used\":0.5}\n");
fs.chmodSync(locked, 0);
if (process.getuid && process.getuid() !== 0) {
  assert.deepEqual(readSamples(locked), []);
}
fs.chmodSync(locked, 0o600);

// The MAX_LINES trim counts lines it didn't write: foreign lines appended
// by another process between addSample calls are kept and the oldest evicted.
// (Deterministic stand-in for two writers racing on the same file — the
// read-modify-write trim is not atomic across processes.)
const foreign = path.join(dir, "foreign.jsonl");
for (let i = 0; i < 1999; i++) addSample(foreign, { at: i, used: 0 });
for (let i = 0; i < 5; i++) fs.appendFileSync(foreign, JSON.stringify({ at: 9000 + i, used: 0 }) + "\n");
addSample(foreign, { at: 9999, used: 0 });
const fkept = readSamples(foreign);
assert.equal(fkept.length, 2000);
assert.equal(fkept[0].at, 5, "1999 own + 5 foreign + 1 new = 2005, oldest 5 evicted");
assert.equal(fkept[1999].at, 9999);

// addSample error paths: a file in the way of the parent dir, or the target
// itself being a directory, throws instead of writing anything.
const blocker = path.join(dir, "blocker");
fs.writeFileSync(blocker, "x");
assert.throws(() => addSample(path.join(blocker, "s.jsonl"), { at: 1, used: 0.1 }));
assert.throws(() => addSample(dir, { at: 1, used: 0.1 }));

// ---------------------------------------------------------------- handoffReturns

// Missing list and null entries are skipped.
assert.deepEqual(handoffReturns(), []);
assert.deepEqual(handoffReturns(null), []);
assert.deepEqual(handoffReturns([null, undefined, false]), []);

// Missing/odd agent and files fields bucket predictably: agent "" and 0 both
// become "?", and a non-array `files` counts as read-only.
const odd = handoffReturns([
  { verdict: "accept", tokens: 10 },
  { agent: "", files: "not-an-array", verdict: "accept", tokens: 20 },
  { agent: 0, files: ["x"], verdict: "accept", tokens: 30 },
]);
assert.deepEqual(odd.map((g) => g.key), ["?, read-only", "?, 1 file"]);
const ro = odd[0];
assert.deepEqual({ jobs: ro.jobs, tokens: ro.tokens, accepted: ro.accepted, perJob: ro.perJob },
  { jobs: 2, tokens: 30, accepted: 2, perJob: 15 });

// Only the exact string "accept" counts; casing, near-misses and a missing
// verdict never do.
const verdicts = handoffReturns([
  { agent: "a", files: [], tokens: 100, verdict: "Accept" },
  { agent: "a", files: [], tokens: 100, verdict: "accepted" },
  { agent: "a", files: [], tokens: 100, verdict: "ACCEPT" },
  { agent: "a", files: [], tokens: 100, verdict: true },
  { agent: "a", files: [], tokens: 100 },
]);
assert.equal(verdicts.length, 1);
assert.equal(verdicts[0].jobs, 5);
assert.equal(verdicts[0].accepted, 0);
assert.equal(verdicts[0].perJob, null);

// Bucket boundaries: 0 -> read-only, 1 -> "1 file", 2-3 -> "2-3 files",
// 4+ -> "4+ files".
for (const [n, bucket] of [[0, "read-only"], [1, "1 file"], [2, "2-3 files"], [3, "2-3 files"], [4, "4+ files"]]) {
  const [g] = handoffReturns([{ agent: "a", files: Array(n).fill("x"), verdict: "accept", tokens: 1 }]);
  assert.equal(g.key, `a, ${bucket}`, `files.length=${n}`);
}

// tokens: 0 counts as a real report; { n: "x" } reports nothing; a negative
// count is accepted and sorts as the cheapest handoff (see note below).
const tk = handoffReturns([
  { agent: "a", files: [], tokens: 0, verdict: "accept" },
  { agent: "b", files: [], tokens: -50, verdict: "accept" },
  { agent: "c", files: [], tokens: { n: "x" }, verdict: "accept" },
  { agent: "d", files: [], tokens: { n: 0 }, verdict: "accept" },
]);
assert.deepEqual(tk.map((g) => g.key), ["b, read-only", "a, read-only", "d, read-only", "c, read-only"]);
assert.equal(tk[0].perJob, -50);
assert.equal(tk[1].perJob, 0, "tokens: 0 is a reported zero, not unknown");
assert.equal(tk[3].perJob, null, "{ n: \"x\" } reports nothing");

// Tied perJob sorts by key so output order is deterministic.
const tie = handoffReturns([
  { agent: "zeta", files: [], tokens: 100, verdict: "accept" },
  { agent: "alpha", files: [], tokens: 100, verdict: "accept" },
]);
assert.deepEqual(tie.map((g) => g.key), ["alpha, read-only", "zeta, read-only"]);

// Truthy non-object entries are not skipped: numbers, strings and booleans
// all count as jobs in the "?, read-only" bucket (only falsy entries are
// dropped). See suspected bug 4 below.
const nonobj = handoffReturns([5, "x", true]);
assert.equal(nonobj.length, 1);
assert.equal(nonobj[0].key, "?, read-only");
assert.equal(nonobj[0].jobs, 3);
assert.equal(nonobj[0].accepted, 0);
assert.equal(nonobj[0].perJob, null);

// A string `jobs` is iterable, so it is walked char by char — same bogus
// group. Non-iterable input (number, plain object) throws TypeError.
assert.equal(handoffReturns("ab")[0].jobs, 2);
assert.throws(() => handoffReturns(5), TypeError);
assert.throws(() => handoffReturns({}), TypeError);

// tokensOf shapes not covered above: { n: NaN/Infinity/"50" }, a numeric
// string, a boolean and { n: -5 } (negative counts, see bug 2).
const tk2 = handoffReturns([
  { agent: "a", files: [], tokens: { n: NaN }, verdict: "accept" },
  { agent: "b", files: [], tokens: { n: Infinity }, verdict: "accept" },
  { agent: "c", files: [], tokens: { n: "50" }, verdict: "accept" },
  { agent: "d", files: [], tokens: "100", verdict: "accept" },
  { agent: "e", files: [], tokens: true, verdict: "accept" },
  { agent: "f", files: [], tokens: { n: -5 }, verdict: "accept" },
]);
assert.deepEqual(tk2.map((g) => g.key), ["f, read-only", "a, read-only", "b, read-only", "c, read-only", "d, read-only", "e, read-only"]);
assert.equal(tk2[0].perJob, -5);
for (const g of tk2.slice(1)) assert.equal(g.perJob, null, g.key);

// SUSPECTED BUGS found while writing these tests (not fixed, per job rules):
//
// 1. perJob divides summed tokens by ALL accepted jobs, not by the accepted
//    jobs that actually reported tokens. A group with one accepted job at
//    100 tokens and one accepted job with no token report gets perJob 50 —
//    the unknown job is treated as 0 tokens, which contradicts the comment
//    "unknown is never 'free'" (it makes the handoff look cheaper):
//      handoffReturns([
//        { agent: "a", files: ["x"], tokens: 100, verdict: "accept" },
//        { agent: "a", files: ["x"], verdict: "accept" },
//      ])[0].perJob === 50   // arguably should be 100 (per reported job)
//
// 2. Negative token counts pass tokensOf's finite check and sort first as the
//    "cheapest" handoff (group "b" above, perJob -50); bestReturnLesson could
//    crown nonsense data as the best return. tokensOf probably should reject
//    t < 0:
//      handoffReturns([{ agent: "a", files: [], tokens: -5, verdict: "accept" }])[0].perJob === -5
//
// 3. readSamples accepts JSON arrays and empty objects as samples
//    (typeof [] === "object") — see the commented assert above.
//
// 4. handoffReturns counts truthy non-object entries (5, "x", true) as jobs
//    in the "?, read-only" bucket — the `if (!j) continue` guard only drops
//    falsy entries, so a malformed jobs list inflates `jobs`. Pinned by the
//    asserts above; probably should require a plain object.
//      handoffReturns([5, "x", true])[0].jobs === 3   // arguably should be 0/throw
//
// 5. addSample's MAX_LINES trim is a read-modify-write across two syscalls;
//    two processes appending concurrently can both pass the length check and
//    leave the file over the cap or drop a just-written line. Not testable
//    deterministically in-process; the foreign-lines test above shows the
//    trim does at least count lines it didn't write.

// ---------------------------------------------------------------- bestReturnLesson

// Exactly 3 accepted jobs is enough; the cheapest group's key and tokens show.
const three = [
  { agent: "a", files: [], tokens: 30000, verdict: "accept" },
  { agent: "b", files: ["x"], tokens: 20000, verdict: "accept" },
  { agent: "c", files: ["x", "y"], tokens: 10000, verdict: "accept" },
];
const l3 = bestReturnLesson(three);
assert.equal(l3, "Best handoff return: c, 2-3 files averages 10K tokens per accepted job.");

// 3+ accepted but no token reports anywhere -> no lesson (unknown isn't free).
const noTok = [
  { agent: "a", verdict: "accept" },
  { agent: "b", verdict: "accept" },
  { agent: "c", verdict: "accept" },
];
assert.equal(bestReturnLesson(noTok), "");

// Non-accepted jobs don't count toward the 3-job minimum.
const twoAcc = [
  { agent: "a", verdict: "accept" },
  { agent: "b", verdict: "accept" },
  { agent: "c", verdict: "send-back" },
  { agent: "d", verdict: "review" },
];
assert.equal(bestReturnLesson(twoAcc), "");

// Junk input and accepted-but-tokenless mixes stay quiet.
assert.equal(bestReturnLesson(null), "");
assert.equal(bestReturnLesson([null, { verdict: "accept" }]), "");

// Sub-1K perJob formats without a suffix; the lesson is an exact sentence.
assert.equal(bestReturnLesson([
  { agent: "a", files: [], tokens: 500, verdict: "accept" },
  { agent: "a", files: [], tokens: 500, verdict: "accept" },
  { agent: "a", files: [], tokens: 500, verdict: "accept" },
]), "Best handoff return: a, read-only averages 500 tokens per accepted job.");

// A perJob tie between groups resolves by key (localeCompare), same as
// handoffReturns' sort — the lesson names the alphabetically first key.
assert.equal(bestReturnLesson([
  { agent: "z", files: [], tokens: 100, verdict: "accept" },
  { agent: "a", files: [], tokens: 100, verdict: "accept" },
  { agent: "z", files: ["x"], tokens: 100, verdict: "accept" },
]), "Best handoff return: a, read-only averages 100 tokens per accepted job.");

// Extra accepted jobs beyond the minimum don't change the winner, and
// non-"accept" verdicts never do either.
assert.equal(bestReturnLesson([
  ...three,
  { agent: "a", files: [], tokens: 1, verdict: "send-back" },
  { agent: "a", files: [], tokens: 1 },
]), l3);

// Non-array input throws: a number has no .filter, a string has no .filter
// either (only null/undefined fall back to []).
assert.throws(() => bestReturnLesson(5), TypeError);
assert.throws(() => bestReturnLesson("ab"), TypeError);
assert.throws(() => bestReturnLesson({}), TypeError);

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
console.log("constance-leverage.deep: tests passed");
