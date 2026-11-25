// Deeper tests for constance-selfmerge.mjs: edge cases and failure paths the
// main test leaves out — a missing bin dir, output truncation, strict check
// values, a detached repo, a dirty worktree, merge failures after a good
// rebase, a revert that conflicts, corrupt review files, and real races
// between child node processes (a file-lock merge race and an unlocked one,
// plus concurrent addPending writers). Everything lives in mkdtemp throwaways
// with a fake HOME where a HOME is needed; nothing touches the real home.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runSuite, selfMerge, selfMergeBranch, addPending, pendingReviews, markReviewed, revertMerge } from "./constance-selfmerge.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-smd-"));
// The module under test, by absolute path; child processes turn it into a URL.
const SELF = path.join(path.dirname(fileURLToPath(import.meta.url)), "constance-selfmerge.mjs");
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
const sh = (dir, ...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
const okSuite = () => ({ ok: true, failed: [], output: "" });
const ALL = { ownTests: true, guard: true, diff: true };

function makeRepo(name) {
  const repo = path.join(root, name, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt"); git(repo, "commit", "-qm", "init");
  return repo;
}
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
const noMergeHead = (repo) => sh(repo, "rev-parse", "-q", "--verify", "MERGE_HEAD").status !== 0;
const cleanStatus = (dir) => git(dir, "status", "--porcelain").trim() === "";
// A worktree's git dir is a .git file pointing into the repo's worktrees dir.
const wtGitDir = (wt) => git(wt, "rev-parse", "--git-dir").trim();
const noRebaseLeft = (wt) => {
  const gd = path.isAbsolute(wtGitDir(wt)) ? wtGitDir(wt) : path.join(wt, wtGitDir(wt));
  return !fs.existsSync(path.join(gd, "rebase-merge")) && !fs.existsSync(path.join(gd, "rebase-apply"))
    && sh(wt, "rev-parse", "-q", "--verify", "REBASE_HEAD").status !== 0
    && !fs.existsSync(path.join(gd, "index.lock"));
};

// Child process helpers: real separate processes for the race tests.
const spawnNode = (file, args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [file, ...args.map(String)], { encoding: "utf8" });
  let out = "", err = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { err += d; });
  p.on("close", (code) => resolve({ code, out, err }));
});

// runSuite, no bin dir at all: an empty suite passes.
{
  const dir = path.join(root, "nobin");
  fs.mkdirSync(dir, { recursive: true });
  const s = runSuite(dir);
  assert.equal(s.ok, true); assert.deepEqual(s.failed, []);
}

// runSuite ignores anything that is not bin/*.test.mjs, and a file that throws
// counts as a failure just like one that exits non-zero.
{
  const dir = path.join(root, "suite2");
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "helper.mjs"), `process.exit(3);\n`);
  fs.writeFileSync(path.join(dir, "bin", "notes.txt"), `not a test\n`);
  fs.mkdirSync(path.join(dir, "bin", "nested"));
  fs.writeFileSync(path.join(dir, "bin", "nested", "deep.test.mjs"), `process.exit(1);\n`);
  fs.writeFileSync(path.join(dir, "bin", "aaa-throw.test.mjs"), `throw new Error("boom");\n`);
  const s = runSuite(dir);
  assert.equal(s.ok, false);
  assert.deepEqual(s.failed, ["aaa-throw.test.mjs"], "only top-level *.test.mjs files run");
  assert.ok(s.output.includes("boom"), "the thrown error reached the output");
}

// runSuite keeps only the last 2000 chars of everything the tests printed.
{
  const dir = path.join(root, "suite3");
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  const pad = "x".repeat(5000);
  fs.writeFileSync(path.join(dir, "bin", "a.test.mjs"), `console.log(${JSON.stringify(pad)}); console.log("TAIL-MARK");\n`);
  const s = runSuite(dir);
  assert.equal(s.ok, true);
  assert.ok(s.output.length <= 2000, `output truncated to 2000 chars, got ${s.output.length}`);
  assert.ok(s.output.endsWith("TAIL-MARK\n"), "the tail of the output is what survives");
  assert.ok(s.output.startsWith("x".repeat(100)), "only the last 2000 chars survive, not the head");
}

