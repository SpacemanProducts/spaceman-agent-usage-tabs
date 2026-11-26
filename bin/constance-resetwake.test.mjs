// Reset-wake: the session-reset detector, the wake decision (queue starts at 03:00, never
// over a pause or a wall), the last-24-hours lane count, the once-a-day log and the behind
// lessons — all in a mktemp state dir.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionReset, wakeDecision, finalLanes, logDay, behindLessons } from "./constance-resetwake.mjs";
import { readHistory, CAUSES, curve, longWindow, laneCount, DAY, HOUR } from "./constance-week.mjs";

const iso = (t) => new Date(t).toISOString();
const sess = (percent, resetsAt) => ({ title: "Session", percent, resetsAt: iso(resetsAt) });
const wk = (percent, resetsAt) => ({ title: "Weekly", percent, resetsAt: iso(resetsAt) });
const queue = (over = {}) => ({ goals: [{ id: "g1", text: "a goal", dir: "/p" }], paused: "", ownerPaused: false, ...over });

// ---- sessionReset: the window's resetsAt passed
{
  const resetAt = new Date(2026, 10, 26, 3, 0).getTime();       // 03:00, middle of the night
  const now = resetAt + 10 * 60e3;
  const prev = [sess(0.92, resetAt), wk(0.4, now + 4 * DAY)];
  const cur = [sess(0.04, resetAt + 5 * HOUR), wk(0.4, now + 4 * DAY)];
  assert.equal(sessionReset(prev, cur, now), true, "resetsAt passed");
  // A stale reading still showing the old reset time counts too.
  assert.equal(sessionReset(prev, prev, now), true);
  // Mid-window, nothing changed.
  const mid = resetAt - 2 * HOUR;
  assert.equal(sessionReset([sess(0.5, resetAt)], [sess(0.55, resetAt)], mid), false);
  // Same window, jittered resetsAt: not a reset even when the reading dips.
  assert.equal(sessionReset([sess(0.9, mid + 3 * HOUR)], [sess(0.1, mid + 3 * HOUR + 60e3)], mid), false);
  // High to low with a genuinely new resetsAt: a reset even before the old time passed.
  assert.equal(sessionReset([sess(0.9, mid + 3 * HOUR)], [sess(0.1, mid + 8 * HOUR)], mid), true);
  // No session window, no reset.
  assert.equal(sessionReset([wk(0.5, now + DAY)], [wk(0.4, now + DAY)], now), false);
}

// ---- wakeDecision: a 03:00 session reset starts the queue by itself
{
  const resetAt = new Date(2026, 10, 26, 3, 0).getTime();
  const now = resetAt + 10 * 60e3;
  const prev = [sess(0.95, resetAt), wk(0.5, now + 3 * DAY)];
  const cur = [sess(0.03, resetAt + 5 * HOUR), wk(0.5, now + 3 * DAY)];
  assert.deepEqual(wakeDecision({ queue: queue(), goalRunning: false, prevLimits: prev, limits: cur, now }),
    { start: true, why: "the session window reset" });
  const d = (over = {}, limits = cur) => wakeDecision({ queue: queue(), goalRunning: false, prevLimits: prev, limits, now, ...over });
  assert.equal(d({ queue: queue({ ownerPaused: true }) }).start, false, "ownerPaused never starts");
  assert.equal(d({ queue: queue({ paused: "needs you" }) }).start, false);
  assert.equal(d({ goalRunning: true }).start, false);
  assert.equal(d({ queue: queue({ goals: [] }) }).start, false);
  assert.equal(d({}, [sess(0.03, resetAt + 5 * HOUR), wk(1.0, now + 3 * DAY)]).start, false, "a limit at 100%");
  assert.equal(d({ wall: { until: now + HOUR } }).start, false, "a wall pending");
  assert.equal(d({ wall: now - HOUR }).start, true, "an expired wall doesn't block");
  assert.equal(d({ prevLimits: [sess(0.9, now + 4 * HOUR)], limits: [sess(0.5, now + 4 * HOUR)] }).start, false, "no reset, no start");
}

// ---- logDay + behindLessons: a synthetic week that starts behind and catches up by day 6
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-resetwake-"));
  const start = new Date(2026, 10, 23, 0).getTime(), weekEnd = start + 7 * DAY;
  // Day 2 sits at 5% used against ~36% expected: behind. She catches up by day 6.
  const usedByDay = [0.01, 0.02, 0.05, 0.28, 0.48, 0.70, 0.92];
  const lessons = [];
  const expected = [];
  for (let day = 0; day < 7; day++) {
    const t = start + day * DAY + 12 * HOUR;
    const limits = [sess(0.1, t + 3 * HOUR), wk(usedByDay[day], weekEnd)];
    const c = curve(longWindow(limits, t), t);
    const causes = c.status === "behind" ? ["not-running"] : [];
    lessons.push(...logDay(dir, { limits, causes, lead: "claude", now: t }).lessons);
    // Once per calendar day: a second call the same day adds no record but does refresh
    // the day's reading, so the stored curve is the later one.
    const c2 = curve(longWindow(limits, t + HOUR), t + HOUR);
    expected.push(c2.expected);
    logDay(dir, { limits, causes: ["paused"], now: t + HOUR });
  }
  const days = readHistory(dir);
  assert.equal(days.length, 7, "one record per day");
  days.forEach((d, i) => {
    assert.ok(Math.abs(d.expected - expected[i]) < 0.001, `day ${i} logged against the curve`);
    assert.equal(d.used, usedByDay[i]);
  });
  assert.equal(days[2].used, 0.05);
  assert.equal(days[2].status, "behind", "day 2 is behind");
  assert.equal(days[5].status, "behind");
  assert.notEqual(days[6].status, "behind", "caught up by day 6");
  assert.deepEqual(days[6].causes, ["paused"], "a second same-day call merges causes into the one record");
  assert.ok(days[2].causes.includes("not-running"));
  assert.ok(lessons.includes(CAUSES["not-running"]), "the quiet days became a lesson");
  const behind = behindLessons(days);
  assert.ok(behind.length >= 1 && behind.length <= 3);
  assert.ok(behind.includes(CAUSES["not-running"]));
  assert.deepEqual(behindLessons([]), []);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- finalLanes: the last 24 hours opens more lanes than a normal behind stretch — with room
{
  const now = new Date(2026, 10, 26, 12).getTime();
  const final = [sess(0.05, now + 3 * HOUR), wk(0.6, now + 20 * HOUR)];   // 20 h left, 40% room
  const normal = [sess(0.05, now + 3 * HOUR), wk(0.2, now + 4 * DAY)];    // behind, not final
  const f = finalLanes({ limits: final, openItems: 30, now });
  const n = laneCount({ c: curve(longWindow(normal, now), now), limits: normal, openItems: 30, now });
  assert.ok(f.lanes > n.lanes, `final ${f.lanes} > normal ${n.lanes}`);
  assert.equal(f.why, "last 24 hours");
  // No room: 95% used with 20 h left is not a substantial remainder.
  const spent = [sess(0.05, now + 3 * HOUR), wk(0.95, now + 20 * HOUR)];
  assert.equal(finalLanes({ limits: spent, openItems: 30, now }).lanes, 0);
  // A hot session caps it even in the final stretch.
  const hot = [sess(0.9, now + 3 * HOUR), wk(0.6, now + 20 * HOUR)];
  assert.equal(finalLanes({ limits: hot, openItems: 30, now }).lanes, 0);
}

console.log("constance-resetwake: tests passed");
