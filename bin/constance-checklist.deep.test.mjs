// Deeper edge-case pass on the goal checklist (bin/constance-checklist.mjs),
// complementing constance-checklist.test.mjs. The module is pure, so the fake
// HOME under mktemp is only a guard so nothing can ever touch the real one.
// Covers what the first test leaves out: malformed goal/job shapes, marker and
// numbering boundaries, continuation-line rules, state precedence, practice
// detection and jobs that belong to no goal. Suspected bugs are commented out
// with a note, not fixed (this job is test-only).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseItems, parseItemArg, jobItems, checklist } from "./constance-checklist.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constance-checklist-deep-"));
process.env.HOME = path.join(tmp, "home");
fs.mkdirSync(process.env.HOME, { recursive: true });

// ---------- parseItems: markers and numbering ----------

// CRLF endings split the same as LF.
assert.deepEqual(parseItems("1. a\r\n2. b\r\n"), ["a", "b"]);
// Every marker shape: "N.", "N)", "-", "*", "•" — each needs whitespace after.
assert.deepEqual(parseItems("1. a\n2) b\n- c\n* d\n• e"), ["a", "b", "c", "d", "e"]);
assert.deepEqual(parseItems("1.\ta\n2. b"), ["a", "b"], "a tab counts as the separating space");
assert.deepEqual(parseItems("1.x\n2.y"), ["1.x 2.y"], "no space after the marker: not items, whole text is one item");
assert.deepEqual(parseItems("1)\tx\n2. y"), ["x", "y"], "tab after ')' works too");
// Numbers are 1-2 digits: 0 and 99 are items, 100 is not (its "10" leaves "0." behind).
assert.deepEqual(parseItems("0. zero\n99. ninety-nine"), ["zero", "ninety-nine"]);
assert.deepEqual(parseItems("100. big\n2. two"), ["100. big 2. two"], "a 3-digit 'number' is not a marker; one real item means the whole text is the item");
assert.deepEqual(parseItems("123) x\n2. y"), ["123) x 2. y"]);
// Item numbers are ignored entirely: duplicates and gaps still parse.
assert.deepEqual(parseItems("1. a\n1. b\n7. c"), ["a", "b", "c"]);
// A bullet line with no text after the marker is not an item.
assert.deepEqual(parseItems("- \n- \n1. a\n2. b"), ["a", "b"], "empty bullet lines are dropped, not items");
// Marker characters outside the set are plain text.
assert.deepEqual(parseItems("◦ a\n‣ b"), ["◦ a ‣ b"], "other bullet glyphs are not markers");
assert.deepEqual(parseItems("— a\n– b"), ["— a – b"], "dashes are not bullets");

// ---------- parseItems: continuation lines ----------

// An indented line right after an item continues it; several join with one space.
assert.deepEqual(parseItems("1. a\n   continued\n\tmore\n2. b"), ["a continued more", "b"]);
// An indented line that itself looks like a marker still continues, marker text included.
assert.deepEqual(parseItems("1. a\n  - nested\n2. b"), ["a - nested", "b"]);
// A blank or whitespace-only line ends the continuation; the next indented line is dropped.
assert.deepEqual(parseItems("1. a\n   cont\n\n   orphan\n2. b"), ["a cont", "b"]);
// A non-indented plain line ends the continuation and is ignored (preamble/closing).
assert.deepEqual(parseItems("1. a\n   cont\nnote\n   dropped\n2. b"), ["a cont", "b"]);
// An indented line before the first item has nothing to continue and is ignored.
assert.deepEqual(parseItems("  lead-in\n1. a\n2. b"), ["a", "b"]);
// Trailing spaces on an item are stripped; internal spacing is kept.
assert.deepEqual(parseItems("1.   spaced   out   \n2. b"), ["spaced   out", "b"]);

// ---------- parseItems: degenerate inputs ----------

assert.deepEqual(parseItems(null), ["null"], "null stringifies to 'null', which is one item");
assert.deepEqual(parseItems(42), ["42"]);
assert.deepEqual(parseItems("   \n  \n"), [], "whitespace-only text has no items");
// One real item plus malformed lines: fewer than 2 items means the WHOLE text is the item.
assert.deepEqual(parseItems("1. only\n2.nope\n3.also-nope"), ["1. only 2.nope 3.also-nope"]);
// Exactly two items means the preamble and closing lines vanish entirely.
assert.deepEqual(parseItems("do the thing\n1. a\n2. b\nthen commit"), ["a", "b"]);
// A lone \r is not a line break: the whole blob is one line, hence one item.
assert.deepEqual(parseItems("1. a\r2. b"), ["1. a 2. b"], "a lone \\r is not a line break; the collapsed fallback eats it");

// ---------- parseItemArg ----------

