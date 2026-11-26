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
//   - top-level JSON scalars, stored entries with missing/odd fields, wrong
//     argument types for every public function, strict id matching, the lock
//     file's stale/fresh/held behaviour, and a queue.json that is a directory.
//
// Everything runs against mkdtemp dirs; HOME and the XDG dirs are pointed at a
// scratch folder too, so even a default stateDir() call cannot touch the real
// home. All scratch dirs are removed at the end.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { addTask, pendingTasks, peekNext, readyTasks, finishTask, removeTask, queueView, queueFile } from "./constance-queue.mjs";

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "constance-queue-deep-home-"));
process.env.HOME = fakeHome;
process.env.XDG_STATE_HOME = path.join(fakeHome, "state");
process.env.XDG_CONFIG_HOME = path.join(fakeHome, "config");
process.env.XDG_CACHE_HOME = path.join(fakeHome, "cache");
const dirs = [fakeHome];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-queue-deep-")); dirs.push(d); return d; };
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

// ============================================================ top-level JSON scalars
{
  // queue.json holding a bare scalar (hand edit, truncated write that still
  // parses) must read as an empty queue, not crash on d.next/d.projects.
  const dir = tmp(), p = proj("scalar");
  for (const raw of ["null", "42", "\"text\"", "true", "[]"]) {
    fs.writeFileSync(queueFile(dir), raw);
    assert.deepEqual(pendingTasks(p, dir), [], `${raw} reads as empty`);
    assert.equal(peekNext(p, dir), null);
    assert.deepEqual(queueView(p, dir), []);
  }
  fs.writeFileSync(queueFile(dir), "null");
  assert.equal(addTask(p, { task: "after null" }, dir).id, 1, "addTask recovers from a null top level");
}

// ============================================================ stored-entry edge shapes
{
  // Entries that ARE objects but miss fields: only status === "pending" counts,
  // and the view passes holes through rather than inventing text.
  const dir = tmp(), p = proj("entries");
  fs.writeFileSync(queueFile(dir), JSON.stringify({ next: 9, projects: { [p]: [
    { id: 1, status: "pending" },
    { id: 2, status: "handed", task: "done one" },
    { id: 3, task: "no status at all" },
    { id: 4, status: "weird", task: "unknown status" },
  ] } }));
  assert.deepEqual(pendingTasks(p, dir).map((t) => t.id), [1], "only exact 'pending' is pending");
  assert.deepEqual(queueView(p, dir), [{ id: 1, task: undefined, files: [], agent: "" }],
    "a pending entry with no task/files/agent shows the holes, not placeholders");
  assert.deepEqual(readyTasks(p, {}, dir).map((t) => t.id), [1], "a field-less pending task is eligible (read-only)");
  // Handed/unknown-status entries still occupy the file but never resurface.
  const raw = JSON.parse(fs.readFileSync(queueFile(dir), "utf8"));
  assert.equal(raw.projects[p].length, 4, "non-pending entries are kept as history, not dropped");
  assert.equal(raw.next, 9, "next is preserved untouched by reads");
}
{
  // Mutating what pendingTasks returns cannot corrupt the file: every read
  // re-parses queue.json.
  const dir = tmp(), p = proj("freshread");
  const t = addTask(p, { task: "orig" }, dir);
  pendingTasks(p, dir)[0].task = "mutated";
  assert.equal(pendingTasks(p, dir)[0].task, "orig", "read results are detached copies");
  assert.equal(t.task, "orig");
}

// ============================================================ argument type edges
{
  const dir = tmp(), p = proj("argtypes");
  // files must be an array: a string or null hits .filter and throws TypeError.
  // The lock's finally still releases, so the next call works.
  assert.throws(() => addTask(p, { task: "x", files: "a.js" }, dir), TypeError);
  assert.throws(() => addTask(p, { task: "x", files: null }, dir), TypeError);
  assert.equal(addTask(p, { task: "after throw" }, dir).task, "after throw", "a thrown addTask leaves no lock behind");

  // Scalars coerce: task/agent go through String(), a falsy title is omitted,
  // and a string `items` slips through because only .length is checked.
  const t = addTask(p, { task: 42, agent: { toString: () => "obj" }, title: 0, items: "ab" }, dir);
  assert.equal(t.task, "42");
  assert.equal(t.agent, "obj");
  assert.ok(!("title" in t), "falsy title is omitted, not stored as 0");
  assert.equal(t.items, "ab", "a string items is stored verbatim (only .length gates it)");

  // readyTasks option types: non-array busyFiles throws TypeError.
  addTask(p, { task: "y", files: ["f.js"] }, dir);
  assert.throws(() => readyTasks(p, { busyFiles: "f.js" }, dir), TypeError);
  assert.throws(() => readyTasks(p, { busyFiles: null }, dir), TypeError);
  // A non-numeric limit compares false against every length: effectively
  // unbounded rather than an error.
  assert.equal(readyTasks(p, { limit: "abc" }, dir).length, 3, "string limit is unbounded");
  assert.equal(readyTasks(p, { limit: NaN }, dir).length, 3, "NaN limit is unbounded");
}
{
  // File lists may hold non-string truthy entries (hand edit): they are stored
  // and still participate in busy/claim matching by identity.
  const dir = tmp(), p = proj("weirdfiles");
  const t = addTask(p, { task: "numeric file", files: [7, "a.js"] }, dir);
  assert.deepEqual(t.files, [7, "a.js"], "addTask keeps truthy non-strings");
  assert.deepEqual(readyTasks(p, { busyFiles: [7] }, dir), [], "a numeric busy entry matches the numeric file");
  assert.equal(readyTasks(p, { busyFiles: ["7"] }, dir).length, 1, "string '7' does NOT match number 7");
}

