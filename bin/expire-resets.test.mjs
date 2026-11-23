import assert from "node:assert/strict";
import { expireResets, anyPassed, RESET_NOTE } from "./expire-resets.mjs";
const now = Date.parse("2026-11-22T12:00:00Z");
const ls = [
  { title: "Session", percent: 1, resetsAt: "2026-11-22T11:59:00Z" },                                   // passed -> 0
  { title: "Free grok-4.7 (24 h)", percent: 1, resetsAt: "2026-11-22T11:00:00Z", hitAt: "x", cap: true }, // passed -> 0, hit cleared
  { title: "Weekly", percent: 0.5, resetsAt: "2026-11-25T00:00:00Z" },                                  // future: unchanged
  { title: "Monthly", percent: 0.3, resetsAt: "" },                                                     // no time: unchanged
];
const out = expireResets(ls, now);
assert.deepEqual(out[0], { title: "Session", percent: 0, resetsAt: "", note: RESET_NOTE });
assert.equal(out[1].hitAt, undefined); assert.equal(out[1].percent, 0); assert.equal(out[1].cap, true);
assert.equal(out[2], ls[2]); assert.equal(out[3], ls[3]);
assert.equal(anyPassed(ls, now), true); assert.equal(anyPassed([ls[2]], now), false);
console.log("expire-resets ok");
