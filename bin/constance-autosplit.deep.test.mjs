// Deeper edge-case tests for constance-autosplit.mjs: goal-text shapes parseItems
// hands down (CRLF, bullets, non-item lines, >2-digit numbers, empty/non-string
// goals), the module-name regex's boundary quirks, `files`/`scorecard` wrong types,
// cap-note ordering, padding candidate filtering and `overlaps` on malformed job
// lists. The module is pure (no fs, net or agents, no shared state between calls),
// so there are no timing races to race; the mkdtemp HOME/XDG dirs below are set
// anyway so nothing here can ever reach the real home folder. Nothing the module
// reads lives on disk — its "input files" are the `files` array option.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-autosplit-deep-"));
for (const v of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  const p = path.join(dir, v.toLowerCase());
  fs.mkdirSync(p, { recursive: true });
  process.env[v] = p;
}
const { autosplit, overlaps } = await import("./constance-autosplit.mjs");

const MODULE_FILES = [
  "bin/constance-alpha.mjs", "bin/constance-alpha.test.mjs",
  "bin/constance-beta.mjs",
  "bin/constance-gamma.mjs", "bin/constance-gamma.test.mjs",
];
// One numbered item naming `text`; returns the job's claimed files.
const filesForText = (text, opts = {}) => autosplit(`1. ${text}`, { files: [], min: 0, ...opts })[0].files;

// ---- goal text edges (what parseItems hands autosplit) -------------------------
assert.deepEqual(autosplit("", { files: MODULE_FILES, min: 0 }), [], "empty goal, min 0");
assert.deepEqual(autosplit(undefined, { files: MODULE_FILES, min: 0 }), [], "undefined goal");
// null/number goals are String()-coerced into a one-item goal — including the text.
assert.equal(autosplit(null, { files: [], min: 0 })[0].task, "null");
assert.equal(autosplit(42, { files: [], min: 0 })[0].task, "42");
// CRLF line endings split items the same as LF.
const crlf = autosplit("1. fix bin/constance-crlf.mjs\r\n2. other", { files: [], min: 0 });
assert.equal(crlf.length, 2);
assert.deepEqual(crlf[0].files, ["bin/constance-crlf.mjs", "bin/constance-crlf.test.mjs"]);
// ITEM markers are \d{1,2}: "100." is not a marker, so the whole goal is one item
// and keeps its literal "1. "/"100. " text (whitespace collapsed).
const hundred = autosplit("1. a\n100. b", { files: [], min: 0 });
assert.equal(hundred.length, 1);
assert.equal(hundred[0].task, "1. a 100. b");
assert.equal(hundred[0].item, 1);
// -, * and • bullets all count; item numbers are positions, not printed numbers.
const bullets = autosplit("- a\n* b\n• c", { files: [], min: 0 });
assert.deepEqual(bullets.map((j) => [j.item, j.title]), [[1, "a"], [2, "b"], [3, "c"]]);
assert.deepEqual(autosplit("3. a\n7. b", { files: [], min: 0 }).map((j) => j.item), [1, 2]);
// A lone bullet goal is still one item — and keeps its "- " prefix verbatim.
assert.equal(autosplit("- lone", { files: [], min: 0 })[0].task, "- lone");
// A module named only on an item's indented continuation line still counts.
const cont = autosplit("1. fix the bug\n   see bin/constance-cont.mjs\n2. other", { files: [], min: 0 });
assert.deepEqual(cont[0].files, ["bin/constance-cont.mjs", "bin/constance-cont.test.mjs"]);
// Module names in non-item lines (preamble/trailer) are ignored entirely.
const pre = autosplit("preamble mentions bin/constance-pre.mjs\n1. a\n2. b", { files: [], min: 0 });
assert.ok(pre.every((j) => j.files.length === 0), "preamble module names no files");
// min pads but never truncates: more items than min keeps every item job.
assert.equal(autosplit("1. a\n2. b\n3. c\n4. d\n5. e", { files: [], min: 2 }).length, 5);
// An empty goal still pads to min when candidates exist — the jobs are all
// item:null deeper-test jobs with no checklist item behind them.
const emptyPad = autosplit("", { files: ["bin/constance-pad.mjs"], min: 2 });
assert.equal(emptyPad.length, 1, "one candidate, min 2: pads once then runs out");
assert.ok(emptyPad.every((j) => j.item === null));
// Options omitted entirely: files/scorecard/agent/min all default (min 15, but an
// empty file list leaves no padding candidates).
assert.equal(autosplit("1. a\n2. b").length, 2);
// Titles clip at 60 chars with an ellipsis; 60 exactly is left alone.
assert.equal(autosplit(`1. ${"x".repeat(60)}`, { files: [], min: 0 })[0].title.length, 60);
const clipped = autosplit(`1. ${"x".repeat(61)}`, { files: [], min: 0 })[0].title;
assert.equal(clipped.length, 60);
assert.ok(clipped.endsWith("…"));

