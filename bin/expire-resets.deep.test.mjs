import assert from "node:assert/strict";
import { expireResets, anyPassed, RESET_NOTE } from "./expire-resets.mjs";

// expire-resets.mjs is a pure function: it reads no files and no env, so there is
// nothing to isolate in a temp dir. These tests cover what expire-resets.test.mjs
// does not: nullish/empty/wrong-type inputs, non-object entries, percent and
// resetsAt type coercion, clock boundaries, immutability, and the NaN nowMs edge.

const now = Date.parse("2026-11-22T12:00:00Z");
const past = "2026-11-22T11:00:00Z";
const future = "2026-11-23T00:00:00Z";

// ---- nullish / empty / wrong-type container input ----
assert.deepEqual(expireResets(null, now), []);
assert.deepEqual(expireResets(undefined, now), []);
assert.deepEqual(expireResets(), []);
const empty = [];
assert.notEqual(expireResets(empty, now), empty, "always returns a fresh array");
assert.deepEqual(expireResets(empty, now), []);
// Truthy non-arrays have no .map: current contract is a TypeError.
for (const bad of ["x", {}, 5, true]) {
  assert.throws(() => expireResets(bad, now), TypeError, `expireResets(${JSON.stringify(bad)})`);
  assert.throws(() => anyPassed(bad, now), TypeError, `anyPassed(${JSON.stringify(bad)})`);
}
assert.equal(anyPassed(null, now), false);
assert.equal(anyPassed(undefined, now), false);
assert.equal(anyPassed([], now), false);

// ---- non-object / primitive entries pass through untouched ----
const weird = [null, undefined, 5, "x", true];
const weirdOut = expireResets(weird, now);
assert.equal(weirdOut.length, weird.length);
weird.forEach((w, i) => assert.equal(weirdOut[i], w, `entry ${i} returned by reference`));
assert.equal(anyPassed(weird, now), false);
// An object entry with no usable resetsAt is returned by reference, not copied.
const noReset = { title: "Mystery", percent: 90 };
assert.equal(expireResets([noReset], now)[0], noReset);

// ---- clock boundary: inclusive at exactly nowMs ----
const exact = { title: "Edge", percent: 1, resetsAt: new Date(now).toISOString() };
assert.equal(expireResets([exact], now)[0].percent, 0, "resetsAt == nowMs counts as passed");
assert.equal(anyPassed([exact], now), true);
const plus1 = { title: "Edge+", percent: 1, resetsAt: new Date(now + 1).toISOString() };
assert.equal(expireResets([plus1], now)[0], plus1, "1 ms in the future is not expired");
assert.equal(anyPassed([plus1], now), false);
const minus1 = { title: "Edge-", percent: 1, resetsAt: new Date(now - 1).toISOString() };
assert.equal(expireResets([minus1], now)[0].percent, 0);
// Default nowMs = Date.now(): a 1970 reset is long past, a far-future one is not.
assert.equal(expireResets([{ percent: 1, resetsAt: "1970-01-01T00:00:01Z" }])[0].percent, 0);
assert.equal(expireResets([{ percent: 1, resetsAt: "2999-01-01T00:00:00Z" }])[0].percent, 1);

// ---- percent gate: only Number(percent) > 0 expires ----
for (const p of [0, -1, NaN, "abc", "", null, undefined]) {
  const l = { title: "Low", percent: p, resetsAt: past };
  assert.equal(expireResets([l], now)[0], l, `percent ${JSON.stringify(p)} stays untouched`);
}
for (const p of [0.0001, "0.5", true, Infinity, 150]) {
  const out = expireResets([{ title: "Hi", percent: p, resetsAt: past }], now)[0];
  assert.equal(out.percent, 0, `percent ${JSON.stringify(p)} expires to 0`);
  assert.equal(out.note, RESET_NOTE);
}
// Missing percent means Number(undefined) = NaN: stale resetsAt is kept forever.
const noPct = { title: "NoPct", resetsAt: past };
assert.equal(expireResets([noPct], now)[0], noPct);
assert.equal(anyPassed([noPct], now), true, "anyPassed ignores percent entirely");

