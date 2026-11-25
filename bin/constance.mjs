#!/usr/bin/env node
// Constance, the quarterback. The owner gives her a goal in the panel (the C button); she runs as Claude Code
// on the paid plan (Opus), plans, hands routine pieces to free agents that are under their limits, reviews
// everything that comes back, and reports. This file is both the panel's entry point and the toolbox she
// calls from her own shell:
//
//   start --dir D --goal TEXT   new goal (refused while one is active); starts the driver in the background
//   status                      JSON for the panel: goal, jobs, agents, pace, log
//   remote                      write the phone-safe status summary to remote-status.txt (prints the path)
//   agents | pace | jobs        what she reads before every handoff
//   delegate --agent ID --task TEXT [--files a,b]   hand one task to one free agent (re-checks it first;
//                                                   no --files = read-only; in practice mode it only logs the prompt)
//   lesson TEXT                   add a short lesson to her lessons file (advice for later goals)
//   queue [--task TEXT [--files a,b] [--agent ID] | rm ID]   the ready-task queue for this project;
//                                                   no --task lists what's queued
//   signals                     recent agent-finished notifications she heard
//   wait [--timeout S]          block until a job finishes; prints the next one to review, oldest first
//   review ID accept|send-back --note TEXT        record her verdict
//   reviews                     self-merged jobs still waiting for her background review
//   check N [--note TEXT]       tick checklist item N that she did herself
//   needs-owner TEXT            the goal ends needing the owner: the goal queue stops instead of moving on
//   job ID                      one job in full (prompt, report, review, its log lines) for the panel's card
//   goals [add --goal T --dir D | rm ID | edit ID [--goal T] [--dir D] | move ID up|down|top|N | next]
//                               the owner's goal queue (the panel's GOAL QUEUE); no subcommand lists it
//   note TEXT                   a line in the owner's log
//   stop                        halt everything at once (her, every job)
//   recover                     panel load: restart the driver if a goal is active and it isn't running
//   route STEP                  which model her STEP runs on, as JSON (constance-route.mjs)
//   drive                       (internal) the background loop that runs her and paces her
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { judgeAll, launchCommand, accountEnv, LAUNCH } from "./constance-agents.mjs";
import { copyLimit, roomForCopy, readMachine, PUBLISHED_MAX } from "./constance-ramp.mjs";
import { pace, canResume, keptGoing } from "./constance-pace.mjs";
import { limitWall, writeWall, wallFile } from "./constance-wall.mjs";
import { nextModel, modelName } from "./constance-model.mjs";
import { openStore, conflicts, handoffPrompt, doneFile, reviewQueue, overlaps, settling, inHand } from "./constance-jobs.mjs";
import { readLessons, addLesson, lessonsBlock, readProjectRules, rulesBlock, guardrailBlock } from "./constance-lessons.mjs";
import { snapshot as guardSnapshot, checkRun, restoreRun, fileCap } from "./constance-guard.mjs";
import { NotifyParser, handleNotification, recentSignals, recordSignal, jobFinishSignal, logSaysFinished } from "./constance-notify.mjs";
import { addTask, peekNext, finishTask, removeTask, queueView, readyTasks } from "./constance-queue.mjs";
import { withLock } from "./constance-mergelock.mjs";
import { selfMerge, selfMergeBranch, runSuite, addPending, pendingReviews, markReviewed, revertMerge } from "./constance-selfmerge.mjs";
import { sandboxProblem, sandboxLaunch, bwrapWorks } from "./constance-sandbox.mjs";
import { logText } from "./constance-logtext.mjs";
import { createWorktree, mergeBranch, dropWorktree, repoBranch, worktreeFor, branchFor } from "./constance-worktree.mjs";
import { tokenMeter, matchJobs, snapshots, readRecords, usageFile, refreshInBackground, refreshNow } from "./constance-tokens.mjs";
import { parseItems, parseItemArg, checklist } from "./constance-checklist.mjs";
import { cards, nowLine, history, goalRecord } from "./constance-board.mjs";
import { readGoalQueue, addGoal, removeGoal, editGoal, moveGoal, takeNext, pauseQueue, resumeQueue, needsOwner } from "./constance-goalqueue.mjs";
import { readScorecard, recordReview, scoreRows, sizeHint, rankAgents, scoreLine } from "./constance-scorecard.mjs";
import { secondTry, sendBackAdvice } from "./constance-retry.mjs";
import { planSpare, useItOrLoseItOn } from "./constance-spare.mjs";
import { readBacklog, addItem as addBacklogItem, markTaken, markDone, removeItem as removeBacklogItem, openItems as openBacklog, formatItem, KINDS as BACKLOG_KINDS } from "./constance-backlog.mjs";
import { buildReport, writeReport, lastReportAt } from "./constance-morning.mjs";
import { addSample, readSamples, sessionSpent, leverage, bestReturnLesson, TARGET_PER_PCT } from "./constance-leverage.mjs";
import { readMilk, milkPolicy, milkPrompt } from "./constance-milk.mjs";
import { writeRemoteStatus } from "./constance-remote.mjs";
import { briefFor } from "./constance-brief.mjs";
import { progressLine, tick as progressTick } from "./constance-progress.mjs";
import { resumePlan, logAsk } from "./constance-resume.mjs";
import { routeModel, logRoute } from "./constance-route.mjs";

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);
const ENV = { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH || ""}` };
const STATE = path.dirname(openStore().dir);   // <state>/omarchy/agent-usage-tabs
const store = openStore();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, fallback = "") { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; }
function out(x) { process.stdout.write(typeof x === "string" ? x + "\n" : JSON.stringify(x, null, 2) + "\n"); }
function fail(msg) { process.stderr.write(msg + "\n"); process.exit(1); }

// A pid is ours only if it is alive and its command line still names what we started.
export function alive(pid, needle = "") {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); } catch { return false; }
  if (!needle) return true;
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(needle); } catch { return false; }
}
function killGroup(pid) { try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} } }

function readData() { try { return JSON.parse(fs.readFileSync(path.join(STATE, "data.json"), "utf8")); } catch { return { agents: [] }; } }
// Fresh numbers before a handoff: run the collector when data.json is over 5 minutes old (same sound
// settings as the panel's own runs).
function freshData() {
  let d = readData();
  if (Date.now() - (Number(d.generatedAt) || 0) > 5 * 60e3) {
    let vol = 60; try { const s = JSON.parse(fs.readFileSync(path.join(STATE, "settings.json"), "utf8")); vol = s.resetSound === false ? 0 : Number(s.resetVolume ?? 60); } catch {}
    spawnSync("node", [path.join(HERE, "collect.mjs"), "--notify", "95", "--volume", String(vol)], { env: ENV, stdio: "ignore", timeout: 120e3 });
    d = readData();
  }
  return d;
}
const claudeOf = (d) => (d.agents || []).find((a) => a.id === "claude");

// Agents the owner lets reach the desktop keyring from inside the sandbox
// (settings.json constanceKeyringAgents; none by default — see constance-sandbox.mjs).
function keyringAgents() {
  try { const v = JSON.parse(fs.readFileSync(path.join(STATE, "settings.json"), "utf8")).constanceKeyringAgents; return Array.isArray(v) ? v.map(String) : []; }
  catch { return []; }
}
// Why an agent can't run sandboxed right now ("" when it can): judge() refuses it otherwise.
function boxProblem(id) {
  if (!LAUNCH[id]) return "";
  if (!bwrapWorks()) return "bubblewrap (bwrap) is missing or can't run here";
  return sandboxProblem(id, keyringAgents());
}
const judged = (d) => judgeAll(d, Date.now(), { sandbox: boxProblem });

// Practice mode (the panel's switch, on by default for now): a dry run. She still plans the goal and
// picks agents, but delegate() only writes each handoff's agent, reason and full prompt into the log —
// nothing launches and nothing changes. Missing settings.json means practice is on.
function readSettings() {
  try { return JSON.parse(fs.readFileSync(path.join(STATE, "settings.json"), "utf8")) || {}; } catch { return {}; }
}
const limitOf = (agent) => copyLimit(agent, readSettings());
function practiceMode() {
  try { return JSON.parse(fs.readFileSync(path.join(STATE, "settings.json"), "utf8")).constancePractice !== false; }
  catch { return true; }
}

// ---------------------------------------------------------------- jobs
// Bring statuses up to date: a done file means finished; a process that ended without one is finished too
// (with a note), so it still gets reviewed.
// The folder the agent actually worked in: a copy job's worktree, or the repo
// itself for ordinary jobs. j.dir stays the project repo so conflicts, the
// queue and reviews all talk about one place.
const runDir = (j) => j.worktree || j.dir;

// Where a job's done file is read from: a copy's worktree, or the job's own
// sandbox tmp for a job that works in the project folder itself (inside the
// sandbox that tmp is /tmp — see handOut; a done file inside the project would
// count as a plugin change and reload the owner's shell).
const jobDoneFile = (j) => doneFile(j.worktree || j.tmp || runDir(j), j.id);
const jobDoneDir = (j) => j.worktree || j.tmp || runDir(j);

// A job's sandbox /tmp is only ever the folder handOut made for it; it goes when the job ends.
function dropJobTmp(j) {
  const t = String(j.tmp || "");
  if (t.startsWith(path.join(os.tmpdir(), "constance-job-"))) { try { fs.rmSync(t, { recursive: true, force: true }); } catch {} }
}

// The last `n` bytes of a file as text ("" when unreadable) — a job log can be
// megabytes, but only its tail can say the run finished.
function tailFile(f, n = 8192) {
  try {
    const fd = fs.openSync(f, "r");
    try {
      const size = fs.fstatSync(fd).size, len = Math.min(n, size), buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return ""; }
}

function sweep() {
  const signals = [];
  const changed = store.update((s) => {
    const changed = [];
    for (const j of s.jobs) {
      if (j.status !== "running") {
        // A self-merge runs in a detached process (selfMerging); if it died
        // mid-run the flag is stuck, so clear it and let the review take the job.
        // No pid yet means the spawn is still under way: give it 30 s.
        const gone = j.selfMergePid ? !alive(j.selfMergePid, "selfmerge") : Date.now() - (j.selfMergeAt || 0) > 30000;
        if (j.selfMerging && gone) { delete j.selfMerging; delete j.selfMergePid; delete j.selfMergeAt; }
        continue;
      }
      const f = jobDoneFile(j);
      let done = null, source = "";
      try { done = JSON.parse(fs.readFileSync(f, "utf8")); j.finishedAt = fs.statSync(f).mtimeMs; source = "done-file"; }
      catch {
        if (fs.existsSync(f)) { done = { summary: "(done file was not valid JSON)", commit: "" }; j.finishedAt = Date.now(); source = "done-file"; }
      }
      if (!done && !alive(j.pid, LAUNCH[j.agent]?.cli || "")) { done = { summary: "(the agent exited without writing its done file)", commit: "" }; j.finishedAt = Date.now(); source = "exit"; }
      if (done) { j.status = "finished"; j.settling = Date.now(); j.summary = String(done.summary || ""); j.commit = String(done.commit || ""); changed.push(j); signals.push({ j, source }); }
      // Still running, but its own log says it finished: record the signal
      // (deduped in notify.jsonl) without touching its status.
      else if (j.log && logSaysFinished(tailFile(j.log))) signals.push({ j, source: "log" });
    }
    return changed;
  });
  // `settling` (set with "finished" above) keeps the job out of `wait` until
  // the guard and the self-merge decision are done; maybeSelfMerge swaps it
  // for selfMerging in one update, and it is cleared here otherwise.
  for (const j of changed) {
    try { guardFinished(j); dropJobTmp(j); maybeSelfMerge(j); }
    finally { store.update((s) => { const x = s.jobs.find((k) => k.id === j.id); if (x) delete x.settling; }); }
  }
  // Whoever's sweep sees the finish logs the return — status polls can beat `wait` to it.
  for (const j of changed) store.log({ kind: "returned", job: j.id, agent: j.agent, worker: j.worker, account: j.account?.label || "", text: j.summary + (j.commit ? ` (commit ${j.commit.slice(0, 9)})` : "") });
  for (const { j, source } of signals) recordSignal(store.dir, jobFinishSignal(j, { source, runDir: jobDoneDir(j) }));
  fillSlots();
  return changed;
}

// Same containment rule the guard uses: a changed path is covered by a file
// entry when they match, the entry is "." or names the path's folder.
const normRel = (p) => String(p).replace(/^\.\//, "").replace(/\/+$/, "");
function coversPath(files, p) {
  const b = normRel(p);
  return files.some((f) => { const a = normRel(f); return a === b || a === "." || b === a + "/" || a.startsWith(b + "/"); });
}

// After a delegated run ends, check it stayed inside its guardrails: only its
// allowed files changed, and the home/projects lists match the pre-run
// snapshot. A violation reverts the run's bad commits (nothing is ever deleted or
// moved), reports the rest, logs a lesson, counts a
// strike (smaller tasks from then on) and marks the job so her review sees it.
// Home/projects-only differences are notices: logged, never a strike.
function guardFinished(j) {
  if (!j.guardBefore || j.guardChecked) return;
  const dir = runDir(j);
  const res = checkRun({ dir, files: j.files || [], commit: j.commit, before: j.guardBefore, env: ENV });
  store.update((s) => { const x = s.jobs.find((k) => k.id === j.id); if (x) x.guardChecked = true; });
  // Concurrent jobs share the folder and its git history, and the guard sees
  // every commit since the snapshot: work another overlapping job was allowed
  // to do is that job's, never this one's violation. A job with its own
  // worktree (a copy) is never excused and never excuses: its history is all
  // its own, and its commits only reach the shared repo when its branch merges.
  const jStart = j.startedAt || 0, jEnd = j.finishedAt || Date.now();
  const hasWorktree = (k) => !!(k.worktree || k.branch);
  const others = hasWorktree(j) ? [] : store.read().jobs.filter((k) => k.id !== j.id && k.startedAt && runDir(k) === dir &&
    !hasWorktree(k) && k.startedAt <= jEnd && jStart <= (k.finishedAt || Infinity));
  const allowed = (k) => [...(k.files || []), ".constance/"];
  const excusedCommits = new Set(), excusedPaths = new Set();
  for (const c of res.badCommits || []) {
    const cfiles = changedFiles(dir, c);
    if (others.some((k) => k.commit === c || (cfiles.length > 0 && cfiles.every((p) => coversPath(allowed(k), p))))) {
      excusedCommits.add(c);
      cfiles.forEach((p) => excusedPaths.add(p));
    }
  }
  for (const p of res.badPaths || []) if (others.some((k) => coversPath(allowed(k), p))) excusedPaths.add(p);
  const badPaths = (res.badPaths || []).filter((p) => !excusedPaths.has(p));
  const badCommits = (res.badCommits || []).filter((c) => !excusedCommits.has(c));
  const violations = [...res.violations.filter((v) => v.startsWith("reported commit"))];
  if (badPaths.length) violations.push(`changed files outside its list: ${badPaths.join(", ")}`);
  if ((res.notices || []).length) store.log({ kind: "guard-notice", job: j.id, agent: j.agent, text: res.notices.join("; ") });
  if (!violations.length) return;
  // Revert a commit only when the commit itself touched disallowed files; a
  // home/projects-only or dirty-leftover violation leaves committed work alone.
  // Only commits the guard verified as this run's own are ever reverted.
  const commitBad = !!res.ownCommit && changedFiles(dir, res.ownCommit).some((p) => badPaths.includes(p));
  const did = restoreRun({ dir, commit: commitBad ? res.ownCommit : "", commits: badCommits, badPaths, addedProjects: res.addedProjects || [],
    addedHome: res.addedHome || [], removedHome: res.removedHome || [], removedProjects: res.removedProjects || [] });
  const lesson = `${j.agent} broke a guardrail on job ${j.id}: ${violations.join("; ")}.`;
  addLesson(lesson, store.dir);
  store.update((s) => {
    const x = s.jobs.find((k) => k.id === j.id);
    if (x) x.guardViolation = violations;
    const g = (s.guards ||= {})[j.agent] ||= { strikes: 0, violations: [] };
    g.strikes += 1; g.violations.push({ job: j.id, at: Date.now(), what: violations });
  });
  store.log({ kind: "guard", job: j.id, agent: j.agent, text: `${violations.join("; ")}. Restored: ${did.join("; ") || "nothing to restore"}. Lesson logged; ${j.agent} gets smaller tasks now.` });
}

function changedFiles(dir, commit) {
  if (!/^[0-9a-f]{7,40}$/i.test(commit || "")) return [];
  const r = spawnSync("git", ["-C", dir, "show", "--name-only", "--format=", commit], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

function excludeDoneFiles(dir) {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" });
  if (r.status !== 0) return;
  const f = path.resolve(dir, r.stdout.trim());
  let txt = ""; try { txt = fs.readFileSync(f, "utf8"); } catch {}
  if (!txt.split("\n").includes(".constance/")) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, (txt && !txt.endsWith("\n") ? "\n" : "") + ".constance/\n"); }
}

// ---------------------------------------------------------------- self-merge and slot filling
// A finished copy whose guard is clean, whose branch only touches its allowed
// files and whose own report says its tests passed merges itself at once
// (constance-selfmerge.mjs runs the repo's whole suite first, then merges,
// with one rebase-and-retry on conflict). The merge lands in reviews.json for
// Constance's background review — accept confirms it, send-back reverts it.
// A flagged conflict is marked "conflict" and keeps its worktree, exactly like
// a review-time one; anything else stays "finished" for the normal review.
// constanceSelfMerge: false turns it all off. Best-effort only: a failure is
// logged and the sweep moves on, never blocked — the merge itself runs in a
// detached `selfmerge` process so the suite never stalls a status call.
const reviewsFile = () => path.join(store.dir, "reviews.json");
const selfMergeOn = () => readSettings().constanceSelfMerge !== false;

// The agent's own word that its tests passed: a done-file `tests` field that
// says so, or report text naming passing tests. Silence counts as false.
function ownTestsPassed(done) {
  if (!done) return false;
  const t = done.tests;
  if (t === true || /^(pass|passed|ok|green|success)$/i.test(String(t ?? ""))) return true;
  const text = `${done.summary || ""}\n${done.report || ""}`;
  return /\btests?\b[^.\n]{0,80}?\b(pass|passed|green|succeed)/i.test(text) || /\b(pass|passed|green)\b[^.\n]{0,80}?\btests?\b/i.test(text);
}

// Every file the copy's branch changed against the repo's current branch must
// sit inside the job's allowed list (its files plus .constance/, same as the
// guard's). Unreadable git means no.
function branchDiffOk(j) {
  const base = spawnSync("git", ["-C", j.dir, "merge-base", "HEAD", j.branch], { encoding: "utf8" });
  if (base.status !== 0) return false;
  const d = spawnSync("git", ["-C", j.dir, "diff", "--name-only", `${base.stdout.trim()}..${j.branch}`], { encoding: "utf8" });
  if (d.status !== 0) return false;
  const allowed = [...(j.files || []), ".constance/"];
  return d.stdout.split("\n").filter(Boolean).every((p) => coversPath(allowed, p));
}

// The suite is the slow part of a self-merge, so it never runs inside sweep:
// maybeSelfMerge only does the cheap checks, marks the job (selfMergeTried,
// selfMerging — status stays "finished") and spawns `selfmerge ID` detached.
// That process re-checks everything, runs the suite and merge under the merge
// lock, logs the outcome and clears selfMerging; if it dies first, the next
// sweep clears the flag and the normal review takes the job.
function maybeSelfMerge(j) {
  try {
    if (!selfMergeOn() || !j.worktree || !j.branch) return;
    const fresh = store.read().jobs.find((k) => k.id === j.id);
    // guardChecked with no guardViolation is the guard's clean bill; without it
    // there is no proof the run stayed inside its list, so no self-merge.
    if (!fresh || fresh.status !== "finished" || fresh.selfMergeTried || fresh.selfMerging || fresh.guardViolation?.length || !fresh.guardChecked) return;
    let done = null;
    try { done = JSON.parse(fs.readFileSync(jobDoneFile(fresh), "utf8")); } catch {}
    if (!ownTestsPassed(done)) return;   // normal review handles it
    if (!branchDiffOk(fresh)) return;
    store.update((s) => { const x = s.jobs.find((k) => k.id === j.id); if (x && x.status === "finished" && !x.selfMergeTried) { x.selfMergeTried = true; x.selfMerging = true; x.selfMergeAt = Date.now(); delete x.settling; } });
    const marked = store.read().jobs.find((k) => k.id === j.id);
    if (marked?.selfMerging) spawnSelfMerge(marked);
  } catch (e) {
    store.log({ kind: "note", job: j.id, agent: j.agent, text: `self-merge skipped for job ${j.id}: ${e.message}` });
  }
}

const clearSelfMerging = (id) => store.update((s) => { const x = s.jobs.find((k) => k.id === id); if (x) { delete x.selfMerging; delete x.selfMergePid; delete x.selfMergeAt; } });

// `node constance.mjs selfmerge ID`, detached with its output appended to the
// job's own log. On a spawn failure the flag is cleared so review takes it.
function spawnSelfMerge(j) {
  let fd = null;
  for (const f of [j.log, path.join(store.dir, `selfmerge-${j.id}.log`)]) {
    if (!f) continue;
    try { fd = fs.openSync(f, "a"); break; } catch {}
  }
  try {
    const child = spawn(process.execPath, [SELF, "selfmerge", String(j.id)], { detached: true, stdio: ["ignore", fd ?? "ignore", fd ?? "ignore"], env: ENV });
    child.unref();
    if (fd !== null) fs.closeSync(fd);
    store.update((s) => { const x = s.jobs.find((k) => k.id === j.id); if (x) x.selfMergePid = child.pid; });
  } catch (e) {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
    clearSelfMerging(j.id);
    store.log({ kind: "note", job: j.id, agent: j.agent, text: `self-merge could not start for job ${j.id}: ${e.message}` });
  }
}

// The detached half of a self-merge: re-check the job fresh (a review may have
// taken it meanwhile), then the same checks/selfMerge/withMergeLock/drop/log
// work maybeSelfMerge used to do inline — minus the part that blocked sweep.
function runSelfMerge(id) {
  const j = store.read().jobs.find((k) => k.id === id);
  if (!j) return;
  try {
    if (j.status !== "finished" || j.selfMerging !== true || j.guardViolation?.length || !j.guardChecked || !j.worktree || !j.branch) return;
    let done = null;
    try { done = JSON.parse(fs.readFileSync(jobDoneFile(j), "utf8")); } catch {}
    if (!ownTestsPassed(done) || !branchDiffOk(j)) return;
    const checks = { ownTests: true, guard: true, diff: true };
    // Tests can slow the suite down with CONSTANCE_SELFMERGE_SUITE_DELAY_MS;
    // nothing sets it outside them.
    const delay = Number(process.env.CONSTANCE_SELFMERGE_SUITE_DELAY_MS) || 0;
    const suite = delay ? (dir) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay); return runSuite(dir); } : runSuite;
    // Re-check right before each merge attempt: a review that landed while the
    // suite ran wins, and the merge must not fire on a job it already took.
    const merge = (repo, branch) => {
      const cur = store.read().jobs.find((k) => k.id === id);
      if (!cur || cur.status !== "finished" || cur.selfMerging !== true) return { ok: false, output: "the job was reviewed while the suite ran" };
      return selfMergeBranch(repo, branch);
    };
    // The lock covers the rebase onto the current branch, a re-run of the suite
    // if that brought in new work, and the merge, so wait as long as a live
    // holder needs (a dead one's lock is taken over at once).
    const lock = (fn) => withMergeLock(fn, { waitMs: 60 * 60 * 1000, pollMs: 200 });
    const m = selfMerge({ repo: j.dir, worktree: j.worktree, branch: j.branch, checks, suite, merge, lock });
    if (m.merged) {
      keepTokens(true);
      const did = dropWorktree(j.dir, j.worktree, j.branch, { deleteBranch: true, merged: true });
      // The pending review goes in first, and "merged" and the cleared flag land
      // in one update: `wait` hands out merged jobs, and `review` refuses one
      // still flagged self-merging, so they must never be seen apart.
      addPending(reviewsFile(), { job: j.id, commit: j.commit, branch: j.branch });
      store.update((s) => { const x = s.jobs.find((k) => k.id === id); if (x) { x.status = "merged"; x.mergedAt = Date.now(); x.mergeCommit = m.commit || ""; x.worktree = ""; x.cleaned = did.join("; "); delete x.selfMerging; delete x.selfMergePid; } });
      store.log({ kind: "merge", job: j.id, agent: j.agent, worker: j.worker, text: `self-merged ${j.branch}${m.commit ? ` (${String(m.commit).slice(0, 9)})` : ""}; ${did.join("; ")}` });
      return;
    }
    if (m.conflict || m.flagged) {
      store.update((s) => { const x = s.jobs.find((k) => k.id === id); if (x) { x.status = "conflict"; x.mergeError = m.reason || ""; delete x.selfMerging; delete x.selfMergePid; } });
      store.log({ kind: "merge", job: j.id, agent: j.agent, worker: j.worker, text: `self-merge ${m.conflict ? "conflict" : "failed"} on ${j.branch}: ${(m.reason || "").slice(-300)}` });
      return;
    }
    store.log({ kind: "note", job: j.id, agent: j.agent, worker: j.worker, text: `self-merge didn't land ${j.branch}: ${m.reason || "unknown"}` });
  } catch (e) {
    store.log({ kind: "note", job: j.id, agent: j.agent, text: `self-merge skipped for job ${j.id}: ${e.message}` });
  } finally {
    clearSelfMerging(id);
  }
}

