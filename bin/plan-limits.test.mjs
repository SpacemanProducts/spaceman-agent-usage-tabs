import assert from "node:assert/strict";
import { isPlanLimit, planLimitsOnly } from "./plan-limits.mjs";
for (const t of ["Session", "Weekly", "Monthly", "Daily", "Claude/GPT Weekly", "Auto models Monthly", "Prompt credits", "Flow credits", "Credits", "Fable Weekly"])
  assert.equal(isPlanLimit({ title: t }), true, `${t} is a plan limit`);
for (const t of ["Individual spend limit", "Extra usage", "Overage", "On-demand usage", "Top-up balance", "Auto-reload", "Prepaid balance", "Credits purchased", "Pay as you go", "Spend"])
  assert.equal(isPlanLimit({ title: t }), false, `${t} is money, not a plan limit`);
assert.equal(isPlanLimit({ title: "Monthly", detail: "on-demand spend" }), false, "detail text counts too");
assert.deepEqual(planLimitsOnly([{ title: "Weekly" }, { title: "Overage" }, { title: "Session" }]).map((l) => l.title), ["Weekly", "Session"]);
assert.deepEqual(planLimitsOnly(null), []); assert.equal(isPlanLimit(null), true);
console.log("plan-limits: all tests passed");