// runSuite runs each file with cwd = dir and still uses its own temp HOME even
// when the caller's env already sets HOME.
{
  const dir = path.join(root, "suite4");
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "sibling.txt"), "sibling-data\n");
  fs.writeFileSync(path.join(dir, "bin", "a.test.mjs"),
    `import fs from "node:fs";\n` +
    `if (process.cwd() !== ${JSON.stringify(dir)}) process.exit(2);\n` +
    `if (fs.readFileSync("sibling.txt", "utf8") !== "sibling-data\\n") process.exit(3);\n` +
    `if (!process.env.HOME.includes("constance-suite-home-")) process.exit(4);\n`);
  const s = runSuite(dir, { env: { ...process.env, HOME: "/nonexistent-home" } });
  assert.equal(s.ok, true, `cwd/HOME contract broke: ${s.output}`);
}

// runSuite runs Qt headless: QT_QPA_PLATFORM is offscreen even when the
// caller's session says wayland;xcb, so a test running qml6 never aborts.
{
  const dir = path.join(root, "suite-qt");
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "a.test.mjs"),
    `if (process.env.QT_QPA_PLATFORM !== "offscreen") { console.log("QT_QPA_PLATFORM=" + process.env.QT_QPA_PLATFORM); process.exit(5); }\n`);
  const s = runSuite(dir, { env: { ...process.env, QT_QPA_PLATFORM: "wayland;xcb" } });
  assert.equal(s.ok, true, `suite Qt env not offscreen: ${s.output}`);
}

// selfMerge: the default suite is runSuite, and the default merge is the
// --no-ff selfMergeBranch — a copy on an unmoved main still lands as a merge
// commit. The worktree has no bin dir, so the real suite passes trivially.
{
  const repo = makeRepo("defaults");
  const c = makeCopy(repo, 20, (wt) => commitFile(wt, "b.txt", "b\n", "copy b"));
  const r = selfMerge({ repo, worktree: c.worktree, branch: c.branch, checks: ALL });
  assert.equal(r.merged, true, JSON.stringify(r));
  assert.equal(git(repo, "log", "-1", "--format=%P").trim().split(" ").length, 2, "default merge is --no-ff");
}

// selfMerge, checks must be strictly true: missing keys and truthy non-
// booleans both stop before the suite runs.
{
  const repo = makeRepo("strictchecks");
  const c = makeCopy(repo, 21, (wt) => commitFile(wt, "b.txt", "b\n", "copy b"));
  for (const checks of [{}, { ownTests: "yes", guard: true, diff: true }, { ownTests: true, guard: 1, diff: true }, { ownTests: true, guard: true }]) {
    let suiteCalled = false, lockCalled = false;
    const r = selfMerge({ repo, worktree: c.worktree, branch: c.branch, checks,
      suite: () => { suiteCalled = true; return okSuite(); },
      lock: (fn) => { lockCalled = true; return fn(); } });
    assert.equal(r.merged, false);
    assert.match(r.reason, /check failed/);
    assert.equal(suiteCalled, false); assert.equal(lockCalled, false);
  }
  assert.equal(fs.existsSync(path.join(repo, "b.txt")), false);
}

// selfMerge on a repo with a detached HEAD: repoBranch is "", the rebase is
// skipped, and the merge still lands (on the detached line).
{
  const repo = makeRepo("detached");
  const c = makeCopy(repo, 22, (wt) => commitFile(wt, "b.txt", "b\n", "copy b"));
  git(repo, "checkout", "-q", "--detach", "HEAD");
  const r = selfMerge({ repo, worktree: c.worktree, branch: c.branch, checks: ALL, suite: okSuite });
  assert.equal(r.merged, true, JSON.stringify(r));
  assert.equal(r.retried, false, "no rebase on a detached HEAD");
  assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "b\n");
  assert.equal(noMergeHead(repo), true);
}