// ---- the module-name regex's edges --------------------------------------------
// A hyphenated prefix still matches: "my-constance-bar.mjs" is read as naming
// constance-bar (\b sits between "-" and "c"). Documented, possibly over-broad.
assert.deepEqual(filesForText("see my-constance-bar.mjs"), ["bin/constance-bar.mjs", "bin/constance-bar.test.mjs"]);
// ".mjs" inside a longer dotted name still matches the module up to the first .mjs.
assert.deepEqual(filesForText("see constance-x.mjs.mjs"), ["bin/constance-x.mjs", "bin/constance-x.test.mjs"]);
assert.deepEqual(filesForText("see constance-x.mjs.bak"), ["bin/constance-x.mjs", "bin/constance-x.test.mjs"]);
// ...and test-file mentions never match: ".test"/".deep.test" break the \b/.mjs pair.
assert.deepEqual(filesForText("see constance-t1.test.mjs and constance-t2.deep.test.mjs"), []);
// Non-matches: glued prefix, wrong case, empty name, trailing word char.
for (const s of ["xconstance-foo.mjs", "CONSTANCE-FOO.mjs", "constance-.mjs", "constance-x.mjs5"]) {
  assert.deepEqual(filesForText(`see ${s}`), [], s);
}
// "./bin/" and even "bin//" prefixes still resolve to the bare module name.
assert.deepEqual(filesForText("see ./bin/constance-y.mjs"), ["bin/constance-y.mjs", "bin/constance-y.test.mjs"]);
assert.deepEqual(filesForText("see bin//constance-z.mjs"), ["bin/constance-z.mjs", "bin/constance-z.test.mjs"]);
// Repeats within one item dedupe; two modules keep mention order.
assert.deepEqual(filesForText("constance-d.mjs and constance-d.mjs again"), ["bin/constance-d.mjs", "bin/constance-d.test.mjs"]);
// Two modules keep mention order (a roomy scorecard row so the default cap of 2
// files doesn't drop the second pair).
assert.deepEqual(filesForText("constance-b2.mjs then constance-a2.mjs",
  { scorecard: [{ agent: "g", name: "G", jobs: 4, accepted: 4, sentBack: 0, acceptRate: 1, avgTokens: null, avgMs: null }], agent: "g" }), [
  "bin/constance-b2.mjs", "bin/constance-b2.test.mjs", "bin/constance-a2.mjs", "bin/constance-a2.test.mjs",
]);

