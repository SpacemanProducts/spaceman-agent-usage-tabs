// Is an agent's CLI really installed? A binary found on PATH counts, except a
// mise shim: Omarchy's mise config creates shims for tools it has not
// downloaded yet ("lazy"), so a shim only counts if `mise which` resolves it to
// a file that exists. Running such a shim would also trigger a download.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const defaultExecutable = (f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } };
const isShimDir = (d) => /\/mise\/shims\/?$/.test(d);

export function makeInstalledCheck({ dirs, env, executable = defaultExecutable, which } = {}) {
  const resolveShim = which || ((bin) => {
    const r = spawnSync("mise", ["which", bin], { encoding: "utf8", env, timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
    const p = String(r.stdout || "").trim().split("\n")[0];
    return r.status === 0 && p ? p : "";
  });
  const memo = new Map();
  return (bins) => bins.some((b) => (dirs || []).some((d) => {
    const f = path.join(d, b);
    if (!executable(f)) return false;
    if (!isShimDir(d)) return true;
    if (!memo.has(b)) { const p = resolveShim(b); memo.set(b, !!p && executable(p)); }
    return memo.get(b);
  }));
}

// The command that opens an agent's own CLI: its first binary that is really
// installed, or "" when it has none (the panel then hides its App button).
export const agentCli = (bins, isInstalled) => (bins || []).find((b) => isInstalled([b])) || "";
