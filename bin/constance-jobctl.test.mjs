import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { blockedReason, peek, jobDiff, pauseJob, resumeJob } from "./constance-jobctl.mjs";

// ---- blockedReason ---------------------------------------------------------
assert.equal(blockedReason(""), null);
assert.equal(blockedReason(null), null);
assert.equal(blockedReason("compiling...\n12 files changed\nall tests passed"), null, "normal output is not blocked");
assert.equal(blockedReason("Do you want to continue?\n"), "asking a question");
assert.equal(blockedReason("Continue? (y/n)"), "asking yes or no");
assert.equal(blockedReason("Overwrite the file? [Y/n]"), "asking yes or no");
assert.equal(blockedReason("Allow running `rm -rf build`?"), "asking for permission");
assert.equal(blockedReason("Press Enter to continue"), "waiting for a key press");
assert.equal(blockedReason("hit any key to exit"), "waiting for a key press");
assert.equal(blockedReason("the tool is waiting for input"), "waiting for input");
assert.equal(blockedReason("Enter your password:"), "asking for a credential");
assert.equal(blockedReason("type the api key below"), "asking for a credential");
assert.equal(blockedReason("Please log in to continue:"), "asking to log in");
assert.equal(blockedReason("Authentication required"), "asking to log in");
assert.equal(blockedReason("❯ 1. Yes\n  2. No"), "asking which option");
// A prompt that was answered earlier is pushed out of the tail by the output
// that followed it: only the last few lines count.
{
  const answered = [
    "Do you want to delete the temp files? (y/n)",
    "y",
    "deleted 3 files",
    "running tests",
    "12 passed",
    "0 failed",
    "done",
  ].join("\n");
  assert.equal(blockedReason(answered), null, "an answered prompt is not blocked");
  // But a live prompt at the very end still counts.
  assert.equal(blockedReason("running tests\nDo you want to retry? (y/n)"), "asking yes or no");
}

// ---- peek ------------------------------------------------------------------
{
  const ansi = "one\n\u001b[31mred\u001b[0m text\n\u001b[1;32mgreen\u001b[0m";
  assert.equal(peek(ansi), "one\nred text\ngreen", "ANSI escapes are stripped");

  const many = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(peek(many, { lines: 3 }), "line 27\nline 28\nline 29", "only the last `lines` lines");

  const long = Array.from({ length: 200 }, (_, i) => `output line ${i} with some words`).join("\n");
  const p = peek(long, { maxChars: 100 });
  assert.ok(p.length <= 100, `peek is capped (${p.length})`);
  assert.ok(p.endsWith("some words"), "the cap keeps the newest end");
  assert.ok(p.startsWith("…"), "the cap marks the cut");

  const secrets = [
    "key sk-abcdefghijklmnop1234 here",
    "token ghp_abcdefghij1234567890 end",
    "auth Bearer abcdef1234567890xyz end",
    "hex 0123456789abcdef0123456789abcdef01234567 tail",
    "b64 " + "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVoa2x0" + " tail",
  ].join("\n");
  const masked = peek(secrets);
  assert.doesNotMatch(masked, /sk-abcdefghijklmnop1234/);
  assert.doesNotMatch(masked, /ghp_abcdefghij1234567890/);
  assert.doesNotMatch(masked, /Bearer abcdef1234567890xyz/);
  assert.doesNotMatch(masked, /0123456789abcdef0123456789abcdef01234567/);
  assert.doesNotMatch(masked, /QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVoa2xt/);
  assert.match(masked, /sk-…/);
  assert.match(masked, /Bearer …/);
  // Ordinary words and short tokens are untouched.
  const plain = peek("the quick brown fox\nsk-123 short\nBearer tok");
  assert.match(plain, /the quick brown fox/);
  assert.match(plain, /sk-123 short/, "a short sk- token is not a secret");
}

// ---- jobDiff ---------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctl-git-"));
  const git = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  assert.equal(git("init", "-q").status, 0);
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  fs.mkdirSync(path.join(dir, ".constance"));
  fs.writeFileSync(path.join(dir, ".constance", "done-1.json"), "{}");
  assert.equal(git("add", "-A").status, 0);
  assert.equal(git("commit", "-qm", "init").status, 0);

  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  const d = jobDiff(dir, "HEAD");
  assert.equal(d.error, undefined);
  assert.match(d.stat, /a\.txt/, "the stat names the changed file");
  assert.match(d.patch, /\+two/, "the patch carries the new line");
  assert.equal(d.clipped, false);

  // A missing ref fails cleanly instead of throwing.
  const bad = jobDiff(dir, "no-such-ref");
  assert.equal(bad.patch, "");
  assert.equal(bad.clipped, false);
  assert.ok(bad.error, "a bad ref reports an error");

  // A huge diff is clipped.
  fs.writeFileSync(path.join(dir, "big.txt"), Array.from({ length: 500 }, (_, i) => `line ${i} ${"y".repeat(40)}`).join("\n") + "\n");
  git("add", "big.txt");
  git("commit", "-qm", "big");
  fs.writeFileSync(path.join(dir, "big.txt"), fs.readFileSync(path.join(dir, "big.txt"), "utf8") + "tail\n");
  const c = jobDiff(dir, "HEAD~1", { maxChars: 2000 });
  assert.equal(c.clipped, true, "an oversized diff is clipped");
  assert.ok(c.patch.length <= 2100, `clipped patch stays near the cap (${c.patch.length})`);

  fs.rmSync(dir, { recursive: true });
}

// ---- pauseJob / resumeJob --------------------------------------------------
{
  const calls = [];
  const kill = (pid, sig) => calls.push([pid, sig]);
  const job = { id: 7, status: "running", pid: 4321 };

  const p = pauseJob(job, { kill });
  assert.equal(p.paused, true);
  assert.equal(typeof p.pausedAt, "number");
  assert.deepEqual(calls, [[-4321, "SIGSTOP"]], "SIGSTOP goes to the process group (negative pid)");
  assert.equal(job.paused, undefined, "the job object is not mutated — the caller merges the fields");

  const r = resumeJob(job, { kill });
  assert.deepEqual(r, { paused: false });
  assert.deepEqual(calls[1], [-4321, "SIGCONT"], "SIGCONT goes to the same group");

  for (const bad of [
    null,
    { id: 1, status: "finished", pid: 5 },
    { id: 2, status: "waiting", pid: 5 },
    { id: 3, status: "running", pid: null },
    { id: 4, status: "running" },
    { id: 5, status: "running", pid: -2 },
  ]) {
    assert.throws(() => pauseJob(bad, { kill }), /not running|no pid|no such job/, `pauseJob refuses ${JSON.stringify(bad)}`);
    assert.throws(() => resumeJob(bad, { kill }), /not running|no pid|no such job/, `resumeJob refuses ${JSON.stringify(bad)}`);
  }
  assert.equal(calls.length, 2, "refused jobs never reach kill");
}

console.log("constance-jobctl: tests passed");
