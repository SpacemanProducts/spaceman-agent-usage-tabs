// Constance's guardrails, checked after every delegated run: the job's diff may
// touch only its allowed files. Home/projects differences are only noted — the
// agent runs sandboxed with an empty tmpfs home, so those folders are the
// owner's own. A violation restores what can be restored, logs a lesson, and
// gives that agent smaller tasks from then on.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeGit, trackedDirty } from "./constance-git.mjs";

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

// Host git after a worker ran in the folder: fsmonitor and hooks off, GIT_DIR
// pinned (constance-git.mjs). The guard's own `git status` must never be the
// thing that runs a worker's planted command.
const git = (dir, ...args) => safeGit(dir, args);

const isHash = (c) => /^[0-9a-f]{7,40}$/i.test(c || "");
function headOf(dir) {
  const r = git(dir, "rev-parse", "HEAD");
  return r.status === 0 ? r.stdout.trim() : "";
}

// Paths dirty in the worktree right now. -z prints raw unquoted names,
// --untracked-files=all lists every new file instead of collapsing a wholly
// untracked folder to "dir/", and a rename reports BOTH sides.
export function dirtyPaths(dir) {
  const out = [];
  const st = git(dir, "status", "--porcelain", "-z", "--untracked-files=all");
  if (st.status !== 0) return out;
  const fields = st.stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f || f.length < 4) continue;
    out.push(f.slice(3));
    const xy = f.slice(0, 2);
    if (xy.includes("R") || xy.includes("C")) {
      const other = fields[++i];
      if (other && xy.includes("R")) out.push(other);
    }
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

// Everything wrong with one finished run. `files` is the job's list (empty =
// read-only: any change at all is a violation). .constance/ is NOT allowed:
// only Constance writes there (the sandbox keeps it read-only).
//
// Attribution: workers can't commit (their git data is read-only), so a commit
// counts as this job's only when the caller vouches for it as `commit` (the
// commit Constance made for the job) and it really is new since the pre-run
// HEAD. Every other commit since then belongs to someone else — another job's
// merge, the owner, Constance — and is never blamed on this job or reverted.
// The one exception is a copy's own worktree (`ownTree`): nobody else commits
// there, so a commit Constance didn't make is flagged (its files are checked
// too, since they would merge), but still never reverted.
export function checkRun({ dir, files = [], commit = "", before = null, env = process.env, ownTree = false } = {}) {
  const violations = [];
  const notices = [];
  if (!before) return { ok: true, violations, notices, badPaths: [], badCommits: [], foreignCommits: [] };
  const allowed = [...files];
  const own = before.head !== undefined ? commitFromRun(dir, commit, before.head) : false;
  if (isHash(commit) && before.head !== undefined && !own) violations.push(`reported commit ${commit.slice(0, 9)} is not a new commit from this run`);
  const since = before.head !== undefined ? newCommits(dir, before.head) : [];
  const fullOf = (c) => { const r = git(dir, "rev-parse", c + "^{commit}"); return r.status === 0 ? r.stdout.trim() : c; };
  const ownFull = own ? fullOf(commit) : "";
  const attributed = own ? [commit] : [];
  const foreignCommits = since.filter((c) => c !== ownFull);
  const paths = new Set();
  for (const c of attributed) commitFiles(dir, c).forEach((p) => paths.add(p));
  if (ownTree && foreignCommits.length) {
    violations.push(`${foreignCommits.length} commit${foreignCommits.length === 1 ? "" : "s"} appeared in its own worktree that Constance didn't make: ${foreignCommits.map((c) => c.slice(0, 9)).join(", ")}`);
    for (const c of foreignCommits) commitFiles(dir, c).forEach((p) => paths.add(p));
  }
  const already = new Set(before.dirty || []);
  for (const p of dirtyPaths(dir)) if (!already.has(p)) paths.add(p);
  const bad = [...paths].filter((p) => !inside(p, allowed));
  if (bad.length) violations.push(`changed files outside its list: ${bad.join(", ")}`);
  const badCommits = attributed.filter((c) => commitFiles(dir, c).some((p) => !inside(p, allowed)));
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
  const ownCommit = own ? commit : "";
  return { ok: violations.length === 0, violations, notices, badPaths: bad, ownCommit, ownCommits: attributed, badCommits, foreignCommits, addedProjects, addedHome, removedHome, removedProjects, projectsDir: after.projectsDir };
}

// Undo what can be undone, and nothing else. The guard never deletes, moves,
// checks out or cleans anything: the owner, Constance and other jobs share these
// folders, so a stray path may well be theirs. The only automatic undo is a
// `git revert` (a new commit, never a reset) of a commit attributed to THIS job:
// `commit` (the caller vouches for it) or a `commits` entry that is also in
// `attributed`. Anything else is never reverted. Nothing is reverted on top of
// uncommitted tracked changes, and a revert that can't apply cleanly is aborted.
// Everything else is reported for the owner to look at.
export function restoreRun({ dir, commit = "", commits = [], attributed = [], badPaths = [], addedProjects = [], addedHome = [], removedHome = [], removedProjects = [] } = {}) {
  const did = [];
  const seen = new Set();
  const fullOf = (c) => { const r = git(dir, "rev-parse", c + "^{commit}"); return r.status === 0 ? r.stdout.trim() : ""; };
  const mine = new Set([commit, ...attributed].filter(isHash).map(fullOf).filter(Boolean));
  const revert = (c) => {
    const key = fullOf(c);
    if (!key || seen.has(key)) return;
    seen.add(key);
    if (!mine.has(key)) { did.push(`left commit ${c.slice(0, 9)} alone (not this job's)`); return; }
    const dirty = trackedDirty(dir);
    if (dirty === null || dirty.length) { did.push(`could not revert commit ${c.slice(0, 9)}: the folder has uncommitted changes; left it for you`); return; }
    const r = git(dir, "revert", "--no-edit", c);
    if (r.status === 0) did.push(`reverted commit ${c.slice(0, 9)}`);
    else { git(dir, "revert", "--abort"); did.push(`could not revert commit ${c.slice(0, 9)} cleanly; left it for you`); }
  };
  if (isHash(commit)) revert(commit);
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
