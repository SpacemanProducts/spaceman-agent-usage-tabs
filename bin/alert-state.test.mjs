import assert from "node:assert/strict";
import { planAlerts, markFired, alertText, planHandoffTriggers, markHandoffFired, HANDOFF_AT } from "./alert-state.mjs";

const T = 0.95;
const MIN = 60000, HOUR = 3600000;
const T0 = Date.parse("2026-11-22T10:00:00Z");
const RESET = Date.parse("2026-11-22T15:00:00Z");
const A = (id, title, percent, resetsAt) => ({ id, name: id, limits: [{ title, percent, resetsAt }] });

// One collector run: plan, "send" every alert that is due (as collect.mjs does), save the memory as JSON (so a
// restart between runs is simulated), and return the alerts that went out.
function makeRun(threshold = T) {
  let saved = "{}";
  return (agents, now, { sendFails = false } = {}) => {
    const { toSend, memory } = planAlerts(agents, JSON.parse(saved), threshold, now);
    const out = [];
    for (const item of toSend) { out.push(`${item.agent.name}|${item.limit.title}|${item.level}`); if (!sendFails) markFired(memory, item, now); }
    saved = JSON.stringify(memory);
    return out;
  };
}
// Claude reports its reset time with microseconds that change on every fetch.
const jitter = (n) => new Date(RESET + n * 7919).toISOString().replace("Z", `${String(100000 + n * 331).slice(-6)}+00:00`);

