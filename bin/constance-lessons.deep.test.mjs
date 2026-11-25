// Deeper edge-case pass on Constance's learning layer (bin/constance-lessons.mjs):
// corrupt and odd lessons.json shapes, the tidied marker's exact semantics,
// duplicate and very long lessons, the MERGED fold's case sensitivity, and
// per-project rules.md quirks. Complements constance-lessons.test.mjs. State
// dirs are mktemp; nothing touches a real home, network or agent CLI.
//
// One suspected bug (lessons.json existing as a directory crashes readLessons
// instead of seeding) is pinned in a commented-out test and reported, not fixed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLessons, addLesson, tidyLessons, lessonsFile, lessonsBlock, readProjectRules, projectRulesFile, rulesBlock, guardrailBlock, SEED_LESSONS, MERGED } from "./constance-lessons.mjs";

const mkstate = () => fs.mkdtempSync(path.join(os.tmpdir(), "constance-lessons-deep-"));
const mkproj = () => fs.mkdtempSync(path.join(os.tmpdir(), "constance-proj-deep-"));
const writeRaw = (dir, data) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "lessons.json"), typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n");
};
const readFile = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "lessons.json"), "utf8"));
const dirs = [];
const state = () => { const d = mkstate(); dirs.push(d); return d; };
const proj = () => { const d = mkproj(); dirs.push(d); return d; };

// ===================================================== corrupt / odd files -> seed
// Anything that is not {"lessons": [non-empty strings]} reseeds the file.
for (const [name, raw] of [
  ["invalid JSON", "{not json at all"],
  ["truncated JSON", '{"lessons": ["a", "b"'],
  ["JSON null", "null"],
  ["JSON array", "[]"],
  ["JSON string", '"just a string"'],
  ["JSON number", "42"],
  ["lessons not an array", { lessons: "nope" }],
  ["lessons null", { lessons: null }],
  ["empty lessons array", { lessons: [] }],
  ["only blank strings", { lessons: ["   ", "\n\t", ""] }],
  ["only non-strings", { lessons: [42, null, true, {}, []] }],
]) {
  const d = state();
  writeRaw(d, raw);
  assert.deepEqual(readLessons(d), SEED_LESSONS, `${name}: reseeds`);
  const f = readFile(d);
  assert.deepEqual(f.lessons, SEED_LESSONS, `${name}: file rewritten with seeds`);
  assert.equal(f.tidied, 1, `${name}: rewritten file carries the tidied marker`);
}

// An untidied file keeps only its valid string lessons; non-strings drop out.
{
  const d = state();
  writeRaw(d, { lessons: [42, null, "  padded lesson  ", "", "second"] });
  assert.deepEqual(readLessons(d), ["  padded lesson  ", "second"], "non-strings and blanks are filtered, padding kept");
  assert.equal(readFile(d).tidied, 1, "the untidied read writes the marker back");
}

// A file whose only lesson maps to null through MERGED tidies to empty and
// therefore reseeds — the file is treated as having no usable lessons.
{
  const d = state();
  writeRaw(d, { lessons: ["One agent per project folder at a time."] });
  assert.deepEqual(readLessons(d), SEED_LESSONS, "all-obsolete file reseeds");
}

// ============================================================ the tidied marker
// tidied === 1 is trusted verbatim: no re-tidy, no dedupe, no MERGED fold.
{
  const d = state();
  writeRaw(d, { lessons: ["dup", "dup", "Dup.", "One agent per project folder at a time."], tidied: 1 });
  assert.deepEqual(readLessons(d), ["dup", "dup", "Dup.", "One agent per project folder at a time."], "tidied files are returned as stored");
}
// Any other truthy/falsy value for tidied goes through the untidied path.
for (const tidied of ["1", true, 2, 0, null]) {
  const d = state();
  writeRaw(d, { lessons: ["B", "b."], tidied });
  assert.deepEqual(readLessons(d), ["B"], `tidied=${JSON.stringify(tidied)} is not the marker: untidied path dedupes`);
  assert.equal(readFile(d).tidied, 1, `tidied=${JSON.stringify(tidied)}: rewritten with the real marker`);
}
// A tidied file over the cap returns the newest 20 but is NOT rewritten.
{
  const d = state();
  const many = Array.from({ length: 25 }, (_, i) => `long lesson ${i}`);
  writeRaw(d, { lessons: many, tidied: 1 });
  const before = fs.readFileSync(path.join(d, "lessons.json"), "utf8");
  const r = readLessons(d);
  assert.equal(r.length, 20);
  assert.equal(r[0], "long lesson 5");
  assert.equal(r.at(-1), "long lesson 24");
  assert.equal(fs.readFileSync(path.join(d, "lessons.json"), "utf8"), before, "over-cap tidied file is read but not rewritten");
}
// An untidied over-cap file is tidied AND capped on read.
{
  const d = state();
  const many = Array.from({ length: 25 }, (_, i) => `cap me ${i}`);
  writeRaw(d, { lessons: many });
  const r = readLessons(d);
  assert.equal(r.length, 20);
  assert.equal(r[0], "cap me 5");
  assert.equal(readFile(d).lessons.length, 20, "the rewrite stores the capped list");
  assert.equal(readFile(d).tidied, 1);
}

