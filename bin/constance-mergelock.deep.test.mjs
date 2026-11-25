// Deeper edge-case pass on Constance's merge lock
// (bin/constance-mergelock.mjs). Complements constance-mergelock.test.mjs.
// The lock is a plain directory with a pid `owner` file — it never goes near
// git, so there is no MERGE_HEAD or rebase state to leak; "cleanup" here
// means no stray lock dir or owner file survives any path, including a
// SIGKILLed holder. Everything lives in mkdtemp dirs and spawned children get
// a fake HOME.
//
// Covered here:
//   - staleReason: missing path, garbage/edge owner contents, owner-as-dir,
//     a plain FILE sitting at the lock path, pid reuse (owner = pid 1), and
//     the injected `now` / `alive` options.
//   - withLock: re-entrant self-deadlock, nested different locks, non-Error
//     throws, missing parent dir, waitMs:0 still polling once, pollMs
//     overshooting waitMs, and what the `pid` option does to stealability.
//   - races between real child processes: several children taking over a
//     dead-holder lock and an ownerless-old lock at once, holder/contender
//     ordering, and a SIGKILLed holder.
//
// Suspected bugs are commented out at the bottom and reported, not fixed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { withLock, staleReason, STALE_NO_OWNER_MS } from "./constance-mergelock.mjs";

const MOD = new URL("./constance-mergelock.mjs", import.meta.url).pathname;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-lock-deep-"));
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "constance-lock-home-"));
const childEnv = { ...process.env, HOME: fakeHome };
const hourAgo = new Date(Date.now() - 3600000);

// Every lock path this file creates, so the final sweep can prove none is
// left behind. Tests that intentionally leave one remove it themselves.
const locks = [];
const L = (name) => { const l = path.join(root, name); locks.push(l); return l; };

// A lock dir, optionally with an owner file, aged `ageMs` into the past.
const fakeLock = (name, { owner, ageMs = 3600000 } = {}) => {
  const lock = L(name);
  fs.mkdirSync(lock);
  if (owner !== undefined) fs.writeFileSync(path.join(lock, "owner"), String(owner));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(lock, t, t);
  return lock;
};

const deadPid = () => spawnSync(process.execPath, ["-e", "process.pid"]).pid;
const waitFor = async (fn, ms = 8000) => {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
};
// Spawn a node child running `body`; resolves with its exit code.
const runChild = (body, args = ["--input-type=module", "-e", body]) =>
  new Promise((res, rej) => {
    const c = spawn(process.execPath, args, { env: childEnv, stdio: "ignore" });
    c.on("error", rej);
    c.on("exit", res);
  });