// ---- THE REQUEST: usage held at 100% for many checks -> exactly ONE alert
{
  const run = makeRun();
  const all = [];
  for (let i = 0; i < 12; i++) all.push(...run([A("claude", "Session", 1.0, jitter(i))], T0 + i * 5 * MIN));
  assert.deepEqual(all, ["claude|Session|limit"], "100% for 12 checks (reset time wobbling, memory reloaded each time): one alert");
}
// ---- usage held at 96% (past the threshold, not at the limit): one warning, however long it stays
{
  const run = makeRun();
  const all = [];
  for (let i = 0; i < 20; i++) all.push(...run([A("claude", "Session", 0.96, jitter(i))], T0 + i * 5 * MIN));
  assert.deepEqual(all, ["claude|Session|warn"]);
}
// ---- crossing the threshold, then hitting the limit later in the same window: one of each, then quiet
{
  const run = makeRun();
  const all = [];
  all.push(...run([A("claude", "Session", 0.90, jitter(0))], T0));
  all.push(...run([A("claude", "Session", 0.96, jitter(1))], T0 + 5 * MIN));
  all.push(...run([A("claude", "Session", 0.97, jitter(2))], T0 + 10 * MIN));
  all.push(...run([A("claude", "Session", 1.0, jitter(3))], T0 + 15 * MIN));
  for (let i = 4; i < 12; i++) all.push(...run([A("claude", "Session", 1.0, jitter(i))], T0 + i * 5 * MIN));
  assert.deepEqual(all, ["claude|Session|warn", "claude|Session|limit"]);
}
// ---- jumping straight to the limit sends only the limit alert (it covers the warning)
{
  const run = makeRun();
  assert.deepEqual(run([A("claude", "Session", 0.5, jitter(0))], T0), []);
  assert.deepEqual(run([A("claude", "Session", 1.0, jitter(1))], T0 + 5 * MIN), ["claude|Session|limit"]);
  assert.deepEqual(run([A("claude", "Session", 0.97, jitter(2))], T0 + 10 * MIN), [], "a dip back under 100% does not bring the warning back");
}
// ---- a blip below the threshold (or a failed fetch) does not re-arm the window
{
  const run = makeRun();
  assert.equal(run([A("claude", "Session", 0.97, jitter(0))], T0).length, 1);
  assert.deepEqual(run([A("claude", "Session", 0.93, jitter(1))], T0 + 5 * MIN), [], "small dip");
  assert.deepEqual(run([A("claude", "Session", 0.97, jitter(2))], T0 + 10 * MIN), [], "...and back up: still quiet");
  assert.deepEqual(run([{ id: "claude", name: "claude", limits: [] }], T0 + 15 * MIN), [], "agent errored");
  assert.deepEqual(run([], T0 + 20 * MIN), [], "agent missing");
  assert.deepEqual(run([A("claude", "Session", 0.97, jitter(3))], T0 + 25 * MIN), [], "back: no repeat");
}
// ---- the window resets: memory clears, and the next window alerts once again
{
  const run = makeRun();
  assert.equal(run([A("claude", "Session", 1.0, jitter(0))], T0).length, 1);
  assert.equal(run([A("claude", "Session", 1.0, jitter(1))], T0 + 5 * MIN).length, 0);
  // reset: usage drops far, then the next window (5 h later) fills up again
  assert.deepEqual(run([A("claude", "Session", 0.04, new Date(RESET + 5 * HOUR).toISOString())], RESET + 10 * MIN), []);
  assert.deepEqual(run([A("claude", "Session", 0.97, new Date(RESET + 5 * HOUR).toISOString())], RESET + 4 * HOUR), ["claude|Session|warn"], "new window warns once");
  assert.deepEqual(run([A("claude", "Session", 0.98, new Date(RESET + 5 * HOUR).toISOString())], RESET + 4 * HOUR + 5 * MIN), []);
}
// ---- a new window is recognised even if usage never dipped (the reset time moved on)
{
  const run = makeRun();
  assert.equal(run([A("claude", "Weekly", 0.99, "2026-11-25T11:00:00.100000+00:00")], T0).length, 1);
  assert.equal(run([A("claude", "Weekly", 0.99, "2026-11-25T11:00:01.900000+00:00")], T0 + 5 * MIN).length, 0, "seconds of wobble: same window");
  assert.equal(run([A("claude", "Weekly", 0.99, "2026-12-02T11:00:00+00:00")], T0 + 8 * 24 * HOUR - HOUR).length, 1, "a week later: new window");
}
// ---- survives a restart: the memory is plain JSON
{
  const run1 = makeRun();
  run1([A("grok", "Weekly", 0.99, new Date(RESET).toISOString())], T0);
  const { toSend, memory } = planAlerts([A("grok", "Weekly", 0.99, new Date(RESET).toISOString())], JSON.parse(JSON.stringify(markFired({}, { key: "grok|Weekly", level: "limit", resetMs: RESET }, T0))), T, T0 + MIN);
  assert.equal(toSend.length, 0); assert.ok(memory["grok|Weekly"].levels.limit);
}
// ---- a notification that failed to send is not remembered, so it retries (once it goes out, it never repeats)
{
  const run = makeRun();
  assert.equal(run([A("claude", "Session", 1.0, jitter(0))], T0, { sendFails: true }).length, 1);
  assert.equal(run([A("claude", "Session", 1.0, jitter(1))], T0 + 5 * MIN, { sendFails: true }).length, 1, "retries while sending fails");
  assert.equal(run([A("claude", "Session", 1.0, jitter(2))], T0 + 10 * MIN).length, 1, "sent this time");
  assert.equal(run([A("claude", "Session", 1.0, jitter(3))], T0 + 15 * MIN).length, 0, "and never again");
}
// ---- every agent has its own window; a lower threshold works the same way
{
  const run = makeRun(0.5);
  const all = [];
  for (let i = 0; i < 6; i++) all.push(...run([A("claude", "Session", 0.6, jitter(i)), A("codex", "Weekly", 0.7, jitter(i))], T0 + i * 5 * MIN));
  assert.deepEqual(all.sort(), ["claude|Session|warn", "codex|Weekly|warn"]);
}
// ---- not watched / under threshold: nothing
assert.equal(planAlerts([A("devin", "Prompt credits", 0.99)], {}, T, T0).toSend.length, 0);
assert.equal(planAlerts([A("claude", "Session", 0.71)], {}, T, T0).toSend.length, 0);
assert.equal(planAlerts([A("claude", "Session", 0.95)], {}, T, T0).toSend.length, 0, "exactly 95 is not past 95");
// ---- old windows are pruned
assert.deepEqual(planAlerts([], { "claude|Session": { resetMs: T0 - 2 * HOUR, levels: { warn: 1 } } }, T, T0).memory, {});
// ---- memory from older versions (key with the reset string, value a timestamp) counts as an alert already sent
{
  const old = { "antigravity|Claude/GPT Weekly|2026-11-26T11:27:25.000Z": 1795330023713 };
  assert.equal(planAlerts([A("antigravity", "Claude/GPT Weekly", 0.99, "2026-11-26T11:27:25Z")], old, T, T0).toSend.filter((x) => x.level === "warn").length, 0);
}
// ---- multi-account: an alert per account, named by its label, each once
{
  const run = makeRun();
  const a = { id: "claude", name: "Claude Code", limits: [], accounts: [{ id: "w", label: "Work", limits: [{ title: "Session", percent: 0.99, resetsAt: "2026-11-22T15:00:00Z" }] }, { id: "m", label: "Main", limits: [{ title: "Session", percent: 0.1 }] }] };
  const all = [];
  for (let i = 0; i < 5; i++) all.push(...run([a], T0 + i * 5 * MIN));
  assert.deepEqual(all, ["Claude Code (Work)|Session|warn"]);
}
// ---- the notification text
assert.deepEqual(alertText({ level: "warn", agent: { name: "Claude Code" }, limit: { title: "Session", percent: 0.96 } }, "resets in 1h 20m"), { title: "Claude Code: 96% used", body: "Session limit at 96% — resets in 1h 20m" });
assert.deepEqual(alertText({ level: "limit", agent: { name: "Claude Code" }, limit: { title: "Weekly", percent: 1 } }), { title: "Claude Code: limit reached", body: "Weekly limit hit (100%)" });