// selfMerge, the suite receives the worktree path, and a suite failure never
// enters the lock.
{
  const repo = makeRepo("suitearg");
  const c = makeCopy(repo, 23, (wt) => commitFile(wt, "b.txt", "b\n", "copy b"));
  const seen = [];
  let locked = false;
  const r = selfMerge({ repo, worktree: c.worktree, branch: c.branch, checks: ALL,
    suite: (dir) => { seen.push(dir); return { ok: false, failed: [], output: "" }; },
    lock: (fn) => { locked = true; return fn(); } });
  assert.equal(r.merged, false); assert.equal(r.reason, "full test suite failed");
  assert.deepEqual(seen, [c.worktree], "the suite got the copy's worktree");
  assert.equal(locked, false, "a failed suite never takes the merge lock");
}

// selfMerge, a merge that fails without a conflict reports the output tail and
// is not flagged.
{
  const repo = makeRepo("mergefail");
  const c = makeCopy(repo, 24, (wt) => commitFile(wt, "b.txt", "b\n", "copy b"));
  const long = "y".repeat(900);
  const r = selfMerge({ repo, worktree: c.worktree, branch: c.branch, checks: ALL, suite: okSuite,
    merge: () => ({ ok: false, conflict: false, output: `head ${long} tail` }) });
  assert.equal(r.merged, false);
  assert.equal(r.conflict, undefined); assert.equal(r.flagged, undefined);
  assert.ok(r.reason.length <= 400, "the reason is capped at 400 chars");
  assert.ok(r.reason.endsWith("tail"), "the reason keeps the end of the merge output");
  assert.equal(noMergeHead(repo), true);
}

// selfMerge, the merge conflicts even though the rebase was clean: flagged,
// with the retried flag telling whether the rebase had moved the branch.
{
  const repo = makeRepo("mergeconflict");
  const c = makeCopy(repo, 25, (wt) => commitFile(wt, "b.txt", "b\n", "copy b"));
  const r = selfMerge({ repo, worktree: c.worktree, branch: c.branch, checks: ALL, suite: okSuite,
    merge: () => ({ ok: false, conflict: true, output: "CONFLICT (content)" }) });
  assert.equal(r.merged, false);
  assert.equal(r.conflict, true); assert.equal(r.flagged, true);
  assert.equal(r.reason, "conflict after rebase");
  assert.equal(r.retried, false, "main never moved, so the rebase did not retry");
  assert.equal(noMergeHead(repo), true); assert.equal(cleanStatus(repo), true);
  assert.equal(noRebaseLeft(c.worktree), true, "no rebase state left in the worktree");
}

// selfMerge with a dirty worktree: the rebase refuses, is aborted, and both
// the repo and the worktree keep their uncommitted changes.
{
  const repo = makeRepo("dirtywt");
  const c = makeCopy(repo, 26, (wt) => commitFile(wt, "b.txt", "b\n", "copy b"));
  fs.writeFileSync(path.join(c.worktree, "a.txt"), "dirty\n");   // unstaged change to a tracked file
  const r = selfMerge({ repo, worktree: c.worktree, branch: c.branch, checks: ALL, suite: okSuite });
  assert.equal(r.merged, false); assert.equal(r.flagged, true);
  assert.equal(fs.readFileSync(path.join(c.worktree, "a.txt"), "utf8"), "dirty\n", "the dirty file survived the aborted rebase");
  assert.equal(noMergeHead(repo), true);
  assert.equal(fs.existsSync(path.join(repo, "b.txt")), false, "nothing merged");
}

