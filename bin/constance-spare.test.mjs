import assert from "node:assert/strict";
import { leftAtReset, spareWindows, useItOrLoseItOn, planSpare, SOON, DEFAULT_SOON, MIN_LEFT, OPUS_KINDS } from "./constance-spare.mjs";

const now = Date.UTC(2026, 10, 24, 12);
const H = 3600e3, D = 24 * H;
const lim = (title, used, resetsIn) => ({ title, percent: used, resetsAt: new Date(now + resetsIn).toISOString() });
const agent = (id, limits) => ({ id, limits });
const item = (id, kind, text = `do ${id}`) => ({ id, kind, text, files: [], done: false });

// --- leftAtReset -------------------------------------------------------------
// Session window is 5 h. Half used with 1 h left: 4 h elapsed, rate 0.125/h,
// projected 0.5 + 0.125 = 0.625 used at reset -> 0.375 left.
assert.equal(leftAtReset(lim("Session", 0.5, H), now), 0.375);
assert.equal(leftAtReset(lim("Session", 0.2, H), now), 0.75, "20% used, 80% of the window gone: most of it left");
assert.equal(leftAtReset(lim("Session", 0.9, H), now), 0, "projected past full: nothing left");
assert.equal(leftAtReset(lim("Monthly", 0.4, H), now), 0.6, "unknown window length: projected flat at the current level");
assert.equal(leftAtReset(lim("Session", 0.5, 6 * H), now), 0.5, "reset beyond a whole window: no elapsed share, projected flat");
assert.equal(leftAtReset({ title: "Session", resetsAt: new Date(now + H).toISOString() }, now), null, "no percent");
assert.equal(leftAtReset({ title: "Session", percent: 0.5 }, now), null, "no resetsAt");
assert.equal(leftAtReset(lim("Session", 0.5, -H), now), null, "reset in the past");
assert.equal(leftAtReset(lim("Session", 0.5, H), now + 2 * H), null, "now after the reset");
assert.equal(leftAtReset(null, now), null);

// --- spareWindows ------------------------------------------------------------
// Session resets within SOON.Session (1 h) with room to spare.
assert.deepEqual(
  spareWindows(agent("grok", [lim("Session", 0.2, 0.5 * H)]), now).map((w) => w.agent),
  ["grok"], "a session resetting in 30 min with 80%+ room left is spare");
assert.equal(spareWindows(agent("grok", [lim("Session", 0.2, 2 * H)]), now).length, 0,
  "same room but the reset is 2 h out: past SOON.Session, nothing offered");
assert.equal(spareWindows(agent("grok", [lim("Session", 0.8, 0.5 * H)]), now).length, 0,
  "high burn: 80% used, projected to ~89% at reset, under MIN_LEFT");
assert.equal(spareWindows(agent("grok", [lim("Session", 0.86, 0.5 * H)]), now).length, 0,
  "near a wall: any limit at 85%+ means no spare windows at all");
assert.equal(spareWindows(agent("grok", [lim("Session", 0.2, 0.5 * H), lim("Weekly", 0.9, 0.5 * H)]), now).length, 0,
  "one near-wall limit poisons the whole agent");
assert.equal(spareWindows(agent("grok", [lim("Session", 0.2, 30 * H)]), now).length, 0,
  "a 30 h session reset is never 'soon'");
assert.equal(spareWindows(agent("grok", [lim("Weekly", 0.2, 23 * H)]), now).length, 1,
  "a weekly reset 23 h out is within SOON.Weekly (24 h)");
assert.equal(spareWindows(agent("grok", [lim("Weekly", 0.2, 25 * H)]), now).length, 0,
  "25 h out is past SOON.Weekly");
assert.equal(spareWindows(agent("grok", [lim("Other", 0.2, 5 * H)]), now).length, 1,
  "an unlisted title gets DEFAULT_SOON (6 h)");
assert.equal(spareWindows(agent("grok", [lim("Other", 0.2, 7 * H)]), now).length, 0);
const w = spareWindows(agent("grok", [lim("Session", 0.2, 0.5 * H)]), now)[0];
assert.deepEqual(Object.keys(w).sort(), ["agent", "left", "resetsAt", "title", "used"], "window shape");
assert.equal(w.resetsAt, now + 0.5 * H, "resetsAt as ms");
assert.equal(w.left >= MIN_LEFT, true);
assert.equal(SOON.Session, H);
assert.equal(DEFAULT_SOON, 6 * H);
assert.equal(MIN_LEFT, 0.25);

