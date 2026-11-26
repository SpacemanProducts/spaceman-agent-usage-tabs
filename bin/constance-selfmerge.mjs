// Constance self-merge: a copy whose own checks pass (its tests, the guard and
// a clean diff) merges itself at once instead of waiting for Constance's
// review, which then happens in the background and can revert the merge. It
// rebases onto the current branch under the merge lock right before merging;
// anything that still fails is flagged for the owner — nothing is ever
// forced, reset or deleted.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mergeBranch, repoBranch } from "./constance-worktree.mjs";
import { stateDir } from "./constance-jobs.mjs";
import { safeGit, trackedDirty } from "./constance-git.mjs";
import { suiteLaunch } from "./constance-sandbox.mjs";
import { withLock } from "./constance-mergelock.mjs";

const git = (dir, ...args) => safeGit(dir, args);

// ---------------------------------------------------------------- the project's real test commands
// A self-merge needs the project's own test (and build) commands. They come
// only from places the worker can't touch:
//   1. <repo>/.constance/rules.md in the main checkout (read-only to workers):
//      lines like `test: npm test` or `- Build command: \`make\``.
//   2. package.json as it is on the repo's current branch (git show HEAD:…),
//      never the copy's edited one: scripts.test -> `npm test`, scripts.build ->
//      `npm run build`. npm's placeholder "no test specified" doesn't count.
//   3. This plugin's own convention, when the current branch has bin/*.test.mjs:
//      run every one of them (from the worktree, so new tests run too).
// No command found means no self-merge: the job goes to the normal review.
const RULE_RE = /^\s*(?:[-*]\s*)?(test|build)(?:\s+command)?\s*:\s*(.+?)\s*$/i;
const NPM_PLACEHOLDER = /no test specified/i;

export function testCommands(repo) {
  const cmds = [];
  let rules = "";
  try { rules = fs.readFileSync(path.join(repo, ".constance", "rules.md"), "utf8"); } catch {}
  for (const line of rules.split("\n")) {
    const m = line.match(RULE_RE);
    if (!m) continue;
    const cmd = m[2].replace(/^`+|`+$/g, "").trim();
    if (cmd) cmds.push({ kind: m[1].toLowerCase(), cmd, source: ".constance/rules.md" });
  }
  if (!cmds.length) {
    const pj = git(repo, "show", "HEAD:package.json");
    if (pj.status === 0) {
      try {
        const scripts = JSON.parse(pj.stdout).scripts || {};
        if (typeof scripts.test === "string" && scripts.test.trim() && !NPM_PLACEHOLDER.test(scripts.test)) cmds.push({ kind: "test", cmd: "npm test", source: "package.json" });
        if (typeof scripts.build === "string" && scripts.build.trim()) cmds.push({ kind: "build", cmd: "npm run build", source: "package.json" });
      } catch {}
    }
  }
  if (!cmds.length) {
    const ls = git(repo, "ls-tree", "--name-only", "HEAD", "bin/");
    if (ls.status === 0 && ls.stdout.split("\n").some((f) => /^bin\/[^/]+\.test\.mjs$/.test(f))) {
      cmds.push({ kind: "test", cmd: 'for t in bin/*.test.mjs; do node "$t" || { echo "FAILED: $t"; exit 1; }; done', source: "bin/*.test.mjs" });
    }
  }
  return cmds;
}

