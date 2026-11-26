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
//   takeover ID                 "Give it to Opus": stop job ID's worker and let Opus (claude) finish it in
//                               the same folder, with the partial diff and the last 50 log lines
//   goals pause | goals resume  the owner's queue pause: the current goal runs on, no queued goal starts
//   stop                        halt everything at once (her, every job)
//   recover                     panel load: restart the driver if a goal is active and it isn't running
//   route STEP                  which model her STEP runs on, as JSON (constance-route.mjs)
//   batchreview [--apply FILE]  review up to 5 self-merged jobs in one pass; --apply
//                               parses a verdict reply and confirms/reverts each
//   split [--goal TEXT] [--dir D]   autosplit a goal into delegate-ready jobs, as JSON
//   spec KIND --what ... --files ... --accept ...   fill a job-spec template, as text
//   drive                       (internal) the background loop that runs her and paces her
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { judgeAll, launchCommand, accountEnv, LAUNCH, preferOrder, KILO_NOTE, kiloPaidVerdict, reviewText } from "./constance-agents.mjs";
import { copyLimit, roomForCopy, readMachine, PUBLISHED_MAX } from "./constance-ramp.mjs";
import { pace, canResume, keptGoing } from "./constance-pace.mjs";
import { writeWall, wallFile, clock } from "./constance-wall.mjs";
import { nextModel, modelName } from "./constance-model.mjs";
import { openStore, conflicts, handoffPrompt, doneFile, reviewQueue, overlaps, settling, inHand } from "./constance-jobs.mjs";
import { readLessons, addLesson, lessonsBlock, readProjectRules, rulesBlock, guardrailBlock } from "./constance-lessons.mjs";
import { snapshot as guardSnapshot, checkRun, restoreRun, fileCap, commitFiles } from "./constance-guard.mjs";
import { NotifyParser, handleNotification, recentSignals, recordSignal, jobFinishSignal, logSaysFinished } from "./constance-notify.mjs";
import { addTask, peekNext, finishTask, removeTask, queueView, readyTasks, expireTasks, pendingTasks } from "./constance-queue.mjs";
import { withLock } from "./constance-mergelock.mjs";
import { selfMerge, selfMergeBranch, runSuite, testCommands, addPending, pendingReviews, markReviewed, revertMerge } from "./constance-selfmerge.mjs";
import { safeGit, trackedDirty } from "./constance-git.mjs";
import { dirtyPaths } from "./constance-guard.mjs";
import { sandboxProblem, sandboxLaunch, bwrapWorks } from "./constance-sandbox.mjs";
import { logText } from "./constance-logtext.mjs";
import { createWorktree, mergeBranch, dropWorktree, repoBranch, worktreeFor, branchFor } from "./constance-worktree.mjs";
import { tokenMeter, matchJobs, snapshots, readRecords, usageFile, refreshInBackground, refreshNow } from "./constance-tokens.mjs";
import { parseItems, parseItemArg, checklist } from "./constance-checklist.mjs";
import { cards, nowLine, history, goalRecord, meters } from "./constance-board.mjs";
import { readGoalQueue, addGoal, removeGoal, editGoal, moveGoal, takeNext, pauseQueue, resumeQueue, queueStops, holdQueue, releaseQueue } from "./constance-goalqueue.mjs";
import { stuckCheck, expectedMs, activitySignature, observe, dueForCheck, IDLE_MS, CHECK_GAP_MS } from "./constance-stuck.mjs";
import { OPUS, opusCommand, autoTakeoverOn, takeoverProblem, opusBlocked, lastLines, partialDiff, readTail, takeoverPrompt } from "./constance-takeover.mjs";
import { readScorecard, recordReview, scoreRows, sizeHint, rankAgents, scoreLine } from "./constance-scorecard.mjs";
import { secondTry, sendBackAdvice, shouldAutoRetry, retrySpec } from "./constance-retry.mjs";
import { refill } from "./constance-refill.mjs";
import { batches, batchPrompt, parseVerdicts, applyVerdicts } from "./constance-batchreview.mjs";
import { ratioReport, saveReport } from "./constance-ratio-report.mjs";
import { autosplit } from "./constance-autosplit.mjs";
import { fillSpec } from "./constance-specs.mjs";
import { planSpare, useItOrLoseItOn } from "./constance-spare.mjs";
import { readBacklog, addItem as addBacklogItem, markTaken, markDone, removeItem as removeBacklogItem, openItems as openBacklog, formatItem, KINDS as BACKLOG_KINDS } from "./constance-backlog.mjs";
import { buildReport, writeReport, lastReportAt } from "./constance-morning.mjs";
import { addSample, readSamples, sessionSpent, leverage, bestReturnLesson, TARGET_PER_PCT } from "./constance-leverage.mjs";
import { readMilk, milkPolicy, milkPrompt, milkStep, MILK_STEPS } from "./constance-milk.mjs";
import { writeRemoteStatus } from "./constance-remote.mjs";
import { briefFor } from "./constance-brief.mjs";
import { progressLine, tick as progressTick } from "./constance-progress.mjs";
import { resumePlan, logAsk } from "./constance-resume.mjs";
import { projectDirProblem } from "./constance-projectdir.mjs";
import { goalReport } from "./constance-report.mjs";
import { memoryOf, addDecision, addProblem, solveProblem, addNext, beginStep, endStep, openStep, renderHandoff, handoffFile, writeHandoff, insidePlugins } from "./constance-handoff.mjs";
import { nextStep, stepPrompt, resumedFrom, progressMark, MAX_NUDGES } from "./constance-steps.mjs";
import { routeModel, logRoute } from "./constance-route.mjs";
import { pickBrain, topModel, brainLimits, brainCommand, brainWall, milkLabel } from "./constance-brain.mjs";
import { buildSummary } from "./constance-summary.mjs";

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);
const ENV = { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH || ""}` };
const base = openStore();
const STATE = path.dirname(base.dir);   // <state>/omarchy/agent-usage-tabs
// jobs.json is hand-editable state: a null job entry or a goal/guards value that
// isn't an object would crash readers and writers alike. Every read and update
// sees only well-shaped entries — bad ones are skipped, never wiped by a crash.
const cleanState = (s) => {
  if (s && typeof s === "object") {
    s.jobs = (Array.isArray(s.jobs) ? s.jobs : []).filter((j) => j && typeof j === "object");
    if (!s.goal || typeof s.goal !== "object" || Array.isArray(s.goal)) s.goal = null;
    if (!s.guards || typeof s.guards !== "object") s.guards = {};
  }
  return s;
};
const store = { ...base, read: () => cleanState(base.read()), update: (fn) => base.update((s) => fn(cleanState(s))) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, fallback = "") { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; }
function out(x) { process.stdout.write(typeof x === "string" ? x + "\n" : JSON.stringify(x, null, 2) + "\n"); }
function fail(msg) { process.stderr.write(msg + "\n"); process.exit(1); }

// Small state files are rewritten through a temp file in the same folder + rename, so a
// concurrent reader never sees a torn file; the temp is removed if the rename fails.
export function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

// A pid is ours only if it is alive and its command line still names what we started.
export function alive(pid, needle = "") {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); } catch { return false; }
  if (!needle) return true;
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(needle); } catch { return false; }
}
const claudeOf = (d) => (d.agents || []).find((a) => a.id === "claude");   // takeover always runs Claude
function killGroup(pid, sig = "SIGTERM") { try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} } }
// The CLI a job's process runs: its agent's, or Claude Code's once Opus took it over.
const cliOf = (j) => (j.handedFrom ? OPUS.cli : LAUNCH[j.agent]?.cli || "");

// data.json is collector output but still just a file on disk: a payload that
// isn't an object, or an agents list holding non-object entries, reads as no
// data rather than crashing every command that uses it.
function readData() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(STATE, "data.json"), "utf8"));
    if (!d || typeof d !== "object" || Array.isArray(d)) return { agents: [] };
    return { ...d, agents: (Array.isArray(d.agents) ? d.agents : []).filter((a) => a && typeof a === "object" && !Array.isArray(a)) };
  } catch { return { agents: [] }; }
}
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
// Her planning brain (constance-brain.mjs): Claude Code by default, or Antigravity's
// `agy` when the owner picked it and opted it into the sandboxed keyring. brainOf()/paceNow()
// hand pace() the brain's own limits — for agy that's only the quota pool her chosen model
// burns, renamed to plain Session/Weekly so the pacing windows line up with Claude's.
const brainNow = () => pickBrain(readSettings());
const agyOf = (d) => (d.agents || []).find((a) => a.id === "antigravity");
const brainTop = (d, b) => (b.id === "antigravity" ? topModel(agyOf(d), readSettings()) : null);
const brainName = (b) => (b && b.id === "antigravity" ? "Antigravity" : "Claude");
const brainCli = (id) => (id === "antigravity" ? "agy" : "claude");
// The model one brain run spawns with: agy's picked model id, else her Claude model.
function brainModel(d, b) {
  if (b.id === "antigravity") return brainTop(d, b)?.id || "";
  return store.read().goal?.model || "opus";
}
function brainOf(d) { const b = brainNow(); return brainLimits(d, b.id, brainTop(d, b)); }
function paceNow(d) {
  const b = brainNow();
  return pace(brainLimits(d, b.id, brainTop(d, b)), Date.now(), undefined, { name: brainName(b) });
}

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
const judged = (d) => {
  const list = judgeAll(d, Date.now(), { sandbox: boxProblem });
  // While agy is her brain it never doubles as a worker.
  if (brainNow().id === "antigravity")
    for (const a of list) if (a.id === "antigravity") { a.available = false; a.reason = "it is her brain right now"; }
  return list;
};

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
// Jobs handed out since 1.50.2 (doneInTmp) write their done file in their own
// sandbox tmp, copies too: a worker can't write .constance/ anywhere. Older
// copies still running wrote theirs in the worktree.
const jobDoneDir = (j) => (j.doneInTmp ? j.tmp : j.worktree || j.tmp) || runDir(j);
const jobDoneFile = (j) => doneFile(jobDoneDir(j), j.id);

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

// A done file that won't parse is given this long (by its last write) to be
// finished by its agent before the sweep believes it: agents write the file in
// more than one write, and a read between them must not end a healthy job.
const DONE_FILE_STALE_MS = 10e3;

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
      // A running record with no dir, worktree or tmp has nowhere a done file
      // could be: jobDoneFile() throws on it, so treat the file as missing.
      const f = (() => { try { return jobDoneFile(j); } catch { return ""; } })();
      let done = null, source = "";
      // A done file that exists but doesn't parse may just be caught mid-write:
      // it only counts once the agent is gone AND the file has sat unparseable
      // for DONE_FILE_STALE_MS, so a healthy run is never finished on a torn read.
      let awaitingDone = false;
      try { done = JSON.parse(fs.readFileSync(f, "utf8")); j.finishedAt = fs.statSync(f).mtimeMs; source = "done-file"; }
      catch {
        if (fs.existsSync(f)) {
          let age = Infinity;
          try { age = Date.now() - fs.statSync(f).mtimeMs; } catch {}
          if (!alive(j.pid, cliOf(j)) && age > DONE_FILE_STALE_MS) { done = { summary: "(done file was not valid JSON)", commit: "" }; j.finishedAt = Date.now(); source = "done-file"; }
          else awaitingDone = true;
        }
      }
      if (!done && !awaitingDone && !alive(j.pid, cliOf(j))) { done = { summary: j.summaryNote ? `(${j.summaryNote}; the worker had been stopped)` : "(the agent exited without writing its done file)", commit: "" }; j.finishedAt = Date.now(); source = "exit"; }
      // A worker can't commit, so its done file's "commit" is only what it claimed
      // (kept as reportedCommit); the job's commit is the one commitForJob makes.
      // `tests` is the worker's own claim, shown on its card only: it is never a
      // self-merge signal (that is the sandboxed suite's job).
      if (done) { j.status = "finished"; j.settling = Date.now(); j.summary = reviewText(j.agent, String(done.summary || "")); j.reportedCommit = String(done.commit || ""); j.commit = ""; if (done.tests !== undefined) j.tests = done.tests; changed.push(j); signals.push({ j, source }); }
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
    try {
      // A kilo run that billed fails on the spot: no guard, commit, retry or self-merge.
      if (kiloPaidFail(j)) { dropJobTmp(j); continue; }
      guardFinished(j); commitForJob(j); dropJobTmp(j); autoRetry(j); maybeSelfMerge(j);
    }
    finally { store.update((s) => { const x = s.jobs.find((k) => k.id === j.id); if (x) delete x.settling; }); }
  }
  // Whoever's sweep sees the finish logs the return — status polls can beat `wait` to it.
  for (const j of changed) store.log({ kind: "returned", job: j.id, agent: j.agent, worker: j.worker, account: j.account?.label || "", text: j.summary + (j.commit ? ` (commit ${j.commit.slice(0, 9)})` : "") });
  for (const { j, source } of signals) recordSignal(store.dir, jobFinishSignal(j, { source, runDir: jobDoneDir(j) }));
  checkStuck();
  fillSlots();
  return changed;
}

// ---------------------------------------------------------------- stuck jobs and "Give it to Opus"
// Every sweep looks at running jobs (each one's files and log at most every 30 s,
// constance-stuck.mjs): more than twice its agent's usual time on the scorecard, or
// 15 minutes with no file change and no log output, flags it stuck. A newly stuck job
// is logged and the owner gets one silent notification; when the Milk Opus slider
// leans toward Opus (constance-takeover.mjs AUTO_FROM) it goes to Opus by itself.
// Tests shorten the windows with CONSTANCE_STUCK_IDLE_MS / CONSTANCE_STUCK_CHECK_MS.
const envMs = (name, dflt) => (process.env[name] !== undefined && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : dflt);
function checkStuck() {
  try {
    const running = store.read().jobs.filter((j) => j.status === "running");
    if (!running.length) return;
    const now = Date.now(), gap = envMs("CONSTANCE_STUCK_CHECK_MS", CHECK_GAP_MS), idleMs = envMs("CONSTANCE_STUCK_IDLE_MS", IDLE_MS);
    let rows = null;
    const newly = [];
    for (const j of running) {
      const due = dueForCheck(j.activity, now, gap);
      const activity = due ? observe(j.activity, activitySignature(runDir(j), j.log), now) : j.activity;
      rows ??= scoreRows(readScorecard(store.dir));
      // Opus's own run is timed from its takeover; it has no scorecard row of its own at first.
      const res = stuckCheck({ ...j, startedAt: j.takenOverAt || j.startedAt }, { now, expected: expectedMs(rows.find((r) => r.agent === j.agent)), activityAt: activity?.at || 0, idleMs });
      if (!due && !!j.stuck === res.stuck) continue;
      const flagged = store.update((s) => {
        const x = s.jobs.find((k) => k.id === j.id);
        if (!x || x.status !== "running") return false;
        if (activity) x.activity = activity;
        if (!res.stuck) { delete x.stuck; return false; }
        const fresh = !x.stuck;
        x.stuck = { kind: res.kind, reason: res.reason, at: x.stuck?.at || now };
        if (fresh && !x.stuckNotified) { x.stuckNotified = now; return { ...x }; }
        return false;
      });
      if (flagged) newly.push(flagged);
    }
    for (const j of newly) {
      const who = j.worker || j.agent;
      store.log({ kind: "stuck", job: j.id, agent: j.agent, worker: j.worker, text: `looks stuck: ${j.stuck.reason}.` });
      let auto = "";
      if (!j.handedFrom && autoTakeoverOn(readMilk(readSettings()))) {
        try { takeOver(j.id, { auto: true, reason: `it looked stuck: ${j.stuck.reason}` }); auto = "handed to Opus automatically"; }
        catch (e) { store.log({ kind: "note", job: j.id, agent: j.agent, text: `not handed to Opus automatically: ${e.message}` }); }
      }
      tellOwner(`Job ${j.id} looks stuck`, `${who}: ${j.stuck.reason}. ${auto ? "Milk Opus is high, so it was " + auto + "." : j.handedFrom ? "Opus already has it; you may want to stop it." : "Open her panel and press Give it to Opus."}`);
    }
  } catch (e) { store.log({ kind: "note", text: `Stuck check skipped: ${e.message}` }); }
}

const pause = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
function waitGone(pid, needle, ms = 5000) {
  const end = Date.now() + ms;
  while (alive(pid, needle) && Date.now() < end) pause(100);
  if (alive(pid, needle)) { killGroup(pid, "SIGKILL"); pause(300); }
  return !alive(pid, needle);
}

// "Give it to Opus": stop the worker (its partial changes and log stay where they are) and
// relaunch the same job as Opus in the same folder or worktree, in the same sandbox kind,
// with the original prompt, the partial diff and the last 50 log lines. The job keeps its
// id, files, guard snapshot (the guard checks the worker's and Opus's changes together), done
// file and review path; its card shows Opus as the worker. Throws with a reason on refusal.
function takeOver(id, { auto = false, reason = "" } = {}) {
  const g = store.read().goal;
  if (!g || !["running", "paused"].includes(g.status)) throw new Error("No goal is running.");
  if (practiceMode()) throw new Error("Practice mode is on: nothing launches, so nothing can go to Opus.");
  const blocked = opusBlocked(claudeOf(readData()), { auto });
  if (blocked) throw new Error(`Opus can't take it now: ${blocked}.`);
  const box = boxProblem(OPUS.agent);
  if (box) throw new Error(`Opus can't run sandboxed: ${box}.`);
  // Claim it: "waiting" keeps the sweep off it while the worker stops, and Stop still covers it.
  const j = store.update((s) => {
    const x = s.jobs.find((k) => k.id === id);
    const problem = takeoverProblem(x);
    if (problem) return { problem };
    x.status = "waiting"; x.handingOver = Date.now();
    return { ...x };
  });
  if (j.problem) throw new Error(`Can't give it to Opus: ${j.problem}.`);
  const back = (extra = {}) => store.update((s) => { const x = s.jobs.find((k) => k.id === id); if (x) { x.status = "running"; delete x.handingOver; Object.assign(x, extra); } });
  if (alive(j.pid, cliOf(j))) killGroup(j.pid);
  waitGone(j.pid, cliOf(j));
  // It finished on its own just now: let the sweep take it the normal way.
  if (fs.existsSync(jobDoneFile(j))) { back(); throw new Error(`job ${id} just finished on its own; it goes to review.`); }
  keepTokens(true);
  const workerTokens = store.read().jobs.find((k) => k.id === id)?.tokens ?? null;
  const rd = runDir(j);
  const from = j.worker || (readData().agents || []).find((a) => a.id === j.agent)?.name || j.agent;
  const why = reason || (auto ? "it looked stuck" : "the owner handed it to Opus");
  const { diff, untracked } = partialDiff(rd, j.guardBefore?.head || "");
  const logTail = lastLines(readTail(j.log));
  const prompt = takeoverPrompt({ prompt: j.prompt, from, reason: why, diff, untracked, logTail });
  const logPath = j.log || path.join(store.dir, `job-${id}.log`);
  let child, tmp = j.tmp;
  try {
    if (!tmp || !fs.existsSync(tmp)) tmp = fs.mkdtempSync(path.join(os.tmpdir(), `constance-job-${id}-`));
    // Same rule as a normal launch: jobs since 1.50.2 (doneInTmp) write their
    // done file in the sandbox tmp, since the worktree's .constance/ is read-only.
    const doneDir = j.doneInTmp || !j.worktree ? tmp : rd;
    fs.mkdirSync(path.join(doneDir, ".constance"), { recursive: true });
    fs.appendFileSync(logPath, `\n--- ${new Date().toISOString()} ${from} stopped; handed to Opus (${why}) ---\n`);
    const fd = fs.openSync(logPath, "a");
    try {
      const b = sandboxLaunch(opusCommand(prompt), { agent: OPUS.agent, dir: rd, tmp, env: ENV, keyringAgents: [] });
      const [cmd, ...args] = b.cmd;
      child = spawn(cmd, args, { cwd: rd, env: b.env, detached: true, stdio: ["ignore", fd, fd] });
      child.unref();
    } finally { fs.closeSync(fd); }
  } catch (e) {
    // The worker is already stopped: the job goes on to the sweep as an exit without a done file.
    back({ tmp, summaryNote: `Opus couldn't launch: ${e.message}` });
    store.log({ kind: "note", job: id, agent: j.agent, worker: j.worker, text: `Job ${id} could not go to Opus: ${e.message}. Its worker was stopped, so it goes to review as it is.` });
    throw new Error(`Opus couldn't launch: ${e.message}`);
  }
  const now = Date.now();
  const kept = store.update((s) => {
    const x = s.jobs.find((k) => k.id === id);
    // Stop was pressed during the handover: it stays stopped, and Opus goes too.
    if (!x || x.status !== "waiting" || !x.handingOver) return false;
    x.handedFrom = { agent: x.agent, worker: x.worker || "", account: x.account?.label || "", pid: x.pid, at: now, auto, reason: why, ...(workerTokens !== null ? { tokens: workerTokens } : {}) };
    x.agent = OPUS.agent; x.worker = OPUS.worker; x.account = null;
    x.workerPrompt = x.prompt; x.prompt = prompt;
    x.status = "running"; x.pid = child.pid; x.tmp = tmp; x.log = logPath; x.takenOverAt = now;
    delete x.handingOver; delete x.stuck; delete x.activity;
    return true;
  });
  if (!kept) { killGroup(child.pid); throw new Error(`job ${id} was stopped during the handover.`); }
  store.log({ kind: "takeover", job: id, agent: OPUS.agent, worker: OPUS.worker, files: j.files || [], text: `${from} stopped and Opus took over${auto ? " automatically" : ""} (${why}).` });
  return { id, from };
}

