// Constance guard vs a copy's self-merge, end to end: a shared-folder job
// (no worktree — e.g. a read-only Grok job in the project folder) whose run
// overlaps a Devin copy's self-merge must not be guard-checked against the
// merge's commits. Driven only through real `node bin/constance.mjs` sweeps
// (`jobs`) against a temp repo and temp state dir, with jobs.json crafted the
// way handOut/maybeSelfMerge/the selfmerge process leave it.
//
//   - merge already recorded: the shared job finishes, the sweep excuses the
//     copy's merge commit and everything it pulled in — no violation, the
//     copy's file stays, nothing is reverted.
//   - merge still in flight (copy selfMerging, no mergeCommit yet): the
//     shared job's guard defers WITHOUT guardChecked; once the merge lands
//     and is recorded, the next sweep checks it and excuses the same way.
//   - the shared job's OWN merge of a branch with outside files is still a
//     violation: badCommits are reverted as before.
//
// Every file lives under one mkdtemp dir; the children get HOME and the XDG
// vars pointed inside it, so nothing touches the real home or state folders.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { snapshot, mergedInCommits } from "./constance-guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "constance.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-guard-merge-"));

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
function makeCopy(repo, it, id, rel, content) {
  const wt = path.join(it.iter, `wt-${id}`);
  const branch = `constance/job-${id}`;
  git(repo, "worktree", "add", "-q", "-b", branch, wt, "HEAD");
  fs.writeFileSync(path.join(wt, rel), content);
  git(wt, "add", rel); git(wt, "commit", "-qm", `job ${id} work`);
  const tip = git(wt, "rev-parse", "HEAD");
  const doneDir = path.join(wt, ".constance");
  fs.mkdirSync(doneDir, { recursive: true });
  fs.writeFileSync(path.join(doneDir, `done-${id}.json`),
    JSON.stringify({ summary: `job ${id} done, tests passed`, commit: tip, files: [rel], tests: "passed" }));
  return { worktree: wt, branch, tip, rel };
}

// A shared-folder job mid-run: status "running" with its done file already in
// place in the repo's .constance/, so the next sweep finishes it and runs the
// guard. guardBefore is the pre-run snapshot taken before the copy's merge.
function sharedJob(it, repo, id, before, files = []) {
  const doneDir = path.join(repo, ".constance");
  fs.mkdirSync(doneDir, { recursive: true });
  fs.writeFileSync(path.join(doneDir, `done-${id}.json`),
    JSON.stringify({ summary: `job ${id} done`, commit: "", files }));
  const log = path.join(it.iter, `job-${id}.log`); fs.writeFileSync(log, "");
  return { id, agent: "grok", worker: "grok-1", goal: null, dir: repo, files,
    task: "look around, change nothing", status: "running", pid: null,
    startedAt: Date.now() - 60e3, log, guardBefore: before };
}

// A copy job as the selfmerge process leaves it once merged: status "merged",
// mergeCommit recorded, worktree dropped (branch kept until cleanup).
function mergedCopyJob(it, repo, id, c, mergeSha, extra = {}) {
  return { id, agent: "devin", worker: `devin-${id}`, copy: true, goal: null,
    dir: repo, worktree: "", branch: c.branch, files: [c.rel],
    task: `add ${c.rel}`, status: "merged", summary: `job ${id} done, tests passed`,
    commit: c.tip, mergeCommit: mergeSha, startedAt: Date.now() - 120e3,
    finishedAt: Date.now() - 90e3, mergedAt: Date.now() - 60e3,
    log: path.join(it.iter, `copy-${id}.log`), ...extra };
}

// The same copy mid-self-merge: finished, guard clean, flagged selfMerging
// while its detached selfmerge runs — mergeCommit not recorded yet.
function mergingCopyJob(it, repo, id, c) {
  return { id, agent: "devin", worker: `devin-${id}`, copy: true, goal: null,
    dir: repo, worktree: c.worktree, branch: c.branch, files: [c.rel],
    task: `add ${c.rel}`, status: "finished", summary: `job ${id} done, tests passed`,
    commit: c.tip, startedAt: Date.now() - 120e3, finishedAt: Date.now() - 90e3,
    log: path.join(it.iter, `copy-${id}.log`), guardChecked: true,
    selfMerging: true, selfMergeAt: Date.now() };
}

const jobsFile = (it) => path.join(it.constanceDir, "jobs.json");
const writeJobs = (it, jobs) => fs.writeFileSync(jobsFile(it), JSON.stringify({ goal: null, jobs, next: 10, guards: {} }));
const readJobs = (it) => JSON.parse(fs.readFileSync(jobsFile(it), "utf8")).jobs;
const jobById = (it, id) => readJobs(it).find((j) => j.id === id);

// Land the copy's branch in the repo the way selfMergeBranch does: a --no-ff
// merge commit whose second parent is the copy's tip.
function landMerge(repo, c) {
  git(repo, "merge", "--no-ff", "-m", `Merge branch '${c.branch}'`, c.branch);
  return git(repo, "rev-parse", "HEAD");
}

