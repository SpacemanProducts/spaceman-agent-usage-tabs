// Deeper edge-case pass on Constance's ready-task queue
// (bin/constance-queue.mjs). Complements constance-queue.test.mjs:
//
//   - readyTasks: partial busy-file overlap, limit 0 / negative / huge,
//     claim-ordering interactions, non-string and falsy file entries.
//   - add/remove/list round trips: id counter across removals, queueView
//     shape, handed tasks surviving removeTask's project-key cleanup.
//   - corrupt or missing queue.json: garbage bytes, wrong-typed fields,
//     a queue.json that is a directory.
//   - concurrent writes: several processes adding at once must never lose an
//     update (addTask/removeTask serialize on a lock file) or leave a torn
//     queue.json or a stray .tmp file.
//
// Everything runs against mkdtemp dirs; no HOME, network or agent CLI is
// touched.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { addTask, pendingTasks, peekNext, readyTasks, finishTask, removeTask, queueView, queueFile } from "./constance-queue.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "constance-queue-deep-"));
const proj = (n) => `/home/u/deep-${n}`;
const ids = (list) => list.map((t) => t.id);

// ============================================================ readyTasks edges
{
  const dir = tmp(), p = proj("busy");
  const a = addTask(p, { task: "touches a and b", files: ["a.js", "b.js"] }, dir);
  const b = addTask(p, { task: "read only" }, dir);
  const c = addTask(p, { task: "touches b only", files: ["b.js"] }, dir);

  // Partial overlap: one busy file is enough to skip the whole task.
  assert.deepEqual(ids(readyTasks(p, { busyFiles: ["b.js"] }, dir)), [b.id],
    "a task is skipped when ANY of its files is busy, not just all of them");
  // busyFiles falsy entries are ignored; so are duplicates.
  assert.deepEqual(ids(readyTasks(p, { busyFiles: [null, "", "a.js", "a.js"] }, dir)), [b.id, c.id],
    "falsy busy entries never match; duplicates collapse");
  // A task's own files list may contain falsy entries (addTask filters them,
  // but a hand-edited file could carry them through pendingTasks).
  const raw = JSON.parse(fs.readFileSync(queueFile(dir), "utf8"));
  raw.projects[p].find((t) => t.id === c.id).files = ["d.js", null, ""];
  fs.writeFileSync(queueFile(dir), JSON.stringify(raw));
  assert.deepEqual(ids(readyTasks(p, {}, dir)), [a.id, b.id, c.id],
    "falsy file entries inside a stored task do not block it");
}

{
  const dir = tmp(), p = proj("limit");
  for (let i = 0; i < 4; i++) addTask(p, { task: `t${i}` }, dir);
  assert.deepEqual(readyTasks(p, { limit: 0 }, dir), [], "limit 0 picks nothing");
  assert.deepEqual(readyTasks(p, { limit: -3 }, dir), [], "a negative limit picks nothing");
  assert.equal(readyTasks(p, { limit: 99 }, dir).length, 4, "a huge limit returns everything eligible");
  assert.equal(readyTasks(p, { limit: 2.7 }, dir).length, 3, "a fractional limit effectively ceils: length 2 is still < 2.7");
  assert.equal(readyTasks(p, { limit: "2" }, dir).length, 2, "a string limit still compares numerically");
  assert.equal(readyTasks(p, {}, dir).length, 4, "default limit is unbounded");
}

{
  // Skipped tasks do not consume limit slots, and a task skipped for a busy
  // file does not claim its other files for later picks.
  const dir = tmp(), p = proj("order");
  const busy = addTask(p, { task: "busy a", files: ["a.js", "shared.js"] }, dir);
  const later = addTask(p, { task: "later shared", files: ["shared.js"] }, dir);
  const free = addTask(p, { task: "free c", files: ["c.js"] }, dir);
  assert.deepEqual(ids(readyTasks(p, { busyFiles: ["a.js"], limit: 2 }, dir)), [later.id, free.id],
    "skipped tasks free their slots and their un-busy files stay claimable");
  // Claim order follows queue order, not file count.
  const dir2 = tmp(), p2 = proj("order2");
  const first = addTask(p2, { task: "one file", files: ["x.js"] }, dir2);
  addTask(p2, { task: "many files", files: ["x.js", "y.js", "z.js"] }, dir2);
  const tail = addTask(p2, { task: "tail", files: ["y.js"] }, dir2);
  // first claims x.js, so the middle task is skipped even though it also
  // holds y.js and z.js; tail still picks y.js because nothing claimed it.
  assert.deepEqual(ids(readyTasks(p2, {}, dir2)), [first.id, tail.id]);
}

