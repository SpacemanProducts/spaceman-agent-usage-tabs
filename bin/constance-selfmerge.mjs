// Constance self-merge: a copy whose own checks pass (its tests, the guard and
// a clean diff) merges itself at once instead of waiting for Constance's
// review, which then happens in the background and can revert the merge. A
// conflict gets one rebase-and-retry; anything still failing is flagged for
// the owner — nothing is ever forced, reset or deleted.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mergeBranch, repoBranch } from "./constance-worktree.mjs";
import { stateDir } from "./constance-jobs.mjs";

const git = (dir, ...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });

// Run every bin/*.test.mjs in dir under node with cwd dir, each with HOME
// pointed at a fresh temp folder that is removed afterwards, so the suite
// never sees the real home. ok only when every file exits 0; output keeps the
// last 2000 chars of what the tests printed.
export function runSuite(dir, { env = process.env } = {}) {
  const bin = path.join(dir, "bin");
  const files = fs.existsSync(bin) ? fs.readdirSync(bin).filter((f) => f.endsWith(".test.mjs")).sort() : [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "constance-suite-home-"));
  const chunks = [];
  const failed = [];
  try {
    for (const f of files) {
      const r = spawnSync(process.execPath, [path.join(bin, f)], { cwd: dir, encoding: "utf8", env: { ...env, HOME: home } });
      chunks.push(r.stdout || "", r.stderr || "");
      if (r.status !== 0 || r.error) failed.push(f);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  return { ok: failed.length === 0, failed, output: chunks.join("").slice(-2000) };
}

const CHECKS = ["ownTests", "guard", "diff"];

// Merge a finished copy's branch once its checks and the whole suite pass.
// On a conflict the branch is rebased onto the repo's current branch inside
// the worktree and tried once more (suite, then merge); a second failure is
// flagged for Constance instead of forcing anything.
export function selfMerge({ repo, worktree, branch, checks = {}, suite = runSuite, merge = mergeBranch }) {
  const failed = CHECKS.find((k) => checks[k] !== true);
  if (failed) return { merged: false, reason: `${failed} check failed` };
  const s = suite(worktree);
  if (!s.ok) return { merged: false, reason: "full test suite failed", failed: s.failed || [] };
  const m = merge(repo, branch);
  if (m.ok) return { merged: true, commit: m.commit, retried: false };
  if (!m.conflict) return { merged: false, reason: String(m.output || "merge failed").slice(-400) };
  const rb = git(worktree, "rebase", repoBranch(repo));
  if (rb.status !== 0) {
    git(worktree, "rebase", "--abort");
    return { merged: false, conflict: true, flagged: true, reason: "conflict, rebase failed" };
  }
  const s2 = suite(worktree);
  if (!s2.ok) return { merged: false, conflict: true, flagged: true, retried: true, reason: "conflict after rebase", failed: s2.failed || [] };
  const m2 = merge(repo, branch);
  if (m2.ok) return { merged: true, commit: m2.commit, retried: true };
  return { merged: false, conflict: true, flagged: true, retried: true, reason: "conflict after rebase" };
}

// Merges that selfMerge landed wait in this list for Constance's background
// review; markReviewed moves an entry to `reviewed` with its verdict
// ("ok" or "reverted"). Default file: reviews.json in the constance state dir.
const defaultReviews = () => path.join(stateDir(), "reviews.json");
const readReviews = (file) => {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    return { pending: Array.isArray(d.pending) ? d.pending : [], reviewed: Array.isArray(d.reviewed) ? d.reviewed : [] };
  } catch { return { pending: [], reviewed: [] }; }
};
const writeReviews = (file, d) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + "\n");
  fs.renameSync(tmp, file);
};

export function addPending(file = defaultReviews(), { job, commit, branch, at = Date.now() } = {}) {
  const d = readReviews(file);
  const entry = { job, commit, branch, at };
  d.pending.push(entry);
  writeReviews(file, d);
  return entry;
}

export function pendingReviews(file = defaultReviews()) {
  return readReviews(file).pending;
}

export function markReviewed(file = defaultReviews(), job, verdict) {
  const d = readReviews(file);
  const i = d.pending.findIndex((p) => p.job === job);
  if (i < 0) return null;
  const [entry] = d.pending.splice(i, 1);
  d.reviewed.push({ ...entry, verdict, reviewedAt: Date.now() });
  writeReviews(file, d);
  return { ...entry, verdict };
}

// Undo a self-merged commit: a merge commit needs `-m 1` (revert relative to
// the repo's own line), a plain commit a normal revert. A failed revert is
// aborted so the repo is never left mid-revert.
export function revertMerge(repo, commit) {
  const p = git(repo, "rev-list", "--parents", "-n", "1", commit);
  const parents = p.status === 0 ? p.stdout.trim().split(/\s+/).length - 1 : 1;
  const args = parents > 1 ? ["revert", "-m", "1", "--no-edit", commit] : ["revert", "--no-edit", commit];
  const r = git(repo, ...args);
  const output = `${r.stdout || ""}${r.stderr || ""}`.trim().slice(-800);
  if (r.status === 0) return { ok: true, commit, output };
  git(repo, "revert", "--abort");
  return { ok: false, commit, output };
}
