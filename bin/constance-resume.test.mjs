import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resumePlan, logAsk, askReport, RESUME_GRACE_MS } from "./constance-resume.mjs";
import { writeWall, readWall } from "./constance-wall.mjs";

// Fake clock: `now` is passed in, nothing reads the real one. 2026-11-24 21:15 UTC.
const now = Date.UTC(2026, 10, 24, 21, 15);
const until = Date.UTC(2026, 10, 24, 22, 50); // what statedReset gives for "resets 5:50pm (America/New_York)"
const wall = { until, stated: true, text: "You've hit your 5-hour limit · resets 5:50pm (America/New_York)", at: now };
const pausedByWall = { status: "paused", pauseReason: "Claude said it hit its limit; paused until 10:50 PM." };
const P = (over = {}) => resumePlan({ wall, now, goalStatus: pausedByWall, ...over });

// Not paused by the wall: nothing to plan, whatever the wall says.
assert.equal(P({ goalStatus: { status: "running" } }).action, "none");
assert.equal(P({ goalStatus: { status: "paused", pauseReason: "Session at 95%: paused until it resets." } }).action, "none", "a readings pause isn't the wall's");
assert.equal(P({ goalStatus: { status: "paused" } }).action, "none", "no reason, no wall pause");
assert.equal(P({ goalStatus: "paused" }).action, "none", "a bare status string can't prove the wall paused her");
assert.equal(P({ goalStatus: null }).action, "none");
assert.equal(P({ goalStatus: undefined }).action, "none");

// Paused by the wall with no usable reset time: never resume on a guess.
assert.equal(P({ wall: null }).action, "none");
assert.equal(P({ wall: {} }).action, "none");
assert.equal(P({ wall: { until: "soon" } }).action, "none");

// The time edges around until and until + 60 s.
assert.equal(P({ now: until - 1 }).action, "wait", "one ms before the reset still waits");
assert.equal(P({ now: until }).action, "wait", "at the reset time itself still waits");
const w = P({ now: until });
assert.equal(w.until, until + RESUME_GRACE_MS, "wait reports when she may go");
assert.match(w.why, /grace|60/, "the why mentions the grace");
assert.equal(P({ now: until + RESUME_GRACE_MS - 1 }).action, "wait", "one ms before the grace ends still waits");
const r = P({ now: until + RESUME_GRACE_MS });
assert.equal(r.action, "resume", "exactly at reset + 60 s she resumes");
assert.equal(r.until, until + RESUME_GRACE_MS);
assert.equal(P({ now: until + RESUME_GRACE_MS + 1 }).action, "resume", "past the grace she resumes");
assert.equal(P({ now: until + 3 * 3600e3 }).action, "resume", "a wall long past still resumes (the readings decide after)");
assert.equal(P({ now }).action, "wait", "mid-wall waits");

// wall.json round-trip: what writeWall stores is what resumePlan reads.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-resume-"));
writeWall(dir, { until, stated: true, text: "x" }, now);
assert.equal(readWall(dir, now).until, until);
const rw = P({ wall: readWall(dir, now) });
assert.equal(rw.action, "wait", "a live wall.json plans a wait");
assert.equal(P({ wall: readWall(dir, until + RESUME_GRACE_MS + 1), now: until + RESUME_GRACE_MS + 1 }).action, "none", "an expired wall.json reads as no wall: no resume");

// logAsk / askReport on a fake file — no real state dir, no network.
const asks = path.join(dir, "asks.jsonl");
assert.deepEqual(askReport(asks), { asked: 0, reasons: [] }, "no file, no asks");
logAsk(asks, { reason: "needs the owner to pick a design", at: now });
logAsk(asks, { reason: "a worker is stuck", at: now + 1000 });
logAsk(asks, { reason: "needs the owner to pick a design", at: now + 2000 });
logAsk(asks, { reason: "old ask", at: now - 5000 });
let rep = askReport(asks);
assert.equal(rep.asked, 4);
assert.deepEqual(rep.reasons, ["needs the owner to pick a design", "a worker is stuck", "needs the owner to pick a design", "old ask"]);
rep = askReport(asks, now);
assert.equal(rep.asked, 3, "sinceMs cuts the older ones");
assert.deepEqual(rep.reasons, ["needs the owner to pick a design", "a worker is stuck", "needs the owner to pick a design"]);
assert.equal(askReport(asks, now + 1e9).asked, 0, "a future sinceMs sees nothing");

// Defaults and junk: at defaults to now, missing reason is "", bad lines are skipped.
logAsk(asks, { reason: "no clock" });
assert.equal(askReport(asks).asked, 5);
fs.appendFileSync(asks, "{broken\n\"just a string\"\n{\"at\":\"x\"}\n");
assert.equal(askReport(asks).asked, 5, "unparseable and non-numeric lines don't count");
logAsk(path.join(dir, "nested", "deep", "asks.jsonl"), { reason: "r", at: 1 });
assert.equal(askReport(path.join(dir, "nested", "deep", "asks.jsonl")).asked, 1, "parent dirs are made");

fs.rmSync(dir, { recursive: true });
console.log("constance-resume: tests passed");

// Antigravity as her brain: its wall pause resumes the same way; other reasons still don't.
assert.equal(resumePlan({ wall: { until: 1000 }, now: 1000 + 61e3, goalStatus: { status: "paused", pauseReason: "Antigravity said it hit its limit; paused until 10:50 PM." } }).action, "resume");
assert.equal(resumePlan({ wall: { until: 1000 }, now: 1000 + 61e3, goalStatus: { status: "paused", pauseReason: "Grok said it hit its limit" } }).action, "none");
console.log("constance-resume: antigravity wall ok");