// A self-merged job is already in the repo: wherever an accepted job counts
// (checklist ticks, goal history, the goal-end checks) a merged one counts the
// same — her later review only confirms it or reverts it.
const asAccepted = (jobs) => jobs.map((j) => (j.status === "merged" ? { ...j, status: "accepted" } : j));

// Queued tasks never wait for a review: after every sweep (and on status and
// the driver's heartbeat) a ready task that names its agent goes straight to
// handOut while that agent has room. Agent-less tasks still go through
// autoNext when a job is accepted. A refused handoff is retried on the next
// sweep but logged only once per process.
const fillMissed = new Set();
function fillSlots() {
  try {
    const s = store.read(), g = s.goal;
    if (!g || g.status !== "running") return;
    const dir = g.dir;
    const busyFiles = s.jobs.filter((j) => ["held", "waiting", "running"].includes(j.status)).flatMap((j) => j.files || []);
    let slots = 0;
    for (const agent of Object.keys(PUBLISHED_MAX)) slots += Math.max(0, limitOf(agent) - copySlots(s, agent, dir).length);
    if (!slots) return;
    for (const t of readyTasks(dir, { busyFiles, limit: slots }, store.dir)) {
      if (!t.agent) continue;
      try {
        const r = handOut({ agent: t.agent, task: t.task, files: t.files || [], items: parseItemArg(t.items || []), title: t.title || "" });
        finishTask(dir, t.id, r.job.id, store.dir);
        store.log({ kind: "note", text: `Ready queue: "${t.task.slice(0, 80)}" went to ${t.agent} automatically as job ${r.job.id} (a copy slot was free).` });
      } catch (e) {
        if (!fillMissed.has(t.id)) { fillMissed.add(t.id); store.log({ kind: "note", text: `Ready queue: "${t.task.slice(0, 80)}" stays queued — ${e.message}` }); }
      }
    }
  } catch {}
}

