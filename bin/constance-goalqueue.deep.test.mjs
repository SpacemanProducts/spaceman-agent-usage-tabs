// Deeper edge-case tests for constance-goalqueue.mjs: malformed queue files, coerced and
// boundary inputs to add/edit/move, pause/takeNext semantics, and needsOwner corner cases.
// Everything runs against a mktemp state dir with a fake HOME; nothing touches the bus,
// the network or real agents. constance-goalqueue.mjs itself is not modified here.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-goalqueue-deep-"));
process.env.HOME = dir; // fake HOME: nothing in this test may read the real one
const { readGoalQueue, addGoal, removeGoal, editGoal, moveGoal, takeNext, pauseQueue, resumeQueue, needsOwner } =
  await import("./constance-goalqueue.mjs");

const qfile = path.join(dir, "goal-queue.json");
const fresh = () => { try { fs.rmSync(qfile); } catch { /* absent is fine */ } };
const writeQueue = (q) => fs.writeFileSync(qfile, typeof q === "string" ? q : JSON.stringify(q));
const noTmp = () => assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".tmp")), [], "no stray tmp files");

// ---- readGoalQueue: missing, malformed and wrong-shaped files -------------------------
fresh();
assert.deepEqual(readGoalQueue(dir), { goals: [], paused: "", ownerPaused: false, ownerPausedAt: 0 }, "missing file");
writeQueue("{not json");
assert.deepEqual(readGoalQueue(dir), { goals: [], paused: "", ownerPaused: false, ownerPausedAt: 0 }, "malformed JSON");
writeQueue("﻿{}"); // BOM prefix: JSON.parse rejects it
assert.deepEqual(readGoalQueue(dir), { goals: [], paused: "", ownerPaused: false, ownerPausedAt: 0 }, "BOM-prefixed JSON");
for (const bad of ["null", "[]", '"x"', "42", "true"]) {
  writeQueue(bad);
  assert.deepEqual(readGoalQueue(dir), { goals: [], paused: "", ownerPaused: false, ownerPausedAt: 0 }, bad);
}
writeQueue({ goals: "nope", paused: 7 });
assert.deepEqual(readGoalQueue(dir), { goals: [], paused: "7", ownerPaused: false, ownerPausedAt: 0 }, "non-array goals dropped, numeric paused stringified");
writeQueue({ goals: null });
assert.deepEqual(readGoalQueue(dir), { goals: [], paused: "", ownerPaused: false, ownerPausedAt: 0 });
// Entries survive only with truthy text AND dir; everything else is dropped.
writeQueue({
  goals: [null, 42, "x", {}, { text: "no dir" }, { dir: "/d" }, { text: "ok", dir: "/ok", extra: 1 }],
  paused: { why: "object" },
});
const rq = readGoalQueue(dir);
assert.equal(rq.goals.length, 1);
assert.deepEqual(rq.goals[0], { text: "ok", dir: "/ok", extra: 1 }, "extra fields are kept verbatim");
assert.equal(rq.paused, "[object Object]", "object paused stringifies");
// paused coercion: falsy values become "" (queue runs), truthy non-strings still pause it.
for (const [raw, want] of [[0, ""], [false, ""], [null, ""], ["0", "0"], [" ", " "], [5, "5"]]) {
  writeQueue({ goals: [], paused: raw });
  assert.equal(readGoalQueue(dir).paused, want, `paused=${JSON.stringify(raw)}`);
}
assert.notEqual(readGoalQueue(dir), readGoalQueue(dir), "each read parses fresh objects");