// ============================================================ duplicates
// Exact duplicates never stack, even across reads and adds.
{
  const d = state();
  addLesson("repeat this lesson", d);
  addLesson("repeat this lesson", d);
  addLesson("  repeat this lesson  ", d); // trims to the same string
  const r = readLessons(d);
  assert.equal(r.filter((l) => l === "repeat this lesson").length, 1, "exact dupes collapse");
}
// Normalized near-dupes merge through tidyLessons on every write.
{
  const d = state();
  addLesson("Always   Run   THE build.", d);
  addLesson("always run the build!", d);
  const r = readLessons(d);
  assert.equal(r.filter((l) => /always\s+run\s+the\s+build/i.test(l)).length, 1, "punctuation/case/space dupes merge");
}
// MERGED is an exact, case-sensitive lookup: the old lesson folds into its
// seed; a differently-cased copy is just an unknown lesson.
{
  const d = state();
  const old = "Check the report against every item in the handoff and send back anything skipped.";
  assert.equal(MERGED[old], SEED_LESSONS[2]);
  addLesson(old, d);
  const r = readLessons(d);
  assert.equal(r.filter((l) => l === SEED_LESSONS[2]).length, 1, "old lesson folded into the seed, not duplicated");
  assert.ok(!r.includes(old), "the old wording is gone");
  const d2 = state();
  addLesson(old.toLowerCase(), d2);
  assert.ok(readLessons(d2).includes(old.toLowerCase()), "lowercased old lesson is NOT in MERGED and survives");
}
// Adding an old lesson to a fresh dir is a no-op: seeds already hold the fold.
{
  const d = state();
  const res = addLesson(Object.keys(MERGED)[0], d);
  assert.deepEqual(res, SEED_LESSONS, "folded lesson dedupes against the seed");
}

// ============================================================ very long lessons
// There is no per-lesson length cap: a huge lesson is stored verbatim.
{
  const d = state();
  const huge = "x".repeat(50_000);
  const kept = addLesson(huge, d);
  assert.equal(kept.at(-1), huge, "a 50k-char lesson is stored whole");
  assert.equal(readLessons(d).at(-1), huge, "and survives a fresh read");
  assert.ok(fs.statSync(path.join(d, "lessons.json")).size > 50_000, "the file really grew");
  // The count cap still applies to long lessons.
  const d2 = state();
  for (let i = 0; i < 25; i++) addLesson(`long ${i} ` + "y".repeat(2000), d2);
  const r2 = readLessons(d2);
  assert.equal(r2.length, 20, "count cap holds regardless of lesson size");
  assert.ok(r2.at(-1).startsWith("long 24 "));
}
// Lessons with newlines are stored verbatim (the block renders them raw).
{
  const d = state();
  addLesson("first line\nsecond line", d);
  assert.ok(readLessons(d).includes("first line\nsecond line"));
  assert.match(lessonsBlock(readLessons(d)), /- first line\nsecond line/, "newline passes through into the block unescaped");
}

