// Deeper edge-case pass on Constance's copy worktrees (bin/constance-worktree.mjs),
// complementing constance-worktree.test.mjs: repoBranch on a detached HEAD, the
// three merge outcomes (fast-forward, merge commit, conflict — the repo always
// left clean with no MERGE_HEAD), and dropWorktree's branch-delete modes plus a
// worktree folder that is already gone. Everything runs against throwaway git
// repos in a mktemp folder with a fake HOME; nothing touches the real home,
// the real worktree area, or any network.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { repoBranch, worktreeRoot, branchFor, worktreeFor, createWorktree, mergeBranch, dropWorktree } from "./constance-worktree.mjs";

const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "constance-wt-deep-"));
process.env.HOME = path.join(root, "home");       // a fake home: git never sees the real one
fs.mkdirSync(process.env.HOME, { recursive: true });
process.env.CONSTANCE_WORKTREES = path.join(root, "worktrees");

const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
const tryGit = (dir, ...a) => { try { return git(dir, ...a); } catch (e) { return ""; } };
const head = (dir) => git(dir, "rev-parse", "HEAD").trim();
const parents = (dir) => git(dir, "rev-list", "--parents", "-n", "1", "HEAD").trim().split(/\s+/).length - 1;
const clean = (dir) => {
  assert.equal(git(dir, "status", "--porcelain").trim(), "", "the repo is clean");
  assert.equal(tryGit(dir, "rev-parse", "-q", "--verify", "MERGE_HEAD"), "", "no MERGE_HEAD is left");
};
const commitFile = (dir, name, text, msg) => {
  fs.writeFileSync(path.join(dir, name), text);
  git(dir, "add", name); git(dir, "commit", "-qm", msg);
};

// ---- a fresh repo per section keeps the cases independent
function newRepo(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  git(dir, "init", "-q"); git(dir, "config", "user.email", "t@t"); git(dir, "config", "user.name", "t");
  commitFile(dir, "seed.txt", "seed\n", "init");
  return dir;
}

// ============================================================ repoBranch
{
  const repo = newRepo("repo-branch");
  const main = git(repo, "branch", "--show-current").trim();
  assert.equal(repoBranch(repo), main, "on a branch it reports the branch name");
  git(repo, "checkout", "-q", "--detach", "HEAD");
  assert.equal(repoBranch(repo), "", "a detached HEAD reports no branch (git answers HEAD, which is filtered)");
  git(repo, "checkout", "-q", main);
  assert.equal(repoBranch(repo), main, "back on the branch it reports again");
  assert.equal(repoBranch(path.join(root, "no-such-dir")), "", "a missing dir reports no branch, never throws");
}

// ============================================================ worktreeRoot / names
{
  assert.equal(worktreeRoot({ CONSTANCE_WORKTREES: "/x/y" }), "/x/y", "the env override wins");
  assert.ok(worktreeRoot({}).endsWith(path.join("constance-worktrees")), "default ends in constance-worktrees");
  assert.equal(branchFor(7), "constance/job-7");
  assert.equal(worktreeFor(7), path.join(process.env.CONSTANCE_WORKTREES, "job-7"));
}

// ============================================================ mergeBranch: fast-forward
{
  const repo = newRepo("merge-ff");
  const w = createWorktree(repo, 901);
  commitFile(w.worktree, "ff.txt", "ff\n", "copy ff");
  const base = head(repo);
  const m = mergeBranch(repo, w.branch);
  assert.equal(m.ok, true, "a branch ahead of HEAD merges");
  assert.equal(head(repo), head(w.worktree), "a fast-forward lands exactly on the branch tip");
  assert.equal(parents(repo), 1, "a fast-forward creates no merge commit");
  assert.equal(fs.readFileSync(path.join(repo, "ff.txt"), "utf8"), "ff\n");
  clean(repo);
  assert.ok(m.commit, "the result carries the new HEAD");
  assert.notEqual(base, head(repo));
  dropWorktree(repo, w.worktree, w.branch, { deleteBranch: true, merged: true });
}

