// The stage bar (preparing red, checklist yellow, review green) and the Rev Meter.
import assert from "node:assert/strict";
import { stageProgress, revMeter, STAGE_HUE, DEFAULT_PREP_MS, TARGET_PER_PCT } from "./constance-meters.mjs";

const now = 1e12, min = 60e3;
const goal = { id: "g1", status: "running", startedAt: now };
const P = (extra = {}) => stageProgress({ goal, now, ...extra });
assert.equal(stageProgress({ goal: null }), null);
assert.deepEqual([STAGE_HUE.preparing, STAGE_HUE.checklist, STAGE_HUE.review], [0, 55, 120]);
assert.equal(P().stage, "preparing"); assert.equal(P().hue, 0); assert.equal(P().etaMs, null, "no history: no time claimed");
// Preparing moves with time and with each real step, and never claims to be finished.
let last = -1;
for (const t of [0, 0.5, 1, 2, 4, 8, 60]) { const v = P({ now: now + t * min }); assert.ok(v.overall > last || t >= 8); assert.ok(v.overall < 0.2); last = v.overall; }
assert.ok(P({ steps: 3 }).fraction > P().fraction);
const eta = P({ now: now + min, prepHistory: [5 * min, 3 * min, 4 * min] });
assert.equal(eta.etaMs, 3 * min); assert.match(eta.label, /about 3 min left/);
assert.equal(P({ now: now + 99 * min, prepHistory: [min] }).label, "Preparing");
assert.ok(DEFAULT_PREP_MS > 0);
// Checklist: yellow, steps along with every finished item.
const jobs = (...s) => s.map((status) => ({ goal: "g1", status }));
const a = P({ jobs: jobs("running", "running", "running") }), b = P({ jobs: jobs("accepted", "finished", "running") }), c = P({ jobs: jobs("accepted", "accepted", "running") });
assert.equal(a.stage, "checklist"); assert.equal(a.hue, 55); assert.match(c.label, /2 of 3 done/);
assert.ok(a.overall < b.overall && b.overall < c.overall);
assert.ok(a.overall >= 0.2 && c.overall <= 0.85);
// Review: green once everything is back; done fills the bar.
const r = P({ jobs: jobs("accepted", "finished") });
assert.equal(r.stage, "review"); assert.equal(r.hue, 120); assert.ok(r.overall >= 0.85 && r.overall < 1);
assert.equal(P({ items: [{ state: "done" }, { state: "todo" }] }).stage, "checklist");
assert.equal(P({ items: [{ state: "done" }, { state: "review" }] }).stage, "review");
assert.equal(P({ items: [{ state: "review" }, { state: "problem" }] }).stage, "checklist", "a problem is not back");
const done = stageProgress({ goal: { ...goal, status: "done" }, now });
assert.equal(done.overall, 1); assert.equal(done.active, false);
assert.equal(stageProgress({ goal: { ...goal, status: "paused" }, now }).active, false, "paused sits still");
assert.equal(P({ jobs: [{ goal: "other", status: "running" }] }).stage, "preparing", "another goal's jobs don't count");

// Rev Meter.
assert.equal(revMeter().grade, "idle"); assert.equal(revMeter().needle, 0); assert.equal(revMeter().score, null);
assert.equal(revMeter({ running: 1, slots: 10 }).grade, "warming up");
assert.equal(revMeter({ running: 3, lanes: 2, slots: 10 }).grade, "cooking");
assert.equal(revMeter({ running: 7, lanes: 2, slots: 10 }).grade, "redline");
assert.equal(revMeter({ running: 9, slots: 10, perPct: 1e6 }).grade, "cooking", "busy but poor return is not redline");
const m = revMeter({ running: 1, slots: 2, perPct: 5e6, workerTokens: 10e6, leadTokens: 2e6 });
assert.equal(m.score, 5e6 / TARGET_PER_PCT); assert.ok(Math.abs(m.share - 1 / 6) < 1e-9);
assert.equal(revMeter({ perPct: NaN }).score, null);
assert.equal(revMeter({ workerTokens: null, leadTokens: 5 }).share, null, "never half a guess");
console.log("constance-meters: tests passed");
