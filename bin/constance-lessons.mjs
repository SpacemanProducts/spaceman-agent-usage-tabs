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

const MAX_LESSONS = 60;

function writeLessons(file, lessons) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ lessons }, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// The lessons list, seeding the file the first time it is read. Always an array of strings.
export function readLessons(dir = stateDir()) {
  const file = lessonsFile(dir);
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    const lessons = Array.isArray(d?.lessons) ? d.lessons.filter((x) => typeof x === "string" && x.trim()) : [];
    if (lessons.length) return lessons.slice(-MAX_LESSONS);
  } catch { /* missing or unreadable: seed below */ }
  writeLessons(file, SEED_LESSONS);
  return SEED_LESSONS.slice();
}

// Add one short lesson (deduped, newest kept, capped). Returns the stored list.
export function addLesson(text, dir = stateDir()) {
  const lesson = String(text || "").trim();
  if (!lesson) return readLessons(dir);
  const lessons = readLessons(dir);
  if (!lessons.includes(lesson)) lessons.push(lesson);
  const kept = lessons.slice(-MAX_LESSONS);
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
