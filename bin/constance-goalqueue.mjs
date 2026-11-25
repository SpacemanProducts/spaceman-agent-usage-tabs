// Constance's goal queue: goals the owner lined up, each with its own folder. When a goal ends well
// she starts the next one by herself (her pacing still gates it: the driver pauses a goal at her
// limits before running it). When a goal ends with a problem that needs the owner, the queue stops
// and says why instead of moving on; it stays stopped until the owner starts the next goal.
//
// goal-queue.json in her state dir: { goals: [{ id, text, dir, addedAt }], paused: "" | "why" }.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { checklist } from "./constance-checklist.mjs";

const fileOf = (dir) => path.join(dir, "goal-queue.json");
const lockOf = (dir) => fileOf(dir) + ".lock";

export function readGoalQueue(dir) {
  try {
    const d = JSON.parse(fs.readFileSync(fileOf(dir), "utf8"));
    return { goals: Array.isArray(d.goals) ? d.goals.filter((g) => g && g.text && g.dir) : [], paused: String(d.paused || "") };
  } catch { return { goals: [], paused: "" }; }
}

// change() is read-modify-write across processes (the driver, the panel's C commands,
// goal-queue edits), so it runs under a small lock file next to goal-queue.json: an
// O_EXCL create holding this pid, a short poll while a live holder finishes, and a
// stale break only when the recorded pid is dead. An empty lock file gets the same
// grace mergelock gives an ownerless dir — the pid write lands a tick after the create.
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pidAlive = (pid) => {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};
const LOCK_STALE_MS = 30000;
const lockStale = (file, now = Date.now()) => {
  let pid = 0, mtime = 0;
  try {
    pid = Number(fs.readFileSync(file, "utf8").trim()) || 0;
    mtime = fs.statSync(file).mtimeMs;
  } catch { return true; } // unreadable/gone: safe to break
  if (pid > 0) return !pidAlive(pid);
  return now - mtime > LOCK_STALE_MS;
};
function withQueueLock(dir, fn, { waitMs = 10000, pollMs = 25 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = lockOf(dir), until = Date.now() + waitMs;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lock, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (e) {
      try { if (fd !== undefined) fs.closeSync(fd); } catch {}
      if (e.code !== "EEXIST") throw e;
      if (lockStale(lock)) { try { fs.rmSync(lock, { force: true }); } catch {} continue; }
      if (Date.now() > until) throw new Error("another queue change is still running");
      sleepSync(pollMs);
    }
  }
  try { return fn(); } finally {
    try {
      if (Number(fs.readFileSync(lock, "utf8").trim()) === process.pid) fs.rmSync(lock, { force: true });
    } catch {}
  }
}

function save(dir, q) {
  fs.mkdirSync(dir, { recursive: true });
  const f = fileOf(dir), tmp = f + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(q, null, 2) + "\n");
  try {
    fs.renameSync(tmp, f);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
  return q;
}
const change = (dir, fn) => withQueueLock(dir, () => { const q = readGoalQueue(dir); const r = fn(q); save(dir, q); return r; });

export function addGoal(dir, { text, dir: folder }, now = Date.now()) {
  const t = String(text || "").trim();
  if (!t) throw new Error("Tell Constance a goal first.");
  if (!folder) throw new Error("A queued goal needs a folder.");
  return change(dir, (q) => { const g = { id: randomUUID().slice(0, 8), text: t, dir: folder, addedAt: now }; q.goals.push(g); return g; });
}

export function removeGoal(dir, id) {
  return change(dir, (q) => { const i = q.goals.findIndex((g) => g.id === id); if (i < 0) throw new Error(`No queued goal ${id}.`); return q.goals.splice(i, 1)[0]; });
}

export function editGoal(dir, id, { text, dir: folder } = {}) {
  return change(dir, (q) => {
    const g = q.goals.find((x) => x.id === id);
    if (!g) throw new Error(`No queued goal ${id}.`);
    if (text !== undefined && text !== null) { const t = String(text).trim(); if (!t) throw new Error("A goal can't be empty."); g.text = t; }
    if (folder) g.dir = folder;
    return g;
  });
}

// "up" / "down" / "top" or a 0-based index.
export function moveGoal(dir, id, to) {
  return change(dir, (q) => {
    const i = q.goals.findIndex((g) => g.id === id);
    if (i < 0) throw new Error(`No queued goal ${id}.`);
    const n = q.goals.length;
    let j = to === "up" ? i - 1 : to === "down" ? i + 1 : to === "top" ? 0
      : typeof to === "number" || (typeof to === "string" && to.trim() !== "") ? Number(to) : NaN;
    if (!Number.isInteger(j)) throw new Error("Move it up, down, top or to a position.");
    j = Math.max(0, Math.min(n - 1, j));
    const [g] = q.goals.splice(i, 1); q.goals.splice(j, 0, g);
    return q.goals.map((x) => x.id);
  });
}