// ============================================================ mergeBranch: merge commit (diverged)
{
  const repo = newRepo("merge-commit");
  const w = createWorktree(repo, 902);
  commitFile(repo, "main.txt", "main\n", "main moves on");          // repo advances
  commitFile(w.worktree, "copy.txt", "copy\n", "copy moves on");     // branch advances too
  const m = mergeBranch(repo, w.branch);
  assert.equal(m.ok, true, "diverged branches with different files merge");
  assert.equal(parents(repo), 2, "a real merge makes a two-parent commit");
  assert.equal(fs.readFileSync(path.join(repo, "main.txt"), "utf8"), "main\n");
  assert.equal(fs.readFileSync(path.join(repo, "copy.txt"), "utf8"), "copy\n", "both sides' files are present");
  clean(repo);
  dropWorktree(repo, w.worktree, w.branch, { deleteBranch: true, merged: true });
}

// ============================================================ mergeBranch: --no-ff forces a merge commit
{
  const repo = newRepo("merge-noff");
  const w = createWorktree(repo, 903);
  commitFile(w.worktree, "noff.txt", "noff\n", "copy noff");
  const m = mergeBranch(repo, w.branch, { noFf: true });
  assert.equal(m.ok, true);
  assert.equal(parents(repo), 2, "--no-ff makes a merge commit even though a fast-forward was possible");
  clean(repo);
  dropWorktree(repo, w.worktree, w.branch, { deleteBranch: true, merged: true });
}

// ============================================================ mergeBranch: already up to date
{
  const repo = newRepo("merge-uptodate");
  const w = createWorktree(repo, 904);
  commitFile(w.worktree, "done.txt", "done\n", "copy done");
  assert.equal(mergeBranch(repo, w.branch).ok, true, "first merge lands");
  const before = head(repo);
  const m = mergeBranch(repo, w.branch);
  assert.equal(m.ok, true, "merging the same branch again is not an error");
  assert.equal(head(repo), before, "HEAD does not move on an up-to-date merge");
  clean(repo);
  dropWorktree(repo, w.worktree, w.branch, { deleteBranch: true, merged: true });
}

// ============================================================ mergeBranch: conflict is aborted, repo untouched
{
  const repo = newRepo("merge-conflict");
  const w = createWorktree(repo, 905);
  commitFile(repo, "shared.txt", "repo version\n", "repo edits shared");
  commitFile(w.worktree, "shared.txt", "copy version\n", "copy edits shared");
  const before = head(repo);
  const m = mergeBranch(repo, w.branch);
  assert.equal(m.ok, false, "a conflicting merge fails");
  assert.equal(m.conflict, true, "it is reported as a conflict");
  assert.ok(m.output.length > 0, "the failure carries git's output");
  assert.equal(head(repo), before, "HEAD is back where it was");
  assert.equal(fs.readFileSync(path.join(repo, "shared.txt"), "utf8"), "repo version\n", "the file keeps the repo's content");
  clean(repo);
  dropWorktree(repo, w.worktree, w.branch, { deleteBranch: true });
}

// ============================================================ mergeBranch: a bad ref fails without a merge state
{
  const repo = newRepo("merge-badref");
  const before = head(repo);
  const m = mergeBranch(repo, "constance/job-999-does-not-exist");
  assert.equal(m.ok, false);
  assert.equal(m.conflict, false, "a missing ref is not a conflict");
  assert.ok(m.output.length > 0);
  assert.equal(head(repo), before);
  clean(repo);
}

// SUSPECTED BUG, reported not fixed: the `fastForward` flag is named like it
// should say whether the merge fast-forwarded, but it is computed as
// "HEAD did not move" — so a real fast-forward (and a --no-ff merge commit)
// both report fastForward:false, and only an up-to-date no-op reports true.
// Nothing reads the field today (only constance.mjs/selfmerge use ok/commit/
// conflict), so it is dead misleading data rather than a live failure.
//
// assert.equal(mergeBranch(ffRepo, ffBranch).fastForward, true,
//   "a fast-forward merge should report fastForward: true");

