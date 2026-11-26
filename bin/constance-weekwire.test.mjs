// The weekly wire: one call that turns limits + settings + the persisted drift state into the
// pace, the drifted intensity and the lanes — or null when there is no weekly reading.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { weekStatus, readWeekState, writeWeekState, weekStateFile } from "./constance-weekwire.mjs";
import { DAY, HOUR, HARD_LANES, MAX_LANES, FIRST_STEP, DRIFT_PER_HOUR } from "./constance-week.mjs";

const now = new Date(2026, 10, 23, 12).getTime(), WEEK = 7 * DAY;
const iso = (t) => new Date(t).toISOString();
const limits = (session, weekly, { sessionLeft = 3 * HOUR, weekLeft = 4 * DAY, t = now } = {}) => [
  { title: "Session", percent: session, resetsAt: iso(t + sessionLeft) },
  { title: "Weekly", percent: weekly, resetsAt: iso(t + weekLeft) }];
const near = (a, b) => Math.abs(a - b) < 1e-9;

// ---- day 3 of 7 expects about 43%; on pace drifts back to the owner's setting
{
  const w = weekStatus({ limits: limits(0.1, 3 / 7), settings: { constanceMilk: 25 }, openItems: 20, now });
  assert.equal(w.pace, "on pace");
  assert.equal(Math.round(w.expected * 100), 43);
  assert.equal(Math.round(w.used * 100), 43);
  assert.equal(w.gapPts, 0);
  assert.equal(w.manual, 25);
  assert.equal(w.drift, 0);
  assert.equal(w.driftText, "at your 25");
  assert.equal(w.effective, 25);
  assert.equal(w.lanes, 0, "on pace opens no lanes");
  assert.equal(w.final, false);
  assert.equal(w.state.manual, 25);
}

// ---- behind: drift starts from the setting and moves toward more lead work
{
  const w = weekStatus({ limits: limits(0.1, 0.2), settings: { constanceMilk: 30 }, openItems: 20, now });
  assert.equal(w.pace, "behind");
  assert.ok(w.gapPts < -5);
  assert.equal(w.drift, FIRST_STEP, "the first step after a fresh start is small");
  assert.equal(w.driftText, "+10 from your 30");
  assert.equal(w.effective, 40);
  assert.ok(w.lanes > 0);
  // The returned state is what gets persisted; the next call eases from it.
  const next = weekStatus({ limits: limits(0.1, 0.2), settings: { constanceMilk: 30 }, state: w.state, openItems: 20, now: now + HOUR });
  assert.ok(near(next.state.drift, FIRST_STEP + DRIFT_PER_HOUR));
}

// ---- ahead: drift back toward max delegation (0)
{
  const w = weekStatus({ limits: limits(0.1, 0.8), settings: { constanceMilk: 60 }, openItems: 20, now });
  assert.equal(w.pace, "ahead");
  assert.equal(w.drift, -FIRST_STEP);
  assert.equal(w.driftText, "-10 from your 60");
  assert.equal(w.effective, 50);
  assert.equal(w.lanes, 0, "ahead opens no lanes");
}

// ---- drift is capped by the owner's setting at both ends
{
  const behind = { manual: 25, drift: 74, at: now - HOUR, resetsAt: new Date(now + 4 * DAY).toISOString() };
  const w = weekStatus({ limits: limits(0.1, 0.2), settings: { constanceMilk: 25 }, state: behind, openItems: 20, now });
  assert.ok(w.effective <= 100);
  assert.ok(w.state.drift <= 75, "never past max Opus");
  const ahead = { manual: 60, drift: -59, at: now - HOUR, resetsAt: behind.resetsAt };
  const a = weekStatus({ limits: limits(0.1, 0.8), settings: { constanceMilk: 60 }, state: ahead, openItems: 20, now });
  assert.ok(a.state.drift >= -60, "never below max delegation");
  assert.ok(a.effective >= 0);
}

// ---- a changed setting or a new week restarts the drift from the setting
{
  const state = { manual: 25, drift: 40, at: now, resetsAt: new Date(now + 4 * DAY).toISOString() };
  const w = weekStatus({ limits: limits(0.1, 0.2), settings: { constanceMilk: 50 }, state, openItems: 20, now });
  assert.equal(w.state.drift, FIRST_STEP);
  assert.equal(w.manual, 50);
}

// ---- the last 24 hours with substantial room: final, full drift, as many lanes as allowed
{
  const left = 20 * HOUR;
  const w = weekStatus({ limits: limits(0.05, 0.6, { weekLeft: left }), settings: { constanceMilk: 30 }, openItems: 30, now });
  assert.equal(w.final, true);
  assert.equal(w.pace, "behind", "60% used with 20h left is behind the curve");
  assert.equal(w.state.drift, 70, "no easing in the last stretch");
  assert.equal(w.lanes, HARD_LANES);
  assert.ok(w.lanes > MAX_LANES);
  const notFinal = weekStatus({ limits: limits(0.1, 0.2), settings: { constanceMilk: 30 }, openItems: 20, now });
  assert.equal(notFinal.final, false);
  assert.ok(notFinal.lanes <= MAX_LANES);
}

// ---- no weekly reading: null, never a guess
assert.equal(weekStatus({ limits: [{ title: "Session", percent: 0.1, resetsAt: iso(now + HOUR) }], now }), null);
assert.equal(weekStatus({ limits: [{ title: "Weekly", percent: 0.2 }], now }), null, "no reset time, no curve");
assert.equal(weekStatus({ limits: [], now }), null);

// ---- bad input never throws
for (const bad of [undefined, null, {}, { limits: "junk" }, { limits: [null, 42, {}] }, { limits: limits(0.1, 0.2), state: "junk" }, { limits: limits(0.1, 0.2), openItems: "lots" }, { limits: limits(0.1, 0.2), now: NaN }]) {
  assert.doesNotThrow(() => weekStatus(bad));
}
assert.equal(weekStatus({ limits: limits(0.1, 0.2), state: "junk", openItems: 20, now }).pace, "behind", "a junk state starts fresh");
assert.equal(weekStatus({ limits: limits(0.1, 0.2), now: NaN }), null);

// ---- the persisted drift state: roundtrip in a mktemp dir, junk reads as null
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-weekwire-"));
  assert.equal(readWeekState(dir), null, "missing file reads as null");
  const state = weekStatus({ limits: limits(0.1, 0.2), settings: { constanceMilk: 30 }, openItems: 20, now }).state;
  writeWeekState(dir, state);
  assert.deepEqual(readWeekState(dir), state);
  assert.ok(fs.existsSync(weekStateFile(dir)));
  fs.writeFileSync(weekStateFile(dir), "not json");
  assert.equal(readWeekState(dir), null, "corrupt file reads as null");
  writeWeekState(dir, null);
  assert.equal(readWeekState(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("constance-weekwire: tests passed");