assert.deepEqual(parseItemArg("1,2"), [1, 2]);
assert.deepEqual(parseItemArg("1 2 3"), [1, 2, 3], "whitespace separates too");
assert.deepEqual(parseItemArg("1,,2"), [1, 2], "empty segments are dropped");
assert.deepEqual(parseItemArg(5), [5], "a bare number works");
assert.deepEqual(parseItemArg(null), []);
assert.deepEqual(parseItemArg(undefined), []);
assert.deepEqual(parseItemArg({}), [], "an object stringifies to garbage and filters out");
assert.deepEqual(parseItemArg("Infinity"), []);
assert.deepEqual(parseItemArg("-3"), [], "negatives are dropped");
assert.deepEqual(parseItemArg("1.5"), [], "non-integers are dropped");
assert.deepEqual(parseItemArg("3.0"), [3], "3.0 is integer-valued");
assert.deepEqual(parseItemArg("0x2"), [2], "hex parses as a number (quirk, harmless here)");
assert.deepEqual(parseItemArg("1e1"), [10], "exponent notation parses too");
assert.deepEqual(parseItemArg([null, undefined, NaN, "2", "2.5"]), [2]);
assert.deepEqual(parseItemArg("9,9,1"), [1, 9], "deduped and sorted");
assert.deepEqual(parseItemArg("1\n2"), [1, 2], "newlines separate as well");
assert.deepEqual(parseItemArg("999999999"), [999999999], "no upper bound on the item number itself");

// ---------- jobItems ----------

assert.deepEqual(jobItems({ items: "2" }, 4), [2], "a string tag parses like an array");
assert.deepEqual(jobItems({ items: [2.0] }, 4), [2]);
assert.deepEqual(jobItems({ items: null }, 4), []);
assert.deepEqual(jobItems({ items: "abc" }, 4), []);
assert.deepEqual(jobItems({ items: [0, -1] }, 4), [], "non-positive tags are dropped before the count check");
assert.deepEqual(jobItems({ items: [9] }, 1), [1], "an out-of-range tag on a one-item goal still owns it");
assert.deepEqual(jobItems({ items: [9] }, 4), [], "but not on a multi-item goal");
assert.deepEqual(jobItems({ items: [1, 2] }, 2), [1, 2], "multi-item tags count for each");
assert.deepEqual(jobItems({}, 0), [], "a zero-item goal owns nothing");
assert.throws(() => jobItems(null, 1), TypeError, "a null job crashes (callers never pass one)");

// ---------- checklist: goal shapes ----------

assert.deepEqual(checklist(undefined, []), { items: [], done: 0, total: 0, line: "" });
assert.deepEqual(checklist({}, []), { items: [], done: 0, total: 0, line: "0 of 0 done" }, "a goal with no text and no items has zero items");
assert.deepEqual(checklist({ id: "g", text: "" }, []).line, "0 of 0 done");
assert.deepEqual(checklist({ id: "g", text: null }, []).total, 1, "null text stringifies to 'null', one item");
assert.equal(checklist({ id: "g", text: "1. a\n2. b", items: [] }, []).total, 2, "an EMPTY stored items list falls back to parsing the text");
assert.deepEqual(checklist({ id: "g", items: [1, 2] }, [{ id: "j", goal: "g", items: [2], status: "accepted" }]).items.map((x) => x.state), ["todo", "done"], "stored items need no text at all");

// ---------- checklist: state precedence ----------

const goal2 = { id: "g", text: "1. a\n2. b\n3. c\n4. d" };
const J = (items, status, extra = {}) => ({ id: Math.random().toString(36).slice(2), goal: "g", items, status, ...extra });
// Every OPEN status blocks "done by jobs"; only a finished one yields "review".
for (const st of ["waiting", "held", "running"]) {
  const c = checklist(goal2, [J([1], "accepted"), J([1], st)]);
  assert.equal(c.items[0].state, "working", `accepted + ${st} is still working`);
}
assert.equal(checklist(goal2, [J([1], "finished")]).items[0].state, "review");
assert.equal(checklist(goal2, [J([1], "sent back")]).items[0].state, "todo", "sent back is neither open nor merged");
assert.equal(checklist(goal2, [J([1], "accepted"), J([1], "finished"), J([1], "running")]).items[0].state, "review", "a finished job outranks running ones for 'review'");
// Conflict beats merged jobs, but her own tick beats a conflict.
assert.equal(checklist(goal2, [J([1], "accepted"), J([1], "conflict")]).items[0].state, "problem", "conflict wins over a merged sibling");
assert.equal(checklist({ ...goal2, checked: { 1: "did it" } }, [J([1], "conflict")]).items[0].state, "done", "her tick wins over everything");
// checked[] marks done for ANY defined value — including false/null. Callers only
// ever write a non-empty note string (constance.mjs: `note || "done by Constance"`),
// so this is a documented quirk, not a live bug.
assert.equal(checklist({ ...goal2, checked: { 1: false } }, []).items[0].state, "done", "checked:false still counts as ticked (quirk)");
assert.equal(checklist({ ...goal2, checked: { 1: null } }, []).items[0].state, "done", "checked:null still counts as ticked (quirk)");
assert.equal(checklist({ ...goal2, checked: { 1: "" } }, []).items[0].state, "done", "an empty-string note still ticks, note stays ''");
assert.equal(checklist({ ...goal2, checked: { 1: 42 } }, []).items[0].note, "42", "a non-string note is stringified");
// checked keys are strings; numeric and string lookups are the same slot.
assert.equal(checklist({ ...goal2, checked: { "1": "x" } }, []).items[0].state, "done");
// checked for an item number that does not exist is simply ignored.
assert.equal(checklist(goal2, []).total, 4);
assert.equal(checklist({ ...goal2, checked: { 9: "ghost" } }, []).done, 0);

