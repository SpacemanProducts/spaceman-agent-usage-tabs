#!/usr/bin/env node
// Constance, the quarterback. The owner gives her a goal in the panel (the C button); she runs as Claude Code
// on the paid plan (Opus), plans, hands routine pieces to free agents that are under their limits, reviews
// everything that comes back, and reports. This file is both the panel's entry point and the toolbox she
// calls from her own shell:
//
//   start --dir D --goal TEXT   new goal (refused while one is active); starts the driver in the background
//   status                      JSON for the panel: goal, jobs, agents, pace, log
//   agents | pace | jobs        what she reads before every handoff
//   delegate --agent ID --task TEXT [--files a,b]   hand one task to one free agent (re-checks it first;
//                                                   no --files = read-only; in practice mode it only logs the prompt)
//   lesson TEXT                   add a short lesson to her lessons file (advice for later goals)
//   queue [--task TEXT [--files a,b] [--agent ID] | rm ID]   the ready-task queue for this project;
//                                                   no --task lists what's queued
//   signals                     recent agent-finished notifications she heard
//   wait [--timeout S]          block until a job finishes; prints the next one to review, oldest first
//   review ID accept|send-back --note TEXT        record her verdict
//   note TEXT                   a line in the owner's log
//   stop                        halt everything at once (her, every job)
//   recover                     panel load: restart the driver if a goal is active and it isn't running
//   drive                       (internal) the background loop that runs her and paces her
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { judgeAll, launchCommand, accountEnv, LAUNCH } from "./constance-agents.mjs";
import { pace } from "./constance-pace.mjs";
import { nextModel, modelName } from "./constance-model.mjs";
import { openStore, conflicts, handoffPrompt, doneFile, reviewQueue, overlaps } from "./constance-jobs.mjs";
import { readLessons, addLesson, lessonsBlock, readProjectRules, rulesBlock, guardrailBlock } from "./constance-lessons.mjs";
import { snapshot as guardSnapshot, checkRun, restoreRun, fileCap } from "./constance-guard.mjs";
import { NotifyParser, handleNotification, recentSignals } from "./constance-notify.mjs";
import { addTask, peekNext, finishTask, removeTask, queueView } from "./constance-queue.mjs";

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

// Practice mode (the panel's switch, on by default for now): a dry run. She still plans the goal and
// picks agents, but delegate() only writes each handoff's agent, reason and full prompt into the log —
// nothing launches and nothing changes. Missing settings.json means practice is on.
function practiceMode() {
  try { return JSON.parse(fs.readFileSync(path.join(STATE, "settings.json"), "utf8")).constancePractice !== false; }
  catch { return true; }
}

// ---------------------------------------------------------------- jobs
// Bring statuses up to date: a done file means finished; a process that ended without one is finished too
// (with a note), so it still gets reviewed.
function sweep() {
  const changed = store.update((s) => {
    const changed = [];
    for (const j of s.jobs) {
      if (j.status !== "running") continue;
      const f = doneFile(j.dir, j.id);
      let done = null;
      try { done = JSON.parse(fs.readFileSync(f, "utf8")); j.finishedAt = fs.statSync(f).mtimeMs; }
      catch {
        if (fs.existsSync(f)) { done = { summary: "(done file was not valid JSON)", commit: "" }; j.finishedAt = Date.now(); }
      }
      if (!done && !alive(j.pid, LAUNCH[j.agent]?.cli || "")) { done = { summary: "(the agent exited without writing its done file)", commit: "" }; j.finishedAt = Date.now(); }
      if (done) { j.status = "finished"; j.summary = String(done.summary || ""); j.commit = String(done.commit || ""); changed.push(j); }
    }
    return changed;
  });
  for (const j of changed) guardFinished(j);
  return changed;
}

