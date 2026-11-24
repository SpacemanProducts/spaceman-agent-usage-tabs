import assert from "node:assert/strict";
import { pace, windowPace, STOP_AT } from "./constance-pace.mjs";
const now = Date.UTC(2026, 10, 23, 12);
const H = 3600e3, D = 24 * H;
const claude = (s, sLeft, w, wLeft) => ({ limits: [
  { title: "Session", percent: s, resetsAt: new Date(now + sLeft).toISOString() },
  { title: "Weekly", percent: w, resetsAt: new Date(now + wLeft).toISOString() }] });

assert.equal(pace(claude(0.2, 2.5 * H, 0.3, 4 * D), now).mode, "normal", "on pace: 20% of the session with half of it gone");
assert.equal(pace(claude(0.5, 4 * H, 0.3, 4 * D), now).mode, "delegate", "50% of the session with 20% of it gone: too fast");
assert.equal(pace(claude(0.1, 4.5 * H, 0.6, 5 * D), now).mode, "delegate", "a busy week: 60% used, 2 of 7 days gone");
assert.equal(pace(claude(0.75, 0.5 * H, 0.3, 4 * D), now).mode, "delegate", "above 70% always leans on the free agents");
assert.equal(pace(claude(0.05, 4.9 * H, 0.1, 6.9 * D), now).mode, "normal", "a fresh window's tiny use isn't 'too fast'");
const stop = pace(claude(STOP_AT, H, 0.3, 4 * D), now);
assert.equal(stop.mode, "stop", "at 90% she stops before running out");
assert.equal(stop.until, now + H, "and says when she can go again");
assert.equal(pace(claude(0.2, H, 0.95, D), now).mode, "stop", "the weekly limit counts the same way");
assert.equal(pace(null, now).mode, "delegate", "no reading: play it safe");
assert.equal(windowPace({ title: "Session", percent: 0.4, resetsAt: "" }, now).burn, null, "no reset time: no burn rate invented");
assert.equal(windowPace({ title: "Monthly", percent: 0.4 }, now), null);
console.log("constance-pace: tests passed");
