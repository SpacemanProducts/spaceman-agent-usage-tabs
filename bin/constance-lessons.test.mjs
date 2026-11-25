// Constance's learning layer: the lessons file seeds itself on first read,
// pre-tidy files are folded through tidyLessons once, lessons append tidied and
// capped, project rules come from the project's own .constance/rules.md, and
// every handoff carries the guardrail block.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLessons, addLesson, tidyLessons, lessonsBlock, readProjectRules, projectRulesFile, rulesBlock, guardrailBlock, SEED_LESSONS, MERGED } from "./constance-lessons.mjs";

const mkstate = () => fs.mkdtempSync(path.join(os.tmpdir(), "constance-lessons-"));
const writeRaw = (dir, lessons, tidied) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "lessons.json"), JSON.stringify(tidied ? { lessons, tidied: 1 } : { lessons }, null, 2) + "\n");
};

// First read seeds the file with the seven seed lessons, marked tidied.
const dir = mkstate();
const first = readLessons(dir);
assert.deepEqual(first, SEED_LESSONS);
assert.equal(SEED_LESSONS.length, 7, "the seed is the seven cleaned-up lines");
assert.ok(fs.existsSync(path.join(dir, "lessons.json")), "the lessons file is created on first read");
const seeded = JSON.parse(fs.readFileSync(path.join(dir, "lessons.json"), "utf8"));
assert.deepEqual(seeded.lessons, SEED_LESSONS);
assert.equal(seeded.tidied, 1, "the seeded file carries the tidied marker");
assert.deepEqual(readLessons(dir), SEED_LESSONS, "a second read returns the same list");
assert.ok(first.every((l) => typeof l === "string" && l.length > 10), "every seed is a real lesson");
assert.ok(SEED_LESSONS.some((l) => /ready queue/.test(l)), "the ready-task queue lesson is seeded");
assert.ok(SEED_LESSONS.some((l) => /notification/.test(l)), "the finished-notification lesson is seeded");
assert.ok(SEED_LESSONS.some((l) => /mktemp fake home/.test(l) && /\/tmp/.test(l)), "the fake-home/no-/tmp lesson is seeded");

// The old 11-line file (nine old seeds + restart line + Top 10 line) tidies to
// exactly the seven new lines; a second read leaves it unchanged.
const oldSeeds = [
  "Keep free agents busy: keep a short queue of ready tasks per project, so a finished agent gets the next one right away.",
  "Watch for the terminal's \"finished\" notification as well as the done file; either one means the job is done.",
  "Check the report against every item in the handoff and send back anything skipped.",
  "Don't accept \"it's just an artifact\" without proof.",
  "Check the real symptom before closing a \"nothing's wrong\" report.",
  "Agents never touch the real home folder; tests use a mktemp fake home, and backups never go in /tmp.",
  "One agent per project folder at a time.",
  "Per-project rules live in that project's own rules file.",
  "Weaker models get one narrow task at a time.",
];
const restartLine = "A restart can kill running copies mid-job: check each worktree for finished-but-uncommitted work before redoing it; a complete diff can be committed on its branch and accepted.";
const top10Line = "Check the generated output, not just the rule: Top 10 met the 3-item cap but still opened with the massage chair the owner complained about.";
const oldDir = mkstate();
writeRaw(oldDir, [...oldSeeds, restartLine, top10Line]);
const tidied = readLessons(oldDir);
// tidyLessons keeps first positions, so the per-project line (old index 7)
// lands before the weaker-models line (old index 8).
const expected = [SEED_LESSONS[0], SEED_LESSONS[1], SEED_LESSONS[2], SEED_LESSONS[3], SEED_LESSONS[5], SEED_LESSONS[4], SEED_LESSONS[6]];
assert.deepEqual(tidied, expected, "the 11 old lines fold into the seven seeds");
assert.deepEqual([...tidied].sort(), [...SEED_LESSONS].sort(), "the tidied list is exactly the seven seed lines");
const tidiedFile = JSON.parse(fs.readFileSync(path.join(oldDir, "lessons.json"), "utf8"));
assert.equal(tidiedFile.tidied, 1, "tidying writes the marker back");
assert.deepEqual(tidiedFile.lessons, expected);
const before = fs.readFileSync(path.join(oldDir, "lessons.json"), "utf8");
assert.deepEqual(readLessons(oldDir), tidied, "a second read returns the tidied list");
assert.equal(fs.readFileSync(path.join(oldDir, "lessons.json"), "utf8"), before, "a second read changes nothing");

// Unknown lessons survive tidying untouched.
const unkDir = mkstate();
writeRaw(unkDir, ["A lesson nobody has seen before."]);
assert.deepEqual(readLessons(unkDir), ["A lesson nobody has seen before."], "unknown lessons are kept as they are");

// Near-duplicates differing only in case, spacing or a final period merge.
addLesson("Always   Run   THE build.", dir);
addLesson("always run the build.", dir);
const nearDup = readLessons(dir);
assert.equal(nearDup.filter((l) => /always\s+run\s+the\s+build/i.test(l)).length, 1, "case/space/period duplicates merge");
assert.ok(nearDup.includes("Always   Run   THE build."), "the first position of the duplicate is kept");

// Guardrail lessons ("<agent> broke a guardrail on job ...") keep only the newest 3.
const gdir = mkstate();
for (let i = 1; i <= 5; i++) addLesson(`devin broke a guardrail on job g${i}: touched a banned file.`, gdir);
const guards = readLessons(gdir).filter((l) => /broke a guardrail on job/.test(l));
assert.equal(guards.length, 3, "only the newest 3 guardrail lessons are kept");
assert.deepEqual(guards, [3, 4, 5].map((i) => `devin broke a guardrail on job g${i}: touched a banned file.`));

// addLesson appends, dedupes and survives a fresh read.
addLesson("always run the real test suite", dir);
addLesson("always run the real test suite", dir);
const after = readLessons(dir);
assert.equal(after.filter((l) => l === "always run the real test suite").length, 1, "duplicates are dropped");
assert.equal(after.at(-1), "always run the real test suite", "newest lesson is last");
assert.equal(addLesson("   ", dir).length, after.length, "blank lessons are ignored");

// The cap is 20 and keeps the newest lessons.
const capDir = mkstate();
for (let i = 0; i < 30; i++) addLesson(`cap lesson number ${i}`, capDir);
const capped = readLessons(capDir);
assert.equal(capped.length, 20, "the list stays bounded at 20");
assert.equal(capped.at(-1), "cap lesson number 29");
assert.ok(!capped.includes("cap lesson number 0"), "oldest lessons fall off the end");
assert.equal(capped.filter((l) => SEED_LESSONS.includes(l)).length, 0, "the seeds fell off under the cap");

// tidyLessons unit checks: MERGED drops and maps, unknowns pass through.
assert.equal(MERGED["One agent per project folder at a time."], null, "the obsolete one-agent lesson maps to null");
assert.equal(tidyLessons(["One agent per project folder at a time.", "Brand new."]).join("|"), "Brand new.");

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

for (const d of [dir, oldDir, unkDir, gdir, capDir, proj]) fs.rmSync(d, { recursive: true, force: true });
console.log("constance-lessons: tests passed");
