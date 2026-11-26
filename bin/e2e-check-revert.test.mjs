// Constance check-then-revert, end to end: one fake goal with two copy jobs in
// a temp repo and temp state dir, driven only through real
// `node bin/constance.mjs` processes.
//
//   - job 1's done file reports a failing test, so the sweep finishes it but
//     maybeSelfMerge refuses it (ownTestsPassed is false): it stays "finished"
//     and waits for review — `wait` hands it out, nothing of it is merged.
//   - job 2 reports passing tests: the sweep flags it selfMerging and spawns
//     the detached `selfmerge` process, which merges its branch into the repo
//     as a --no-ff merge commit and marks the job "merged" (pending review).
//   - `review 2 send-back` then runs git revert -m 1 on that merge commit: the
//     file is back to its pre-merge content, a Revert commit sits on top, the
//     job ends "sent back" and reviews.json records the "reverted" verdict.
//
// Every file lives under one mkdtemp dir; the children get HOME and the XDG
// vars pointed inside it, so nothing touches the real home or state folders.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "constance.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-e2e-revert-"));

const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();

function makeIter(name) {
  const iter = path.join(root, name);
  for (const d of ["home", "state", "config", "cache"]) fs.mkdirSync(path.join(iter, d), { recursive: true });
  const constanceDir = path.join(iter, "state", "omarchy", "agent-usage-tabs", "constance");
  fs.mkdirSync(constanceDir, { recursive: true });
  return { iter, home: path.join(iter, "home"), state: path.join(iter, "state"),
    config: path.join(iter, "config"), cache: path.join(iter, "cache"), constanceDir };
}

const envFor = (it) => ({ ...process.env, HOME: it.home, XDG_STATE_HOME: it.state,
  XDG_CONFIG_HOME: it.config, XDG_CACHE_HOME: it.cache });