// selfMerge with a worktree that does not exist: reported as not merged and
// flagged, and the repo is untouched. (The reason says "conflict" even though
// nothing conflicted — a missing worktree is not a merge conflict.)
{
  const repo = makeRepo("nowt");
  const r = selfMerge({ repo, worktree: path.join(root, "nowt", "ghost"), branch: "constance/job-99", checks: ALL, suite: okSuite });
  assert.equal(r.merged, false); assert.equal(r.flagged, true);
  assert.equal(noMergeHead(repo), true); assert.equal(cleanStatus(repo), true);
}

// revertMerge on a merge whose later history touched the same lines: the
// revert conflicts, is aborted, and the newer content stays.
{
  const repo = makeRepo("revertconflict");
  const c = makeCopy(repo, 27, (wt) => commitFile(wt, "a.txt", "copy\n", "copy a"));
  const m = selfMergeBranch(repo, c.branch);
  assert.equal(m.ok, true);
  commitOn(repo, "a.txt", "later\n", "main moved the same line after the merge");
  const rv = revertMerge(repo, m.commit);
  assert.equal(rv.ok, false, `expected a conflicting revert, got ${JSON.stringify(rv)}`);
  assert.equal(sh(repo, "rev-parse", "-q", "--verify", "REVERT_HEAD").status !== 0, true, "no revert left in progress");
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "later\n", "the newer line survived");
  assert.equal(cleanStatus(repo), true, "repo clean after the aborted revert");
}

// revertMerge accepts any commit-ish git understands, e.g. HEAD~1.
{
  const repo = makeRepo("revhead");
  commitOn(repo, "b.txt", "b\n", "plain work");
  const target = git(repo, "rev-parse", "HEAD~0").trim();
  assert.equal(revertMerge(repo, "HEAD").ok, true);
  assert.equal(fs.existsSync(path.join(repo, "b.txt")), false);
  assert.equal(revertMerge(repo, target).ok, false, "the commit is already reverted, second revert fails");
  assert.equal(sh(repo, "rev-parse", "-q", "--verify", "REVERT_HEAD").status !== 0, true);
}

// The pending-review file tolerates corrupt JSON: reads as empty, and the next
// addPending rewrites it cleanly. markReviewed on an unknown job in a corrupt
// file is a no-op that does not destroy the file.
{
  const file = path.join(root, "corrupt-reviews", "reviews.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{not json!!");
  assert.deepEqual(pendingReviews(file), []);
  assert.equal(markReviewed(file, 5, "ok"), null);
  assert.equal(fs.readFileSync(file, "utf8"), "{not json!!", "markReviewed on an unknown job writes nothing");
  addPending(file, { job: 5, commit: "c", branch: "b" });
  const pend = pendingReviews(file);
  assert.equal(pend.length, 1); assert.equal(pend[0].job, 5);
  assert.ok(pend[0].at > 0, "at defaults to now");
}

// addPending keeps exactly the fields it documents; anything else is dropped.
{
  const file = path.join(root, "fields.json");
  addPending(file, { job: 42, commit: "abc123", branch: "constance/job-42", at: 7, extra: "dropped" });
  const [p] = pendingReviews(file);
  assert.equal(p.commit, "abc123"); assert.equal(p.branch, "constance/job-42"); assert.equal(p.at, 7);
  assert.deepEqual(Object.keys(p).sort(), ["at", "branch", "commit", "job"]);
}

// --- Cross-process races -------------------------------------------------

