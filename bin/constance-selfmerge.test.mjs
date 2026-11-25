// Constance self-merge: runSuite runs a project's test commands in the suite
// sandbox; selfMerge lands a copy's branch once checks, suite and merge pass, and
// retries once through a rebase on conflict; the pending list and revertMerge
// back Constance's later background review. All repos and folders are mkdtemp
// throwaways; nothing touches the real home or worktree areas.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { runSuite, selfMerge, addPending, pendingReviews, markReviewed, revertMerge } from "./constance-selfmerge.mjs";
import { mergeBranch } from "./constance-worktree.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-sm-"));
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
const sh = (dir, ...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
const okSuite = () => ({ ok: true, failed: [], output: "" });
const ALL = { ownTests: true, guard: true, diff: true };

// A repo on a main branch with one commit (a.txt = "a").
function makeRepo(name) {
  const repo = path.join(root, name, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt"); git(repo, "commit", "-qm", "init");
  return repo;
}
// A copy worktree on constance/job-<id> at repo HEAD; fn(wt) makes its commits.
function makeCopy(repo, id, fn) {
  const wt = path.join(root, path.basename(repo), `wt-${id}`);
  const branch = `constance/job-${id}`;
  git(repo, "worktree", "add", "-q", "-b", branch, wt, "HEAD");
  if (fn) fn(wt);
  return { worktree: wt, branch };
}
const commitFile = (wt, file, text, msg) => {
  fs.writeFileSync(path.join(wt, file), text);
  git(wt, "add", file); git(wt, "commit", "-qm", msg);
};
const commitOn = (repo, file, text, msg) => commitFile(repo, file, text, msg);

// runSuite: runs the project's commands inside the suite sandbox. A failing
// command fails the suite, output is kept, HOME inside is the box's fake home,
// and no commands at all is an empty suite — never a pass.
{
  const dir = path.join(root, "suite");
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  git(dir, "init", "-q");
  const empty = runSuite(dir, { commands: [] });
  assert.equal(empty.ok, false, "no commands is never a pass"); assert.equal(empty.empty, true);
  let s = runSuite(dir, { commands: [{ cmd: 'echo "$HOME" > home-marker; echo suite-ok-marker' }, { cmd: "echo suite-bad-marker; exit 1" }] });
  assert.equal(s.ok, false, "a failing command fails the suite");
  assert.deepEqual(s.failed, ["echo suite-bad-marker; exit 1"]);
  assert.ok(s.output.includes("suite-ok-marker") && s.output.includes("suite-bad-marker"), "output keeps both commands' prints");
  assert.equal(fs.readFileSync(path.join(dir, "home-marker"), "utf8").trim(), "/tmp/home", "HOME inside is the box's fake home");
  s = runSuite(dir, { commands: [{ cmd: "true" }] });
  assert.equal(s.ok, true); assert.deepEqual(s.failed, []);
}

// selfMerge, clean path: checks + suite + merge all pass, branch lands.
{
  const repo = makeRepo("clean");
  const c = makeCopy(repo, 1, (wt) => commitFile(wt, "b.txt", "b\n", "copy b"));
  let calls = 0;
  const r = selfMerge({ repo, worktree: c.worktree, branch: c.branch, checks: ALL, suite: () => { calls++; return okSuite(); } });
  assert.equal(r.merged, true); assert.equal(r.retried, false); assert.ok(r.commit);
  assert.equal(calls, 1, "the suite ran once");
  assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "b\n", "the copy's file is merged");
  assert.equal(git(repo, "rev-parse", "HEAD").trim(), r.commit);
  assert.equal(git(repo, "status", "--porcelain").trim(), "", "repo clean");
}

// selfMerge, a failed own check: nothing runs, nothing merges.
{
  const repo = makeRepo("checkfail");
  const c = makeCopy(repo, 2, (wt) => commitFile(wt, "b.txt", "b\n", "copy b"));
  for (const key of ["guard", "diff"]) {
    const checks = { ...ALL, [key]: false };
    let suiteCalled = false;
    const r = selfMerge({ repo, worktree: c.worktree, branch: c.branch, checks, suite: () => { suiteCalled = true; return okSuite(); } });
    assert.equal(r.merged, false); assert.match(r.reason, new RegExp(key));
    assert.equal(suiteCalled, false, `the suite must not run when ${key} failed`);
  }
  assert.equal(fs.existsSync(path.join(repo, "b.txt")), false, "nothing merged");
}

// selfMerge, suite failure: reported with the failing files, nothing merges.
{
  const repo = makeRepo("suitefail");
  const c = makeCopy(repo, 3, (wt) => commitFile(wt, "b.txt", "b\n", "copy b"));
  const r = selfMerge({ repo, worktree: c.worktree, branch: c.branch, checks: ALL,
    suite: () => ({ ok: false, failed: ["x.test.mjs"], output: "boom" }) });
  assert.equal(r.merged, false); assert.equal(r.reason, "full test suite failed");
  assert.deepEqual(r.failed, ["x.test.mjs"]);
  assert.equal(fs.existsSync(path.join(repo, "b.txt")), false);
}

// selfMerge, conflict the rebase fixes: the copy's a.txt change is identical to
// one main already made (same patch, so rebase skips it as previously applied)
// while main moved on; the real work (b.txt) rebases clean and merges.
{
  const repo = makeRepo("rebasefix");
  const c = makeCopy(repo, 4, (wt) => {
    commitFile(wt, "a.txt", "shared\n", "same change main makes");
    commitFile(wt, "b.txt", "b\n", "copy work");
  });
  commitOn(repo, "a.txt", "shared\n", "main makes the same change");
  commitOn(repo, "a.txt", "main-wins\n", "main moves on");
  const direct = mergeBranch(repo, c.branch);
  assert.equal(direct.ok, false); assert.equal(direct.conflict, true, "setup really conflicts");
  const r = selfMerge({ repo, worktree: c.worktree, branch: c.branch, checks: ALL, suite: okSuite });
  assert.equal(r.merged, true, JSON.stringify(r)); assert.equal(r.retried, true);
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "main-wins\n", "main's line won, the duplicate change was dropped");
  assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "b\n", "the real work landed");
  assert.equal(git(repo, "status", "--porcelain").trim(), "", "repo clean after the retried merge");
  assert.notEqual(git(repo, "branch", "--list", c.branch).trim(), "", "the branch is never deleted");
}

