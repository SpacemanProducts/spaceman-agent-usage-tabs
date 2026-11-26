// Constance's ready-task queue: a short list of well-defined next tasks per
// project, kept in her state folder (queue.json, outside any repo). She fills
// it while planning a goal; when a job finishes and passes review, the next
// queued task for that project is handed to the same agent automatically.
// Every task belongs to the goal it was queued in (`goal`): it is only ever
// handed out, shown or counted while that goal runs. A task left pending when
// its goal ends never leaks into the next goal on the same project (its item
// numbers would tick the wrong checklist, and its finished job would start
// review steps that goal never asked for); expireTasks() retires it.
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./constance-jobs.mjs";

export function queueFile(dir = stateDir()) {
  return path.join(dir, "queue.json");
}

function readAll(dir = stateDir()) {
  try {
    const d = JSON.parse(fs.readFileSync(queueFile(dir), "utf8"));
    const raw = d && typeof d === "object" && d.projects && typeof d.projects === "object" ? d.projects : {};
    // Null prototype: keys like "__proto__" or "constructor" become own
    // properties instead of hitting Object.prototype setters/getters.
    const projects = Object.assign(Object.create(null), raw);
    // next must be a positive integer; anything else (negative, fractional,
    // zero, non-numeric) is recomputed as max stored id + 1 so bad ids never
    // flow into new tasks.
    let next = Number(d && typeof d === "object" ? d.next : NaN);
    if (!Number.isInteger(next) || next < 1) {
      next = 1;
      for (const list of Object.values(projects)) {
        if (!Array.isArray(list)) continue;
        for (const t of list) {
          if (t && typeof t === "object" && Number.isInteger(t.id) && t.id >= next) next = t.id + 1;
        }
      }
    }
    return { next, projects };
  } catch { return { next: 1, projects: Object.create(null) }; }
}

function writeAll(dir, data) {
  fs.mkdirSync(path.dirname(queueFile(dir)), { recursive: true });
  const tmp = queueFile(dir) + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, queueFile(dir));
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// addTask/removeTask are read-modify-write: serialize them with a lock file
// next to queue.json so two writers can't lose each other's update. The lock
// is an O_EXCL create with a short retry loop; one older than 10 s is stale.
function withLock(dir, fn) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = queueFile(dir) + ".lock";
  for (let i = 0; ; i++) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: "wx" }); break; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.unlinkSync(lock); continue; } } catch {}
      if (i > 200) throw new Error("queue file is locked");
      sleepSync(25);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lock); } catch {} }
}

// projects[dir] may hold a non-array (hand edit, older version, partial
// write): treat it as an empty list everywhere.
function projectList(data, projectDir) {
  const list = data.projects[projectDir];
  return Array.isArray(list) ? list : null;
}

// Entries inside the list may themselves be non-objects (null, number, string
// from a hand edit or torn write): every reader skips them instead of crashing
// on t.status/t.id.
const isTask = (t) => t !== null && typeof t === "object";

// Add a ready task for a project. agent is optional: empty means "whoever
// finishes the current job". Returns the stored task.
export function addTask(projectDir, { task, files = [], agent = "", items = [], title = "", goal = "" }, dir = stateDir()) {
  const text = String(task || "").trim();
  if (!text) throw new Error("queue needs a task");
  return withLock(dir, () => {
    const data = readAll(dir);
    const list = projectList(data, projectDir) || (data.projects[projectDir] = []);
    const item = { id: data.next++, task: text, files: files.filter(Boolean), agent: String(agent || ""), status: "pending", createdAt: Date.now(),
      ...(goal ? { goal: String(goal) } : {}), ...(items.length ? { items } : {}), ...(title ? { title: String(title) } : {}) };
    list.push(item);
    writeAll(dir, data);
    return item;
  });
}

// With `goal`, only that goal's tasks (an untagged task belongs to no goal).
const ofGoal = (t, goal) => goal === undefined || (typeof goal === "string" && goal !== "" && t.goal === goal);

export function pendingTasks(projectDir, dir = stateDir(), goal = undefined) {
  return (projectList(readAll(dir), projectDir) || []).filter((t) => isTask(t) && t.status === "pending" && ofGoal(t, goal));
}

// Retire every pending task of this project that doesn't belong to `goal`
// (the running goal): status "expired". Returns the expired tasks.
export function expireTasks(projectDir, goal, dir = stateDir()) {
  if (typeof goal !== "string" || !goal) return [];
  if (!(projectList(readAll(dir), projectDir) || []).some((t) => isTask(t) && t.status === "pending" && t.goal !== goal)) return [];
  return withLock(dir, () => {
    const data = readAll(dir);
    const gone = [];
    for (const t of projectList(data, projectDir) || []) {
      if (isTask(t) && t.status === "pending" && t.goal !== goal) { t.status = "expired"; t.expiredAt = Date.now(); gone.push(t); }
    }
    if (gone.length) writeAll(dir, data);
    return gone;
  });
}

// Pending tasks that can start right now, oldest first: a task is skipped when
// any of its files is in busyFiles or is already claimed by an earlier picked
// task (two picked tasks never share a file). Tasks with no files are read-only
// and always eligible. At most `limit` tasks.
export function readyTasks(projectDir, { busyFiles = [], limit = Infinity, goal = undefined } = {}, dir = stateDir()) {
  const busy = new Set(busyFiles.filter(Boolean));
  const claimed = new Set();
  const ready = [];
  for (const t of pendingTasks(projectDir, dir, goal)) {
    if (ready.length >= limit) break;
    const files = (t.files || []).filter(Boolean);
    if (files.some((f) => busy.has(f) || claimed.has(f))) continue;
    for (const f of files) claimed.add(f);
    ready.push(t);
  }
  return ready;
}

// The next task to hand out, or null. Does not remove it — call finishTask or
// failTask after the handoff is attempted.
export function peekNext(projectDir, dir = stateDir(), goal = undefined) {
  return pendingTasks(projectDir, dir, goal)[0] || null;
}

export function finishTask(projectDir, taskId, jobId, dir = stateDir()) {
  return withLock(dir, () => {
    const data = readAll(dir);
    const t = (projectList(data, projectDir) || []).find((x) => isTask(x) && x.id === taskId);
    if (t) { t.status = "handed"; t.jobId = jobId; t.handedAt = Date.now(); }
    writeAll(dir, data);
  });
}

export function removeTask(projectDir, taskId, dir = stateDir()) {
  return withLock(dir, () => {
    const data = readAll(dir);
    const list = projectList(data, projectDir);
    if (!list) return false;
    const i = list.findIndex((x) => isTask(x) && x.id === taskId);
    if (i < 0) return false;
    list.splice(i, 1);
    if (!list.length) delete data.projects[projectDir];
    writeAll(dir, data);
    return true;
  });
}

// What the panel and `C queue` show: pending tasks for one project, oldest first.
export function queueView(projectDir, dir = stateDir(), goal = undefined) {
  return pendingTasks(projectDir, dir, goal).map((t) => ({ id: t.id, task: t.task, files: t.files || [], agent: t.agent || "" }));
}