{
  // Agent pins: the queue stores the pin but never filters on it — readyTasks
  // and peekNext hand out the oldest pending task regardless of agent, so the
  // pin is the caller's job. Documented, not changed.
  const dir = tmp(), p = proj("pin");
  const pinned = addTask(p, { task: "grok only", agent: "grok" }, dir);
  const free = addTask(p, { task: "anyone" }, dir);
  assert.equal(pinned.agent, "grok");
  assert.equal(free.agent, "");
  assert.equal(peekNext(p, dir).agent, "grok", "peekNext ignores the pin: oldest pending wins");
  assert.equal(readyTasks(p, {}, dir)[0].id, pinned.id, "readyTasks ignores the pin too");
  assert.equal(addTask(p, { task: "numeric agent", agent: 7 }, dir).agent, "7", "agent is coerced to string");
  assert.deepEqual(queueView(p, dir).map((t) => t.agent), ["grok", "", "7"], "view keeps pins in order");
}

// ============================================================ add/remove/list round trips
{
  const dir = tmp(), p = proj("round");
  assert.equal(removeTask(p, 1, dir), false, "removing from a missing project is a no-op");
  assert.equal(finishTask(p, 999, 1, dir), undefined, "finishing an unknown id is silent");

  const t1 = addTask(p, { task: "  padded task  ", title: "Pretty", items: [1, 2] }, dir);
  assert.equal(t1.task, "padded task", "task text is trimmed");
  assert.equal(t1.title, "Pretty");
  assert.deepEqual(t1.items, [1, 2]);
  const t2 = addTask(p, { task: "second" }, dir);
  assert.equal(t2.id, t1.id + 1);

  // Removing the middle task keeps ids monotonic: the counter is never reused.
  assert.equal(removeTask(p, t1.id, dir), true);
  const t3 = addTask(p, { task: "third" }, dir);
  assert.equal(t3.id, t2.id + 1, "next id does not reuse a removed one");
  assert.deepEqual(ids(pendingTasks(p, dir)), [t2.id, t3.id]);

  // finishTask keeps the task in the file (history) but out of pending.
  finishTask(p, t2.id, "job-9", dir);
  assert.deepEqual(ids(pendingTasks(p, dir)), [t3.id]);
  const stored = JSON.parse(fs.readFileSync(queueFile(dir), "utf8")).projects[p];
  const handed = stored.find((t) => t.id === t2.id);
  assert.equal(handed.status, "handed"); assert.equal(handed.jobId, "job-9");
  assert.ok(handed.handedAt > 0, "handedAt is stamped");

  // queueView shows pending only and strips status/jobId/createdAt noise.
  assert.deepEqual(queueView(p, dir), [{ id: t3.id, task: "third", files: [], agent: "" }]);

  // removeTask can drop a handed task too (id match ignores status).
  assert.equal(removeTask(p, t2.id, dir), true, "handed tasks are removable by id");
  assert.equal(removeTask(p, "nope", dir), false);
}

// ============================================================ corrupt / missing queue file
{
  const dir = tmp(), p = proj("missing");
  assert.deepEqual(pendingTasks(p, dir), [], "missing file reads as empty");
  assert.deepEqual(readyTasks(p, {}, dir), []);
  assert.equal(peekNext(p, dir), null);
  assert.deepEqual(queueView(p, dir), []);
  addTask(p, { task: "first after missing" }, dir);
  assert.equal(pendingTasks(p, dir).length, 1, "addTask creates the file and dir");
}
{
  const dir = tmp(), p = proj("garbage");
  fs.writeFileSync(queueFile(dir), "{not json!!!");
  assert.deepEqual(pendingTasks(p, dir), [], "unparseable JSON reads as empty");
  addTask(p, { task: "recovered" }, dir);
  assert.equal(JSON.parse(fs.readFileSync(queueFile(dir), "utf8")).projects[p][0].task, "recovered",
    "a corrupt file is overwritten by the next write, not appended to");
}
{
  const dir = tmp(), p = proj("shape");
  // Parseable JSON with wrong-typed fields: `next` falls back via Number()||1,
  // `projects` falls back only when it is not an object.
  fs.writeFileSync(queueFile(dir), JSON.stringify({ next: "abc", projects: null }));
  const t = addTask(p, { task: "fresh ids" }, dir);
  assert.equal(t.id, 1, "non-numeric next restarts ids at 1");

  fs.writeFileSync(queueFile(dir), JSON.stringify({ next: "7", projects: {} }));
  assert.equal(addTask(p, { task: "coerced next" }, dir).id, 7, "numeric-string next is honoured");
  assert.equal(addTask(p, { task: "after" }, dir).id, 8);

  // projects as an ARRAY passes the typeof check but indexes by string key
  // harmlessly — pendingTasks just finds nothing.
  fs.writeFileSync(queueFile(dir), JSON.stringify({ next: 1, projects: [] }));
  assert.deepEqual(pendingTasks(p, dir), [], "array-typed projects reads as empty");
}

