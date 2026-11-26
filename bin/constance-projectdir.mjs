// A worker only ever launches inside a real project folder. Without one the
// sandbox would have nothing sensible to bind writable: a missing dir throws
// deep in bwrap setup, "" or a relative path resolves against the controller's
// cwd, and "/" or the home folder would expose everything. This is the one
// check, used by launchJob and again by sandboxArgs (every launch path).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const under = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

// "" when dir is a usable project folder, else a short reason.
export function projectDirProblem(dir, env = process.env) {
  if (typeof dir !== "string" || dir.trim() === "") return "no project folder";
  if (!path.isAbsolute(dir)) return `project folder ${dir} is not an absolute path`;
  let real;
  try { real = fs.realpathSync(dir); } catch { return `project folder ${dir} does not exist`; }
  let st;
  try { st = fs.statSync(real); } catch { return `project folder ${dir} can't be read`; }
  if (!st.isDirectory()) return `project folder ${dir} is not a folder`;
  if (real === path.parse(real).root) return "the project folder can't be /";
  let home = path.resolve(env.HOME || os.homedir());
  try { home = fs.realpathSync(home); } catch {}
  if (under(home, real)) return "the project folder can't be the home folder or above it";
  return "";
}

export function assertProjectDir(dir, env = process.env) {
  const p = projectDirProblem(dir, env);
  if (p) throw new Error(`refusing to launch a worker: ${p}`);
}