// Child script for the selfMerge races: runs selfMerge with a suite stub and
// an optional mkdir-based lock directory, so two real processes can serialize
// (or not) exactly like withMergeLock does in production.
const SM_CHILD = path.join(root, "sm-child.mjs");
fs.writeFileSync(SM_CHILD, `import fs from "node:fs";
import { pathToFileURL } from "node:url";
const [mod, repo, wt, branch, lockDir] = process.argv.slice(2);
const { selfMerge } = await import(pathToFileURL(mod).href);
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const lock = lockDir ? (fn) => {
  const deadline = Date.now() + 60000;
  for (;;) {
    try { fs.mkdirSync(lockDir); break; }
    catch (e) { if (e.code !== "EEXIST" || Date.now() > deadline) throw e; nap(25); }
  }
  try { return fn(); } finally { fs.rmSync(lockDir, { recursive: true, force: true }); }
} : (fn) => fn();
const r = selfMerge({ repo, worktree: wt, branch, checks: { ownTests: true, guard: true, diff: true },
  suite: () => ({ ok: true, failed: [], output: "" }), lock });
console.log("RESULT " + JSON.stringify(r));
`);

// Two copies self-merge at the same time under a shared file lock: they
// serialize like production's withMergeLock, so the second rebases onto the
// first's merge and both changes land.
{
  const repo = makeRepo("race-locked");
  const a = makeCopy(repo, 30, (wt) => commitFile(wt, "ra.txt", "a\n", "copy a"));
  const b = makeCopy(repo, 31, (wt) => commitFile(wt, "rb.txt", "b\n", "copy b"));
  const lockDir = path.join(root, "race-locked", "merge.lock");
  const [ra, rb] = await Promise.all([
    spawnNode(SM_CHILD, [SELF, repo, a.worktree, a.branch, lockDir]),
    spawnNode(SM_CHILD, [SELF, repo, b.worktree, b.branch, lockDir]),
  ]);
  assert.equal(ra.code, 0, ra.err); assert.equal(rb.code, 0, rb.err);
  const pa = JSON.parse(ra.out.match(/RESULT (.*)/)[1]);
  const pb = JSON.parse(rb.out.match(/RESULT (.*)/)[1]);
  assert.equal(pa.merged, true, JSON.stringify(pa)); assert.equal(pb.merged, true, JSON.stringify(pb));
  assert.equal(fs.readFileSync(path.join(repo, "ra.txt"), "utf8"), "a\n");
  assert.equal(fs.readFileSync(path.join(repo, "rb.txt"), "utf8"), "b\n");
  assert.deepEqual([pa.retried, pb.retried].sort(), [false, true], "the loser of the lock rebased onto the winner's merge");
  assert.equal(noMergeHead(repo), true); assert.equal(cleanStatus(repo), true);
  assert.equal(noRebaseLeft(a.worktree) && noRebaseLeft(b.worktree), true);
  assert.equal(fs.existsSync(lockDir), false, "the lock dir is released");
}

// The same two copies with NO shared lock: the rebase+merge pair can collide
// on the repo's own git locks. Whatever the timing, no merge or rebase state
// may survive and every merge that reported success must be in the tree.
// NOTE: `git status --porcelain` is deliberately NOT asserted clean here —
// see the commented-out BUG block below for the dirty-index case this race
// can produce in mergeBranch.
{
  const repo = makeRepo("race-free");
  const a = makeCopy(repo, 32, (wt) => commitFile(wt, "fa.txt", "a\n", "copy a"));
  const b = makeCopy(repo, 33, (wt) => commitFile(wt, "fb.txt", "b\n", "copy b"));
  const results = await Promise.all([
    spawnNode(SM_CHILD, [SELF, repo, a.worktree, a.branch, ""]),
    spawnNode(SM_CHILD, [SELF, repo, b.worktree, b.branch, ""]),
  ]);
  const parsed = results.map((r) => {
    assert.equal(r.code, 0, r.err);
    return JSON.parse(r.out.match(/RESULT (.*)/)[1]);
  });
  for (const [i, m] of parsed.entries()) {
    const file = i === 0 ? "fa.txt" : "fb.txt";
    if (m.merged) assert.equal(fs.readFileSync(path.join(repo, file), "utf8"), i === 0 ? "a\n" : "b\n", "a reported merge is really in the tree");
    else assert.equal(m.merged, false);
  }
  assert.equal(noMergeHead(repo), true, "no merge state survives the race");
  for (const wt of [a.worktree, b.worktree]) assert.equal(noRebaseLeft(wt), true, "no rebase state survives");
}

