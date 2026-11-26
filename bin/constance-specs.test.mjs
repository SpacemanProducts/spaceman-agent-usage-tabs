import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TEMPLATES, MAX_SPEC_CHARS, fillSpec, guessKind } from "./constance-specs.mjs";

// The module is pure (fields in, spec string out), so nothing touches the real
// home folder; a mktemp HOME is set anyway per the job rules.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "constance-specs-"));
process.env.HOME = home;

// Every template renders for every kind and keeps its fixed "Done when:" line.
for (const kind of Object.keys(TEMPLATES)) {
  const spec = fillSpec(kind, {
    what: "the thing",
    files: "bin/foo.mjs",
    accept: "tests pass",
    notes: "keep it small",
  });
  assert.ok(spec.length > 0, `${kind} renders`);
  assert.ok(spec.length < MAX_SPEC_CHARS, `${kind} under the cap`);
  assert.match(spec, /Done when: tests pass/, `${kind} keeps the Done when line`);
  assert.match(spec, /the thing/, `${kind} fills what`);
  assert.match(spec, /bin\/foo\.mjs/, `${kind} fills files`);
  assert.match(spec, /keep it small/, `${kind} fills notes`);
}

// Empty optional sections are stripped; required ones still show.
for (const kind of Object.keys(TEMPLATES)) {
  const spec = fillSpec(kind, { what: "w", accept: "a" });
  assert.doesNotMatch(spec, /^Files:/m, `${kind} drops the empty Files line`);
  assert.doesNotMatch(spec, /^Notes:/m, `${kind} drops the empty Notes line`);
  assert.match(spec, /Done when: a/, `${kind} still ends with Done when`);
}
const onlyNotes = fillSpec("feature", { what: "w", accept: "a", notes: "n" });
assert.doesNotMatch(onlyNotes, /^Files:/m, "files dropped when only notes given");
assert.match(onlyNotes, /^Notes: n$/m, "notes kept when given");

// files accepts an array too.
const arr = fillSpec("test", { what: "w", accept: "a", files: ["a.mjs", "b.mjs"] });
assert.match(arr, /Files: a\.mjs, b\.mjs/, "array files join with commas");

// Unknown kind throws.
assert.throws(() => fillSpec("nope", { what: "w", accept: "a" }), /unknown spec kind/);
assert.throws(() => fillSpec("", { what: "w", accept: "a" }), /unknown spec kind/);

// Missing or empty required fields throw, per kind.
for (const kind of Object.keys(TEMPLATES)) {
  assert.throws(() => fillSpec(kind, { accept: "a" }), /needs a what/, `${kind} needs what`);
  assert.throws(() => fillSpec(kind, { what: "w" }), /needs a accept/, `${kind} needs accept`);
  assert.throws(() => fillSpec(kind, { what: "  ", accept: "a" }), /needs a what/, `${kind} blank what`);
  assert.throws(() => fillSpec(kind, { what: "w", accept: "" }), /needs a accept/, `${kind} blank accept`);
}
assert.throws(() => fillSpec("feature"), /needs a what/, "no fields at all throws");

// Over the cap throws: a giant accept on the longest template.
const big = "x".repeat(MAX_SPEC_CHARS);
assert.throws(() => fillSpec("feature", { what: "w", accept: big }), /spec too long/);
// Just under the cap still works.
const near = fillSpec("docs", { what: "w", accept: "a".repeat(1100) });
assert.ok(near.length < MAX_SPEC_CHARS);

// guessKind: each keyword family maps to its kind, first match wins.
assert.equal(guessKind("add unit tests for the parser"), "test");
assert.equal(guessKind("write a spec for retries"), "test");
assert.equal(guessKind("fix the login crash"), "bugfix");
assert.equal(guessKind("there is a bug in collect.mjs"), "bugfix");
assert.equal(guessKind("fix the broken retry loop"), "bugfix", "fix and broken agree");
assert.equal(guessKind("refactor the queue module"), "refactor");
assert.equal(guessKind("rename the panel tiles"), "refactor");
assert.equal(guessKind("update the docs for settings"), "docs");
assert.equal(guessKind("write a README section"), "docs");
assert.equal(guessKind("add a dark-mode toggle"), "feature");
assert.equal(guessKind(""), "feature");
assert.equal(guessKind(null), "feature");
assert.equal(guessKind(undefined), "feature");
// A test mention beats a later fix mention.
assert.equal(guessKind("fix the tests that fail"), "test", "test keyword wins over fix");

fs.rmSync(home, { recursive: true, force: true });
console.log("constance-specs: tests passed");
