import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pace, canResume, windowPace, keepGoingFile, STOP_AT, NEAR_END_AT } from "./constance-pace.mjs";
import { writeWall, wallFile } from "./constance-wall.mjs";
const now = Date.UTC(2026, 10, 23, 12);
const H = 3600e3, D = 24 * H;
// An empty state dir for the Keep-going file: pace() reads it, and the tests must never see
// (or leave) the real one.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-pace-"));
const P = (c, t = now) => pace(c, t, dir);
const claude = (s, sLeft, w, wLeft) => ({ limits: [
  { title: "Session", percent: s, resetsAt: new Date(now + sLeft).toISOString() },
  { title: "Weekly", percent: w, resetsAt: new Date(now + wLeft).toISOString() }] });
// Session is 5 h: the last 20% (1 h) counts as "reset is close". Weekly is 7 d: the last
// 20% (33.6 h) counts.

assert.equal(P(claude(0.2, 2.5 * H, 0.3, 4 * D)).mode, "normal", "on pace: 20% of the session with half of it gone");
assert.equal(P(claude(0.5, 4 * H, 0.3, 4 * D)).mode, "delegate", "50% of the session with 20% of it gone: too fast");
assert.equal(P(claude(0.1, 4.5 * H, 0.6, 5 * D)).mode, "delegate", "a busy week: 60% used, 2 of 7 days gone");
assert.equal(P(claude(0.75, 0.5 * H, 0.3, 4 * D)).mode, "delegate", "above 70% always leans on the free agents");
assert.equal(P(claude(0.05, 4.9 * H, 0.1, 6.9 * D)).mode, "normal", "a fresh window's tiny use isn't 'too fast'");

// Far from the reset the 90% pause stands.
const stop = P(claude(STOP_AT, 3 * H, 0.3, 6 * D));
assert.equal(stop.mode, "stop", "at 90% with hours left she stops before running out");
assert.equal(stop.until, now + 3 * H, "and says when she can go again");
assert.equal(stop.title, "Session", "and which window paused her");
assert.equal(P(claude(0.2, 4 * H, 0.95, 6 * D)).mode, "stop", "the weekly limit counts the same way");

// Near the reset (last 20% of the window) the pause moves to 97%: between 90% and 97% she
// keeps planning, review and merges and delegates the rest.
assert.equal(P(claude(0.92, 0.5 * H, 0.3, 4 * D)).mode, "delegate", "reset in 30 min: 92% keeps her on review and planning");
assert.equal(P(claude(0.92, H, 0.3, 4 * D)).mode, "delegate", "exactly the last fifth still counts as close");
assert.equal(P(claude(STOP_AT, 1.5 * H, 0.3, 4 * D)).mode, "stop", "just past the close mark the 90% pause is back");
const nearEnd = P(claude(NEAR_END_AT, 0.5 * H, 0.3, 4 * D));
assert.equal(nearEnd.mode, "stop", "at 97% near the reset she stops so she never runs out");
assert.equal(nearEnd.until, now + 0.5 * H);
assert.equal(P(claude(0.99, 0.5 * H, 0.3, 4 * D)).mode, "stop", "over 97% near the reset still stops");
assert.equal(P(claude(0.2, 4 * H, 0.93, 30 * H)).mode, "delegate", "weekly reset in 30 h: 93% keeps delegate pace");
assert.equal(P(claude(0.2, 4 * H, 0.93, 60 * H)).mode, "stop", "weekly reset in 60 h: still the 90% pause");
assert.match(P(claude(0.92, 0.5 * H, 0.3, 4 * D)).reason, /reset is close/, "the reason says why she didn't stop");

