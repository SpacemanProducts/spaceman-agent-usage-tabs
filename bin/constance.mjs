#!/usr/bin/env node
// Constance, the quarterback. The owner gives her a goal in the panel (the C button); she runs as Claude Code
// on the paid plan (Opus), plans, hands routine pieces to free agents that are under their limits, reviews
// everything that comes back, and reports. This file is both the panel's entry point and the toolbox she
// calls from her own shell:
//
//   start --dir D --goal TEXT   new goal (refused while one is active); starts the driver in the background
//   status                      JSON for the panel: goal, jobs, agents, pace, log
//   agents | pace | jobs        what she reads before every handoff
//   delegate --agent ID --files a,b --task TEXT   hand one task to one free agent (re-checks it first)
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
import { judgeAll, launchCommand, LAUNCH } from "./constance-agents.mjs";
import { pace } from "./constance-pace.mjs";
import { openStore, conflicts, handoffPrompt, doneFile, reviewQueue, overlaps } from "./constance-jobs.mjs";

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

// ---------------------------------------------------------------- jobs
// Bring statuses up to date: a done file means finished; a process that ended without one is finished too
// (with a note), so it still gets reviewed.
function sweep() {
  return store.update((s) => {
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

function delegate() {
  const agent = arg("--agent"), task = arg("--task"), files = arg("--files").split(",").map((x) => x.trim()).filter(Boolean);
  const g = store.read().goal;
  if (!g || g.status !== "running") fail("No goal is running (stopped or paused), so nothing is handed out.");
  if (!agent || !task || files.length === 0) fail("Usage: delegate --agent ID --files a,b --task TEXT");
  const verdict = judgeAll(freshData()).find((a) => a.id === agent);
  if (!verdict?.available) fail(`${agent} is not available: ${verdict ? verdict.reason : "unknown agent"}. Run \`agents\` and pick another, or do it yourself.`);
  const dir = g.dir;
  const job = store.update((s) => {
    const busy = conflicts(s.jobs, dir, files);
    if (busy.length) return { busy };
    const j = { id: s.next++, goal: g.id, agent, dir, files, task, status: "waiting", createdAt: Date.now() };
    j.prompt = handoffPrompt(j);
    s.jobs.push(j);
    return j;
  });
  if (job.busy) fail(`Those files overlap job ${job.busy.map((b) => `${b.id} (${b.agent}: ${b.files.join(", ")})`).join("; ")}. Wait for it, or split the work differently.`);
  excludeDoneFiles(dir);
  fs.mkdirSync(path.join(dir, ".constance"), { recursive: true });
  try { fs.rmSync(doneFile(dir, job.id)); } catch {}
  const logPath = path.join(store.dir, `job-${job.id}.log`);
  const fd = fs.openSync(logPath, "w");
  const [cmd, ...args] = launchCommand(agent, job.prompt);
  const child = spawn(cmd, args, { cwd: dir, env: ENV, detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  store.update((s) => { const j = s.jobs.find((x) => x.id === job.id); j.status = "running"; j.pid = child.pid; j.startedAt = Date.now(); j.log = logPath; });
  store.log({ kind: "handoff", job: job.id, agent, files, text: task });
  out(`Job ${job.id} handed to ${verdict.name} (${verdict.reason}). It writes ${doneFile(dir, job.id)} when done; run \`wait\`.`);
}

async function waitJob() {
  const until = Date.now() + Math.min(560, Number(arg("--timeout", "100")) || 100) * 1000;
  for (;;) {
    for (const j of sweep()) store.log({ kind: "returned", job: j.id, agent: j.agent, text: j.summary + (j.commit ? ` (commit ${j.commit.slice(0, 9)})` : "") });
    const s = store.read();
    const next = reviewQueue(s.jobs)[0];
    if (next) {
      const files = changedFiles(next.dir, next.commit);
      // Earlier finished or accepted jobs in this goal that changed the same files: check against them first.
      const earlier = s.jobs.filter((j) => j.id !== next.id && j.goal === next.goal && ["finished", "accepted"].includes(j.status) && (j.finishedAt || 0) <= (next.finishedAt || 0))
        .map((j) => ({ id: j.id, agent: j.agent, commit: j.commit, shared: overlaps(changedFiles(j.dir, j.commit), files) })).filter((x) => x.shared.length);
      let tail = ""; try { tail = fs.readFileSync(next.log, "utf8").slice(-2500); } catch {}
      return out({ review: { id: next.id, agent: next.agent, dir: next.dir, files: next.files, task: next.task, summary: next.summary, commit: next.commit, changedFiles: files,
        checkAgainst: earlier, logTail: tail }, stillRunning: s.jobs.filter((j) => j.status === "running").map((j) => ({ id: j.id, agent: j.agent })),
        next: "Review it now: read the diff, run the tests and build, fix or send back. Then `review " + next.id + " accept|send-back --note ...`." });
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
  out(`Job ${id} ${j.status}.`);
}

// ---------------------------------------------------------------- the goal and the driver
const ROLE = (dir) => `You are Constance, the quarterback of the owner's coding agents. You run on the owner's one paid plan (Claude). You plan, delegate, review and still play yourself when the work is hard or risky. You have full authority: never stop to ask permission.

Your toolbox is \`node ${SELF} <command>\` (call it C below). Work only in ${dir}.
- \`C pace\`: your own session/weekly pacing. Obey its mode. "normal": keep hard, risky or architectural work, delegate routine well-defined low-risk pieces. "delegate": you are burning your limits too fast, so delegate editing and testing too and keep only planning and review. You never run out of your own limits; the driver pauses you at 90% and resumes after the reset.
- \`C agents\`: who is available right now (under their limits, signed in, readable, free). Re-check right before every handoff; availability changes as limits reset. No agent is the default: spread work over whoever has spare capacity. Never use an agent that isn't listed as available, and never anything that costs money.
- \`C delegate --agent ID --files a,b --task "..."\`: hand off one well-defined piece. List every file it may edit; two jobs may never share files, and you must not edit a running job's files yourself. The tool adds the folder check, git rules and done file to the prompt.
- \`C wait --timeout 540\` (give your Bash tool a 600000 ms timeout for it; long waits save your limits): blocks until a job finishes and gives you the next one to review, oldest finish first. Review each fully before it counts: read the diff, run the tests and the build, compare with any earlier job it lists under checkAgainst. Fix small problems yourself or send it back with a new delegate. Then \`C review ID accept|send-back --note "..."\`.
- \`C note "..."\`: a short line in the owner's log for anything he should know.
Before you edit anything, run \`git status\`; commit only your own changes, never push. When the goal is done and every job is reviewed, finish with a short plain report for the owner: what was done, by whom, the commits, anything left open.`;

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
    const prompt = resume
      ? "You were interrupted (a restart, a pause for your limits, or an error). Run `C jobs` and `C wait` to see where things stand, then carry on with the goal."
      : `Goal from the owner: ${g.text}\nProject folder: ${g.dir}`;
    const args = ["-p", "--model", "opus", "--dangerously-skip-permissions", "--output-format", "text", "--append-system-prompt", ROLE(g.dir),
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
  out({ goal: s.goal, jobs: s.jobs.map(({ prompt, ...j }) => j), agents: judgeAll(d), pace: pace(claudeOf(d)), log: store.readLog(80) });
}

const cmd = process.argv[2];
if (process.argv[1] === SELF) {
  if (cmd === "start") startGoal();
  else if (cmd === "drive") await drive();
  else if (cmd === "status") status();
  else if (cmd === "agents") { const d = freshData(); out(judgeAll(d).map((a) => `${a.available ? "AVAILABLE  " : "skip       "}${a.id.padEnd(12)} ${a.reason}`).join("\n")); }
  else if (cmd === "pace") out(pace(claudeOf(freshData())));
  else if (cmd === "jobs") { sweep(); const s = store.read(); out({ goal: s.goal && { text: s.goal.text, dir: s.goal.dir, status: s.goal.status }, jobs: s.jobs.map(({ prompt, ...j }) => j) }); }
  else if (cmd === "delegate") delegate();
  else if (cmd === "wait") await waitJob();
  else if (cmd === "review") review();
  else if (cmd === "note") { store.log({ kind: "note", text: process.argv.slice(3).join(" ") }); out("noted"); }
  else if (cmd === "stop") stopAll();
  else if (cmd === "recover") recover();
  else fail("Usage: constance.mjs start|status|agents|pace|jobs|delegate|wait|review|note|stop|recover");
}
