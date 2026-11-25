// Constance's backlog refill: when a project's ready-task queue runs low and
// free agent slots exist, turn open backlog items into tasks to queue. Only
// kinds test, docs, task and bug are handed out this way, in that order —
// review and design stay for planning. An item is skipped when its 'files:'
// tag touches a busy file or a file an earlier pick already claimed, or when
// it is done or already tagged with a job. Nothing is invented: with no
// suitable items the answer is an empty list and the reason says so.
import { readBacklog } from "./constance-backlog.mjs";

export const REFILL_KINDS = ["test", "docs", "task", "bug"];

// backlog may be an array of parsed items (constance-backlog's shape) or a
// project directory to read .constance/backlog.md from; omitted means
// projectDir. Returns { tasks, reason }: tasks are at most freeSlots entries
// of { task, files, kind, backlogId }; reason is null on success and a short
// explanation when nothing was (or could be) queued.
export function refill(projectDir, { queueLen = 0, freeSlots = 0, low = 3, backlog, busyFiles = [] } = {}) {
  if (!(Number(queueLen) < low)) return { tasks: [], reason: "the queue is not low" };
  if (!(Number(freeSlots) > 0)) return { tasks: [], reason: "no free slots" };
  const items = Array.isArray(backlog) ? backlog : readBacklog(backlog || projectDir);
  const busy = new Set((busyFiles || []).filter(Boolean));
  const claimed = new Set();
  const tasks = [];
  for (const kind of REFILL_KINDS) {
    for (const item of items) {
      if (tasks.length >= freeSlots) break;
      if (!item || item.kind !== kind || item.done || item.job) continue;
      const files = (item.files || []).filter(Boolean);
      if (files.some((f) => busy.has(f) || claimed.has(f))) continue;
      for (const f of files) claimed.add(f);
      tasks.push({ task: String(item.text || "").trim(), files, kind, backlogId: item.id });
    }
    if (tasks.length >= freeSlots) break;
  }
  return tasks.length ? { tasks, reason: null } : { tasks, reason: "nothing worthwhile" };
}