// ============================================================ id matching is strict
{
  const dir = tmp(), p = proj("idtypes");
  const t = addTask(p, { task: "x" }, dir);
  assert.equal(removeTask(p, String(t.id), dir), false, "a string id does not match the numeric one");
  finishTask(p, String(t.id), 1, dir);
  assert.equal(pendingTasks(p, dir).length, 1, "finishTask with a string id is a silent no-op");
  assert.equal(removeTask(p, t.id + 0.5, dir), false, "a fractional id does not match either");
  assert.equal(finishTask(p, null, 1, dir), undefined, "null id is a silent no-op");
}

// ============================================================ finishTask writes even when idle
{
  // finishTask is a read-modify-write with no "did anything change" check:
  // it rewrites queue.json (creating dir + file) even when nothing matched.
  const dir = tmp(), p = proj("idle-write");
  assert.equal(finishTask(p, 1, 1, dir), undefined);
  const raw = JSON.parse(fs.readFileSync(queueFile(dir), "utf8"));
  assert.deepEqual(raw, { next: 1, projects: {} }, "an idle finishTask still materializes queue.json");
  // And it does not repair a non-array project value the way addTask does.
  fs.writeFileSync(queueFile(dir), JSON.stringify({ next: 3, projects: { [p]: "oops" } }));
  finishTask(p, 1, 1, dir);
  assert.equal(JSON.parse(fs.readFileSync(queueFile(dir), "utf8")).projects[p], "oops",
    "finishTask preserves the non-array it could not match");
}

// ============================================================ the lock file
{
  const dir = tmp(), p = proj("stale");
  fs.mkdirSync(dir, { recursive: true });
  const lock = queueFile(dir) + ".lock";
  // A lock older than 10 s is stale: broken and the write proceeds.
  fs.writeFileSync(lock, String(process.pid));
  const old = new Date(Date.now() - 20000);
  fs.utimesSync(lock, old, old);
  assert.equal(addTask(p, { task: "after stale" }, dir).task, "after stale");
  assert.ok(!fs.existsSync(lock), "the broken stale lock is removed");
}
{
  // A fresh lock nobody releases makes the writer give up: ~200 retries x
  // 25 ms then "queue file is locked". The foreign lock is left untouched.
  // (This one really does sleep ~5 s; that is the designed timeout.)
  const dir = tmp(), p = proj("held");
  fs.mkdirSync(dir, { recursive: true });
  const lock = queueFile(dir) + ".lock";
  fs.writeFileSync(lock, String(process.pid));
  assert.throws(() => addTask(p, { task: "blocked" }, dir), /queue file is locked/);
  assert.equal(fs.readFileSync(lock, "utf8"), String(process.pid), "the foreign lock file is not removed");
  // removeTask shares the same lock. By now the foreign lock is >10 s old, so
  // it counts as stale: removeTask breaks it and proceeds (a no-op here).
  assert.equal(removeTask(p, 1, dir), false, "removeTask waits out the stale window, then runs");
  assert.ok(!fs.existsSync(lock), "the stale lock is cleaned up by the next writer");
}
{
  // A stray .tmp left by a crashed write is ignored by readers and does not
  // collide with the next write (the tmp name carries the pid).
  const dir = tmp(), p = proj("straytmp");
  addTask(p, { task: "real" }, dir);
  fs.writeFileSync(queueFile(dir) + ".999999.tmp", "{torn");
  assert.equal(pendingTasks(p, dir)[0].task, "real", "a stray tmp does not affect reads");
  addTask(p, { task: "second" }, dir);
  assert.equal(pendingTasks(p, dir).length, 2, "the next write still lands");
}

// ============================================================ queue.json that is a directory
{
  const dir = tmp(), p = proj("dirfile");
  fs.mkdirSync(queueFile(dir));
  assert.deepEqual(pendingTasks(p, dir), [], "a directory at queue.json reads as empty");
  assert.equal(peekNext(p, dir), null);
  assert.throws(() => addTask(p, { task: "x" }, dir), /EISDIR/, "the rename onto a directory fails");
  assert.ok(fs.readdirSync(dir).some((f) => f.endsWith(".tmp")),
    "the failed rename leaves its .tmp file behind (documented wart)");
}