// ---- addGoal: coercion, injected clock, validation ------------------------------------
fresh();
const g1 = addGoal(dir, { text: "  spaced  ", dir: "/a" }, 111);
assert.equal(g1.text, "spaced");
assert.equal(g1.addedAt, 111, "injected clock lands on addedAt");
assert.match(g1.id, /^[0-9a-f]{8}$/, "id is 8 hex chars");
const g2 = addGoal(dir, { text: "two", dir: "/b" });
assert.notEqual(g1.id, g2.id, "ids differ");
assert.equal(readGoalQueue(dir).goals.map((g) => g.text).join(""), "spacedtwo", "queue order = add order");
assert.equal(addGoal(dir, { text: 42, dir: "/c" }).text, "42", "numeric text coerced");
assert.equal(addGoal(dir, { text: {}, dir: "/d" }).text, "[object Object]", "object text coerces via String()");
for (const t of [0, false, null, "", "   ", undefined]) {
  assert.throws(() => addGoal(dir, { text: t, dir: "/x" }), /goal first/, `text=${JSON.stringify(t)}`);
}
for (const d of [undefined, null, "", 0, false]) {
  assert.throws(() => addGoal(dir, { text: "x", dir: d }), /folder/, `dir=${JSON.stringify(d)}`);
}
assert.equal(addGoal(dir, { text: "nl", dir: "/e" }).text, "nl");
assert.equal(addGoal(dir, { text: "l1\nl2  ", dir: "/f" }).text, "l1\nl2", "only the ends are trimmed; inner newlines kept");
// A non-string dir is stored as-is (the queue does not validate it; resolveDir does later).
const weird = addGoal(dir, { text: "weird dir", dir: 123 });
assert.equal(readGoalQueue(dir).goals.find((g) => g.id === weird.id).dir, 123);
noTmp();
// A corrupt existing file is replaced wholesale, not appended to.
fresh();
writeQueue("garbage{{{");
const g5 = addGoal(dir, { text: "after garbage", dir: "/g" });
assert.deepEqual(readGoalQueue(dir).goals.map((g) => g.id), [g5.id]);
noTmp();

// ---- editGoal / removeGoal: partial updates, atomicity on rejection ------------------
fresh();
const A = addGoal(dir, { text: "A", dir: "/a" });
const B = addGoal(dir, { text: "B", dir: "/b" });
const C = addGoal(dir, { text: "C", dir: "/c" });
const find = (id) => readGoalQueue(dir).goals.find((g) => g.id === id);
editGoal(dir, A.id, { text: "A2" });
assert.deepEqual(find(A.id), { ...A, text: "A2" }, "text-only edit keeps dir and addedAt");
editGoal(dir, A.id, { dir: "/a2" });
assert.deepEqual(find(A.id), { ...A, text: "A2", dir: "/a2" }, "dir-only edit keeps text");
editGoal(dir, A.id, { text: undefined, dir: undefined });
assert.equal(find(A.id).text, "A2", "explicit undefined fields change nothing");
editGoal(dir, A.id, {});
assert.equal(find(A.id).dir, "/a2", "empty edit is a no-op that still returns the goal");
editGoal(dir, A.id, { dir: "" });
assert.equal(find(A.id).dir, "/a2", "empty-string dir is falsy: cannot clear the folder");
// A rejected edit throws BEFORE saving: the file on disk is untouched.
const before = fs.readFileSync(qfile, "utf8");
assert.throws(() => editGoal(dir, A.id, { text: "   " }), /empty/);
assert.throws(() => editGoal(dir, "nope", { text: "x" }), /No queued goal/);
assert.equal(fs.readFileSync(qfile, "utf8"), before, "rejected edits leave the file byte-identical");
assert.equal(removeGoal(dir, B.id).text, "B", "removeGoal returns the removed goal");
assert.throws(() => removeGoal(dir, B.id), /No queued goal/);
assert.deepEqual(readGoalQueue(dir).goals.map((g) => g.id), [A.id, C.id]);
// Hand-edited duplicate ids: remove/move hit the FIRST match only.
writeQueue({ goals: [
  { id: "dup", text: "one", dir: "/1" },
  { id: "dup", text: "two", dir: "/2" },
] });
assert.equal(removeGoal(dir, "dup").text, "one", "first duplicate removed");
assert.equal(readGoalQueue(dir).goals[0].text, "two", "second duplicate survives");
writeQueue({ goals: [
  { id: "dup", text: "one", dir: "/1" },
  { id: "dup", text: "two", dir: "/2" },
  { id: "z", text: "three", dir: "/3" },
] });
moveGoal(dir, "dup", "top");
assert.deepEqual(readGoalQueue(dir).goals.map((g) => g.text), ["one", "two", "three"], "move hits the first duplicate");