// ---------- checklist: which jobs count ----------

// A job with no goal field counts for every goal; an empty-string goal does too.
assert.equal(checklist(goal2, [{ id: "j", items: [1], status: "accepted" }]).items[0].state, "done", "goal-less job counts");
assert.equal(checklist(goal2, [{ id: "j", goal: "", items: [1], status: "accepted" }]).items[0].state, "done", "empty goal id counts for all");
assert.equal(checklist(goal2, [{ id: "j", goal: "other", items: [1], status: "accepted" }]).items[0].state, "todo", "another goal's job does not count");
// Two goals' jobs side by side: only the matching goal's jobs apply.
const c2 = checklist({ id: "gA", text: "1. a\n2. b" }, [
  { id: "j1", goal: "gA", items: [1], status: "accepted" },
  { id: "j2", goal: "gB", items: [2], status: "accepted" },
]);
assert.deepEqual(c2.items.map((x) => x.state), ["done", "todo"]);
// A job tagged for several items lands in each item's jobs list.
const c3 = checklist(goal2, [J([1, 3], "accepted")]);
assert.deepEqual(c3.items[0].jobs.length, 1);
assert.deepEqual(c3.items[2].jobs.length, 1);
assert.deepEqual(c3.items.map((x) => x.state), ["done", "todo", "done", "todo"]);
// Untagged jobs on a multi-item goal belong to nothing.
assert.equal(checklist(goal2, [J([], "accepted")]).done, 0);
assert.equal(checklist({ id: "g", text: "only item" }, [J([], "accepted")]).done, 1, "single-item goal: untagged job still counts");
// items on a job can be a comma string, same as the delegate arg.
assert.equal(checklist(goal2, [J("2", "accepted")]).items[1].state, "done");

// ---------- checklist: practice detection ----------

// isPractice is a case-sensitive prefix match on summary starting "(practice run".
assert.equal(checklist({ id: "g", text: "1. a\n2. b" }, [{ id: "j", goal: "g", items: [1], status: "accepted", summary: "(practice run: nothing launched)" }]).done, 0);
assert.equal(checklist({ id: "g", text: "1. a\n2. b" }, [{ id: "j", goal: "g", items: [1], status: "accepted", summary: "(Practice run: capital P)" }]).done, 1, "capital P is NOT practice — it counts as merged");
assert.equal(checklist({ id: "g", text: "1. a\n2. b" }, [{ id: "j", goal: "g", items: [1], status: "accepted", summary: "practice run without paren" }]).done, 1, "no leading paren: not practice either");
assert.equal(checklist({ id: "g", text: "1. a\n2. b" }, [{ id: "j", goal: "g", items: [1], status: "accepted" }]).done, 1, "no summary at all: a real merge");
// A practice accepted job is not open either, so it leaves the item plain todo.
assert.equal(checklist({ id: "g", text: "1. a\n2. b" }, [{ id: "j", goal: "g", items: [1], status: "accepted", summary: "(practice run x)" }]).items[0].state, "todo");

// ---------- checklist: result shape ----------

const full = checklist({ id: "g", text: "1. a\n2. b" }, [{ id: "j1", goal: "g", items: [1], status: "accepted" }, { id: "j2", goal: "g", items: [2], status: "finished" }]);
assert.equal(full.line, "1 of 2 done");
assert.equal(full.total, 2);
assert.equal(full.done, 1);
assert.deepEqual(full.items[0].jobs, ["j1"]);
assert.deepEqual(full.items[1].jobs, ["j2"]);
assert.equal(full.items[1].by, "");
// Duplicate job ids appear twice in the jobs list (cosmetic; callers use unique ids).
const dup = checklist({ id: "g", text: "1. a\n2. b" }, [
  { id: "j", goal: "g", items: [1], status: "accepted" },
  { id: "j", goal: "g", items: [1], status: "accepted" },
]);
assert.deepEqual(dup.items[0].jobs, ["j", "j"]);
// A job missing fields entirely is tolerated: no items, no goal, unknown status.
assert.equal(checklist({ id: "g", text: "1. a\n2. b" }, [{}]).done, 0);
assert.throws(() => checklist({ id: "g", text: "1. a\n2. b" }, null), TypeError, "jobs:null crashes (callers always pass an array)");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("constance-checklist.deep: ok");