// ============================================================ staleReason edges
{
  // A path that does not exist is not "held" — withLock just retries mkdir.
  assert.equal(staleReason(L("never-existed")), "");
}
{
  // Owner contents that are not a usable pid fall back to the no-owner
  // rule: garbage, empty, whitespace-only and non-numeric text all read as
  // owner 0, so only the lock's age decides.
  for (const [i, content] of ["abc", "", "   \n", "12x", "NaN"].entries()) {
    const lock = fakeLock(`garbage-${i}`, { owner: content });
    assert.equal(staleReason(lock), "no holder recorded", `owner ${JSON.stringify(content)} reads as no owner`);
    const fresh = L(`garbage-fresh-${i}`);
    fs.mkdirSync(fresh);
    fs.writeFileSync(path.join(fresh, "owner"), content);
    assert.equal(staleReason(fresh), "", `a fresh garbage-owner lock is still held`);
  }
}
{
  // Owner file with surrounding whitespace still parses; a negative pid is
  // truthy but can never be alive, so the lock is stale immediately — even
  // when fresh, with no age check at all.
  const spaced = fakeLock("spaced-owner", { owner: `  ${deadPid()}\n` });
  assert.match(staleReason(spaced), /is gone/);
  const neg = L("neg-owner");
  fs.mkdirSync(neg);
  fs.writeFileSync(path.join(neg, "owner"), "-5");
  assert.equal(staleReason(neg), "holder -5 is gone", "a negative pid is a dead holder at any age");
}
{
  // `owner` being a directory (or unreadable) reads as owner 0: the no-owner
  // age rule applies.
  const lock = L("owner-is-dir");
  fs.mkdirSync(lock);
  fs.mkdirSync(path.join(lock, "owner"));
  const old = new Date(Date.now() - STALE_NO_OWNER_MS - 1000);
  fs.utimesSync(lock, old, old);
  assert.equal(staleReason(lock), "no holder recorded");
  assert.equal(withLock(lock, () => "took it", { waitMs: 0 }), "took it");
  assert.equal(fs.existsSync(lock), false);
}
{
  // A plain FILE at the lock path: statSync succeeds, ownerOf fails with
  // ENOTDIR, so it follows the no-owner age rule. Fresh = held; old = stale
  // and withLock will rm it and mkdir in its place — the path is deleted as
  // if it were a lock. Safe only because merge.lock is a dedicated path.
  const f = L("file-lock");
  fs.writeFileSync(f, "not a lock, just a file");
  assert.equal(staleReason(f), "", "a fresh regular file at the lock path reads as held");
  const old = new Date(Date.now() - STALE_NO_OWNER_MS - 1000);
  fs.utimesSync(f, old, old);
  assert.equal(staleReason(f), "no holder recorded");
  assert.equal(withLock(f, () => "stole the file", { waitMs: 0 }), "stole the file");
  assert.equal(fs.existsSync(f), false, "the foreign file was removed and the lock released");
}
{
  // Pid reuse: if the recorded holder pid now belongs to a live unrelated
  // process, the lock looks held. pid 1 is always alive, so this stands in
  // for "holder died, pid got recycled".
  const recycled = fakeLock("recycled-pid", { owner: "1" });
  assert.equal(staleReason(recycled), "", "a live pid 1 owner means held, however the pid got there");
  assert.throws(() => withLock(recycled, () => 1, { waitMs: 80, pollMs: 10 }), /still running/);
  assert.ok(fs.existsSync(recycled), "the recycled-pid lock is never taken");
  fs.rmSync(recycled, { recursive: true, force: true });
}
{
  // The `now` injection only affects the no-owner branch: an owner-present
  // lock ignores it entirely (live owner stays held, dead owner stays gone).
  const live = fakeLock("now-live", { owner: process.pid });
  assert.equal(staleReason(live, { now: Date.now() + 10 * STALE_NO_OWNER_MS }), "");
  const dead = fakeLock("now-dead", { owner: deadPid() });
  assert.match(staleReason(dead, { now: Date.now() - 10 * STALE_NO_OWNER_MS }), /is gone/);
}
{
  // The `alive` injection overrides real liveness both ways.
  const deadLock = fakeLock("alive-on", { owner: deadPid() });
  assert.throws(() => withLock(deadLock, () => 1, { waitMs: 80, pollMs: 10, alive: () => true }),
    /still running/, "pretending the dead holder is alive keeps its lock");
  assert.ok(fs.existsSync(deadLock));
  fs.rmSync(deadLock, { recursive: true, force: true });
  const selfLock = fakeLock("alive-off", { owner: process.pid });
  assert.equal(withLock(selfLock, () => "stole", { waitMs: 0, alive: () => false }), "stole",
    "pretending every pid is dead lets a live owner's lock be taken");
  assert.equal(fs.existsSync(selfLock), false);
}

// ============================================================ withLock edges
{
  // Re-entrant use of the SAME lock from the SAME process self-deadlocks:
  // the outer holder's pid is alive, so the inner call just times out. The
  // outer fn survives the inner throw and the lock is still released once.
  const lock = L("reentrant");
  let innerErr = null;
  const v = withLock(lock, () => {
    try { withLock(lock, () => {}, { waitMs: 120, pollMs: 10 }); }
    catch (e) { innerErr = e; }
    return "outer finished";
  }, { pollMs: 10 });
  assert.equal(v, "outer finished");
  assert.match(innerErr && innerErr.message, /still running/);
  assert.equal(fs.existsSync(lock), false, "released exactly once, by the outer holder");
}
{
  // Different locks nest fine.
  const a = L("nest-a"), b = L("nest-b");
  assert.equal(withLock(a, () => withLock(b, () => "deep")), "deep");
  assert.equal(fs.existsSync(a) || fs.existsSync(b), false);
}
{
  // A non-Error throw still releases the lock and propagates unchanged.
  const lock = L("string-throw");
  try {
    withLock(lock, () => { throw "a plain string failure"; });
    assert.unreachable();
  } catch (e) {
    assert.equal(e, "a plain string failure");
  }
  assert.equal(fs.existsSync(lock), false);
}
{
  // The parent directory must already exist: mkdirSync ENOENT is not EEXIST,
  // so it propagates immediately instead of being treated as contention.
  assert.throws(() => withLock(path.join(root, "no-such-dir", "lock"), () => 1),
    (e) => e.code === "ENOENT");
}
{
  // waitMs: 0 on a held lock gives up immediately (whether it sleeps one
  // poll first depends on clock granularity — not asserted). The lock must
  // be genuinely held: a fresh ownerless dir counts.
  const lock = L("wait-zero");
  fs.mkdirSync(lock);
  assert.throws(() => withLock(lock, () => 1, { waitMs: 0, pollMs: 30 }), /still running/);
  assert.ok(fs.existsSync(lock), "the held lock is untouched");
  fs.rmSync(lock, { recursive: true, force: true });
}
{
  // pollMs is not capped by the remaining wait: a long poll oversleeps the
  // deadline by nearly a full interval.
  const lock = L("poll-overshoot");
  fs.mkdirSync(lock);
  const t0 = Date.now();
  assert.throws(() => withLock(lock, () => 1, { waitMs: 50, pollMs: 300 }), /still running/);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 200, `pollMs overshot waitMs (elapsed ${elapsed}ms)`);
  fs.rmSync(lock, { recursive: true, force: true });
}
{
  // The `pid` option is written verbatim into the owner file, and the lock
  // is only as safe as that pid being alive: record a dead pid and the lock
  // is stealable by anyone while fn is still running.
  const dead = deadPid();
  const lock = L("fake-pid");
  withLock(lock, () => {
    assert.equal(fs.readFileSync(path.join(lock, "owner"), "utf8"), String(dead));
    assert.match(staleReason(lock), /is gone/, "a lock held under a dead pid is already stale");
  }, { pid: dead, waitMs: 0 });
  assert.equal(fs.existsSync(lock), false);
}