// Copies of one agent that still hold their slot: held (waiting for room on the
// machine), waiting/running, finished and awaiting review (the branch isn't
// merged yet), merged and awaiting its background review, or conflicted (left
// for the owner). Accepted, sent-back and stopped jobs free their number.
function copySlots(s, agent, dir) {
  return s.jobs.filter((j) => j.agent === agent && j.dir === dir && j.copy && ["held", "waiting", "running", "finished", "merged", "conflict"].includes(j.status));
}
function claimCopy(s, agent, dir, limit, prefer = 0) {
  const used = new Set(copySlots(s, agent, dir).map((j) => j.copy));
  if (prefer > 0 && prefer <= limit && !used.has(prefer)) return prefer;
  for (let i = 1; i <= limit; i++) if (!used.has(i)) return i;
  return 0;
}
// Room for one more started copy of this agent: copies already launched (still
// running) and when the newest one started feed the ramp check.
function copyRoom(s, agent, machine) {
  const started = s.jobs.filter((j) => j.agent === agent && j.copy && j.startedAt);
  const running = started.filter((j) => j.status === "running" || j.status === "waiting").length;
  const lastStartAt = Math.max(0, ...started.map((j) => j.startedAt));
  return roomForCopy(machine, { running, lastStartAt });
}

// The actual handoff, shared by `delegate` and the queue's auto-next: checks the
// agent is still available, enforces strike caps and file conflicts, builds the
// prompt (project rules + guardrails), snapshots the world, and launches. Agents
// with copyLimit > 1 (Devin, up to 10, lowered by settings constanceMaxCopies)
// get an editing job in their own git worktree on their own branch, tracked as a
// numbered worker; it merges into the repo only after review accepts it. Copies
// ramp up: when the machine has no room yet (constance-ramp.mjs), the job is
// held — its files and number stay reserved — and releaseHeld() starts it later.
// Throws with a human reason on any refusal; returns { job, who, verdict, practice, held }.
function handOut({ agent, task, files = [], preferCopy = 0, items = [], title = "", againOf = null }) {
  const g = store.read().goal;
  if (!g || g.status !== "running") throw new Error("No goal is running (stopped or paused), so nothing is handed out.");
  if (!agent || !task) throw new Error("delegate needs --agent ID and --task TEXT");
  // Second-try rule: work sent back twice is never resent as it was; it is split
  // into smaller jobs (fewer files each) or she does it herself.
  const twice = secondTry(store.read().jobs, { files, againOf });
  if (twice) throw new Error(twice.reason);
  const verdict = judged(freshData()).find((a) => a.id === agent);
  if (!verdict?.available) throw new Error(`${agent} is not available: ${verdict ? verdict.reason : "unknown agent"}. Run \`agents\` and pick another, or do it yourself.`);
  const dir = g.dir;
  // The cached repo brief (layout, test loop, rules, never-touch list) rides at
  // the top of every worker prompt; briefFor rebuilds it only when the tree
  // moved a lot or the cache is a week old.
  let brief = "";
  try { brief = briefFor(dir, { cacheDir: path.join(store.dir, "briefs") }); } catch {}
  // Guardrail strikes shrink what this agent may touch: after a violation it gets
  // smaller tasks only, enforced here rather than left to her judgment.
  const strikes = Number(store.read().guards?.[agent]?.strikes) || 0;
  const cap = fileCap(strikes);
  if (files.length > cap) throw new Error(`${agent} broke a guardrail before, so it gets smaller tasks: at most ${cap} file${cap === 1 ? "" : "s"} per job (it asked for ${files.length}). Split the work or pick another agent.`);
  const practice = practiceMode();
  const account = verdict.accountId ? { id: verdict.accountId, label: verdict.account } : null;
  // Per-project rules are read fresh for every handoff; guardrails go to every
  // delegated agent (they are all fast/free models).
  const extra = rulesBlock(readProjectRules(dir)) + "\n" + guardrailBlock(files);
  const limit = limitOf(agent);
  const machine = readMachine();
  const job = store.update((s) => {
    const busy = conflicts(s.jobs, dir, files);
    if (busy.length) return { busy };
    const useCopy = limit > 1 && files.length > 0 && !practice;
    let copy = 0, worker = "", room = { ok: true, reason: "" };
    if (useCopy) {
      const slots = copySlots(s, agent, dir);
      if (slots.length >= limit) return { cap: limit };
      copy = claimCopy(s, agent, dir, limit, preferCopy);
      if (!copy) return { cap: limit };
      worker = `${verdict.name} ${copy}`;
      // Older held copies go first: a new one never jumps the line.
      room = s.jobs.some((j) => j.agent === agent && j.status === "held") ? { ok: false, reason: "earlier copies are still held" } : copyRoom(s, agent, machine);
    }
    const id = s.next++;
    const j = { id, goal: g.id, agent, account, repo: dir, dir, files, task, status: practice ? "finished" : room.ok ? "waiting" : "held", createdAt: Date.now() };
    if (items.length) j.items = items;
    if (title) j.title = String(title).trim().slice(0, 80);
    if (Number.isFinite(againOf) && againOf > 0) j.againOf = againOf;
    if (useCopy) { j.copy = copy; j.worker = worker; j.worktree = worktreeFor(id); j.branch = branchFor(id); }
    if (!room.ok) j.heldReason = room.reason;
    // Claimed now, so a second handOut racing this one sees the start and ramps.
    if (useCopy && room.ok) j.startedAt = Date.now();
    if (practice) { j.finishedAt = Date.now(); j.summary = "(practice run: the prompt is in the log, nothing was launched)"; }
    // Practice shows the same prompt a real copy would get: its worktree for the
    // pwd check and the done file. Only the would-be path is recorded
    // (practiceWorktree), so nothing is created, merged or cleaned up for it.
    const asCopy = limit > 1 && files.length > 0;
    if (asCopy && practice) { j.practiceWorktree = worktreeFor(id); j.practiceBranch = branchFor(id); }
    const wt = j.worktree || j.practiceWorktree, br = j.branch || j.practiceBranch;
    // Copies share the repo's one stash, so their prompts forbid it. And a job
    // that works in the project folder itself can't write its done file there
    // (inside the sandbox its temp folder is /tmp, which is where the prompt
    // must point — a done file in the project would reload the owner's shell).
    const promptExtra = asCopy ? `${extra}\nNever use git stash: other copies share it.` : extra;
    const built = asCopy
      ? handoffPrompt({ id, dir, task, files, account, worktree: wt, branch: br, mainDir: dir }, promptExtra)
      : handoffPrompt(j, promptExtra);
    const body = asCopy ? built : built.split(doneFile(dir, id)).join(doneFile("/tmp", id));
    j.prompt = brief ? `Repo brief:\n${brief}\n\n${body}` : body;
    s.jobs.push(j);
    return j;
  });
  if (job.busy) throw new Error(`Those files overlap job ${job.busy.map((b) => `${b.id} (${b.agent}: ${b.files.join(", ")})`).join("; ")}. Wait for it, or split the work differently.`);
  if (job.cap) throw new Error(`${agent} already has ${job.cap} copies running or held (the limit is ${job.cap}). Wait for one to be reviewed, or hand the task to another agent.`);
  const who = (job.worker || verdict.name) + (verdict.account ? ` (${verdict.account})` : "");
  if (practice) {
    store.log({ kind: "practice", job: job.id, agent, account: verdict.account, reason: verdict.reason, files, text: task, prompt: job.prompt, ...(job.practiceWorktree ? { worktree: job.practiceWorktree, branch: job.practiceBranch } : {}) });
    return { job, who, verdict, practice: true };
  }
  if (job.status === "held") {
    store.log({ kind: "held", job: job.id, agent, worker: job.worker, account: verdict.account, files, text: `${task} — held: ${job.heldReason}` });
    return { job, who, verdict, practice: false, held: true };
  }
  launchJob(job, verdict.account);
  return { job, who, verdict, practice: false };
}