// selfMerge, conflict the rebase can't fix: flagged, rebase aborted, and both
// the repo and the worktree are left clean (no MERGE_HEAD, no rebase running).
{
  const repo = makeRepo("rebasefail");
  const c = makeCopy(repo, 5, (wt) => commitFile(wt, "a.txt", "copy\n", "copy a"));
  commitOn(repo, "a.txt", "main\n", "main a");
  const r = selfMerge({ repo, worktree: c.worktree, branch: c.branch, checks: ALL, suite: okSuite });
  assert.equal(r.merged, false);
  assert.equal(r.conflict, true); assert.equal(r.flagged, true);
  assert.equal(r.reason, "conflict, rebase failed");
  assert.equal(sh(repo, "rev-parse", "-q", "--verify", "MERGE_HEAD").status !== 0, true, "no merge left in the repo");
  assert.equal(git(repo, "status", "--porcelain").trim(), "", "repo clean");
  assert.equal(sh(c.worktree, "rev-parse", "-q", "--verify", "REBASE_HEAD").status !== 0, true, "no rebase left in the worktree");
  assert.equal(fs.readFileSync(path.join(c.worktree, "a.txt"), "utf8"), "copy\n", "the aborted rebase restored the copy's file");
}

// The first suite runs outside the merge lock; the rebase and the merge run inside it.
{
  const repo = makeRepo("lockorder");
  const c = makeCopy(repo, 9, (wt) => commitFile(wt, "b.txt", "b\n", "copy b"));
  const events = [];
  let held = false;
  const r = selfMerge({ repo, worktree: c.worktree, branch: c.branch, checks: ALL,
    suite: () => { events.push(held ? "suite-locked" : "suite"); return okSuite(); },
    merge: (rp, br) => { events.push(held ? "merge-locked" : "merge"); return mergeBranch(rp, br); },
    lock: (fn) => { held = true; try { return fn(); } finally { held = false; } } });
  assert.equal(r.merged, true);
  assert.deepEqual(events, ["suite", "merge-locked"], "suite outside the lock, merge inside it");
}

