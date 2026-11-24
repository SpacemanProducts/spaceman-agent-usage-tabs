// Constance's guardrails, checked after every delegated run: the job's diff may
// touch only its allowed files, and the home folder and project list must match
// the snapshot taken before the run. A violation restores what can be restored,
// logs a lesson, and gives that agent smaller tasks from then on.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const names = (dir) => {
  try { return fs.readdirSync(dir).sort(); } catch { return []; }
};

// What the world looked like before the run: top-level names of $HOME and of the
// projects folder (~/Projects, or SQUAD_PROJECTS). Names only — cheap and enough
// to catch an agent creating or deleting folders where it shouldn't.
export function snapshot(env = process.env) {
  const home = env.HOME || os.homedir();
  const projects = env.SQUAD_PROJECTS || path.join(home, "Projects");
  return { home: names(home), projects: names(projects), projectsDir: projects };
}

const git = (dir, ...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });

// Paths the run changed: its commit's files plus anything still dirty in the
// worktree (an agent that forgot to commit still shows up here).
export function changedPaths(dir, commit) {
  const out = new Set();
  if (/^[0-9a-f]{7,40}$/i.test(commit || "")) {
    const r = git(dir, "show", "--name-only", "--format=", commit);
    if (r.status === 0) r.stdout.split("\n").filter(Boolean).forEach((p) => out.add(p));
  }
  const st = git(dir, "status", "--porcelain");
  if (st.status === 0) {
    for (const line of st.stdout.split("\n")) {
      if (!line.trim()) continue;
      let p = line.slice(3).trim();
      const arrow = p.indexOf(" -> ");
      if (arrow >= 0) p = p.slice(arrow + 4);
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      out.add(p);
    }
  }
  return [...out];
}

const norm = (p) => String(p).replace(/^\.\//, "").replace(/\/+$/, "");
const inside = (p, list) => list.some((f) => { const a = norm(f), b = norm(p); return a === b || a === "." || b === a + "/" || a.startsWith(b + "/"); });

// Dot-prefixed entries are ignored in the comparisons: tools churn hidden dirs
// constantly (~/.cache, ~/.local, browser state), and an agent misbehaving in a
// way we care about leaves visible, project-like folders behind.
const visible = (names) => names.filter((n) => !n.startsWith("."));

// Everything wrong with one finished run. `allowed` is the job's file list
// (empty = read-only: any change at all is a violation, .constance/ aside).
export function checkRun({ dir, files = [], commit = "", before = null, env = process.env } = {}) {
  const violations = [];
  if (!before) return { ok: true, violations };
  const allowed = [...files, ".constance/"];
  const bad = changedPaths(dir, commit).filter((p) => !inside(p, allowed));
  if (bad.length) violations.push(`changed files outside its list: ${bad.join(", ")}`);
  const after = snapshot(env);
  const homeAfter = visible(after.home), homeBefore = visible(before.home || []);
  const projAfter = visible(after.projects), projBefore = visible(before.projects || []);
  const addedHome = homeAfter.filter((n) => !homeBefore.includes(n));
  const removedHome = homeBefore.filter((n) => !homeAfter.includes(n));
  const addedProjects = projAfter.filter((n) => !projBefore.includes(n));
  const removedProjects = projBefore.filter((n) => !projAfter.includes(n));
  if (addedHome.length) violations.push(`created entries in the home folder: ${addedHome.join(", ")}`);
  if (removedHome.length) violations.push(`removed entries from the home folder: ${removedHome.join(", ")}`);
  if (addedProjects.length) violations.push(`created projects outside the folder: ${addedProjects.join(", ")}`);
  if (removedProjects.length) violations.push(`removed projects: ${removedProjects.join(", ")}`);
  return { ok: violations.length === 0, violations, badPaths: bad, addedProjects, addedHome, removedHome, removedProjects, projectsDir: after.projectsDir };
}

// Undo what can be undone, safely:
//  - the job's own commit is reverted (a new commit, never a reset);
//  - disallowed paths still dirty are checked out / cleaned by name only;
//  - folders the run created in the projects dir are moved into the project's
//    .constance/quarantine/ (kept, not deleted);
//  - home-folder entries are only reported: nothing there is safe to touch blindly.
export function restoreRun({ dir, commit = "", badPaths = [], addedProjects = [], projectsDir = "" } = {}) {
  const did = [];
  if (/^[0-9a-f]{7,40}$/i.test(commit || "")) {
    const r = git(dir, "revert", "--no-edit", commit);
    if (r.status === 0) did.push(`reverted commit ${commit.slice(0, 9)}`);
  }
  for (const p of badPaths) {
    const clean = p.replace(/^["']|["']$/g, "");
    if (clean.includes("..") || path.isAbsolute(clean)) continue;
    git(dir, "checkout", "--", clean);
    git(dir, "clean", "-fdq", "--", clean);
    did.push(`restored ${clean}`);
  }
  if (projectsDir && addedProjects.length) {
    const quarantine = path.join(dir, ".constance", "quarantine");
    fs.mkdirSync(quarantine, { recursive: true });
    for (const n of addedProjects) {
      const src = path.join(projectsDir, n);
      try { fs.renameSync(src, path.join(quarantine, `${Date.now()}-${n}`)); did.push(`quarantined project ${n}`); } catch {}
    }
  }
  return did;
}

// How small an agent's tasks must be after violations: strikes raise the bar.
// 0 strikes -> no cap; 1 -> at most 3 files; 2+ -> one file or read-only.
export function fileCap(strikes) {
  if (!strikes) return Infinity;
  return strikes === 1 ? 3 : 1;
}