const cli = (it, args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: envFor(it), encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, `constance.mjs ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
};

function makeRepo(it) {
  const repo = path.join(it.iter, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt"); git(repo, "commit", "-qm", "init");
  return repo;
}

// A finished-looking copy: its own worktree on constance/job-<id>, one committed
// change and the done file a real run would leave (uncommitted, in .constance/).
// `done` is the done-file JSON verbatim so each job controls its own report.
function makeCopy(repo, it, id, rel, content, done) {
  const wt = path.join(it.iter, `wt-${id}`);
  const branch = `constance/job-${id}`;
  git(repo, "worktree", "add", "-q", "-b", branch, wt, "HEAD");
  fs.writeFileSync(path.join(wt, rel), content);
  git(wt, "add", rel); git(wt, "commit", "-qm", `job ${id} work`);
  const tip = git(wt, "rev-parse", "HEAD");
  const doneDir = path.join(wt, ".constance");
  fs.mkdirSync(doneDir, { recursive: true });
  fs.writeFileSync(path.join(doneDir, `done-${id}.json`), JSON.stringify({ commit: tip, files: [rel], ...done }));
  return { worktree: wt, branch, tip, rel };
}

// A copy job as handOut would have left it mid-run: status "running" with its
// done file already in place, so the next sweep finishes it. guardChecked is
// set so the guard counts as clean (its snapshot isn't needed for this test).
function runningJob(it, repo, goalId, id, c) {
  return { id, agent: "devin", worker: `devin-${id}`, copy: true, goal: goalId,
    dir: repo, worktree: c.worktree, branch: c.branch, files: [c.rel],
    task: `change ${c.rel}`, status: "running", pid: null, startedAt: Date.now() - 1000,
    log: path.join(it.iter, `job-${id}.log`), guardChecked: true };
}

const jobsFile = (it) => path.join(it.constanceDir, "jobs.json");
const reviewsFile = (it) => path.join(it.constanceDir, "reviews.json");
const readJobs = (it) => JSON.parse(fs.readFileSync(jobsFile(it), "utf8")).jobs;
const jobById = (it, id) => readJobs(it).find((j) => j.id === id);
const readReviews = (it) => {
  try { return JSON.parse(fs.readFileSync(reviewsFile(it), "utf8")); }
  catch { return { pending: [], reviewed: [] }; }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const it = makeIter("revert");
  const repo = makeRepo(it);
  const ORIG = "a\n";
  const CHANGED = "a changed by job 2\n";

  // Job 1 reports a failing test: finished by the sweep, never self-merged.
  const c1 = makeCopy(repo, it, 1, "one.txt", "one\n",
    { summary: "job 1 done; its new check fails", report: "the new test fails: expected 1 got 2", files: ["one.txt"] });
  // Job 2 reports passing tests: self-merges, then gets sent back.
  const c2 = makeCopy(repo, it, 2, "a.txt", CHANGED,
    { summary: "job 2 done, tests passed", tests: "passed" });

  const goal = { id: 1, text: "e2e revert goal", dir: repo, status: "running", startedAt: Date.now() };
  fs.writeFileSync(jobsFile(it), JSON.stringify({ goal, jobs: [
    runningJob(it, repo, goal.id, 1, c1), runningJob(it, repo, goal.id, 2, c2)], next: 3, guards: {} }));

  // One sweep: both done files are seen. Job 1 finishes and waits for review;
  // job 2 is flagged selfMerging and its detached `selfmerge` process starts.
  cli(it, ["jobs"]);
  let j1 = jobById(it, 1), j2 = jobById(it, 2);
  assert.equal(j1.status, "finished", `job 1 ended ${j1.status}, expected finished`);
  assert.ok(!j1.selfMerging, "job 1 was flagged selfMerging despite its failing test");
  assert.equal(j2.status, "finished", `job 2 ended ${j2.status} before its self-merge`);
  assert.equal(j2.selfMerging, true, "job 2 was not flagged selfMerging");

  // The detached selfmerge runs the (empty) suite and merges under the lock.
  const deadline = Date.now() + 60000;
  for (;;) {
    j2 = jobById(it, 2);
    if (j2.status === "merged") break;
    assert.ok(Date.now() < deadline, `job 2 never merged (status ${j2.status}, ${(j2.mergeError || "").slice(-200)})`);
    await sleep(100);
  }
  j1 = jobById(it, 1);
  assert.equal(j1.status, "finished", `job 1 changed to ${j1.status} while job 2 self-merged`);

  // The merge landed: one --no-ff merge commit whose second parent is job 2's
  // tip, the file carries job 2's content, and the merge waits in reviews.json.
  const merges = git(repo, "log", "--merges", "--format=%H").split("\n").filter(Boolean);
  assert.equal(merges.length, 1, `expected exactly one merge commit, got ${merges.length}`);
  const parents = git(repo, "rev-list", "--parents", "-n", "1", merges[0]).trim().split(/\s+/);
  assert.equal(parents.length, 3, `${merges[0]} is not a two-parent merge commit`);
  assert.equal(parents[2], c2.tip, "the merge's second parent is not job 2's tip");
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), CHANGED, "job 2's change is not in the repo");
  assert.ok(!fs.existsSync(path.join(repo, "one.txt")), "job 1's file was merged even though it was never reviewed");
  const pending = readReviews(it).pending;
  assert.ok(pending.some((p) => p.job === 2), "the self-merge is not pending background review");
  assert.equal(git(repo, "branch", "--list", c2.branch).trim(), "", "job 2's branch was not cleaned up after merging");
  assert.notEqual(git(repo, "branch", "--list", c1.branch).trim(), "", "job 1's branch was touched");

  // Job 1 is what `wait` hands out: it waits for review, untouched by job 2.
  const wout = JSON.parse(cli(it, ["wait", "--timeout", "1"]));
  assert.equal(wout.review?.id, 1, `wait handed out job ${wout.review?.id}, expected job 1`);

  // Send job 2 back: the merge commit is reverted, the file returns to its
  // pre-merge content and a Revert commit sits on top of the merge.
  const out = cli(it, ["review", "2", "send-back", "--note", "e2e: revert it"]);
  assert.match(out, /Job 2 sent back/, `review send-back said: ${out.trim()}`);

  j1 = jobById(it, 1); j2 = jobById(it, 2);
  assert.equal(j1.status, "finished", `job 1 ended ${j1.status}`);
  assert.equal(j2.status, "sent back", `job 2 ended ${j2.status}`);
  assert.ok(j2.revertedAt, "job 2 has no revertedAt after the send-back");
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), ORIG, "a.txt was not restored by the revert");
  const mergeSubject = git(repo, "log", "-1", "--format=%s", merges[0]);
  assert.equal(git(repo, "log", "-1", "--format=%s"), `Revert "${mergeSubject}"`,
    "HEAD is not a Revert commit on top of the merge");
  assert.equal(git(repo, "log", "--merges", "--format=%H").split("\n").filter(Boolean).length, 1,
    "the revert added a second merge commit");
  const rv = readReviews(it);
  assert.equal(rv.pending.length, 0, "the reverted merge is still pending review");
  assert.ok(rv.reviewed.some((p) => p.job === 2 && p.verdict === "reverted"),
    `reviews.json has no reverted verdict for job 2: ${JSON.stringify(rv.reviewed)}`);
  assert.equal(git(repo, "status", "--porcelain").trim() === "", true, "repo left dirty");
}

try {
  await run();
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("constance-e2e-check-revert: tests passed");