// Main moved on (no conflict): the copy is rebased first, the suite runs again
// on the rebased tree under the lock, and main gets both changes.
{
  const repo = makeRepo("moved");
  const c = makeCopy(repo, 10, (wt) => commitFile(wt, "b.txt", "b\n", "copy b"));
  commitOn(repo, "m.txt", "m\n", "main moved");
  const seen = [];
  const r = selfMerge({ repo, worktree: c.worktree, branch: c.branch, checks: ALL,
    suite: (wt) => { seen.push(fs.existsSync(path.join(wt, "m.txt"))); return okSuite(); } });
  assert.equal(r.merged, true, JSON.stringify(r)); assert.equal(r.retried, true);
  assert.deepEqual(seen, [false, true], "the second suite saw main's new work");
  assert.equal(fs.readFileSync(path.join(repo, "m.txt"), "utf8"), "m\n");
  assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "b\n");
  const main = git(repo, "rev-parse", "HEAD^1").trim();
  assert.equal(git(repo, "rev-parse", "HEAD^2^").trim(), main, "the copy's branch sat on main's tip when merged");
  assert.match(git(repo, "log", "-1", "--format=%P").trim(), /^\S+ \S+$/, "a real merge commit, so a send-back can revert it whole");
}

// The suite fails on the rebased tree: flagged, nothing merged.
{
  const repo = makeRepo("movedfail");
  const c = makeCopy(repo, 11, (wt) => commitFile(wt, "b.txt", "b\n", "copy b"));
  commitOn(repo, "m.txt", "m\n", "main moved");
  let n = 0;
  const r = selfMerge({ repo, worktree: c.worktree, branch: c.branch, checks: ALL,
    suite: () => (++n === 1 ? okSuite() : { ok: false, failed: ["y.test.mjs"], output: "" }) });
  assert.equal(r.merged, false); assert.equal(r.flagged, true);
  assert.equal(r.reason, "suite failed after rebase"); assert.deepEqual(r.failed, ["y.test.mjs"]);
  assert.equal(fs.existsSync(path.join(repo, "b.txt")), false, "nothing merged");
}

// Two copies from the same base self-merge one after the other: the second is
// rebased onto the first's merge, so both changes are in main.
{
  const repo = makeRepo("pair");
  const a = makeCopy(repo, 12, (wt) => commitFile(wt, "p1.txt", "1\n", "copy p1"));
  const b = makeCopy(repo, 13, (wt) => commitFile(wt, "p2.txt", "2\n", "copy p2"));
  assert.equal(selfMerge({ repo, worktree: a.worktree, branch: a.branch, checks: ALL, suite: okSuite }).merged, true);
  const rb = selfMerge({ repo, worktree: b.worktree, branch: b.branch, checks: ALL, suite: okSuite });
  assert.equal(rb.merged, true); assert.equal(rb.retried, true, "the second copy was rebased onto the first's merge");
  assert.ok(fs.existsSync(path.join(repo, "p1.txt")) && fs.existsSync(path.join(repo, "p2.txt")), "neither copy's change was lost");
  assert.equal(git(repo, "status", "--porcelain").trim(), "", "repo clean");
}