// ---- resetsAt coercion ----
// QUIRK (already noted in devin-deep.test.mjs): a numeric resetsAt is stringified
// and Date.parse("123") reads it as year 123, so it is always "passed".
assert.equal(expireResets([{ percent: 1, resetsAt: 123 }], now)[0].percent, 0);
assert.equal(anyPassed([{ resetsAt: 123 }], now), true);
// A real Date object stringifies to a parseable date and works.
assert.equal(expireResets([{ percent: 1, resetsAt: new Date(past) }], now)[0].percent, 0);
// Non-parseable resetsAt values leave the entry alone.
for (const r of ["garbage", "2026-13-45", "", true, {}, [], null, undefined]) {
  const l = { title: "Bad", percent: 1, resetsAt: r };
  assert.equal(expireResets([l], now)[0], l, `resetsAt ${JSON.stringify(r)} unchanged`);
  assert.equal(anyPassed([l], now), false);
}
// anyPassed does not care about percent: a 0% meter with a stale resetsAt still counts.
assert.equal(anyPassed([{ percent: 0, resetsAt: past }], now), true);
// anyPassed short-circuits on the first passed window.
assert.equal(anyPassed([{ resetsAt: future }, { resetsAt: past }], now), true);
assert.equal(anyPassed([{ resetsAt: future }, { resetsAt: "junk" }], now), false);

// ---- expired result shape: hitAt removed, everything else kept ----
const rich = { title: "Weekly", percent: 1, resetsAt: past, hitAt: "2026-11-22T10:00:00Z", cap: true, account: "main", extra: { a: 1 } };
const richOut = expireResets([rich], now)[0];
assert.deepEqual(richOut, { title: "Weekly", percent: 0, resetsAt: "", note: RESET_NOTE, cap: true, account: "main", extra: { a: 1 } });
assert.equal("hitAt" in richOut, false);
// A pre-existing note is overwritten by RESET_NOTE.
assert.equal(expireResets([{ percent: 1, resetsAt: past, note: "old" }], now)[0].note, RESET_NOTE);
// hitAt is stripped even when already undefined; the key is simply absent.
assert.equal("hitAt" in expireResets([{ percent: 1, resetsAt: past, hitAt: undefined }], now)[0], false);

// ---- immutability ----
const src = { title: "S", percent: 42, resetsAt: past, hitAt: "h" };
const frozenSrc = Object.freeze(src);
const out = expireResets([frozenSrc], now);
assert.equal(out[0].percent, 0);
assert.equal(src.percent, 42, "input object not mutated");
assert.equal(src.hitAt, "h");
assert.equal(src.resetsAt, past);
// The unchanged entries are the same references; the changed one is a new object.
assert.notEqual(out[0], src);
const mixed = [{ percent: 1, resetsAt: past }, { percent: 1, resetsAt: future }];
const mixedOut = expireResets(mixed, now);
assert.notEqual(mixedOut[0], mixed[0]);
assert.equal(mixedOut[1], mixed[1]);
assert.equal(mixed[0].percent, 1, "original array entries untouched");
// Frozen input array works too.
assert.equal(expireResets(Object.freeze([{ percent: 1, resetsAt: past }]), now)[0].percent, 0);

// ---- BUG: NaN nowMs makes the two helpers disagree ----
// expireResets treats `t > NaN` as false, so EVERY entry with a finite resetsAt and
// percent > 0 is expired; anyPassed treats `t <= NaN` as false and reports nothing
// passed. collect.mjs calls both (anyPassed to skip a refetch, expireResets to
// render), so a bad clock value would zero every meter while claiming nothing reset.
// Date.now() cannot be NaN in practice, but a caller passing a parsed/derived time
// can hit it. Not fixed here (module is out of scope for this job).
//
// assert.deepEqual(expireResets([{ percent: 1, resetsAt: past }], NaN),
//   [{ percent: 0, resetsAt: "", note: RESET_NOTE }]);
// assert.equal(anyPassed([{ percent: 1, resetsAt: past }], NaN), false);
// assert.equal(expireResets([{ percent: 1, resetsAt: past }], NaN).length,
//   anyPassed([{ percent: 1, resetsAt: past }], NaN) ? 0 : 1,
//   "the helpers should agree about whether anything expired");

console.log("expire-resets deep ok");
