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
// and the project's own .git/config and .git/hooks are read-only, so an agent
// can't plant a hook or fsmonitor command that later runs outside the sandbox.
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
  const gi = gitPointer(proj);
  // extraRw is bound verbatim, so it must never be able to mount the real home
  // (or "/") back over the empty-home tmpfs, or land on top of a read-only bind
  // and re-expose it writable. Refuse the home folder, any parent of it ("/"
  // included), and anything that is or contains a read-only bind destination.
  const roPaths = HOME_RO.map((r) => path.join(home, r)).filter(exists);
  if (gi?.type === "dir") roPaths.push(path.join(gi.dir, "hooks"), path.join(gi.dir, "config"));
  else if (gi?.type === "worktree") roPaths.push(gi.file, path.join(gi.common, "hooks"), path.join(gi.common, "config"), path.join(gi.common, "worktrees"));
  for (const raw of extraRw) {
    const p = path.resolve(raw);
    if (p === "/" || under(home, p) || roPaths.some((r) => under(r, p))) {
      throw new Error(`extraRw ${p} would reopen the home folder or cover a read-only bind`);
    }
  }
  for (const rel of HOME_RO) {
    const p = path.join(home, rel);
    if (exists(p)) a.push("--ro-bind", p, p);
  }
  const rw = [...PROFILES[agent].rw.map((r) => path.join(home, r)), ...extraRw.map((p) => path.resolve(p))];
  for (const p of rw) {
    // The agent's own folders are made if missing, so a first login can land.
    if (!exists(p) && under(p, home)) fs.mkdirSync(p, { recursive: true });
    if (exists(p)) a.push("--bind", p, p);
  }
  a.push("--bind", proj, proj);
  // The project's git config and hooks stay read-only: both can name commands
  // that git runs later, outside the sandbox (hooks, core.fsmonitor, core.hooksPath).
  if (gi?.type === "dir") {
    const hooks = path.join(gi.dir, "hooks");
    if (!exists(hooks)) fs.mkdirSync(hooks);
    a.push("--ro-bind", hooks, hooks);
    const cfg = path.join(gi.dir, "config");
    // bwrap can only ro-bind a file that exists, so a missing config gets an
    // empty one on the host first (an empty file is a valid git config). Without
    // this the agent could CREATE .git/config inside the writable project bind
    // and set core.hooksPath/core.fsmonitor for the next unsandboxed host git run.
    if (!exists(cfg)) fs.writeFileSync(cfg, "");
    a.push("--ro-bind", cfg, cfg);
  } else if (gi?.type === "worktree") {
    // In a worktree .git is a file: keep the pointer itself read-only, bind the
    // shared git dir for objects/refs, then re-expose only THIS worktree's
    // gitdir (index/HEAD) writable. Sibling worktrees' gitdirs stay read-only.
    a.push("--ro-bind", gi.file, gi.file);
    a.push("--bind", gi.common, gi.common);
    const hooks = path.join(gi.common, "hooks");
    if (!exists(hooks)) fs.mkdirSync(hooks);
    a.push("--ro-bind", hooks, hooks);
    const cfg = path.join(gi.common, "config");
    // Same as a plain repo's .git/config: create an empty file when missing so
    // the read-only bind always exists and the agent can't write one itself.
    if (!exists(cfg)) fs.writeFileSync(cfg, "");
    a.push("--ro-bind", cfg, cfg);
    const wts = path.join(gi.common, "worktrees");
    if (exists(wts)) {
      a.push("--ro-bind", wts, wts);
      if (exists(gi.gitDir)) a.push("--bind", gi.gitDir, gi.gitDir);
    }
  }
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
