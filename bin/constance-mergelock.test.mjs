// Constance's merge lock: an old lock with a live holder is never taken over
// (a self-merge holds it through a whole suite), a dead holder's lock is, the
// lock is only removed by its owner, and real processes racing for it never
// interleave. Everything lives in a mkdtemp folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { withLock, staleReason, STALE_NO_OWNER_MS } from "./constance-mergelock.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-lock-"));
const MOD = new URL("./constance-mergelock.mjs", import.meta.url).pathname;
const hourAgo = new Date(Date.now() - 3600000);
const fakeLock = (name, owner) => {
  const lock = path.join(root, name);
  fs.mkdirSync(lock);
  if (owner !== undefined) fs.writeFileSync(path.join(lock, "owner"), String(owner));
  fs.utimesSync(lock, hourAgo, hourAgo);
  return lock;
};

// A free lock: fn runs with the lock held and its value comes back; the lock is gone after.
{
  const lock = path.join(root, "free");
  const v = withLock(lock, () => { assert.equal(fs.readFileSync(path.join(lock, "owner"), "utf8"), String(process.pid)); return 42; });
  assert.equal(v, 42);
  assert.equal(fs.existsSync(lock), false, "released");
  assert.throws(() => withLock(lock, () => { throw new Error("boom"); }), /boom/);
  assert.equal(fs.existsSync(lock), false, "released after a throw too");
}

// An hour-old lock whose holder is alive is still held: wait, then give up, never steal.
{
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  const lock = fakeLock("live", sleeper.pid);
  assert.equal(staleReason(lock), "", "a live holder is never stale, however old");
  let ran = false;
  assert.throws(() => withLock(lock, () => { ran = true; }, { waitMs: 300 }), /another merge is still running/);
  assert.equal(ran, false);
  assert.equal(fs.readFileSync(path.join(lock, "owner"), "utf8"), String(sleeper.pid), "the holder's lock is untouched");
  sleeper.kill();
}

// A dead holder's lock is taken over at once.
{
  const dead = spawnSync(process.execPath, ["-e", "process.pid"]).pid;
  const lock = fakeLock("dead", dead);
  assert.match(staleReason(lock), /is gone/);
  assert.equal(withLock(lock, () => "took it", { waitMs: 0 }), "took it");
  assert.equal(fs.existsSync(lock), false);
}

// No owner file: stale only once it is older than STALE_NO_OWNER_MS.
{
  const old = fakeLock("noowner-old");
  assert.equal(staleReason(old), "no holder recorded");
  assert.equal(withLock(old, () => 1, { waitMs: 0 }), 1);
  const fresh = path.join(root, "noowner-fresh");
  fs.mkdirSync(fresh);
  assert.equal(staleReason(fresh), "", "a lock being created right now is held");
  assert.equal(staleReason(fresh, { now: Date.now() + STALE_NO_OWNER_MS + 1000 }), "no holder recorded");
  assert.throws(() => withLock(fresh, () => 1, { waitMs: 100 }), /still running/);
}

// Only the owner removes the lock: if someone else holds it by the end, it stays.
{
  const lock = path.join(root, "handover");
  withLock(lock, () => fs.writeFileSync(path.join(lock, "owner"), "999999"));
  assert.equal(fs.existsSync(lock), true, "a lock that changed hands is not removed");
}

// Real processes racing: each does a slow read-modify-write under the lock; none is lost.
{
  const lock = path.join(root, "race");
  const counter = path.join(root, "counter");
  fs.writeFileSync(counter, "0");
  const N = 6;
  const code = `import fs from "node:fs"; import { withLock } from ${JSON.stringify(MOD)};
withLock(${JSON.stringify(lock)}, () => {
  const n = Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8"));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
  fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
}, { waitMs: 30000 });`;
  const kids = Array.from({ length: N }, () => spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "inherit" }));
  const codes = await Promise.all(kids.map((k) => new Promise((r) => k.on("exit", r))));
  assert.deepEqual(codes, Array(N).fill(0));
  assert.equal(fs.readFileSync(counter, "utf8"), String(N), "every holder's change survived");
  assert.equal(fs.existsSync(lock), false);
}

fs.rmSync(root, { recursive: true, force: true });
console.log("constance-mergelock: tests passed");
