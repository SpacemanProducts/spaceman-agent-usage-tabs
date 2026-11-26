// Constance self-merge race, end to end: two finished copy jobs flagged
// selfMerging are merged by two real `constance.mjs selfmerge ID` processes
// started at the same moment, against one temp repo and one temp state dir.
// The suite delay (CONSTANCE_SELFMERGE_SUITE_DELAY_MS) makes both children
// reach the merge lock together, so the loser really waits on it.
//
// Asserts, for non-overlapping files repeated 5 times and once more with both
// copies on the same file:
//   - both merges land as separate --no-ff merge commits (one lands, the other
//     ends "conflict" after its rebase retry when the file overlaps),
//   - the merge lock is never observed held by both at once,
//   - no job is left with selfMerging set afterwards,
//   - merge.lock (and any takeover leftovers) is gone at the end,
//   - `wait` hands out the already-merged job while the racers are still
//     self-merging and a just-finished job is still settling — never either
//     of those.
// Every file lives under one mkdtemp dir; the children get HOME and the XDG
// vars pointed inside it, so nothing touches the real home or state folders.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "constance.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-e2e-selfmerge-"));

const SUITE_DELAY_MS = "700";
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
const sh = (dir, ...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });

function makeIter(name) {
  const iter = path.join(root, name);
  for (const d of ["home", "state", "config", "cache"]) fs.mkdirSync(path.join(iter, d), { recursive: true });
  const constanceDir = path.join(iter, "state", "omarchy", "agent-usage-tabs", "constance");
  fs.mkdirSync(constanceDir, { recursive: true });
  return { iter, home: path.join(iter, "home"), state: path.join(iter, "state"),
    config: path.join(iter, "config"), cache: path.join(iter, "cache"), constanceDir };
}

const envFor = (it) => ({ ...process.env, HOME: it.home, XDG_STATE_HOME: it.state,
  XDG_CONFIG_HOME: it.config, XDG_CACHE_HOME: it.cache, CONSTANCE_SELFMERGE_SUITE_DELAY_MS: SUITE_DELAY_MS });