// Run the commands in dir (a copy's worktree) inside the suite sandbox
// (constance-sandbox.mjs suiteLaunch: no network, no bus, no ssh-agent, fake
// HOME/XDG). ok only when there was at least one command and every one exited
// 0; an empty list is `{ ok: false, empty: true }`. Output keeps the last 2000
// chars. `launch` is injectable for tests.
export function runSuite(dir, { commands = [], env = process.env, timeoutMs = 45 * 60e3, launch = suiteLaunch } = {}) {
  if (!commands.length) return { ok: false, empty: true, failed: [], output: "no test command for this project" };
  const chunks = [];
  const failed = [];
  for (const c of commands) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constance-suite-"));
    try {
      const box = launch(c.cmd, { dir, tmp, env });
      const [cmd, ...args] = box.cmd;
      const r = spawnSync(cmd, args, { cwd: dir, encoding: "utf8", env: box.env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
      chunks.push(`$ ${c.cmd}\n`, r.stdout || "", r.stderr || "");
      if (r.status !== 0 || r.error) failed.push(c.cmd);
    } catch (e) {
      chunks.push(`$ ${c.cmd}\n${e.message}\n`);
      failed.push(c.cmd);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    if (failed.length) break;
  }
  return { ok: failed.length === 0, failed, output: chunks.join("").slice(-2000) };
}

// A self-merge always makes a merge commit (--no-ff), even after the rebase
// makes a fast-forward possible: a send-back reverts that one commit with -m 1
// and so undoes all of the copy's commits, not just its last.
export const selfMergeBranch = (repo, branch) => mergeBranch(repo, branch, { noFf: true });

// The report regex is gone: the agent's own word is never a merge signal. The
// checks are the guard's clean bill and the branch diff; the suite (the
// project's real commands, sandboxed) is the test signal.
const CHECKS = ["guard", "diff"];

// Merge a finished copy's branch once its checks and the whole suite pass.
// The suite runs first, outside the merge lock (it is the slow part). Then,
// holding the lock so no other merge can land in between, the branch is
// rebased onto the repo's current branch right before merging; if that
// brought in new commits the suite runs again on the rebased tree. A rebase
// that conflicts is aborted and flagged; a merge that still conflicts is
// flagged too. Nothing is ever forced, reset or deleted.
// `retried` is true when the branch had to be rebased onto newer work.
export function selfMerge({ repo, worktree, branch, checks = {}, suite = runSuite, merge = selfMergeBranch, lock = (fn) => fn() }) {
  const failed = CHECKS.find((k) => checks[k] !== true);
  if (failed) return { merged: false, reason: `${failed} check failed` };
  // A worktree with uncommitted tracked changes can't be rebased, and its tests
  // would not be testing what merges: the job failed, it is not a conflict.
  const dirty = trackedDirty(worktree);
  if (dirty === null || dirty.length) return { merged: false, failed: true, reason: dirty ? `worktree has uncommitted changes: ${dirty.slice(0, 5).join(", ")}` : "worktree status unreadable" };
  const s = suite(worktree);
  if (s.empty) return { merged: false, noSuite: true, reason: "no test command for this project, so no self-merge" };
  if (!s.ok) return { merged: false, reason: "full test suite failed", failed: s.failed || [] };
  return lock(() => {
    const base = repoBranch(repo);
    let moved = false;
    if (base) {
      // The suite may have left changes behind; a dirty tree can't rebase.
      const d2 = trackedDirty(worktree);
      if (d2 === null || d2.length) return { merged: false, failed: true, reason: d2 ? `worktree has uncommitted changes: ${d2.slice(0, 5).join(", ")}` : "worktree status unreadable" };
      const head = () => git(worktree, "rev-parse", "HEAD").stdout.trim();
      const before = head();
      const rb = git(worktree, "rebase", base);
      if (rb.status !== 0) {
        // Only a rebase that actually started is aborted.
        const gd = git(worktree, "rev-parse", "--absolute-git-dir").stdout.trim();
        if (gd && ["rebase-merge", "rebase-apply"].some((d) => fs.existsSync(path.join(gd, d)))) git(worktree, "rebase", "--abort");
        return { merged: false, conflict: true, flagged: true, reason: "conflict, rebase failed" };
      }
      moved = head() !== before;
      if (moved) {
        const s2 = suite(worktree);
        if (!s2.ok) return { merged: false, conflict: true, flagged: true, retried: true, reason: "suite failed after rebase", failed: s2.failed || [] };
      }
    }
    const headBefore = git(repo, "rev-parse", "HEAD").stdout.trim();
    const m = merge(repo, branch);
    if (m.ok) {
      // "Already up to date" (an empty copy, or one whose commits already
      // landed): the merge created nothing and m.commit is the pre-merge
      // HEAD, not a merge of the branch. Reporting it as merged would put a
      // real prior commit in the review queue, where a send-back revert would
      // undo work this copy never did — so it is nothing to merge instead.
      if (m.commit && m.commit === headBefore) return { merged: false, reason: "nothing to merge" };
      return { merged: true, commit: m.commit, retried: moved };
    }
    if (!m.conflict) return { merged: false, reason: String(m.output || "merge failed").slice(-400) };
    return { merged: false, conflict: true, flagged: true, retried: moved, reason: "conflict after rebase" };
  });
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
  try {
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
};

// addPending and markReviewed are read-modify-write: without a lock two
// processes that overlap each read the same file and the second write drops
// the first's entry. The reviews file gets the same pid-owned directory lock
// as merges (a sibling `<file>.lock`), so every writer serializes.
const withReviewsLock = (file, fn) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file + ".lock", fn);
};

export function addPending(file = defaultReviews(), { job, commit, branch, at = Date.now() } = {}) {
  return withReviewsLock(file, () => {
    const d = readReviews(file);
    const entry = { job, commit, branch, at };
    d.pending.push(entry);
    writeReviews(file, d);
    return entry;
  });
}

export function pendingReviews(file = defaultReviews()) {
  return readReviews(file).pending;
}

export function markReviewed(file = defaultReviews(), job, verdict) {
  return withReviewsLock(file, () => {
    const d = readReviews(file);
    const i = d.pending.findIndex((p) => p.job === job);
    if (i < 0) return null;
    const [entry] = d.pending.splice(i, 1);
    d.reviewed.push({ ...entry, verdict, reviewedAt: Date.now() });
    writeReviews(file, d);
    return { ...entry, verdict };
  });
}

// Undo a self-merged commit: a merge commit needs `-m 1` (revert relative to
// the repo's own line), a plain commit a normal revert. A failed revert is
// aborted so the repo is never left mid-revert.
export function revertMerge(repo, commit) {
  // Never revert on top of someone's uncommitted work: a failed revert's
  // --abort could take it with it. Flag instead.
  const dirty = trackedDirty(repo);
  if (dirty === null || dirty.length) return { ok: false, commit, dirty: true, output: dirty ? `the checkout has uncommitted changes (${dirty.slice(0, 5).join(", ")}); nothing was reverted` : "git status unreadable; nothing was reverted" };
  const p = git(repo, "rev-list", "--parents", "-n", "1", commit);
  const parents = p.status === 0 ? p.stdout.trim().split(/\s+/).length - 1 : 1;
  // A merge commit is reverted only when it is a self-merge of a copy branch
  // ("Merge branch 'constance/job-…'"): any other merge — a stale or foreign
  // commit recorded by mistake — is refused so a send-back can never undo
  // work it did not merge. Plain commits still revert the normal way: the
  // job's own branch tip is the documented fallback target.
  if (parents > 1) {
    const subj = git(repo, "log", "-1", "--format=%s", commit).stdout.trim();
    if (!/^Merge branch 'constance\/job-/.test(subj)) {
      return { ok: false, commit, output: `refused: ${String(commit).slice(0, 12)} is not a self-merge commit (${subj.slice(0, 100)})` };
    }
  }
  const args = parents > 1 ? ["revert", "-m", "1", "--no-edit", commit] : ["revert", "--no-edit", commit];
  const r = git(repo, ...args);
  const output = `${r.stdout || ""}${r.stderr || ""}`.trim().slice(-800);
  if (r.status === 0) return { ok: true, commit, output };
  git(repo, "revert", "--abort");
  return { ok: false, commit, output };
}
