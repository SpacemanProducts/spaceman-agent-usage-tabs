// Constance's merge lock: every merge into a project's branch (self-merge,
// accept, the revert of a send-back) runs one at a time across her separate
// processes. The lock is a directory with an `owner` file holding the holder's
// pid, published in a single rename so the path never exists without its
// owner (a crashed publisher can only leave a `<lock>.*.new` sibling behind,
// never an ownerless `lock`). It is only stale when that process is gone; a
// lock that is merely old is still held, because a self-merge keeps it
// through a rebase and a whole test suite. An ownerless lock dir (left by an
// older version) is stale after STALE_NO_OWNER_MS. Only the owner ever removes
// it.
//
// withLock is strictly synchronous: fn must not return a promise. If it does,
// the lock is released and an Error is thrown — there is no async variant,
// because every critical section it guards is spawnSync-based anyway.
import fs from "node:fs";
import path from "node:path";

export const STALE_NO_OWNER_MS = 30000;

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pidAlive = (pid) => {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};
const ownerOf = (lock) => {
  try { return Number(fs.readFileSync(path.join(lock, "owner"), "utf8").trim()) || 0; } catch { return 0; }
};
// The raw owner text, for the takeover check: "" vs a pid is not enough —
// two different dead pids both read stale, so the takeover remembers exactly
// what it judged and only deletes the corpse if the moved dir still matches.
const ownerTextOf = (lock) => {
  try { return fs.readFileSync(path.join(lock, "owner"), "utf8").trim(); } catch { return null; }
};

// Why the lock at `lock` can be taken over, or "" while it is really held.
export function staleReason(lock, { now = Date.now(), alive = pidAlive } = {}) {
  let st;
  try { st = fs.statSync(lock); } catch { return ""; }   // gone: just retry
  const owner = ownerOf(lock);
  if (owner) return alive(owner) ? "" : `holder ${owner} is gone`;
  return now - st.mtimeMs > STALE_NO_OWNER_MS ? "no holder recorded" : "";
}

// Run fn() holding the lock. Waits up to waitMs for a live holder, then throws
// "another merge is still running". pid is this process (tests pass others);
// numeric strings and bigints are coerced to the number they name, anything
// else throws before the lock is touched.
export function withLock(lock, fn, { waitMs = 10000, pollMs = 25, pid = process.pid, alive = pidAlive } = {}) {
  const self = Number(pid);
  if (!Number.isInteger(self) || self <= 0) throw new TypeError(`withLock pid must be a positive integer, got ${String(pid)}`);
  if (typeof lock !== "string" || !lock) throw new TypeError(`withLock lock must be a non-empty path string, got ${String(lock)}`);
  const until = Date.now() + waitMs;
  // Every error a racer can hit while publishing or moving the lock means the
  // same thing — someone else got there first (or the path is blocked): look
  // again, never crash. Real errors (missing parent dir, EACCES, ...) still
  // propagate from the staging mkdir.
  const raced = new Set(["ENOENT", "EEXIST", "ENOTEMPTY", "EISDIR", "ENOTDIR", "EBUSY"]);
  for (;;) {
    if (!fs.existsSync(lock)) {
      // Stage the lock next to its final path WITH `owner` already inside,
      // then publish it with one rename. `lock` therefore never exists as a
      // dir without an owner, so a contender's takeover rename can never move
      // aside a half-made lock belonging to a live new owner — the old bug:
      // staleReason judged a dead-holder corpse, a new owner mkdir'd `lock`
      // but had not written `owner` yet, and the contender's rename moved the
      // NEW lock aside.
      const tmp = `${lock}.${self}-${Date.now()}-${Math.random().toString(36).slice(2)}.new`;
      try {
        fs.mkdirSync(tmp);
        fs.writeFileSync(path.join(tmp, "owner"), String(self));
      } catch (e) {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
        throw e;
      }
      try {
        fs.renameSync(tmp, lock);
        break;
      } catch (e) {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
        if (!raced.has(e.code)) throw e;
        // `lock` is taken or blocked: fall through and contend for it.
      }
    }
    if (!staleReason(lock, { alive })) {
      if (Date.now() > until) throw new Error("another merge is still running");
      sleepSync(pollMs);
      continue;
    }
    // Stale: take it over atomically by renaming the corpse aside first.
    // rename(2) moves exactly one path — the first contender to rename wins
    // and every other rename gets ENOENT — so two waiters can never both
    // delete-and-recreate `lock` and each believe they hold it.
    const judged = ownerTextOf(lock);
    const aside = `${lock}.gone-${self}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      fs.renameSync(lock, aside);
    } catch (e2) {
      if (raced.has(e2.code)) continue;   // gone or blocked: look again
      throw e2;
    }
    // Whatever now sits at `aside` may not be the corpse we judged: between
    // the stale check and the rename, another contender can finish a takeover
    // and publish a LIVE lock at `lock`, and our rename would have moved that
    // instead. It is the corpse only if the owner text is unchanged AND it
    // still reads stale; anything else is put back — or, if `lock` was
    // re-created meanwhile, left in place with a note rather than deleted.
    if (ownerTextOf(aside) === judged && staleReason(aside, { alive }) !== "") {
      try { fs.rmSync(aside, { recursive: true, force: true }); } catch {}
    } else {
      let back = false;
      if (!fs.existsSync(lock)) {
        try { fs.renameSync(aside, lock); back = true; } catch {}
      }
      if (!back) {
        try {
          fs.writeFileSync(path.join(aside, "constance-mergelock-note"),
            `moved aside during a takeover race and could not be put back: ${lock} was re-created meanwhile\n`);
        } catch {}
      }
    }
    continue;
  }
  try {
    const out = fn();
    if (out !== null && (typeof out === "object" || typeof out === "function") && typeof out.then === "function") {
      throw new Error("withLock fn returned a promise; withLock is synchronous and the lock is already released — keep fn synchronous");
    }
    return out;
  } finally {
    if (ownerOf(lock) === self) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} }
  }
}
