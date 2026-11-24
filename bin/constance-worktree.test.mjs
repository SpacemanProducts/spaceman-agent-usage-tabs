// Constance's copy worktrees: a job gets its own worktree on its own branch in a
// temp area outside the repo, commits there, and its branch merges back into the
// repo's current branch — cleanly when the files differ, and aborted (never
// forced) when they conflict.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createWorktree, mergeBranch, dropWorktree, repoBranch, worktreeFor, branchFor } from "./constance-worktree.mjs";

const root = fs.mkdtempSync(path.join(fs.existsSync("/var/tmp") ? "/var/tmp" : os.tmpdir(), "constance-wt-test-"));
const repo = path.join(root, "repo");
fs.mkdirSync(repo);
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
const gitIn = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
fs.writeFileSync(path.join(repo, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-qm", "init");
assert.equal(repoBranch(repo), git("branch", "--show-current").trim());

// A copy worktree is outside the repo, on its own branch, at the same commit.
const w1 = createWorktree(repo, 901);
assert.equal(w1.worktree, worktreeFor(901)); assert.equal(w1.branch, branchFor(901));
assert.ok(!w1.worktree.startsWith(repo), "the worktree is outside the repo");
assert.equal(fs.readFileSync(path.join(w1.worktree, ".git"), "utf8").trim().startsWith("gitdir:"), true, "a worktree .git is a pointer file");
assert.equal(repoBranch(w1.worktree), w1.branch, "the worktree is on its own branch");
assert.equal(gitIn(w1.worktree, "rev-parse", "HEAD").trim(), git("rev-parse", "HEAD").trim(), "same starting commit");

// The copy commits in its worktree; accepting merges the branch and cleans up.
fs.writeFileSync(path.join(w1.worktree, "b.txt"), "b\n"); gitIn(w1.worktree, "add", "b.txt"); gitIn(w1.worktree, "commit", "-qm", "copy b");
const m1 = mergeBranch(repo, w1.branch);
assert.equal(m1.ok, true, "a clean branch merges"); assert.ok(m1.commit);
assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "b\n", "the merged file is in the repo");
assert.ok(git("status", "--porcelain").trim() === "", "the repo is clean after the merge");
const did1 = dropWorktree(repo, w1.worktree, w1.branch, { deleteBranch: true, merged: true });
assert.ok(did1.length >= 2, "worktree and branch are cleaned: " + did1.join("; "));
assert.ok(!fs.existsSync(w1.worktree), "the worktree folder is gone");
assert.equal(git("branch", "--list", w1.branch).trim(), "", "the merged branch is deleted");

// Two copies that both touch the same file: the second merge conflicts, is
// aborted, and leaves the repo exactly as the owner left it.
const w2 = createWorktree(repo, 902), w3 = createWorktree(repo, 903);
fs.writeFileSync(path.join(w2.worktree, "a.txt"), "from copy 2\n"); gitIn(w2.worktree, "add", "a.txt"); gitIn(w2.worktree, "commit", "-qm", "copy 2 a");
fs.writeFileSync(path.join(w3.worktree, "a.txt"), "from copy 3\n"); gitIn(w3.worktree, "add", "a.txt"); gitIn(w3.worktree, "commit", "-qm", "copy 3 a");
const m2 = mergeBranch(repo, w2.branch);
assert.equal(m2.ok, true, "the first of the two merges");
const m3 = mergeBranch(repo, w3.branch);
assert.equal(m3.ok, false); assert.equal(m3.conflict, true, "the second conflicts");
assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "from copy 2\n", "the aborted merge changed nothing");
assert.equal(git("status", "--porcelain").trim(), "", "no merge is left in progress");
for (const w of [w2, w3]) dropWorktree(repo, w.worktree, w.branch, { deleteBranch: true });
assert.equal(git("worktree", "list", "--porcelain").split("worktree ").length - 1, 1, "all copy worktrees are gone");

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(path.dirname(worktreeFor(901)), { recursive: true, force: true });
console.log("constance-worktree: tests passed");