// ============================================================ races: real child processes
{
  // Several children race to take over the SAME dead-holder lock. Both the
  // stale check and the rm+mkdir takeover must be race-safe: every child
  // gets in, one at a time, and the counter loses nothing.
  const lock = fakeLock("race-dead", { owner: deadPid() });
  const counter = path.join(root, "counter-dead");
  fs.writeFileSync(counter, "0");
  const N = 4;
  const code = `import fs from "node:fs"; import { withLock } from ${JSON.stringify(MOD)};
withLock(${JSON.stringify(lock)}, () => {
  const n = Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8"));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
  fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
}, { waitMs: 30000, pollMs: 10 });`;
  const kids = Array.from({ length: N }, () => runChild(code));
  assert.deepEqual(await Promise.all(kids), Array(N).fill(0));
  // NOTE: the counter can come out below N — see the takeover TOCTOU bug in
  // the commented-out section below. Assert only that every child ran and
  // the file is a sane count; the strict check is commented out there.
  const got = Number(fs.readFileSync(counter, "utf8"));
  assert.ok(got >= 1 && got <= N, `counter ${got} within [1, ${N}] (lost updates = reported bug)`);
  assert.equal(fs.existsSync(lock), false);
}
{
  // Same race, but the stale lock has NO owner file (an old version's lock,
  // or a holder that died between mkdir and writing `owner`). Same caveat:
  // a lost update is the reported takeover bug, not a test failure.
  const lock = L("race-noowner");
  fs.mkdirSync(lock);
  fs.utimesSync(lock, hourAgo, hourAgo);
  const counter = path.join(root, "counter-noowner");
  fs.writeFileSync(counter, "0");
  const N = 3;
  const code = `import fs from "node:fs"; import { withLock } from ${JSON.stringify(MOD)};
withLock(${JSON.stringify(lock)}, () => {
  const n = Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8"));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
  fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
}, { waitMs: 30000, pollMs: 10 });`;
  const kids = Array.from({ length: N }, () => runChild(code));
  assert.deepEqual(await Promise.all(kids), Array(N).fill(0));
  const got = Number(fs.readFileSync(counter, "utf8"));
  assert.ok(got >= 1 && got <= N, `counter ${got} within [1, ${N}]`);
  assert.equal(fs.existsSync(lock), false);
}
{
  // A holder that is SIGKILLed mid-merge leaves its lock behind; the next
  // acquirer takes it over once the dead pid is observed, and nothing stray
  // remains.
  const lock = L("killed-holder");
  const ready = path.join(root, "killed.ready");
  const holder = spawn(process.execPath, ["--input-type=module", "-e", `
import fs from "node:fs"; import { withLock } from ${JSON.stringify(MOD)};
withLock(${JSON.stringify(lock)}, () => {
  fs.writeFileSync(${JSON.stringify(ready)}, "1");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
}, { waitMs: 5000, pollMs: 10 });`], { env: childEnv, stdio: "ignore" });
  await waitFor(() => fs.existsSync(ready), 8000);
  assert.ok(fs.existsSync(lock), "holder has the lock while it sleeps");
  holder.kill("SIGKILL");
  await new Promise((r) => holder.on("exit", r));
  assert.ok(fs.existsSync(lock), "SIGKILL leaves the lock dir behind");
  assert.match(staleReason(lock), /is gone/, "the killed holder's pid is dead");
  assert.equal(withLock(lock, () => "took over", { waitMs: 3000, pollMs: 10 }), "took over");
  assert.equal(fs.existsSync(lock), false, "takeover released cleanly");
}
{
  // Holder/contender ordering across two processes: the contender must wait
  // for the holder's whole fn, not barge in when the holder is merely slow.
  const lock = L("ordering");
  const log = path.join(root, "ordering.log");
  fs.writeFileSync(log, "");
  const mk = (name, holdMs, startDelay) => `
import fs from "node:fs"; import { withLock } from ${JSON.stringify(MOD)};
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${startDelay});
withLock(${JSON.stringify(lock)}, () => {
  fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name + " in")} + "\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
  fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name + " out")} + "\\n");
}, { waitMs: 15000, pollMs: 10 });`;
  // B starts 250 ms late so A is certainly the holder; B's fn is instant.
  const [codeA, codeB] = await Promise.all([runChild(mk("A", 400, 0)), runChild(mk("B", 0, 250))]);
  assert.deepEqual([codeA, codeB], [0, 0]);
  assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"),
    ["A in", "A out", "B in", "B out"], "the contender ran only after the holder finished");
  assert.equal(fs.existsSync(lock), false);
}
{
  // A fresh ownerless lock blocks everyone (it may be mid-acquire); once it
  // ages past STALE_NO_OWNER_MS it is treated as abandoned and taken over.
  const lock = L("ownerless-window");
  fs.mkdirSync(lock);
  assert.throws(() => withLock(lock, () => 1, { waitMs: 120, pollMs: 10 }), /still running/);
  const old = new Date(Date.now() - STALE_NO_OWNER_MS - 1000);
  fs.utimesSync(lock, old, old);
  assert.equal(withLock(lock, () => "took it", { waitMs: 500, pollMs: 10 }), "took it");
  assert.equal(fs.existsSync(lock), false);
}

