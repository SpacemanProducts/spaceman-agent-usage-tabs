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

// ---- A FREE account, as GitHub really reports it: plan "individual" but access_type_sku "free_limited_copilot", premium requests
// 0, and monthly chat (200) and completions (2000) allowances. The plan is Free, and the two allowances are the meters.
const freeReal = parseCopilotQuota({ copilot_plan: "individual", access_type_sku: "free_limited_copilot", quota_reset_date_utc: "2026-12-01T00:00:00.000Z", quota_snapshots: {
  chat: { entitlement: 200, remaining: 199, quota_remaining: 199.8, percent_remaining: 99.9, unlimited: false, has_quota: true, credits_used: 0 },
  completions: { entitlement: 2000, remaining: 2000, quota_remaining: 2000, percent_remaining: 100, unlimited: false, has_quota: true, credits_used: 0 },
  premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 0, unlimited: false, has_quota: false, credits_used: 0 } } });
assert.equal(freeReal.plan, "Free", "not Pro: access_type_sku says free");
assert.equal(freeReal.free, true);
assert.deepEqual(freeReal.limits.map((l) => [l.title, l.note, Math.round(l.percent * 1000) / 1000]), [["Chat and agent requests", "Shared plan quota", 0.001]], "plain-language labels, the same numbers; editor autocomplete is not a CLI meter");
assert.ok(freeReal.limits.every((l) => l.window === "monthly"), "still monthly meters (the window is kept for reset detection)");
assert.equal(freeReal.limits[0].resetsAt, "2026-12-01T00:00:00.000Z"); assert.equal(freeReal.status, "", "meters shown, so no 'no allowance' line");
// used up: 150 of 200 chat left -> 25% used, from the most precise figure
assert.equal(parseCopilotQuota({ copilot_plan: "free", quota_snapshots: { chat: { entitlement: 200, percent_remaining: 25, has_quota: true } } }).limits[0].percent, 0.75);
// a paid plan whose chat and completions are unlimited gets no extra meters, only its premium meter
const paid = parseCopilotQuota({ copilot_plan: "individual", quota_reset_date_utc: "2026-12-01T00:00:00.000Z", quota_snapshots: { chat: { unlimited: true, entitlement: -1 }, completions: { unlimited: true }, premium_interactions: { entitlement: 300, credits_used: 30, unlimited: false } } });
assert.equal(paid.plan, "Pro"); assert.deepEqual(paid.limits.map((l) => l.title), ["Monthly"]);
// ---- token-based billing: the allowance is in AI credits, and the note counts them (real payload 2026-11-23: 194.9 of 200 left)
{
  const r = parseCopilotQuota({ copilot_plan: "individual", access_type_sku: "free_limited_copilot", quota_reset_date_utc: "2026-12-01T00:00:00.000Z", quota_snapshots: {
    chat: { entitlement: 200, remaining: 194, quota_remaining: 194.9, percent_remaining: 97.4, unlimited: false, has_quota: true, credits_used: 5, token_based_billing: true },
    premium_interactions: { entitlement: 0, has_quota: false } } });
  assert.equal(r.limits[0].note, "5.1 of 200 AI credits used. Shared plan quota");
  assert.ok(Math.abs(r.limits[0].percent - 0.026) < 1e-9);
}
console.log("copilot: all tests passed");
