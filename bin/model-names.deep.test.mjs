import assert from "node:assert/strict";
import { friendlyModels, prettyId } from "./model-names.mjs";

// model-names.mjs is pure (no fs, clock, or module state), so no temp HOME/XDG
// dirs are needed; nothing it touches lives on disk.

const row = (name, total = 0, extra = {}) => ({
  name, id: name, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  total, state: "used", removing: "", ...extra,
});

// ---- prettyId -------------------------------------------------------------

// Underscore separators and dash-separated version numbers merge the same way.
assert.equal(prettyId("gemini-3-8-flash"), "Gemini 3.8 Flash");
assert.equal(prettyId("gemini_3_8_flash"), "Gemini 3.8 Flash");
assert.equal(prettyId("gpt-5-1-codex-high"), "GPT 5.1 Codex High");

// Acronym table applies per word, including "oss" and "agy".
assert.equal(prettyId("gpt-oss-120b"), "GPT OSS 120b");
assert.equal(prettyId("agy-fast-lane"), "Antigravity Fast Lane");

// Repeated delimiters collapse; leading/trailing delimiters are dropped.
assert.equal(prettyId("a--b__c"), "A B C");
assert.equal(prettyId("--lead--trail--"), "Lead Trail");

// Only a single numeric run merges: once a word contains a dot, later numbers
// become their own words ("a-1-2-3" -> "A 1.2 3"). Documents current behavior.
assert.equal(prettyId("a-1-2-3"), "A 1.2 3");

// Non-string input is coerced through String().
assert.equal(prettyId(""), "");
assert.equal(prettyId(null), "Null");
assert.equal(prettyId(123), "123");

// ---- friendlyModels: degenerate input -------------------------------------

assert.deepEqual(friendlyModels(), []);
assert.deepEqual(friendlyModels([]), []);
assert.deepEqual(friendlyModels(null), []);

// A string is iterable, so each character passes through as an untouched row.
// Wrong-type input is tolerated here rather than rejected.
assert.deepEqual(friendlyModels("ab"), ["a", "b"]);

// Scalar (non-object) elements pass through untouched.
assert.deepEqual(friendlyModels([5, true, "x"]), [5, true, "x"]);

// BUG: friendlyModels([null]) throws "Cannot read properties of null (reading
// 'id')" — a single corrupt element crashes the whole call instead of being
// skipped or passed through. Same for undefined elements. Fix would be a
// null/undefined guard on each row; left unfixed per job rules.
// assert.deepEqual(friendlyModels([null]), [null]);
// assert.deepEqual(friendlyModels([undefined, row("ok-1")]), [undefined, row("ok-1")]);

// BUG: friendlyModels(42) throws "(rows || []) is not iterable" — a non-iterable
// wrong-type argument crashes instead of returning []. Same class of bug as
// above. Left unfixed per job rules.
// assert.deepEqual(friendlyModels(42), []);

// ---- friendlyModels: "unknown" rows ---------------------------------------

// Case-insensitive "unknown" becomes "Unlabeled usage" and keeps its row data.
const u = friendlyModels([row("UNKNOWN", 7), row("Unknown", 8)]);
assert.deepEqual(u.map((r) => r.name), ["Unlabeled usage", "Unlabeled usage"]);
assert.deepEqual(u.map((r) => r.total), [8, 7], "used rows sort by total desc");
assert.equal(u[0].tip, "the agent didn't name the model for these tokens.");

// Trailing whitespace defeats the anchored regex: "unknown " is not renamed and
// is not raw (space fails the raw pattern), so it passes through unchanged.
const spaced = friendlyModels([row("unknown ", 3)]);
assert.equal(spaced[0].name, "unknown ");
assert.equal(spaced[0].tip, undefined);

// Custom agent name appears in the tip; renamed row is a copy (rawId-free here
// because the unknown branch spreads without adding rawId).
const named = friendlyModels([row("unknown", 1)], "Grok");
assert.equal(named[0].tip, "Grok didn't name the model for these tokens.");

// "unknown" wins over worker grouping even when the id says worker.
const unkWorker = friendlyModels([row("unknown", 1, { id: "worker-9" })]);
assert.equal(unkWorker.length, 1);
assert.equal(unkWorker[0].name, "Unlabeled usage");

// ---- friendlyModels: background worker grouping ---------------------------

// Grouping requires BOTH /worker/i on the effective id AND a raw-looking name.
// id falls back to name only when r.id is falsy.
const w1 = friendlyModels([row("gemini-x-worker", 5)]);
assert.equal(w1[0].name, "Background workers");
assert.equal(w1[0].id, "background-workers");
assert.equal(w1[0].total, 5);
assert.equal(w1[0].state, "used");
assert.equal(w1[0].removing, "");
assert.match(w1[0].tip, /gemini-x-worker/);