// ============================================================ dropWorktree
{
  const repo = newRepo("drop");

  // deleteBranch without `merged` force-deletes (-D) even an unmerged branch.
  const w1 = createWorktree(repo, 911);
  commitFile(w1.worktree, "w1.txt", "w1\n", "unmerged copy");
  const d1 = dropWorktree(repo, w1.worktree, w1.branch, { deleteBranch: true });
  assert.ok(d1.some((s) => s.includes("worktree removed")), "the worktree line is reported: " + d1.join("; "));
  assert.ok(d1.some((s) => s.includes("deleted")), "the branch line is reported: " + d1.join("; "));
  assert.ok(!fs.existsSync(w1.worktree), "the worktree folder is gone");
  assert.equal(git(repo, "branch", "--list", w1.branch).trim(), "", "an unmerged branch is force-deleted without merged:true");
  clean(repo);

  // merged:true on an UNMERGED branch: git branch -d refuses, the branch is kept.
  const w2 = createWorktree(repo, 912);
  commitFile(w2.worktree, "w2.txt", "w2\n", "still unmerged");
  const d2 = dropWorktree(repo, w2.worktree, w2.branch, { deleteBranch: true, merged: true });
  assert.ok(!fs.existsSync(w2.worktree), "the worktree is still removed");
  assert.ok(d2.some((s) => s.includes("kept")), "a -d refusal is reported as kept: " + d2.join("; "));
  assert.notEqual(git(repo, "branch", "--list", w2.branch).trim(), "", "the unmerged branch survives -d");
  git(repo, "branch", "-D", w2.branch);   // test cleanup only

  // deleteBranch:false keeps the branch even after a real merge.
  const w3 = createWorktree(repo, 913);
  commitFile(w3.worktree, "w3.txt", "w3\n", "merged copy");
  assert.equal(mergeBranch(repo, w3.branch).ok, true);
  const d3 = dropWorktree(repo, w3.worktree, w3.branch);
  assert.equal(git(repo, "branch", "--list", w3.branch).trim(), w3.branch, "no deleteBranch means the branch stays");
  git(repo, "branch", "-D", w3.branch);

  // The worktree folder is already gone: dropWorktree must not throw, still
  // prunes the stale entry and still deletes the branch when asked.
  const w4 = createWorktree(repo, 914);
  commitFile(w4.worktree, "w4.txt", "w4\n", "copy whose folder vanishes");
  fs.rmSync(w4.worktree, { recursive: true, force: true });
  const d4 = dropWorktree(repo, w4.worktree, w4.branch, { deleteBranch: true });
  assert.ok(d4.some((s) => s.includes("deleted")), "the branch is still deleted: " + d4.join("; "));
  assert.equal(git(repo, "branch", "--list", w4.branch).trim(), "", "branch gone");
  assert.equal(git(repo, "worktree", "list", "--porcelain").split("worktree ").length - 1, 1, "no stale worktree entry remains");
  clean(repo);

  // A worktree path git does not know (plain leftover folder): the rmSync
  // fallback removes it and the run reports success.
  const stray = path.join(process.env.CONSTANCE_WORKTREES, "job-915");
  fs.mkdirSync(stray, { recursive: true });
  fs.writeFileSync(path.join(stray, "left.txt"), "x\n");
  const d5 = dropWorktree(repo, stray, null, {});
  assert.ok(d5.some((s) => s.includes("worktree removed")), "a plain folder is still reported removed: " + d5.join("; "));
  assert.ok(!fs.existsSync(stray));

  // No worktree and no branch: nothing to do, nothing thrown.
  assert.deepEqual(dropWorktree(repo, null, null, {}), [], "an empty drop is a no-op");
  clean(repo);
}

fs.rmSync(root, { recursive: true, force: true });   // the repos, worktrees and fake home, nothing else
console.log("constance-worktree.deep: tests passed");
