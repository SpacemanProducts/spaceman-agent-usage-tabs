// Weekly-aware pacing: the even-spread curve, the drift of the owner's intensity setting both ways,
// backlog lanes, the last 24 hours, the daily history and its lessons, and one synthetic week that
// starts behind and catches up.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOUR, DAY, intensitySetting, longWindow, curve, finalStretch, targetDrift, stepDrift, intensityView, laneCount, weekMode, headroom,
  recordDay, readHistory, CAUSES, DEFAULT_INTENSITY, HARD_LANES, MAX_LANES, DRIFT_PER_HOUR } from "./constance-week.mjs";

const now = new Date(2026, 10, 23, 12).getTime(), WEEK = 7 * DAY;
const iso = (t) => new Date(t).toISOString();
const limits = (session, weekly, { sessionLeft = 3 * HOUR, weekLeft = 4 * DAY, t = now } = {}) => [
  { title: "Session", percent: session, resetsAt: iso(t + sessionLeft) },
  { title: "Weekly", percent: weekly, resetsAt: iso(t + weekLeft) }];
const at = (weekly, weekLeft = 4 * DAY) => curve(longWindow(limits(0.1, weekly, { weekLeft }), now), now);
const near = (a, b) => Math.abs(a - b) < 1e-9;

// ---- the spend curve: day 3 of 7 is 3/7 = 43%
{
  const c = at(0.2);
  assert.equal(c.day, 3); assert.equal(c.days, 7);
  assert.equal(Math.round(c.expected * 100), 43);
  assert.equal(c.status, "behind");
  assert.equal(at(0.43).status, "on pace");
  assert.equal(at(3 / 7 - 0.049).status, "on pace", "within 5 points is on pace");
  assert.equal(at(3 / 7 + 0.049).status, "on pace");
  assert.equal(at(3 / 7 - 0.06).status, "behind");
  assert.equal(at(0.7).status, "ahead");
  assert.equal(at(0, WEEK).day, 1, "a fresh week is day 1");
  assert.equal(at(0.5, 3.8 * DAY).day, 4);
}
// The long window: the fullest weekly pool, else monthly; a session alone has no curve.
assert.equal(longWindow([{ title: "Gemini Weekly", percent: 0.2, resetsAt: iso(now + DAY) }, { title: "Claude Weekly", percent: 0.6, resetsAt: iso(now + DAY) }], now).title, "Claude Weekly");
assert.equal(longWindow([{ title: "Monthly", percent: 0.2, resetsAt: iso(now + 10 * DAY) }], now).len, 30 * DAY);
assert.equal(longWindow([{ title: "Session", percent: 0.2, resetsAt: iso(now + HOUR) }], now), null);
assert.equal(longWindow([{ title: "Weekly", percent: 0.2 }], now), null, "no reset time, no curve: never guessed");
assert.equal(longWindow([{ title: "Weekly", percent: 0.2, resetsAt: iso(now - HOUR) }], now), null, "a reading from last week is not this week");
assert.equal(curve(null, now).status, "unknown");

// ---- the owner's setting is the starting point
assert.equal(intensitySetting({}), DEFAULT_INTENSITY);
assert.equal(intensitySetting({ constanceMilk: 65 }), 65);
assert.equal(intensitySetting({ constanceMilk: 0 }), 0);
assert.equal(intensitySetting({ constanceMilk: 400 }), 100);
assert.equal(intensitySetting({ constanceMilk: "junk" }), DEFAULT_INTENSITY);

// ---- behind: drift toward more lead work, a step at a time, and say how far
{
  const c = at(0.2), manual = 30;
  assert.ok(targetDrift(c, manual) > 0);
  const first = stepDrift(null, { manual, c, now });
  assert.equal(first.drift, 10, "the first move is small");
  const later = stepDrift(first, { manual, c, now: now + HOUR });
  assert.ok(near(later.drift, 10 + DRIFT_PER_HOUR));
  const end = stepDrift(later, { manual, c, now: now + 40 * HOUR });
  assert.equal(end.drift, targetDrift(c, manual)); assert.ok(manual + end.drift <= 100);
  const v = intensityView(later, c);
  assert.equal(v.manual, 30); assert.equal(v.effective, 60); assert.equal(v.drift, 30);
  assert.match(v.text, /Your setting 30% · running at 60% \(\+30 toward more lead work, behind pace\)/);
  // Moving the slider or a new week starts over from the owner's setting.
  assert.equal(stepDrift(end, { manual: 50, c, now: now + 41 * HOUR }).drift, 10);
  const nextWeek = { ...c, resetsAt: c.resetsAt + WEEK };
  assert.equal(stepDrift(end, { manual, c: nextWeek, now: now + 41 * HOUR }).drift, 10);
  assert.equal(stepDrift(first, { manual, c: { ...c, resetsAt: c.resetsAt + 60e3 }, now: now + HOUR }).drift, later.drift, "a reset time that wobbles a minute is the same week");
}
// ---- ahead: drift back toward max delegation
{
  const c = at(0.75), manual = 60;
  const s = stepDrift(null, { manual, c, now });
  assert.equal(s.drift, -10);
  const end = stepDrift(s, { manual, c, now: now + 40 * HOUR });
  assert.equal(manual + end.drift, 0, "far ahead ends at max delegation");
  assert.match(intensityView(end, c).text, /toward delegation, ahead of pace/);
}
// ---- on pace: ease back to the owner's setting
{
  const behind = at(0.2), on = { ...at(0.43), resetsAt: behind.resetsAt };
  const high = { manual: 30, drift: 40, at: now, resetsAt: behind.resetsAt };
  assert.equal(stepDrift(high, { manual: 30, c: on, now: now + HOUR }).drift, 20);
  const back = stepDrift(high, { manual: 30, c: on, now: now + 5 * HOUR });
  assert.equal(back.drift, 0);
  assert.match(intensityView(back, on).text, /At your setting \(30%\)/);
  assert.equal(stepDrift(null, { manual: 30, c: curve(null), now }).drift, 0, "unreadable: never drift on a guess");
}