function takeoverCmd() {
  const id = Number(process.argv[3]);
  if (!Number.isInteger(id) || id < 1) fail("Usage: takeover ID");
  sweep();
  try { const r = takeOver(id); out(`Opus took over job ${id} from ${r.from}. Its card shows Opus now; it is reviewed like any other job.`); }
  catch (e) { fail(e.message); }
}

// Same containment rule the guard uses: a changed path is covered by a file
// entry when they match, the entry is "." or names the path's folder.
const normRel = (p) => String(p).replace(/^\.\//, "").replace(/\/+$/, "");
function coversPath(files, p) {
  const b = normRel(p);
  return files.some((f) => { const a = normRel(f); return a === b || a === "." || b === a + "/" || a.startsWith(b + "/"); });
}

// A finished kilo job's own --format json stream is its log: kiloPaidVerdict
// fails it when the run shows a paid model or any cost > 0 (kilo bills per
// token, so this is checked before the guard and self-merge ever see it).
// Returns the verdict, or null when the job isn't kilo or came back clean.
function kiloPaidFail(j) {
  if (j.agent !== "kilo") return null;
  let text = "";
  try { text = fs.readFileSync(j.log, "utf8"); } catch { text = tailFile(j.log, 65536); }
  const v = kiloPaidVerdict(text);
  if (!v) return null;
  store.update((s) => { const x = s.jobs.find((k) => k.id === j.id); if (x && x.status === "finished") { x.status = "failed"; x.reviewNote = v.note; } });
  store.log({ kind: "note", job: j.id, agent: j.agent, worker: j.worker, text: `Job ${j.id} failed: ${v.note}` });
  return v;
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
  const hasWorktree = (k) => !!(k.worktree || k.branch);
  // Workers can't commit (their git data is read-only), so nothing committed
  // since the snapshot is this job's: the guard judges what the run left in the
  // tree, and a copy's worktree is also checked for commits nobody should have
  // made there. Nothing is ever reverted here — the only commit a job gets is
  // the one Constance makes for it afterwards (commitForJob), from its list.
  const res = checkRun({ dir, files: j.files || [], commit: "", before: j.guardBefore, env: ENV, ownTree: hasWorktree(j) });
  store.update((s) => { const x = s.jobs.find((k) => k.id === j.id); if (x) x.guardChecked = true; });
  // Concurrent jobs share the folder: a dirty path another overlapping job may
  // edit is that job's, never this one's violation. A copy is never excused.
  const jStart = j.startedAt || 0, jEnd = j.finishedAt || Date.now();
  const others = hasWorktree(j) ? [] : store.read().jobs.filter((k) => k.id !== j.id && k.startedAt && runDir(k) === dir &&
    !hasWorktree(k) && k.startedAt <= jEnd && jStart <= (k.finishedAt || Infinity));
  const excusedPaths = new Set();
  for (const p of res.badPaths || []) if (others.some((k) => coversPath(k.files || [], p))) excusedPaths.add(p);
  const badPaths = (res.badPaths || []).filter((p) => !excusedPaths.has(p));
  const violations = [...res.violations.filter((v) => !v.startsWith("changed files outside its list"))];
  if (badPaths.length) violations.push(`changed files outside its list: ${badPaths.join(", ")}`);
  if ((res.notices || []).length) store.log({ kind: "guard-notice", job: j.id, agent: j.agent, text: res.notices.join("; ") });
  if (!violations.length) return;
  const did = restoreRun({ dir, badPaths, addedProjects: res.addedProjects || [],
    addedHome: res.addedHome || [], removedHome: res.removedHome || [], removedProjects: res.removedProjects || [] });
  const lesson = `${j.agent} broke a guardrail on job ${j.id}: ${violations.join("; ")}.`;
  addLesson(lesson, store.dir);
  store.update((s) => {
    const x = s.jobs.find((k) => k.id === j.id);
    if (x) { x.guardViolation = violations; x.guardBadPaths = badPaths; }
    const g = (s.guards ||= {})[j.agent] ||= { strikes: 0, violations: [] };
    g.strikes += 1; g.violations.push({ job: j.id, at: Date.now(), what: violations });
  });
  store.log({ kind: "guard", job: j.id, agent: j.agent, text: `${violations.join("; ")}. ${did.join("; ") || "Nothing was reverted."} Lesson logged; ${j.agent} gets smaller tasks now.` });
}

// The controller's commit: workers can't write git data, so Constance commits a
// finished job's work for it, on the host, with the hardened git
// (constance-git.mjs). Only paths that (a) changed during the run (not dirty
// before it) and (b) are inside the job's own file list are staged; anything
// else stays in the tree for the guard's report. A read-only job never gets a
// commit. The commit becomes the job's `commit`. A busy index (another git
// command in the same folder) is retried for a few seconds; a commit that still
// fails is logged and the work stays uncommitted for her review.
function commitForJob(j) {
  try {
    const files = j.files || [];
    if (!files.length || j.commit && j.controllerCommit) return;
    const dir = runDir(j);
    const before = new Set(j.guardBefore?.dirty || []);
    const paths = dirtyPaths(dir).filter((p) => !before.has(p) && coversPath(files, p) && !isProtectedPath(p));
    if (!paths.length) return;
    const first = String(j.summary || j.task || "").split("\n")[0].trim().slice(0, 72) || "work";
    const msg = `${j.worker || j.agent} (job ${j.id}): ${first}\n\nCommitted by Constance for ${j.agent}; files: ${paths.join(", ")}`;
    let r = null;
    for (let i = 0; i < 40; i++) {
      r = safeGit(dir, ["add", "-A", "--", ...paths]);
      if (r.status === 0) r = safeGit(dir, ["commit", "-q", "--no-verify", "-m", msg, "--", ...paths]);
      if (r.status === 0 || !/index\.lock|unable to (create|lock)/i.test(`${r.stderr}${r.stdout}`)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    if (r.status !== 0) {
      store.log({ kind: "note", job: j.id, agent: j.agent, worker: j.worker, text: `Couldn't commit job ${j.id}'s work (${(r.stderr || r.stdout || "").trim().slice(-200)}); it is left uncommitted in ${dir}.` });
      return;
    }
    const head = safeGit(dir, ["rev-parse", "HEAD"]).stdout.trim();
    store.update((s) => { const x = s.jobs.find((k) => k.id === j.id); if (x) { x.commit = head; x.controllerCommit = true; x.committedFiles = paths; } });
    j.commit = head; j.controllerCommit = true;
  } catch (e) {
    store.log({ kind: "note", job: j.id, agent: j.agent, text: `Couldn't commit job ${j.id}'s work: ${e.message}` });
  }
}

// Paths only Constance may write: a job may never list them, and her commit
// never stages them.
function isProtectedPath(p) {
  const n = normRel(p);
  return n === ".git" || n.startsWith(".git/") || n === ".constance" || n.startsWith(".constance/");
}

function changedFiles(dir, commit) {
  if (!/^[0-9a-f]{7,40}$/i.test(commit || "")) return [];
  const r = safeGit(dir, ["show", "--name-only", "--format=", commit]);
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

function excludeDoneFiles(dir) {
  const r = safeGit(dir, ["rev-parse", "--git-path", "info/exclude"]);
  if (r.status !== 0) return;
  const f = path.resolve(dir, r.stdout.trim());
  let txt = ""; try { txt = fs.readFileSync(f, "utf8"); } catch {}
  if (!txt.split("\n").includes(".constance/")) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, (txt && !txt.endsWith("\n") ? "\n" : "") + ".constance/\n"); }
}

// ---------------------------------------------------------------- self-merge and slot filling
// A finished copy whose guard is clean, whose branch only touches its allowed
// files and whose project has a real test command merges itself at once
// (constance-selfmerge.mjs runs that suite sandboxed first, then merges,
// with one rebase-and-retry on conflict). The merge lands in reviews.json for
// Constance's background review — accept confirms it, send-back reverts it.
// A flagged conflict is marked "conflict" and keeps its worktree, exactly like
// a review-time one; anything else stays "finished" for the normal review.
// constanceSelfMerge: false turns it all off. Best-effort only: a failure is
// logged and the sweep moves on, never blocked — the merge itself runs in a
// detached `selfmerge` process so the suite never stalls a status call.
const reviewsFile = () => path.join(store.dir, "reviews.json");
const selfMergeOn = () => readSettings().constanceSelfMerge !== false;

// The agent's own word ("tests pass" in its report) is never a merge signal:
// a self-merge needs the project's real test commands (testCommands in
// constance-selfmerge.mjs), run sandboxed. A project without one never
// self-merges; its copies wait for her normal review.
// Every file the copy's branch changed against the repo's current branch must
// sit inside the job's allowed list (never .git/ or .constance/). Unreadable
// git means no.
function branchDiffOk(j) {
  const base = safeGit(j.dir, ["merge-base", "HEAD", j.branch]);
  if (base.status !== 0) return false;
  const d = safeGit(j.dir, ["diff", "--name-only", `${base.stdout.trim()}..${j.branch}`]);
  if (d.status !== 0) return false;
  const allowed = j.files || [];
  const changed = d.stdout.split("\n").filter(Boolean);
  return changed.length > 0 && changed.every((p) => coversPath(allowed, p) && !isProtectedPath(p));
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
    if (!testCommands(fresh.dir).length) {
      store.log({ kind: "note", job: j.id, agent: j.agent, text: `No self-merge for job ${j.id}: ${fresh.dir} has no test command (.constance/rules.md "test: ..." or package.json scripts.test), so it waits for review.` });
      return;
    }
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
    if (!branchDiffOk(j)) return;
    const commands = testCommands(j.dir);
    const checks = { guard: true, diff: true };
    // Tests can slow the suite down with CONSTANCE_SELFMERGE_SUITE_DELAY_MS;
    // nothing sets it outside them.
    const delay = Number(process.env.CONSTANCE_SELFMERGE_SUITE_DELAY_MS) || 0;
    const run = (dir) => runSuite(dir, { commands, env: ENV });
    const suite = delay ? (dir) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay); return run(dir); } : run;
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
    // `failed: true` is the dirty-worktree verdict; a failed suite carries the
    // list of failed commands in `failed` too, and goes to the normal review.
    if (m.failed === true) {
      // A copy whose worktree isn't clean can't be rebased or tested as it
      // merges: it failed. "failed" frees its copy slot and its files; the
      // worktree and branch stay for the owner to look at.
      store.update((s) => { const x = s.jobs.find((k) => k.id === id); if (x) { x.status = "failed"; x.failedAt = Date.now(); x.mergeError = m.reason || ""; delete x.selfMerging; delete x.selfMergePid; } });
      store.log({ kind: "merge", job: j.id, agent: j.agent, worker: j.worker, text: `self-merge failed on ${j.branch}: ${(m.reason || "").slice(-300)}. The copy's slot is free again; its worktree is kept.` });
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

// A copy that failed on its own — failing tests, a guard violation or a crash
// (shouldAutoRetry decides, retrySpec builds the redo) — is retried once on a
// fresh copy of the same agent before Constance's review ever sees the
// failure: the original is marked sent back (the run failed; she didn't
// reject it), its worktree and branch dropped unmerged, and the redo goes out
// linked with --again and flagged autoRetry so it is never retried itself. A
// refusal (the agent is busy, the second-try rule, a file conflict) puts the
// job back to finished for the normal review.
function autoRetry(j) {
  try {
    if (!j.copy || j.autoRetry || j.handedFrom) return;
    const fresh = store.read().jobs.find((k) => k.id === j.id);
    if (!fresh || fresh.status !== "finished" || fresh.autoRetried || !shouldAutoRetry(fresh, store.read().jobs)) return;
    const spec = retrySpec(fresh, { errorOutput: fresh.log ? tailFile(fresh.log) : "" });
    store.update((s) => { const x = s.jobs.find((k) => k.id === j.id); if (x) { x.status = "sent back"; x.reviewNote = "auto-retry: the run failed on its own"; x.reviewedAt = Date.now(); x.autoRetried = true; } });
    let r;
    try { r = handOut({ agent: spec.agent, task: spec.task, files: spec.files, againOf: spec.again }); }
    catch (e) {
      store.update((s) => { const x = s.jobs.find((k) => k.id === j.id); if (x) { x.status = "finished"; delete x.autoRetried; delete x.reviewNote; delete x.reviewedAt; } });
      store.log({ kind: "note", job: j.id, agent: j.agent, text: `auto-retry for job ${j.id} refused, it goes to review instead: ${e.message}` });
      return;
    }
    store.update((s) => {
      const x = s.jobs.find((k) => k.id === r.job.id); if (x) x.autoRetry = true;
      const y = s.jobs.find((k) => k.id === j.id); if (y) y.retryJob = r.job.id;
    });
    try { cleanupRejected(fresh); } catch {}
    store.log({ kind: "retry", job: j.id, agent: j.agent, worker: j.worker, text: `failed on its own; retried as job ${r.job.id}${r.held ? " (held until the machine has room)" : ""}.` });
  } catch (e) {
    store.log({ kind: "note", job: j.id, agent: j.agent, text: `auto-retry skipped for job ${j.id}: ${e.message}` });
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
    expireStale(dir, g.id);
    const busyFiles = s.jobs.filter((j) => ["held", "waiting", "running"].includes(j.status)).flatMap((j) => j.files || []);
    let slots = 0;
    for (const agent of Object.keys(PUBLISHED_MAX)) slots += Math.max(0, limitOf(agent) - copySlots(s, agent, dir).length);
    if (!slots) return;
    let handed = 0;
    for (const t of readyTasks(dir, { busyFiles, limit: slots, goal: g.id }, store.dir)) {
      if (!t.agent) continue;
      try {
        const r = handOut({ agent: t.agent, task: t.task, files: t.files || [], items: parseItemArg(t.items || []), title: t.title || "" });
        handed++;
        finishTask(dir, t.id, r.job.id, store.dir);
        markRefillTaken(dir, t.id, r.job.id);
        store.log({ kind: "note", text: `Ready queue: "${t.task.slice(0, 80)}" went to ${t.agent} automatically as job ${r.job.id} (a copy slot was free).` });
      } catch (e) {
        if (!fillMissed.has(t.id)) { fillMissed.add(t.id); store.log({ kind: "note", text: `Ready queue: "${t.task.slice(0, 80)}" stays queued — ${e.message}` }); }
      }
    }
    refillQueue(dir, { freeSlots: slots - handed, busyFiles, goal: g.id });
  } catch {}
}

// ---------------------------------------------------------------- backlog refill
// When the ready queue runs dry while copy slots sit free, refill() pulls open
// backlog items (test/docs/task/bug kinds only) into it so autoNext always has
// work for a freed agent. Queue tasks carry no extra fields, so each refill
// remembers its backlog item in refills.json; the take is marked with the job
// id when the task is actually handed out (markRefillTaken, called wherever a
// queued task starts).
const refillsFile = () => path.join(store.dir, "refills.json");
const REFILL_LOW = 3;
function readRefills() { try { return JSON.parse(fs.readFileSync(refillsFile(), "utf8")) || {}; } catch { return {}; } }
function writeRefills(d) { try { writeAtomic(refillsFile(), JSON.stringify(d, null, 2) + "\n"); } catch {} }
function rememberRefill(dir, taskId, backlogId) {
  const d = readRefills(); (d[dir] ||= {})[taskId] = backlogId; writeRefills(d);
}
// The refills still waiting in this goal's queue. An entry whose task is no
// longer pending for the goal (it expired with an older goal) is dropped, so
// its backlog item can be refilled again instead of counting as queued forever.
function liveRefills(dir, goal) {
  const d = readRefills(), m = d[dir];
  if (!m) return {};
  const live = new Set(pendingTasks(dir, store.dir, goal).map((t) => String(t.id)));
  let changed = false;
  for (const k of Object.keys(m)) if (!live.has(String(k))) { delete m[k]; changed = true; }
  if (changed) { if (!Object.keys(m).length) delete d[dir]; writeRefills(d); }
  return m;
}
// Pending tasks an older goal left in this project's queue are retired, once,
// with a log line: they never go to the running goal.
function expireStale(dir, goal) {
  try {
    const gone = expireTasks(dir, goal, store.dir);
    if (gone.length) store.log({ kind: "note", text: `Ready queue: ${gone.length} task${gone.length === 1 ? "" : "s"} left from an earlier goal expired (${gone.map((t) => `"${t.task.slice(0, 40)}"`).join(", ")}); they are not handed to this goal.` });
  } catch {}
}
function markRefillTaken(dir, taskId, jobId) {
  const d = readRefills(), m = d[dir];
  if (!m || !(taskId in m)) return;
  const backlogId = m[taskId];
  delete m[taskId]; if (!Object.keys(m).length) delete d[dir];
  writeRefills(d);
  try { if (markTaken(dir, backlogId, jobId)) store.log({ kind: "note", text: `Backlog #${backlogId} is job ${jobId}'s now.` }); } catch {}
}
// Queue length below REFILL_LOW with freeSlots to spare: add refill tasks,
// skipping backlog items already queued (they aren't marked taken until they
// start, so the map is what keeps a later sweep from queueing them twice).
function refillQueue(dir, { freeSlots, busyFiles, goal }) {
  try {
    const queueLen = queueView(dir, store.dir, goal).length;
    if (queueLen >= REFILL_LOW || freeSlots <= 0) return;
    const queued = new Set(Object.values(liveRefills(dir, goal)));
    const r = refill(dir, { queueLen, freeSlots, backlog: openBacklog(dir).filter((it) => !queued.has(it.id)), busyFiles });
    for (const t of r.tasks) {
      const item = addTask(dir, { task: t.task, files: t.files || [], goal }, store.dir);
      rememberRefill(dir, item.id, t.backlogId);
    }
    if (r.tasks.length) store.log({ kind: "note", text: `Ready queue refilled from the backlog: ${r.tasks.length} task${r.tasks.length === 1 ? "" : "s"} queued.` });
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
  const banned = files.filter(isProtectedPath);
  if (banned.length) throw new Error(`Only Constance writes ${banned.join(", ")}: no worker may be given .git/ or .constance/ files.`);
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
    const j = { id, goal: g.id, agent, account, repo: dir, dir, files, task, status: practice ? "finished" : room.ok ? "waiting" : "held", createdAt: Date.now(), doneInTmp: true };
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
    const promptExtra = extra;
    const built = asCopy
      ? handoffPrompt({ id, dir, task, files, account, worktree: wt, branch: br, mainDir: dir }, promptExtra)
      : handoffPrompt(j, promptExtra);
    const body = built.split(doneFile(asCopy ? wt : dir, id)).join(doneFile("/tmp", id));
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
  // No project folder, no launch: checked before a worktree or anything else.
  const noDir = projectDirProblem(dir, ENV);
  if (noDir) {
    store.update((s) => { const j = s.jobs.find((x) => x.id === job.id); if (j) { j.status = "stopped"; j.summary = `(not launched: ${noDir})`; } });
    store.log({ kind: "note", job: job.id, agent, worker: job.worker, text: `Job ${job.id} not launched: ${noDir}` });
    throw new Error(`refusing to launch a worker: ${noDir}`);
  }
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
    const doneDir = job.doneInTmp || !job.worktree ? tmp : rd;
    fs.mkdirSync(path.join(doneDir, ".constance"), { recursive: true });
    try { fs.rmSync(doneFile(doneDir, job.id)); } catch {}
    // A project-folder job sees the project's .constance/ (her handoff.md,
    // backlog and rules) read-only: only the controller writes there. A copy's
    // .constance/ is its own worktree's, where its done file goes.
    const readOnly = [];
    if (!job.worktree) {
      const cdir = path.join(rd, ".constance");
      if (!fs.existsSync(cdir) && !insidePlugins(rd, ENV)) { try { fs.mkdirSync(cdir, { recursive: true }); excludeDoneFiles(rd); } catch {} }
      readOnly.push(cdir);
    }
    box = sandboxLaunch(launchCommand(agent, job.prompt), { agent, dir: rd, tmp, env: { ...ENV, ...acctEnv }, extraRw: Object.values(acctEnv), keyringAgents: keyringAgents(), readOnly });
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
  let verdicts = null;
  const started = [];
  for (const agent of agents) {
    // Memory is read fresh before every start (finding 17).
    const machine = readMachine();
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
  const g = store.read().goal;
  if (!g || g.status !== "running" || g.dir !== j.dir) return "";
  expireStale(j.dir, g.id);
  const item = peekNext(j.dir, store.dir, g.id);
  if (!item) return "";
  const agent = item.agent || j.agent;
  try {
    const r = handOut({ agent, task: item.task, files: item.files || [], preferCopy: agent === j.agent ? j.copy || 0 : 0, items: parseItemArg(item.items || []), title: item.title || "" });
    finishTask(j.dir, item.id, r.job.id, store.dir);
    markRefillTaken(j.dir, item.id, r.job.id);
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
    const item = addTask(g.dir, { task, files, agent: arg("--agent"), items: parseItemArg(arg("--item")), title: arg("--title"), goal: g.id }, store.dir);
    store.log({ kind: "note", text: `Ready queue: "${task.slice(0, 80)}" queued (${files.length ? files.join(", ") : "read-only"}${item.agent ? ", for " + item.agent : ", any agent"}).` });
    out(`Queued as task ${item.id}. It goes to ${item.agent || "the finishing agent"} automatically when the current job is accepted.`);
    return;
  }
  const q = queueView(g.dir, store.dir, g.id);
  if (!q.length) { out("The ready queue is empty."); return; }
  out(q.map((t) => `${t.id}. ${t.task}${t.files.length ? `  [${t.files.join(", ")}]` : "  [read-only]"}${t.agent ? `  → ${t.agent}` : ""}`).join("\n"));
}

// What `wait` reports as still working: running jobs plus finished ones whose
// self-merge is still running in the background.
const busyJobs = (s) => s.jobs.filter((j) => j.status === "running" || inHand(j))
  .map((j) => ({ id: j.id, agent: j.agent, worker: j.worker || null, ...(j.selfMerging ? { selfMerging: true } : {}) }));

// What she needs to review one finished job: its report, changed files, guard
// result, earlier jobs in this goal that touched the same files, and its log's
// tail. `wait` returns it; a review step gets one per job in its prompt.
function reviewPacket(next, s) {
  const files = changedFiles(next.dir, next.commit);
  // Earlier finished, merged or accepted jobs in this goal that changed the same files: check against them first.
  const earlier = s.jobs.filter((j) => j.id !== next.id && j.goal === next.goal && ["finished", "merged", "accepted"].includes(j.status) && (j.finishedAt || 0) <= (next.finishedAt || 0))
    .map((j) => ({ id: j.id, agent: j.agent, commit: j.commit, shared: overlaps(changedFiles(j.dir, j.commit), files) })).filter((x) => x.shared.length);
  let tail = ""; try { tail = fs.readFileSync(next.log, "utf8").slice(-2500); } catch {}
  return { id: next.id, agent: next.agent, worker: next.worker || null, dir: runDir(next), files: next.files, task: next.task, summary: reviewText(next.agent, next.summary), commit: next.commit, changedFiles: files,
    ...(next.status === "merged" ? { selfMerged: true } : {}),
    guardViolation: next.guardViolation || null,
    checkAgainst: earlier, logTail: reviewText(next.agent, tail) };
}

// The driver's view of a goal's open work, for nextStep(): jobs ready for her
// review (finished or self-merged, not still being checked), and jobs still in
// flight (running, held, waiting, or finished but settling/self-merging).
function stepView(s) {
  const g = s.goal;
  const mine = s.jobs.filter((j) => !j.goal || j.goal === g?.id);
  const reviewable = [...reviewQueue(mine).filter((j) => !inHand(j)), ...mine.filter((j) => j.status === "merged" && !inHand(j))];
  const inFlight = mine.filter((j) => ["running", "held", "waiting"].includes(j.status) || (["finished", "merged"].includes(j.status) && inHand(j)));
  const items = checklist(g, asAccepted(s.jobs)).items;
  return { reviewable, inFlight, items, openItems: items.filter((i) => i.state !== "done"), mark: progressMark({ jobs: mine, items }) };
}

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
      return out({ review: { ...reviewPacket(next, s), queue: queueView(next.dir, store.dir, s.goal?.id || "") }, stillRunning: busyJobs(s), signals: recentSignals(store.dir, 6),
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
    // A real conflict marks the job "conflict"; anything else (the checkout has
    // uncommitted work, git failed) leaves it finished so it can be accepted
    // again once the checkout is clean.
    if (!m.conflict) { store.log({ kind: "merge", job: j.id, agent: j.agent, worker: j.worker, text: `merge of ${j.branch} not done: ${(m.output || "").slice(-300)}` }); return m; }
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
  // Accepting a copy merges its branch: take the merge lock FIRST, and mark the
  // job accepted only once the merge has landed. A busy lock (a self-merge
  // running its suite) is retried; if it stays busy the job is left exactly as
  // it was — still finished — and she is told to try again.
  if (verdict === "accept" && found.worktree) {
    let m;
    try { m = acceptMerge(id); }
    catch (e) { fail(`Job ${id} is still finished: ${e.message}. Nothing changed; run the review again in a minute.`); }
    if (m.gone) fail(`Job ${id} is ${m.gone}; only a finished job can be reviewed.`);
    if (!m.ok) {
      const j = store.read().jobs.find((x) => x.id === id);
      if (m.conflict) score(j, verdict);
      out(m.conflict
        ? `Job ${id}: merging ${found.branch} conflicted: ${(m.output || "").trim().slice(-300)}. Nothing was forced; the worktree and branch were left in place.`
        : `Job ${id} is still finished; ${found.branch} was not merged: ${(m.output || "").trim().slice(-300)}. Nothing was forced or reset; review it again once that is sorted.`);
      return;
    }
    store.log({ kind: "review", job: id, agent: found.agent, worker: found.worker, verdict, text: note });
    const j = store.update((s) => { const x = s.jobs.find((y) => y.id === id); if (x) { x.status = "accepted"; x.reviewNote = note; x.reviewedAt = Date.now(); } return x; });
    score(j, verdict);
    out(`Job ${id} ${j.status}.${autoNext(j)}`);
    return;
  }
  const j = store.update((s) => { const j = s.jobs.find((x) => x.id === id); if (j) { j.status = verdict === "accept" ? "accepted" : "sent back"; j.reviewNote = note; j.reviewedAt = Date.now(); } return j; });
  store.log({ kind: "review", job: id, agent: j.agent, worker: j.worker, verdict, text: note });
  const cleaned = verdict === "send-back" && j.worktree ? ` ${cleanupRejected(j)}` : "";
  score(j, verdict);
  const extra = verdict === "accept" ? autoNext(j) : `${cleaned}${(() => { const a = sendBackAdvice(store.read().jobs, j); return a ? ` ${a}` : ""; })()}`;
  out(`Job ${id} ${j.status}.${extra}`);
}

// The merge half of accepting a copy, under the merge lock. Each attempt waits
// up to 10 s for the lock; attempts repeat until CONSTANCE_ACCEPT_WAIT_MS
// (default 100 s, inside a tool call's time limit) has passed, then it throws
// and nothing has changed. Inside the lock the job is re-read: a review or a
// self-merge that got there first wins ({ gone: status }).
function acceptMerge(id) {
  const until = Date.now() + (Number(process.env.CONSTANCE_ACCEPT_WAIT_MS) || 100e3);
  for (;;) {
    try {
      return withMergeLock(() => {
        const cur = store.read().jobs.find((x) => x.id === id);
        if (!cur || cur.status !== "finished" || cur.selfMerging) return { ok: false, gone: cur ? (cur.selfMerging ? "self-merging" : cur.status) : "gone" };
        return mergeAccepted(cur);
      }, { waitMs: 10e3, pollMs: 200 });
    } catch (e) {
      if (!/another merge is still running/.test(e.message) || Date.now() > until) throw new Error(/another merge/.test(e.message) ? "another merge held the merge lock the whole time" : e.message);
    }
  }
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
  const rv = withMergeLock(() => revertMerge(j.dir, target), { waitMs: 90e3, pollMs: 200 });
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

// The diff a self-merged job brought into the repo: its merge commit against
// the branch it landed on (the first parent), for the batch review prompt.
function mergedDiff(j) {
  const c = j.mergeCommit || j.commit;
  if (!c || !/^[0-9a-f]{7,40}$/i.test(String(c))) return "";
  const d = safeGit(j.dir, ["diff", `${c}^`, c]);
  return d.status === 0 ? d.stdout : "";
}

// `batchreview`: her background review of self-merged jobs, up to five at a
// time (constance-batchreview.mjs). Bare prints the batch prompt — every
// pending job's id, task and diff plus the one-line reply contract. With
// --apply FILE it parses the verdict reply ("ID ok" / "ID fail: reason"; a
// missing or garbled verdict counts as a fail) and applies it: ok confirms the
// merge, fail reverts it through the same revertMerge path `review` uses.
function batchReviewCmd() {
  const batch = batches(store.read().jobs)[0] || [];
  if (!batch.length) { out("No merged jobs are waiting for review."); return; }
  const apply = arg("--apply");
  if (!apply) {
    process.stdout.write(`Batch review: ${batch.length} merged job${batch.length === 1 ? "" : "s"} waiting for review (${batch.map((j) => j.id).join(", ")}). Reply with one line per job — "<id> ok" or "<id> fail: <reason>" — and run: C batchreview --apply FILE\n\n`);
    out(batchPrompt(batch, { diffOf: mergedDiff }));
    return;
  }
  let text;
  try { text = fs.readFileSync(apply, "utf8"); } catch (e) { fail(`Can't read ${apply}: ${e.message}`); }
  const ids = batch.map((j) => j.id);
  const verdicts = parseVerdicts(text, ids);
  const reasons = Object.fromEntries(ids.map((id) => [id, String(verdicts[String(id)]?.reason || "")]));
  const extras = [];
  const summary = applyVerdicts(verdicts, {
    jobs: batch,
    revert: (job) => withMergeLock(() => revertMerge(job.dir, job.mergeCommit || job.commit)),
    markReviewed: (job, verdict) => {
      const j = store.read().jobs.find((k) => k.id === job.id) || job;
      const ok = verdict === "ok";
      const note = reasons[j.id] || (ok ? "confirmed" : "no verdict");
      store.log({ kind: "review", job: j.id, agent: j.agent, worker: j.worker, verdict: ok ? "accept" : "send-back", text: `batch review: ${note}` });
      markReviewed(reviewsFile(), j.id, verdict);
      if (ok) {
        store.update((s) => { const x = s.jobs.find((k) => k.id === j.id); if (x) { x.status = "accepted"; x.reviewNote = note; x.reviewedAt = Date.now(); } });
        score(j, "accept");
        const nx = autoNext(j); if (nx.trim()) extras.push(nx.trim());
      } else {
        store.update((s) => { const x = s.jobs.find((k) => k.id === j.id); if (x) { x.status = "sent back"; x.revertedAt = Date.now(); x.reviewNote = note; x.reviewedAt = Date.now(); } });
        store.log({ kind: "revert", job: j.id, agent: j.agent, worker: j.worker, text: `reverted the self-merge of ${j.branch || "the branch"} (batch review): ${note}` });
        score(j, "send-back");
      }
    },
  });
  const failed = summary.revertFailed.length ? ` ${summary.revertFailed.length} revert${summary.revertFailed.length === 1 ? "" : "s"} failed — still merged and pending: ${summary.revertFailed.join(", ")}.` : "";
  out(`Batch review applied: ${summary.ok} confirmed, ${summary.reverted} reverted.${failed}${extras.length ? " " + extras.join(" ") : ""}`);
}

// `split`: autosplit a goal's text into ready-to-delegate jobs (one per
// checklist item, disjoint file lists, deeper-test padding) printed as JSON —
// for planning a big goal. Defaults to the running goal's text and folder;
// --goal/--dir override.
function splitCmd() {
  const g = store.read().goal;
  const text = arg("--goal") || g?.text;
  const dir = arg("--dir") ? path.resolve(arg("--dir")) : g?.dir;
  if (!text) fail("No goal is running: pass --goal TEXT (and --dir PROJECT).");
  let files = [];
  if (dir) {
    const r = safeGit(dir, ["ls-files"]);
    if (r.status === 0) files = r.stdout.split("\n").filter(Boolean);
  }
  try { out(autosplit(text, { files, scorecard: scoreRows(readScorecard(store.dir)), agent: arg("--agent") || null, min: Number(arg("--min")) || 15 })); }
  catch (e) { fail(e.message); }
}

// `spec KIND --what ... --files a,b --accept ... [--notes ...]`: fill a job-spec
// template (constance-specs.mjs) and print it — a precise task text for
// `delegate --task`.
function specCmd() {
  const kind = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : "";
  try {
    out(fillSpec(kind, { what: arg("--what"), files: arg("--files").split(",").map((x) => x.trim()).filter(Boolean), accept: arg("--accept"), notes: arg("--notes") }));
  } catch (e) { fail(e.message); }
}

// ---------------------------------------------------------------- the handoff file
// <project>/.constance/handoff.md is rendered from the goal (its `handoff`
// memory in jobs.json) and the job list, and only ever written here. A file that
// changed since the last write was edited by someone else: it is rewritten from
// her records and the owner is told once per goal.
const agentName = () => {
  const names = Object.fromEntries((readData().agents || []).filter((a) => a.name).map((a) => [a.id, a.name]));
  return (id) => names[id] || (id ? id[0].toUpperCase() + id.slice(1) : id);
};
function renderHandoffNow() {
  const s = store.read(), g = s.goal;
  if (!g || !g.dir) return null;
  const { file, inProject } = handoffFile(g.dir, store.dir, ENV);
  const mem = memoryOf(g);
  const live = openStep(mem) && alive(g.brainPid, brainCli(g.brainId)) ? openStep(mem).n : 0;
  const text = renderHandoff({ goal: g, jobs: s.jobs, items: checklist(g, asAccepted(s.jobs)).items, name: agentName(), practice: practiceMode(), liveStep: live });
  let prev = ""; try { prev = fs.readFileSync(file, "utf8"); } catch {}
  if (prev === text) return { file, text, inProject };
  if (inProject) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); excludeDoneFiles(g.dir); } catch {} }
  const w = writeHandoff(file, text, mem.sha);
  store.update((x) => { if (x.goal && x.goal.id === g.id) { x.goal.handoff = { ...memoryOf(x.goal), sha: w.sha }; if (w.tampered) x.goal.handoffTampered = (x.goal.handoffTampered || 0) + 1; } });
  if (w.tampered && !g.handoffTampered) store.log({ kind: "note", text: `${file} was changed outside the controller; it was rewritten from her records (nothing in it is lost).` });
  return { file, text, inProject };
}
// Change the goal's handoff memory under the store's lock, then re-render the file.
function withMemory(fn) {
  const r = store.update((s) => {
    if (!s.goal || !["running", "paused"].includes(s.goal.status)) return { none: true };
    const mem = memoryOf(s.goal);
    const out = fn(mem);
    s.goal.handoff = mem;
    return { out };
  });
  if (r.none) fail("No goal is running, so there is no handoff to change.");
  try { renderHandoffNow(); } catch {}
  return r.out;
}
function handoffCmd() {
  const sub = process.argv[3] || "";
  const text = () => process.argv.slice(4).join(" ").trim();
  try {
    if (sub === "decide") { withMemory((m) => addDecision(m, text())); return out("decision recorded"); }
    if (sub === "problem") { const n = withMemory((m) => addProblem(m, text())); return out(`problem P${n} recorded`); }
    if (sub === "solved") { const n = Number(String(process.argv[4] || "").replace(/^P/i, "")); withMemory((m) => solveProblem(m, n, arg("--note"))); return out(`problem P${n} solved`); }
    if (sub === "next") { withMemory((m) => addNext(m, text())); return out("note for the next session recorded"); }
  } catch (e) { fail(e.message); }
  if (sub === "--all") return out(memoryOf(store.read().goal));
  if (sub) fail("Usage: handoff [decide TEXT|problem TEXT|solved N [--note TEXT]|next TEXT|--all]");
  const r = renderHandoffNow();
  if (!r) fail("No goal, so there is no handoff file.");
  process.stdout.write(`${r.file}\n\n${r.text}`);
}

// ---------------------------------------------------------------- the goal and the driver
const ROLE = (dir) => `You are Constance, the quarterback of the owner's coding agents. You run on the owner's one paid plan (Claude). You plan, delegate, review and still play yourself when the work is hard or risky. You have full authority: never stop to ask permission.

Your toolbox is \`node ${SELF} <command>\` (call it C below). Work only in ${dir}.
- \`C pace\`: your own session/weekly pacing. Obey its mode. "normal": keep hard, risky or architectural work, delegate routine well-defined low-risk pieces. "delegate": you are burning your limits too fast, so delegate editing and testing too and keep only planning and review. You never run out of your own limits; the driver pauses you at 90% and resumes after the reset.
- \`C agents\`: who is available right now (under their limits, signed in, readable, free), best scorecard first, each with its record (jobs, accepted, sent back, average tokens and time) and how big a job suits it. Re-check right before every handoff; availability changes as limits reset. No agent is the default: spread work over whoever has spare capacity, and size each task to its agent's record. Never use an agent that isn't listed as available, and never anything that costs money.
- The goal's checklist: \`C status\` shows the goal split into numbered items (board.checklist), which the owner watches tick. Tag every handoff with the item it is for, \`--item N\` (or \`--item 1,3\`), and give it \`--title "fixing the guard"\`: a few plain words, starting with a verb in -ing form, shown to the owner as "Devin 2 is fixing the guard". An item ticks when one of its jobs is merged and none is still open. When you finish an item yourself, \`C check N --note "..."\`.
- \`C needs-owner "one plain sentence"\` is only for what truly needs the owner: a decision only they can make, a merge conflict, or a failure that two tries could not fix — never an ordinary failure you can retry or delegate again. Run it before your report; the owner's next queued goal then waits for them instead of starting.
- \`C delegate --agent ID --files a,b --item N --title "..." --task "..."\`: hand off one small, clear task — the smaller and more self-contained, the better; give weaker agents smaller pieces. List every file it may edit; two editing jobs may never share files, and you must not edit a running job's files yourself. For read-only work (investigating a cause, summarizing a file) omit \`--files\`. The tool adds the folder check, git rules, tests/build and done file to the prompt, so the task text itself only needs to say what to do.
- Devin may run as several copies at once (up to ${limitOf("devin")}): each editing job gets its own worktree and branch, shows up as Devin 1..${limitOf("devin")}, and merges into the project only after you accept it. Give copies tasks whose files never overlap; if a merge ever conflicts the job is marked and left for the owner — report it, don't force it. Copies ramp up as the machine allows: a delegate may come back "held" — its files are reserved and it starts by itself when the load and free memory allow, so never delegate it again; just keep going.
- Second-try rule: when a job comes back wrong, a redo goes out with \`--again ID\` (the job it redoes). Work sent back twice is never resent as it was: split it into smaller jobs with fewer files each, or do it yourself. \`delegate\` refuses a third try with the same files.
- Use it or lose it: \`C spare\` shows which agents have room they would lose at a reset that is close, and which items of this project's backlog (\`C backlog\`; \`C backlog add --kind review|bug|design|task|test|docs --text "..."\`) could use it. Spend leftover room only on backlog items, never on made-up work just to burn it. Your own leftover Opus goes to reviews, tangled bugs and design. When you hand a backlog item out, \`C backlog take N --job ID\`; when it is finished, \`C backlog done N\`.
- When a bug's cause is unknown, the first handoff changes nothing: tell the agent to find the cause, report it in a few lines and stop. Send the fix as a second handoff once you know the cause.
- When a large file needs reading, hand that to a free agent to summarize instead of reading it all yourself.
- Some work stays with you, never delegated: live database changes, bugs tangled across many parts of the code, and anything involving secrets or credentials.
- Reviews come to you as review steps: the controller waits for the jobs (never run \`C wait\` yourself) and starts a fresh session with a batch of finished jobs, each with its report, changed files, guard result and log tail. The agent runs the tests and build itself and reports in plain text what changed, the results and the files. Check the report against the goal; read the full diff yourself only when the change is risky or the report doesn't add up. Compare with any earlier job it lists under checkAgainst. Fix small problems yourself or send it back with a new delegate. Then \`C review ID accept|send-back --note "..."\`.
- The handoff file (.constance/handoff.md, given to you in full at the start of every step) is your whole memory between sessions: goal, checklist, job board, decisions, open problems and notes for the next session. Only the controller writes it; never edit it yourself. Record with \`C handoff decide "..."\` (a decision and its reason), \`C handoff problem "..."\` (something unresolved; \`C handoff solved N --note "..."\` once fixed) and \`C handoff next "..."\` (what the next session must know). One line each; the next session knows nothing else.
- \`C status\` shows \`practice: true\` during a dry run (the panel's Practice switch, on by default for now): plan and delegate exactly as usual — the tool logs each handoff's agent, reason and full prompt instead of launching it — but don't edit files yourself, and say in your report that it was a practice run.
- \`C note "..."\`: a short line in the owner's log for anything he should know.
- \`C queue --task "..." [--files a,b] [--agent ID]\`: while planning, keep a short queue of ready tasks for this project so free agents never sit idle. When you accept a job, the next queued task is handed to the same agent automatically. \`C queue\` lists what is pending, \`C queue rm ID\` drops one.
- \`C signals\`: recent "agent finished" notifications heard from the desktop. One matched to your job means check it; one for an agent with no job is the owner's own run — noted, never touched.
- \`C lesson "..."\`: add one short lesson to your lessons file — something you learned the hard way this goal (a skipped check, a surprise an agent caused, a rule that saved time). It is advice for your future goals, never a rule that overrides the ones above. Read your lessons before each goal; they are already in your first message.
- You work in steps, each a fresh session: a planning step (delegate everything that can start now, queue the rest) or a review batch (review the jobs it lists, delegate follow-ups). Do the step, record what the next session needs with \`C handoff\`, and end your turn; the controller waits for the jobs and starts the next step. Never write the final report while checklist items are still todo or jobs are open.
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
  // Goal records only: the end-of-goal ratio report shares the file, marked by `kind`.
  try { return fs.readFileSync(historyFile(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r && typeof r === "object" && !r.kind); } catch { return []; }
}
// Keep the goal that just ended in history.jsonl (once per goal), with its tokens kept first.
function recordHistory(fresh = true) {
  let records = [];
  try { records = keepTokens(fresh); } catch {}
  const s = store.read();
  if (!s.goal || ["running", "paused"].includes(s.goal.status)) return null;
  if (readHistory().some((r) => r.id === s.goal.id)) return null;
  const rec = goalRecord(s.goal, asAccepted(s.jobs), matchJobs(s.jobs, records));
  rec.failReason = s.goal.failReason || "";
  rec.endNotes = s.goal.endNotes || [];
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
  // Only `stop` reasons halt the queue; `notes` (a failed goal, unreviewed or
  // merged jobs, open checklist items) are kept on the goal and logged, then
  // the queue goes on. queueStops() sees the jobs as they are — merged jobs
  // included — and counts them as accepted for the checklist itself.
  const { stop, notes } = queueStops(g, s.jobs, { practice: practiceMode() });
  if (stop.length || notes.length) {
    const text = stop.join("; ");
    store.update((x) => {
      if (x.goal && x.goal.id === g.id) {
        if (notes.length) x.goal.endNotes = notes;
        if (stop.length) x.goal.needsOwner = text.charAt(0).toUpperCase() + text.slice(1) + ".";
      }
    });
  }
  if (notes.length) store.log({ kind: "note", text: `Goal ended with: ${notes.join("; ")}. The queue goes on.` });
  recordHistory();
  try { ratioReportFor(g); } catch (e) { store.log({ kind: "note", text: `Ratio report not written: ${e.message}` }); }
  const q = readGoalQueue(store.dir);
  if (stop.length) {
    const text = stop.join("; ");
    if (q.goals.length) {
      pauseQueue(store.dir, text);
      store.log({ kind: "needs-you", text: `Goal queue stopped: ${text}. ${q.goals.length} goal${q.goals.length === 1 ? "" : "s"} wait for you.` });
      tellOwner("Constance needs you", `${text}. The goal queue is stopped until you start the next goal.`);
    } else if (g.fromQueue || g.fromSpare) {
      // The queue ran dry on a goal that needs the owner: the morning report says so (one notice, not two).
      store.log({ kind: "needs-you", text: `${text}.` });
      morningReport();
    } else {
      store.log({ kind: "needs-you", text: `${text}.` });
      tellOwner("Constance needs you", `${text}.`);
    }
    return false;
  }
  // The owner paused the queue: this goal is done and nothing else starts (no queued goal and
  // no use-it-or-lose-it goal) until "Resume queue".
  if (q.ownerPaused) {
    if (q.goals.length) store.log({ kind: "queue", text: `Queue paused: ${q.goals.length} goal${q.goals.length === 1 ? " waits" : "s wait"} until you press Resume queue.` });
    else if (g.fromQueue || g.fromSpare) morningReport();
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
  writeAtomic(spareFile(), JSON.stringify({ used: [...seen, ...picks.map(key)].slice(-200) }) + "\n");
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
      const cur = store.read().goal, q = readGoalQueue(store.dir);
      if (!cur || !["running", "paused"].includes(cur.status)) {
        if (!q.paused && !q.ownerPaused && q.goals.length === 1) return startNextNow();
      }
      return out(`Queued: ${g.text.split("\n")[0].slice(0, 100)}${q.ownerPaused ? " (the queue is paused: it waits for Resume queue)" : ""}`);
    }
    if (sub === "rm") { const g = removeGoal(store.dir, id); store.log({ kind: "queue", text: `Goal removed from the queue: ${g.text.split("\n")[0].slice(0, 100)}` }); return out("removed"); }
    if (sub === "edit") {
      const text = process.argv.includes("--goal") ? arg("--goal") : undefined;
      const dir = arg("--dir") || arg("--new") ? resolveDir(arg("--dir"), arg("--new")) : "";
      editGoal(store.dir, id, { text, dir }); return out("edited");
    }
    if (sub === "move") { moveGoal(store.dir, id, process.argv[5]); return out("moved"); }
    if (sub === "next") return startNextNow();
    if (sub === "pause") {
      const q = holdQueue(store.dir);
      store.log({ kind: "queue", text: "Queue paused by you: the current goal keeps running; no queued goal starts until Resume queue." });
      return out(`Queue paused.${q.goals.length ? ` ${q.goals.length} goal${q.goals.length === 1 ? " waits" : "s wait"}.` : ""}`);
    }
    if (sub === "resume") {
      const q = releaseQueue(store.dir);
      store.log({ kind: "queue", text: "Queue resumed." });
      // Nothing running and nothing stopping it: the next goal starts now, as it would have.
      const cur = store.read().goal;
      if ((!cur || !["running", "paused"].includes(cur.status)) && !q.paused && q.goals.length) return startNextNow();
      return out(`Queue resumed.${q.paused ? ` It is still stopped for you: ${q.paused} Press Start next when ready.` : ""}`);
    }
  } catch (e) { fail(e.message); }
  const q = readGoalQueue(store.dir);
  out(q);
}
// The owner's "Start next": clears a stopped queue and starts the first goal.
function startNextNow() {
  const cur = store.read().goal;
  if (cur && ["running", "paused"].includes(cur.status)) fail("She is already on a goal; the next one starts when it ends.");
  if (readGoalQueue(store.dir).ownerPaused) fail("The queue is paused: press Resume queue to start the next goal.");
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
// `C report`: the current (or last) goal's full report, for the panel's Show report.
function reportCmd() {
  const g = store.read().goal;
  if (!g) fail("No goal yet.");
  out({ id: g.id, status: g.status, report: goalReport(store.dir, g) });
}

function jobCmd() {
  const id = Number(process.argv[3]);
  const s = store.read(), j = s.jobs.find((x) => x.id === id);
  if (!j) fail(`No job ${id}.`);
  const { guardBefore, ...rest } = j;
  out({ ...rest, summary: reviewText(j.agent, rest.summary || ""), log: store.readLog(2000).filter((e) => e.job === id && e.kind !== "practice").slice(-20) });
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
  writeAtomic(pidFile, String(process.pid));
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
  try { sampleCopiesRunning(); } catch {}
  try {
    if (lastProgressArgs) progressTick({ ...lastProgressArgs, target: TARGET_PER_PCT, stateFile: path.join(store.dir, "progress.json"), exec: progressExec });
  } catch {}
}

async function drive() {
  let pausedLogged = false, failures = 0;
  for (;;) {
    const g = store.read().goal;
    if (!g || !["running", "paused"].includes(g.status)) return;
    const dNow = freshData();
    const p = paceNow(dNow);
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
      if (!canResume(p, brainOf(readData()))) {
        const why = `Waiting for a current reading of ${brainName(brainNow())}'s limits before picking the goal up again.`;
        if (g.pauseReason !== why) { store.update((s) => { s.goal.pauseReason = why; }); store.log({ kind: "paused", text: why }); }
        pausedLogged = true;
        await sleep(60e3); continue;
      }
      store.update((s) => { s.goal.status = "running"; delete s.goal.pauseReason; });
      store.log({ kind: "resumed", text: kept ? "You chose Keep going; picking the goal up again." : "Back under her limits; picking the goal up again." });
      pausedLogged = false;
    }
    // After a restart the previous brain run may still be going: adopt it rather than start a second one.
    const cli = brainCli(g.brainId);
    if (alive(g.brainPid, cli)) {
      let killed = false;
      while (alive(g.brainPid, cli)) {
        const st = store.read().goal;
        if (!st || st.status === "stopped") return;
        if (!killed && paceNow(readData()).mode === "stop") { killGroup(g.brainPid); killed = true; }
        try { releaseHeld(); fillSlots(); heartbeat(); } catch {}
        await sleep(5000);
      }
      const st = store.read().goal;
      // The adopted run's step is closed (its exit code is unknown; the board says what it did).
      // A killed one stays open, so the next session is told it was cut off.
      if (st && !killed) store.update((x) => { if (x.goal) { const m = memoryOf(x.goal); if (openStep(m)) { endStep(m, { outcome: "ok" }); openStep(m); } x.goal.handoff = m; } });
      if (!st || st.status !== "running" || killed) continue;
    }
    // What next (constance-steps.mjs): a fresh brain session for a planning step
    // or a review batch, or — while the workers work — no brain at all: the
    // driver sweeps (what \`C wait\` used to do inside her session) and keeps the
    // board and the handoff file current.
    try { sweep(); releaseHeld(); } catch {}
    let st = store.read();
    let step = decideStep(st);
    if (step.action === "wait") {
      for (;;) {
        const cur = store.read().goal;
        if (!cur || cur.status === "stopped") return;
        if (cur.status !== "running" || paceNow(readData()).mode === "stop") break;
        try { sweep(); releaseHeld(); fillSlots(); heartbeat(); renderHandoffNow(); } catch {}
        st = store.read();
        step = decideStep(st);
        if (step.action !== "wait") break;
        await sleep(WAIT_TICK_MS);
      }
      continue;
    }
    if (step.action === "done") {
      if (step.why === "no progress after the nudges") store.log({ kind: "note", text: `The last ${MAX_NUDGES + 1} steps moved nothing (${openWork(st) || "nothing open"}); ending the goal.` });
      const report = (() => { try { return fs.readFileSync(path.join(store.dir, `report-${g.id}.txt`), "utf8").trim(); } catch { return ""; } })();
      store.update((s) => { s.goal.status = "done"; s.goal.finishedAt = Date.now(); s.goal.report = report.slice(-4000); });
      logStepTotals();
      store.log({ kind: "report", text: report.slice(-4000) || "(no report)" });
      try { renderHandoffNow(); } catch {}
      if (afterGoal()) { pausedLogged = false; failures = 0; continue; }
      return;
    }
    // The brain is picked fresh at every step: the owner can flip
    // settings.constanceBrain between runs. Wanted-but-not-allowed is told to
    // the owner once per goal, then she quietly stays on Claude Code.
    const b = brainNow();
    if (b.wanted === "antigravity" && !b.ok && !g.brainNoteLogged) {
      store.update((s) => { if (s.goal) s.goal.brainNoteLogged = true; });
      store.log({ kind: "note", text: b.why });
    }
    const model = brainModel(dNow, b);
    const kind = step.action;
    // A step that didn't end cleanly (a crash, a restart, a limit pause, a
    // failed run) is closed and the fresh session is told so; everything it did
    // is already on the board, so the handoff file is all it needs.
    const prevStep = memoryOf(st.goal).steps.at(-1);
    const resumed = resumedFrom(prevStep);
    if (prevStep && !prevStep.endedAt) store.update((x) => { if (x.goal) { const m = memoryOf(x.goal); endStep(m, { outcome: "interrupted (a restart or a crash)" }); x.goal.handoff = m; } });
    let nudgeText = "";
    if (step.nudge) {
      const n = (st.goal.nudges || 0) + 1;
      store.update((x) => { if (x.goal) x.goal.nudges = n; });
      nudgeText = `The goal is not finished: ${openWork(st) || "work is still open"}. The last session ended without moving it. Keep going: delegate or review, don't ask.`;
      store.log({ kind: "note", text: `${brainName(b)} ended a step but the goal is unfinished (${openWork(st)}); a fresh session picks it up, nudge ${n} of ${MAX_NUDGES}.` });
    }
    st = store.read();
    const batch = kind === "review" ? step.jobs.map((id) => st.jobs.find((j) => j.id === id)).filter(Boolean).map((j) => reviewPacket(j, st)) : [];
    const ho = renderHandoffNow() || { text: "", file: "" };
    const firstPlan = kind === "plan" && !memoryOf(st.goal).steps.length;
    // Fresh lessons and this project's own rules ride along on every step (advice only — her core rules never change).
    const prompt = stepPrompt({ kind, dir: g.dir, handoff: ho.text, handoffPath: ho.file, lessons: lessonsBlock(readLessons(store.dir)), milk: milkPrompt(readMilk(readSettings())), rules: rulesBlock(readProjectRules(g.dir)), batch, resumed, nudge: nudgeText, ownerGoal: firstPlan ? g.text : "" });
    const session = randomUUID();
    const mark = stepView(st).mark;
    store.update((x) => { if (x.goal) { const m = memoryOf(x.goal); beginStep(m, { kind, session, model, jobs: step.jobs || [], promptChars: prompt.length, resumed, mark }); x.goal.handoff = m; } });
    const { cmd, args } = brainCommand({ brain: b.id, model, role: ROLE(g.dir), prompt, session, resume: false });
    const reportPath = path.join(store.dir, `report-${g.id}.txt`);
    const fd = fs.openSync(reportPath, "w");
    const brain = spawn(cmd, args, { cwd: g.dir, env: ENV, detached: true, stdio: ["ignore", fd, fd] });
    store.update((s) => { s.goal.started = true; s.goal.brainPid = brain.pid; s.goal.brainId = b.id; s.goal.brainModel = model; s.goal.session = session; });
    store.log({ kind: "step", step: kind, model, text: `Step ${memoryOf(store.read().goal).steps.at(-1)?.n}: ${kind === "review" ? `review of job${batch.length === 1 ? "" : "s"} ${batch.map((j) => j.id).join(", ")}` : "planning"} in a fresh session (${prompt.length} prompt chars)${resumed ? `, after ${resumed}` : ""}.` });
    // Every step leaves a route line: the step, the model she actually runs on,
    // and why (constance-route.mjs routes planning; a review batch runs on her brain model).
    try {
      store.log({ kind: "route", step: kind, model, text: kind === "plan" ? routeModel("plan", { milk: readMilk(readSettings()) }).why : "a review batch runs on her own brain model" });
      logRoute(path.join(store.dir, "routes.jsonl"), { step: kind, model, job: g.id });
    } catch {}
    let pausedByUs = false;
    const watch = setInterval(() => {
      const cur = store.read().goal;
      if (!cur || cur.status === "stopped") { killGroup(brain.pid); return; }
      try { releaseHeld(); fillSlots(); heartbeat(); } catch {}
      if (paceNow(readData()).mode === "stop") { pausedByUs = true; killGroup(brain.pid); }
    }, 30e3);
    const code = await new Promise((r) => brain.on("exit", (c) => r(c)));
    clearInterval(watch);
    const report = (() => { try { return fs.readFileSync(reportPath, "utf8").trim(); } catch { return ""; } })();
    const close = (outcome) => store.update((x) => { if (x.goal) { const m = memoryOf(x.goal); endStep(m, { outcome, code: code ?? -1, outChars: report.length }); x.goal.handoff = m; } });
    const now = store.read().goal;
    if (!now || now.status === "stopped") { close("stopped by the owner"); try { renderHandoffNow(); } catch {} return; }
    if (pausedByUs) { close("paused for her limits"); continue; }
    if (code === 0) { close("ok"); failures = 0; try { renderHandoffNow(); } catch {} continue; }
    // Her brain said it hit its limit (Claude's "You've hit your 5-hour limit · resets 5:50pm
    // (America/New_York)", or agy's quota text): a pause until the time it stated, never a
    // failure. pace() reads wall.json and stops her until then.
    const wall = brainWall(b.id, report, Date.now(), brainOf(freshData()).limits);
    if (wall && (code !== 0 || report.length < 400)) {
      writeWall(store.dir, wall);
      close("her limit wall");
      // The pause reason must name the wall even when its stated reset already
      // passed (the readings then show "on pace"): resumePlan only follows
      // wall.json for a pause whose reason starts "<Brain> said it hit its limit".
      const wallReason = `${brainName(b)} said it hit its limit; paused until ${clock(wall.until)}.`;
      store.update((s) => { if (s.goal) { s.goal.status = "paused"; s.goal.pauseReason = wallReason; } });
      store.log({ kind: "paused", text: wallReason });
      pausedLogged = true;
      continue;
    }
    // Opus (or whatever she is on) isn't allowed on this Claude plan: drop to the
    // best model that is and run the step again on it. Not a failure.
    const cur = store.read().goal;
    const next = cur && cur.status === "running" && b.id === "claude" ? nextModel(cur.model || "opus", report) : null;
    if (next) {
      close(`a model switch to ${modelName(next)}`);
      store.update((s) => { if (s.goal) s.goal.model = next; });
      store.log({ kind: "model", text: `${modelName(cur.model || "opus")} isn't allowed on this Claude plan; Constance switched to ${modelName(next)} and started the step over.` });
      continue;
    }
    close(`a failed run (exit ${code})`);
    if (++failures >= 3) {
      const last = report.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) || "";
      const reason = `${brainName(b)} exited with code ${code} three times: ${last ? last.slice(0, 200) : "no output"}`;
      store.update((s) => { s.goal.status = "failed"; s.goal.finishedAt = Date.now(); s.goal.failReason = reason; });
      logStepTotals();
      store.log({ kind: "failed", text: reason });
      try { renderHandoffNow(); } catch {}
      // A failed goal is a note, not a stop: afterGoal() starts the next queued goal.
      if (afterGoal()) { pausedLogged = false; failures = 0; continue; }
      return;
    }
    store.log({ kind: "note", text: `${brainName(b)} exited with code ${code}; retrying in a minute.` });
    await sleep(60e3);
  }
}

