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
  assert.equal(m.fastForward, true, "a fast-forward merge reports fastForward: true");
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
  assert.equal(m.fastForward, false, "a merge commit is not a fast-forward");
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
  assert.equal(m.fastForward, false, "--no-ff is never a fast-forward");
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
  assert.equal(m.fastForward, false, "an up-to-date no-op is not a fast-forward");
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

// ============================================================ mergeBranch: failure without MERGE_HEAD still cleans up
// The race case from constance-selfmerge.deep.test.mjs, made deterministic: a
// held ref lock makes `git merge` fail at update_ref AFTER the fast-forward
// already staged the result, so there is no MERGE_HEAD to abort — but the
// repo must still come out clean because it was clean before the merge.
{
  const repo = newRepo("merge-nomergehead");
  const w = createWorktree(repo, 940);
  commitFile(w.worktree, "locked.txt", "locked\n", "copy work");
  const current = git(repo, "branch", "--show-current").trim();
  const lock = path.join(repo, ".git", "refs", "heads", `${current}.lock`);
  fs.writeFileSync(lock, "");
  const before = head(repo);
  const m = mergeBranch(repo, w.branch);
  fs.rmSync(lock);
  assert.equal(m.ok, false, "the locked ref makes the merge fail");
  assert.equal(m.conflict, false, "no MERGE_HEAD was written, so it is not a conflict");
  assert.equal(head(repo), before, "HEAD never moved");
  clean(repo);   // the staged merge result must be gone: index reset, tree restored, strays cleaned
  assert.equal(fs.existsSync(path.join(repo, "locked.txt")), false, "the staged file did not survive");
  dropWorktree(repo, w.worktree, w.branch, { deleteBranch: true });
}

// ============================================================ mergeBranch: a dirty repo keeps the owner's changes
// Same failure shape, but the tree was already dirty: the cleanup must not
// run, so pre-existing uncommitted work is never reset away.
{
  const repo = newRepo("merge-dirtytree");
  const w = createWorktree(repo, 941);
  commitFile(w.worktree, "seed.txt", "copy version\n", "copy edits seed");
  fs.writeFileSync(path.join(repo, "seed.txt"), "owner edit\n");   // unstaged, tracked
  const m = mergeBranch(repo, w.branch);
  assert.equal(m.ok, false, "git refuses to merge over local changes");
  assert.equal(m.conflict, false);
  assert.equal(fs.readFileSync(path.join(repo, "seed.txt"), "utf8"), "owner edit\n", "pre-existing changes are never reset away");
  assert.equal(git(repo, "status", "--porcelain"), " M seed.txt\n", "the owner's edit is still there, unstaged");
  dropWorktree(repo, w.worktree, w.branch, { deleteBranch: true });
}

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

// ============================================================ repoBranch: more edges
{
  const unborn = path.join(root, "repo-unborn");
  fs.mkdirSync(unborn);
  git(unborn, "init", "-q");
  assert.equal(repoBranch(unborn), "", "an unborn HEAD (no commits yet) reports no branch, never throws");
  const afile = path.join(root, "a-plain-file");
  fs.writeFileSync(afile, "x\n");
  assert.equal(repoBranch(afile), "", "a path that is not a repo reports no branch");
}

// ============================================================ worktreeRoot: env is read fresh, never cached
{
  assert.equal(worktreeRoot({ CONSTANCE_WORKTREES: "" }).endsWith(path.join("constance-worktrees")),
    true, "an empty-string override falls through to the default");
  const saved = process.env.CONSTANCE_WORKTREES;
  try {
    process.env.CONSTANCE_WORKTREES = path.join(root, "wts-a");
    assert.equal(worktreeFor(1), path.join(root, "wts-a", "job-1"), "the first env value is used");
    process.env.CONSTANCE_WORKTREES = path.join(root, "wts-b");
    assert.equal(worktreeFor(1), path.join(root, "wts-b", "job-1"), "a changed env value is picked up: no caching");
  } finally {
    process.env.CONSTANCE_WORKTREES = saved;
  }
}

