// Constance's post-run guardrails in a scratch HOME/projects dir and git repo:
// a clean run passes, a run that touches files outside its list is caught —
// every new commit is checked, reported or not — home/projects differences are
// only notices, and only the run's own verified commits are reverted: nothing
// is ever deleted, moved, checked out or cleaned.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { snapshot, checkRun, restoreRun, changedPaths, commitFromRun, newCommits, fileCap } from "./constance-guard.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-guard-"));
const home = path.join(root, "home"), projects = path.join(home, "Projects"), repo = path.join(projects, "app");
fs.mkdirSync(projects, { recursive: true }); fs.mkdirSync(repo);
const env = { HOME: home, SQUAD_PROJECTS: projects };
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
fs.writeFileSync(path.join(repo, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-qm", "init");
// Same exclusion the real delegate() sets up: .constance/ never shows in status.
fs.writeFileSync(path.join(repo, ".git/info/exclude"), ".constance/\n");
fs.mkdirSync(path.join(repo, ".constance"));
fs.writeFileSync(path.join(repo, ".constance", "done-1.json"), '{"summary":"ok","commit":""}');

const before = snapshot(env, repo);
assert.deepEqual(before.home, ["Projects"], "home snapshot lists top-level names");
assert.match(before.head, /^[0-9a-f]{40}$/, "the pre-run HEAD is recorded");
assert.deepEqual(before.projects, ["app"]);

// A clean run: allowed file committed, done file ignored -> no violations.
fs.writeFileSync(path.join(repo, "b.txt"), "b\n"); git("add", "b.txt"); git("commit", "-qm", "add b");
const cleanCommit = git("rev-parse", "HEAD").trim();
let res = checkRun({ dir: repo, files: ["b.txt"], commit: cleanCommit, before, env });
assert.equal(res.ok, true, JSON.stringify(res.violations));
assert.deepEqual(res.badPaths, []);

// Uncommitted leftovers count too: an allowed file plus a stray one.
fs.writeFileSync(path.join(repo, "stray.txt"), "x\n");
res = checkRun({ dir: repo, files: ["b.txt"], commit: cleanCommit, before, env });
assert.equal(res.ok, false);
assert.ok(res.violations.some((v) => v.includes("stray.txt")), "stray.txt flagged: " + res.violations);
fs.rmSync(path.join(repo, "stray.txt"));

// A file outside the allowed list inside the commit is flagged.
fs.writeFileSync(path.join(repo, "c.txt"), "c\n"); git("add", "c.txt"); git("commit", "-qm", "add c");
const badCommit = git("rev-parse", "HEAD").trim();
res = checkRun({ dir: repo, files: ["b.txt"], commit: badCommit, before, env });
assert.equal(res.ok, false);
assert.ok(res.badPaths.includes("c.txt"));

// A read-only job (no files) flags ANY change.
res = checkRun({ dir: repo, files: [], commit: badCommit, before, env });
assert.equal(res.ok, false, "read-only jobs may not change anything");

// A new folder in ~/Projects during the run is only a notice: the agent's home
// is an empty tmpfs, so the projects folder is the owner's own.
const projBefore = snapshot(env, repo);
fs.mkdirSync(path.join(projects, "sneaky-app"));
fs.writeFileSync(path.join(projects, "sneaky-app", "keep.txt"), "k\n");
res = checkRun({ dir: repo, files: ["b.txt"], commit: "", before: projBefore, env });
assert.equal(res.ok, true, "home/projects differences are not violations: " + res.violations);
assert.ok(res.notices.some((n) => n.includes("sneaky-app")), "new project folder noticed: " + res.notices);
assert.deepEqual(res.addedProjects, ["sneaky-app"]);

// restoreRun reverts the run's own commit and touches nothing else: the new
// project folder (which may be the owner's) stays exactly where it is.
let did = restoreRun({ dir: repo, commit: badCommit, badPaths: ["c.txt"], addedProjects: ["sneaky-app"] });
assert.ok(did.some((d) => d.startsWith("reverted commit")), did.join("; "));
assert.ok(did.some((d) => d.includes("left in place") && d.includes("sneaky-app")), did.join("; "));
assert.equal(fs.readFileSync(path.join(projects, "sneaky-app", "keep.txt"), "utf8"), "k\n", "the project folder is never moved");
assert.ok(!fs.existsSync(path.join(repo, ".constance", "quarantine")), "no quarantine moves");
assert.equal(git("status", "--porcelain").trim(), "", "worktree is clean after the revert");
assert.ok(!fs.existsSync(path.join(repo, "c.txt")), "reverted file is gone");
fs.rmSync(path.join(projects, "sneaky-app"), { recursive: true });

// The owner's own uncommitted and untracked work, there before the run, is never
// blamed on the agent and never touched — even when the run also leaves a stray.
fs.writeFileSync(path.join(repo, "a.txt"), "owner edit\n");
fs.writeFileSync(path.join(repo, "owner-draft.md"), "draft\n");
const ownerBefore = snapshot(env, repo);
fs.writeFileSync(path.join(repo, "stray2.txt"), "x\n");
res = checkRun({ dir: repo, files: ["b.txt"], commit: "", before: ownerBefore, env });
assert.deepEqual(res.badPaths, ["stray2.txt"], "only the run's own stray is flagged: " + res.badPaths);
did = restoreRun({ dir: repo, commit: "", badPaths: res.badPaths });
assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "owner edit\n", "owner's edit kept");
assert.equal(fs.readFileSync(path.join(repo, "owner-draft.md"), "utf8"), "draft\n", "owner's untracked file kept");
assert.ok(fs.existsSync(path.join(repo, "stray2.txt")), "even the stray is only reported, never deleted");
fs.rmSync(path.join(repo, "stray2.txt")); fs.rmSync(path.join(repo, "owner-draft.md")); git("checkout", "--", "a.txt");

// A reported commit that the run didn't make (an older one) is never trusted:
// it's flagged, its files aren't blamed, and it's never reverted.
const runBefore = snapshot(env, repo);
assert.equal(commitFromRun(repo, cleanCommit, runBefore.head), false, "an old commit is not this run's");
assert.equal(commitFromRun(repo, runBefore.head, runBefore.head), false, "the pre-run HEAD is not this run's");
res = checkRun({ dir: repo, files: [], commit: cleanCommit, before: runBefore, env });
assert.equal(res.ownCommit, "");
assert.ok(res.violations.some((v) => v.includes("not a new commit")), res.violations.join("; "));
assert.deepEqual(res.badPaths, [], "the old commit's files are not blamed on this run");
fs.writeFileSync(path.join(repo, "e.txt"), "e\n"); git("add", "e.txt"); git("commit", "-qm", "add e");
assert.equal(commitFromRun(repo, git("rev-parse", "HEAD").trim(), runBefore.head), true, "a new commit on the branch is the run's");

// A revert that can't apply cleanly is aborted: no half-reverted tree.
fs.writeFileSync(path.join(repo, "e.txt"), "e2\n"); git("commit", "-qam", "owner changes e");
const eCommit = git("rev-list", "-n1", "HEAD~1").trim();
did = restoreRun({ dir: repo, commit: eCommit });
assert.ok(did.some((d) => d.startsWith("could not revert")), did.join("; "));
assert.equal(git("status", "--porcelain").trim(), "", "the tree is as it was");
assert.equal(fs.readFileSync(path.join(repo, "e.txt"), "utf8"), "e2\n");

// Home-level additions are notices, never violations or auto-touches; hidden
// churn is ignored entirely.
fs.writeFileSync(path.join(home, "stray-home-file"), "x");
fs.mkdirSync(path.join(home, ".cache-churn"));
res = checkRun({ dir: repo, files: ["b.txt"], commit: "", before, env });
assert.ok(res.notices.some((n) => n.includes("stray-home-file")), "home additions noticed: " + res.notices);
assert.ok(!res.violations.some((v) => v.includes("stray-home-file")), "home additions are not violations");
assert.ok(!res.notices.some((n) => n.includes("cache-churn")), "dotfile churn is ignored");
assert.ok(fs.existsSync(path.join(home, "stray-home-file")), "home entries are only reported, never moved");

// newCommits lists baseHead..HEAD oldest first; a missing or bogus base is [].
assert.deepEqual(newCommits(repo, ""), []);
assert.deepEqual(newCommits(repo, "0".repeat(40)), []);
assert.deepEqual(newCommits(repo, before.head).length > 0, true, "commits since the pre-run HEAD are listed");

// Finding 5: in a shared folder, a commit nobody attributed to this job (the
// owner's, another job's merge) is never blamed on it and never reverted.
const unrepBefore = snapshot(env, repo);
fs.writeFileSync(path.join(repo, "f.txt"), "f\n"); git("add", "f.txt"); git("commit", "-qm", "someone else's commit");
const unrepCommit = git("rev-parse", "HEAD").trim();
res = checkRun({ dir: repo, files: ["b.txt"], commit: "", before: unrepBefore, env });
assert.equal(res.ok, true, "a foreign commit in a shared folder is not this job's violation: " + res.violations.join("; "));
assert.deepEqual(res.ownCommits, []);
assert.deepEqual(res.badCommits, [], "a foreign commit is never a bad commit");
assert.deepEqual(res.foreignCommits, [unrepCommit], "it is listed as foreign");
did = restoreRun({ dir: repo, commits: [unrepCommit] });
assert.ok(did.some((d) => d.includes("not this job's")), "restoreRun refuses an unattributed commit: " + did.join("; "));
assert.ok(fs.existsSync(path.join(repo, "f.txt")), "the foreign commit's file is still there");

// In a copy's own worktree, a commit Constance didn't make is flagged (and its
// files checked), but still never reverted.
res = checkRun({ dir: repo, files: ["b.txt"], commit: "", before: unrepBefore, env, ownTree: true });
assert.equal(res.ok, false);
assert.ok(res.violations.some((v) => v.includes("didn't make")), res.violations.join("; "));
assert.ok(res.badPaths.includes("f.txt"), "its files are checked: " + res.badPaths);
assert.deepEqual(res.badCommits, [], "still nothing to revert");

// Two new commits, the attributed one good: the other is foreign, not bad.
const twoBefore = snapshot(env, repo);
fs.writeFileSync(path.join(repo, "g.txt"), "g\n"); git("add", "g.txt"); git("commit", "-qm", "good g");
const goodCommit = git("rev-parse", "HEAD").trim();
fs.writeFileSync(path.join(repo, "h.txt"), "h\n"); git("add", "h.txt"); git("commit", "-qm", "foreign h");
const badH = git("rev-parse", "HEAD").trim();
res = checkRun({ dir: repo, files: ["g.txt"], commit: goodCommit, before: twoBefore, env });
assert.deepEqual(res.ownCommits, [goodCommit], "only the attributed commit is the job's");
assert.deepEqual(res.foreignCommits, [badH]);
assert.deepEqual(res.badCommits, []);
assert.equal(res.ownCommit, goodCommit);
assert.ok(!res.badPaths.includes("h.txt"), "a foreign commit's files are not blamed: " + res.badPaths.join(","));
assert.equal(res.ok, true);

// An attributed commit touching an outside file is bad, and only it reverts.
const okBefore = snapshot(env, repo);
fs.writeFileSync(path.join(repo, "i.txt"), "i\n"); fs.writeFileSync(path.join(repo, "i-out.txt"), "o\n");
git("add", "i.txt", "i-out.txt"); git("commit", "-qm", "attributed i");
const iCommit = git("rev-parse", "HEAD").trim();
res = checkRun({ dir: repo, files: ["i.txt"], commit: iCommit, before: okBefore, env });
assert.deepEqual(res.badCommits, [iCommit]);
did = restoreRun({ dir: repo, commits: res.badCommits, attributed: res.ownCommits });
assert.ok(did.some((d) => d.startsWith("reverted commit")), did.join("; "));
assert.ok(!fs.existsSync(path.join(repo, "i-out.txt")), "the attributed bad commit was reverted");

// Nothing is reverted on top of uncommitted tracked changes.
fs.writeFileSync(path.join(repo, "j.txt"), "j\n"); git("add", "j.txt"); git("commit", "-qm", "j");
const jCommit = git("rev-parse", "HEAD").trim();
fs.writeFileSync(path.join(repo, "a.txt"), "owner's edit\n");
did = restoreRun({ dir: repo, commit: jCommit });
assert.ok(did.some((d) => d.includes("uncommitted changes")), did.join("; "));
assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "owner's edit\n", "the owner's edit is untouched");
git("checkout", "--", "a.txt");

// changedPaths sees committed and dirty paths but ignores .constance/.
assert.deepEqual(changedPaths(repo, ""), [], "clean tree, no commit: nothing");
fs.writeFileSync(path.join(repo, "d.txt"), "d\n");
assert.deepEqual(changedPaths(repo, ""), ["d.txt"]);
fs.rmSync(path.join(repo, "d.txt"));

// fileCap: clean agents uncapped, one strike -> 3 files, two+ -> 1.
assert.equal(fileCap(0), Infinity);
assert.equal(fileCap(1), 3);
assert.equal(fileCap(2), 1);
assert.equal(fileCap(5), 1);

fs.rmSync(root, { recursive: true, force: true });
console.log("constance-guard: tests passed");
