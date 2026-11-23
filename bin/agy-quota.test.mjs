import assert from "node:assert/strict";
import { parseQuota, poolLabel } from "./agy-quota.mjs";
const R = "2026-11-26T11:27:25Z";
// What Google returned for this Free account: one pool, one weekly bucket -> exactly one bar (nothing combined, nothing invented)
assert.deepEqual(parseQuota({ groups: [{ displayName: "Claude and GPT models", buckets: [{ bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.00623, resetTime: R }] }] }),
  [{ title: "Claude/GPT Weekly", percent: 0.99377, resetsAt: "2026-11-26T11:27:25.000Z" }]);
// A paid plan with both pools and both windows -> four separate bars, each with its own percent and reset time
const paid = { groups: [
  { displayName: "Gemini models", buckets: [{ bucketId: "gemini-session", window: "5-hour", remainingFraction: 0.40, resetTime: "2026-11-22T15:00:00Z" }, { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.70, resetTime: R }] },
  { displayName: "Claude and GPT models", buckets: [{ bucketId: "3p-session", window: "5-hour", remainingFraction: 0.10, resetTime: "2026-11-22T14:00:00Z" }, { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.55, resetTime: R }] },
] };
const four = parseQuota(paid);
assert.deepEqual(four.map((l) => [l.title, Math.round(l.percent * 100)]), [["Gemini Session", 60], ["Gemini Weekly", 30], ["Claude/GPT Session", 90], ["Claude/GPT Weekly", 45]]);
assert.equal(new Set(four.map((l) => l.resetsAt)).size, 3, "each bar keeps its own reset time");
// An untouched Claude/GPT pool is not shown (a scoped allowance, shown once used); an untouched Gemini pool is
assert.deepEqual(parseQuota({ groups: [{ displayName: "Gemini models", buckets: [{ window: "5-hour", remainingFraction: 1, resetTime: R }] }, { displayName: "Claude and GPT models", buckets: [{ window: "5-hour", remainingFraction: 1, resetTime: R }] }] }).map((l) => l.title), ["Gemini Session"]);
// A disabled bucket, a bucket with no figure, and the older flat `buckets` shape
assert.deepEqual(parseQuota({ groups: [{ displayName: "Gemini models", buckets: [{ disabled: true, remainingFraction: 0.5 }, { window: "weekly" }] }] }), []);
assert.deepEqual(parseQuota({ buckets: [{ window: "weekly", remainingFraction: 0.25, resetTime: R }] }).map((l) => l.title), ["Gemini Weekly"]);
assert.deepEqual(parseQuota(null), []); assert.deepEqual(parseQuota({}), []);
assert.equal(poolLabel("Gemini 4 models"), "Gemini"); assert.equal(poolLabel("Claude and GPT models"), "Claude/GPT"); assert.equal(poolLabel(""), "Other");
console.log("agy-quota: all tests passed");
// A Pro/Ultra-style pool with an untouched 5-hour window beside a used weekly one: both show, Session first.
assert.deepEqual(parseQuota({ groups: [{ displayName: "Claude and GPT models", buckets: [
  { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.6, resetTime: R },
  { bucketId: "3p-session", window: "5-hour", remainingFraction: 1, resetTime: R }] }] }).map((l) => [l.title, l.percent]),
  [["Claude/GPT Session", 0], ["Claude/GPT Weekly", 0.4]]);
// Ultra as reported by a real account: the Claude/GPT weekly pool only, no Gemini bucket.
assert.deepEqual(parseQuota({ groups: [{ displayName: "Claude and GPT models", buckets: [{ bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.25, resetTime: R }] }] })
  .map((l) => l.title), ["Claude/GPT Weekly"]);
