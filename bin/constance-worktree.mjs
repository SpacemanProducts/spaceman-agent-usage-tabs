// Constance's parallel copies: each editing job for a multi-copy agent runs in
// its own git worktree on its own branch, in a temp area outside ~/Projects.
// After review accepts the job, its branch is merged into the repo's current
// branch — one at a time, and a conflict stops instead of forcing anything.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeGit, trackedDirty } from "./constance-git.mjs";

// Every git call here is the hardened one (constance-git.mjs): no fsmonitor, no
// hooks, GIT_DIR pinned to the folder's own git dir.
const git = (dir, ...args) => safeGit(dir, args);

export function repoBranch(dir) {
  const r = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
  const b = r.status === 0 ? r.stdout.trim() : "";
  return b && b !== "HEAD" ? b : "";
}

// Worktrees live in /var/tmp when it exists: /tmp is replaced by each job's own
// sandbox temp folder, so a worktree there would be hidden inside the sandbox.
// CONSTANCE_WORKTREES overrides it: the tests point it at their own temp folder,
// so they never create or remove anything in the real worktree area.
export function worktreeRoot(env = process.env) {
  if (env.CONSTANCE_WORKTREES) return env.CONSTANCE_WORKTREES;
  const base = fs.existsSync("/var/tmp") ? "/var/tmp" : (env.TMPDIR || os.tmpdir());
  return path.join(base, "constance-worktrees");
}

export function branchFor(id) { return `constance/job-${id}`; }
export function worktreeFor(id) { return path.join(worktreeRoot(), `job-${id}`); }

// `git worktree add -b <branch> <path> HEAD` from the repo's current commit.
export function createWorktree(repo, id) {
  const wt = worktreeFor(id), branch = branchFor(id);
  git(repo, "worktree", "prune");
  if (fs.existsSync(wt)) {
    git(repo, "worktree", "remove", "--force", wt);
    fs.rmSync(wt, { recursive: true, force: true });
    git(repo, "worktree", "prune");
  }
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const r = git(repo, "worktree", "add", "-b", branch, wt, "HEAD");
  if (r.status !== 0) throw new Error(`could not create worktree: ${(r.stderr || r.stdout || "").trim()}`);
  return { worktree: wt, branch };
}

// Merge the copy's branch into the repo's current branch. Never forces, and
// never resets, cleans or checks out anything:
//   - a checkout with uncommitted tracked changes (the owner's, or a job's
//     still in progress) is not merged into at all: { ok: false, dirty: true }.
//     Merging on top of them, or aborting a merge that touched them, could take
//     them with it.
//   - a conflict (MERGE_HEAD exists) is aborted with `merge --abort`, which is
//     safe because the tree had no tracked changes when the merge started.
//   - any other failure is reported and the tree is left exactly as git left it.
export function mergeBranch(repo, branch, { noFf = false } = {}) {
  const dirty = trackedDirty(repo);
  if (dirty === null) return { ok: false, flagged: true, output: "git status failed in the checkout; nothing was merged" };
  if (dirty.length) return { ok: false, dirty: true, flagged: true, output: `the checkout has uncommitted changes (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", ..." : ""}); nothing was merged` };
  const before = git(repo, "rev-parse", "HEAD");
  const r = git(repo, "merge", "--no-edit", ...(noFf ? ["--no-ff"] : []), branch);
  if (r.status === 0) {
    const head = git(repo, "rev-parse", "HEAD");
    const tip = git(repo, "rev-parse", branch);
    const moved = before.status === 0 && head.status === 0 && head.stdout.trim() !== before.stdout.trim();
    // A fast-forward lands HEAD exactly on the branch tip; a merge commit never does.
    const fastForward = moved && tip.status === 0 && head.stdout.trim() === tip.stdout.trim();
    return { ok: true, commit: head.status === 0 ? head.stdout.trim() : "", fastForward };
  }
  const merging = git(repo, "rev-parse", "-q", "--verify", "MERGE_HEAD").status === 0;
  if (merging) git(repo, "merge", "--abort");
  return { ok: false, conflict: merging, flagged: !merging, output: `${r.stdout || ""}${r.stderr || ""}`.trim().slice(-800) };
}

// Remove a worktree and (optionally) its branch. Used after a merge, on Stop,
// and for rejected copies; the branch is only deleted when asked.
export function dropWorktree(repo, worktree, branch, { deleteBranch = false, merged = false } = {}) {
  const did = [];
  if (worktree && fs.existsSync(worktree)) {
    const r = git(repo, "worktree", "remove", "--force", worktree);
    if (r.status !== 0) { try { fs.rmSync(worktree, { recursive: true, force: true }); } catch {} }
    did.push("worktree removed");
  }
  git(repo, "worktree", "prune");
  if (deleteBranch && branch) {
    const r = git(repo, "branch", merged ? "-d" : "-D", branch);
    if (r.status === 0) did.push(`branch ${branch} deleted`);
    else did.push(`branch ${branch} kept (${(r.stderr || "").trim().slice(-120)})`);
  }
  return did;
}