// BUG (found by the race above, left unfixed per the task): when two merges
// run without the merge lock, the loser's `git merge` can fail at
// `update_ref failed for ref 'HEAD'` AFTER the ort strategy already staged the
// merge result. mergeBranch then sees no MERGE_HEAD, reports
// { ok:false, conflict:false }, and selfMerge reports a plain failure — but
// the repo is left dirty mid-merge (observed: `A fa.txt`, `D fb.txt`,
// `?? fb.txt` in git status --porcelain). Nothing aborts or verifies the
// post-merge state. Production always merges under withMergeLock so this
// needs a lock failure or a bypass to trigger, but the cleanup path is still
// wrong. This commented-out test asserts the invariant that SHOULD hold; it
// fails intermittently until mergeBranch is fixed.
// {
//   const repo = makeRepo("race-free-strict");
//   const a = makeCopy(repo, 34, (wt) => commitFile(wt, "ga.txt", "a\n", "copy a"));
//   const b = makeCopy(repo, 35, (wt) => commitFile(wt, "gb.txt", "b\n", "copy b"));
//   await Promise.all([
//     spawnNode(SM_CHILD, [SELF, repo, a.worktree, a.branch, ""]),
//     spawnNode(SM_CHILD, [SELF, repo, b.worktree, b.branch, ""]),
//   ]);
//   assert.equal(cleanStatus(repo), true, "a failed merge must not leave staged changes behind");
// }

// Many processes addPending into the same reviews file at once.
// readReviews + writeReviews is a read-modify-write with NO lock, so writers
// that overlap lose each other's entries (observed: 83 of 200 adds survived
// with 8 processes x 25 adds). Production hits this whenever two selfmerge
// children finish close together: one merge's pending review silently
// disappears. What runs here checks the file stays well-formed JSON with
// unique jobs; the strict no-loss invariant runs below now that writers lock.
const PENDING_CHILD = path.join(root, "pending-child.mjs");
fs.writeFileSync(PENDING_CHILD, `import { pathToFileURL } from "node:url";
const [mod, file, base, n] = process.argv.slice(2);
const { addPending } = await import(pathToFileURL(mod).href);
for (let i = 0; i < Number(n); i++) addPending(file, { job: Number(base) + i, commit: "c" + i, branch: "b" + i });
console.log("done");
`);
{
  const file = path.join(root, "race-reviews.json");
  const kids = 8, per = 25;
  const runs = [];
  for (let k = 0; k < kids; k++) runs.push(spawnNode(PENDING_CHILD, [SELF, file, k * per, per]));
  const res = await Promise.all(runs);
  for (const r of res) assert.equal(r.code, 0, r.err);
  const pend = pendingReviews(file);
  assert.ok(pend.length > 0, "at least one writer's entries landed");
  const jobs = new Set(pend.map((p) => p.job));
  assert.equal(jobs.size, pend.length, "surviving entries are unique, none half-written");
  for (const p of pend) assert.ok(p.job >= 0 && p.commit && p.branch, "every entry is well-formed");
}
// addPending/markReviewed serialize on a `<file>.lock` directory (the same
// pid-owned lock as merges), so no writer's entries are lost: all 200 adds
// from 8 racing processes must land.
{
  const file = path.join(root, "race-reviews-strict.json");
  const kids = 8, per = 25;
  const res = await Promise.all(Array.from({ length: kids }, (_, k) =>
    spawnNode(PENDING_CHILD, [SELF, file, k * per, per])));
  for (const r of res) assert.equal(r.code, 0, r.err);
  assert.equal(pendingReviews(file).length, kids * per, "no addPending may be lost");
}

fs.rmSync(root, { recursive: true, force: true });
console.log("constance-selfmerge.deep: tests passed");