// ---- behind: parallel lanes for real backlog items, held back by the session
{
  const c = at(0.2), ls = limits(0.1, 0.2);
  const n = laneCount({ c, limits: ls, openItems: 20, now });
  assert.equal(n.lanes, MAX_LANES, "far behind opens the most lanes"); assert.equal(n.why, "behind pace");
  assert.equal(laneCount({ c: at(0.36), limits: limits(0.1, 0.36), openItems: 20, now }).lanes, 2, "a little behind opens fewer");
  assert.equal(laneCount({ c, limits: ls, openItems: 0, now }).lanes, 0);
  assert.match(laneCount({ c, limits: ls, openItems: 0, now }).why, /backlog is empty/, "never busywork");
  assert.equal(laneCount({ c, limits: ls, openItems: 2, now }).lanes, 2);
  assert.equal(laneCount({ c, limits: ls, openItems: 1, running: 2, now }).lanes, 3, "running lanes count with the open items");
  assert.equal(laneCount({ c, limits: limits(0.75, 0.2), openItems: 20, now }).lanes, 1, "the session caps it");
  assert.equal(laneCount({ c, limits: limits(0.85, 0.2), openItems: 20, now }).lanes, 0);
  assert.equal(laneCount({ c, limits: ls, openItems: 20, settings: { constanceMaxLanes: 0 }, now }).lanes, 0, "the owner can turn lanes off");
  assert.equal(laneCount({ c, limits: ls, openItems: 20, stopped: true, now }).lanes, 0);
  assert.equal(laneCount({ c: at(0.43), limits: ls, openItems: 20, now }).lanes, 0, "on pace: none");
  assert.equal(laneCount({ c: at(0.8), limits: ls, openItems: 20, now }).lanes, 0, "ahead: none");
  assert.equal(laneCount({ c: curve(null), limits: [], openItems: 20, now }).lanes, 0);
}
assert.ok(near(headroom({ title: "Session", percent: 0.5, resetsAt: iso(now + 4 * HOUR) }, now), 0.4));
assert.ok(near(headroom({ title: "Session", percent: 0.5, resetsAt: iso(now + HOUR / 2) }, now), 0.47), "close to the reset the line is 97%");

// ---- the last 24 hours with real room left: as many lanes as the session allows
{
  const left = 20 * HOUR, c = at(0.6, left), ls = limits(0.05, 0.6, { weekLeft: left });
  assert.equal(finalStretch(c), true);
  const n = laneCount({ c, limits: ls, openItems: 30, now });
  assert.equal(n.lanes, HARD_LANES); assert.equal(n.why, "last 24 hours");
  assert.ok(n.lanes > MAX_LANES);
  assert.equal(laneCount({ c, limits: limits(0.5, 0.6, { weekLeft: left }), openItems: 30, now }).lanes, 5, "40 points of session room at 8 a lane");
  assert.equal(laneCount({ c, limits: ls, openItems: 30, settings: { constanceLaneCost: 0.2 }, now }).lanes, 4);
  assert.equal(stepDrift(null, { manual: 30, c, now }).drift, 70, "no easing in: straight to full");
  assert.match(intensityView(stepDrift(null, { manual: 30, c, now }), c).text, /last 24 hours/);
  assert.equal(weekMode({ mode: "delegate", reason: "x" }, c, ls).mode, "push");
  assert.equal(finalStretch(at(0.95, left)), false, "5% left is not substantial");
  assert.equal(finalStretch(at(0.6, 25 * HOUR)), false);
  assert.equal(finalStretch(at(0.9, left)), true, "10% left still counts");
  assert.match(laneCount({ c: at(0.965, left), limits: limits(0.05, 0.965, { weekLeft: left }), openItems: 5, now }).why, /on pace|ahead|stop line/);
}