// Take the first goal off the queue (null when empty or stopped for the owner, unless `force`).
export function takeNext(dir, { force = false } = {}) {
  return change(dir, (q) => {
    if (q.paused && !force) return null;
    q.paused = "";
    return q.goals.shift() || null;
  });
}

export function pauseQueue(dir, why) { return change(dir, (q) => { q.paused = String(why || "stopped"); return q.paused; }); }
export function resumeQueue(dir) { return change(dir, (q) => { q.paused = ""; return true; }); }

// Why a finished goal needs the owner before the queue moves on ([] = it doesn't). `practice`
// skips the checklist check: a practice run merges nothing, so nothing ever ticks.
export function needsOwner(goal, jobs = [], { practice = false } = {}) {
  if (!goal) return [];
  const why = [];
  if (goal.status === "failed") why.push("she couldn't finish the goal");
  if (goal.status === "stopped") why.push("you stopped her");
  if (goal.needsOwner) why.push(String(goal.needsOwner));
  const mine = jobs.filter((j) => j.goal === goal.id);
  const ids = (f) => mine.filter(f).map((j) => j.id);
  const conflict = ids((j) => j.status === "conflict");
  if (conflict.length) why.push(`job${conflict.length > 1 ? "s" : ""} ${conflict.join(", ")} hit a merge conflict`);
  const unreviewed = ids((j) => j.status === "finished" && !String(j.summary || "").startsWith("(practice run"));
  if (unreviewed.length) why.push(`job${unreviewed.length > 1 ? "s" : ""} ${unreviewed.join(", ")} never got reviewed`);
  const open = ids((j) => ["running", "waiting", "held"].includes(j.status));
  if (open.length) why.push(`job${open.length > 1 ? "s" : ""} ${open.join(", ")} still running`);
  if (!practice && goal.status === "done") {
    const list = checklist(goal, jobs);
    const left = list.items.filter((x) => x.state !== "done").map((x) => x.n);
    if (list.total > 1 && left.length) why.push(`item${left.length > 1 ? "s" : ""} ${left.join(", ")} of the checklist not done`);
  }
  return why;
}

// What a finished goal does to the queue, split by who has to act: `stop` is only for things that
// truly need the owner (the queue pauses and says why); `notes` are the rest, worth logging but not
// worth stopping the queue for. Same rules and wording as needsOwner(), plus merged jobs (they wait
// for her background review) which needsOwner never sees because its caller maps them to accepted.
export function queueStops(goal, jobs = [], { practice = false } = {}) {
  if (!goal) return { stop: [], notes: [] };
  const stop = [], notes = [];
  if (goal.status === "stopped") stop.push("you stopped her");
  if (goal.needsOwner) stop.push(String(goal.needsOwner));
  const mine = jobs.filter((j) => j.goal === goal.id);
  const ids = (f) => mine.filter(f).map((j) => j.id);
  const many = (n) => (n > 1 ? "s" : "");
  const conflict = ids((j) => j.status === "conflict");
  if (conflict.length) stop.push(`job${many(conflict.length)} ${conflict.join(", ")} hit a merge conflict`);
  if (goal.status === "failed") {
    const why = "she couldn't finish the goal";
    notes.push(typeof goal.failReason === "string" && goal.failReason.length ? `${why}: ${goal.failReason}` : why);
  }
  const unreviewed = ids((j) => j.status === "finished" && !String(j.summary || "").startsWith("(practice run"));
  if (unreviewed.length) notes.push(`job${many(unreviewed.length)} ${unreviewed.join(", ")} never got reviewed`);
  const open = ids((j) => ["running", "waiting", "held"].includes(j.status));
  if (open.length) notes.push(`job${many(open.length)} ${open.join(", ")} still running`);
  const merged = ids((j) => j.status === "merged");
  if (merged.length) notes.push(`job${many(merged.length)} ${merged.join(", ")} merged and still waiting for review`);
  if (!practice && goal.status === "done") {
    // Merged jobs already landed in the repo: count them as accepted for the checklist, the way
    // afterGoal() hands needsOwner() asAccepted(s.jobs).
    const forChecklist = jobs.map((j) => (j.status === "merged" ? { ...j, status: "accepted" } : j));
    const list = checklist(goal, forChecklist);
    const left = list.items.filter((x) => x.state !== "done").map((x) => x.n);
    if (list.total > 1 && left.length) notes.push(`item${many(left.length)} ${left.join(", ")} of the checklist not done`);
  }
  return { stop, notes };
}
