// Deeper edge-case pass on Constance's backlog refill (bin/constance-refill.mjs),
// complementing constance-refill.test.mjs. Covers numeric-coercion gates
// (strings, NaN, null, fractions, Infinity), wrong-typed backlog items and
// options, busyFiles that are not arrays or not strings, a backlog.md that is
// missing/corrupt/a directory, stale-state behaviour between calls, and the
// job:0 corner where refill and openItems disagree about "taken". The module
// reads only <dir>/.constance/backlog.md; the fake HOME/XDG dirs under mktemp
// are a guard so nothing can ever touch the real home folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseBacklog } from "./constance-backlog.mjs";
import { refill } from "./constance-refill.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constance-refill-deep-"));
process.env.HOME = path.join(tmp, "home");
fs.mkdirSync(process.env.HOME, { recursive: true });
for (const v of ["XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  process.env[v] = path.join(tmp, v.toLowerCase());
  fs.mkdirSync(process.env[v], { recursive: true });
}

const writeBacklog = (dir, text) => {
  fs.mkdirSync(path.join(dir, ".constance"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".constance", "backlog.md"), text);
};
// A minimal parsed-item shape, overridable per test.
const mk = (over = {}) => ({ id: 1, kind: "task", text: "do it", files: [], job: null, done: false, ...over });
const lowQueue = { queueLen: 0, freeSlots: 5 };

// ---------- gates: queueLen / low / freeSlots coercion ----------

// queueLen is compared as Number(queueLen) < low, and low is NOT coerced by
// the module — the '<' operator coerces it anyway.
assert.equal(refill(null, { queueLen: null, freeSlots: 1, backlog: [mk()] }).tasks.length, 1,
  "queueLen null coerces to 0, so the queue counts as low");
assert.equal(refill(null, { queueLen: "2", freeSlots: 1, backlog: [mk()] }).tasks.length, 1,
  "a numeric-string queueLen works");
assert.deepEqual(refill(null, { queueLen: "abc", freeSlots: 1, backlog: [mk()] }),
  { tasks: [], reason: "the queue is not low" }, "NaN queueLen is never low");
assert.deepEqual(refill(null, { queueLen: NaN, freeSlots: 1, backlog: [mk()] }),
  { tasks: [], reason: "the queue is not low" }, "NaN queueLen is never low");
assert.deepEqual(refill(null, { queueLen: 0, freeSlots: 1, low: "abc", backlog: [mk()] }),
  { tasks: [], reason: "the queue is not low" }, "a non-numeric low makes every queue look full");
assert.equal(refill(null, { queueLen: 0, freeSlots: 1, low: "3", backlog: [mk()] }).tasks.length, 1,
  "a numeric-string low still compares numerically");
assert.deepEqual(refill(null, { queueLen: 0, freeSlots: 1, low: 0, backlog: [mk()] }),
  { tasks: [], reason: "the queue is not low" }, "low 0 means even an empty queue is not low");
assert.deepEqual(refill(null, { queueLen: -5, freeSlots: 1, low: -10, backlog: [mk()] }),
  { tasks: [], reason: "the queue is not low" }, "a negative queueLen is still not below a more-negative low");
assert.equal(refill(null, { queueLen: -5, freeSlots: 1, low: -3, backlog: [mk()] }).tasks.length, 1,
  "a negative queueLen below low counts as low");

// freeSlots goes through Number(freeSlots) > 0 and caps via tasks.length >= freeSlots.
assert.deepEqual(refill(null, { queueLen: 0, freeSlots: null, backlog: [mk()] }),
  { tasks: [], reason: "no free slots" }, "freeSlots null coerces to 0");
assert.deepEqual(refill(null, { queueLen: 0, freeSlots: NaN, backlog: [mk()] }),
  { tasks: [], reason: "no free slots" }, "freeSlots NaN is not > 0");
assert.equal(refill(null, { queueLen: 0, freeSlots: "2", backlog: [mk({ id: 1 }), mk({ id: 2 })] }).tasks.length, 2,
  "a numeric-string freeSlots works");
assert.equal(refill(null, { queueLen: 0, freeSlots: true, backlog: [mk({ id: 1 }), mk({ id: 2 })] }).tasks.length, 1,
  "freeSlots true coerces to 1");
// A fractional slot count rounds UP: length >= 1.5 first fails at length 1,
// so two tasks are handed out for freeSlots 1.5.
assert.equal(refill(null, { queueLen: 0, freeSlots: 1.5, backlog: [mk({ id: 1 }), mk({ id: 2 }), mk({ id: 3 })] }).tasks.length, 2,
  "freeSlots 1.5 hands out 2 tasks (integer length >= 1.5)");
assert.equal(refill(null, { queueLen: 0, freeSlots: 0.5, backlog: [mk({ id: 1 }), mk({ id: 2 })] }).tasks.length, 1,
  "freeSlots 0.5 still hands out 1 task");
assert.equal(refill(null, { queueLen: 0, freeSlots: Infinity, backlog: [mk({ id: 1 }), mk({ id: 2 })] }).tasks.length, 2,
  "freeSlots Infinity never caps");

// ---------- backlog option: wrong types and fallbacks ----------

// An empty array is a valid backlog and never touches the filesystem, so a
// nonsense projectDir is fine.
assert.deepEqual(refill("does/not/exist", { ...lowQueue, backlog: [] }), { tasks: [], reason: "nothing worthwhile" });
// backlog null/undefined falls back to reading <projectDir>/.constance/backlog.md.
const fbDir = path.join(tmp, "fallback");
writeBacklog(fbDir, "- [ ] task: from file\n");
assert.equal(refill(fbDir, { ...lowQueue, backlog: null }).tasks[0].task, "from file", "null backlog reads the dir");
assert.equal(refill(fbDir, { ...lowQueue, backlog: undefined }).tasks[0].task, "from file", "undefined backlog reads the dir");
// A string backlog is treated as a project directory, not as item data.
const strDir = path.join(tmp, "stringbacklog");
writeBacklog(strDir, "- [ ] bug: via string path\n");
assert.equal(refill(null, { ...lowQueue, backlog: strDir }).tasks[0].kind, "bug", "a string backlog is a directory path");
// A non-array non-string backlog (object, number) is passed to readBacklog as
// a directory; path.join throws inside readBacklog's try, so it degrades to an
// empty backlog instead of propagating.
assert.deepEqual(refill(null, { ...lowQueue, backlog: {} }), { tasks: [], reason: "nothing worthwhile" },
  "object backlog reads as an empty backlog");
assert.deepEqual(refill(null, { ...lowQueue, backlog: 42 }), { tasks: [], reason: "nothing worthwhile" },
  "number backlog reads as an empty backlog");
// projectDir itself may be missing when the backlog has to be read: same
// swallowed path.join error, same empty answer.
assert.deepEqual(refill(null, lowQueue), { tasks: [], reason: "nothing worthwhile" },
  "no projectDir and no backlog is empty, not an exception");
assert.deepEqual(refill(undefined, { ...lowQueue, backlog: undefined }), { tasks: [], reason: "nothing worthwhile" });

// ---------- backlog items: wrong shapes are skipped, not fatal ----------

// Garbage entries in a hand-built backlog array are skipped silently.
assert.deepEqual(
  refill(null, { ...lowQueue, backlog: [null, undefined, 0, false, "junk", 42, {}, [], NaN] }),
  { tasks: [], reason: "nothing worthwhile" },
  "non-object items never match a kind");
// An item missing id/kind/text/files/job/done fields still works: kind must
// match exactly, falsy done/job mean open, missing files mean fileless.
const sparse = refill(null, { ...lowQueue, backlog: [{ kind: "docs", text: "sparse" }] });
assert.equal(sparse.tasks.length, 1);
assert.equal(sparse.tasks[0].backlogId, undefined, "a missing id surfaces as undefined backlogId");
assert.deepEqual(sparse.tasks[0].files, []);
assert.equal(sparse.tasks[0].task, "sparse");
// Kind matching is exact: case, whitespace and substrings do not count.
for (const kind of ["Bug", "TASK", "task ", " tas", "buggy", ""]) {
  assert.deepEqual(refill(null, { ...lowQueue, backlog: [mk({ kind })] }),
    { tasks: [], reason: "nothing worthwhile" }, `kind ${JSON.stringify(kind)} is not a refill kind`);
}
// done/job are truthiness checks, not === true / !== null.
assert.deepEqual(refill(null, { ...lowQueue, backlog: [mk({ done: "false" })] }),
  { tasks: [], reason: "nothing worthwhile" }, "done: 'false' (a truthy string) still counts as done");
assert.deepEqual(refill(null, { ...lowQueue, backlog: [mk({ done: 1 })] }),
  { tasks: [], reason: "nothing worthwhile" }, "done: 1 counts as done");
assert.deepEqual(refill(null, { ...lowQueue, backlog: [mk({ job: "0" })] }),
  { tasks: [], reason: "nothing worthwhile" }, "job: '0' is truthy, so the item is taken");
assert.deepEqual(refill(null, { ...lowQueue, backlog: [mk({ job: {} })] }),
  { tasks: [], reason: "nothing worthwhile" }, "any truthy job counts as taken");
// A missing text becomes an empty task string; it is still handed out.
const noText = refill(null, { ...lowQueue, backlog: [mk({ text: null }), mk({ text: 0 }), mk({ text: "   " })] });
assert.equal(noText.tasks.length, 3, "empty/whitespace text still produces tasks");
assert.deepEqual(noText.tasks.map((t) => t.task), ["", "", ""], "task text is String(...).trim()'d");
const objText = refill(null, { ...lowQueue, backlog: [mk({ text: { a: 1 } })] });
assert.equal(objText.tasks[0].task, "[object Object]", "non-string text is stringified");

// item.files is expected to be an array of strings; anything else mostly
// degrades, but a non-array with no .filter throws.
assert.throws(() => refill(null, { ...lowQueue, backlog: [mk({ files: "a.mjs" })] }), TypeError,
  "files as a bare string crashes on .filter");
assert.throws(() => refill(null, { ...lowQueue, backlog: [mk({ files: 5 })] }), TypeError,
  "files as a number crashes on .filter");
// null/undefined files mean fileless; falsy entries inside the array drop out.
const oddFiles = refill(null, {
  ...lowQueue,
  backlog: [mk({ id: 1, files: null }), mk({ id: 2, files: [null, "", 0, false, "real.mjs"] })],
});
assert.equal(oddFiles.tasks.length, 2);
assert.deepEqual(oddFiles.tasks[0].files, [], "files: null is fileless");
assert.deepEqual(oddFiles.tasks[1].files, ["real.mjs"], "falsy file entries are filtered");
// Truthy non-string file entries pass through unstringified into the task.
const numFile = refill(null, { ...lowQueue, backlog: [mk({ files: [123] })] });
assert.deepEqual(numFile.tasks[0].files, [123], "numeric file entries are not coerced to strings");
// A file entry duplicated inside one item is claimed once and stays duplicated
// in the task's own files list.
const dupInItem = refill(null, { ...lowQueue, backlog: [mk({ files: ["a.mjs", "a.mjs"] })] });
assert.deepEqual(dupInItem.tasks[0].files, ["a.mjs", "a.mjs"]);
// BUG: refill treats a falsy job (0, "", false) as untaken and hands the item
// out, while openItems() in constance-backlog.mjs treats any job !== null as
// taken — so an item tagged '(job 0)' is invisible to openItems yet refillable.
// assert.deepEqual(
//   refill(null, { ...lowQueue, backlog: [mk({ job: 0 })] }),
//   { tasks: [], reason: "nothing worthwhile" },
//   "job 0 should count as taken, matching openItems");

// ---------- busyFiles: wrong types and match semantics ----------

// busyFiles is expected to be an array; non-arrays crash on .filter.
assert.throws(() => refill(null, { ...lowQueue, backlog: [mk({ files: ["f.mjs"] })], busyFiles: "f.mjs" }), TypeError,
  "busyFiles as a string crashes");
assert.throws(() => refill(null, { ...lowQueue, backlog: [mk({ files: ["f.mjs"] })], busyFiles: {} }), TypeError,
  "busyFiles as an object crashes");
// null/undefined busyFiles means nothing busy; falsy entries drop out.
assert.equal(refill(null, { ...lowQueue, backlog: [mk({ files: ["f.mjs"] })], busyFiles: null }).tasks.length, 1);
assert.equal(refill(null, { ...lowQueue, backlog: [mk({ files: ["f.mjs"] })], busyFiles: [null, "", 0, false] }).tasks.length, 1,
  "falsy busyFiles entries are ignored");
// Matching is exact string equality in a Set: no substring, prefix, case-fold
// or type coercion.
const busyItem = mk({ files: ["src/foo.mjs"] });
for (const busy of [["src"], ["src/foo"], ["SRC/FOO.MJS"], ["foo.mjs"], [123], [{}]]) {
  assert.equal(refill(null, { ...lowQueue, backlog: [busyItem], busyFiles: busy }).tasks.length, 1,
    `busyFiles ${JSON.stringify(busy)} does not block ${JSON.stringify(busyItem.files)}`);
}
assert.deepEqual(refill(null, { ...lowQueue, backlog: [busyItem], busyFiles: ["src/foo.mjs"] }),
  { tasks: [], reason: "nothing worthwhile" }, "an exact busy match blocks the item");
// An item is skipped when ANY of its files is busy, even if others are free.
const mixed = mk({ files: ["free.mjs", "busy.mjs"] });
assert.deepEqual(refill(null, { ...lowQueue, backlog: [mixed], busyFiles: ["busy.mjs"] }),
  { tasks: [], reason: "nothing worthwhile" }, "one busy file sinks the whole item");
// A skipped item does not consume a free slot: the next suitable item fills it.
const skipThenTake = refill(null, {
  ...lowQueue, freeSlots: 1,
  backlog: [mk({ id: 1, kind: "test", files: ["hot.mjs"] }), mk({ id: 2, kind: "test", files: ["cold.mjs"] })],
  busyFiles: ["hot.mjs"],
});
assert.deepEqual(skipThenTake.tasks.map((t) => t.backlogId), [2], "the busy item is skipped, not counted");

// ---------- ordering: same-kind order and cross-kind file claims ----------

// Within one kind, backlog order is preserved; kinds still win outermost.
const ordered = refill(null, {
  queueLen: 0, freeSlots: 10,
  backlog: [
    mk({ id: 10, kind: "bug" }), mk({ id: 11, kind: "task" }), mk({ id: 12, kind: "test" }),
    mk({ id: 13, kind: "test" }), mk({ id: 14, kind: "docs" }), mk({ id: 15, kind: "bug" }),
  ],
});
assert.deepEqual(ordered.tasks.map((t) => t.backlogId), [12, 13, 14, 11, 10, 15],
  "kind order first, backlog order inside each kind");
// A file claimed by an earlier-kind pick blocks a later-kind item too.
const crossKind = refill(null, {
  ...lowQueue,
  backlog: [
    mk({ id: 1, kind: "test", files: ["shared.mjs"] }),
    mk({ id: 2, kind: "bug", files: ["shared.mjs"] }),
    mk({ id: 3, kind: "bug", files: ["other.mjs"] }),
  ],
});
assert.deepEqual(crossKind.tasks.map((t) => t.backlogId), [1, 3], "claims cross kind boundaries");
// Claimed files come only from items actually handed out: an item skipped for
// a busy file does not claim its other files.
const skippedClaim = refill(null, {
  ...lowQueue,
  backlog: [
    mk({ id: 1, kind: "test", files: ["hot.mjs", "warm.mjs"] }),
    mk({ id: 2, kind: "bug", files: ["warm.mjs"] }),
  ],
  busyFiles: ["hot.mjs"],
});
assert.deepEqual(skippedClaim.tasks.map((t) => t.backlogId), [2], "a skipped item claims nothing");
// Two fileless items never conflict and both come out.
const fileless = refill(null, { ...lowQueue, backlog: [mk({ id: 1 }), mk({ id: 2 })] });
assert.equal(fileless.tasks.length, 2);

// ---------- filesystem edges: missing, corrupt, wrong-shaped backlog.md ----------

const proj = path.join(tmp, "project");
// No .constance at all.
fs.mkdirSync(proj, { recursive: true });
assert.deepEqual(refill(proj, lowQueue), { tasks: [], reason: "nothing worthwhile" }, "no .constance folder");
// .constance exists but backlog.md does not.
fs.mkdirSync(path.join(proj, ".constance"), { recursive: true });
assert.deepEqual(refill(proj, lowQueue), { tasks: [], reason: "nothing worthwhile" }, "missing backlog.md");
// backlog.md as a directory: readFileSync throws EISDIR, caught as empty.
const dirBacklog = path.join(tmp, "dirbacklog");
fs.mkdirSync(path.join(dirBacklog, ".constance", "backlog.md"), { recursive: true });
assert.deepEqual(refill(dirBacklog, lowQueue), { tasks: [], reason: "nothing worthwhile" }, "backlog.md as a directory");
// Garbage bytes that are not valid UTF-8 decode to U+FFFD prose: no items.
const corrupt = path.join(tmp, "corrupt");
fs.mkdirSync(path.join(corrupt, ".constance"), { recursive: true });
fs.writeFileSync(path.join(corrupt, ".constance", "backlog.md"), Buffer.from([0xff, 0xfe, 0x00, 0x2d, 0x5b, 0x20]));
assert.deepEqual(refill(corrupt, lowQueue), { tasks: [], reason: "nothing worthwhile" }, "invalid UTF-8 reads as no items");
// Valid UTF-8 prose with no item lines is equally empty.
const prose = path.join(tmp, "prose");
writeBacklog(prose, "# Backlog\njust some notes\n- not an item\n");
assert.deepEqual(refill(prose, lowQueue), { tasks: [], reason: "nothing worthwhile" }, "prose-only backlog");
// .constance as a regular file: the backlog path is unreachable, reads empty.
const dcFile = path.join(tmp, "dcfile");
fs.mkdirSync(dcFile, { recursive: true });
fs.writeFileSync(path.join(dcFile, ".constance"), "not a dir");
assert.deepEqual(refill(dcFile, lowQueue), { tasks: [], reason: "nothing worthwhile" }, ".constance as a file");
// projectDir as a file (not a directory) reads the same empty way.
const fileDir = path.join(tmp, "justfile");
fs.writeFileSync(fileDir, "x");
assert.deepEqual(refill(fileDir, lowQueue), { tasks: [], reason: "nothing worthwhile" }, "projectDir as a file");

// ---------- stale state: no caching between calls ----------

// refill re-reads the file on every call: an edit between calls is seen.
const live = path.join(tmp, "live");
writeBacklog(live, "- [ ] task: first\n");
assert.equal(refill(live, { queueLen: 0, freeSlots: 1 }).tasks[0].task, "first");
writeBacklog(live, "- [ ] bug: second\n");
const second = refill(live, { queueLen: 0, freeSlots: 1 });
assert.equal(second.tasks[0].kind, "bug", "the rewritten backlog is re-read, not cached");
assert.equal(second.tasks[0].task, "second");
// Mutating a returned tasks array does not poison later calls.
const r1 = refill(live, { queueLen: 0, freeSlots: 5 });
r1.tasks.length = 0;
r1.tasks.push({ task: "forged" });
const r2 = refill(live, { queueLen: 0, freeSlots: 5 });
assert.equal(r2.tasks.length, 1);
assert.equal(r2.tasks[0].task, "second", "returned arrays are fresh per call");
// Two back-to-back calls with identical inputs are deterministic.
assert.deepEqual(refill(live, lowQueue), refill(live, lowQueue), "same inputs, same result");
// A backlog array passed in is not mutated by the call.
const frozenItems = [mk({ id: 7, kind: "task", files: ["x.mjs"] })];
const snapshot = JSON.stringify(frozenItems);
refill(null, { ...lowQueue, backlog: frozenItems });
assert.equal(JSON.stringify(frozenItems), snapshot, "input items are not mutated");

// ---------- result shape ----------

const ok = refill(null, { ...lowQueue, backlog: [mk()] });
assert.deepEqual(Object.keys(ok).sort(), ["reason", "tasks"], "success result has exactly tasks+reason");
assert.equal(ok.reason, null);
assert.deepEqual(Object.keys(ok.tasks[0]).sort(), ["backlogId", "files", "kind", "task"],
  "each task has exactly task/files/kind/backlogId");
const no = refill(null, { queueLen: 5, freeSlots: 1, backlog: [mk()] });
assert.deepEqual(Object.keys(no).sort(), ["reason", "tasks"]);
assert.equal(typeof no.reason, "string");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("constance-refill.deep: tests passed");