// ---- moveGoal: target coercion and boundaries ----------------------------------------
fresh();
const M1 = addGoal(dir, { text: "m1", dir: "/1" });
const M2 = addGoal(dir, { text: "m2", dir: "/2" });
const M3 = addGoal(dir, { text: "m3", dir: "/3" });
const texts = () => readGoalQueue(dir).goals.map((g) => g.text).join("");
assert.equal(texts(), "m1m2m3");
assert.deepEqual(moveGoal(dir, M1.id, "1"), [M2.id, M1.id, M3.id], "numeric string position works; returns new id order");
assert.equal(texts(), "m2m1m3");
moveGoal(dir, M1.id, " 0 "); // Number() trims whitespace
assert.equal(texts(), "m1m2m3", "whitespace-padded number works");
moveGoal(dir, M1.id, -4); // negative clamps to top
assert.equal(texts(), "m1m2m3");
moveGoal(dir, M1.id, 99); // past the end clamps to last
assert.equal(texts(), "m2m3m1");
moveGoal(dir, M2.id, "0x1"); // hex parses via Number(): position 1, not an error
assert.equal(texts(), "m3m2m1", "hex-string target is accepted as a number");
for (const bad of ["1.5", "sideways", "up ", NaN, Infinity, -Infinity, undefined]) {
  assert.throws(() => moveGoal(dir, M1.id, bad), /up, down/, `to=${String(bad)}`);
}
assert.equal(texts(), "m3m2m1", "rejected moves change nothing");
// Moving to the same slot is a stable no-op.
moveGoal(dir, M2.id, 1);
assert.equal(texts(), "m3m2m1");
moveGoal(dir, M2.id, "down"); // M2 was middle: down swaps it past M1
assert.equal(texts(), "m3m1m2");
moveGoal(dir, M2.id, "down"); // now last: clamps, stays
assert.equal(texts(), "m3m1m2");
// Single-element queue: every target is a no-op.
fresh();
const solo = addGoal(dir, { text: "solo", dir: "/s" });
for (const to of ["up", "down", "top", 0, 5, "-1"]) {
  assert.deepEqual(moveGoal(dir, solo.id, to), [solo.id], `to=${to}`);
}

// ---- takeNext / pauseQueue / resumeQueue ----------------------------------------------
fresh();
assert.equal(takeNext(dir), null, "empty queue takes nothing");
assert.equal(readGoalQueue(dir).paused, "", "taking from an unpaused empty queue does not pause it");
pauseQueue(dir);
assert.equal(readGoalQueue(dir).paused, "stopped", "pauseQueue() defaults the reason");
const p1 = addGoal(dir, { text: "p1", dir: "/p1" });
const p2 = addGoal(dir, { text: "p2", dir: "/p2" });
assert.equal(takeNext(dir), null, "paused queue hands out nothing");
assert.equal(readGoalQueue(dir).paused, "stopped", "a refused take leaves the pause in place");
assert.deepEqual(takeNext(dir, { force: true }), p1, "force takes the front goal, whole record");
assert.equal(readGoalQueue(dir).paused, "", "force clears the pause");
assert.equal(takeNext(dir).text, "p2");
// Force on an empty-but-paused queue still clears the pause.
pauseQueue(dir, "stuck");
assert.equal(takeNext(dir, { force: true }), null);
assert.equal(readGoalQueue(dir).paused, "", "force clears pause even when nothing is taken");
// pauseQueue reason coercion.
assert.equal(pauseQueue(dir), "stopped");
assert.equal(pauseQueue(dir, ""), "stopped", "empty reason falls back");
assert.equal(pauseQueue(dir, 0), "stopped", "falsy reason falls back");
assert.equal(pauseQueue(dir, "  "), "  ", "whitespace reason kept verbatim");
assert.equal(readGoalQueue(dir).paused, "  ");
resumeQueue(dir);
assert.equal(resumeQueue(dir), true, "resumeQueue is idempotent and returns true");
assert.equal(readGoalQueue(dir).paused, "");
// A paused flag that is the STRING "0" is truthy: the queue still holds.
writeQueue({ goals: [{ id: "s", text: "held", dir: "/h" }], paused: "0" });
assert.equal(takeNext(dir), null, "paused \"0\" still blocks");
// A numeric 0 paused coerces to "" on read: the queue runs.
writeQueue({ goals: [{ id: "s", text: "held", dir: "/h" }], paused: 0 });
assert.equal(takeNext(dir).text, "held", "paused 0 does not block");
// takeNext preserves addedAt from the stored record.
fresh();
const timed = addGoal(dir, { text: "timed", dir: "/t" }, 777);
assert.equal(takeNext(dir).addedAt, 777);
noTmp();