// Starts a reserved job (status "waiting"): worktree for a copy, done-file setup,
// guard snapshot, then the sandboxed agent. Throws (and marks the job stopped)
// when it can't launch.
function launchJob(job, accountLabel = job.account?.label || "") {
  const agent = job.agent, dir = job.dir, files = job.files || [];
  // A copy job gets its worktree before anything else: no worktree, no launch.
  if (job.worktree) {
    try { createWorktree(dir, job.id); }
    catch (e) {
      store.update((s) => { const j = s.jobs.find((x) => x.id === job.id); j.status = "stopped"; j.summary = `(no worktree: ${e.message})`; });
      store.log({ kind: "note", job: job.id, agent, worker: job.worker, text: `Job ${job.id} not launched: ${e.message}` });
      throw new Error(`${agent} copy couldn't get its worktree: ${e.message}`);
    }
  }
  const rd = runDir(job);
  excludeDoneFiles(rd);
  // Snapshot the world before the run: the post-run guard checks the diff and
  // these lists against it.
  const before = guardSnapshot(ENV, rd);
  store.update((s) => { const j = s.jobs.find((x) => x.id === job.id); j.guardBefore = before; });
  const logPath = path.join(store.dir, `job-${job.id}.log`);
  const fd = fs.openSync(logPath, "w");
  // A non-seated account's login lives in its own home: pin the CLI to it, and
  // that home is the agent's own, so it is writable inside the sandbox too.
  const acctEnv = accountEnv(agent, job.account?.id);
  // Prompts are off, so the agent only ever runs inside the sandbox: write access
  // to this worktree (or project), its own config/login folders and a fresh temp
  // folder. If it can't be sandboxed, nothing launches.
  let box;
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `constance-job-${job.id}-`));
    store.update((s) => { const j = s.jobs.find((x) => x.id === job.id); j.tmp = tmp; });
    // The done file goes in a copy's worktree, or in the job's own sandbox tmp
    // for a project-folder job (inside the sandbox that tmp is /tmp, which is
    // what the prompt tells the agent): never inside the project itself.
    const doneDir = job.worktree ? rd : tmp;
    fs.mkdirSync(path.join(doneDir, ".constance"), { recursive: true });
    try { fs.rmSync(doneFile(doneDir, job.id)); } catch {}
    box = sandboxLaunch(launchCommand(agent, job.prompt), { agent, dir: rd, tmp, env: { ...ENV, ...acctEnv }, extraRw: Object.values(acctEnv), keyringAgents: keyringAgents() });
  } catch (e) {
    fs.closeSync(fd);
    store.update((s) => { const j = s.jobs.find((x) => x.id === job.id); j.status = "stopped"; j.summary = `(not launched: ${e.message})`; });
    store.log({ kind: "note", job: job.id, agent, worker: job.worker, text: `Job ${job.id} not launched: ${e.message}` });
    throw new Error(`${agent} can't run sandboxed, so it was not launched: ${e.message}`);
  }
  const [cmd, ...args] = box.cmd;
  const child = spawn(cmd, args, { cwd: rd, env: box.env, detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  store.update((s) => { const j = s.jobs.find((x) => x.id === job.id); j.status = "running"; j.pid = child.pid; j.startedAt = Date.now(); j.log = logPath; });
  store.log({ kind: "handoff", job: job.id, agent, worker: job.worker, account: accountLabel, files, text: job.task });
}

// Held copies start by themselves, oldest first and one at a time per agent, as
// soon as the machine has room (and the agent is still under its limits). Called
// from wait, jobs and the driver's heartbeat. Returns the jobs it started.
function releaseHeld() {
  const g = store.read().goal;
  if (!g || g.status !== "running" || practiceMode()) return [];
  const agents = [...new Set(store.read().jobs.filter((j) => j.status === "held").map((j) => j.agent))];
  if (!agents.length) return [];
  const machine = readMachine();
  let verdicts = null;
  const started = [];
  for (const agent of agents) {
    verdicts ??= judged(readData());
    const v = verdicts.find((a) => a.id === agent);
    const pick = store.update((s) => {
      const j = s.jobs.filter((x) => x.agent === agent && x.status === "held").sort((a, b) => a.id - b.id)[0];
      if (!j) return null;
      const room = v?.available ? copyRoom(s, agent, machine) : { ok: false, reason: v ? v.reason : "not available" };
      if (!room.ok) { j.heldReason = room.reason; return null; }
      j.status = "waiting"; j.startedAt = Date.now(); delete j.heldReason;
      return { ...j };
    });
    if (!pick) continue;
    try { launchJob(pick); started.push(pick); }
    catch (e) { store.log({ kind: "note", job: pick.id, agent, worker: pick.worker, text: `Held job ${pick.id} could not start: ${e.message}` }); }
  }
  return started;
}

// Per agent that can run copies: the limit, how many are running and held, and
// why the held ones wait. For the panel and `jobs`.
function copiesView(s) {
  const machine = readMachine();
  return Object.keys(PUBLISHED_MAX).map((agent) => {
    const mine = s.jobs.filter((j) => j.agent === agent && j.copy && j.goal === s.goal?.id);
    const held = mine.filter((j) => j.status === "held");
    return { agent, limit: limitOf(agent), running: mine.filter((j) => j.status === "running" || j.status === "waiting").length,
      held: held.length, heldReason: held.length ? held.sort((a, b) => a.id - b.id)[0].heldReason || copyRoom(s, agent, machine).reason : "" };
  });
}

function delegate() {
  const agent = arg("--agent"), task = arg("--task"), files = arg("--files").split(",").map((x) => x.trim()).filter(Boolean);
  const items = parseItemArg(arg("--item")), title = arg("--title"), againOf = Number(arg("--again")) || null;
  let r;
  try { r = handOut({ agent, task, files, items, title, againOf }); }
  catch (e) { fail(e.message); }
  const { job, who, verdict } = r;
  // The scorecard sizes tasks: advice, printed when the job is bigger than this agent's record suggests.
  const row = scoreRows(readScorecard(store.dir)).find((x) => x.agent === agent), hint = sizeHint(row);
  if (files.length > hint.maxFiles) process.stdout.write(`Scorecard: ${agent} ${hint.note}, so jobs of up to ${hint.maxFiles} file${hint.maxFiles === 1 ? "" : "s"} suit it best (this one has ${files.length}).\n`);
  if (r.practice) {
    out(`Practice job ${job.id}: ${who} would take it (${verdict.reason}).${job.practiceWorktree ? ` A real run would work in its own worktree ${job.practiceWorktree} on ${job.practiceBranch}.` : ""} Nothing launched; the full prompt is in the log. Run \`wait\` to review it.`);
    return;
  }
  if (r.held) {
    out(`Job ${job.id} for ${who} is held: ${job.heldReason}. Its files are reserved and it starts by itself as soon as the machine has room; don't delegate it again. Run \`wait\`.`);
    return;
  }
  out(`Job ${job.id} handed to ${who} (${verdict.reason}). ${files.length ? `It may edit ${files.join(", ")}.` : "Read-only."}${job.worker ? ` ${job.worker} works in its own worktree on ${job.branch}.` : ""} It writes ${jobDoneFile(job)} when done; run \`wait\`.`);
}

// After a job is accepted, the next queued task for its project goes to the
// same agent right away — that's the point of the ready queue. A refusal (the
// agent hit a limit, files conflict) leaves the task queued and says why.
function autoNext(j) {
  const item = peekNext(j.dir, store.dir);
  if (!item) return "";
  const agent = item.agent || j.agent;
  try {
    const r = handOut({ agent, task: item.task, files: item.files || [], preferCopy: agent === j.agent ? j.copy || 0 : 0, items: parseItemArg(item.items || []), title: item.title || "" });
    finishTask(j.dir, item.id, r.job.id, store.dir);
    store.log({ kind: "note", text: `Ready queue: "${item.task.slice(0, 80)}" went to ${agent} automatically as job ${r.job.id}.` });
    return r.practice
      ? ` Next queued task logged for ${agent} (practice).`
      : r.held ? ` Next queued task is job ${r.job.id} for ${agent}, held until the machine has room (${r.job.heldReason}).`
      : ` Next queued task went to ${agent} as job ${r.job.id}.`;
  } catch (e) {
    store.log({ kind: "note", text: `Ready queue: "${item.task.slice(0, 80)}" stays queued — ${e.message}` });
    return ` Next queued task stays queued: ${e.message}`;
  }
}

// `C queue`: the ready-task list for the current goal's project. She fills it
// while planning; an accepted job hands the next one to the same agent at once.
function queueCmd() {
  const g = store.read().goal;
  if (!g || !g.dir) fail("No goal is running, so there is no project queue.");
  const sub = process.argv[3];
  if (sub === "rm") {
    const id = Number(process.argv[4]);
    if (!removeTask(g.dir, id, store.dir)) fail(`No queued task ${id}.`);
    store.log({ kind: "note", text: `Ready queue: task ${id} removed.` });
    out("removed");
    return;
  }
  const task = arg("--task");
  if (task) {
    const files = arg("--files").split(",").map((x) => x.trim()).filter(Boolean);
    const item = addTask(g.dir, { task, files, agent: arg("--agent"), items: parseItemArg(arg("--item")), title: arg("--title") }, store.dir);
    store.log({ kind: "note", text: `Ready queue: "${task.slice(0, 80)}" queued (${files.length ? files.join(", ") : "read-only"}${item.agent ? ", for " + item.agent : ", any agent"}).` });
    out(`Queued as task ${item.id}. It goes to ${item.agent || "the finishing agent"} automatically when the current job is accepted.`);
    return;
  }
  const q = queueView(g.dir, store.dir);
  if (!q.length) { out("The ready queue is empty."); return; }
  out(q.map((t) => `${t.id}. ${t.task}${t.files.length ? `  [${t.files.join(", ")}]` : "  [read-only]"}${t.agent ? `  → ${t.agent}` : ""}`).join("\n"));
}

// What `wait` reports as still working: running jobs plus finished ones whose
// self-merge is still running in the background.
const busyJobs = (s) => s.jobs.filter((j) => j.status === "running" || inHand(j))
  .map((j) => ({ id: j.id, agent: j.agent, worker: j.worker || null, ...(j.selfMerging ? { selfMerging: true } : {}) }));

async function waitJob() {
  const until = Date.now() + Math.min(560, Number(arg("--timeout", "100")) || 100) * 1000;
  for (;;) {
    sweep();
    releaseHeld();
    const s = store.read();
    // Finished jobs and self-merged ones waiting for their background review,
    // oldest finish first. A job still self-merging is not hers to review yet.
    const next = [...reviewQueue(s.jobs).filter((j) => !inHand(j)), ...s.jobs.filter((j) => j.status === "merged" && !inHand(j))]
      .sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0) || a.id - b.id)[0];
    if (next) {
      const files = changedFiles(next.dir, next.commit);
      // Earlier finished, merged or accepted jobs in this goal that changed the same files: check against them first.
      const earlier = s.jobs.filter((j) => j.id !== next.id && j.goal === next.goal && ["finished", "merged", "accepted"].includes(j.status) && (j.finishedAt || 0) <= (next.finishedAt || 0))
        .map((j) => ({ id: j.id, agent: j.agent, commit: j.commit, shared: overlaps(changedFiles(j.dir, j.commit), files) })).filter((x) => x.shared.length);
      let tail = ""; try { tail = fs.readFileSync(next.log, "utf8").slice(-2500); } catch {}
      return out({ review: { id: next.id, agent: next.agent, worker: next.worker || null, dir: runDir(next), files: next.files, task: next.task, summary: next.summary, commit: next.commit, changedFiles: files,
        guardViolation: next.guardViolation || null,
        checkAgainst: earlier, logTail: tail, queue: queueView(next.dir, store.dir) }, stillRunning: busyJobs(s), signals: recentSignals(store.dir, 6),
        next: "Review it now: read its report and check it against the goal; read the full diff yourself only when the change is risky or the report doesn't add up. Compare it with any earlier job listed under checkAgainst. Fix small problems yourself or send it back with a new delegate. Then `review " + next.id + " accept|send-back --note ...`." });
    }
    const held = s.jobs.filter((j) => j.status === "held").map((j) => ({ id: j.id, agent: j.agent, worker: j.worker || null, heldReason: j.heldReason || "" }));
    if (!s.jobs.some((j) => j.status === "running" || j.status === "waiting" || inHand(j)) && !held.length) return out({ review: null, stillRunning: [], next: "No jobs are running." });
    if (s.goal?.status === "stopped") return out({ review: null, next: "Stopped by the owner. End now." });
    if (Date.now() > until) return out({ review: null, stillRunning: busyJobs(s), held,
      next: held.length ? `Still running; ${held.length} held cop${held.length === 1 ? "y starts" : "ies start"} by itself when the machine has room. Call \`wait\` again.` : "Still running; call `wait` again." });
    await sleep(5000);
  }
}

// Merges into a project (self-merge, accept, a send-back's revert) run one at a
// time across her processes: constance-mergelock.mjs, a pid-owned lock in her
// state dir that is only stale once its holder is gone. Review and revert keep
// the short default wait; a self-merge waits as long as the holder runs.
function withMergeLock(fn, opts = {}) {
  return withLock(path.join(store.dir, "merge.lock"), fn, opts);
}

// Accept means the copy's branch merges into the repo's current branch, then
// its worktree and branch are cleaned up. A conflict aborts the merge, marks the
// job "conflict", keeps the worktree/branch for the owner, and reports — never
// forces anything.
function mergeAccepted(j) {
  if (!j.worktree || !j.branch) return { ok: true };
  keepTokens(true);
  const m = mergeBranch(j.dir, j.branch);
  if (!m.ok) {
    store.update((s) => { const x = s.jobs.find((k) => k.id === j.id); if (x) { x.status = "conflict"; x.mergeError = m.output || ""; } });
    store.log({ kind: "merge", job: j.id, agent: j.agent, worker: j.worker, text: `merge ${m.conflict ? "conflict" : "failed"} on ${j.branch}: ${(m.output || "").slice(-300)}` });
    return m;
  }
  const did = dropWorktree(j.dir, j.worktree, j.branch, { deleteBranch: true, merged: true });
  store.update((s) => { const x = s.jobs.find((k) => k.id === j.id); if (x) { x.mergedAt = Date.now(); x.mergeCommit = m.commit || ""; x.worktree = ""; x.cleaned = did.join("; "); } });
  store.log({ kind: "merge", job: j.id, agent: j.agent, worker: j.worker, text: `merged ${j.branch} into ${repoBranch(j.dir) || "the current branch"}${m.commit ? ` (${String(m.commit).slice(0, 9)})` : ""}; ${did.join("; ")}` });
  return { ok: true };
}

// A sent-back copy's work is rejected: drop its worktree and branch so temp
// folders don't pile up. The branch is deleted (the work was not merged).
function cleanupRejected(j) {
  if (!j.worktree) return "";
  keepTokens(true);
  const did = dropWorktree(j.dir, j.worktree, j.branch, { deleteBranch: true });
  store.update((s) => { const x = s.jobs.find((k) => k.id === j.id); if (x) { x.worktree = ""; x.cleaned = did.join("; "); } });
  store.log({ kind: "note", job: j.id, agent: j.agent, worker: j.worker, text: `Job ${j.id} sent back; ${did.join("; ") || "worktree cleaned"}.` });
  return did.join("; ");
}

// The scorecard counts every reviewed job once, with its kept tokens and run time.
function score(j, verdict) {
  try {
    if (!j.worktree) keepTokens(true);   // copies already kept theirs before the merge/cleanup
    const fresh = store.read().jobs.find((x) => x.id === j.id) || j;
    recordReview(store.dir, fresh, verdict);
  } catch (e) { store.log({ kind: "note", job: j.id, text: `Scorecard not updated: ${e.message}` }); }
}