// ============================================================ tidyLessons deep
assert.deepEqual(tidyLessons("not an array"), [], "non-array input tidies to empty");
assert.deepEqual(tidyLessons([1, null, {}, "ok"]), ["ok"], "non-string items are skipped");
assert.deepEqual(tidyLessons([]), []);
// The guardrail cap keys on "<word> broke a guardrail on job": a lesson with
// no agent-ish first token is NOT counted, so it is never dropped as an old guard.
{
  const noPrefix = Array.from({ length: 5 }, (_, i) => `broke a guardrail on job n${i}: thing`);
  const out = tidyLessons(noPrefix);
  assert.equal(out.length, 5, "guardrail-shaped lessons without a prefix are not treated as guards");
  const withPrefix = Array.from({ length: 5 }, (_, i) => `agy broke a guardrail on job p${i}: thing`);
  const out2 = tidyLessons(withPrefix);
  assert.equal(out2.length, 3, "prefixed guardrail lessons still cap at the newest 3");
  assert.deepEqual(out2.map((l) => l.match(/job (\S+)/)[1]), ["p2:", "p3:", "p4:"], "newest three by position win");
}
// Guardrail lessons interleaved with normal ones: only guards are capped.
{
  const mixed = [
    "a broke a guardrail on job 1: x", "normal one", "b broke a guardrail on job 2: x",
    "normal two", "c broke a guardrail on job 3: x", "d broke a guardrail on job 4: x",
  ];
  const out = tidyLessons(mixed);
  assert.deepEqual(out, ["normal one", "b broke a guardrail on job 2: x", "normal two", "c broke a guardrail on job 3: x", "d broke a guardrail on job 4: x"], "oldest guard dropped, normals untouched, positions kept");
}
// normLesson strips trailing punctuation but NOT an ellipsis: "…" survives.
assert.deepEqual(tidyLessons(["same lesson…", "same lesson"]), ["same lesson…", "same lesson"], "ellipsis is not normalized away (current behaviour)");

// ============================================================ project rules deep
{
  const p = proj();
  assert.equal(readProjectRules(p), "", "no .constance dir = no rules");
  fs.mkdirSync(path.join(p, ".constance"));
  fs.writeFileSync(projectRulesFile(p), "   \n\t  \n");
  assert.equal(readProjectRules(p), "", "whitespace-only rules read as none");
  fs.writeFileSync(projectRulesFile(p), "﻿BOM start rule.\n");
  assert.equal(readProjectRules(p), "BOM start rule.", "BOM is trimmed like whitespace");
  fs.rmSync(projectRulesFile(p));
  fs.mkdirSync(projectRulesFile(p)); // rules.md as a directory
  assert.equal(readProjectRules(p), "", "unreadable rules file = no rules, no throw");
}
{
  const p = proj();
  fs.mkdirSync(path.join(p, ".constance"), { recursive: true });
  fs.writeFileSync(projectRulesFile(p), "line one\n\nline three\n");
  assert.equal(readProjectRules(p), "line one\n\nline three", "interior blank lines kept, edges trimmed");
  assert.match(rulesBlock("line one\n\nline three"), /line one\n\nline three/, "rulesBlock preserves newlines");
  assert.equal(rulesBlock("   "), "", "whitespace rules block is empty");
  assert.equal(rulesBlock(null), "", "null rules block is empty");
}

// ============================================================ blocks
assert.match(guardrailBlock([]), /\(none — this is a read-only job\)/);
assert.match(guardrailBlock([]), /may only create or change these files: \(none/);
{
  const many = Array.from({ length: 30 }, (_, i) => `f${i}.js`);
  const g = guardrailBlock(many);
  assert.ok(g.includes("f0.js, f1.js"), "file list joins with commas");
  assert.ok(g.includes("f29.js"), "all files listed");
}
assert.match(lessonsBlock(["only"]), /^\nLessons from your earlier goals/);
assert.equal(lessonsBlock([]), "");
assert.equal(lessonsFile(state()), path.join(dirs.at(-1), "lessons.json"), "lessonsFile joins dir + lessons.json");

// SUSPECTED BUG (reported, not fixed — this job is test-only): when
// lessons.json exists but is a directory, readFileSync throws EISDIR, the
// catch falls through to seeding, and writeLessons' renameSync(tmp, dir)
// throws EISDIR — readLessons crashes instead of returning the seeds, despite
// the "missing or unreadable: seed below" comment promising recovery.
// Verified by hand: readLessons() throws "EISDIR: illegal operation on a
// directory, rename ...". addLesson() hits the same wall via writeLessons.
// {
//   const d = state();
//   fs.mkdirSync(path.join(d, "lessons.json"));
//   assert.deepEqual(readLessons(d), SEED_LESSONS, "a directory named lessons.json should reseed, not crash");
// }

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log("constance-lessons.deep: tests passed");