// ---- the `files` option: normalization, coercion, wrong types ------------------
// "./bin/x" is normalized, so an existing module brings no test file.
const norm = autosplit("1. fix bin/constance-norm.mjs", { files: ["./bin/constance-norm.mjs"], min: 0 });
assert.deepEqual(norm[0].files, ["bin/constance-norm.mjs"]);
// Only ONE "./" is stripped: "././bin/x" stays unrecognized and the module is
// treated as new (its test file is claimed too).
const dbl = autosplit("1. fix bin/constance-dbl.mjs", { files: ["././bin/constance-dbl.mjs"], min: 0 });
assert.deepEqual(dbl[0].files, ["bin/constance-dbl.mjs", "bin/constance-dbl.test.mjs"]);
// Non-string entries are String()-coerced; junk entries are inert.
const junk = autosplit("1. fix bin/constance-j.mjs", { files: [null, 42, "./bin/constance-j.mjs"], min: 0 });
assert.deepEqual(junk[0].files, ["bin/constance-j.mjs"]);
// A module is "new" unless bin/<name>.mjs itself is listed — its .test.mjs being
// present changes nothing (filesFor only checks the module path).
const testOnly = autosplit("1. fix bin/constance-tonly.mjs", { files: ["bin/constance-tonly.test.mjs"], min: 0 });
assert.deepEqual(testOnly[0].files, ["bin/constance-tonly.mjs", "bin/constance-tonly.test.mjs"]);
// Wrong-typed `files` throws a TypeError (map is called unguarded).
for (const bad of [null, "bin/x", new Set(["bin/x"]), 42]) {
  assert.throws(() => autosplit("1. a", { files: bad, min: 0 }), TypeError, JSON.stringify(String(bad)));
}
// Duplicate entries in `files` collapse (Set), and the input array is not mutated.
const dupFiles = ["bin/constance-p1.mjs", "bin/constance-p1.mjs"];
const before = [...dupFiles];
autosplit("1. x", { files: dupFiles, min: 3 });
assert.deepEqual(dupFiles, before);

// ---- scorecard row selection and the file cap ----------------------------------
const mkRow = (over) => ({ agent: "g", name: "G", jobs: 4, accepted: 4, sentBack: 0, acceptRate: 1, avgTokens: null, avgMs: null, ...over });
// agent given but absent from the scorecard: row null -> maxFiles 2, "no scorecard record".
const noRow = autosplit("1. add bin/constance-x1.mjs and bin/constance-x2.mjs and bin/constance-x3.mjs",
  { files: [], scorecard: [mkRow({ agent: "other" })], agent: "g", min: 0 })[0];
assert.deepEqual(noRow.files, ["bin/constance-x1.mjs", "bin/constance-x1.test.mjs"]);
assert.match(noRow.notes[0], /capped at 2 files \(no scorecard record\): dropped bin\/constance-x2\.mjs, bin\/constance-x2\.test\.mjs, bin\/constance-x3\.mjs, bin\/constance-x3\.test\.mjs/);
// scorecard rows that are null are skipped only when agent is set; with agent null
// the FIRST row is taken verbatim, so [null] means no record -> maxFiles 2.
const nullRow = autosplit("1. add bin/constance-y1.mjs and bin/constance-y2.mjs and bin/constance-y3.mjs",
  { files: [], scorecard: [null], min: 0 })[0];
assert.deepEqual(nullRow.files, ["bin/constance-y1.mjs", "bin/constance-y1.test.mjs"]);
assert.match(nullRow.notes[0], /no scorecard record/);
// Wrong-typed scorecard: {} has no .find (agent set -> throws); with agent null
// row is ({} || [])[0] -> undefined -> treated as no record. A truthy non-array
// like "abc" becomes the row itself: sizeHint sees no .jobs -> maxFiles 2, and
// capNote interpolates row.name ?? row.agent -> "scorecard: undefined".
assert.throws(() => autosplit("1. a", { files: [], scorecard: {}, agent: "x", min: 0 }), TypeError);
const scObj = autosplit("1. add bin/constance-z1.mjs and bin/constance-z2.mjs and bin/constance-z3.mjs",
  { files: [], scorecard: {}, min: 0 })[0];
assert.match(scObj.notes[0], /no scorecard record/);
const scStr = autosplit("1. add bin/constance-w1.mjs and bin/constance-w2.mjs and bin/constance-w3.mjs",
  { files: [], scorecard: "abc", min: 0 })[0];
assert.match(scStr.notes[0], /capped at 2 files \(scorecard: undefined\)/);
// A reliable but slow row (avgMs > 20 min) drops one slot: maxFiles 3.
const slowRel = autosplit("1. add bin/constance-s1.mjs and bin/constance-s2.mjs",
  { files: [], scorecard: [mkRow({ avgMs: 21 * 60e3 })], agent: "g", min: 0 })[0];
