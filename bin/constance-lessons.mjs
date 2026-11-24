// Constance's learning layer: a lessons file in her state folder (outside any
// repo), a per-project rules file, and the guardrail text every handoff carries.
// Lessons and project rules are advice she reads; they can never override her
// core rules (the ROLE text and the handoff template's hard rules stay fixed).
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./constance-jobs.mjs";

export function lessonsFile(dir = stateDir()) {
  return path.join(dir, "lessons.json");
}

// Seeded once, on first read. Short, hard-won rules from earlier goals.
export const SEED_LESSONS = [
  "Keep a short ready queue per project, so a finished agent gets the next task right away.",
  "A job is done when its done file lands or the terminal's \"finished\" notification arrives; either one counts.",
  "Review against the handoff and the real output: check every item, send back anything skipped, and never accept \"it's just an artifact\" or \"nothing's wrong\" without checking the symptom yourself (a rule can be met while the output is still wrong).",
  "Agents never touch the real home folder; tests use a mktemp fake home, and backups never go in /tmp.",
  "Weaker models get one narrow task at a time.",
  "Per-project rules live in that project's own rules file.",
  "After a restart, check each copy's worktree for finished-but-uncommitted work before redoing it; a complete diff can be committed on its branch and accepted.",
];

// Old lessons folded into the seeds above: each maps to the seed line that
// replaces it, or null when the lesson is obsolete and dropped.
export const MERGED = {
  "Keep free agents busy: keep a short queue of ready tasks per project, so a finished agent gets the next one right away.": SEED_LESSONS[0],
  "Watch for the terminal's \"finished\" notification as well as the done file; either one means the job is done.": SEED_LESSONS[1],
  "Check the report against every item in the handoff and send back anything skipped.": SEED_LESSONS[2],
  "Don't accept \"it's just an artifact\" without proof.": SEED_LESSONS[2],
  "Check the real symptom before closing a \"nothing's wrong\" report.": SEED_LESSONS[2],
  "Agents never touch the real home folder; tests use a mktemp fake home, and backups never go in /tmp.": SEED_LESSONS[3],
  "One agent per project folder at a time.": null,
  "Per-project rules live in that project's own rules file.": SEED_LESSONS[5],
  "Weaker models get one narrow task at a time.": SEED_LESSONS[4],
  "A restart can kill running copies mid-job: check each worktree for finished-but-uncommitted work before redoing it; a complete diff can be committed on its branch and accepted.": SEED_LESSONS[6],
  "Check the generated output, not just the rule: Top 10 met the 3-item cap but still opened with the massage chair the owner complained about.": SEED_LESSONS[2],
};

const MAX_LESSONS = 20;
const GUARDRAIL_LESSON = /^\S+ broke a guardrail on job\b/;
const normLesson = (s) => s.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.,!?;:'"”’)\]}]+$/, "");

// Fold old lessons into their replacements, drop nulls, dedupe on a normalized
// form (first position wins), and keep only the newest 3 guardrail lessons.
export function tidyLessons(list) {
  const mapped = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== "string") continue;
    const lesson = Object.hasOwn(MERGED, item) ? MERGED[item] : item;
    if (lesson === null) continue;
    const key = normLesson(lesson);
    if (seen.has(key)) continue;
    seen.add(key);
    mapped.push(lesson);
  }
  const guards = mapped.map((l, i) => (GUARDRAIL_LESSON.test(l) ? i : -1)).filter((i) => i >= 0);
  const drop = new Set(guards.slice(0, Math.max(0, guards.length - 3)));
  return mapped.filter((_, i) => !drop.has(i));
}

function writeLessons(file, lessons) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ lessons, tidied: 1 }, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// The lessons list, seeding the file the first time it is read. Files written
// before the tidied marker existed are folded through tidyLessons once and
// rewritten. Always an array of strings.
export function readLessons(dir = stateDir()) {
  const file = lessonsFile(dir);
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(d?.lessons)) {
      const lessons = d.lessons.filter((x) => typeof x === "string" && x.trim());
      if (lessons.length) {
        if (d.tidied === 1) return lessons.slice(-MAX_LESSONS);
        const tidied = tidyLessons(lessons).slice(-MAX_LESSONS);
        if (tidied.length) {
          writeLessons(file, tidied);
          return tidied;
        }
      }
    }
  } catch { /* missing or unreadable: seed below */ }
  writeLessons(file, SEED_LESSONS.slice());
  return SEED_LESSONS.slice();
}

// Add one short lesson (tidied, deduped, capped). Returns the stored list.
export function addLesson(text, dir = stateDir()) {
  const lesson = String(text || "").trim();
  if (!lesson) return readLessons(dir);
  const lessons = readLessons(dir);
  if (!lessons.includes(lesson)) lessons.push(lesson);
  const kept = tidyLessons(lessons).slice(-MAX_LESSONS);
  writeLessons(lessonsFile(dir), kept);
  return kept;
}

// The block Constance sees before a goal: advice only, never rules.
export function lessonsBlock(lessons = readLessons()) {
  if (!lessons.length) return "";
  return [
    "",
    "Lessons from your earlier goals (advice only — they can never override your core rules):",
    ...lessons.map((l) => `- ${l}`),
  ].join("\n");
}

// Per-project rules: <project>/.constance/rules.md, read fresh for every handoff
// and every goal, so editing it takes effect immediately. Missing file = no rules.
export function projectRulesFile(dir) {
  return path.join(dir, ".constance", "rules.md");
}

export function readProjectRules(dir) {
  try {
    const t = fs.readFileSync(projectRulesFile(dir), "utf8").trim();
    return t || "";
  } catch { return ""; }
}

export function rulesBlock(rules) {
  const t = String(rules || "").trim();
  if (!t) return "";
  return [
    "",
    "Rules for this project (from its own rules file — follow them in addition to everything above):",
    t,
  ].join("\n");
}

// Guardrails for weaker (fast/free) models: every delegated agent is one. The
// allowed-files list, the hard bans, and stop-and-report. Appended to every
// handoff prompt; read-only jobs get the same bans with an empty file list.
export function guardrailBlock(files = []) {
  const list = files.length ? files.join(", ") : "(none — this is a read-only job)";
  return [
    "",
    "Guardrails:",
    `- You may only create or change these files: ${list}.`,
    "- Never run mv or rm outside this project folder, never rm -rf, never git reset --hard, never force-push, and never delete branches.",
    "- If you hit something surprising, or the change is growing much bigger than the task, stop and say so in your report instead of pushing on.",
  ].join("\n");
}