// How often the driver sweeps while workers work and no brain runs (tests shorten it).
const WAIT_TICK_MS = Number(ENV.CONSTANCE_WAIT_TICK_MS) || 5000;

// The step decision for the goal as it stands (constance-steps.mjs).
function decideStep(s) {
  const v = stepView(s);
  const mem = memoryOf(s.goal);
  const ended = mem.steps.filter((x) => x.endedAt);
  const last = mem.steps.at(-1);
  return nextStep({ openItems: v.openItems, inFlight: v.inFlight, reviewable: v.reviewable, practice: practiceMode(), needsOwner: !!s.goal.needsOwner,
    stepsDone: ended.filter((x) => x.outcome === "ok").length, nudges: s.goal.nudges || 0,
    lastMark: last && last.endedAt && last.outcome === "ok" && last.mark !== undefined ? last.mark : null, mark: v.mark,
    lastUnclean: !!last && (!last.endedAt || last.outcome !== "ok"),
    ...(ENV.CONSTANCE_REVIEW_WAIT_MS ? { waitMs: Number(ENV.CONSTANCE_REVIEW_WAIT_MS) } : {}) });
}

// One log line per goal with what her brain sessions cost in prompt size: the
// numbers to compare against the old one-long-session goals.
function logStepTotals() {
  const g = store.read().goal;
  const steps = memoryOf(g).steps;
  if (!steps.length) return;
  const chars = steps.reduce((a, x) => a + (x.promptChars || 0), 0), top = Math.max(...steps.map((x) => x.promptChars || 0));
  const plan = steps.filter((x) => x.kind === "plan").length, rev = steps.filter((x) => x.kind === "review").length;
  store.log({ kind: "steps", sessions: steps.length, plan, review: rev, promptChars: chars, maxPromptChars: top,
    text: `This goal ran ${steps.length} fresh brain session${steps.length === 1 ? "" : "s"} (${plan} planning, ${rev} review); prompts ${chars} chars in all, the largest ${top}.` });
}