assert.deepEqual(slowRel.files, ["bin/constance-s1.mjs", "bin/constance-s1.test.mjs", "bin/constance-s2.mjs"]);
assert.match(slowRel.notes[0], /capped at 3 files \(scorecard: G\): dropped bin\/constance-s2\.test\.mjs/);
// sizeHint boundaries seen through the cap: acceptRate exactly 0.8 is reliable
// (4 files, no cap); acceptRate null with jobs counts as reliable too.
for (const row of [mkRow({ acceptRate: 0.8 }), mkRow({ acceptRate: null })]) {
  const j = autosplit("1. add bin/constance-q1.mjs and bin/constance-q2.mjs",
    { files: [], scorecard: [row], agent: "g", min: 0 })[0];
  assert.equal(j.files.length, 4, `acceptRate ${row.acceptRate}`);
  assert.ok(!j.notes, "no cap note at maxFiles 4");
}
// maxFiles 1 keeps only the FIRST raw file — a new module's own .test.mjs is
// dropped by the cap along with everything after it.
const oneFile = autosplit("1. add bin/constance-f1.mjs and bin/constance-f2.mjs",
  { files: [], scorecard: [mkRow({ accepted: 1, sentBack: 2, acceptRate: 1 / 3 })], agent: "g", min: 0 })[0];
assert.deepEqual(oneFile.files, ["bin/constance-f1.mjs"]);
assert.match(oneFile.notes[0], /dropped bin\/constance-f1\.test\.mjs, bin\/constance-f2\.mjs, bin\/constance-f2\.test\.mjs/);
// Note ordering: "stays with job N" claims are reported before the cap note,
// and the cap note comes last even when both fire on the same job.
const both = autosplit(
  "1. add bin/constance-n1.mjs\n2. fix bin/constance-n1.mjs and add bin/constance-n2.mjs bin/constance-n3.mjs bin/constance-n4.mjs",
  { files: [], scorecard: [mkRow({})], agent: "g", min: 0 });
assert.equal(both.length, 2);
assert.deepEqual(both[1].notes, [
  "bin/constance-n1.mjs stays with job 1",
  "bin/constance-n1.test.mjs stays with job 1",
  "capped at 4 files (scorecard: G): dropped bin/constance-n4.mjs, bin/constance-n4.test.mjs",
]);
assert.deepEqual(both[1].files, ["bin/constance-n2.mjs", "bin/constance-n2.test.mjs", "bin/constance-n3.mjs", "bin/constance-n3.test.mjs"]);

// ---- deeper-test padding ---------------------------------------------------------
// Pad jobs come in `files` array order (Set insertion order), duplicates collapse,
// and "./bin/" entries normalize into candidates.
const padOrder = autosplit("1. x", {
  files: ["bin/constance-p2.mjs", "./bin/constance-p1.mjs", "bin/constance-p1.mjs"], min: 3 })
  .slice(1).map((j) => j.title);
assert.deepEqual(padOrder, ["Deeper test: bin/constance-p2.mjs", "Deeper test: bin/constance-p1.mjs"]);
// Non-candidates: *.test.mjs (incl. *.deep.test.mjs), non-constance names, a bare
// "constance-.mjs" (nothing between dash and .mjs), trailing-space and uppercase
// entries — while "bin/constance-w.mjs.mjs" IS a candidate and gets the odd deep
// name "bin/constance-w.mjs.deep.test.mjs" (deepTest only swaps the last .mjs).
const padSkip = autosplit("1. x", {
  files: [
    "bin/constance-s1.test.mjs", "bin/constance-s2.deep.test.mjs", "bin/notconstance-x.mjs",
    "bin/constance-.mjs", "bin/constance-s3.mjs ", "BIN/constance-s4.mjs", "bin/other.mjs",
    "bin/constance-w.mjs.mjs",
  ], min: 10 }).slice(1);