// ============================================================ createWorktree: error paths
{
  const notRepo = path.join(root, "not-a-repo");
  fs.mkdirSync(notRepo);
  assert.throws(() => createWorktree(notRepo, 920), /could not create worktree/, "a non-repo dir throws with git's error");

  const repo = newRepo("create-errors");
  assert.throws(() => createWorktree(repo, "1 2"), /could not create worktree/, "an id that makes an invalid branch name throws");

  // CONSTANCE_WORKTREES pointing at a plain file: the mkdir for the worktree
  // parent fails before git is even asked — the raw fs error propagates.
  const blocker = path.join(root, "wts-blocker");
  fs.writeFileSync(blocker, "x\n");
  const saved = process.env.CONSTANCE_WORKTREES;
  try {
    process.env.CONSTANCE_WORKTREES = blocker;
    assert.throws(() => createWorktree(repo, 921), undefined, "an unwritable worktree root throws");
  } finally {
    process.env.CONSTANCE_WORKTREES = saved;
  }
  clean(repo);

  // Regression: createWorktree is idempotent for the same job id. It removes a
  // stale worktree folder at the same path and reuses the leftover branch
  // instead of dying on `git worktree add -b` ("branch already exists").
  {
    const repo2 = newRepo("create-twice");
    const first = createWorktree(repo2, 922);
    const second = createWorktree(repo2, 922);   // should reuse/replace cleanly
    assert.equal(second.worktree, first.worktree);
    assert.equal(second.branch, first.branch);
    assert.ok(fs.existsSync(second.worktree), "the recreated worktree exists");
    assert.equal(git(repo2, "worktree", "list", "--porcelain").split("worktree ").length - 1, 2,
      "exactly the repo plus one worktree");
    dropWorktree(repo2, second.worktree, second.branch, { deleteBranch: true });
    clean(repo2);
  }
}

// ============================================================ mergeBranch: self, empty, detached, truncation, dirty-conflict
{
  const repo = newRepo("merge-self");
  const current = repoBranch(repo);
  const before = head(repo);
  const m = mergeBranch(repo, current);
  assert.equal(m.ok, true, "merging the repo's own current branch is a no-op success");
  assert.equal(m.fastForward, false);
  assert.equal(head(repo), before, "HEAD does not move");
  clean(repo);

  assert.equal(mergeBranch(repo, null).ok, false, "a null branch fails cleanly");
  assert.equal(mergeBranch(repo, null).conflict, false);
  assert.ok(mergeBranch(repo, "").output.length > 0, "an empty branch reports git's complaint");
  assert.equal(mergeBranch(repo, "").conflict, false);
  clean(repo);
}

// A detached HEAD still merges: git lands the result on the detached HEAD.
{
  const repo = newRepo("merge-detached");
  const w = createWorktree(repo, 930);
  commitFile(w.worktree, "det.txt", "det\n", "copy det");
  const main = git(repo, "branch", "--show-current").trim();
  git(repo, "checkout", "-q", "--detach", "HEAD");
  const m = mergeBranch(repo, w.branch);
  assert.equal(m.ok, true, "a merge works on a detached HEAD");
  assert.equal(m.fastForward, true);
  assert.equal(repoBranch(repo), "", "still detached afterwards");
  assert.equal(head(repo), head(w.worktree), "the detached HEAD moved to the branch tip");
  git(repo, "checkout", "-q", main);   // back to the branch; the detached tip is abandoned, repo clean
  clean(repo);
  dropWorktree(repo, w.worktree, w.branch, { deleteBranch: true });
}

// mergeBranch truncates its failure output to the last 800 chars: many
// conflicting files produce far more, and the report must stay bounded.
{
  const repo = newRepo("merge-truncate");
  const w = createWorktree(repo, 931);
  for (let i = 0; i < 40; i++) {
    const name = `conflict-${String(i).padStart(2, "0")}.txt`;
    commitFile(repo, name, `repo ${i}\n`, `repo ${i}`);
    commitFile(w.worktree, name, `copy ${i}\n`, `copy ${i}`);
  }
  const m = mergeBranch(repo, w.branch);
  assert.equal(m.ok, false);
  assert.equal(m.conflict, true, "forty conflicting files is still a conflict");
  assert.ok(m.output.length <= 800, `output is capped at 800 chars, got ${m.output.length}`);
  assert.ok(m.output.length > 0);
  clean(repo);
  dropWorktree(repo, w.worktree, w.branch, { deleteBranch: true });
}