function makeRepo(it) {
  const repo = path.join(it.iter, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt"); git(repo, "commit", "-qm", "init");
  return repo;
}

// A finished copy: its own worktree on constance/job-<id>, one committed file
// and the done file a real run would leave (uncommitted, inside .constance/).
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

const jobLog = (it, id) => { const f = path.join(it.iter, `job-${id}.log`); fs.writeFileSync(f, ""); return f; };

// A copy job exactly as maybeSelfMerge + spawnSelfMerge leave it: finished,
// guard clean, flagged selfMerging while its detached selfmerge runs.
function racerJob(it, repo, id, c) {
  return { id, agent: "devin", worker: "devin-1", copy: true, goal: null,
    dir: repo, worktree: c.worktree, branch: c.branch, files: [c.rel],
    task: `add ${c.rel}`, status: "finished", summary: `job ${id} done, tests passed`,
    commit: c.tip, finishedAt: Date.now(), log: jobLog(it, id), guardChecked: true,
    selfMerging: true, selfMergeAt: Date.now() };
}

// Two jobs wait must never hand out mid-race: one already "merged" (the
// reviewable one — its finishedAt is oldest so it wins the sort), one
// "finished" but still settling (in Constance's hands for SETTLE_MS).
function probeJobs(it, repo) {
  return [
    { id: 3, agent: "devin", worker: "devin-1", copy: true, goal: null, dir: repo,
      worktree: "", branch: "constance/job-3", files: ["m.txt"], task: "earlier merged work",
      status: "merged", summary: "already merged", commit: "", mergeCommit: "",
      finishedAt: 1, mergedAt: 2, log: jobLog(it, 3) },
    { id: 4, agent: "devin", worker: "devin-2", copy: true, goal: null, dir: repo,
      worktree: "", branch: "", files: ["s.txt"], task: "just finished", status: "finished",
      summary: "just finished", commit: "", finishedAt: Date.now(), log: jobLog(it, 4),
      guardChecked: true, settling: Date.now() },
  ];
}

function writeJobs(it, jobs) {
  fs.writeFileSync(path.join(it.constanceDir, "jobs.json"),
    JSON.stringify({ goal: null, jobs, next: 10, guards: {} }));
}

function spawnCmd(it, args) {
  const fd = fs.openSync(path.join(it.iter, `cmd-${args.filter((a) => /^\d+$/.test(a)).join("-") || args[0]}.log`), "a");
  const child = spawn(process.execPath, [CLI, ...args], { env: envFor(it), stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  return child;
}

const exitCode = (child) => new Promise((r) => child.once("exit", (code) => r(code)));

// `wait` prints its JSON verdict on stdout; collect it while it runs.
function spawnWait(it) {
  const child = spawn(process.execPath, [CLI, "wait", "--timeout", "1"], { env: envFor(it) });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  return { done: exitCode(child).then((code) => ({ code, out, err })) };
}

// Sample merge.lock ~every 2 ms while the children run: who owns it, and is
// anything besides the single `owner` file ever inside. A sample only sees
// the lock dir, so "two holders at once" can only be caught as overlapping
// observed hold windows — the holds here last tens to hundreds of ms, far
// longer than the poll, so a real overlap would show up.
function startLockMonitor(lock) {
  const samples = [];
  const timer = setInterval(() => {
    try {
      if (!fs.existsSync(lock)) { samples.push({ t: Date.now(), pid: null, extras: null }); return; }
      let pid = null;
      try { pid = Number(fs.readFileSync(path.join(lock, "owner"), "utf8").trim()) || null; } catch {}
      let extras = [];
      try { extras = fs.readdirSync(lock).filter((f) => f !== "owner"); } catch {}
      samples.push({ t: Date.now(), pid, extras });
    } catch {}
  }, 2);
  return { samples, stop: () => clearInterval(timer) };
}

// Contiguous observed holds of `pid`, clustered across poll gaps <= 20 ms.
function holdWindows(samples, pid) {
  const wins = [];
  for (const s of samples) {
    if (s.pid !== pid) continue;
    const last = wins[wins.length - 1];
    if (last && s.t - last.end <= 20) last.end = s.t; else wins.push({ start: s.t, end: s.t });
  }
  return wins;
}

function assertLockDisjoint(samples, pidA, pidB) {
  for (const s of samples) {
    if (s.pid === null) continue;
    assert.ok(s.pid === pidA || s.pid === pidB, `merge.lock was owned by unexpected pid ${s.pid}`);
    assert.deepEqual(s.extras, [], `merge.lock held unexpected entries: ${s.extras}`);
  }
  assert.ok(samples.some((s) => s.pid === pidA), "the first self-merge never held the lock");
  assert.ok(samples.some((s) => s.pid === pidB), "the second self-merge never held the lock");
  for (const a of holdWindows(samples, pidA)) for (const b of holdWindows(samples, pidB)) {
    const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
    assert.ok(overlap <= 5, `merge lock held by both self-merges at once (~${overlap} ms overlap)`);
  }
}

function readJobs(it) {
  return JSON.parse(fs.readFileSync(path.join(it.constanceDir, "jobs.json"), "utf8")).jobs;
}
function readReviews(it) {
  try { return JSON.parse(fs.readFileSync(path.join(it.constanceDir, "reviews.json"), "utf8")); }
  catch { return { pending: [], reviewed: [] }; }
}
function assertSettled(it, lock) {
  for (const j of readJobs(it)) assert.ok(!j.selfMerging && !j.selfMergePid && !j.selfMergeAt,
    `job ${j.id} is still flagged selfMerging`);
  assert.ok(!fs.existsSync(lock), "merge.lock still exists after both self-merges");
  assert.deepEqual(fs.readdirSync(it.constanceDir).filter((f) => f.startsWith("merge.lock")), [],
    "merge.lock takeover leftovers were left behind");
}

// One race: two copies finish together and both run `selfmerge` for real.
// sameFile=false gives each copy its own file (both must land); sameFile=true
// makes them edit the same file differently (exactly one may land).
async function race(name, { sameFile }) {
  const it = makeIter(name);
  const repo = makeRepo(it);
  const relA = sameFile ? "shared.txt" : `a-${name}.txt`;
  const relB = sameFile ? "shared.txt" : `b-${name}.txt`;
  const contentA = sameFile ? `shared one ${name}\n` : `a ${name}\n`;
  const contentB = sameFile ? `shared two ${name}\n` : `b ${name}\n`;
  const cA = makeCopy(repo, it, 1, relA, contentA);
  const cB = makeCopy(repo, it, 2, relB, contentB);
  cA.rel = relA; cB.rel = relB;
  writeJobs(it, [racerJob(it, repo, 1, cA), racerJob(it, repo, 2, cB), ...probeJobs(it, repo)]);
  const lock = path.join(it.constanceDir, "merge.lock");

  const mon = startLockMonitor(lock);
  const p1 = spawnCmd(it, ["selfmerge", "1"]);
  const p2 = spawnCmd(it, ["selfmerge", "2"]);
  const w = spawnWait(it);
  const [e1, e2, wr] = await Promise.all([exitCode(p1), exitCode(p2), w.done]);
  mon.stop();

  assert.equal(e1, 0, `selfmerge 1 exited ${e1}`);
  assert.equal(e2, 0, `selfmerge 2 exited ${e2}`);
  assert.equal(wr.code, 0, `wait exited ${wr.code}: ${wr.err}`);
  assertLockDisjoint(mon.samples, p1.pid, p2.pid);

  // wait ran while both racers were still self-merging: it must hand out the
  // already-merged job, report both racers and the settling job as still in
  // Constance's hands, and never the settling one.
  const wout = JSON.parse(wr.out);
  assert.equal(wout.review?.id, 3, `wait handed out job ${wout.review?.id}, expected the merged job 3`);
  const running = wout.stillRunning || [];
  for (const id of [1, 2]) {
    const j = running.find((x) => x.id === id);
    assert.ok(j, `wait did not report racing job ${id} as still running`);
    assert.equal(j.selfMerging, true, `wait did not flag racing job ${id} as self-merging`);
  }
  assert.ok(running.some((x) => x.id === 4), "wait dropped the settling job from stillRunning");
  assert.ok(!running.some((x) => x.id === 3), "wait listed the already-merged job as still running");

  const merges = git(repo, "log", "--merges", "--format=%H").split("\n").filter(Boolean);
  const jobs = readJobs(it);
  const byId = (id) => jobs.find((j) => j.id === id);
  assertSettled(it, lock);

  if (!sameFile) {
    assert.equal(merges.length, 2, `expected two merge commits, got ${merges.length}`);
    for (const c of merges) {
      assert.equal(git(repo, "rev-list", "--parents", "-n", "1", c).trim().split(/\s+/).length, 3,
        `${c} is not a two-parent merge commit`);
    }
    assert.ok(merges.includes(git(repo, "rev-parse", "HEAD^1").trim()),
      "the second merge does not sit on the first — the merges were not serialized");
    assert.equal(fs.readFileSync(path.join(repo, relA), "utf8"), contentA, "copy A's file missing");
    assert.equal(fs.readFileSync(path.join(repo, relB), "utf8"), contentB, "copy B's file missing");
    for (const id of [1, 2]) assert.equal(byId(id).status, "merged", `job ${id} ended ${byId(id).status}`);
    assert.equal(readReviews(it).pending.length, 2, "both self-merges wait for background review");
  } else {
    assert.equal(merges.length, 1, `expected exactly one merge commit, got ${merges.length}`);
    const merged = [byId(1), byId(2)].find((j) => j.status === "merged");
    const conflicted = [byId(1), byId(2)].find((j) => j.status === "conflict");
    assert.ok(merged && conflicted, `expected one merged and one conflict job, got ${byId(1).status}/${byId(2).status}`);
    assert.match(conflicted.mergeError || "", /conflict/, "the loser was not flagged as a conflict");
    const winnerContent = merged.files[0] === "shared.txt" ? (merged.id === 1 ? contentA : contentB) : "";
    assert.equal(fs.readFileSync(path.join(repo, "shared.txt"), "utf8"), winnerContent, "the winner's content is not what landed");
    assert.ok(fs.existsSync(conflicted.worktree), "a conflicted self-merge dropped its worktree");
    assert.notEqual(git(repo, "branch", "--list", conflicted.branch).trim(), "", "a conflicted self-merge deleted its branch");
    assert.equal(git(repo, "branch", "--list", merged.branch).trim(), "", "the merged branch was not cleaned up");
    assert.equal(readReviews(it).pending.length, 1, "only the landed merge waits for review");
  }
  assert.equal(sh(repo, "status", "--porcelain").stdout.trim(), "", "repo left dirty");
}

try {
  for (let i = 1; i <= 5; i++) await race(`race-${i}`, { sameFile: false });
  await race("conflict", { sameFile: true });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("constance-e2e-selfmerge-race: tests passed");