// ============================================================ BUG (fixed): non-object entries crash every reader
// A hand-edited or partially-written queue.json can store null/number/string
// entries inside projects[dir]. Readers must skip them the same way a
// non-array project value reads as empty, not throw TypeError.
{
  const dir = tmp(), p = proj("junkentries");
  fs.writeFileSync(queueFile(dir), JSON.stringify({ next: 5, projects: { [p]: [null, 42, "oops", { id: 7, status: "pending", task: "real" }] } }));
  assert.deepEqual(pendingTasks(p, dir).map((t) => t.id), [7], "pendingTasks skips non-object entries");
  assert.deepEqual(queueView(p, dir).map((t) => t.id), [7], "queueView skips them too");
  assert.deepEqual(readyTasks(p, {}, dir).map((t) => t.id), [7], "readyTasks skips them too");
  assert.equal(peekNext(p, dir).id, 7);
  assert.equal(removeTask(p, 42, dir), false, "a non-object entry never matches an id");
  assert.equal(removeTask(p, null, dir), false);
  finishTask(p, 7, "job-1", dir);
  assert.equal(pendingTasks(p, dir).length, 0, "finishTask finds the real entry past the junk");
  const raw = JSON.parse(fs.readFileSync(queueFile(dir), "utf8"));
  assert.equal(raw.projects[p].length, 4, "junk entries are skipped by readers, not deleted");
  assert.equal(raw.projects[p][3].status, "handed", "the real entry was still updated");
}

// ============================================================ BUG (fixed): bad `next` flows into ids
// readAll accepts negatives and fractions via Number(d.next) || 1; ids are
// compared with === elsewhere, so they must stay positive integers. A bad
// next is recomputed as max stored id + 1.
{
  const dir = tmp(), p = proj("badnext");
  fs.writeFileSync(queueFile(dir), JSON.stringify({ next: -3, projects: {} }));
  assert.equal(addTask(p, { task: "x" }, dir).id, 1, "negative next restarts ids at 1");
  fs.writeFileSync(queueFile(dir), JSON.stringify({ next: 1.9, projects: {} }));
  assert.equal(addTask(p, { task: "y" }, dir).id, 1, "fractional next never reaches an id");
  fs.writeFileSync(queueFile(dir), JSON.stringify({ next: -3, projects: { [p]: [{ id: 8, status: "handed", task: "old" }] } }));
  assert.equal(addTask(p, { task: "z" }, dir).id, 9, "bad next falls back to max stored id + 1");
  fs.writeFileSync(queueFile(dir), JSON.stringify({ next: 0, projects: { [p]: [{ id: 4, status: "pending", task: "live" }] } }));
  assert.equal(addTask(p, { task: "w" }, dir).id, 5, "zero next also recomputes from max id");
}

// ============================================================ BUG (fixed): "__proto__" as projectDir loses tasks
// data.projects["__proto__"] used to hit the Object.prototype setter: the list
// was stored AS the prototype and JSON.stringify dropped it — the task was
// silently lost while `next` still incremented. projects is now a
// null-prototype object so such keys are ordinary own properties.
{
  const dir = tmp();
  const t = addTask("__proto__", { task: "proto task" }, dir);
  const raw = JSON.parse(fs.readFileSync(queueFile(dir), "utf8"));
  assert.equal(raw.projects["__proto__"][0].task, "proto task", "the task survives serialization");
  assert.deepEqual(pendingTasks("__proto__", dir).map((x) => x.id), [t.id], "it reads back");
  assert.equal(removeTask("__proto__", t.id, dir), true, "it removes cleanly");
  assert.deepEqual(pendingTasks("__proto__", dir), []);
  // Other prototype-colliding keys are safe too.
  const t2 = addTask("constructor", { task: "ctor task" }, dir);
  assert.equal(JSON.parse(fs.readFileSync(queueFile(dir), "utf8")).projects.constructor[0].id, t2.id);
}

// ============================================================ BUG (fixed): finishTask is not under the lock
// addTask/removeTask serialize their read-modify-write on queue.json.lock;
// finishTask did the same read-modify-write unlocked — a classic lost-update
// window against a racing addTask/removeTask. It now takes the same lock.
{
  const dir = tmp(), p = proj("finlock");
  const t = addTask(p, { task: "x" }, dir);
  finishTask(p, t.id, "job-1", dir);
  assert.equal(pendingTasks(p, dir).length, 0);
  assert.equal(JSON.parse(fs.readFileSync(queueFile(dir), "utf8")).projects[p][0].status, "handed");
  // Proof the lock is really held: a fresh foreign lock makes finishTask wait
  // out the retry loop and give up, exactly like addTask does.
  fs.writeFileSync(queueFile(dir) + ".lock", String(process.pid));
  assert.throws(() => finishTask(p, 999, 1, dir), /queue file is locked/);
  fs.unlinkSync(queueFile(dir) + ".lock");
  finishTask(p, 999, 1, dir);
  assert.ok(!fs.existsSync(queueFile(dir) + ".lock"), "finishTask releases its lock");
}

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log("constance-queue.deep: tests passed");
