// Constance's learning layer: the lessons file seeds itself on first read,
// lessons append deduped and capped, project rules come from the project's own
// .constance/rules.md, and every handoff carries the guardrail block.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLessons, addLesson, lessonsBlock, readProjectRules, projectRulesFile, rulesBlock, guardrailBlock, SEED_LESSONS } from "./constance-lessons.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-lessons-"));
const file = path.join(dir, "lessons.json");

// First read seeds the file with the owner's lessons; later reads return them.
const first = readLessons(dir);
assert.deepEqual(first, SEED_LESSONS);
assert.ok(fs.existsSync(file), "the lessons file is created on first read");
assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).lessons, SEED_LESSONS);
assert.deepEqual(readLessons(dir), SEED_LESSONS, "a second read returns the same list");
assert.ok(first.every((l) => typeof l === "string" && l.length > 10), "every seed is a real lesson");
assert.ok(SEED_LESSONS.some((l) => /queue/.test(l)), "the ready-task queue lesson is seeded");
assert.ok(SEED_LESSONS.some((l) => /notification/.test(l)), "the finished-notification lesson is seeded");
assert.ok(SEED_LESSONS.some((l) => /mktemp fake home/.test(l) && /\/tmp/.test(l)), "the fake-home/no-/tmp lesson is seeded");

// addLesson appends, dedupes and survives a fresh read.
addLesson("always run the build before reporting", dir);
addLesson("always run the build before reporting", dir);
const after = readLessons(dir);
assert.equal(after.filter((l) => l === "always run the build before reporting").length, 1, "duplicates are dropped");
assert.equal(after.length, SEED_LESSONS.length + 1);
assert.equal(after.at(-1), "always run the build before reporting", "newest lesson is last");
assert.equal(addLesson("   ", dir).length, after.length, "blank lessons are ignored");

// The cap keeps the newest lessons.
for (let i = 0; i < 80; i++) addLesson(`lesson number ${i}`, dir);
const capped = readLessons(dir);
assert.ok(capped.length <= 60, "the list stays bounded");
assert.equal(capped.at(-1), "lesson number 79");
assert.ok(!capped.includes("lesson number 0"), "oldest lessons fall off the end");

// lessonsBlock is advice-only text for the goal prompt.
const block = lessonsBlock(["a", "b"]);
assert.match(block, /advice only/i);
assert.match(block, /never override/i);
assert.match(block, /- a\n- b/);
assert.equal(lessonsBlock([]), "");

// Per-project rules live in <project>/.constance/rules.md, read fresh.
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "constance-proj-"));
assert.equal(readProjectRules(proj), "", "no rules file = no rules");
fs.mkdirSync(path.join(proj, ".constance"), { recursive: true });
fs.writeFileSync(projectRulesFile(proj), "Never edit generated files.\nTests must pass before commit.\n");
assert.equal(readProjectRules(proj), "Never edit generated files.\nTests must pass before commit.");
assert.match(rulesBlock(readProjectRules(proj)), /Never edit generated files/);
assert.match(rulesBlock("x"), /rules file/);
assert.equal(rulesBlock(""), "");

// Guardrails: allowed-files list, the hard bans, stop-and-report.
const g = guardrailBlock(["src/a.js", "src/b.js"]);
for (const needle of ["src/a.js, src/b.js", "mv or rm outside", "rm -rf", "git reset --hard", "force-push", "delete branches", "stop and say so"]) {
  assert.ok(g.includes(needle), `guardrail block mentions ${needle}`);
}
assert.match(guardrailBlock([]), /read-only/, "read-only jobs get an empty allowed list");
assert.match(guardrailBlock([]), /rm -rf/, "read-only jobs still carry the bans");

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(proj, { recursive: true, force: true });
console.log("constance-lessons: tests passed");
