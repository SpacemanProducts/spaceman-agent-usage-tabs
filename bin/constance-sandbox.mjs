// Constance's sandbox: every worker she launches with its permission prompts off
// runs inside bubblewrap (bwrap). Inside, the agent can write to exactly three
// places: the job's project folder, its own config/login folders, and a fresh
// temp folder. The rest of the system is read-only, and the home folder starts
// EMPTY: only the toolchains an agent needs to run (mise, ~/.local/bin, git's
// config) come back, read-only. So ~/.ssh, ~/.config (outside the agent's own
// folder), Documents, ~/Projects outside this project, other agents' logins and
// Claude's own login are simply not there.
//
// Also cut off: the session bus and everything else under /run/user (no D-Bus,
// so no `systemd-run --user` escape and no keyring; no ssh-agent; no Wayland),
// and ALL of the project's git data (.git, or a worktree's pointer and the main
// repo's git dir) plus its .constance/ folder are read-only: an agent can't
// commit, move a ref, or plant a hook, commondir or config that host git later
// trusts. Constance commits the job's allowed files for it, on the host.
//
// An agent with no verified profile here is never launched with prompts off.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Per agent: the folders (relative to $HOME) it may write — its own config and
// login — checked live on 2026-11-24 by logging in and doing a tiny job sandboxed
// (CHANGELOG 1.42.0). `keyring: true` means its login lives in the desktop
// keyring (Secret Service over D-Bus): sandboxed, it can only sign in through a
// bus proxy that passes org.freedesktop.secrets alone. The Linux keyring has no
// per-app rules, so that proxy lets the agent read EVERY secret in it — it is
// off unless the owner names the agent in settings.json `constanceKeyringAgents`.
// `env` adds variables inside (Cursor only looks in the keyring when a display
// is named; the ":99" here points at nothing — no display socket is visible).
export const PROFILES = {
  antigravity: { rw: [".gemini", ".config/antigravity"], keyring: true },
  grok: { rw: [".grok"] },
  copilot: { rw: [".copilot", ".cache/copilot"], keyring: true },
  devin: { rw: [".config/devin", ".local/share/devin", ".cache/devin"] },
  codex: { rw: [".codex", ".local/state/codex"] },
  cursor: { rw: [".cursor", ".config/cursor", ".local/share/cursor-agent", ".local/state/cursor", ".cache/cursor-compile-cache"], keyring: true, env: { DISPLAY: ":99" } },
};

// Read-only toolchain and git identity, brought back into the empty home.
export const HOME_RO = [".local/bin", ".local/share/mise", ".config/mise", ".config/git", ".gitconfig", ".cargo/bin", ".bun/bin"];

// Why an agent can't be sandboxed, or "" when it can. `keyringAgents` is the
// owner's list of agents allowed keyring access (settings.json).
export function sandboxProblem(agent, keyringAgents = []) {
  const p = PROFILES[agent];
  if (!p) return "no sandbox profile";
  if (p.keyring && !keyringAgents.includes(agent)) return "its login is in the desktop keyring, which the sandbox keeps closed (allow it in settings: constanceKeyringAgents)";
  if (p.keyring && !hasProxy()) return "xdg-dbus-proxy is missing, so its keyring login can't be reached sandboxed";
  return "";
}

let proxyChecked = null;
function hasProxy() {
  if (proxyChecked === null) proxyChecked = spawnSync("sh", ["-c", "command -v xdg-dbus-proxy"], { stdio: "ignore" }).status === 0;
  return proxyChecked;
}

let bwrapChecked = null;
// bwrap must exist and be able to create a namespace here (some kernels forbid
// unprivileged user namespaces). Checked once per process.
export function bwrapWorks(bin = "bwrap") {
  if (bwrapChecked !== null) return bwrapChecked;
  const r = spawnSync(bin, ["--ro-bind", "/", "/", "--unshare-pid", "--dev", "/dev", "--proc", "/proc", "true"], { stdio: "ignore", timeout: 10e3 });
  bwrapChecked = r.status === 0;
  return bwrapChecked;
}

const under = (child, parent) => child === parent || child.startsWith(parent.endsWith("/") ? parent : parent + "/");

// A normal repo has .git as a directory; a linked worktree has it as a file
// pointing at <main>/.git/worktrees/<name>, whose commondir points back at the
// main .git. The sandbox needs the common dir for objects/refs and the worktree
// gitdir for index/HEAD — while hooks and config stay read-only either way.
function gitPointer(dir) {
  const file = path.join(dir, ".git");
  try {
    const st = fs.statSync(file);
    if (st.isDirectory()) return { type: "dir", dir: file };
    if (!st.isFile()) return null;
    const m = fs.readFileSync(file, "utf8").match(/^gitdir:\s*(.+)$/m);
    if (!m) return null;
    const gitDir = path.resolve(dir, m[1].trim());
    let common = gitDir;
    try {
      const rel = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
      if (rel) common = path.resolve(gitDir, rel);
    } catch {}
    return { type: "worktree", file, gitDir, common };
  } catch { return null; }
}