// A present id that lacks "worker" disables grouping even if the name has it.
const w2 = friendlyModels([row("gemini-x-worker", 5, { id: "plain-id" })]);
assert.equal(w2[0].name, "Gemini X Worker");
assert.equal(w2[0].rawId, "gemini-x-worker");

// Worker match on id is case-insensitive.
const w3 = friendlyModels([row("raw-model-1", 4, { id: "Worker-7" })]);
assert.equal(w3[0].name, "Background workers");

// A named (non-raw) row is never grouped even with a worker-ish id.
const w4 = friendlyModels([row("Gemini Flash", 5, { id: "worker-1" })]);
assert.equal(w4[0].name, "Gemini Flash");

// Uppercase names are not raw, so "Gemini-Worker" stays a normal row.
const w5 = friendlyModels([row("Gemini-Worker", 5, { id: "worker-2" })]);
assert.equal(w5[0].name, "Gemini-Worker");

// Totals: numeric strings coerce, non-numeric becomes 0; the group sums only
// the SUM keys and ignores everything else on the worker rows.
const w6 = friendlyModels([
  row("a-worker", "10", { extra: 999 }),
  row("b-worker", "abc", { total: undefined }),
]);
assert.equal(w6[0].total, 10);
assert.equal(w6[0].input + w6[0].output + w6[0].cacheRead + w6[0].cacheWrite, 0);
assert.equal(w6[0].state, "used"); // total > 0

// All-zero workers produce a "zero"-state group.
const w7 = friendlyModels([row("a-worker", 0), row("b-worker", 0)]);
assert.equal(w7[0].name, "Background workers");
assert.equal(w7[0].state, "zero");
assert.equal(w7[0].total, 0);

// No workers -> no group row at all.
assert.equal(friendlyModels([row("Named Model", 3)]).length, 1);

// ---- friendlyModels: sorting ------------------------------------------------

// used rows sort by total desc; zero keeps insertion order; unavailable last.
// The worker group participates in the same sort by its own state/total.
const sorted = friendlyModels([
  row("z-row", 10, { state: "used" }),
  row("a-row", 99, { state: "used" }),
  row("zero1", 0, { state: "zero" }),
  row("gone", 0, { state: "unavailable" }),
  row("zero2", 0, { state: "zero" }),
  row("w1-worker", 50),
  row("w2-worker", 50),
]);
assert.deepEqual(sorted.map((r) => [r.name, r.state, r.total]), [
  ["Background workers", "used", 100],
  ["A Row", "used", 99],
  ["Z Row", "used", 10],
  ["zero1", "zero", 0],
  ["zero2", "zero", 0],
  ["gone", "unavailable", 0],
]);

// A zero-total worker group sorts after other zero rows (it is appended last)
// and before unavailable rows.
const sortedZero = friendlyModels([
  row("gone", 0, { state: "unavailable" }),
  row("zero1", 0, { state: "zero" }),
  row("a-worker", 0),
]);
assert.deepEqual(sortedZero.map((r) => r.name), ["zero1", "Background workers", "gone"]);

// A state outside the rank table does not crash; it lands after known states.
const weird = friendlyModels([
  row("m", 0, { state: "bogus" }),
  row("n-2", 3, { state: "used" }),
]);
assert.deepEqual(weird.map((r) => r.name), ["N 2", "m"]);

// Renamed rows keep every original field; untouched rows keep their identity.
const src = [row("raw-model-x", 4), row("Named Model", 2)];
const renamed = friendlyModels(src);
assert.equal(renamed[1], src[1], "non-raw row passes through by reference");
assert.equal(renamed[0].name, "Raw Model X");
assert.equal(renamed[0].rawId, "raw-model-x");
assert.equal(renamed[0].total, 4);
assert.equal(src[0].rawId, undefined, "input row is not mutated");

// ---- friendlyModels: no shared state / repeat calls -------------------------

// The module holds no state between calls: interleaved calls with different
// inputs cannot contaminate each other.
const inputs = [
  [row("gemini-a-worker", 1), row("unknown", 2)],
  [row("gpt-oss-120b", 3)],
  [row("claude-x-worker", 4, { id: "WORKER-1" })],
];
const expected = inputs.map((rows) => friendlyModels(rows));
for (let i = 0; i < 200; i++) {
  for (let j = 0; j < inputs.length; j++) {
    assert.deepEqual(friendlyModels(inputs[j]), expected[j]);
  }
}

console.log("model-names deep ok");
