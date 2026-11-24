// Constance's guardrails, checked after every delegated run: the job's diff may
// touch only its allowed files. Home/projects differences are only noted — the
// agent runs sandboxed with an empty tmpfs home, so those folders are the
// owner's own. A violation restores what can be restored, logs a lesson, and
// gives that agent smaller tasks from then on.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const names = (dir) => {
  try { return fs.readdirSync(dir).sort(); } catch { return []; }
};

// What the world looked like before the run: top-level names of $HOME and of the
// projects folder (~/Projects, or SQUAD_PROJECTS), plus the project's HEAD and the
// paths that were already dirty (the owner's own work in progress, never the
// agent's). Names only — cheap and enough to catch an agent creating or deleting
// folders where it shouldn't.
export function snapshot(env = process.env, dir = "") {
  const home = env.HOME || os.homedir();
  const projects = env.SQUAD_PROJECTS || path.join(home, "Projects");
  const snap = { home: names(home), projects: names(projects), projectsDir: projects };
  if (dir) { snap.head = headOf(dir); snap.dirty = dirtyPaths(dir); }
  return snap;
}

const git = (dir, ...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });

const isHash = (c) => /^[0-9a-f]{7,40}$/i.test(c || "");
function headOf(dir) {
  const r = git(dir, "rev-parse", "HEAD");
  return r.status === 0 ? r.stdout.trim() : "";
}

// Paths dirty in the worktree right now.
export function dirtyPaths(dir) {
  const out = [];
  const st = git(dir, "status", "--porcelain");
  if (st.status !== 0) return out;
  for (const line of st.stdout.split("\n")) {
    if (!line.trim()) continue;
    let p = line.slice(3).trim();
    const arrow = p.indexOf(" -> ");
    if (arrow >= 0) p = p.slice(arrow + 4);
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    out.push(p);
  }
  return out;
}

// A reported commit counts only if the run really made it: new since the
// pre-run HEAD and on the current branch. Anything else (an old commit, someone
// else's, a typo) is never inspected or reverted as the agent's.
export function commitFromRun(dir, commit, baseHead) {
  if (!isHash(commit)) return false;
  if (git(dir, "merge-base", "--is-ancestor", commit, "HEAD").status !== 0) return false;
  if (!baseHead) return false;
  const full = git(dir, "rev-parse", commit + "^{commit}");
  if (full.status !== 0 || full.stdout.trim() === baseHead) return false;
  return git(dir, "merge-base", "--is-ancestor", baseHead, commit).status === 0;
}

const commitFiles = (dir, commit) => {
  const out = [];
  const r = git(dir, "show", "--name-only", "--format=", commit);
  if (r.status === 0) r.stdout.split("\n").filter(Boolean).forEach((p) => out.push(p));
  return out;
};

