import assert from "node:assert/strict";
import { parseCopilotQuota } from "./copilot.mjs";
const q = (snap, extra = {}) => ({ copilot_plan: "individual", quota_reset_date_utc: "2026-12-01T00:00:00.000Z", quota_snapshots: { premium_interactions: snap }, ...extra });
// your real shape: entitlement 0 -> no meter, one status line with the reset date
const real = parseCopilotQuota(q({ entitlement: 0, credits_used: 0, has_quota: false, unlimited: false }));
assert.deepEqual(real.limits, []); assert.equal(real.status, "No included allowance on this plan · resets Dec 1, 00:00 UTC"); assert.equal(real.plan, "Pro"); assert.equal(real.free, false);
assert.equal(parseCopilotQuota(q({ entitlement: 0, credits_used: 0 }, { copilot_plan: "free" })).free, true, "free plan flagged");
// a limited allowance -> a monthly meter with its reset time
const lim = parseCopilotQuota(q({ entitlement: 1500, credits_used: 300, unlimited: false }));
assert.equal(lim.limits[0].title, "Monthly"); assert.equal(lim.limits[0].percent, 0.2); assert.equal(lim.limits[0].resetsAt, "2026-12-01T00:00:00.000Z");
// remaining-style payload
assert.equal(parseCopilotQuota(q({ entitlement: 100, remaining: 25 })).limits[0].percent, 0.75);
assert.equal(parseCopilotQuota(q({ entitlement: 100, percent_remaining: 40 })).limits[0].percent, 0.6);
// unlimited, missing, garbage: no meter, no guessing
assert.deepEqual(parseCopilotQuota(q({ unlimited: true })).limits, []);
assert.deepEqual(parseCopilotQuota({}).limits, []); assert.deepEqual(parseCopilotQuota(null).limits, []);
assert.deepEqual(parseCopilotQuota(q({ entitlement: null })).limits, []);
assert.deepEqual(parseCopilotQuota(q({ entitlement: 100 })).limits, [], "no usage figure -> no meter");
console.log("copilot: all tests passed");