function stopAll() {
  // Jobs that were actually running still get their guard check before their
  // worktrees and temp folders go: a stopped agent's stray changes count too.
  // Held/waiting jobs never launched, so there is nothing to check for them.
  // A job mid-handover to Opus ran too: its worker's partial changes are checked as well.
  const halted = new Set(store.read().jobs.filter((j) => j.status === "running" || j.handingOver).map((j) => j.id));
  const s = store.update((s) => {
    if (s.goal && ["running", "paused"].includes(s.goal.status)) { s.goal.status = "stopped"; s.goal.finishedAt = Date.now(); }
    for (const j of s.jobs) if (j.status === "running" || j.status === "waiting" || j.status === "held") { if (alive(j.pid, cliOf(j))) killGroup(j.pid); j.status = "stopped"; j.stoppedAt = Date.now(); }
    return JSON.parse(JSON.stringify(s));
  });
  // A self-merge still running in the background dies with everything else;
  // the next sweep clears its flag and the job stays finished for the record.
  for (const j of s.jobs) if (j.selfMerging && alive(j.selfMergePid, "selfmerge")) killGroup(j.selfMergePid);
  // Keep the halted workers' token counts before their worktrees go (only when any ran).
  if (halted.size) keepTokens(true);
  for (const j of s.jobs) if (j.status === "stopped") { if (halted.has(j.id)) guardFinished(j); dropJobTmp(j); if (j.worktree) dropWorktree(j.dir, j.worktree, j.branch, { deleteBranch: true }); }
  const g = s.goal;
  if (g && alive(g.brainPid, brainCli(g.brainId))) killGroup(g.brainPid);
  if (g && alive(g.driverPid, "constance.mjs")) killGroup(g.driverPid);
  if (isWatcher(watcherPid())) killGroup(watcherPid());
  store.log({ kind: "stopped", text: "Stop pressed: Constance and every job halted." });
  try { renderHandoffNow(); } catch {}   // the project keeps a true handoff for the next goal
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

// How long preparing took on earlier goals: goal start to its first handed-out
// job (handoff, practice or held), measured from the log's entries. Goals still
// on record only as history.jsonl rows carry no job times, so the log is the
// source; the running goal's own segment is skipped. Empty when nothing is known.
function prepHistory(s, log) {
  const cutoff = s.goal && ["running", "paused"].includes(s.goal.status) ? (s.goal.startedAt || Infinity) : Infinity;
  const out = [];
  let start = null;
  for (const e of log || []) {
    if (e.kind === "goal") { start = Number.isFinite(e.at) && e.at < cutoff ? e.at : null; continue; }
    if (start === null) continue;
    if (["handoff", "practice", "held"].includes(e.kind)) {
      if (Number.isFinite(e.at) && e.at > start) out.push(e.at - start);
      start = null;
    } else if (["report", "stopped", "failed"].includes(e.kind)) start = null;
  }
  return out;
}

// Her own Claude sessions' tokens on this goal: folder-usage records for agent
// "claude" in the goal's folder that started while it ran (each brain step
// spawns one there). null when there is no goal or nothing matched — the Rev
// Meter's lead share stays hidden rather than guessing.
function leadTokensOf(goal, records) {
  if (!goal || !goal.dir || !Number.isFinite(goal.startedAt)) return null;
  const until = Number.isFinite(goal.finishedAt) ? goal.finishedAt : Infinity;
  let total = 0, seen = false;
  for (const r of records || []) {
    if (!r || r.agent !== "claude" || r.unit !== "tokens" || r.folder !== goal.dir) continue;
    const start = Number(r.start), amount = Number(r.amount);
    if (!Number.isFinite(start) || start < goal.startedAt || start > until || !Number.isFinite(amount) || amount < 0) continue;
    seen = true; total += amount;
  }
  return seen ? total : null;
}

function boardView(s, d, records) {
  const names = Object.fromEntries((d.agents || []).filter((a) => a.name).map((a) => [a.id, a.name]));
  const name = (id) => names[id] || (id ? id[0].toUpperCase() + id.slice(1) : id);
  const live = matchJobs(s.jobs, records);
  const gq = readGoalQueue(store.dir);
  const cl = checklist(s.goal, asAccepted(s.jobs));
  const log = store.readLog(5000);
  // The Rev Meter's inputs: running workers (lead lanes counted apart), the
  // copy slots free plus the ones busy, her per-1% leverage and the goal's
  // measured worker/lead token split — each null when it can't be known.
  const goalTokens = tokenMeter({ jobs: s.jobs, goal: s.goal, records }).goal;
  const workerTokens = goalTokens && (goalTokens.total > 0 || goalTokens.cantTell === 0) ? goalTokens.total : null;
  const leadTokens = leadTokensOf(s.goal, records);
  const busyJobs = s.jobs.filter((j) => ["running", "waiting"].includes(j.status));
  const lanes = busyJobs.filter((j) => j.lane).length;
  const running = busyJobs.length - lanes;
  let freeSlots = 0;
  if (s.goal) for (const agent of Object.keys(PUBLISHED_MAX)) freeSlots += Math.max(0, limitOf(agent) - copySlots(s, agent, s.goal.dir).length);
  return {
    ...meters({ goal: s.goal, items: cl.items, jobs: s.jobs, steps: memoryOf(s.goal).steps.length,
      prepHistory: prepHistory(s, log), now: Date.now(), running, lanes, slots: freeSlots + running,
      perPct: leverageView(s, workerTokens).perPct, workerTokens, leadTokens }),
    checklist: cl,
    cards: cards({ jobs: s.jobs, goal: s.goal, queue: s.goal && ["running", "paused"].includes(s.goal.status) ? queueView(s.goal.dir, store.dir, s.goal.id) : [], live, names: name }),
    // A merged job still waits for her review, so the Now line counts it with the finished ones.
    now: nowLine({ goal: s.goal, jobs: s.jobs.map((j) => (j.status === "merged" ? { ...j, status: "finished" } : j)), names: name, goalQueue: gq.goals, queuePaused: gq.paused, queueHeld: gq.ownerPaused }),
    history: history({ records: readHistory(), log, goal: s.goal, jobs: s.jobs, live }),
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

// ---------------------------------------------------------------- ratio report
// End-of-goal ratio report (constance-ratio-report.mjs): free-worker tokens per
// 1% of her session, Opus routing by step, average copies and idle
// slot-minutes. The driver heartbeat drops one copies-running sample into her
// state dir (ratio-samples.jsonl); afterGoal turns the goal's jobs, its 'route'
// log lines and those samples into the report, appends it to history.jsonl
// and keeps its lesson lines.
const ratioSamplesFile = () => path.join(store.dir, "ratio-samples.jsonl");
const ROUTE_STEP = { plan: "planning", spec: "specs", review: "reviews", "review-failed": "reviews", fix: "fixes", conflict: "fixes" };

function sampleCopiesRunning() {
  const s = store.read();
  const copiesRunning = s.jobs.filter((j) => j.copy && (j.status === "running" || j.status === "waiting")).length;
  const f = ratioSamplesFile();
  fs.appendFileSync(f, JSON.stringify({ at: Date.now(), copiesRunning }) + "\n");
  const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  if (lines.length > 4000) writeAtomic(f, lines.slice(-4000).join("\n") + "\n");
}

// Her Session window's used share right now, in percent (null when unreadable).
function sessionPctNow() {
  const w = (paceNow(readData())?.windows || []).find((x) => x.title === "Session");
  return Number.isFinite(w?.used) ? w.used * 100 : null;
}

function ratioReportFor(g) {
  const s = store.read();
  const jobs = s.jobs.filter((j) => j.goal === g.id).map((j) => ({
    ...j, verdict: j.status === "accepted" || j.status === "merged" ? "accept" : j.status === "sent back" ? "send-back" : "review",
  }));
  const routes = store.readLog(5000)
    .filter((l) => l.kind === "route" && l.model && Number(l.at) >= (g.startedAt || 0))
    .map((l) => ({ step: ROUTE_STEP[l.step] || l.step, model: l.model }));
  const samples = readSamples(ratioSamplesFile(), g.startedAt);
  const end = sessionPctNow();
  const spent = sessionSpent(readSamples(leverageFile(), g.startedAt));
  const start = end !== null ? Math.max(0, end - spent) : null;
  const slots = Object.keys(PUBLISHED_MAX).reduce((n, a) => n + limitOf(a), 0);
  const report = ratioReport({ goal: g, jobs, routes, samples, sessionStartPct: start, sessionEndPct: end, slots });
  for (const l of saveReport(store.dir, report)) addLesson(l, store.dir);
}

// status.milk: the slider's policy plus the step it sits on (name, one-line
// description) and the five steps themselves, so the panel can caption the
// knob without duplicating bin/constance-milk.mjs. Additive fields only.
function milkStatus() {
  const v = readMilk(readSettings());
  const step = milkStep(v);
  return { ...milkPolicy(v), autoTakeover: autoTakeoverOn(v), stepName: step.name, stepDescription: step.description,
    steps: MILK_STEPS.map((s) => ({ name: s.name, value: s.value, description: s.description })) };
}

function statusPayload() {
  sweep();   // the panel's 3 s poll is what notices done files and starts self-merges
  const records = keepTokens();
  fillSlots();
  const s = store.read(), d = readData();
  const p = paceNow(d);
  sampleLeverage(p);
  const tv = tokensView(s, d, records);
  const pargs = progressArgs(s, p, tv);
  const board = boardView(s, d, records);
  const pline = pargs ? progressLine({ ...pargs, target: TARGET_PER_PCT }) : "";
  if (pline) board.now += ` · ${pline}`;
  lastProgressArgs = pargs;
  // The brain picker the panel shows: the live pick (wanted vs ok), the model it
  // would run on (agy's top model name, else her Claude model) and its milk label.
  const b = brainNow();
  const brain = { id: b.id, name: b.name, wanted: b.wanted, ok: b.ok, why: b.why || "",
    model: b.id === "antigravity" ? (brainTop(d, b)?.name || "") : modelName(s.goal?.model || "opus"),
    milkLabel: milkLabel(b.id) };
  return { goal: s.goal, board, progress: { line: pline }, tokens: tv, jobs: s.jobs.map(({ prompt, guardBefore, ...j }) => j), agents: judged(d), pace: p, brain,
    leverage: leverageView(s, tv.goal?.total ?? null), milk: milkStatus(), practice: practiceMode(), guards: s.guards || {}, copies: copiesView(s),
    queue: s.goal ? queueView(s.goal.dir, store.dir, s.goal.id) : [], signals: recentSignals(store.dir, 10), log: store.readLog(150) };
}

function status() { out(statusPayload()); }

const cmd = process.argv[2];
if (process.argv[1] === SELF) {
  // A closed pipe (e.g. `status | head -1`) must end quietly, not with an 'write EPIPE' stack trace.
  for (const s of [process.stdout, process.stderr]) s.on("error", (e) => { if (e?.code === "EPIPE") process.exit(0); throw e; });
  if (cmd === "start") startGoal();
  else if (cmd === "drive") await drive();
  else if (cmd === "status") status();
  // The phone-safe summary (constance-remote.mjs): written to her state dir,
  // nothing is sent anywhere and no port is opened. Prints the file's path.
  else if (cmd === "remote") { writeRemoteStatus(statusPayload(), remoteFile()); out(remoteFile()); }
  else if (cmd === "agents") {
    const d = freshData(), guards = store.read().guards || {}, card = readScorecard(store.dir), rows = scoreRows(card);
    const all = judged(d), order = rankAgents(all.filter((a) => a.available).map((a) => a.id), card);
    // Available agents first, best scorecard first — except Devin leads while
    // it is available and kilo sits right behind it (preferOrder); each with
    // its record and a size hint.
    const sorted = preferOrder([...order.map((id) => all.find((a) => a.id === id)), ...all.filter((a) => !a.available)]);
    out(sorted.map((a) => {
      const row = rows.find((r) => r.agent === a.id), h = sizeHint(row);
      const sc = a.available ? `  [${row ? scoreLine(row) : "no reviewed jobs yet"}; ${h.note}: up to ${h.maxFiles} file${h.maxFiles === 1 ? "" : "s"} a job]` : "";
      return `${a.available ? "AVAILABLE  " : "skip       "}${a.id.padEnd(12)} ${a.reason}${guards[a.id]?.strikes ? `  (guardrail strikes: ${guards[a.id].strikes} — smaller tasks only)` : ""}${sc}${a.id === "kilo" ? `  (${KILO_NOTE})` : ""}`;
    }).join("\n"));
  }
  else if (cmd === "pace") out(paceNow(freshData()));
  else if (cmd === "jobs") { sweep(); releaseHeld(); const s = store.read(); out({ goal: s.goal && { text: s.goal.text, dir: s.goal.dir, status: s.goal.status }, queue: s.goal ? queueView(s.goal.dir, store.dir, s.goal.id) : [], copies: copiesView(s), jobs: s.jobs.map(({ prompt, guardBefore, ...j }) => j) }); }
  else if (cmd === "queue") queueCmd();
  else if (cmd === "backlog") backlogCmd();
  else if (cmd === "scorecard") { const rows = scoreRows(readScorecard(store.dir)); out(rows.length ? rows.map((r) => `${scoreLine(r)} — ${sizeHint(r).note}`).join("\n") : "No reviewed jobs yet."); }
  else if (cmd === "spare") { const g = store.read().goal; const p = sparePlan(arg("--dir") ? path.resolve(arg("--dir")) : g?.dir); out(p.picks.length ? [p.reason, ...p.picks.flatMap((x) => x.items.map((it) => `${x.agent}: #${it.id} ${formatItem(it)}`))].join("\n") : p.reason); }
  else if (cmd === "signals") out(recentSignals(store.dir, 20));
  // The whole log as plain text (the panel's Copy all): every entry, practice prompts in full.
  else if (cmd === "log") { const names = Object.fromEntries((readData().agents || []).map((a) => [a.id, a.name || a.id])); process.stdout.write(logText(store.readLog(Infinity), (id) => names[id] || id)); }
  // `summary`: the panel's "Copy summary" — a plain-text board snapshot
  // (constance-summary.mjs), capped at 80 lines.
  else if (cmd === "summary") {
    const s = store.read(), d = readData();
    const records = keepTokens();
    const tv = tokensView(s, d, records);
    out(buildSummary({
      current: s.goal || null,
      items: checklist(s.goal, asAccepted(s.jobs)).items,
      history: readHistory(),
      queue: readGoalQueue(store.dir).goals,
      jobs: s.jobs,
      leverage: leverageView(s, tv.goal?.total ?? null),
      log: store.readLog(Infinity),
    }));
  }
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
  else if (cmd === "takeover") takeoverCmd();
  else if (cmd === "goals") goalsCmd();
  else if (cmd === "check") checkCmd();
  else if (cmd === "job") jobCmd();
  else if (cmd === "report") reportCmd();
  else if (cmd === "needs-owner") {
    const text = process.argv.slice(3).join(" ").trim();
    if (!text) fail("Usage: needs-owner TEXT");
    logAsk(path.join(store.dir, "asks.jsonl"), { reason: text });
    store.update((s) => { if (s.goal && typeof s.goal === "object") s.goal.needsOwner = text; });
    store.log({ kind: "needs-you", text });
    out("noted: the goal queue waits for the owner after this goal");
  }
  else if (cmd === "route") {
    const step = process.argv[3];
    if (!step) fail("Usage: route STEP");
    out(routeModel(step, { milk: readMilk(readSettings()) }));
  }
  else if (cmd === "handoff") handoffCmd();
  else if (cmd === "batchreview") batchReviewCmd();
  else if (cmd === "split") splitCmd();
  else if (cmd === "spec") specCmd();
  else if (cmd === "recover") recover();
  else fail("Usage: constance.mjs start|status|remote|agents|scorecard|pace|jobs|job|delegate|wait|review|reviews|check|needs-owner|note|lesson|queue|backlog|spare|goals|signals|log|summary|watch|selfmerge|route|handoff|batchreview|split|spec|takeover|report|stop|recover");
}