// A dirty file that the incoming branch also changes: git refuses before the
// merge starts, so it is NOT a conflict and the owner's edit survives.
{
  const repo = newRepo("merge-dirtyconflict");
  const w = createWorktree(repo, 932);
  commitFile(repo, "hot.txt", "base\n", "base");   // now tracked on both sides' base
  commitFile(w.worktree, "hot.txt", "copy version\n", "copy edits hot");
  fs.writeFileSync(path.join(repo, "hot.txt"), "owner edit\n");   // unstaged local change
  const m = mergeBranch(repo, w.branch);
  assert.equal(m.ok, false);
  assert.equal(m.conflict, false, "a pre-merge refusal is not a conflict");
  assert.equal(fs.readFileSync(path.join(repo, "hot.txt"), "utf8"), "owner edit\n", "the owner's edit is untouched");
  assert.equal(git(repo, "status", "--porcelain"), " M hot.txt\n");
  assert.equal(tryGit(repo, "rev-parse", "-q", "--verify", "MERGE_HEAD"), "", "no merge state left");
  dropWorktree(repo, w.worktree, w.branch, { deleteBranch: true });
}

// ============================================================ dropWorktree: more edges
{
  const repo = newRepo("drop-edges");

  // Deleting a branch that does not exist reports "kept", never throws.
  const d1 = dropWorktree(repo, null, "constance/job-999-missing", { deleteBranch: true });
  assert.ok(d1.some((s) => s.includes("kept")), "a missing branch is reported kept: " + d1.join("; "));

  // deleteBranch with no branch arg is a no-op for branches.
  assert.deepEqual(dropWorktree(repo, null, null, { deleteBranch: true }), [], "nothing to drop is a no-op");

  // A worktree path that does not exist and no branch: still a no-op.
  assert.deepEqual(dropWorktree(repo, path.join(process.env.CONSTANCE_WORKTREES, "job-933"), null, {}), [],
    "a missing worktree path with no branch is a no-op");

  // The repo's CURRENT branch can never be deleted: git refuses, the report
  // says kept, and the branch survives.
  const current = repoBranch(repo);
  const d2 = dropWorktree(repo, null, current, { deleteBranch: true });
  assert.ok(d2.some((s) => s.includes("kept")), "the current branch is reported kept: " + d2.join("; "));
  assert.ok(git(repo, "branch", "--list", current).includes(current), "the current branch still exists");

  // A worktree path that is a plain file (not a dir): removed and reported.
  const f = path.join(process.env.CONSTANCE_WORKTREES, "job-934");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "x\n");
  const d3 = dropWorktree(repo, f, null, {});
  assert.ok(d3.some((s) => s.includes("worktree removed")), "a plain file path is reported removed: " + d3.join("; "));
  assert.equal(fs.existsSync(f), false, "the file is gone");

  // Regression: dropWorktree must not report "worktree removed" or delete the
  // branch when BOTH `git worktree remove` and the rmSync fallback fail — e.g.
  // the folder's permissions were tightened (chmod 000) after creation. The
  // folder is still there afterwards, so the report must say the removal
  // failed and the branch must be kept.
  {
    const repo2 = newRepo("drop-unremovable");
    const w = createWorktree(repo2, 935);
    fs.chmodSync(w.worktree, 0o000);
    const d = dropWorktree(repo2, w.worktree, w.branch, { deleteBranch: true });
    fs.chmodSync(w.worktree, 0o700);   // restore so cleanup can run
    assert.equal(fs.existsSync(w.worktree), true,
      "an unremovable folder survives and is reported as such");
    assert.ok(d.some((s) => s.includes("removal failed")),
      "the failed removal is reported: " + d.join("; "));
    assert.ok(!d.some((s) => s.includes("worktree removed")),
      "'worktree removed' is never claimed for a folder that is still there: " + d.join("; "));
    assert.ok(d.some((s) => s.includes("kept")),
      "the branch is kept while its worktree remains: " + d.join("; "));
    assert.notEqual(git(repo2, "branch", "--list", w.branch).trim(), "", "the branch still exists");
    fs.rmSync(w.worktree, { recursive: true, force: true });
    git(repo2, "worktree", "prune");
    git(repo2, "branch", "-D", w.branch);
    clean(repo2);
  }

  clean(repo);
}

fs.rmSync(root, { recursive: true, force: true });   // the repos, worktrees and fake home, nothing else
console.log("constance-worktree.deep: tests passed");
