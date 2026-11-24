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

export function readGoalQueue(dir) {
  try {
    const d = JSON.parse(fs.readFileSync(fileOf(dir), "utf8"));
    return { goals: Array.isArray(d.goals) ? d.goals.filter((g) => g && g.text && g.dir) : [], paused: String(d.paused || "") };
  } catch { return { goals: [], paused: "" }; }
}

function save(dir, q) {
  fs.mkdirSync(dir, { recursive: true });
  const f = fileOf(dir), tmp = f + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(q, null, 2) + "\n");
  fs.renameSync(tmp, f);
  return q;
}
const change = (dir, fn) => { const q = readGoalQueue(dir); const r = fn(q); save(dir, q); return r; };

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
    if (text !== undefined) { const t = String(text).trim(); if (!t) throw new Error("A goal can't be empty."); g.text = t; }
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
    let j = to === "up" ? i - 1 : to === "down" ? i + 1 : to === "top" ? 0 : Number(to);
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
