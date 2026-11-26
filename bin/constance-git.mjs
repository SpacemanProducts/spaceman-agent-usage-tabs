// Host-side git for folders a worker has been inside. Every git call Constance
// makes in a project or a copy's worktree after a worker ran there goes through
// safeGit:
//   - core.fsmonitor and core.hooksPath are switched off on the command line, so
//     no config value can make host git run a command (the sandbox keeps .git
//     read-only too; this is the second lock).
//   - GIT_DIR and GIT_WORK_TREE are pinned to the folder's own git dir, resolved
//     from its `.git` entry, so git never discovers a planted `.git` further up or
//     down the tree.
//   - GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM are left alone: the owner's identity
//     and settings still apply.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const SAFE_CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false"];

// The git dir for a work tree: `<dir>/.git` when it is a directory, or the path
// a linked worktree's `.git` file names. null when there is none.
export function gitDirOf(dir) {
  const dotgit = path.join(dir, ".git");
  let st;
  try { st = fs.lstatSync(dotgit); } catch { return null; }
  if (st.isDirectory()) return dotgit;
  if (!st.isFile()) return null;
  try {
    const m = fs.readFileSync(dotgit, "utf8").match(/^gitdir:\s*(.+)$/m);
    return m ? path.resolve(dir, m[1].trim()) : null;
  } catch { return null; }
}

// Environment for one safe git call: the caller's env minus anything that could
// point git elsewhere, plus the pinned dirs.
export function safeEnv(dir, env = process.env) {
  const e = { ...env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CEILING_DIRECTORIES", "GIT_EXEC_PATH", "GIT_SSH_COMMAND", "GIT_EXTERNAL_DIFF"]) delete e[k];
  const gd = gitDirOf(dir);
  if (gd) { e.GIT_DIR = gd; e.GIT_WORK_TREE = dir; }
  return e;
}

// spawnSync("git", ...) the safe way. Returns spawnSync's result.
export function safeGit(dir, args, { env = process.env, ...opts } = {}) {
  return spawnSync("git", [...SAFE_CONFIG, ...args], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts, env: safeEnv(dir, env) });
}

// Tracked changes (staged or not) in a work tree, ignoring untracked files:
// the uncommitted work a merge, revert or reset could destroy.
export function trackedDirty(dir, env = process.env) {
  const r = safeGit(dir, ["status", "--porcelain", "--untracked-files=no"], { env });
  if (r.status !== 0) return null;
  return r.stdout.split("\n").filter((l) => l.trim()).map((l) => l.slice(3));
}