// After a delegated run ends, check it stayed inside its guardrails: only its
// allowed files changed, and the home/projects lists match the pre-run
// snapshot. A violation reverts the run's own bad commit (nothing is ever deleted or
// moved), reports the rest, logs a lesson, counts a
// strike (smaller tasks from then on) and marks the job so her review sees it.
function guardFinished(j) {
  if (!j.guardBefore || j.guardChecked) return;
  const res = checkRun({ dir: j.dir, files: j.files || [], commit: j.commit, before: j.guardBefore, env: ENV });
  store.update((s) => { const x = s.jobs.find((k) => k.id === j.id); if (x) x.guardChecked = true; });
  if (res.ok) return;
  // Revert the commit only when the commit itself touched disallowed files; a
  // home/projects-only or dirty-leftover violation leaves committed work alone.
  // Only a commit the guard verified as this run's own is ever reverted.
  const commitBad = !!res.ownCommit && changedFiles(j.dir, res.ownCommit).some((p) => (res.badPaths || []).includes(p));
  const did = restoreRun({ dir: j.dir, commit: commitBad ? res.ownCommit : "", badPaths: res.badPaths || [], addedProjects: res.addedProjects || [],
    addedHome: res.addedHome || [], removedHome: res.removedHome || [], removedProjects: res.removedProjects || [] });
  const lesson = `${j.agent} broke a guardrail on job ${j.id}: ${res.violations.join("; ")}.`;
  addLesson(lesson, store.dir);
  store.update((s) => {
    const x = s.jobs.find((k) => k.id === j.id);
    if (x) x.guardViolation = res.violations;
    const g = (s.guards ||= {})[j.agent] ||= { strikes: 0, violations: [] };
    g.strikes += 1; g.violations.push({ job: j.id, at: Date.now(), what: res.violations });
  });
  store.log({ kind: "guard", job: j.id, agent: j.agent, text: `${res.violations.join("; ")}. Restored: ${did.join("; ") || "nothing to restore"}. Lesson logged; ${j.agent} gets smaller tasks now.` });
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

// The actual handoff, shared by `delegate` and the queue's auto-next: checks the
// agent is still available, enforces strike caps and file conflicts, builds the
// prompt (project rules + guardrails), snapshots the world, and launches. Throws
// with a human reason on any refusal; returns { job, who, verdict, practice }.
function handOut({ agent, task, files = [] }) {
  const g = store.read().goal;
  if (!g || g.status !== "running") throw new Error("No goal is running (stopped or paused), so nothing is handed out.");
  if (!agent || !task) throw new Error("delegate needs --agent ID and --task TEXT");
  const verdict = judgeAll(freshData()).find((a) => a.id === agent);
  if (!verdict?.available) throw new Error(`${agent} is not available: ${verdict ? verdict.reason : "unknown agent"}. Run \`agents\` and pick another, or do it yourself.`);
  const dir = g.dir;
  // Guardrail strikes shrink what this agent may touch: after a violation it gets
  // smaller tasks only, enforced here rather than left to her judgment.
  const strikes = Number(store.read().guards?.[agent]?.strikes) || 0;
  const cap = fileCap(strikes);
  if (files.length > cap) throw new Error(`${agent} broke a guardrail before, so it gets smaller tasks: at most ${cap} file${cap === 1 ? "" : "s"} per job (it asked for ${files.length}). Split the work or pick another agent.`);
  const practice = practiceMode();
  const account = verdict.accountId ? { id: verdict.accountId, label: verdict.account } : null;
  const who = verdict.name + (verdict.account ? ` (${verdict.account})` : "");
  // Per-project rules are read fresh for every handoff; guardrails go to every
  // delegated agent (they are all fast/free models).
  const extra = rulesBlock(readProjectRules(dir)) + "\n" + guardrailBlock(files);
  const job = store.update((s) => {
    const busy = conflicts(s.jobs, dir, files);
    if (busy.length) return { busy };
    const j = { id: s.next++, goal: g.id, agent, account, dir, files, task, status: practice ? "finished" : "waiting", createdAt: Date.now() };
    if (practice) { j.finishedAt = Date.now(); j.summary = "(practice run: the prompt is in the log, nothing was launched)"; }
    j.prompt = handoffPrompt(j, extra);
    s.jobs.push(j);
    return j;
  });
  if (job.busy) throw new Error(`Those files overlap job ${job.busy.map((b) => `${b.id} (${b.agent}: ${b.files.join(", ")})`).join("; ")}. Wait for it, or split the work differently.`);
  if (practice) {
    store.log({ kind: "practice", job: job.id, agent, account: verdict.account, reason: verdict.reason, files, text: task, prompt: job.prompt });
    return { job, who, verdict, practice: true };
  }
  excludeDoneFiles(dir);
  fs.mkdirSync(path.join(dir, ".constance"), { recursive: true });
  try { fs.rmSync(doneFile(dir, job.id)); } catch {}
  // Snapshot the world before the run: the post-run guard checks the diff and
  // these lists against it.
  const before = guardSnapshot(ENV, dir);
  store.update((s) => { const j = s.jobs.find((x) => x.id === job.id); j.guardBefore = before; });
  const logPath = path.join(store.dir, `job-${job.id}.log`);
  const fd = fs.openSync(logPath, "w");
  const [cmd, ...args] = launchCommand(agent, job.prompt);
  // A non-seated account's login lives in its own home: pin the CLI to it.
  const child = spawn(cmd, args, { cwd: dir, env: { ...ENV, ...accountEnv(agent, job.account?.id) }, detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  store.update((s) => { const j = s.jobs.find((x) => x.id === job.id); j.status = "running"; j.pid = child.pid; j.startedAt = Date.now(); j.log = logPath; });
  store.log({ kind: "handoff", job: job.id, agent, account: verdict.account, files, text: task });
  return { job, who, verdict, practice: false };
}

function delegate() {
  const agent = arg("--agent"), task = arg("--task"), files = arg("--files").split(",").map((x) => x.trim()).filter(Boolean);
  let r;
  try { r = handOut({ agent, task, files }); }
  catch (e) { fail(e.message); }
  const { job, who, verdict } = r;
  if (r.practice) {
    out(`Practice job ${job.id}: ${who} would take it (${verdict.reason}). Nothing launched; the full prompt is in the log. Run \`wait\` to review it.`);
    return;
  }
  out(`Job ${job.id} handed to ${who} (${verdict.reason}). ${files.length ? `It may edit ${files.join(", ")}.` : "Read-only."} It writes ${doneFile(job.dir, job.id)} when done; run \`wait\`.`);
}

// After a job is accepted, the next queued task for its project goes to the
// same agent right away — that's the point of the ready queue. A refusal (the
// agent hit a limit, files conflict) leaves the task queued and says why.
function autoNext(j) {
  const item = peekNext(j.dir, store.dir);
  if (!item) return "";
  const agent = item.agent || j.agent;
  try {
    const r = handOut({ agent, task: item.task, files: item.files || [] });
    finishTask(j.dir, item.id, r.job.id, store.dir);
    store.log({ kind: "note", text: `Ready queue: "${item.task.slice(0, 80)}" went to ${agent} automatically as job ${r.job.id}.` });
    return r.practice
      ? ` Next queued task logged for ${agent} (practice).`
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
    const item = addTask(g.dir, { task, files, agent: arg("--agent") }, store.dir);
    store.log({ kind: "note", text: `Ready queue: "${task.slice(0, 80)}" queued (${files.length ? files.join(", ") : "read-only"}${item.agent ? ", for " + item.agent : ", any agent"}).` });
    out(`Queued as task ${item.id}. It goes to ${item.agent || "the finishing agent"} automatically when the current job is accepted.`);
    return;
  }
  const q = queueView(g.dir, store.dir);
  if (!q.length) { out("The ready queue is empty."); return; }
  out(q.map((t) => `${t.id}. ${t.task}${t.files.length ? `  [${t.files.join(", ")}]` : "  [read-only]"}${t.agent ? `  → ${t.agent}` : ""}`).join("\n"));
}

async function waitJob() {
  const until = Date.now() + Math.min(560, Number(arg("--timeout", "100")) || 100) * 1000;
  for (;;) {
    for (const j of sweep()) store.log({ kind: "returned", job: j.id, agent: j.agent, account: j.account?.label || "", text: j.summary + (j.commit ? ` (commit ${j.commit.slice(0, 9)})` : "") });
    const s = store.read();
    const next = reviewQueue(s.jobs)[0];
    if (next) {
      const files = changedFiles(next.dir, next.commit);
      // Earlier finished or accepted jobs in this goal that changed the same files: check against them first.
      const earlier = s.jobs.filter((j) => j.id !== next.id && j.goal === next.goal && ["finished", "accepted"].includes(j.status) && (j.finishedAt || 0) <= (next.finishedAt || 0))
        .map((j) => ({ id: j.id, agent: j.agent, commit: j.commit, shared: overlaps(changedFiles(j.dir, j.commit), files) })).filter((x) => x.shared.length);
      let tail = ""; try { tail = fs.readFileSync(next.log, "utf8").slice(-2500); } catch {}
      return out({ review: { id: next.id, agent: next.agent, dir: next.dir, files: next.files, task: next.task, summary: next.summary, commit: next.commit, changedFiles: files,
        guardViolation: next.guardViolation || null,
        checkAgainst: earlier, logTail: tail, queue: queueView(next.dir, store.dir) }, stillRunning: s.jobs.filter((j) => j.status === "running").map((j) => ({ id: j.id, agent: j.agent })), signals: recentSignals(store.dir, 6),
        next: "Review it now: read its report and check it against the goal; read the full diff yourself only when the change is risky or the report doesn't add up. Compare it with any earlier job listed under checkAgainst. Fix small problems yourself or send it back with a new delegate. Then `review " + next.id + " accept|send-back --note ...`." });
    }
    if (!s.jobs.some((j) => j.status === "running")) return out({ review: null, stillRunning: [], next: "No jobs are running." });
    if (s.goal?.status === "stopped") return out({ review: null, next: "Stopped by the owner. End now." });
    if (Date.now() > until) return out({ review: null, stillRunning: s.jobs.filter((j) => j.status === "running").map((j) => ({ id: j.id, agent: j.agent })), next: "Still running; call `wait` again." });
    await sleep(5000);
  }
}

function review() {
  const id = Number(process.argv[3]), verdict = process.argv[4], note = arg("--note");
  if (!["accept", "send-back"].includes(verdict)) fail("Usage: review ID accept|send-back --note TEXT");
  const j = store.update((s) => { const j = s.jobs.find((x) => x.id === id); if (j) { j.status = verdict === "accept" ? "accepted" : "sent back"; j.reviewNote = note; j.reviewedAt = Date.now(); } return j; });
  if (!j) fail(`No job ${id}.`);
  store.log({ kind: "review", job: id, agent: j.agent, verdict, text: note });
  // Accepted means the agent is free: hand it the next queued task for this
  // project immediately, so free capacity never sits idle.
  const extra = verdict === "accept" ? autoNext(j) : "";
  out(`Job ${id} ${j.status}.${extra}`);
}

// ---------------------------------------------------------------- the goal and the driver
const ROLE = (dir) => `You are Constance, the quarterback of the owner's coding agents. You run on the owner's one paid plan (Claude). You plan, delegate, review and still play yourself when the work is hard or risky. You have full authority: never stop to ask permission.

Your toolbox is \`node ${SELF} <command>\` (call it C below). Work only in ${dir}.
- \`C pace\`: your own session/weekly pacing. Obey its mode. "normal": keep hard, risky or architectural work, delegate routine well-defined low-risk pieces. "delegate": you are burning your limits too fast, so delegate editing and testing too and keep only planning and review. You never run out of your own limits; the driver pauses you at 90% and resumes after the reset.
- \`C agents\`: who is available right now (under their limits, signed in, readable, free). Re-check right before every handoff; availability changes as limits reset. No agent is the default: spread work over whoever has spare capacity. Never use an agent that isn't listed as available, and never anything that costs money.
- \`C delegate --agent ID --files a,b --task "..."\`: hand off one small, clear task — the smaller and more self-contained, the better; give weaker agents smaller pieces. List every file it may edit; two editing jobs may never share files, and you must not edit a running job's files yourself. For read-only work (investigating a cause, summarizing a file) omit \`--files\`. The tool adds the folder check, git rules, tests/build and done file to the prompt, so the task text itself only needs to say what to do.
- When a bug's cause is unknown, the first handoff changes nothing: tell the agent to find the cause, report it in a few lines and stop. Send the fix as a second handoff once you know the cause.
- When a large file needs reading, hand that to a free agent to summarize instead of reading it all yourself.
- Some work stays with you, never delegated: live database changes, bugs tangled across many parts of the code, and anything involving secrets or credentials.
- \`C wait --timeout 540\` (give your Bash tool a 600000 ms timeout for it; long waits save your limits): blocks until a job finishes and gives you the next one to review, oldest finish first. The agent runs the tests and build itself and reports in plain text what changed, the results and the files. Check the report against the goal; read the full diff yourself only when the change is risky or the report doesn't add up. Compare with any earlier job it lists under checkAgainst. Fix small problems yourself or send it back with a new delegate. Then \`C review ID accept|send-back --note "..."\`.
- \`C status\` shows \`practice: true\` during a dry run (the panel's Practice switch, on by default for now): plan and delegate exactly as usual — the tool logs each handoff's agent, reason and full prompt instead of launching it — but don't edit files yourself, and say in your report that it was a practice run.
- \`C note "..."\`: a short line in the owner's log for anything he should know.
- \`C queue --task "..." [--files a,b] [--agent ID]\`: while planning, keep a short queue of ready tasks for this project so free agents never sit idle. When you accept a job, the next queued task is handed to the same agent automatically. \`C queue\` lists what is pending, \`C queue rm ID\` drops one.
- \`C signals\`: recent "agent finished" notifications heard from the desktop. One matched to your job means check it; one for an agent with no job is the owner's own run — noted, never touched.
- \`C lesson "..."\`: add one short lesson to your lessons file — something you learned the hard way this goal (a skipped check, a surprise an agent caused, a rule that saved time). It is advice for your future goals, never a rule that overrides the ones above. Read your lessons before each goal; they are already in your first message.
Before you edit anything, run \`git status\`; commit only your own changes, never push or deploy. When the goal is done and every job is reviewed, finish with a short plain report for the owner: what was done, by whom, the commits, anything left open.`;

function startGoal() {
  const text = arg("--goal").trim(), fresh = arg("--new");
  if (!text) fail("Tell Constance a goal first.");
  let dir = path.resolve(arg("--dir") || ".");
  if (fresh) {   // "+ New project" in the folder step: made in ~/Projects with git set up, as Start and CS do
    if (fresh.includes("/") || fresh.startsWith(".")) fail("Use a plain folder name.");
    dir = path.join(process.env.SQUAD_PROJECTS || path.join(process.env.HOME, "Projects"), fresh);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      spawnSync("bash", ["-c", 'source "$1"; init_repo "$2"', "_", path.join(HERE, "folders.sh"), dir], { env: ENV });
    }
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail(`No such folder: ${dir}`);
  // Never the home folder itself (or anything above it): she and her agents run
  // with permission prompts skipped, so the project folder is their whole world.
  const home = path.resolve(process.env.HOME || "/");
  const real = fs.realpathSync(dir);
  if (real === home || real === "/" || home.startsWith(real.endsWith("/") ? real : real + "/")) fail("Pick a project folder first: Constance never works in your home folder itself.");
  const res = store.update((s) => {
    if (s.goal && ["running", "paused"].includes(s.goal.status)) return { busy: s.goal };
    s.goal = { id: randomUUID().slice(0, 8), text, dir, status: "running", session: randomUUID(), startedAt: Date.now(), started: false };
    s.jobs = s.jobs.filter((j) => j.status === "running");   // a fresh goal starts a fresh job list
    return s.goal;
  });
  if (res.busy) fail(`Constance is already on a goal: "${res.busy.text}". Stop it first.`);
  store.log({ kind: "goal", text: `${text} (in ${dir})` });
  spawnDriver();
  out(`Constance is on it: ${text}`);
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
    const ev = handleNotification(evt, { jobs: store.read().jobs, storeDir: store.dir });
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

async function drive() {
  let pausedLogged = false, failures = 0;
  for (;;) {
    const g = store.read().goal;
    if (!g || !["running", "paused"].includes(g.status)) return;
    const p = pace(claudeOf(freshData()));
    if (p.mode === "stop") {
      store.update((s) => { s.goal.status = "paused"; s.goal.pauseReason = p.reason; });
      if (!pausedLogged) { store.log({ kind: "paused", text: p.reason }); pausedLogged = true; }
      await sleep(60e3); continue;
    }
    if (g.status === "paused") { store.update((s) => { s.goal.status = "running"; delete s.goal.pauseReason; }); store.log({ kind: "resumed", text: "Back under her limits; picking the goal up again." }); pausedLogged = false; }
    // After a restart the previous Claude run may still be going: adopt it rather than start a second one.
    if (alive(g.brainPid, "claude")) {
      let killed = false;
      while (alive(g.brainPid, "claude")) {
        const st = store.read().goal;
        if (!st || st.status === "stopped") return;
        if (!killed && pace(claudeOf(readData())).mode === "stop") { killGroup(g.brainPid); killed = true; }
        await sleep(5000);
      }
      const st = store.read().goal;
      if (!st || st.status !== "running" || killed) continue;
    }
    const resume = g.started;
    // Fresh lessons and this project's own rules go into the first message of
    // every goal (advice only — her core rules above never change).
    const prompt = resume
      ? "You were interrupted (a restart, a pause for your limits, or an error). Run `C jobs` and `C wait` to see where things stand, then carry on with the goal."
      : `Goal from the owner: ${g.text}\nProject folder: ${g.dir}` + lessonsBlock(readLessons(store.dir)) + rulesBlock(readProjectRules(g.dir));
    const args = ["-p", "--model", g.model || "opus", "--dangerously-skip-permissions", "--output-format", "text", "--append-system-prompt", ROLE(g.dir),
      ...(resume ? ["--resume", g.session] : ["--session-id", g.session]), prompt];
    const reportPath = path.join(store.dir, `report-${g.id}.txt`);
    const fd = fs.openSync(reportPath, "w");
    const brain = spawn("claude", args, { cwd: g.dir, env: ENV, detached: true, stdio: ["ignore", fd, fd] });
    store.update((s) => { s.goal.started = true; s.goal.brainPid = brain.pid; });
    let pausedByUs = false;
    const watch = setInterval(() => {
      const st = store.read().goal;
      if (!st || st.status === "stopped") { killGroup(brain.pid); return; }
      if (pace(claudeOf(readData())).mode === "stop") { pausedByUs = true; killGroup(brain.pid); }
    }, 30e3);
    const code = await new Promise((r) => brain.on("exit", (c) => r(c)));
    clearInterval(watch);
    const now = store.read().goal;
    if (!now || now.status === "stopped") return;
    if (pausedByUs) continue;
    const report = (() => { try { return fs.readFileSync(reportPath, "utf8").trim(); } catch { return ""; } })();
    if (code === 0) {
      store.update((s) => { s.goal.status = "done"; s.goal.finishedAt = Date.now(); s.goal.report = report.slice(-4000); });
      store.log({ kind: "report", text: report.slice(-4000) || "(no report)" });
      return;
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
      return;
    }
    store.log({ kind: "note", text: `Claude exited with code ${code}; retrying in a minute.` });
    await sleep(60e3);
  }
}

function stopAll() {
  const s = store.update((s) => {
    if (s.goal && ["running", "paused"].includes(s.goal.status)) { s.goal.status = "stopped"; s.goal.finishedAt = Date.now(); }
    for (const j of s.jobs) if (j.status === "running" || j.status === "waiting") { if (alive(j.pid, LAUNCH[j.agent]?.cli || "")) killGroup(j.pid); j.status = "stopped"; }
    return JSON.parse(JSON.stringify(s));
  });
  const g = s.goal;
  if (g && alive(g.brainPid, "claude")) killGroup(g.brainPid);
  if (g && alive(g.driverPid, "constance.mjs")) killGroup(g.driverPid);
  if (isWatcher(watcherPid())) killGroup(watcherPid());
  store.log({ kind: "stopped", text: "Stop pressed: Constance and every job halted." });
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

function status() {
  const s = store.read(), d = readData();
  out({ goal: s.goal, jobs: s.jobs.map(({ prompt, guardBefore, ...j }) => j), agents: judgeAll(d), pace: pace(claudeOf(d)), practice: practiceMode(), guards: s.guards || {},
    queue: s.goal ? queueView(s.goal.dir, store.dir) : [], signals: recentSignals(store.dir, 10), log: store.readLog(80) });
}

const cmd = process.argv[2];
if (process.argv[1] === SELF) {
  if (cmd === "start") startGoal();
  else if (cmd === "drive") await drive();
  else if (cmd === "status") status();
  else if (cmd === "agents") {
    const d = freshData(), guards = store.read().guards || {};
    out(judgeAll(d).map((a) => `${a.available ? "AVAILABLE  " : "skip       "}${a.id.padEnd(12)} ${a.reason}${guards[a.id]?.strikes ? `  (guardrail strikes: ${guards[a.id].strikes} — smaller tasks only)` : ""}`).join("\n"));
  }
  else if (cmd === "pace") out(pace(claudeOf(freshData())));
  else if (cmd === "jobs") { sweep(); const s = store.read(); out({ goal: s.goal && { text: s.goal.text, dir: s.goal.dir, status: s.goal.status }, queue: s.goal ? queueView(s.goal.dir, store.dir) : [], jobs: s.jobs.map(({ prompt, guardBefore, ...j }) => j) }); }
  else if (cmd === "queue") queueCmd();
  else if (cmd === "signals") out(recentSignals(store.dir, 20));
  else if (cmd === "watch") await watch();
  else if (cmd === "delegate") delegate();
  else if (cmd === "wait") await waitJob();
  else if (cmd === "review") review();
  else if (cmd === "note") { store.log({ kind: "note", text: process.argv.slice(3).join(" ") }); out("noted"); }
  else if (cmd === "lesson") {
    const text = process.argv.slice(3).join(" ").trim();
    if (!text) fail("Usage: lesson TEXT");
    addLesson(text, store.dir);
    store.log({ kind: "lesson", text });
    out("lesson added");
  }
  else if (cmd === "stop") stopAll();
  else if (cmd === "recover") recover();
  else fail("Usage: constance.mjs start|status|agents|pace|jobs|delegate|wait|review|note|lesson|queue|signals|watch|stop|recover");
}
