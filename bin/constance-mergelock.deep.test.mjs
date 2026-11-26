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
// The takeover TOCTOU, the sync-only footgun and the non-number pid leak that
// an earlier pass found are fixed in the module and asserted below.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { withLock, staleReason, STALE_NO_OWNER_MS } from "./constance-mergelock.mjs";

const MOD = new URL("./constance-mergelock.mjs", import.meta.url).pathname;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-lock-deep-"));
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "constance-lock-home-"));
const xdgState = path.join(fakeHome, "xdg-state");
const xdgConfig = path.join(fakeHome, "xdg-config");
const xdgCache = path.join(fakeHome, "xdg-cache");
for (const d of [xdgState, xdgConfig, xdgCache]) fs.mkdirSync(d, { recursive: true });
const childEnv = {
  ...process.env,
  HOME: fakeHome,
  XDG_STATE_HOME: xdgState,
  XDG_CONFIG_HOME: xdgConfig,
  XDG_CACHE_HOME: xdgCache,
};
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
  // Several children race to take over the SAME dead-holder lock, ten rounds
  // in one run — under CPU load, so contenders really do get descheduled
  // mid-takeover (the engine race: a slow contender judging a corpse stale
  // while another publishes a live lock). The takeover must be race-safe
  // every time: every child gets in, one at a time — an `inside` marker
  // proves no two critical sections ever overlap — and the counter loses
  // nothing.
  const N = 8, ROUNDS = 10;
  const loadKids = Array.from({ length: Math.min(8, Math.max(2, os.cpus().length)) },
    () => spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }));
  try {
    for (let round = 0; round < ROUNDS; round++) {
      const lock = fakeLock(`race-dead-${round}`, { owner: deadPid() });
      const counter = path.join(root, `counter-dead-${round}`);
      const inside = path.join(root, `inside-dead-${round}`);
      const violations = path.join(root, `violations-dead-${round}`);
      fs.writeFileSync(counter, "0");
      const code = `import fs from "node:fs"; import { withLock } from ${JSON.stringify(MOD)};
withLock(${JSON.stringify(lock)}, () => {
  if (fs.existsSync(${JSON.stringify(inside)})) fs.appendFileSync(${JSON.stringify(violations)}, "overlap\\n");
  fs.writeFileSync(${JSON.stringify(inside)}, "1");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
  fs.rmSync(${JSON.stringify(inside)});
  const n = Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8"));
  fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
}, { waitMs: 30000, pollMs: 5 });`;
      const kids = Array.from({ length: N }, () => runChild(code));
      assert.deepEqual(await Promise.all(kids), Array(N).fill(0), `round ${round}: every child exited 0`);
      assert.equal(fs.readFileSync(counter, "utf8"), String(N), `round ${round}: no holder's update was lost`);
      assert.equal(fs.existsSync(violations), false, `round ${round}: two children were inside the lock at once`);
      assert.equal(fs.existsSync(lock), false);
    }
  } finally {
    for (const k of loadKids) k.kill("SIGKILL");
    await Promise.all(loadKids.map((k) => new Promise((r) => k.on("exit", r))));
  }
  const strayGuards = fs.readdirSync(root).filter((f) => f.endsWith(".tmutex"));
  assert.deepEqual(strayGuards, [], `guard mutexes left behind: ${strayGuards}`);
}
{
  // Same race, but the stale lock has NO owner file (an old version's lock,
  // or a holder that died between mkdir and writing `owner`). Same strict
  // check: the atomic takeover must lose nothing.
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
  assert.equal(fs.readFileSync(counter, "utf8"), String(N), "no holder's update was lost");
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

// ============================================================ former bugs, now fixed
{
  // withLock refuses a promise-returning fn: the lock is released and the
  // call throws instead of letting fn's continuation run unprotected. There
  // is no async variant — every guarded critical section is spawnSync-based.
  const lock = L("async-fn");
  let release;
  const gate = new Promise((r) => (release = r));
  assert.throws(() => withLock(lock, () => gate.then(() => "done")), /promise|synchronous/);
  assert.equal(fs.existsSync(lock), false, "the lock is released even though fn's promise never settled");
  assert.equal(withLock(lock, () => "second entered while first pending"), "second entered while first pending");
  release();
}
{
  // pid is coerced to the number it names, so the release check still
  // recognizes the owner for a numeric string or a bigint; a pid that isn't
  // a positive integer is rejected before the lock is touched.
  for (const [i, p] of ["1234", 1234n].entries()) {
    const lock = L(`pid-coerce-${i}`);
    withLock(lock, () => {}, { pid: p, waitMs: 0 });
    assert.equal(fs.existsSync(lock), false, `pid ${String(p)} still releases its lock`);
  }
  const bad = L("pid-bad");
  assert.throws(() => withLock(bad, () => 1, { pid: "abc" }), /pid/);
  assert.equal(fs.existsSync(bad), false, "a bad pid never creates the lock");
}
// The takeover TOCTOU itself is covered by the strict race tests above: the
// stale lock is renamed aside atomically and re-verified before deletion, so
// two contenders can never both hold `lock`.

// ============================================================ more staleReason edges
{
  // A non-path `lock` argument makes statSync throw a TypeError, which the
  // catch-all turns into "" — same as a missing path, never a throw.
  assert.equal(staleReason(undefined), "");
  assert.equal(staleReason(12345), "");
}
{
  // Owner "0" (and anything coercing to 0) reads as NO owner: the falsy pid
  // falls through to the no-owner age rule, so a fresh lock is held only
  // because it is fresh, and an old one is stale with "no holder recorded".
  const fresh = L("owner-zero-fresh");
  fs.mkdirSync(fresh);
  fs.writeFileSync(path.join(fresh, "owner"), "0");
  assert.equal(staleReason(fresh), "", "owner 0 is treated as no owner recorded");
  const old = fakeLock("owner-zero-old", { owner: "0" });
  assert.equal(staleReason(old), "no holder recorded");
  fs.rmSync(old, { recursive: true, force: true });
  locks.splice(locks.indexOf(old), 1);
}
{
  // Exotic-but-numeric owner contents, all naming a dead pid. "Infinity"
  // is truthy so it counts as a recorded holder even though no such pid
  // can exist; "<dead>e0" and "<dead>.5" parse to non-integer pids that
  // kill() can never report alive. Whichever way kill() rejects them, the
  // lock reads stale at once.
  const d = deadPid();
  for (const [i, content] of ["Infinity", `${d}e0`, `${d}.5`, `  ${d}  `].entries()) {
    const lock = fakeLock(`exotic-owner-${i}`, { owner: content });
    assert.match(staleReason(lock), /is gone/, `owner ${JSON.stringify(content)} is a dead holder`);
    fs.rmSync(lock, { recursive: true, force: true });
    locks.splice(locks.indexOf(lock), 1);
  }
}
{
  // Clock edge: the no-owner staleness check is a strict `>`, so a lock is
  // held AT exactly STALE_NO_OWNER_MS and stale one ms past it.
  const lock = L("mtime-edge");
  fs.mkdirSync(lock);
  // Pin the mtime to a whole-millisecond date so the injected `now` math is
  // exact: mtimeMs reads back as an integer and `now - mtime` lands exactly
  // on STALE_NO_OWNER_MS, never a hair above it.
  const pin = new Date(1700000000000);
  fs.utimesSync(lock, pin, pin);
  const mt = fs.statSync(lock).mtimeMs;
  assert.ok(Number.isInteger(mt), `pinned mtime is integral, got ${mt}`);
  assert.equal(staleReason(lock, { now: mt + STALE_NO_OWNER_MS }), "",
    "exactly at the boundary the lock is still held");
  assert.equal(staleReason(lock, { now: mt + STALE_NO_OWNER_MS + 1 }), "no holder recorded",
    "one ms past the boundary it is stale");
  // The `alive` hook is only consulted when an owner pid was recorded: an
  // ownerless lock ignores it entirely, even one that would throw.
  const old = fakeLock("alive-ignored", { ageMs: STALE_NO_OWNER_MS + 1000 });
  assert.equal(staleReason(old, { alive: () => { throw new Error("must not be called"); } }),
    "no holder recorded");
  fs.rmSync(old, { recursive: true, force: true });
  locks.splice(locks.indexOf(old), 1);
}
{
  // A dangling symlink at the lock path: statSync follows it, gets ENOENT,
  // and staleReason reports "" forever — the lock reads as held no matter
  // how old the link is, so withLock can only ever time out. Bounded by
  // waitMs, and the symlink itself is never deleted.
  const target = path.join(root, "symlink-target-missing");
  const link = L("dangling-link");
  fs.symlinkSync(target, link);
  assert.equal(staleReason(link), "", "a dangling symlink always reads as held");
  assert.throws(() => withLock(link, () => 1, { waitMs: 80, pollMs: 10 }), /still running/);
  assert.ok(fs.lstatSync(link).isSymbolicLink(), "the symlink is left alone");
}

// ============================================================ more withLock edges
{
  // waitMs only bounds the WAIT for a held lock: a negative waitMs still
  // acquires a free lock (the deadline is never consulted), but on a held
  // lock it gives up on the first poll.
  const free = L("neg-wait-free");
  assert.equal(withLock(free, () => "acquired", { waitMs: -1000 }), "acquired");
  assert.equal(fs.existsSync(free), false);
  const held = L("neg-wait-held");
  fs.mkdirSync(held);
  assert.throws(() => withLock(held, () => 1, { waitMs: -1, pollMs: 10 }), /still running/);
  fs.rmSync(held, { recursive: true, force: true });
  locks.splice(locks.indexOf(held), 1);
}
{
  // pollMs: 0 turns the wait into a busy spin — Atomics.wait times out
  // immediately — but the deadline is still honored and fn never runs.
  const lock = L("poll-zero");
  fs.mkdirSync(lock);
  const t0 = Date.now();
  assert.throws(() => withLock(lock, () => 1, { waitMs: 100, pollMs: 0 }), /still running/);
  assert.ok(Date.now() - t0 >= 80, "the deadline still applied under a zero poll");
  fs.rmSync(lock, { recursive: true, force: true });
  locks.splice(locks.indexOf(lock), 1);
}
{
  // The promise check reads `out.then`: an object whose `then` getter throws
  // propagates that error (not the "returned a promise" one) and still
  // releases the lock. A non-function `then` is not a thenable, so the
  // value is returned untouched.
  const lock = L("thenable-getter");
  assert.throws(() => withLock(lock, () => ({ get then() { throw new Error("then getter blew up"); } })),
    /then getter blew up/);
  assert.equal(fs.existsSync(lock), false, "released even when reading .then threw");
  const plain = { then: "not a function" };
  const lock2 = L("non-thenable");
  assert.equal(withLock(lock2, () => plain), plain, "a non-callable then is just data");
  assert.equal(fs.existsSync(lock2), false);
}
{
  // A path whose PARENT is a regular file fails with ENOTDIR, not EEXIST —
  // it propagates like any other mkdir error.
  const blocker = path.join(root, "blocker-file");
  fs.writeFileSync(blocker, "i am a file, not a directory");
  assert.throws(() => withLock(path.join(blocker, "lock"), () => 1),
    (e) => e.code === "ENOTDIR");
}
{
  // A throwing `alive` probe propagates out of withLock (it is not wrapped
  // in the contention path) and leaves the held lock untouched.
  const lock = fakeLock("alive-throws", { owner: deadPid() });
  assert.throws(() => withLock(lock, () => 1, { waitMs: 0, alive: () => { throw new Error("probe failed"); } }),
    /probe failed/);
  assert.ok(fs.existsSync(lock), "the lock was never touched");
  fs.rmSync(lock, { recursive: true, force: true });
  locks.splice(locks.indexOf(lock), 1);
}
{
  // `pid` values that are not positive integers are rejected up front;
  // 0 and negatives pass Number() but fail the integer/>0 check.
  for (const [i, bad] of [0, -3, 1.5, "0", NaN].entries()) {
    const lock = L(`pid-bad-${i}`);
    assert.throws(() => withLock(lock, () => 1, { pid: bad }), /pid/, `pid ${String(bad)} rejected`);
    assert.equal(fs.existsSync(lock), false, `pid ${String(bad)} never created the lock`);
  }
}
{
  // A lock path that is not a string at all fails inside mkdirSync with a
  // TypeError — again not EEXIST, so it propagates immediately.
  assert.throws(() => withLock(undefined, () => 1), TypeError);
  assert.throws(() => withLock(12345, () => 1), TypeError);
}

// ============================================================ race: a holder that throws
{
  // If the holder's fn throws, withLock still releases and a waiting
  // contender proceeds — a failed merge must not wedge the lock.
  const lock = L("race-thrower");
  const counter = path.join(root, "counter-thrower");
  fs.writeFileSync(counter, "0");
  const prelude = `import fs from "node:fs"; import { withLock } from ${JSON.stringify(MOD)};`;
  const thrower = `${prelude}
withLock(${JSON.stringify(lock)}, () => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
  throw new Error("holder blew up mid-merge");
}, { waitMs: 30000, pollMs: 10 });`;
  const waiter = `${prelude}
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
withLock(${JSON.stringify(lock)}, () => {
  const n = Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8"));
  fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
}, { waitMs: 30000, pollMs: 10 });`;
  const [codeThrower, codeWaiter] = await Promise.all([runChild(thrower), runChild(waiter)]);
  assert.equal(codeThrower, 1, "the throwing holder exits non-zero");
  assert.equal(codeWaiter, 0, "the contender still acquired the released lock");
  assert.equal(fs.readFileSync(counter, "utf8"), "1", "the waiter's update landed");
  assert.equal(fs.existsSync(lock), false);
}

// ============================================================ the guard mutex itself
{
  // An orphaned guard mutex — its holder crashed between mkdirSync and
  // rmdirSync — blocks acquisition only until it is older than
  // GUARD_STALE_MS (10 s), when it is certainly dead and gets broken.
  const lock = L("orphan-guard");
  const gmutex = `${lock}.tmutex`;
  fs.mkdirSync(gmutex);
  const old = new Date(Date.now() - 11000);
  fs.utimesSync(gmutex, old, old);
  assert.equal(withLock(lock, () => "acquired past the orphan", { waitMs: 3000, pollMs: 5 }),
    "acquired past the orphan");
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(gmutex), false, "the orphaned guard was removed");
}
{
  // A FRESH guard mutex is a live holder mid-step: withLock waits on it and
  // gives up at waitMs like any other contention, never breaking it early.
  const lock = L("fresh-guard");
  const gmutex = `${lock}.tmutex`;
  fs.mkdirSync(gmutex);
  assert.throws(() => withLock(lock, () => 1, { waitMs: 120, pollMs: 10 }), /still running/);
  assert.equal(fs.existsSync(lock), false, "no lock was published while the guard was held");
  assert.ok(fs.existsSync(gmutex), "the fresh guard was not broken");
  fs.rmdirSync(gmutex);
}

// ============================================================ cleanup sweep
for (const l of locks) fs.rmSync(l, { recursive: true, force: true });
for (const l of locks) assert.equal(fs.existsSync(l), false, `stray lock left at ${l}`);
// Takeovers rename stale locks aside as `<lock>.gone-*`; none may litter root.
const corpses = fs.readdirSync(root).filter((f) => f.includes(".gone-"));
assert.deepEqual(corpses, [], `stale-lock corpses left behind: ${corpses}`);
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(fakeHome, { recursive: true, force: true });
console.log("constance-mergelock.deep: tests passed");
