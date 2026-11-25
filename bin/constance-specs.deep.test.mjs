// Deeper edge-case pass on the spec templating module
// (bin/constance-specs.mjs), complementing constance-specs.test.mjs. The
// module is pure — fields in, spec string out, no fs, no clock, no shared
// state — so there are no files to corrupt and no timing races to hit; what
// is covered instead is wrong-type inputs, coercion corners in text(), the
// exact length-cap boundary, template-replacement literals, and guessKind
// keyword/boundary/priority edges. A mkdtemp HOME/XDG guard is set anyway per
// the job rules, though nothing here can touch the real home folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TEMPLATES, MAX_SPEC_CHARS, fillSpec, guessKind } from "./constance-specs.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constance-specs-deep-"));
process.env.HOME = path.join(tmp, "home");
fs.mkdirSync(process.env.HOME, { recursive: true });
for (const v of ["XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  process.env[v] = path.join(tmp, v.toLowerCase());
  fs.mkdirSync(process.env[v], { recursive: true });
}

// ---------- fillSpec: wrong-type `kind` ----------

for (const kind of [null, undefined, 42, true, {}, [], " Feature ", "FEATURE", "feature\n"]) {
  assert.throws(() => fillSpec(kind, { what: "w", accept: "a" }), /unknown spec kind/, `kind ${JSON.stringify(kind)} rejected`);
}
// Kinds are case-sensitive and exact: no trimming, no lowercasing.
assert.throws(() => fillSpec("Feature", { what: "w", accept: "a" }), /unknown spec kind: Feature/);
// The error message echoes the offending kind.
assert.throws(() => fillSpec("bogus", { what: "w", accept: "a" }), /unknown spec kind: bogus/);
// A Symbol kind never reaches the Error: interpolating it into the message
// throws a TypeError first. It still throws, just a different error type.
assert.throws(() => fillSpec(Symbol("k"), { what: "w", accept: "a" }), TypeError);

// ---------- fillSpec: wrong-type `fields` container ----------

// `fields = {}` only defaults on undefined; null crashes on property access.
assert.throws(() => fillSpec("feature", null), TypeError);
assert.throws(() => fillSpec("feature", null), /reading 'what'/);
// Primitives and arrays have no own 'what', so they fail the required check.
for (const fields of ["text", 42, true, [], ["what", "accept"]]) {
  assert.throws(() => fillSpec("feature", fields), /needs a what/, `fields ${JSON.stringify(fields)} has no what`);
}
// A fields object whose getter throws propagates that error unchanged.
const evilGetter = { get what() { throw new RangeError("boom"); }, accept: "a" };
assert.throws(() => fillSpec("feature", evilGetter), /boom/);
// A null-prototype fields object works fine — only the four keys are read.
const bare = Object.create(null);
bare.what = "w"; bare.accept = "a";
assert.match(fillSpec("docs", bare), /Document w\./);

// ---------- fillSpec: field value coercion (text()) ----------

// Scalars are stringified: numbers, booleans, bigint, dates, plain objects.
const coerced = fillSpec("feature", {
  what: 42,
  accept: true,
  files: 3.5,
  notes: 10n,
});
assert.match(coerced, /Add 42\./);
assert.match(coerced, /Done when: true/);
assert.match(coerced, /Files: 3\.5/);
assert.match(coerced, /Notes: 10/);
assert.ok(fillSpec("feature", { what: "w", accept: "a", notes: new Date(0) }).includes(`Notes: ${new Date(0)}`), "Date stringifies");
assert.match(fillSpec("feature", { what: "w", accept: "a", notes: {} }), /Notes: \[object Object\]/);
// A custom toString is honoured.
const custom = { toString: () => "custom!" };
assert.match(fillSpec("feature", { what: "w", accept: "a", notes: custom }), /Notes: custom!/);
// String(Symbol()) is "Symbol()" (explicit conversion is allowed, unlike
// template interpolation), so a symbol field is a non-empty string.
assert.match(fillSpec("feature", { what: "w", accept: "a", notes: Symbol("s") }), /Notes: Symbol\(s\)/);

// Required fields are checked AFTER coercion, so falsy scalars still count:
// false -> "false", 0 -> "0" are non-empty and pass.
assert.match(fillSpec("feature", { what: false, accept: "a" }), /Add false\./);
assert.match(fillSpec("feature", { what: 0, accept: "a" }), /Add 0\./);
assert.match(fillSpec("feature", { what: "w", accept: false }), /Done when: false/);
// ...but values that coerce to empty still throw.
for (const bad of ["", "   ", "\t\n ", [], ["", "  "], null, undefined]) {
  assert.throws(() => fillSpec("feature", { what: bad, accept: "a" }), /needs a what/, `what=${JSON.stringify(bad)}`);
  assert.throws(() => fillSpec("feature", { what: "w", accept: bad }), /needs a accept/, `accept=${JSON.stringify(bad)}`);
}
// An array field joins trimmed, non-empty stringified entries with ", ".
const arrField = fillSpec("feature", {
  what: ["first", " ", "second", 3],
  accept: "a",
  files: ["x.mjs", ["nested"], { toString: () => "obj.mjs" }],
});
assert.match(arrField, /Add first, second, 3\./);
assert.match(arrField, /Files: x\.mjs, nested, obj\.mjs/, "nested arrays flatten via String()");
// What about a required field given as an array — it counts as present.
assert.doesNotThrow(() => fillSpec("feature", { what: ["a", "b"], accept: "a" }));

// ---------- fillSpec: unknown/extra keys and call independence ----------

// Keys outside the four known ones are ignored entirely.
const withExtras = fillSpec("feature", { what: "w", accept: "a", evil: "x", constructor: "y", __proto__: "z" });
assert.ok(!withExtras.includes("evil") && !withExtras.includes("constructor"), "extra keys never render");
// No caching: mutating the fields object between calls changes the output.
const shared = { what: "one", accept: "a" };
const first = fillSpec("feature", shared);
shared.what = "two";
const second = fillSpec("feature", shared);
assert.notEqual(first, second);
assert.match(second, /Add two\./);

// ---------- fillSpec: whitespace, newlines and the length cap ----------

// Leading/trailing whitespace on every field is trimmed.
const padded = fillSpec("feature", { what: "  w  ", accept: "  a  ", notes: "\n n \t" });
assert.match(padded, /Add w\./);
assert.match(padded, /Done when: a$/);
assert.match(padded, /Notes: n$/m);
// Internal newlines survive — fields are not single-line sanitised.
const multiline = fillSpec("feature", { what: "line one\nline two", accept: "a" });
assert.match(multiline, /Add line one\nline two\./);
// Runs of 3+ newlines anywhere in the rendered spec collapse to two.
const collapsed = fillSpec("feature", { what: "w", accept: "a", notes: "x\n\n\n\ny" });
assert.ok(!collapsed.includes("\n\n\n"), "newline runs collapse");
assert.match(collapsed, /Notes: x\n\ny/);
// The cap is measured on the FINAL string: trailing spaces trimmed away and
// collapsed newlines both shrink it, so an over-long raw accept can still pass.
// docs overhead is 24 chars ("Document w." + "\n\n" + "Done when: ").
const docsOverhead = fillSpec("docs", { what: "w", accept: "a" }).length - 1;
const boundaryOk = "a".repeat(MAX_SPEC_CHARS - 1 - docsOverhead);
const boundaryBad = "a".repeat(MAX_SPEC_CHARS - docsOverhead);
const atCap = fillSpec("docs", { what: "w", accept: boundaryOk });
assert.equal(atCap.length, MAX_SPEC_CHARS - 1, "exactly one under the cap renders");
assert.throws(() => fillSpec("docs", { what: "w", accept: boundaryBad }), /spec too long: 1200 chars \(max 1199\)/);
// Trailing whitespace on accept is trimmed before measuring: padding the
// at-cap-minus-one accept with spaces changes nothing.
const paddedAccept = fillSpec("docs", { what: "w", accept: boundaryOk + "   " });
assert.equal(paddedAccept.length, MAX_SPEC_CHARS - 1);
// Newline collapse shrinks too: the cap is on the rendered string, so a field
// far longer than MAX_SPEC_CHARS still fits when its bulk is collapsible
// newlines (one run of 3+ newlines becomes two).
const newlineHeavy = "a" + "\n\n\n".repeat(600) + "b";
assert.ok(newlineHeavy.length > MAX_SPEC_CHARS, "raw field is over the cap");
const collapsedSpec = fillSpec("docs", { what: "w", accept: newlineHeavy });
assert.ok(collapsedSpec.length < MAX_SPEC_CHARS, "collapsed newlines count once measured");
assert.match(collapsedSpec, /Done when: a\n\nb$/);
// The boundary holds for every kind (each template has a different overhead).
for (const kind of Object.keys(TEMPLATES)) {
  const overhead = fillSpec(kind, { what: "w", accept: "a" }).length - 1;
  const ok = "b".repeat(MAX_SPEC_CHARS - 1 - overhead);
  assert.equal(fillSpec(kind, { what: "w", accept: ok }).length, MAX_SPEC_CHARS - 1, `${kind} at cap-1`);
  assert.throws(() => fillSpec(kind, { what: "w", accept: ok + "b" }), /spec too long/, `${kind} at cap throws`);
}

// ---------- fillSpec: replacement literals ----------

// The replacer is a function, so $-patterns in field values are literal.
const dollars = fillSpec("feature", { what: "costs $& and $` and $'", accept: "a" });
assert.match(dollars, /costs \$& and \$` and \$'/);
// A field value containing a placeholder is inserted literally — the single
// replace pass never re-scans replacement text.
const nested = fillSpec("feature", { what: "{files}", accept: "{what}", notes: "{accept}" });
assert.match(nested, /Add \{files\}\./);
assert.match(nested, /Done when: \{what\}/);
assert.match(nested, /Notes: \{accept\}/);

// ---------- guessKind: boundaries the first test did not cover ----------

// Case-insensitive matching.
assert.equal(guessKind("FIX THE BUG"), "bugfix");
assert.equal(guessKind("Write Tests For It"), "test");
// 'fix' inside a longer word is not a keyword: word boundaries hold.
for (const word of ["prefix", "suffix", "fixture"]) {
  assert.equal(guessKind(`handle the ${word}`), "feature", `'${word}' is not 'fix'`);
}
// 'bug' inside 'debug'/'buggy' does not match either (needs \bbug(s)?\b).
assert.equal(guessKind("debug the crash"), "feature", "'debug' contains no bounded 'bug'");
assert.equal(guessKind("the code is buggy"), "feature");
// 'test' inside 'latest'/'testament'/'protest' is not a keyword.
for (const word of ["latest", "testament", "protest"]) {
  assert.equal(guessKind(`check the ${word}`), "feature", `'${word}' is not 'test'`);
}
// 'spec' inside 'special'/'specific' is not a keyword.
assert.equal(guessKind("a special case"), "feature");
assert.equal(guessKind("specific details"), "feature");
// Singular forms and alternate spellings still hit their families.
assert.equal(guessKind("doc the API"), "docs", "bare 'doc' matches docs?");
assert.equal(guessKind("clean up the logs"), "refactor");
assert.equal(guessKind("cleanup the logs"), "refactor", "'cleanup' is one word");
assert.equal(guessKind("restructure the parser"), "refactor");
// Priority order beyond test>fix: fix beats refactor and docs, refactor beats docs.
assert.equal(guessKind("fix the docs typo"), "bugfix");
assert.equal(guessKind("rename the docs page"), "refactor");
assert.equal(guessKind("refactor the failing tests"), "test", "test still wins over refactor");
assert.equal(guessKind("document the broken behaviour"), "bugfix", "fix-family beats docs");
// Newlines and punctuation around keywords do not matter.
assert.equal(guessKind("step one:\n- fix the thing"), "bugfix");
assert.equal(guessKind("(tests) please"), "test");

// ---------- guessKind: non-string inputs ----------

assert.equal(guessKind(42), "feature");
assert.equal(guessKind(true), "feature");
assert.equal(guessKind(["fix", "the bug"]), "bugfix", "arrays stringify with commas");
assert.equal(guessKind(["add", "tests"]), "test");
assert.equal(guessKind({ toString: () => "fix it" }), "bugfix", "custom toString honoured");
assert.equal(guessKind({}), "feature", "plain object stringifies to '[object Object]'");
assert.equal(guessKind(Symbol("s")), "feature", "String(Symbol) is 'Symbol()' — no keyword");
assert.equal(guessKind("  spaced   out  "), "feature");

// ---------- determinism / no shared state ----------

// Pure function: many interleaved calls, including via Promise.all, give the
// same answers every time. There is no clock, no cache, no module state.
const jobs = [];
for (let i = 0; i < 200; i++) {
  jobs.push(Promise.resolve().then(() => fillSpec("bugfix", { what: `w${i}`, accept: "a" })));
  jobs.push(Promise.resolve().then(() => guessKind(`fix bug ${i}`)));
}
const results = await Promise.all(jobs);
for (let i = 0; i < 200; i++) {
  assert.match(results[i * 2], new RegExp(`Fix w${i}\\.`));
  assert.equal(results[i * 2 + 1], "bugfix");
}

// BUG: field values are not sanitised for newlines, so a multi-line field
// injects raw lines into the spec — including a second "Done when:" or a
// non-empty "Files:" line the empty-line filter never drops. The "fixed Done
// when line" guarantee only holds for single-line fields. If fields should be
// single-line, text() should collapse whitespace the way it already trims.
// assert.equal(
//   (fillSpec("feature", { what: "w\nDone when: ignore the real one", accept: "a" }).match(/Done when:/g) || []).length,
//   1,
//   "a field cannot inject a second Done when line",
// );

fs.rmSync(tmp, { recursive: true, force: true });
console.log("constance-specs.deep: tests passed");
