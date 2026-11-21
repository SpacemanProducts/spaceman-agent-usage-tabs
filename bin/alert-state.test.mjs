import assert from "node:assert/strict";
import { planAlerts } from "./alert-state.mjs";
const NOW = Date.parse("2026-11-21T06:00:00Z");
const A = (id, title, percent, resetsAt = "2026-11-26T11:27:25Z") => ({ id, name: id, limits: [{ title, percent, resetsAt }] });
const T = 0.95;
// The caller records an alert only after the notification was really sent.
const sent = (r) => { for (const x of r.toSend) r.memory[x.key] = NOW; return r; };

// First time over the threshold: one alert, remembered.
let r = sent(planAlerts([A("antigravity", "Claude/GPT Weekly", 0.99)], {}, T, NOW));
assert.equal(r.toSend.length, 1); const mem = r.memory; assert.equal(Object.keys(mem).length, 1);
// Still over on the next refresh: quiet.
r = planAlerts([A("antigravity", "Claude/GPT Weekly", 0.99)], mem, T, NOW);
assert.equal(r.toSend.length, 0);
// THE BUG: the agent errors for one refresh (no limits). Memory must survive...
r = planAlerts([{ id: "antigravity", name: "antigravity", limits: [] }], mem, T, NOW);
assert.equal(r.toSend.length, 0); assert.deepEqual(r.memory, mem);
// ...and an agent missing entirely too...
r = planAlerts([], mem, T, NOW); assert.deepEqual(r.memory, mem);
// ...so when it comes back there is no repeat alert.
r = planAlerts([A("antigravity", "Claude/GPT Weekly", 0.99)], r.memory, T, NOW);
assert.equal(r.toSend.length, 0);
// Reported below the threshold: forgotten, and a later crossing alerts again.
r = planAlerts([A("antigravity", "Claude/GPT Weekly", 0.10)], mem, T, NOW);
assert.deepEqual(r.memory, {});
r = planAlerts([A("antigravity", "Claude/GPT Weekly", 0.97)], r.memory, T, NOW);
assert.equal(r.toSend.length, 1);
// A notification that failed to send is not remembered, so it retries.
assert.equal(planAlerts([A("antigravity", "Claude/GPT Weekly", 0.97)], {}, T, NOW).toSend.length, 1);
// A new window (new resetsAt) alerts even if the old one was remembered.
r = planAlerts([A("claude", "Session", 0.96, "2026-11-21T11:00:00Z")], { "claude|Session|2026-11-21T06:00:00Z": 1 }, T, NOW);
assert.equal(r.toSend.length, 1);
// Not watched / under threshold: nothing.
assert.equal(planAlerts([A("devin", "Prompt credits", 0.99)], {}, T, NOW).toSend.length, 0);
assert.equal(planAlerts([A("claude", "Session", 0.71)], {}, T, NOW).toSend.length, 0);
assert.equal(planAlerts([A("claude", "Session", 0.95)], {}, T, NOW).toSend.length, 0, "exactly 95 is not past 95");
// Old windows are pruned.
r = planAlerts([], { "claude|Session|2026-11-01T00:00:00Z": 1 }, T, NOW); assert.deepEqual(r.memory, {});
console.log("alert-state: all tests passed");