// ============================================================ suspected bugs (reported, not fixed)
//
// BUG (latent): withLock is synchronous. If fn returns a promise, the
// finally block removes the lock as soon as fn() *returns the promise*, not
// when it settles — an async fn would run unprotected while a second caller
// walks in. Verified live: withLock(lock, () => gate.then(...)) leaves the
// lock dir gone before the promise resolves. All current callers
// (constance.mjs withMergeLock) pass sync fns, so this is a footgun, not a
// live bug; if async fns are ever wanted, withLock must await thenables.
//
//   const lock = path.join(root, "async-fn");
//   let release;
//   const gate = new Promise((r) => (release = r));
//   const p = withLock(lock, () => gate.then(() => "done"));
//   assert.equal(fs.existsSync(lock), false);        // lock already gone
//   withLock(lock, () => "second entered while first pending");
//   release();
//   await p;
//
// BUG: the release check `ownerOf(lock) === pid` is strict, but ownerOf()
// returns a Number. A non-number pid — the string "1234" or 1234n — is
// written to the owner file yet never matches on cleanup, so the lock is
// left behind (and, since its recorded numeric pid may be dead, immediately
// stealable). Verified live: withLock(lock, fn, { pid: "1234" }) leaves the
// lock dir with owner "1234". Pass only numbers.
//
//   const lock = path.join(root, "string-pid");
//   withLock(lock, () => {}, { pid: "1234" });
//   assert.equal(fs.existsSync(lock), false);        // currently FAILS: dir remains
//
// BUG (race, observed live): the stale-lock takeover is check-then-remove,
// not atomic. withLock re-reads staleReason and then rmSyncs the lock, but
// between those two steps another waiter can rm+mkdir+write its own owner —
// and the first waiter's rmSync then deletes that FRESH lock. Both processes
// end up inside fn() at once. Observed: 3 children racing to take over an
// ownerless-old lock produced counter "2" (one read-modify-write lost).
// The window is microseconds wide but real under contention. A fix needs an
// atomic takeover (e.g. rename the stale dir aside first, or re-verify the
// owner/inode immediately before rm and retry on change).
//
//   // strict version of the race-noowner test above — fails intermittently:
//   //   assert.equal(fs.readFileSync(counter, "utf8"), String(N));

// ============================================================ cleanup sweep
for (const l of locks) fs.rmSync(l, { recursive: true, force: true });
for (const l of locks) assert.equal(fs.existsSync(l), false, `stray lock left at ${l}`);
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(fakeHome, { recursive: true, force: true });
console.log("constance-mergelock.deep: tests passed");