// Every commit the run made: baseHead..HEAD, oldest first. A missing or
// unresolvable base means "can't tell which commits are the run's", so the
// list is empty rather than guessed.
export function newCommits(dir, baseHead) {
  if (!baseHead) return [];
  const base = git(dir, "rev-parse", "--verify", "--quiet", baseHead + "^{commit}");
  if (base.status !== 0) return [];
  const r = git(dir, "rev-list", "--reverse", base.stdout.trim() + "..HEAD");
  if (r.status !== 0) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

// Paths the run changed: its own commit's files plus anything dirty now that
// wasn't dirty before the run (an agent that forgot to commit still shows up;
// the owner's earlier uncommitted work never does).
export function changedPaths(dir, commit, before = null) {
  const out = new Set();
  if (isHash(commit)) commitFiles(dir, commit).forEach((p) => out.add(p));
  const already = new Set((before && before.dirty) || []);
  for (const p of dirtyPaths(dir)) if (!already.has(p)) out.add(p);
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
  const notices = [];
  if (!before) return { ok: true, violations, notices };
  const allowed = [...files, ".constance/"];
  // An old snapshot without a recorded HEAD can't tell the run's commits from
  // anyone else's: judge the dirty paths only.
  const own = before.head !== undefined ? commitFromRun(dir, commit, before.head) : false;
  if (isHash(commit) && before.head !== undefined && !own) violations.push(`reported commit ${commit.slice(0, 9)} is not a new commit from this run`);
  // Every commit since the pre-run HEAD is the run's, reported or not: an agent
  // that commits but reports nothing still gets diff-checked.
  const ownCommits = before.head !== undefined ? newCommits(dir, before.head) : [];
  const paths = new Set();
  for (const c of ownCommits) commitFiles(dir, c).forEach((p) => paths.add(p));
  const already = new Set(before.dirty || []);
  for (const p of dirtyPaths(dir)) if (!already.has(p)) paths.add(p);
  const bad = [...paths].filter((p) => !inside(p, allowed));
  if (bad.length) violations.push(`changed files outside its list: ${bad.join(", ")}`);
  const badCommits = ownCommits.filter((c) => commitFiles(dir, c).some((p) => !inside(p, allowed))).reverse();
  const after = snapshot(env);
  const homeAfter = visible(after.home), homeBefore = visible(before.home || []);
  const projAfter = visible(after.projects), projBefore = visible(before.projects || []);
  const addedHome = homeAfter.filter((n) => !homeBefore.includes(n));
  const removedHome = homeBefore.filter((n) => !homeAfter.includes(n));
  const addedProjects = projAfter.filter((n) => !projBefore.includes(n));
  const removedProjects = projBefore.filter((n) => !projAfter.includes(n));
  // The agent's home is an empty tmpfs, so home/projects differences are the
  // owner's own folders: noted for the record, never a violation.
  if (addedHome.length) notices.push(`created entries in the home folder: ${addedHome.join(", ")}`);
  if (removedHome.length) notices.push(`removed entries from the home folder: ${removedHome.join(", ")}`);
  if (addedProjects.length) notices.push(`created projects outside the folder: ${addedProjects.join(", ")}`);
  if (removedProjects.length) notices.push(`removed projects: ${removedProjects.join(", ")}`);
  const ownCommit = own ? commit : ownCommits[ownCommits.length - 1] || "";
  return { ok: violations.length === 0, violations, notices, badPaths: bad, ownCommit, ownCommits, badCommits, addedProjects, addedHome, removedHome, removedProjects, projectsDir: after.projectsDir };
}

// Undo what can be undone, and nothing else. The guard never deletes, moves,
// checks out or cleans anything: the owner, Constance and other jobs share these
// folders, so a stray path may well be theirs. The only automatic undo is a
// `git revert` of the run's own verified commit (a new commit, never a reset);
// if that revert can't apply cleanly it is aborted, leaving the tree as it was.
// Everything else is reported for the owner to look at.
export function restoreRun({ dir, commit = "", commits = [], badPaths = [], addedProjects = [], addedHome = [], removedHome = [], removedProjects = [] } = {}) {
  const did = [];
  const seen = new Set();
  const revert = (c) => {
    const full = git(dir, "rev-parse", c + "^{commit}");
    const key = full.status === 0 ? full.stdout.trim() : c;
    if (seen.has(key)) return;
    seen.add(key);
    const r = git(dir, "revert", "--no-edit", c);
    if (r.status === 0) did.push(`reverted commit ${c.slice(0, 9)}`);
    else { git(dir, "revert", "--abort"); did.push(`could not revert commit ${c.slice(0, 9)} cleanly; left it for you`); }
  };
  if (isHash(commit)) revert(commit);
  // `commits` is newest first (badCommits order); each reverts independently.
  for (const c of commits) if (isHash(c)) revert(c);
  const left = [...badPaths.map((p) => `${p} (in the project)`), ...addedProjects.map((n) => `${n} (new in Projects)`), ...addedHome.map((n) => `${n} (new in home)`)];
  if (left.length) did.push(`left in place for you to check: ${left.join(", ")}`);
  const gone = [...removedProjects, ...removedHome];
  if (gone.length) did.push(`missing since the run started: ${gone.join(", ")}`);
  return did;
}

// How small an agent's tasks must be after violations: strikes raise the bar.
// 0 strikes -> no cap; 1 -> at most 3 files; 2+ -> one file or read-only.
export function fileCap(strikes) {
  if (!strikes) return Infinity;
  return strikes === 1 ? 3 : 1;
}
