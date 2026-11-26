// Stuck detection rules (constance-stuck.mjs): twice the scorecard's usual time, or 15 minutes
// with no file change and no log output; the activity fingerprint moves on edits and log output.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { stuckCheck, expectedMs, activitySignature, observe, dueForCheck, IDLE_MS, MIN_EXPECTED_MS } from "./constance-stuck.mjs";

const MIN = 60e3, now = 1_000_000_000_000;
const job = (over = {}) => ({ id: 1, status: "running", startedAt: now - 10 * MIN, ...over });

// expectedMs: the scorecard average, floored; null without a timed job.
assert.equal(expectedMs(null), null);
assert.equal(expectedMs({ avgMs: null }), null);
assert.equal(expectedMs({ avgMs: 0 }), null);
assert.equal(expectedMs({ avgMs: 20 * MIN }), 20 * MIN);
assert.equal(expectedMs({ avgMs: 1 * MIN }), MIN_EXPECTED_MS, "one quick job doesn't make every job look stuck");
assert.equal(IDLE_MS, 15 * MIN);

// Twice the expected time.
assert.equal(stuckCheck(job(), { now, expected: 6 * MIN, activityAt: now }).stuck, false, "10 min of a 6 min job is fine");
{
  const r = stuckCheck(job({ startedAt: now - 13 * MIN }), { now, expected: 6 * MIN, activityAt: now });
  assert.equal(r.stuck, true); assert.equal(r.kind, "slow"); assert.match(r.reason, /twice its usual 6 min/);
}
// No activity for 15 minutes (with or without a scorecard).
{
  const r = stuckCheck(job({ startedAt: now - 40 * MIN }), { now, activityAt: now - 15 * MIN });
  assert.equal(r.stuck, true); assert.equal(r.kind, "idle"); assert.match(r.reason, /no file changes and no log output for 15 min/);
}
assert.equal(stuckCheck(job({ startedAt: now - 40 * MIN }), { now, activityAt: now - 14 * MIN }).stuck, false, "activity 14 min ago");
assert.equal(stuckCheck(job({ startedAt: now - 14 * MIN }), { now, activityAt: 0 }).stuck, false, "no activity record yet: counts from the start");
assert.equal(stuckCheck(job({ startedAt: now - 16 * MIN }), { now, activityAt: 0 }).stuck, true);
assert.equal(stuckCheck(job({ startedAt: now - 2000 }), { now, activityAt: 0, idleMs: 1000 }).stuck, true, "idle window is adjustable");
// Only running jobs with a start.
for (const j of [null, job({ status: "finished", startedAt: now - 99 * MIN }), job({ startedAt: 0 }), job({ status: "waiting" })])
  assert.equal(stuckCheck(j, { now }).stuck, false);
assert.match(stuckCheck(job({ startedAt: now - 130 * MIN }), { now, expected: 60 * MIN, activityAt: now }).reason, /running 2 h 10 min/);

// observe / dueForCheck.
{
  const a = observe(null, "x", 100);
  assert.deepEqual(a, { sig: "x", at: 100, checkedAt: 100 });
  const b = observe(a, "x", 200); assert.deepEqual(b, { sig: "x", at: 100, checkedAt: 200 }, "same signature: activity time stays");
  const c = observe(b, "y", 300); assert.deepEqual(c, { sig: "y", at: 300, checkedAt: 300 });
  assert.equal(dueForCheck(null, 0), true);
  assert.equal(dueForCheck(c, 300 + 29e3), false);
  assert.equal(dueForCheck(c, 300 + 30e3), true);
}

// activitySignature: moves on a new file, an edit, a commit and log output; ignores .constance/.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-stuck-"));
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-qm", "init");
  const log = path.join(dir, "..", path.basename(dir) + ".log"); fs.writeFileSync(log, "");
  const s0 = activitySignature(dir, log);
  assert.equal(activitySignature(dir, log), s0, "stable when nothing happens");
  fs.mkdirSync(path.join(dir, ".constance")); fs.writeFileSync(path.join(dir, ".constance/done-1.json"), "{}");
  assert.equal(activitySignature(dir, log), s0, ".constance/ doesn't count");
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
  const s1 = activitySignature(dir, log); assert.notEqual(s1, s0, "new file");
  fs.utimesSync(path.join(dir, "b.txt"), new Date(), new Date(Date.now() + 5000));
  const s2 = activitySignature(dir, log); assert.notEqual(s2, s1, "edited again");
  fs.appendFileSync(log, "thinking...\n");
  const s3 = activitySignature(dir, log); assert.notEqual(s3, s2, "log output");
  git("add", "b.txt"); git("commit", "-qm", "b");
  assert.notEqual(activitySignature(dir, log), s3, "a commit");
  assert.equal(typeof activitySignature(path.join(dir, "missing")), "string", "unreadable folder: no crash");
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(log, { force: true });
}
console.log("constance-stuck: ok");