async function run() {
  // ---- scenario 1: the copy's self-merge is already recorded when the shared
  // job's guard runs. Without the fix its ownCommits (before.head..HEAD) hold
  // the merge and the branch commit, both outside the read-only job's list.
  {
    const it = makeIter("recorded");
    const repo = makeRepo(it);
    const env = envFor(it);
    const before = snapshot(env, repo);
    const c = makeCopy(repo, it, 2, "copy.txt", "copy work\n");
    const mergeSha = landMerge(repo, c);
    const j1 = sharedJob(it, repo, 1, before);
    writeJobs(it, [j1, mergedCopyJob(it, repo, 2, c, mergeSha)]);

    // mergedInCommits itself: the merge plus its branch-side commits; a plain
    // commit or junk is never a merge.
    const brought = mergedInCommits(repo, mergeSha);
    assert.ok(brought.includes(mergeSha) && brought.includes(c.tip), `mergedInCommits: ${brought}`);
    assert.deepEqual(mergedInCommits(repo, c.tip), [], "a non-merge commit lists nothing");
    assert.deepEqual(mergedInCommits(repo, "not-a-hash"), [], "junk lists nothing");

    cli(it, ["jobs"]);
    const done = jobById(it, 1);
    assert.equal(done.status, "finished", `job 1 ended ${done.status}`);
    assert.equal(done.guardChecked, true, "the guard ran");
    assert.ok(!done.guardViolation?.length, `no violation: ${JSON.stringify(done.guardViolation)}`);
    assert.equal(fs.readFileSync(path.join(repo, "copy.txt"), "utf8"), "copy work\n",
      "the copy's merged file was reverted by the shared job's guard");
    assert.equal(git(repo, "log", "--merges", "--format=%H").split("\n").filter(Boolean).length, 1,
      "the self-merge commit is gone — the guard reverted accepted work");
    assert.equal(git(repo, "log", "-1", "--format=%s").startsWith("Revert"), false,
      "a stray Revert commit sits on top of the merge");
    fs.rmSync(it.iter, { recursive: true, force: true });
  }

  // ---- scenario 2: the copy's self-merge is still in flight when the shared
  // job finishes. The guard must defer (no guardChecked, guardDeferred set);
  // once the merge lands and is recorded, the NEXT sweep checks and excuses.
  {
    const it = makeIter("inflight");
    const repo = makeRepo(it);
    const env = envFor(it);
    const before = snapshot(env, repo);
    const c = makeCopy(repo, it, 2, "copy.txt", "copy work\n");
    const j1 = sharedJob(it, repo, 1, before);
    writeJobs(it, [j1, mergingCopyJob(it, repo, 2, c)]);

    cli(it, ["jobs"]);
    let done = jobById(it, 1);
    assert.equal(done.status, "finished", `job 1 ended ${done.status}`);
    assert.ok(!done.guardChecked, "the guard checked while the self-merge was still in flight");
    assert.equal(done.guardDeferred, true, "the deferred check was not marked for the next sweep");
    assert.ok(!fs.existsSync(path.join(repo, "copy.txt")), "precondition: the merge has not landed yet");

    // The selfmerge process lands the merge and records it, exactly like
    // runSelfMerge's store.update does (status merged, mergeCommit, worktree
    // dropped, selfMerging cleared).
    const mergeSha = landMerge(repo, c);
    const jobs = readJobs(it).map((k) => k.id === 2
      ? { ...k, status: "merged", mergeCommit: mergeSha, worktree: "", mergedAt: Date.now(),
          selfMerging: undefined, selfMergePid: undefined, selfMergeAt: undefined }
      : k);
    // JSON.stringify drops undefined keys, matching the real delete.
    fs.writeFileSync(jobsFile(it), JSON.stringify({ goal: null, jobs, next: 10, guards: {} }));

    cli(it, ["jobs"]);
    done = jobById(it, 1);
    assert.equal(done.guardChecked, true, "the deferred guard never re-ran on a later sweep");
    assert.ok(!done.guardViolation?.length, `no violation after the merge landed: ${JSON.stringify(done.guardViolation)}`);
    assert.ok(!done.guardDeferred, "guardDeferred was not cleared once checked");
    assert.equal(fs.readFileSync(path.join(repo, "copy.txt"), "utf8"), "copy work\n",
      "the copy's merged file was reverted by the shared job's guard");
    fs.rmSync(it.iter, { recursive: true, force: true });
  }

  // ---- scenario 3: a merge the shared job's agent made ITSELF (no copy job
  // recorded it) is still a violation: the guard reverts the bad commits.
  {
    const it = makeIter("ownmerge");
    const repo = makeRepo(it);
    const env = envFor(it);
    const before = snapshot(env, repo);
    // The "agent" branches off, adds a file outside its (empty) list, and
    // merges the branch back into the shared folder during its run.
    git(repo, "checkout", "-qb", "feature");
    fs.writeFileSync(path.join(repo, "outside.txt"), "outside\n");
    git(repo, "add", "outside.txt"); git(repo, "commit", "-qm", "feature work");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "--no-ff", "-m", "Merge branch 'feature'", "feature");
    const j1 = sharedJob(it, repo, 1, before);
    writeJobs(it, [j1]);

    cli(it, ["jobs"]);
    const done = jobById(it, 1);
    assert.equal(done.status, "finished", `job 1 ended ${done.status}`);
    assert.equal(done.guardChecked, true, "the guard ran");
    assert.ok(done.guardViolation?.length, "the agent's own merge was not flagged");
    assert.ok(!fs.existsSync(path.join(repo, "outside.txt")),
      "the outside file the agent's own merge brought in was not reverted");
    fs.rmSync(it.iter, { recursive: true, force: true });
  }
}

try {
  await run();
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("constance-guard-merge: tests passed");
