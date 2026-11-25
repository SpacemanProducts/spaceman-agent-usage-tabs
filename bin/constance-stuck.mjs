// Stuck detection for a running job. A job is stuck when it has run more than
// twice its agent's usual time (the scorecard's average, floored at MIN_EXPECTED_MS
// so one quick job doesn't make every later one look stuck), or when it shows no
// file changes and no log output for IDLE_MS. A stuck card turns orange in her
// panel and offers "Give it to Opus"; the owner gets one silent notification per job.
// Pure helpers plus a cheap activity fingerprint; bin/constance.mjs runs them on sweep.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export const IDLE_MS = 15 * 60e3;
export const MIN_EXPECTED_MS = 5 * 60e3;
export const CHECK_GAP_MS = 30e3;

const mins = (ms) => {
  const m = Math.round(ms / 60e3);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim();
};

// The expected run time from a scorecard row ({ avgMs }), or null when the agent has no timed job yet.
export function expectedMs(row, floor = MIN_EXPECTED_MS) {
  const ms = Number(row?.avgMs);
  return Number.isFinite(ms) && ms > 0 ? Math.max(ms, floor) : null;
}

// { stuck, reason } for one running job. `activityAt` is when its files or log last changed
// (falls back to its start); `expected` is expectedMs() or null.
export function stuckCheck(job, { now = Date.now(), expected = null, activityAt = 0, idleMs = IDLE_MS } = {}) {
  if (!job || job.status !== "running" || !(job.startedAt > 0)) return { stuck: false, reason: "" };
  const ran = now - job.startedAt;
  if (expected && ran > 2 * expected) return { stuck: true, kind: "slow", reason: `running ${mins(ran)}, more than twice its usual ${mins(expected)}` };
  const last = Math.max(job.startedAt, Number(activityAt) || 0);
  if (now - last >= idleMs) return { stuck: true, kind: "idle", reason: `no file changes and no log output for ${mins(now - last)}` };
  return { stuck: false, reason: "" };
}

// A fingerprint of what the job visibly did: HEAD, the changed paths and their mtimes
// (so a file edited again counts), and the log's size. Anything unreadable just drops out.
export function activitySignature(dir, logFile = "") {
  const h = createHash("sha1");
  // --no-optional-locks: a plain `git status` may refresh the index under index.lock, which would
  // race the worker's own commit or a self-merge's rebase in the same worktree.
  const git = (...a) => spawnSync("git", ["--no-optional-locks", "-C", dir, ...a], { encoding: "utf8", timeout: 10e3 });
  const head = git("rev-parse", "HEAD");
  h.update(head.status === 0 ? head.stdout : "");
  const st = git("status", "--porcelain=v1", "-z", "--untracked-files=all");
  if (st.status === 0) {
    for (const entry of st.stdout.split("\0").filter(Boolean)) {
      const p = entry.slice(3);
      if (p.startsWith(".constance/")) continue;
      let m = 0; try { m = fs.statSync(path.join(dir, p)).mtimeMs; } catch {}
      h.update(`${entry}:${m}\n`);
    }
  }
  if (logFile) { try { h.update(`log:${fs.statSync(logFile).size}`); } catch {} }
  return h.digest("hex");
}

// Next activity record for a job: { sig, at, checkedAt }. `at` moves only when the signature changed.
export function observe(prev, sig, now = Date.now()) {
  if (!prev || !prev.sig) return { sig, at: now, checkedAt: now };
  return { sig, at: prev.sig === sig ? prev.at : now, checkedAt: now };
}

export const dueForCheck = (activity, now = Date.now(), gap = CHECK_GAP_MS) => !activity || now - (activity.checkedAt || 0) >= gap;