// A copy with several commits, on a main that never moved (a fast-forward was
// possible): the self-merge still makes a merge commit, and reverting it takes
// out all of the copy's commits, not just the last.
{
  const repo = makeRepo("multirevert");
  const c = makeCopy(repo, 14, (wt) => { commitFile(wt, "q1.txt", "1\n", "copy q1"); commitFile(wt, "q2.txt", "2\n", "copy q2"); });
  const r = selfMerge({ repo, worktree: c.worktree, branch: c.branch, checks: ALL, suite: okSuite });
  assert.equal(r.merged, true); assert.equal(r.retried, false);
  assert.equal(git(repo, "log", "-1", "--format=%P").trim().split(" ").length, 2, "a merge commit, not a fast-forward");
  assert.equal(revertMerge(repo, r.commit).ok, true);
  assert.ok(!fs.existsSync(path.join(repo, "q1.txt")) && !fs.existsSync(path.join(repo, "q2.txt")), "the revert took out every commit of the copy");
}

// The pending-review list: add, list, mark with a verdict; unknown jobs are a no-op.
{
  const file = path.join(root, "reviews.json");
  addPending(file, { job: 7, commit: "aaa", branch: "constance/job-7", at: 111 });
  addPending(file, { job: 8, commit: "bbb", branch: "constance/job-8", at: 222 });
  let pend = pendingReviews(file);
  assert.equal(pend.length, 2); assert.equal(pend[0].job, 7); assert.equal(pend[1].job, 8);
  const rev = markReviewed(file, 7, "ok");
  assert.equal(rev.job, 7); assert.equal(rev.verdict, "ok");
  pend = pendingReviews(file);
  assert.equal(pend.length, 1); assert.equal(pend[0].job, 8);
  assert.equal(markReviewed(file, 8, "reverted").verdict, "reverted");
  assert.equal(pendingReviews(file).length, 0);
  assert.equal(markReviewed(file, 99, "ok"), null, "marking an unknown job changes nothing");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.reviewed.length, 2, "reviewed entries are kept with their verdicts");
}

// revertMerge undoes a real merge commit (-m 1), a plain commit, and reports a
// bad commit without leaving a revert in progress.
{
  const repo = makeRepo("revert");
  const c = makeCopy(repo, 6, (wt) => commitFile(wt, "b.txt", "b\n", "copy b"));
  commitOn(repo, "m.txt", "m\n", "main work, so the merge is not a fast-forward");
  const m = mergeBranch(repo, c.branch);
  assert.equal(m.ok, true); assert.ok(m.commit);
  assert.equal(fs.existsSync(path.join(repo, "b.txt")), true);
  const rv = revertMerge(repo, m.commit);
  assert.equal(rv.ok, true, rv.output);
  assert.equal(fs.existsSync(path.join(repo, "b.txt")), false, "the merge's file is gone");
  assert.equal(fs.readFileSync(path.join(repo, "m.txt"), "utf8"), "m\n", "main's own work stays");
  assert.match(git(repo, "log", "-1", "--format=%s"), /Revert/, "a revert commit was made");
  assert.equal(git(repo, "status", "--porcelain").trim(), "", "repo clean after the revert");
  // A plain (non-merge) commit reverts the normal way.
  commitOn(repo, "d.txt", "d\n", "plain work");
  const plain = git(repo, "rev-parse", "HEAD").trim();
  assert.equal(revertMerge(repo, plain).ok, true);
  assert.equal(fs.existsSync(path.join(repo, "d.txt")), false);
  // A bogus commit fails cleanly.
  const bad = revertMerge(repo, "0".repeat(40));
  assert.equal(bad.ok, false);
  assert.equal(sh(repo, "rev-parse", "-q", "--verify", "REVERT_HEAD").status !== 0, true, "no revert left in progress");
}

fs.rmSync(root, { recursive: true, force: true });   // every repo, worktree and temp HOME, nothing else
console.log("constance-selfmerge: tests passed");