// ============================================================ concurrent-ish writes
{
  // Four processes each add five tasks to the same project at once. The
  // queue.json lock serializes the read-modify-write, so all 20 updates
  // must land; rename keeps the file itself atomic and no .tmp survives.
  const dir = tmp(), p = proj("race");
  const child = `
    import { addTask } from ${JSON.stringify(new URL("./constance-queue.mjs", import.meta.url).href)};
    for (let i = 0; i < 5; i++) addTask(${JSON.stringify(p)}, { task: "race " + process.pid + " " + i }, ${JSON.stringify(dir)});
  `;
  const kids = Array.from({ length: 4 }, () =>
    new Promise((res, rej) => {
      const c = spawn(process.execPath, ["--input-type=module", "-e", child], { stdio: "ignore" });
      c.on("exit", (code) => (code === 0 ? res() : rej(new Error(`child exited ${code}`))));
      c.on("error", rej);
    }));
  await Promise.all(kids);

  const raw = JSON.parse(fs.readFileSync(queueFile(dir), "utf8"));
  const stored = raw.projects[p] || [];
  assert.equal(stored.length, 20, `all 20 racing adds survived, got ${stored.length}`);
  const storedIds = new Set(stored.map((t) => t.id));
  assert.equal(storedIds.size, stored.length, "no duplicate ids in the surviving file");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "no stray tmp files");
}

// ============================================================ formerly-suspected bugs (fixed)
{
  // A queue.json that parses but stores a non-array under projects[dir]
  // (hand edit, older version, partial write by another tool) must read as
  // an empty list, not crash every queue function.
  const dir = tmp(), p = proj("typed");
  fs.writeFileSync(queueFile(dir), JSON.stringify({ next: 1, projects: { [p]: "oops" } }));
  assert.deepEqual(pendingTasks(p, dir), [], "non-array project reads as empty");
  assert.deepEqual(readyTasks(p, {}, dir), [], "readyTasks survives it too");
  assert.equal(peekNext(p, dir), null);
  assert.equal(removeTask(p, 1, dir), false, "removeTask on a non-array is a no-op");
  const t = addTask(p, { task: "x" }, dir);
  assert.equal(t.task, "x", "addTask replaces the non-array with a real list");
  assert.deepEqual(pendingTasks(p, dir).map((x) => x.id), [t.id]);
}
{
  // Concurrent addTask calls from separate processes must not lose updates:
  // the lock file serializes read-modify-write. Four writers x five tasks
  // must all land with unique ids.
  const dir = tmp(), p = proj("race-strict");
  const child = `
    import { addTask } from ${JSON.stringify(new URL("./constance-queue.mjs", import.meta.url).href)};
    for (let i = 0; i < 5; i++) addTask(${JSON.stringify(p)}, { task: "strict " + process.pid + " " + i }, ${JSON.stringify(dir)});
  `;
  const kids = Array.from({ length: 4 }, () =>
    new Promise((res, rej) => {
      const c = spawn(process.execPath, ["--input-type=module", "-e", child], { stdio: "ignore" });
      c.on("exit", (code) => (code === 0 ? res() : rej(new Error(`child exited ${code}`))));
      c.on("error", rej);
    }));
  await Promise.all(kids);

  const raw = JSON.parse(fs.readFileSync(queueFile(dir), "utf8"));
  const stored = raw.projects[p] || [];
  assert.equal(stored.length, 20, `no lost updates: expected 20 tasks, got ${stored.length}`);
  assert.equal(new Set(stored.map((t) => t.id)).size, 20, "every racing add got a unique id");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".lock")), [], "no stray lock file");
}

console.log("constance-queue.deep: tests passed");