function review() {
  const id = Number(process.argv[3]), verdict = process.argv[4], note = arg("--note");
  if (!["accept", "send-back"].includes(verdict)) fail("Usage: review ID accept|send-back --note TEXT");
  // A done file may have landed since the last sweep: bring statuses up to date
  // first so a just-finished job can be reviewed right away.
  sweep();
  const found = store.read().jobs.find((x) => x.id === id);
  if (!found) fail(`No job ${id}.`);
  if (found.selfMerging) fail(`Job ${id} is self-merging right now; try again in a moment.`);
  if (settling(found)) fail(`Job ${id} just finished and is still being checked; try again in a moment.`);
  if (found.status === "merged") return reviewMerged(found, verdict, note);
  if (found.status !== "finished") fail(`Job ${id} is ${found.status}; only a finished job can be reviewed.`);
  const j = store.update((s) => { const j = s.jobs.find((x) => x.id === id); if (j) { j.status = verdict === "accept" ? "accepted" : "sent back"; j.reviewNote = note; j.reviewedAt = Date.now(); } return j; });
  store.log({ kind: "review", job: id, agent: j.agent, worker: j.worker, verdict, text: note });
  // Accepted means the agent is free: merge its branch first (copies only),
  // clean up, then hand it the next queued task for this project immediately.
  if (verdict === "accept" && j.worktree) {
    const m = withMergeLock(() => mergeAccepted(j));
    if (!m.ok) {
      score(j, verdict);
      out(`Job ${id} accepted, but merging ${j.branch} ${m.conflict ? "conflicted" : "failed"}: ${(m.output || "").trim().slice(-300)}. Nothing was forced; the worktree and branch were left in place.`);
      return;
    }
  }
  const cleaned = verdict === "send-back" && j.worktree ? ` ${cleanupRejected(j)}` : "";
  score(j, verdict);
  const extra = verdict === "accept" ? autoNext(j) : `${cleaned}${(() => { const a = sendBackAdvice(store.read().jobs, j); return a ? ` ${a}` : ""; })()}`;
  out(`Job ${id} ${j.status}.${extra}`);
}

// The background review of a self-merged job: accept only confirms the merge
// (the work is already in and its slot frees), send-back reverts the merge
// commit — never a reset, and a failed revert leaves everything as it was.
function reviewMerged(j, verdict, note) {
  store.log({ kind: "review", job: j.id, agent: j.agent, worker: j.worker, verdict, text: note });
  if (verdict === "accept") {
    markReviewed(reviewsFile(), j.id, "ok");
    store.update((s) => { const x = s.jobs.find((k) => k.id === j.id); if (x) { x.status = "accepted"; x.reviewNote = note; x.reviewedAt = Date.now(); } });
    score(j, "accept");
    out(`Job ${j.id} accepted; its self-merge of ${j.branch || "the branch"} is confirmed.${autoNext(j)}`);
    return;
  }
  const target = j.mergeCommit || j.commit;
  const rv = withMergeLock(() => revertMerge(j.dir, target));
  if (!rv.ok) {
    out(`Job ${j.id} send-back failed: reverting ${String(target).slice(0, 9)} didn't apply (${(rv.output || "").trim().slice(-300)}). It stays merged and pending; nothing was forced.`);
    return;
  }
  markReviewed(reviewsFile(), j.id, "reverted");
  store.update((s) => { const x = s.jobs.find((k) => k.id === j.id); if (x) { x.status = "sent back"; x.revertedAt = Date.now(); x.reviewNote = note; x.reviewedAt = Date.now(); } });
  store.log({ kind: "revert", job: j.id, agent: j.agent, worker: j.worker, text: `reverted the self-merge of ${j.branch || "the branch"}${note ? `: ${note}` : ""}` });
  score(j, "send-back");
  out(`Job ${j.id} sent back; its self-merge was reverted.`);
}

// ---------------------------------------------------------------- the goal and the driver
const ROLE = (dir) => `You are Constance, the quarterback of the owner's coding agents. You run on the owner's one paid plan (Claude). You plan, delegate, review and still play yourself when the work is hard or risky. You have full authority: never stop to ask permission.

Your toolbox is \`node ${SELF} <command>\` (call it C below). Work only in ${dir}.
- \`C pace\`: your own session/weekly pacing. Obey its mode. "normal": keep hard, risky or architectural work, delegate routine well-defined low-risk pieces. "delegate": you are burning your limits too fast, so delegate editing and testing too and keep only planning and review. You never run out of your own limits; the driver pauses you at 90% and resumes after the reset.
- \`C agents\`: who is available right now (under their limits, signed in, readable, free), best scorecard first, each with its record (jobs, accepted, sent back, average tokens and time) and how big a job suits it. Re-check right before every handoff; availability changes as limits reset. No agent is the default: spread work over whoever has spare capacity, and size each task to its agent's record. Never use an agent that isn't listed as available, and never anything that costs money.
- The goal's checklist: \`C status\` shows the goal split into numbered items (board.checklist), which the owner watches tick. Tag every handoff with the item it is for, \`--item N\` (or \`--item 1,3\`), and give it \`--title "fixing the guard"\`: a few plain words, starting with a verb in -ing form, shown to the owner as "Devin 2 is fixing the guard". An item ticks when one of its jobs is merged and none is still open. When you finish an item yourself, \`C check N --note "..."\`.
- \`C needs-owner "one plain sentence"\` is only for what truly needs the owner: a decision only they can make, a merge conflict, or a failure that two tries could not fix — never an ordinary failure you can retry or delegate again. Run it before your report; the owner's next queued goal then waits for them instead of starting.
- \`C delegate --agent ID --files a,b --item N --title "..." --task "..."\`: hand off one small, clear task — the smaller and more self-contained, the better; give weaker agents smaller pieces. List every file it may edit; two editing jobs may never share files, and you must not edit a running job's files yourself. For read-only work (investigating a cause, summarizing a file) omit \`--files\`. The tool adds the folder check, git rules, tests/build and done file to the prompt, so the task text itself only needs to say what to do.
- Devin may run as several copies at once (up to ${limitOf("devin")}): each editing job gets its own worktree and branch, shows up as Devin 1..${limitOf("devin")}, and merges into the project only after you accept it. Give copies tasks whose files never overlap; if a merge ever conflicts the job is marked and left for the owner — report it, don't force it. Copies ramp up as the machine allows: a delegate may come back "held" — its files are reserved and it starts by itself when the load and free memory allow, so never delegate it again; just keep going and \`wait\`.
- Second-try rule: when a job comes back wrong, a redo goes out with \`--again ID\` (the job it redoes). Work sent back twice is never resent as it was: split it into smaller jobs with fewer files each, or do it yourself. \`delegate\` refuses a third try with the same files.
- Use it or lose it: \`C spare\` shows which agents have room they would lose at a reset that is close, and which items of this project's backlog (\`C backlog\`; \`C backlog add --kind review|bug|design|task|test|docs --text "..."\`) could use it. Spend leftover room only on backlog items, never on made-up work just to burn it. Your own leftover Opus goes to reviews, tangled bugs and design. When you hand a backlog item out, \`C backlog take N --job ID\`; when it is finished, \`C backlog done N\`.
- When a bug's cause is unknown, the first handoff changes nothing: tell the agent to find the cause, report it in a few lines and stop. Send the fix as a second handoff once you know the cause.
- When a large file needs reading, hand that to a free agent to summarize instead of reading it all yourself.
- Some work stays with you, never delegated: live database changes, bugs tangled across many parts of the code, and anything involving secrets or credentials.
- \`C wait --timeout 540\` (give your Bash tool a 600000 ms timeout for it; long waits save your limits): blocks until a job finishes and gives you the next one to review, oldest finish first. The agent runs the tests and build itself and reports in plain text what changed, the results and the files. Check the report against the goal; read the full diff yourself only when the change is risky or the report doesn't add up. Compare with any earlier job it lists under checkAgainst. Fix small problems yourself or send it back with a new delegate. Then \`C review ID accept|send-back --note "..."\`.
- \`C status\` shows \`practice: true\` during a dry run (the panel's Practice switch, on by default for now): plan and delegate exactly as usual — the tool logs each handoff's agent, reason and full prompt instead of launching it — but don't edit files yourself, and say in your report that it was a practice run.
- \`C note "..."\`: a short line in the owner's log for anything he should know.
- \`C queue --task "..." [--files a,b] [--agent ID]\`: while planning, keep a short queue of ready tasks for this project so free agents never sit idle. When you accept a job, the next queued task is handed to the same agent automatically. \`C queue\` lists what is pending, \`C queue rm ID\` drops one.
- \`C signals\`: recent "agent finished" notifications heard from the desktop. One matched to your job means check it; one for an agent with no job is the owner's own run — noted, never touched.
- \`C lesson "..."\`: add one short lesson to your lessons file — something you learned the hard way this goal (a skipped check, a surprise an agent caused, a rule that saved time). It is advice for your future goals, never a rule that overrides the ones above. Read your lessons before each goal; they are already in your first message.
- Never end your turn or write a final report while checklist items are still todo or jobs are open: delegate again or run \`wait\`. Stop only when the goal is done, you are out of room (pace pauses you), or something truly needs the owner.
Before you edit anything, run \`git status\`; commit only your own changes, never push or deploy. When the goal is done and every job is reviewed, finish with a short plain report for the owner: what was done, by whom, the commits, anything left open.`;

// The project folder for a goal: --dir, or a "+ New project" name made in ~/Projects. Throws with a
// human reason when it can't be used (never the home folder itself).
function resolveDir(dirArg, fresh) {
  let dir = path.resolve(dirArg || ".");
  if (fresh) {   // "+ New project" in the folder step: made in ~/Projects with git set up, as Start and CS do
    if (fresh.includes("/") || fresh.startsWith(".")) throw new Error("Use a plain folder name.");
    dir = path.join(process.env.SQUAD_PROJECTS || path.join(process.env.HOME, "Projects"), fresh);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      spawnSync("bash", ["-c", 'source "$1"; init_repo "$2"', "_", path.join(HERE, "folders.sh"), dir], { env: ENV });
    }
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`No such folder: ${dir}`);
  // Never the home folder itself (or anything above it): she and her agents run
  // with permission prompts skipped, so the project folder is their whole world.
  const home = path.resolve(process.env.HOME || "/");
  const real = fs.realpathSync(dir);
  if (real === home || real === "/" || home.startsWith(real.endsWith("/") ? real : real + "/")) throw new Error("Pick a project folder first: Constance never works in your home folder itself.");
  return dir;
}

// Make `text` in `dir` the current goal (refused while one is active). `from` is the queued goal's id.
function beginGoal(text, dir, extra = {}) {
  const res = store.update((s) => {
    if (s.goal && ["running", "paused"].includes(s.goal.status)) return { busy: s.goal };
    s.goal = { id: randomUUID().slice(0, 8), text, dir, items: parseItems(text), status: "running", session: randomUUID(), startedAt: Date.now(), started: false, ...extra };
    s.jobs = s.jobs.filter((j) => j.status === "running");   // a fresh goal starts a fresh job list
    return s.goal;
  });
  if (res.busy) return res;
  store.log({ kind: "goal", text: `${text} (in ${dir})` });
  return res;
}

function startGoal() {
  const text = arg("--goal").trim();
  if (!text) fail("Tell Constance a goal first.");
  let dir;
  try { dir = resolveDir(arg("--dir"), arg("--new")); } catch (e) { fail(e.message); }
  const res = beginGoal(text, dir);
  if (res.busy) fail(`Constance is already on a goal: "${res.busy.text}". Stop it first, or add this one to her goal queue.`);
  resumeQueue(store.dir);   // the owner starting a goal by hand is the go-ahead for the queue again
  spawnDriver();
  out(`Constance is on it: ${text}`);
}