// What stays read-only inside a project bind: ALL of its git data and its
// .constance/ folder. Workers never write either; Constance (the controller)
// makes every commit, ref change and .constance/ write herself, on the host.
//   - a plain repo: <proj>/.git
//   - a linked worktree: its `.git` pointer file and the main repo's whole git
//     dir (objects, refs, config, hooks, worktrees/<name> with its commondir)
// Without this a worker could plant `commondir`, a ref or a config that host
// git later trusts (core.fsmonitor runs on the next `git status`).
export function protectedPaths(proj) {
  const out = [];
  const gi = gitPointer(proj);
  if (gi?.type === "dir") out.push(gi.dir);
  else if (gi?.type === "worktree") out.push(gi.file, gi.common, gi.gitDir);
  out.push(path.join(proj, ".constance"));
  return out;
}

// The --ro-bind args for protectedPaths. .constance/ is made on the host first
// (bwrap can only bind what exists); a .constance that is not a plain folder is
// refused, so nothing launches.
export function protectedBinds(proj, exists = (p) => fs.existsSync(p)) {
  const a = [];
  const gi = gitPointer(proj);
  if (gi?.type === "dir") a.push("--ro-bind", gi.dir, gi.dir);
  else if (gi?.type === "worktree") {
    a.push("--ro-bind", gi.file, gi.file);
    if (exists(gi.common)) a.push("--ro-bind", gi.common, gi.common);
  }
  const dc = path.join(proj, ".constance");
  let st = null;
  try { st = fs.lstatSync(dc); } catch {}
  if (st && !st.isDirectory()) throw new Error(`${dc} is not a plain folder`);
  if (!st) fs.mkdirSync(dc);
  a.push("--ro-bind", dc, dc);
  return a;
}

// The bwrap argv (without the command) for one job. `extraRw` takes absolute
// folders that also belong to the agent (a non-seated account's login home).
// Order matters: bwrap applies mounts in order, so the empty home comes first
// and every bind on top of it after.
export function sandboxArgs({ agent, dir, tmp, env = process.env, extraRw = [], keyringAgents = [], busSock = "" }) {
  const problem = sandboxProblem(agent, keyringAgents);
  if (problem) throw new Error(`${agent} can't run sandboxed: ${problem}`);
  const home = path.resolve(env.HOME || os.homedir());
  const proj = fs.realpathSync(dir);
  if (under(home, proj)) throw new Error("the project folder can't be the home folder or above it");
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const a = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", `/run/user/${uid}`,
    "--bind", tmp, "/tmp",
    "--tmpfs", home,                      // an empty home: nothing of the owner's is visible
    "--tmpfs", path.join(home, ".cache"), // throwaway caches
    "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    // When the CLI exits, everything it left running in the sandbox goes too
    // (Copilot starts its own dbus-daemons, Cursor a language server). bwrap's
    // parent is the job's `sh` wrapper, which lives exactly as long as the job.
    "--die-with-parent",
  ];
  const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
  for (const rel of HOME_RO) {
    const p = path.join(home, rel);
    if (exists(p)) a.push("--ro-bind", p, p);
  }
  // extraRw is bound verbatim, so it must never mount the real home (or "/")
  // back over the empty home, or cover the project's git data or .constance/
  // and re-expose them writable.
  const ro = protectedPaths(proj);
  for (const raw of extraRw) {
    const p = path.resolve(raw);
    if (p === "/" || under(home, p) || ro.some((r) => under(r, p) || under(p, r))) throw new Error(`extraRw ${p} would reopen the home folder or cover the project's git data`);
  }
  const rw = [...PROFILES[agent].rw.map((r) => path.join(home, r)), ...extraRw.map((p) => path.resolve(p))];
  for (const p of rw) {
    // The agent's own folders are made if missing, so a first login can land.
    if (!exists(p) && under(p, home)) fs.mkdirSync(p, { recursive: true });
    if (exists(p)) a.push("--bind", p, p);
  }
  a.push("--bind", proj, proj);
  a.push(...protectedBinds(proj, exists));
  // Keyring agents get the filtered proxy's socket as their only bus.
  if (busSock) a.push("--bind", busSock, `/run/user/${uid}/bus`);
  a.push("--chdir", proj);
  return a;
}