// Keep going (the panel's button while she's paused): the file names the window that stopped
// her; while that same window — same title and same reset time — is still waiting, it can't
// pause her at all.
fs.writeFileSync(keepGoingFile(dir), JSON.stringify({ title: "Session", resetsAt: now + 3 * H, at: now }));
const kept = P(claude(0.95, 3 * H, 0.3, 6 * D));
assert.equal(kept.mode, "delegate", "Keep going: a far window at 95% stays on delegate pace");
assert.match(kept.reason, /Keep going/, "and the reason says the owner chose it");
assert.equal(P(claude(0.2, 4 * H, 0.95, 6 * D)).mode, "stop", "Keep going covers only the window it named");
assert.equal(P(claude(0.99, 3 * H, 0.3, 6 * D)).mode, "delegate", "even past 97% the owner's Keep going wins");
fs.writeFileSync(keepGoingFile(dir), JSON.stringify({ title: "Session", resetsAt: now + 4 * H, at: now }));
assert.equal(P(claude(0.95, 3 * H, 0.3, 6 * D)).mode, "stop", "a moved reset time is a different window: no match");
fs.writeFileSync(keepGoingFile(dir), JSON.stringify({ title: "Session", resetsAt: now - H, at: now - 2 * H }));
assert.equal(P(claude(0.95, 3 * H, 0.3, 6 * D)).mode, "stop", "an expired Keep going does nothing");
fs.writeFileSync(keepGoingFile(dir), JSON.stringify({ title: "Session", resetsAt: null, at: now }));
const noReset = { limits: [{ title: "Session", percent: 0.95, resetsAt: "" }, { title: "Weekly", percent: 0.1, resetsAt: new Date(now + 4 * D).toISOString() }] };
assert.equal(P(noReset).mode, "delegate", "Keep going with no known reset time still works");
assert.equal(P(noReset, now + 6 * H).mode, "stop", "but only for one window length");
// The 2026-11-24 bug: Keep going pressed while the Session sat at 100%. The real limit is hit, so
// Keep going can't resume her into it, and the stop says it's a hard one (the panel hides the button).
fs.writeFileSync(keepGoingFile(dir), JSON.stringify({ title: "Session", resetsAt: now + 3 * H, at: now }));
const wallHit = P(claude(1, 3 * H, 0.3, 6 * D));
assert.equal(wallHit.mode, "stop", "Keep going never overrides a limit at 100%");
assert.equal(wallHit.hard, true); assert.equal(wallHit.until, now + 3 * H);
assert.equal(P(claude(0.95, 3 * H, 0.3, 6 * D)).hard, undefined, "under 100% Keep going still works");
// The endpoint's resets_at jitters by fractions of a second between fetches: still the same window.
fs.writeFileSync(keepGoingFile(dir), JSON.stringify({ title: "Session", resetsAt: now + 3 * H + 254, at: now }));
assert.equal(P(claude(0.95, 3 * H, 0.3, 6 * D)).mode, "delegate", "sub-second jitter keeps the Keep going match");
fs.rmSync(keepGoingFile(dir));

// Claude's own "hit your limit" exit (wall.json) stops her until its stated time, even on a
// reading that looks fine or can't be read.
writeWall(dir, { until: now + 90 * 60e3, stated: true, text: "x" }, now);
const walled = P(claude(0.1, 3 * H, 0.1, 6 * D));
assert.equal(walled.mode, "stop", "a stale low reading can't resume her past Claude's own wall");
assert.equal(walled.until, now + 90 * 60e3); assert.equal(walled.hard, true);
assert.match(walled.reason, /hit its limit/);
assert.equal(P(null).mode, "stop", "even with no reading at all");
assert.equal(P(claude(0.1, 3 * H, 0.1, 6 * D), now + 90 * 60e3).mode, "normal", "after the stated time the readings decide again");
fs.rmSync(wallFile(dir));

assert.equal(P(null).mode, "delegate", "no reading: play it safe");
assert.equal(windowPace({ title: "Session", percent: 0.4, resetsAt: "" }, now).burn, null, "no reset time: no burn rate invented");
assert.equal(windowPace({ title: "Session", percent: 0.4, resetsAt: new Date(now + H).toISOString() }, now).nearReset, true, "the last fifth of the session is 'close'");
assert.equal(windowPace({ title: "Session", percent: 0.4, resetsAt: new Date(now + 2 * H).toISOString() }, now).nearReset, false);
assert.equal(windowPace({ title: "Monthly", percent: 0.4 }, now), null);
// Resuming a paused goal needs a current reading, never a cached or missing one.
const okRead = claude(0.3, 3 * H, 0.3, 6 * D);
assert.equal(canResume(P(okRead), okRead), true, "a current reading under the line resumes her");
const cached = { ...okRead, unsure: "Last reading from 4:02 PM; couldn't refresh." };
assert.equal(canResume(P(cached), cached), false, "a reading the collector couldn't refresh can't");
assert.equal(canResume(P({ limits: [] }), { limits: [] }), false, "no reading can't");
assert.equal(canResume(P(claude(1, 3 * H, 0.3, 6 * D)), claude(1, 3 * H, 0.3, 6 * D)), false, "a stop can't");
assert.equal(canResume({ mode: "delegate", reason: "Session at 95%: you chose Keep going, so she delegates" }, cached), true, "Keep going is the owner's call");
console.log("constance-pace: tests passed");
