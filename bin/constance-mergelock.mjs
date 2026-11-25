// Constance's merge lock: every merge into a project's branch (self-merge,
// accept, the revert of a send-back) runs one at a time across her separate
// processes. The lock is a directory with an `owner` file holding the holder's
// pid. It is only stale when that process is gone; a lock that is merely old is
// still held, because a self-merge keeps it through a rebase and a whole test
// suite. A lock with no owner file (mkdir done, owner not written yet, or left
// by an older version) is stale after STALE_NO_OWNER_MS. Only the owner ever
// removes it.
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

// Why the lock at `lock` can be taken over, or "" while it is really held.
export function staleReason(lock, { now = Date.now(), alive = pidAlive } = {}) {
  let st;
  try { st = fs.statSync(lock); } catch { return ""; }   // gone: just retry mkdir
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
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "owner"), String(self));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (!staleReason(lock, { alive })) {
        if (Date.now() > until) throw new Error("another merge is still running");
        sleepSync(pollMs);
        continue;
      }
      // Stale: take it over atomically by renaming the corpse aside first.
      // rename(2) moves exactly one path — the first contender to rename wins
      // and every other rename gets ENOENT — so two waiters can never both
      // delete-and-recreate `lock` and each believe they hold it. rm'ing
      // `lock` directly was the old bug: a fresh holder's dir could already
      // sit at that path by the time the rm ran.
      const aside = `${lock}.gone-${self}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      try {
        fs.renameSync(lock, aside);
      } catch (e2) {
        if (e2.code === "ENOENT") continue;   // another contender moved it first
        throw e2;
      }
      // The path may have changed hands between the stale check and the
      // rename: a finished takeover leaves a fresh, live lock at `lock`, and
      // our rename would have moved THAT aside instead of the corpse. Re-check
      // what we actually moved — "" means held (live owner, or too fresh to be
      // stale), anything else is a corpse safe to delete.
      if (staleReason(aside, { alive }) === "") {
        // We grabbed a live lock: put it back if `lock` is still free. If it
        // was re-taken in the meantime the live lock stays at `aside` —
        // litter, but never deleted, and its owner's release check reads
        // `lock`, so it won't remove the new holder's lock either way.
        if (!fs.existsSync(lock)) { try { fs.renameSync(aside, lock); } catch {} }
      } else {
        try { fs.rmSync(aside, { recursive: true, force: true }); } catch {}
      }
      continue;
    }
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