// ---- needsOwner: shapes, ordering, checklist interplay -------------------------------
const J = (id, status, extra = {}) => ({ id, goal: "g", status, ...extra });
const G = (text, extra = {}) => ({ id: "g", text, status: "done", ...extra });
assert.deepEqual(needsOwner(null), []);
assert.deepEqual(needsOwner(undefined), []);
assert.deepEqual(needsOwner({}), [], "a bare goal object has nothing to report");
assert.throws(() => needsOwner(G("x"), null), TypeError, "non-array jobs crashes the filter");
assert.throws(() => needsOwner(G("x"), [null]), TypeError, "a null job entry crashes on j.goal");
// All complaint kinds at once, in their fixed order.
const everything = {
  id: "g", text: "1. a\n2. b", status: "failed", needsOwner: "Pick a color",
};
assert.deepEqual(needsOwner(everything, [
  J(1, "conflict"), J(2, "finished"), J(3, "running"), J(4, "accepted", { items: [1] }),
]), [
  "she couldn't finish the goal",
  "Pick a color",
  "job 1 hit a merge conflict",
  "job 2 never got reviewed",
  "job 3 still running",
], "status flags first, then conflict, unreviewed, open; checklist skipped for failed goals");
// Pluralization is on the noun only; the verb stays singular.
assert.deepEqual(needsOwner(G("x"), [J(1, "conflict"), J(2, "conflict")]), ["jobs 1, 2 hit a merge conflict"]);
assert.deepEqual(needsOwner(G("x"), [J(1, "finished"), J(2, "finished")], { practice: true }),
  ["jobs 1, 2 never got reviewed"]);
assert.deepEqual(needsOwner(G("x"), [J(1, "held"), J(2, "waiting"), J(3, "running")]),
  ["jobs 1, 2, 3 still running"]);
// needsOwner flag coerces through String().
assert.deepEqual(needsOwner({ ...G("x"), needsOwner: 42 }), ["42"]);
assert.deepEqual(needsOwner({ ...G("x"), needsOwner: {} }), ["[object Object]"]);
assert.deepEqual(needsOwner({ ...G("x"), needsOwner: "" }), [], "empty flag is falsy: skipped");
// Open jobs are counted per-goal, not per-item: an untagged held job still stops the queue
// even when every checklist item is covered.
assert.deepEqual(needsOwner(G("1. a\n2. b"), [
  J(1, "accepted", { items: [1] }), J(2, "accepted", { items: [2] }), J(3, "held"),
]), ["job 3 still running"]);
// An unreviewed finished job is ALSO an unfinished checklist item: both are reported.
assert.deepEqual(needsOwner(G("1. a\n2. b"), [
  J(1, "accepted", { items: [1] }), J(2, "finished", { items: [2] }),
]), ["job 2 never got reviewed", "item 2 of the checklist not done"]);
// ...unless its summary marks it a practice run: then only the checklist speaks.
assert.deepEqual(needsOwner(G("1. a\n2. b"), [
  J(1, "accepted", { items: [1] }), J(2, "finished", { items: [2], summary: "(practice run: logged only)" }),
]), ["item 2 of the checklist not done"],
  "practice-summary finished jobs skip 'never got reviewed' even when practice=false");
// practice:true skips the checklist but NOT the direct job checks.
assert.deepEqual(needsOwner(G("1. a\n2. b"), [J(1, "conflict", { items: [1, 2] })], { practice: true }),
  ["job 1 hit a merge conflict"]);