assert.deepEqual(padSkip.map((j) => j.title), ["Deeper test: bin/constance-w.mjs.mjs"]);
assert.deepEqual(padSkip[0].files, ["bin/constance-w.mjs.mjs", "bin/constance-w.mjs.deep.test.mjs"]);
// min is a `<` comparison: exactly-met min pads nothing, NaN pads nothing, a
// numeric string coerces, and a fraction pads up to the next whole job (ceil).
assert.equal(autosplit("1. a\n2. b", { files: ["bin/constance-m1.mjs"], min: 2 }).length, 2);
assert.equal(autosplit("1. a", { files: ["bin/constance-m2.mjs"], min: NaN }).length, 1);
assert.equal(autosplit("1. a", { files: ["bin/constance-m3.mjs"], min: "2" }).length, 2);
assert.equal(autosplit("1. a", { files: ["bin/constance-m4.mjs", "bin/constance-m5.mjs"], min: 2.5 }).length, 3);
// A clean pad job carries no notes key at all; its task names the deep file and
// the min it padded toward.
const cleanPad = autosplit("1. a", { files: ["bin/constance-c1.mjs"], min: 2 })[1];
assert.ok(!("notes" in cleanPad));
assert.equal(cleanPad.item, null);
assert.match(cleanPad.task, /minimum of 2 jobs/);
assert.match(cleanPad.task, /constance-c1\.deep\.test\.mjs/);

// ---- overlaps on malformed input -----------------------------------------------
assert.deepEqual(overlaps(null), []);
assert.deepEqual(overlaps(undefined), []);
assert.deepEqual(overlaps([{}]), [], "job without files key");
assert.deepEqual(overlaps([{ files: [] }, { files: null }]), []);
// Output is sorted by file name; a file listed twice in ONE job counts once.
assert.deepEqual(overlaps([{ files: ["z", "a", "z", "b"] }, { files: ["m", "a", "b"] }]), ["a", "b"]);
// Wrong types: a non-iterable jobs arg or a non-iterable files value throws.
assert.throws(() => overlaps(5), TypeError);
assert.throws(() => overlaps([{ files: 5 }]), TypeError);
// A string `files` is iterated as characters — "aa" and "a" "overlap" on "a".
// Silently wrong but only reachable with hand-built jobs; autosplit never emits
// string file lists.
assert.deepEqual(overlaps([{ files: "aa" }, { files: "a" }]), ["a"]);
// overlaps does not mutate its input.
const ovJobs = [{ files: ["b", "a"] }, { files: ["a"] }];
overlaps(ovJobs);
assert.deepEqual(ovJobs, [{ files: ["b", "a"] }, { files: ["a"] }]);
// overlaps() counts claiming jobs, not file occurrences — a single job that
// lists the same file twice is NOT an overlap. autosplit()'s own output never
// has duplicates (take() dedupes), so this only shows on hand-built or foreign
// job lists:
assert.deepEqual(overlaps([{ files: ["a", "a"] }]), []);

// ---- purity / stale state -------------------------------------------------------
// Two calls with the same args return identical, independent results — the
// `claimed` map is per-call, so there is no stale state between invocations.
const shared = { files: ["bin/constance-r1.mjs", "bin/constance-r2.mjs"], scorecard: [mkRow({})], agent: "g", min: 4 };
const run1 = autosplit("1. add bin/constance-r1.mjs and bin/constance-r2.mjs", shared);
const run2 = autosplit("1. add bin/constance-r1.mjs and bin/constance-r2.mjs", shared);
assert.deepEqual(run1, run2);
assert.notEqual(run1, run2);
run1[0].files.push("tampered");
assert.ok(!run2[0].files.includes("tampered"), "mutating one result can't leak into the next call");
// scorecard rows are not mutated by the lookup either.
const scBefore = JSON.stringify(shared.scorecard);
autosplit("1. x", shared);
assert.equal(JSON.stringify(shared.scorecard), scBefore);

fs.rmSync(dir, { recursive: true, force: true });
console.log("constance-autosplit.deep: ok");