// The environment inside: no bus (unless the keyring proxy is given), no
// ssh-agent, no display, temp in /tmp.
export function sandboxEnv(env = process.env, agent = "", withBus = false) {
  const e = { ...env, TMPDIR: "/tmp" };
  for (const k of ["DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK", "SSH_AGENT_PID", "GPG_AGENT_INFO", "WAYLAND_DISPLAY", "DISPLAY", "XAUTHORITY"]) delete e[k];
  if (withBus) e.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${typeof process.getuid === "function" ? process.getuid() : 1000}/bus`;
  return { ...e, ...(PROFILES[agent]?.env || {}) };
}

// Runs the keyring proxy for exactly as long as the sandboxed agent: the proxy
// and bwrap share one process group, so Stop's group kill ends both.
const PROXY_SH = 'sock="$1"; bus="$2"; shift 2; xdg-dbus-proxy "$bus" "$sock" --filter --talk=org.freedesktop.secrets & p=$!; ' +
  'i=0; while [ ! -S "$sock" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done; "$@"; s=$?; kill $p 2>/dev/null; rm -f "$sock"; rmdir "$(dirname "$sock")" 2>/dev/null; exit $s';

// Every job is `sh` running bwrap (never exec'd), so bwrap's parent outlives
// the short-lived `delegate` call and --die-with-parent ties the sandbox to the job.
const PLAIN_SH = '"$@"; exit $?';

// { cmd: [cmd, ...args], env } for one sandboxed job, or a thrown reason when
// it can't be sandboxed (then nothing is launched with prompts off).
export function sandboxLaunch(argv, opts, bin = "bwrap") {
  if (!bwrapWorks(bin)) throw new Error("bubblewrap (bwrap) is missing or can't run here, so no agent is launched with its prompts off");
  const env = opts.env || process.env;
  const problem = sandboxProblem(opts.agent, opts.keyringAgents || []);
  if (problem) throw new Error(`${opts.agent} can't run sandboxed: ${problem}`);
  const keyring = !!PROFILES[opts.agent]?.keyring;
  // The proxy (started first by PROXY_SH) creates this socket before bwrap
  // runs, so bwrap binds the socket itself as the agent's only bus.
  // It lives in a private folder in the runtime dir: socket paths are capped at
  // 108 bytes, and a long temp path would be cut short.
  let busSock = "";
  if (keyring) {
    if (!env.DBUS_SESSION_BUS_ADDRESS) throw new Error(`${opts.agent} needs the keyring, but there is no session bus`);
    const run = env.XDG_RUNTIME_DIR && fs.existsSync(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : os.tmpdir();
    busSock = path.join(fs.mkdtempSync(path.join(run, "constance-bus-")), "bus");
  }
  const box = [bin, ...sandboxArgs({ ...opts, busSock }), "--", ...argv];
  const cmd = keyring ? ["sh", "-c", PROXY_SH, "sh", busSock, env.DBUS_SESSION_BUS_ADDRESS, ...box] : ["sh", "-c", PLAIN_SH, "sh", ...box];
  return { cmd, env: sandboxEnv(env, opts.agent, keyring) };
}

// ---------------------------------------------------------------- the self-merge suite
// A copy's tests are code the worker wrote, so the self-merge suite runs in the
// same kind of box as a worker, only tighter: no network (its own empty net
// namespace), nothing under /run (no session or system bus, no ssh-agent, no
// display), the real home an empty tmpfs with only the toolchains back
// read-only, and HOME plus every XDG dir pointed into the job's own temp folder.
// Writable: the worktree (minus its git data and .constance/) and that temp
// folder. The environment starts EMPTY, so no token or socket path leaks in.
export function suiteArgs({ dir, tmp, env = process.env }) {
  const home = path.resolve(env.HOME || os.homedir());
  const proj = fs.realpathSync(dir);
  if (under(home, proj)) throw new Error("the project folder can't be the home folder or above it");
  const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
  const a = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/run",
    "--bind", tmp, "/tmp",
    "--tmpfs", home,
    "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--new-session", "--die-with-parent",
  ];
  for (const rel of HOME_RO) {
    const p = path.join(home, rel);
    if (exists(p)) a.push("--ro-bind", p, p);
  }
  a.push("--bind", proj, proj);
  a.push(...protectedBinds(proj, exists));
  a.push("--chdir", proj);
  return a;
}

export function suiteEnv(env = process.env) {
  const h = "/tmp/home";
  return {
    PATH: env.PATH || "/usr/local/bin:/usr/bin:/bin",
    LANG: env.LANG || "C.UTF-8",
    HOME: h, TMPDIR: "/tmp", CI: "1",
    XDG_CONFIG_HOME: `${h}/.config`, XDG_STATE_HOME: `${h}/.local/state`, XDG_DATA_HOME: `${h}/.local/share`,
    XDG_CACHE_HOME: `${h}/.cache`, XDG_RUNTIME_DIR: "/tmp/run",
    npm_config_cache: `${h}/.npm`, npm_config_update_notifier: "false",
  };
}

// { cmd, env } running `sh -c command` in the suite box. The fake home folders
// are made inside tmp on the host first.
export function suiteLaunch(command, { dir, tmp, env = process.env }, bin = "bwrap") {
  if (!bwrapWorks(bin)) throw new Error("bubblewrap (bwrap) is missing or can't run here, so the suite can't run sandboxed");
  for (const d of ["home/.config", "home/.local/state", "home/.local/share", "home/.cache", "run"]) fs.mkdirSync(path.join(tmp, d), { recursive: true, mode: 0o700 });
  return { cmd: [bin, ...suiteArgs({ dir, tmp, env }), "--", "sh", "-c", command], env: suiteEnv(env) };
}
