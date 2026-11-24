import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isLimitHit, statedReset, limitWall, writeWall, readWall, wallFile, FALLBACK_WAIT_MS } from "./constance-wall.mjs";

// 2026-11-24 16:15 New York (21:15 UTC): the exit that failed the goal.
const now = Date.UTC(2026, 10, 24, 21, 15);
const exitText = "You've hit your 5-hour limit · resets 5:50pm (America/New_York)";
assert.ok(isLimitHit(exitText));
assert.ok(isLimitHit("Claude AI usage limit reached? You've hit your weekly limit · resets Nov 30, 5pm"));
assert.ok(!isLimitHit("Error: something else broke"));
assert.ok(!isLimitHit(""));

assert.equal(statedReset(exitText, now), Date.UTC(2026, 10, 24, 22, 50), "5:50pm New York is 22:50 UTC in November");
assert.equal(statedReset("resets 5pm (UTC)", now), Date.UTC(2026, 10, 25, 17), "a time already gone today means tomorrow");
assert.equal(statedReset("resets 9:05pm (UTC)", now), Date.UTC(2026, 10, 24, 21, 5) + 86400e3, "minutes count");
assert.equal(statedReset("resets 12am (UTC)", now), Date.UTC(2026, 10, 25, 0), "12am is midnight");
assert.equal(statedReset("resets 12pm (UTC)", now), Date.UTC(2026, 10, 25, 12), "12pm is noon");
assert.equal(statedReset("resets Nov 30, 5pm (America/New_York)", now), Date.UTC(2026, 10, 30, 22), "a stated date");
assert.equal(statedReset("resets Nov 26 at 9:30am (Europe/Berlin)", now), Date.UTC(2026, 10, 26, 8, 30), "'at' form, another zone");
assert.equal(statedReset("resets 13pm (UTC)", now), null, "nonsense time");
assert.equal(statedReset("resets Mar 3, 5pm (UTC)", now), null, "months away is not a session wall");
assert.equal(statedReset("no time here", now), null);
assert.ok(Number.isFinite(statedReset("resets 5:50pm (Not/AZone)", now)), "an unknown zone falls back to this machine's");
// DST: 2027-03-14 is the US spring-forward day. 3pm New York that day is 19:00 UTC.
assert.equal(statedReset("resets 3pm (America/New_York)", Date.UTC(2027, 2, 14, 12)), Date.UTC(2027, 2, 14, 19));

const w = limitWall("some output\n" + exitText + "\n", now);
assert.deepEqual(w, { until: Date.UTC(2026, 10, 24, 22, 50), stated: true, text: exitText });
const vague = limitWall("You've hit your limit.", now);
assert.equal(vague.stated, false); assert.equal(vague.until, now + FALLBACK_WAIT_MS, "no time stated: a short wait");
assert.equal(limitWall("Claude exited: network error", now), null, "other errors are not walls");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-wall-"));
assert.equal(readWall(dir, now), null, "no file, no wall");
writeWall(dir, w, now);
assert.equal(readWall(dir, now).until, w.until);
assert.equal(readWall(dir, w.until), null, "the wall falls at its time");
fs.writeFileSync(wallFile(dir), "{broken");
assert.equal(readWall(dir, now), null, "a broken file is no wall");
fs.rmSync(dir, { recursive: true });
console.log("constance-wall: tests passed");