// ---------------------------------------------------------------- goal end, history and the goal queue
const historyFile = () => path.join(store.dir, "history.jsonl");
function readHistory() {
  try { return fs.readFileSync(historyFile(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
// Keep the goal that just ended in history.jsonl (once per goal), with its tokens kept first.
function recordHistory(fresh = true) {
  let records = [];
  try { records = keepTokens(fresh); } catch {}
  const s = store.read();
  if (!s.goal || ["running", "paused"].includes(s.goal.status)) return null;
  if (readHistory().some((r) => r.id === s.goal.id)) return null;
  const rec = goalRecord(s.goal, asAccepted(s.jobs), matchJobs(s.jobs, records));
  // The same leverage object status shows, kept on the history line; and, once
  // per goal like the record itself, one lesson naming the handoff that paid
  // off best (jobs carry tokens and their review verdicts for it).
  rec.leverage = leverageView(s, tokenMeter({ jobs: s.jobs, goal: s.goal, records }).goal?.total ?? null);
  const back = bestReturnLesson(s.jobs.filter((j) => j.goal === s.goal.id).map((j) => ({
    ...j, verdict: j.status === "accepted" || j.status === "merged" ? "accept" : j.status === "sent back" ? "send-back" : "review" })));
  if (back) addLesson(back, store.dir);
  fs.appendFileSync(historyFile(), JSON.stringify(rec) + "\n");
  return rec;
}

// Quiet desktop notice (no sound: only the reset cha-ching makes noise).
function tellOwner(title, body) {
  try { spawnSync("notify-send", ["-a", "Constance", "-t", "10000", "-u", "normal", "-i", "dialog-warning", "-h", "boolean:suppress-sound:true", title, body], { env: ENV, timeout: 5000, stdio: "ignore" }); } catch {}
}

// A goal just ended (done or failed) in the driver. Record it; then either stop the goal queue and
// tell the owner why, or start the next queued goal. Returns true when a next goal was started.
function afterGoal() {
  const s = store.read(), g = s.goal;
  if (!g || ["running", "paused"].includes(g.status)) return false;
  const why = needsOwner(g, asAccepted(s.jobs), { practice: practiceMode() });
  // A self-merged job still owes its background review: ending the goal with
  // one pending would orphan the revert path, so it stops the queue like an
  // unreviewed finished job does.
  const unreviewedMerged = s.jobs.filter((j) => j.goal === g.id && j.status === "merged").map((j) => j.id);
  if (unreviewedMerged.length) why.push(`job${unreviewedMerged.length > 1 ? "s" : ""} ${unreviewedMerged.join(", ")} merged and still waiting for review`);
  if (why.length) {
    const text = why.join("; ");
    store.update((x) => { if (x.goal && x.goal.id === g.id) x.goal.needsOwner = text.charAt(0).toUpperCase() + text.slice(1) + "."; });
  }
  recordHistory();
  const q = readGoalQueue(store.dir);
  if (why.length) {
    if (q.goals.length) {
      pauseQueue(store.dir, why.join("; "));
      store.log({ kind: "needs-you", text: `Goal queue stopped: ${why.join("; ")}. ${q.goals.length} goal${q.goals.length === 1 ? "" : "s"} wait for you.` });
      tellOwner("Constance needs you", `${why.join("; ")}. The goal queue is stopped until you start the next goal.`);
    } else if (g.fromQueue || g.fromSpare) {
      // The queue ran dry on a goal that needs the owner: the morning report says so (one notice, not two).
      store.log({ kind: "needs-you", text: `${why.join("; ")}.` });
      morningReport();
    } else {
      store.log({ kind: "needs-you", text: `${why.join("; ")}.` });
      tellOwner("Constance needs you", `${why.join("; ")}.`);
    }
    return false;
  }
  const next = takeNext(store.dir);
  if (!next) {
    // The queue is empty. Room an agent would lose at a reset goes to the project's backlog
    // first (use it or lose it); when there's nothing worth doing, the morning report goes out.
    if (startSpareGoal(g)) return true;
    if (g.fromQueue || g.fromSpare) morningReport();
    return false;
  }
  let dir;
  try { dir = resolveDir(next.dir); }
  catch (e) {
    pauseQueue(store.dir, `the next goal's folder can't be used: ${e.message}`);
    // Put it back first in line so nothing is lost.
    const back = addGoal(store.dir, next); moveGoal(store.dir, back.id, "top");
    store.log({ kind: "needs-you", text: `Goal queue stopped: the next goal's folder can't be used (${e.message}).` });
    tellOwner("Constance needs you", `The next queued goal's folder can't be used: ${e.message}`);
    return false;
  }
  const res = beginGoal(next.text, dir, { fromQueue: next.id, driverPid: process.pid });
  if (res.busy) return false;
  store.log({ kind: "note", text: "Started the next goal from the goal queue." });
  spawnWatcher();
  return true;
}

// ---------------------------------------------------------------- use it or lose it, and the morning report
// Limits per agent for the spare-room planner: the agent's own meters, else its first account's.
const limitsOf = (a) => ((a.limits || []).length ? a.limits : (a.accounts || []).find((x) => (x.limits || []).length)?.limits || []);
function sparePlan(dir, d = freshData()) {
  const available = judged(d).filter((a) => a.available).map((a) => a.id);
  return planSpare({ agents: (d.agents || []).map((a) => ({ id: a.id, limits: limitsOf(a) })), available,
    backlog: dir ? openBacklog(dir) : [], settings: readSettings() });
}
const spareFile = () => path.join(store.dir, "spare.json");
function readSpare() { try { const d = JSON.parse(fs.readFileSync(spareFile(), "utf8")); return { used: Array.isArray(d.used) ? d.used : [] }; } catch { return { used: [] }; } }

// When the goal queue is empty and an agent has room it would lose before a reset, start one goal
// made only of the project's own backlog items (never invented work). Once per reset window, so it
// can't loop; the setting (constanceUseItOrLoseIt) turns it off.
function startSpareGoal(g) {
  if (!g?.dir || !useItOrLoseItOn(readSettings())) return false;
  let plan;
  try { plan = sparePlan(g.dir); } catch { return false; }
  const seen = readSpare().used;
  const key = (p) => `${p.agent}:${p.window.title}:${p.window.resetsAt}`;
  const picks = plan.picks.filter((p) => !seen.includes(key(p)));
  if (!picks.length) return false;
  const names = Object.fromEntries((readData().agents || []).map((a) => [a.id, a.name || a.id]));
  const lines = [];
  for (const p of picks) for (const it of p.items)
    lines.push(`${lines.length + 1}. ${p.agent === "claude" ? "You (Constance) do this yourself" : `Hand to ${names[p.agent] || p.agent}`}: ${formatItem(it)} (backlog #${it.id})`);
  const text = [`Use it or lose it: ${plan.reason} Work only on these items from this project's backlog (.constance/backlog.md). If one turns out not to be worth doing, skip it and say why: never make work just to use the room. When an item is finished run \`C backlog done N\` with its backlog number.`, ...lines].join("\n");
  const res = beginGoal(text, g.dir, { fromSpare: true, driverPid: process.pid });
  if (res.busy) return false;
  fs.writeFileSync(spareFile(), JSON.stringify({ used: [...seen, ...picks.map(key)].slice(-200) }) + "\n");
  store.log({ kind: "note", text: `Use it or lose it: started a backlog goal (${picks.map((p) => `${names[p.agent] || p.agent} ${p.window.title}`).join(", ")}).` });
  spawnWatcher();
  return true;
}

// The morning report: what got done since the last one, tokens, and what needs the owner.
function morningReport() {
  try {
    const rep = buildReport({ records: readHistory(), since: lastReportAt(store.dir) });
    const file = writeReport(store.dir, rep);
    store.log({ kind: "morning", text: rep.text.trim(), file });
    tellOwner(rep.title, rep.body);
    return rep;
  } catch (e) { store.log({ kind: "note", text: `Morning report not written: ${e.message}` }); return null; }
}

// `backlog`: the project's worthwhile-work list (list | add --kind K --text T [--files a,b] | take N --job ID | done N | rm N).
function backlogCmd() {
  const g = store.read().goal;
  const dir = arg("--dir") ? path.resolve(arg("--dir")) : g?.dir;
  if (!dir) fail("No goal is running: pass --dir PROJECT.");
  const sub = process.argv[3], n = Number(process.argv[4]);
  if (sub === "add") {
    try { const it = addBacklogItem(dir, { kind: arg("--kind", "task"), text: arg("--text"), files: arg("--files").split(",").map((x) => x.trim()).filter(Boolean) }); out(`Backlog #${it.id}: ${formatItem(it)}`); }
    catch (e) { fail(`${e.message} (kinds: ${BACKLOG_KINDS.join(", ")})`); }
    return;
  }
  if (sub === "take") { if (!markTaken(dir, n, Number(arg("--job")) || 0)) fail(`No backlog item ${n}.`); return out(`Backlog #${n} marked as handed out.`); }
  if (sub === "done") { if (!markDone(dir, n)) fail(`No backlog item ${n}.`); return out(`Backlog #${n} done.`); }
  if (sub === "rm") { if (!removeBacklogItem(dir, n)) fail(`No backlog item ${n}.`); return out(`Backlog #${n} removed.`); }
  const items = readBacklog(dir);
  out(items.length ? items.map((it) => `#${it.id} ${it.done ? "[done] " : it.job !== null ? `[job ${it.job}] ` : ""}${formatItem(it)}`).join("\n") : "The backlog is empty.");
}

// `goals`: the owner's goal queue.
function goalsCmd() {
  const sub = process.argv[3], id = process.argv[4];
  try {
    if (sub === "add") {
      const text = arg("--goal").trim();
      const g = addGoal(store.dir, { text, dir: resolveDir(arg("--dir"), arg("--new")) });
      store.log({ kind: "queue", text: `Goal queued: ${g.text.split("\n")[0].slice(0, 100)} (in ${g.dir})` });
      // Nothing running: the owner adding a goal is the go-ahead, so start it now.
      const cur = store.read().goal;
      if (!cur || !["running", "paused"].includes(cur.status)) {
        const q = readGoalQueue(store.dir);
        if (!q.paused && q.goals.length === 1) return startNextNow();
      }
      return out(`Queued: ${g.text.split("\n")[0].slice(0, 100)}`);
    }
    if (sub === "rm") { const g = removeGoal(store.dir, id); store.log({ kind: "queue", text: `Goal removed from the queue: ${g.text.split("\n")[0].slice(0, 100)}` }); return out("removed"); }
    if (sub === "edit") {
      const text = process.argv.includes("--goal") ? arg("--goal") : undefined;
      const dir = arg("--dir") || arg("--new") ? resolveDir(arg("--dir"), arg("--new")) : "";
      editGoal(store.dir, id, { text, dir }); return out("edited");
    }
    if (sub === "move") { moveGoal(store.dir, id, process.argv[5]); return out("moved"); }
    if (sub === "next") return startNextNow();
  } catch (e) { fail(e.message); }
  const q = readGoalQueue(store.dir);
  out(q);
}
// The owner's "Start next": clears a stopped queue and starts the first goal.
function startNextNow() {
  const cur = store.read().goal;
  if (cur && ["running", "paused"].includes(cur.status)) fail("She is already on a goal; the next one starts when it ends.");
  const next = takeNext(store.dir, { force: true });
  if (!next) fail("The goal queue is empty.");
  let dir;
  try { dir = resolveDir(next.dir); } catch (e) { const back = addGoal(store.dir, next); moveGoal(store.dir, back.id, "top"); fail(e.message); }
  const res = beginGoal(next.text, dir, { fromQueue: next.id });
  if (res.busy) fail("She is already on a goal.");
  spawnDriver();
  out(`Constance is on it: ${next.text.split("\n")[0]}`);
}

// `check N`: she ticks an item she did herself.
function checkCmd() {
  const n = Number(process.argv[3]), note = arg("--note");
  const g = store.read().goal;
  if (!g) fail("No goal.");
  const total = checklist(g, []).total;
  if (!(Number.isInteger(n) && n >= 1 && n <= total)) fail(`Pick an item from 1 to ${total}.`);
  store.update((s) => { s.goal.checked = { ...(s.goal.checked || {}), [n]: note || "done by Constance" }; });
  store.log({ kind: "note", text: `Item ${n} done${note ? ": " + note : ""}.` });
  out(`Item ${n} ticked.`);
}

// `job ID`: one job in full for the panel's card.
function jobCmd() {
  const id = Number(process.argv[3]);
  const s = store.read(), j = s.jobs.find((x) => x.id === id);
  if (!j) fail(`No job ${id}.`);
  const { guardBefore, ...rest } = j;
  out({ ...rest, log: store.readLog(2000).filter((e) => e.job === id && e.kind !== "practice").slice(-20) });
}

function spawnDriver() {
  const child = spawn("node", [SELF, "drive"], { detached: true, stdio: "ignore", env: ENV });
  child.unref();
  store.update((s) => { if (s.goal) s.goal.driverPid = child.pid; });
  spawnWatcher();
}

// True only for our own `node constance.mjs watch` process.
function isWatcher(pid) {
  if (!(pid > 0)) return false;
  try {
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return args.some((a) => a.endsWith("constance.mjs")) && args.includes("watch");
  } catch { return false; }
}

function watcherPid() {
  try { return Number(fs.readFileSync(path.join(store.dir, "watcher.pid"), "utf8")); } catch { return 0; }
}

// The notification watcher is a separate read-only process on the session bus.
// It dedupes itself through watcher.pid, so spawning it per driver is safe.
function spawnWatcher() {
  if (isWatcher(watcherPid())) return;
  const w = spawn("node", [SELF, "watch"], { detached: true, stdio: "ignore", env: ENV });
  w.unref();
}

// `watch`: snoop org.freedesktop.Notifications on the session bus (read-only —
// we never call Notify or CloseNotification). Every agent-finished signal is
// matched to a running job, inspected when the done file is missing, or logged
// as the owner's own agent. Single instance via watcher.pid.
async function watch() {
  const pidFile = path.join(store.dir, "watcher.pid");
  try { const p = Number(fs.readFileSync(pidFile, "utf8")); if (isWatcher(p)) process.exit(0); } catch {}
  fs.writeFileSync(pidFile, String(process.pid));
  const bus = spawn("busctl", ["--user", "monitor"], { stdio: ["ignore", "pipe", "ignore"] });
  bus.on("error", () => { store.log({ kind: "note", text: "Notification watcher could not start (busctl missing?)." }); process.exit(0); });
  const parser = new NotifyParser();
  const onEvent = (evt) => {
    // A project-folder job's done file is in its sandbox tmp, not the project:
    // matchJob finds done files through j.worktree, so hand it the tmp as the
    // job's run dir (j.dir still covers folder matching).
    const jobs = store.read().jobs.map((j) => !j.worktree && j.tmp ? { ...j, worktree: j.tmp } : j);
    const ev = handleNotification(evt, { jobs, storeDir: store.dir });
    if (!ev) return;
    if (ev.kind === "agent-done") {
      store.log({ kind: "signal", job: ev.job, agent: ev.agent, text: `"${ev.summary}" — ${ev.inspection}` });
    } else if (ev.kind === "agent-signal") {
      store.log({ kind: "signal", agent: ev.agent, text: `"${ev.summary}" (still running, no done file)` });
    } else {
      store.log({ kind: "signal", agent: ev.agent, text: "finished outside Constance; noted, left alone" });
    }
  };
  let buf = "";
  bus.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const evt = parser.feed(line);
      if (evt) onEvent(evt);
    }
  });
  // A Notify block is emitted when the next bus message starts; on a quiet bus
  // flush anyway so the last notification is never stuck in the parser.
  const flush = setInterval(() => { const evt = parser.end(); if (evt) onEvent(evt); }, 2000);
  bus.on("exit", () => { clearInterval(flush); process.exit(0); });
  // She only listens while she has a goal: once it is done, failed or stopped
  // the watcher (and its busctl) goes away instead of hearing every desktop
  // notification forever.
  setInterval(() => {
    const g = store.read().goal;
    if (!g || !["running", "paused"].includes(g.status)) { try { bus.kill("SIGTERM"); } catch {} process.exit(0); }
  }, 15e3);
  // Keep the event loop alive for the bus stream.
  await new Promise(() => {});
}

// What is still open on the goal, phrased for the nudge she gets when a clean
// exit leaves work unfinished: checklist items not done and jobs still
// running/held/waiting or finished-but-unreviewed. "" when nothing is open.
function openWork(s) {
  const g = s.goal;
  if (!g) return "";
  const items = checklist(g, asAccepted(s.jobs)).items.filter((i) => i.state !== "done").map((i) => i.n);
  const jobs = s.jobs.filter((j) => (!j.goal || j.goal === g.id) && ["waiting", "held", "running", "finished", "merged"].includes(j.status));
  const parts = [];
  if (items.length) parts.push(`items ${items.join(", ")} are still open`);
  if (jobs.length) parts.push(`jobs ${jobs.map((j) => j.id).join(", ")} are open`);
  return parts.join(" and ");
}

// The driver's heartbeat (its watch interval and adopt loop): refresh the
// leverage samples and the phone-safe remote status, each at most once a
// minute. statusPayload() does the sampling; nothing is sent anywhere. It also
// ticks the progress ping: the line goes out as a silent notify-send at most
// once per 15 minutes while a goal runs (constance-progress.mjs keeps the
// stamp in her state dir).
let lastBeat = 0, lastProgressArgs = null;
// notify-send for the progress ping, with test overrides: CONSTANCE_NO_NOTIFY=1
// skips the send, CONSTANCE_NOTIFY_CMD replaces the notify-send binary.
const progressExec = (cmd, args, opts) => {
  if (process.env.CONSTANCE_NO_NOTIFY === "1") return { status: 1 };
  return spawnSync(process.env.CONSTANCE_NOTIFY_CMD || cmd, args, opts);
};
function heartbeat() {
  const now = Date.now();
  if (now - lastBeat < SAMPLE_GAP_MS) return;
  lastBeat = now;
  try { writeRemoteStatus(statusPayload(), remoteFile()); } catch {}
  try {
    if (lastProgressArgs) progressTick({ ...lastProgressArgs, target: TARGET_PER_PCT, stateFile: path.join(store.dir, "progress.json"), exec: progressExec });
  } catch {}
}

async function drive() {
  let pausedLogged = false, failures = 0, nudge = null;
  for (;;) {
    const g = store.read().goal;
    if (!g || !["running", "paused"].includes(g.status)) return;
    const p = pace(claudeOf(freshData()));
    // A goal paused by Claude's own limit wall follows wall.json, not the
    // readings: resumePlan waits out the stated reset plus a grace, then
    // resumes her — no owner ask and no fresh reading required. The raw file
    // is read (not readWall, which expires at `until`) so the grace still
    // counts in the minute after the reset.
    const wallPlan = g.status === "paused" ? resumePlan({ wall: wallJson(), now: Date.now(), goalStatus: g }) : null;
    if (wallPlan?.action === "wait") { await sleep(60e3); continue; }
    if (wallPlan?.action === "resume") {
      store.update((s) => { s.goal.status = "running"; delete s.goal.pauseReason; });
      store.log({ kind: "resumed", text: "The wall's stated reset plus a minute has passed; picking the goal up again." });
      g.status = "running"; delete g.pauseReason;
      pausedLogged = false;
    } else if (p.mode === "stop") {
      store.update((s) => { s.goal.status = "paused"; s.goal.pauseReason = p.reason; });
      if (!pausedLogged) { store.log({ kind: "paused", text: p.reason }); pausedLogged = true; }
      await sleep(60e3); continue;
    }
    if (g.status === "paused") {
      // Resume only on a reading that is current: a cached or unreadable one can't prove the
      // limit is gone (Keep going is the owner's own call and doesn't need one).
      const kept = keptGoing(p);
      if (!canResume(p, claudeOf(readData()))) {
        const why = "Waiting for a current reading of Claude's limits before picking the goal up again.";
        if (g.pauseReason !== why) { store.update((s) => { s.goal.pauseReason = why; }); store.log({ kind: "paused", text: why }); }
        pausedLogged = true;
        await sleep(60e3); continue;
      }
      store.update((s) => { s.goal.status = "running"; delete s.goal.pauseReason; });
      store.log({ kind: "resumed", text: kept ? "You chose Keep going; picking the goal up again." : "Back under her limits; picking the goal up again." });
      pausedLogged = false;
    }
    // After a restart the previous Claude run may still be going: adopt it rather than start a second one.
    if (alive(g.brainPid, "claude")) {
      let killed = false;
      while (alive(g.brainPid, "claude")) {
        const st = store.read().goal;
        if (!st || st.status === "stopped") return;
        if (!killed && pace(claudeOf(readData())).mode === "stop") { killGroup(g.brainPid); killed = true; }
        try { releaseHeld(); fillSlots(); heartbeat(); } catch {}
        await sleep(5000);
      }
      const st = store.read().goal;
      if (!st || st.status !== "running" || killed) continue;
    }
    const resume = g.started;
    // Fresh lessons and this project's own rules go into the first message of
    // every goal (advice only — her core rules above never change). A nudge
    // resume carries its own short message instead of the generic one.
    const prompt = resume
      ? nudge || "You were interrupted (a restart, a pause for your limits, or an error). Run `C jobs` and `C wait` to see where things stand, then carry on with the goal."
      : `Goal from the owner: ${g.text}\nProject folder: ${g.dir}` + lessonsBlock(readLessons(store.dir)) + "\n" + milkPrompt(readMilk(readSettings())) + rulesBlock(readProjectRules(g.dir));
    nudge = null;
    const args = ["-p", "--model", g.model || "opus", "--dangerously-skip-permissions", "--output-format", "text", "--append-system-prompt", ROLE(g.dir),
      ...(resume ? ["--resume", g.session] : ["--session-id", g.session]), prompt];
    const reportPath = path.join(store.dir, `report-${g.id}.txt`);
    const fd = fs.openSync(reportPath, "w");
    const brain = spawn("claude", args, { cwd: g.dir, env: ENV, detached: true, stdio: ["ignore", fd, fd] });
    store.update((s) => { s.goal.started = true; s.goal.brainPid = brain.pid; });
    // Every start for planning leaves a route line: the step, the model she
    // actually runs on, and the router's reason (constance-route.mjs).
    try {
      const rm = g.model || "opus";
      store.log({ kind: "route", step: "plan", model: rm, text: routeModel("plan", { milk: readMilk(readSettings()) }).why });
      logRoute(path.join(store.dir, "routes.jsonl"), { step: "plan", model: rm, job: g.id });
    } catch {}
    let pausedByUs = false;
    const watch = setInterval(() => {
      const st = store.read().goal;
      if (!st || st.status === "stopped") { killGroup(brain.pid); return; }
      try { releaseHeld(); fillSlots(); heartbeat(); } catch {}
      if (pace(claudeOf(readData())).mode === "stop") { pausedByUs = true; killGroup(brain.pid); }
    }, 30e3);
    const code = await new Promise((r) => brain.on("exit", (c) => r(c)));
    clearInterval(watch);
    const now = store.read().goal;
    if (!now || now.status === "stopped") return;
    if (pausedByUs) continue;
    const report = (() => { try { return fs.readFileSync(reportPath, "utf8").trim(); } catch { return ""; } })();
    if (code === 0) {
      const s = store.read();
      // A clean exit is not a finished goal: open checklist items or unreviewed
      // jobs mean she stopped early. Resume her session with a nudge — at most
      // 3 per goal — unless practice mode or an owner flag ends it normally.
      const open = s.goal && ["running", "paused"].includes(s.goal.status) && !practiceMode() && !s.goal.needsOwner ? openWork(s) : "";
      if (open && (s.goal.nudges || 0) < 3) {
        const n = (s.goal.nudges || 0) + 1;
        store.update((x) => { if (x.goal) x.goal.nudges = n; });
        nudge = `The goal is not finished: ${open}. Keep going: delegate or wait, don't ask.`;
        store.log({ kind: "note", text: `Claude exited cleanly but the goal is unfinished (${open}); resumed her, nudge ${n} of 3.` });
        continue;
      }
      store.update((s) => { s.goal.status = "done"; s.goal.finishedAt = Date.now(); s.goal.report = report.slice(-4000); });
      store.log({ kind: "report", text: report.slice(-4000) || "(no report)" });
      if (afterGoal()) { pausedLogged = false; failures = 0; continue; }
      return;
    }
    // Claude said it hit its limit ("You've hit your 5-hour limit · resets 5:50pm (America/New_York)"):
    // a pause until the time it stated, never a failure. pace() reads wall.json and stops her until then.
    const wall = limitWall(report);
    if (wall && (code !== 0 || report.length < 400)) {
      writeWall(store.dir, wall);
      const p2 = pace(claudeOf(readData()));
      store.update((s) => { if (s.goal) { s.goal.status = "paused"; s.goal.pauseReason = p2.reason; } });
      store.log({ kind: "paused", text: p2.reason });
      pausedLogged = true;
      continue;
    }
    // Opus (or whatever she is on) isn't allowed on this Claude plan: drop to the best model that is
    // and restart the goal fresh — a rejected run leaves no session, so --resume can't be used. This
    // doesn't count as a failure.
    const cur = store.read().goal;
    const next = cur && cur.status === "running" ? nextModel(cur.model || "opus", report) : null;
    if (next) {
      store.update((s) => { if (s.goal) { s.goal.model = next; s.goal.session = randomUUID(); s.goal.started = false; } });
      store.log({ kind: "model", text: `${modelName(cur.model || "opus")} isn't allowed on this Claude plan; Constance switched to ${modelName(next)} and started the goal over.` });
      continue;
    }
    if (++failures >= 3) {
      store.update((s) => { s.goal.status = "failed"; s.goal.finishedAt = Date.now(); });
      store.log({ kind: "failed", text: `Claude exited with code ${code} three times. ${report.slice(-400)}` });
      afterGoal();
      return;
    }
    store.log({ kind: "note", text: `Claude exited with code ${code}; retrying in a minute.` });
    await sleep(60e3);
  }
}

function stopAll() {
  // Jobs that were actually running still get their guard check before their
  // worktrees and temp folders go: a stopped agent's stray changes count too.
  // Held/waiting jobs never launched, so there is nothing to check for them.
  const halted = new Set(store.read().jobs.filter((j) => j.status === "running").map((j) => j.id));
  const s = store.update((s) => {
    if (s.goal && ["running", "paused"].includes(s.goal.status)) { s.goal.status = "stopped"; s.goal.finishedAt = Date.now(); }
    for (const j of s.jobs) if (j.status === "running" || j.status === "waiting" || j.status === "held") { if (alive(j.pid, LAUNCH[j.agent]?.cli || "")) killGroup(j.pid); j.status = "stopped"; j.stoppedAt = Date.now(); }
    return JSON.parse(JSON.stringify(s));
  });
  // A self-merge still running in the background dies with everything else;
  // the next sweep clears its flag and the job stays finished for the record.
  for (const j of s.jobs) if (j.selfMerging && alive(j.selfMergePid, "selfmerge")) killGroup(j.selfMergePid);
  // Keep the halted workers' token counts before their worktrees go (only when any ran).
  if (halted.size) keepTokens(true);
  for (const j of s.jobs) if (j.status === "stopped") { if (halted.has(j.id)) guardFinished(j); dropJobTmp(j); if (j.worktree) dropWorktree(j.dir, j.worktree, j.branch, { deleteBranch: true }); }
  const g = s.goal;
  if (g && alive(g.brainPid, "claude")) killGroup(g.brainPid);
  if (g && alive(g.driverPid, "constance.mjs")) killGroup(g.driverPid);
  if (isWatcher(watcherPid())) killGroup(watcherPid());
  store.log({ kind: "stopped", text: "Stop pressed: Constance and every job halted." });
  try { recordHistory(false); } catch {}   // halted workers' counts were kept above
  out("Stopped.");
}

function recover() {
  const g = store.read().goal;
  if (g && ["running", "paused"].includes(g.status) && !alive(g.driverPid, "constance.mjs")) {
    store.log({ kind: "note", text: "Picked up again after a restart." });
    spawnDriver();
    return out("restarted");
  }
  out("ok");
}

// Token meter: keep each launched job's last matched count on the job (worktrees are
// dropped after review and their records with them). `fresh` rescans the usage
// records first; otherwise a background rescan is started while a worker runs.
function keepTokens(fresh = false) {
  if (fresh) refreshNow(ENV);
  const s = store.read();
  if (!fresh && s.jobs.some((j) => j.status === "running")) refreshInBackground({ env: ENV, gap: ENV.CONSTANCE_TOKENS_GAP_MS ? Number(ENV.CONSTANCE_TOKENS_GAP_MS) : undefined });   // tests shorten the 30 s gap
  const { records } = readRecords(usageFile(ENV));
  const keep = snapshots(s.jobs, matchJobs(s.jobs, records));
  if (Object.keys(keep).length) store.update((x) => { for (const j of x.jobs) if (keep[j.id]) j.tokens = keep[j.id]; });
  return records;
}
function tokensView(s, d, records) {
  const names = Object.fromEntries((d.agents || []).filter((a) => a.name).map((a) => [a.id, a.name]));
  const { live, ...view } = tokenMeter({ jobs: s.jobs, goal: s.goal, records, name: (id) => names[id] || (id ? id[0].toUpperCase() + id.slice(1) : id) });
  return view;
}

function boardView(s, d, records) {
  const names = Object.fromEntries((d.agents || []).filter((a) => a.name).map((a) => [a.id, a.name]));
  const name = (id) => names[id] || (id ? id[0].toUpperCase() + id.slice(1) : id);
  const live = matchJobs(s.jobs, records);
  const gq = readGoalQueue(store.dir);
  return {
    checklist: checklist(s.goal, asAccepted(s.jobs)),
    cards: cards({ jobs: s.jobs, goal: s.goal, queue: s.goal && ["running", "paused"].includes(s.goal.status) ? queueView(s.goal.dir, store.dir) : [], live, names: name }),
    // A merged job still waits for her review, so the Now line counts it with the finished ones.
    now: nowLine({ goal: s.goal, jobs: s.jobs.map((j) => (j.status === "merged" ? { ...j, status: "finished" } : j)), names: name, goalQueue: gq.goals, queuePaused: gq.paused }),
    history: history({ records: readHistory(), log: store.readLog(5000), goal: s.goal, jobs: s.jobs, live }),
    goalQueue: gq,
    scorecard: scorecardView(name, s.goal?.dir),
  };
}

// The panel's SCORECARD: one line per agent with a size hint, and the use-it-or-lose-it state.
function scorecardView(name, dir) {
  const rows = scoreRows(readScorecard(store.dir), name).map((r) => {
    const h = sizeHint(r);
    return { agent: r.agent, name: r.name, line: scoreLine(r), hint: `${h.note}: up to ${h.maxFiles} file${h.maxFiles === 1 ? "" : "s"} a job` };
  });
  const spareOn = useItOrLoseItOn(readSettings());
  let spare = "";
  if (spareOn && dir) { try { const p = sparePlan(dir, readData()); spare = p.picks.length ? p.reason : ""; } catch {} }
  return { rows, spareOn, spare };
}

// ---------------------------------------------------------------- leverage, milk, remote
// The leverage meter's samples file: one Claude-session reading at most every
// 60 s, shared by status calls, the remote command and the driver heartbeat.
// The file's own mtime is the throttle, so separate processes agree.
const leverageFile = () => path.join(store.dir, "leverage.jsonl");
const SAMPLE_GAP_MS = 60e3;
const remoteFile = () => path.join(store.dir, "remote-status.txt");

function sampleLeverage(p) {
  const used = (p?.windows || []).find((w) => w.title === "Session")?.used;
  if (!Number.isFinite(used)) return;
  const f = leverageFile();
  try { if (Date.now() - fs.statSync(f).mtimeMs < SAMPLE_GAP_MS) return; } catch {}
  try { addSample(f, { at: Date.now(), used }); } catch {}
}

// Her leverage for the goal on record: the free-agent token total the TOKENS
// section shows for the goal, per 1% of her own session spent since it began.
function leverageView(s, tokens) {
  return leverage({ tokens: tokens ?? null, spentPct: sessionSpent(readSamples(leverageFile(), s.goal?.startedAt)) });
}

// wall.json as stored, expiry ignored: resumePlan needs the stated reset time
// even in the minute after it (readWall returns null there).
function wallJson() {
  try { return JSON.parse(fs.readFileSync(wallFile(store.dir), "utf8")); } catch { return null; }
}

// The progress ping's inputs, shared by status (the Now line) and the driver
// heartbeat (the throttled notify): Devin's share of the goal's tokens, her
// Session window now vs at goal start, and how many copies are running.
// null while no goal is active — there is no pace to report then.
function progressArgs(s, p, tv) {
  const g = s.goal;
  if (!g || !["running", "paused"].includes(g.status)) return null;
  const sess = (p?.windows || []).find((w) => w.title === "Session");
  const usedPct = Number.isFinite(sess?.used) ? sess.used * 100 : NaN;
  const spent = sessionSpent(readSamples(leverageFile(), g.startedAt));
  const devin = (tv.goal?.byAgent || []).find((a) => a.agent === "devin");
  return { devinTokens: devin?.tokens ?? null, sessionUsedPct: usedPct, sessionStartPct: usedPct - spent,
    copiesRunning: s.jobs.filter((j) => j.copy && (j.status === "running" || j.status === "waiting")).length };
}

function statusPayload() {
  sweep();   // the panel's 3 s poll is what notices done files and starts self-merges
  const records = keepTokens();
  fillSlots();
  const s = store.read(), d = readData();
  const p = pace(claudeOf(d));
  sampleLeverage(p);
  const tv = tokensView(s, d, records);
  const pargs = progressArgs(s, p, tv);
  const board = boardView(s, d, records);
  const pline = pargs ? progressLine({ ...pargs, target: TARGET_PER_PCT }) : "";
  if (pline) board.now += ` · ${pline}`;
  lastProgressArgs = pargs;
  return { goal: s.goal, board, progress: { line: pline }, tokens: tv, jobs: s.jobs.map(({ prompt, guardBefore, ...j }) => j), agents: judged(d), pace: p,
    leverage: leverageView(s, tv.goal?.total ?? null), milk: milkPolicy(readMilk(readSettings())), practice: practiceMode(), guards: s.guards || {}, copies: copiesView(s),
    queue: s.goal ? queueView(s.goal.dir, store.dir) : [], signals: recentSignals(store.dir, 10), log: store.readLog(150) };
}

function status() { out(statusPayload()); }

const cmd = process.argv[2];
if (process.argv[1] === SELF) {
  if (cmd === "start") startGoal();
  else if (cmd === "drive") await drive();
  else if (cmd === "status") status();
  // The phone-safe summary (constance-remote.mjs): written to her state dir,
  // nothing is sent anywhere and no port is opened. Prints the file's path.
  else if (cmd === "remote") { writeRemoteStatus(statusPayload(), remoteFile()); out(remoteFile()); }
  else if (cmd === "agents") {
    const d = freshData(), guards = store.read().guards || {}, card = readScorecard(store.dir), rows = scoreRows(card);
    const all = judged(d), order = rankAgents(all.filter((a) => a.available).map((a) => a.id), card);
    // Available agents first, best scorecard first; each with its record and a size hint.
    const sorted = [...order.map((id) => all.find((a) => a.id === id)), ...all.filter((a) => !a.available)];
    out(sorted.map((a) => {
      const row = rows.find((r) => r.agent === a.id), h = sizeHint(row);
      const sc = a.available ? `  [${row ? scoreLine(row) : "no reviewed jobs yet"}; ${h.note}: up to ${h.maxFiles} file${h.maxFiles === 1 ? "" : "s"} a job]` : "";
      return `${a.available ? "AVAILABLE  " : "skip       "}${a.id.padEnd(12)} ${a.reason}${guards[a.id]?.strikes ? `  (guardrail strikes: ${guards[a.id].strikes} — smaller tasks only)` : ""}${sc}`;
    }).join("\n"));
  }
  else if (cmd === "pace") out(pace(claudeOf(freshData())));
  else if (cmd === "jobs") { sweep(); releaseHeld(); const s = store.read(); out({ goal: s.goal && { text: s.goal.text, dir: s.goal.dir, status: s.goal.status }, queue: s.goal ? queueView(s.goal.dir, store.dir) : [], copies: copiesView(s), jobs: s.jobs.map(({ prompt, guardBefore, ...j }) => j) }); }
  else if (cmd === "queue") queueCmd();
  else if (cmd === "backlog") backlogCmd();
  else if (cmd === "scorecard") { const rows = scoreRows(readScorecard(store.dir)); out(rows.length ? rows.map((r) => `${scoreLine(r)} — ${sizeHint(r).note}`).join("\n") : "No reviewed jobs yet."); }
  else if (cmd === "spare") { const g = store.read().goal; const p = sparePlan(arg("--dir") ? path.resolve(arg("--dir")) : g?.dir); out(p.picks.length ? [p.reason, ...p.picks.flatMap((x) => x.items.map((it) => `${x.agent}: #${it.id} ${formatItem(it)}`))].join("\n") : p.reason); }
  else if (cmd === "signals") out(recentSignals(store.dir, 20));
  // The whole log as plain text (the panel's Copy all): every entry, practice prompts in full.
  else if (cmd === "log") { const names = Object.fromEntries((readData().agents || []).map((a) => [a.id, a.name || a.id])); process.stdout.write(logText(store.readLog(Infinity), (id) => names[id] || id)); }
  else if (cmd === "watch") await watch();
  // Internal: the detached half of a self-merge (spawned by maybeSelfMerge).
  else if (cmd === "selfmerge") runSelfMerge(Number(process.argv[3]));
  else if (cmd === "delegate") delegate();
  else if (cmd === "wait") await waitJob();
  else if (cmd === "review") review();
  else if (cmd === "reviews") out(pendingReviews(reviewsFile()));
  else if (cmd === "note") { store.log({ kind: "note", text: process.argv.slice(3).join(" ") }); out("noted"); }
  else if (cmd === "lesson") {
    const text = process.argv.slice(3).join(" ").trim();
    if (!text) fail("Usage: lesson TEXT");
    addLesson(text, store.dir);
    store.log({ kind: "lesson", text });
    out("lesson added");
  }
  else if (cmd === "stop") stopAll();
  else if (cmd === "goals") goalsCmd();
  else if (cmd === "check") checkCmd();
  else if (cmd === "job") jobCmd();
  else if (cmd === "needs-owner") {
    const text = process.argv.slice(3).join(" ").trim();
    if (!text) fail("Usage: needs-owner TEXT");
    logAsk(path.join(store.dir, "asks.jsonl"), { reason: text });
    store.update((s) => { if (s.goal) s.goal.needsOwner = text; });
    store.log({ kind: "needs-you", text });
    out("noted: the goal queue waits for the owner after this goal");
  }
  else if (cmd === "route") {
    const step = process.argv[3];
    if (!step) fail("Usage: route STEP");
    out(routeModel(step, { milk: readMilk(readSettings()) }));
  }
  else if (cmd === "recover") recover();
  else fail("Usage: constance.mjs start|status|remote|agents|scorecard|pace|jobs|job|delegate|wait|review|reviews|check|needs-owner|note|lesson|queue|backlog|spare|goals|signals|log|watch|selfmerge|route|stop|recover");
}
