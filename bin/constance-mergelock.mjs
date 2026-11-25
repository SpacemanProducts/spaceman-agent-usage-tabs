// Constance's merge lock: every merge into a project's branch (self-merge,
// accept, the revert of a send-back) runs one at a time across her separate
// processes. The lock is a directory with an `owner` file holding the holder's
// pid. It is only stale when that process is gone; a lock that is merely old is
// still held, because a self-merge keeps it through a rebase and a whole test
// suite. A lock with no owner file (mkdir done, owner not written yet, or left
// by an older version) is stale after STALE_NO_OWNER_MS. Only the owner ever
// removes it.
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
// "another merge is still running". pid is this process (tests pass others).
export function withLock(lock, fn, { waitMs = 10000, pollMs = 25, pid = process.pid, alive = pidAlive } = {}) {
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "owner"), String(pid));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const why = staleReason(lock, { alive });
      // Re-read the owner right before removing so a lock someone else has
      // just taken over is left alone.
      if (why && staleReason(lock, { alive })) {
        try { fs.rmSync(lock, { recursive: true, force: true }); } catch {}
        continue;
      }
      if (Date.now() > until) throw new Error("another merge is still running");
      sleepSync(pollMs);
    }
  }
  try { return fn(); }
  finally {
    if (ownerOf(lock) === pid) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} }
  }
}