// ---- the week changes the mode, but never overrides a stop or a hot session
assert.equal(weekMode({ mode: "stop", reason: "full" }, at(0.2), limits(0.95, 0.2)).mode, "stop");
assert.equal(weekMode({ mode: "normal", reason: "" }, at(0.2), limits(0.1, 0.2)).mode, "push");
assert.equal(weekMode({ mode: "normal", reason: "" }, at(0.2), limits(0.75, 0.2)).mode, "delegate");
assert.equal(weekMode({ mode: "normal", reason: "" }, at(0.8), limits(0.1, 0.8)).mode, "delegate");
assert.equal(weekMode({ mode: "normal", reason: "r" }, at(0.43), limits(0.1, 0.43)).mode, "normal");

// ---- history: one record a day against the curve, and a lesson for what kept her behind
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-week-"));
  const c = at(0.2);
  assert.deepEqual(recordDay(dir, { c, causes: ["backlog-empty", "nonsense"], now }).lessons, []);
  recordDay(dir, { c: at(0.22), causes: ["session-full"], now: now + HOUR });
  let h = readHistory(dir);
  assert.equal(h.length, 1, "one record per day");
  assert.equal(h[0].used, 0.22, "the latest reading"); assert.equal(h[0].expected, 0.429); assert.equal(h[0].status, "behind");
  assert.deepEqual(h[0].causes, ["backlog-empty", "session-full"], "every cause seen that day");
  const next = recordDay(dir, { c: at(0.55), now: now + DAY });
  assert.deepEqual(next.lessons, [CAUSES["backlog-empty"], CAUSES["session-full"]], "the day closed behind teaches its causes");
  assert.deepEqual(recordDay(dir, { c: at(0.55), now: now + DAY + HOUR }).lessons, [], "once");
  assert.deepEqual(recordDay(dir, { c: at(0.6), now: now + 2 * DAY }).lessons, [], "a day on pace teaches nothing");
  assert.equal(readHistory(dir).length, 3);
  assert.deepEqual(recordDay(dir, { c: curve(null), now: now + 3 * DAY }).lessons, []);
  assert.equal(readHistory(dir).length, 3, "an unreadable day records nothing");
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- a synthetic week: quiet first two days, then she drifts up, opens lanes and catches up
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-week-sim-"));
  const start = new Date(2026, 10, 23, 0).getTime(), resetsAt = start + WEEK, manual = 30;
  let used = 0, state = null, openItems = 60, lanes = 0, caughtUpAt = 0;
  const trace = [], lessons = [];
  for (let h = 0; h < 168; h++) {
    const t = start + h * HOUR, sessionLeft = (5 - (h % 5)) * HOUR;
    const ls = [{ title: "Session", percent: 0.1, resetsAt: iso(t + sessionLeft) }, { title: "Weekly", percent: used, resetsAt: iso(resetsAt) }];
    const c = curve(longWindow(ls, t), t);
    state = stepDrift(state, { manual, c, now: t });
    lanes = laneCount({ c, limits: ls, openItems, running: 0, now: t }).lanes;
    trace.push({ h, status: c.status, drift: state.drift, lanes, used, expected: c.expected });
    if (h >= 48 && !caughtUpAt && c.status !== "behind") caughtUpAt = h;
    lessons.push(...recordDay(dir, { c, causes: c.status === "behind" && h < 48 ? ["not-running"] : [], now: t }).lessons);
    // The first two days nothing runs. After that use follows how hard she works, plus the lanes.
    if (h >= 48) { used = Math.min(0.97, used + 0.0015 + 0.008 * (manual + state.drift) / 100 + 0.0012 * lanes); openItems = Math.max(0, openItems - lanes / 8); }
  }
  const quiet = trace.slice(24, 48), caught = trace[caughtUpAt];
  assert.ok(quiet.every((x) => x.status === "behind" && x.drift > 0), "behind, and drifting up");
  assert.ok(quiet.some((x) => x.lanes > 0), "with lanes open");
  assert.ok(Math.max(...trace.map((x) => x.drift)) > 30);
  assert.ok(caughtUpAt > 48 && caughtUpAt < 144, `she catches up before the last day (hour ${caughtUpAt})`);
  assert.equal(caught.lanes, 0, "lanes close once she has caught up");
  const after = trace.slice(caughtUpAt, 144);
  assert.ok(after.some((x) => x.status === "on pace" && Math.abs(x.drift) < 1), "and the drift returns to the owner's setting");
  assert.ok(after.every((x) => x.used - x.expected > -0.12), "without falling far behind again");
  assert.ok(trace.every((x) => x.used <= 0.97), "never past the stop line");
  assert.ok(trace.at(-1).used >= 0.9, `the week ends nearly used (${trace.at(-1).used})`);
  const days = readHistory(dir);
  assert.equal(days.length, 7);
  assert.equal(days[1].status, "behind"); assert.notEqual(days[6].status, "behind");
  assert.ok(days[5].gap > -0.08 && days[1].gap < -0.2, "from far behind to about even");
  assert.ok(lessons.includes(CAUSES["not-running"]), "the quiet days became a lesson");
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("constance-week: tests passed");