// --- useItOrLoseItOn ---------------------------------------------------------
assert.equal(useItOrLoseItOn({}), true, "on by default");
assert.equal(useItOrLoseItOn({ constanceUseItOrLoseIt: false }), false);
assert.equal(useItOrLoseItOn({ constanceUseItOrLoseIt: true }), true);
assert.equal(useItOrLoseItOn(undefined), true);
assert.deepEqual(OPUS_KINDS, ["review", "bug", "design"]);

// --- planSpare ---------------------------------------------------------------
const grok = () => agent("grok", [lim("Session", 0.2, 0.5 * H)]); // spare session, resets soon
const claude = () => agent("claude", [lim("Session", 0.3, 0.4 * H)]); // spare session, sooner

let r = planSpare({ agents: [grok()], available: ["grok"], backlog: [item("a", "chore")], now });
assert.equal(r.on, true);
assert.equal(r.picks.length, 1);
assert.equal(r.picks[0].agent, "grok");
assert.equal(r.picks[0].window.title, "Session");
assert.deepEqual(r.picks[0].items.map((i) => i.id), ["a"]);
assert.match(r.reason, /grok/);
assert.match(r.reason, /Session/);

r = planSpare({ agents: [grok()], available: ["grok"], backlog: [item("a", "chore")], settings: { constanceUseItOrLoseIt: false }, now });
assert.deepEqual(r, { on: false, picks: [], reason: "use it or lose it is off" });

r = planSpare({ agents: [grok()], available: ["grok"], backlog: [], now });
assert.deepEqual(r.picks, []);
assert.equal(r.reason, "nothing worthwhile in the backlog, so the spare room is left alone");
r = planSpare({ agents: [grok()], available: ["grok"], backlog: [item("a", "chore", "   "), { id: "b", kind: "x", done: true, text: "old" }], now });
assert.equal(r.reason, "nothing worthwhile in the backlog, so the spare room is left alone", "blank text and done items don't count");

r = planSpare({ agents: [agent("grok", [lim("Session", 0.2, 3 * H)])], available: ["grok"], backlog: [item("a", "chore")], now });
assert.equal(r.reason, "no agent has room it would lose before a reset", "reset too far out");
r = planSpare({ agents: [agent("grok", [lim("Session", 0.9, 0.5 * H)])], available: ["grok"], backlog: [item("a", "chore")], now });
assert.equal(r.reason, "no agent has room it would lose before a reset", "near-wall agent");
r = planSpare({ agents: [grok()], available: [], backlog: [item("a", "chore")], now });
assert.equal(r.reason, "no agent has room it would lose before a reset", "worker not free right now");
r = planSpare({ agents: [], available: ["grok"], backlog: [item("a", "chore")], now });
assert.equal(r.reason, "no agent has room it would lose before a reset");

// Claude only takes OPUS_KINDS; other agents take everything else.
r = planSpare({
  agents: [claude(), grok()],
  available: ["grok"],
  backlog: [item("rev", "review"), item("bug", "bug"), item("des", "design"), item("ch", "chore"), item("fe", "feature")],
  perAgent: 10, now });
assert.equal(r.picks[0].agent, "claude", "claude's reset is sooner: served first");
assert.deepEqual(r.picks[0].items.map((i) => i.id), ["rev", "bug", "des"], "claude takes only review/bug/design");
assert.equal(r.picks[1].agent, "grok");
assert.deepEqual(r.picks[1].items.map((i) => i.id), ["ch", "fe"], "grok gets the rest, none twice");

// Without claude in the agents, a review item stays put rather than going to a worker.
r = planSpare({ agents: [grok()], available: ["grok"], backlog: [item("rev", "review")], now });
assert.equal(r.picks.length, 0, "opus-only work isn't handed to a free agent");
assert.equal(r.reason, "nothing worthwhile in the backlog, so the spare room is left alone");

// perAgent caps how much one agent is handed.
r = planSpare({
  agents: [grok()], available: ["grok"], perAgent: 1, now,
  backlog: [item("a", "chore"), item("b", "chore"), item("c", "chore")] });
assert.equal(r.picks[0].items.length, 1);

// Backlog order is preserved within a pick, and done items are skipped.
r = planSpare({
  agents: [grok()], available: ["grok"], now,
  backlog: [{ id: "x", kind: "chore", text: "skip me", done: true }, item("b", "chore"), item("a", "chore")] });
assert.deepEqual(r.picks[0].items.map((i) => i.id), ["b", "a"]);

// Two spare windows on one agent: the soonest reset is the one offered.
r = planSpare({
  agents: [agent("grok", [lim("Weekly", 0.3, 20 * H), lim("Session", 0.2, 0.5 * H)])],
  available: ["grok"], backlog: [item("a", "chore")], now });
assert.equal(r.picks[0].window.title, "Session", "soonest reset wins");

console.log("constance-spare: tests passed");