// "sent back" is neither open nor merged: the item stays todo and the checklist flags it.
assert.deepEqual(needsOwner(G("1. a\n2. b"), [
  J(1, "accepted", { items: [1] }), J(2, "sent back", { items: [2] }),
]), ["item 2 of the checklist not done"]);
// A job tagged with an out-of-range item owns nothing on a multi-item goal.
assert.deepEqual(needsOwner(G("1. a\n2. b"), [
  J(1, "accepted", { items: [1] }), J(2, "accepted", { items: [99] }),
]), ["item 2 of the checklist not done"]);
// goal.items overrides text parsing; an empty items array falls back to the text.
assert.deepEqual(needsOwner(G("no list here", { items: ["x", "y"] }), [
  J(1, "accepted", { items: [1] }),
]), ["item 2 of the checklist not done"]);
assert.deepEqual(needsOwner(G("1. a\n2. b", { items: [] }), [
  J(1, "accepted", { items: [1] }), J(2, "accepted", { items: [2] }),
]), [], "empty items array falls back to parsing the text");
// A single-item goal never trips the checklist, however the item is written.
assert.deepEqual(needsOwner(G("1. only item"), []), []);
assert.deepEqual(needsOwner(G("just do it", { items: ["only"] }), [J(1, "accepted")]), []);
// checked ticks count even for items no job covered; out-of-range ticks are ignored.
assert.deepEqual(needsOwner(G("1. a\n2. b", { checked: { 2: "done it myself", 9: "bogus" } }), [
  J(1, "accepted", { items: [1] }),
]), [], "hand-ticked item 2 counts; tick 9 is harmless");
// Jobs for other goals (or with a different id type) are invisible.
assert.deepEqual(needsOwner(G("1. a\n2. b"), [
  J(1, "accepted", { items: [1] }), J(2, "accepted", { items: [2] }),
  { id: 9, goal: "other", status: "conflict" }, { id: 10, status: "running" },
]), [], "foreign and goal-less jobs don't count in needsOwner' own filters");
// goal.status values outside done/failed/stopped only surface needsOwner and job problems.
assert.deepEqual(needsOwner({ id: "g", text: "x", status: "paused" }, [J(1, "conflict")]),
  ["job 1 hit a merge conflict"], "paused goals still report job problems");
assert.deepEqual(needsOwner({ id: "g", text: "x", status: "running" }, []), [], "running goal: nothing yet");

// ---- Regression tests: bugs found while writing these tests, now fixed ---------------
// 1. moveGoal used to treat "", null, false and [] as position 0 (Number("") === 0), so an
//    empty or missing move target silently moved the goal to the TOP. It now throws like
//    any other bad target. Reachable from the CLI as `C goals move <id> ""`.
fresh();
const mv = addGoal(dir, { text: "mv", dir: "/mv" });
for (const bad of ["", "   ", null, false, [], {}]) {
  assert.throws(() => moveGoal(dir, mv.id, bad), /up, down/, `to=${JSON.stringify(bad)}`);
}
assert.deepEqual(readGoalQueue(dir).goals.map((g) => g.id), [mv.id], "rejected moves change nothing");
// Sanity: the still-valid targets keep working on the same goal.
moveGoal(dir, mv.id, "top");
moveGoal(dir, mv.id, 0);
assert.deepEqual(readGoalQueue(dir).goals.map((g) => g.id), [mv.id]);
// 2. editGoal(dir, id, { text: null }) used to write the literal string "null" as the goal
//    text. null is now ignored like undefined: a partial update that changes nothing.
const beforeNull = fs.readFileSync(qfile, "utf8");
editGoal(dir, mv.id, { text: null });
assert.equal(readGoalQueue(dir).goals[0].text, "mv", "text: null leaves the text alone");
assert.equal(fs.readFileSync(qfile, "utf8"), beforeNull, "a null-text edit changes nothing on disk");
editGoal(dir, mv.id, { text: null, dir: "/mv2" });
assert.equal(readGoalQueue(dir).goals[0].dir, "/mv2", "null text does not block a dir edit");
assert.throws(() => editGoal(dir, mv.id, { text: "" }), /empty/, "empty string still rejected");
// 3. LEFT AS-IS (documented disagreement, not clearly wrong): needsOwner matches jobs with
//    strict `j.goal === goal.id`, while checklist() also counts a job with NO `goal` field
//    (`!j.goal || j.goal === goal.id`). The active tests above pin goal-less jobs as NOT
//    counting in needsOwner' own filters (see the "foreign and goal-less jobs" case), every
//    job constance.mjs creates sets `goal`, and the two filters disagreeing is latent — so
//    the strict match stays:
// needsOwner({ id: "g", text: "1. a\n2. b", status: "done" }, [{ id: 9, status: "conflict" }], { practice: true });
// // currently returns [] — arguably should report "job 9 hit a merge conflict"

console.log("constance-goalqueue.deep: ok");
