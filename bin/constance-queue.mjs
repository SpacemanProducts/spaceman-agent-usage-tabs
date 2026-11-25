// Constance's ready-task queue: a short list of well-defined next tasks per
// project, kept in her state folder (queue.json, outside any repo). She fills
// it while planning a goal; when a job finishes and passes review, the next
// queued task for that project is handed to the same agent automatically.
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./constance-jobs.mjs";

export function queueFile(dir = stateDir()) {
  return path.join(dir, "queue.json");
}

function readAll(dir = stateDir()) {
  try {
    const d = JSON.parse(fs.readFileSync(queueFile(dir), "utf8"));
    return { next: Number(d.next) || 1, projects: d.projects && typeof d.projects === "object" ? d.projects : {} };
  } catch { return { next: 1, projects: {} }; }
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

// Add a ready task for a project. agent is optional: empty means "whoever
// finishes the current job". Returns the stored task.
export function addTask(projectDir, { task, files = [], agent = "", items = [], title = "" }, dir = stateDir()) {
  const text = String(task || "").trim();
  if (!text) throw new Error("queue needs a task");
  return withLock(dir, () => {
    const data = readAll(dir);
    const list = projectList(data, projectDir) || (data.projects[projectDir] = []);
    const item = { id: data.next++, task: text, files: files.filter(Boolean), agent: String(agent || ""), status: "pending", createdAt: Date.now(),
      ...(items.length ? { items } : {}), ...(title ? { title: String(title) } : {}) };
    list.push(item);
    writeAll(dir, data);
    return item;
  });
}

export function pendingTasks(projectDir, dir = stateDir()) {
  return (projectList(readAll(dir), projectDir) || []).filter((t) => t.status === "pending");
}

// Pending tasks that can start right now, oldest first: a task is skipped when
// any of its files is in busyFiles or is already claimed by an earlier picked
// task (two picked tasks never share a file). Tasks with no files are read-only
// and always eligible. At most `limit` tasks.
export function readyTasks(projectDir, { busyFiles = [], limit = Infinity } = {}, dir = stateDir()) {
  const busy = new Set(busyFiles.filter(Boolean));
  const claimed = new Set();
  const ready = [];
  for (const t of pendingTasks(projectDir, dir)) {
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
export function peekNext(projectDir, dir = stateDir()) {
  return pendingTasks(projectDir, dir)[0] || null;
}

export function finishTask(projectDir, taskId, jobId, dir = stateDir()) {
  const data = readAll(dir);
  const t = (projectList(data, projectDir) || []).find((x) => x.id === taskId);
  if (t) { t.status = "handed"; t.jobId = jobId; t.handedAt = Date.now(); }
  writeAll(dir, data);
}

export function removeTask(projectDir, taskId, dir = stateDir()) {
  return withLock(dir, () => {
    const data = readAll(dir);
    const list = projectList(data, projectDir);
    if (!list) return false;
    const i = list.findIndex((x) => x.id === taskId);
    if (i < 0) return false;
    list.splice(i, 1);
    if (!list.length) delete data.projects[projectDir];
    writeAll(dir, data);
    return true;
  });
}

// What the panel and `C queue` show: pending tasks for one project, oldest first.
export function queueView(projectDir, dir = stateDir()) {
  return pendingTasks(projectDir, dir).map((t) => ({ id: t.id, task: t.task, files: t.files || [], agent: t.agent || "" }));
}