// ---- the handoff note's own trigger: SESSION usage at 90% or more, once per window (not tied to the alert threshold)
{
  assert.equal(HANDOFF_AT, 0.9);
  let saved = "{}";
  const run = (agents, now) => { const { toFire, memory } = planHandoffTriggers(agents, JSON.parse(saved), now); for (const i of toFire) markHandoffFired(memory, i, now); saved = JSON.stringify(memory); return toFire.map((i) => `${i.agent.name}|${i.limit.title}`); };
  // 60%, 75%, 89%: never. (The prompt used to be offered at 60%.)
  for (const p of [0.6, 0.75, 0.89, 0.8999]) assert.deepEqual(run([A("claude", "Session", p, jitter(0))], T0), [], `${p} is below 90%`);
  // a LOW alert threshold does not matter: the handoff rule is its own
  assert.deepEqual(planAlerts([A("claude", "Session", 0.6, jitter(0))], {}, 0.5, T0).toSend.length, 1, "an alert at a 50% threshold can fire at 60%...");
  assert.deepEqual(planHandoffTriggers([A("claude", "Session", 0.6, jitter(0))], {}, T0).toFire, [], "...but the handoff does not");
  // 90% fires once; held at 90-100% for many checks (wobbling reset time, memory reloaded each time) it never repeats
  const all = [];
  for (let i = 0; i < 25; i++) all.push(...run([A("claude", "Session", i < 5 ? 0.9 : 1.0, jitter(i))], T0 + i * 5 * MIN));
  assert.deepEqual(all, ["claude|Session"], "once per window");
  // weekly meters never trigger it
  assert.deepEqual(run([A("grok", "Weekly", 0.99, jitter(0))], T0), []);
  // a dip and a failed fetch do not rearm it; the window resetting does
  assert.deepEqual(run([A("claude", "Session", 0.8, jitter(30))], T0 + 3 * HOUR), [], "small dip");
  assert.deepEqual(run([{ id: "claude", name: "claude", limits: [] }], T0 + 3 * HOUR), [], "failed fetch");
  assert.deepEqual(run([A("claude", "Session", 0.95, jitter(31))], T0 + 3 * HOUR), [], "back up: still the same window");
  const next = new Date(RESET + 5 * HOUR).toISOString();
  assert.deepEqual(run([A("claude", "Session", 0.04, next)], RESET + 10 * MIN), [], "the window resets");
  assert.deepEqual(run([A("claude", "Session", 0.5, next)], RESET + 2 * HOUR), [], "next window at 50%: nothing");
  assert.deepEqual(run([A("claude", "Session", 0.91, next)], RESET + 4 * HOUR), ["claude|Session"], "the next window crosses 90%: once more");
  assert.deepEqual(run([A("claude", "Session", 0.99, next)], RESET + 4 * HOUR + 5 * MIN), []);
  // several agents have their own windows
  const two = [];
  for (let i = 0; i < 4; i++) two.push(...run([A("codex", "Session", 0.93, jitter(i)), A("grok", "Session", 0.97, jitter(i))], T0 + 4 * HOUR + i * 5 * MIN));
  assert.deepEqual(two.sort(), ["codex|Session", "grok|Session"]);
}
console.log("alert-state: all tests passed");
