// Deeper pass over bin/constance-sandbox.mjs: builds the bwrap argv for every
// agent and inspects the mount list itself — bwrap is NEVER launched here
// (constance-sandbox.test.mjs does the live escape checks). Covers what the
// live test can't see cheaply: every PROFILES entry, HOME_RO presence/absence,
// mount ordering (a later bind must sit on top of an earlier tmpfs/ro-bind),
// the keyring bus bind, per-job /tmp and the error paths. Pure argv inspection
// with a mktemp fake HOME; .git layouts are hand-made dirs/files, no real repo.
//
// BUGS FOUND (documented as commented-out tests at the bottom, NOT fixed):
//   1. extraRw is bound verbatim: an extraRw of the home folder itself (or "/")
//      emits `--bind <home> <home>` / `--bind / /` AFTER `--tmpfs <home>`, which
//      re-exposes everything the empty-home tmpfs was hiding.
//   2. `.git/config` (dir repo) and `<common>/config` (worktree) are only
//      ro-bound when the file exists at argv-build time. If it is missing the
//      agent can CREATE it inside the writable project bind and set
//      core.hooksPath/core.fsmonitor, which host git then runs unsandboxed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sandboxArgs, sandboxEnv, sandboxProblem, PROFILES, HOME_RO } from "./constance-sandbox.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constance-sandbox-deep-"));
const jobtmp = path.join(tmp, "jobtmp");
fs.mkdirSync(jobtmp);
const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
let seq = 0;
const mkHome = () => { const h = path.join(tmp, `home${++seq}`); fs.mkdirSync(h, { recursive: true }); return h; };
const mkProj = (home, name = "proj") => { const d = path.join(home, "Projects", name); fs.mkdirSync(d, { recursive: true }); return d; };
const put = (p, t = "x\n") => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
const envFor = (home, extra = {}) => ({ HOME: home, ...extra });

// Flatten the argv into mount records so order can be asserted too.
const mounts = (a) => {
  const out = [];
  for (let i = 0; i < a.length; i++) {
    const f = a[i];
    if (f === "--bind" || f === "--ro-bind") { out.push({ op: f.slice(2), src: a[i + 1], dst: a[i + 2] }); i += 2; }
    else if (["--tmpfs", "--dev", "--proc"].includes(f)) { out.push({ op: f.slice(2), src: a[i + 1], dst: a[i + 1] }); i += 1; }
    else if (f === "--chdir") { out.push({ op: "chdir", src: a[i + 1] }); i += 1; }
    else out.push({ op: f });
  }
  return out;
 };
const hasMount = (a, op, src, dst = src) => mounts(a).some((m) => m.op === op && m.src === src && m.dst === dst);
const argIndex = (a, flag, val) => a.findIndex((x, i) => x === val && a[i - 1] === flag);
const args = (o) => sandboxArgs({ tmp: jobtmp, ...o });

// ============================================================ 1. skeleton argv (no .git)
{
  const home = mkHome(), proj = mkProj(home);
  const a = args({ agent: "grok", dir: proj, env: envFor(home) });
  const m = mounts(a);

  // The whole system is read-only first; then per-job /tmp; then the empty home.
  assert.deepEqual(m[0], { op: "ro-bind", src: "/", dst: "/" });
  assert.ok(hasMount(a, "dev", "/dev") && hasMount(a, "proc", "/proc"), "dev and proc are bound");
  assert.ok(hasMount(a, "tmpfs", `/run/user/${uid}`), "the runtime dir (session bus, ssh-agent, keyring) is an empty tmpfs");
  assert.ok(hasMount(a, "bind", jobtmp, "/tmp"), "the job's own temp folder is /tmp");
  assert.ok(hasMount(a, "tmpfs", home), "home starts as an empty tmpfs");
  assert.ok(hasMount(a, "tmpfs", path.join(home, ".cache")), "home/.cache is a throwaway tmpfs");
  for (const f of ["--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent"]) assert.ok(a.includes(f), `${f} present`);
  assert.equal(a[a.length - 1], proj, "--chdir <project> is the last argument");
  assert.equal(m.at(-1).op, "chdir");

  // The project itself is writable, and nothing else under home is.
  assert.ok(hasMount(a, "bind", proj, proj), "project is bound writable");
  assert.ok(!m.some((x) => x.dst === home && x.op === "bind"), "home itself is never re-bound writable");
  assert.ok(!m.some((x) => x.src === "/" && x.op === "bind"), "root is never re-bound writable");

  // Mount order: the empty home tmpfs must come before every bind into it,
  // or the bind would be hidden under the tmpfs.
  const tmpfsHome = argIndex(a, "--tmpfs", home);
  for (const rel of [".grok", ...HOME_RO]) {
    const p = path.join(home, rel);
    const bi = argIndex(a, "--bind", p) >= 0 ? argIndex(a, "--bind", p) : argIndex(a, "--ro-bind", p);
    if (bi >= 0) assert.ok(tmpfsHome < bi, `${rel} bind sits on top of the home tmpfs`);
  }

  // No bus, no keyring socket: grok isn't a keyring agent and no busSock was given.
  assert.ok(!a.join(" ").includes("/bus"), "no bus bind for a non-keyring agent");
  assert.ok(!m.some((x) => x.dst === `/run/user/${uid}/bus`), "no bus destination at all");
}

// ============================================================ 2. HOME_RO and profile folders
{
  const home = mkHome(), proj = mkProj(home);
  // Only some toolchain folders exist: the rest must be skipped, not bound.
  put(path.join(home, ".local", "bin", "tool"));
  put(path.join(home, ".config", "git", "config"));
  put(path.join(home, ".gitconfig"));
  put(path.join(home, ".grok", "auth.json"));           // grok's own login folder, pre-existing
  const a = args({ agent: "grok", dir: proj, env: envFor(home) });
  for (const rel of [".local/bin", ".config/git", ".gitconfig"]) {
    const p = path.join(home, rel);
    assert.ok(hasMount(a, "ro-bind", p), `existing HOME_RO ${rel} is bound read-only`);
    assert.ok(!hasMount(a, "bind", p), `HOME_RO ${rel} is never writable`);
  }
  for (const rel of [".local/share/mise", ".config/mise", ".cargo/bin", ".bun/bin"]) {
    assert.ok(!a.join(" ").includes(path.join(home, rel)), `missing HOME_RO ${rel} produces no bind`);
    assert.ok(!fs.existsSync(path.join(home, rel)), `missing HOME_RO ${rel} is not created on the host`);
  }
  assert.ok(hasMount(a, "bind", path.join(home, ".grok"), path.join(home, ".grok")), "grok's own folder is writable");
}

// A missing profile folder under home is CREATED on the host, then bound writable
// (a first login needs somewhere to land). One outside home is skipped entirely.
{
  const home = mkHome(), proj = mkProj(home);
  const outside = path.join(tmp, `outside${seq}`);
  put(path.join(outside, "file"));
  const missingOutside = path.join(tmp, `missing-outside${seq}`);
  const devinHome = path.join(home, ".config", "devin");   // two levels deep, absent
  const a = args({ agent: "devin", dir: proj, env: envFor(home), extraRw: [outside, missingOutside] });
  assert.ok(fs.existsSync(devinHome), "missing profile folder under home is created");
  assert.ok(hasMount(a, "bind", devinHome, devinHome), "created profile folder is bound writable");
  assert.ok(hasMount(a, "bind", outside, outside), "existing extraRw outside home is bound writable");
  assert.ok(!a.join(" ").includes(missingOutside), "missing extraRw outside home is skipped");
  assert.ok(!fs.existsSync(missingOutside), "missing extraRw outside home is not created");
  for (const rel of PROFILES.devin.rw) {
    const p = path.join(home, rel);
    assert.ok(hasMount(a, "bind", p, p), `devin rw ${rel} bound writable`);
  }
}

// ============================================================ 3. every PROFILES entry
{
  for (const [id, p] of Object.entries(PROFILES)) {
    const home = mkHome(), proj = mkProj(home);
    const keyringAgents = p.keyring ? [id] : [];
    let a;
    try {
      a = args({ agent: id, dir: proj, env: envFor(home), keyringAgents, busSock: p.keyring ? "/run/user/1000/x/bus" : "" });
    } catch (e) {
      // Hosts without xdg-dbus-proxy can't sandbox keyring agents at all.
      assert.match(e.message, /xdg-dbus-proxy/, `${id}: only the proxy check may fail here`);
      continue;
    }
    for (const rel of p.rw) {
      const f = path.join(home, rel);
      assert.ok(hasMount(a, "bind", f, f), `${id}: rw ${rel} is bound writable`);
      assert.ok(fs.existsSync(f), `${id}: rw ${rel} exists after argv build`);
    }
    assert.ok(!m_has_ro(a, home, p.rw), `${id}: no profile folder is read-only`);
    function m_has_ro(argv, h, rw) {
      return mounts(argv).some((x) => x.op === "ro-bind" && rw.some((r) => x.src === path.join(h, r)));
    }
    if (p.keyring) {
      assert.ok(hasMount(a, "bind", "/run/user/1000/x/bus", `/run/user/${uid}/bus`), `${id}: keyring proxy socket is the only bus`);
      const bi = argIndex(a, "--bind", "/run/user/1000/x/bus");
      assert.ok(bi >= 0 && bi < argIndex(a, "--chdir", proj), `${id}: bus bind precedes --chdir`);
    } else {
      assert.ok(!a.join(" ").includes("/bus"), `${id}: non-keyring agent gets no bus bind`);
    }
  }
}

// ============================================================ 4. .git read-only surfaces
{
  // Plain repo: .git is a directory. hooks/ and config/ must be ro-bound ON TOP
  // of the writable project bind (later mounts win in bwrap).
  const home = mkHome(), proj = mkProj(home);
  put(path.join(proj, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
  fs.mkdirSync(path.join(proj, ".git", "hooks"));
  const a = args({ agent: "grok", dir: proj, env: envFor(home) });
  const hooks = path.join(proj, ".git", "hooks"), cfg = path.join(proj, ".git", "config");
  assert.ok(hasMount(a, "ro-bind", hooks), ".git/hooks is read-only");
  assert.ok(hasMount(a, "ro-bind", cfg), ".git/config is read-only");
  assert.ok(!hasMount(a, "bind", hooks) && !hasMount(a, "bind", cfg), "git surfaces are never writable");
  assert.ok(argIndex(a, "--bind", proj) < argIndex(a, "--ro-bind", cfg), "project bind comes before the config ro-bind");
  assert.ok(argIndex(a, "--bind", proj) < argIndex(a, "--ro-bind", hooks), "project bind comes before the hooks ro-bind");

  // hooks/ missing: the builder creates it (on the host) so it can ro-bind it.
  const home2 = mkHome(), proj2 = mkProj(home2, "p2");
  put(path.join(proj2, ".git", "config"));
  const a2 = args({ agent: "grok", dir: proj2, env: envFor(home2) });
  assert.ok(fs.existsSync(path.join(proj2, ".git", "hooks")), "missing .git/hooks is created for the ro-bind");
  assert.ok(hasMount(a2, "ro-bind", path.join(proj2, ".git", "hooks")), "created hooks dir is ro-bound");

  // No .git at all: no git mounts, and nothing is created inside the project.
  const home3 = mkHome(), proj3 = mkProj(home3, "p3");
  const a3 = args({ agent: "grok", dir: proj3, env: envFor(home3) });
  assert.ok(!a3.join(" ").includes(".git"), "a non-repo project gets no .git mounts");
}

// Linked worktree: .git is a pointer FILE. The pointer stays ro, the shared git
// dir is bound for objects/refs, hooks/config/worktrees stay ro on top, and only
// THIS worktree's gitdir is writable.
{
  const home = mkHome();
  const main = mkProj(home, "main");
  const wt = path.join(tmp, `wt${seq}`); fs.mkdirSync(wt);
  const gitDir = path.join(main, ".git", "worktrees", "wt1");
  put(path.join(main, ".git", "config"), "[core]\n\tbare = false\n");
  fs.mkdirSync(path.join(main, ".git", "hooks"), { recursive: true });
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
  put(path.join(main, ".git", "worktrees", "sibling", "index"), "sibling\n"); // a sibling worktree's gitdir
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${gitDir}\n`);

  const a = args({ agent: "grok", dir: wt, env: envFor(home) });
  const common = path.join(main, ".git");
  assert.ok(hasMount(a, "ro-bind", path.join(wt, ".git")), "the .git pointer file is read-only");
  assert.ok(hasMount(a, "bind", common, common), "the shared git dir is writable (objects/refs)");
  assert.ok(hasMount(a, "ro-bind", path.join(common, "hooks")), "shared hooks stay read-only");
  assert.ok(hasMount(a, "ro-bind", path.join(common, "config")), "shared config stays read-only");
  assert.ok(hasMount(a, "ro-bind", path.join(common, "worktrees")), "the worktrees dir is read-only");
  assert.ok(hasMount(a, "bind", gitDir, gitDir), "this worktree's gitdir is writable");
  // Order matters: every ro-bind protecting shared git state must sit AFTER the
  // writable common bind, and the worktree gitdir bind after the worktrees ro-bind.
  assert.ok(argIndex(a, "--bind", common) < argIndex(a, "--ro-bind", path.join(common, "hooks")), "hooks ro on top of common bind");
  assert.ok(argIndex(a, "--ro-bind", path.join(common, "worktrees")) < argIndex(a, "--bind", gitDir), "own gitdir writable on top of worktrees ro");
  assert.ok(!hasMount(a, "bind", path.join(common, "worktrees", "sibling")), "a sibling worktree's gitdir is never writable");
}

// ============================================================ 5. keyring opt-in and env
{
  const home = mkHome(), proj = mkProj(home);
  // Without the owner's opt-in a keyring agent never reaches argv generation.
  for (const id of ["antigravity", "copilot", "cursor"]) {
    assert.match(sandboxProblem(id), /keyring/, `${id} refused without opt-in`);
    assert.throws(() => args({ agent: id, dir: proj, env: envFor(home) }), /keyring/, `${id} throws`);
  }
  // Opt-in clears the keyring complaint (a missing xdg-dbus-proxy may still complain).
  assert.doesNotMatch(sandboxProblem("copilot", ["copilot"]), /keyring/, "opted-in copilot passes the keyring check");

  // sandboxEnv: bus/display/agent sockets stripped; TMPDIR pinned; cursor's
  // dead DISPLAY comes back via its profile; keyring agents get the proxy bus.
  const dirty = { HOME: home, DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    SSH_AUTH_SOCK: "/run/user/1000/ssh-agent.sock", SSH_AGENT_PID: "1", GPG_AGENT_INFO: "x",
    WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0", XAUTHORITY: "/h/.Xauthority" };
  const eg = sandboxEnv(dirty, "grok");
  assert.equal(eg.TMPDIR, "/tmp");
  for (const k of ["DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK", "SSH_AGENT_PID", "GPG_AGENT_INFO", "WAYLAND_DISPLAY", "DISPLAY", "XAUTHORITY"]) {
    assert.ok(!(k in eg), `sandboxEnv strips ${k}`);
  }
  assert.equal(sandboxEnv(dirty, "grok", true).DBUS_SESSION_BUS_ADDRESS, `unix:path=/run/user/${uid}/bus`, "withBus points at the proxy socket");
  assert.equal(sandboxEnv(dirty, "cursor").DISPLAY, ":99", "cursor's profile re-adds its dead DISPLAY");
  assert.ok(!("DISPLAY" in sandboxEnv(dirty, "grok")), "other agents get no display");
}

// ============================================================ 6. error paths
{
  const home = mkHome(), proj = mkProj(home);
  assert.throws(() => args({ agent: "nobody", dir: proj, env: envFor(home) }), /no sandbox profile/);
  assert.throws(() => args({ agent: "grok", dir: home, tmp: jobtmp, env: envFor(home) }), /home folder/, "home itself is never a project");
  assert.throws(() => args({ agent: "grok", dir: tmp, tmp: jobtmp, env: envFor(home) }), /home folder/, "a folder above home is never a project");
  assert.throws(() => args({ agent: "grok", dir: path.join(tmp, "no-such-dir"), tmp: jobtmp, env: envFor(home) }), /ENOENT/, "a missing project dir throws");
}

// ============================================================ 7. bugs found (NOT fixed — see header)
// BUG 1: extraRw is bound verbatim with no check that it isn't the home folder
// or a wider ancestor. `--bind <home> <home>` lands AFTER `--tmpfs <home>`, so it
// remounts the real home writable inside the "empty" home; `--bind / /` would do
// the same for the whole root. sandboxArgs should refuse extraRw that is home
// itself or an ancestor of it (under() is only used for the project check).
//
//   // const home = mkHome(), proj = mkProj(home);
//   // const a = args({ agent: "grok", dir: proj, env: envFor(home), extraRw: [home] });
//   // SHOULD throw (or omit the bind); currently emits:
//   //   --tmpfs <home> ... --bind <home> <home>  -> real home writable
//   // assert.throws(() => args({ agent: "grok", dir: proj, env: envFor(home), extraRw: [home] }), /home/);
//   // assert.ok(!hasMount(a, "bind", home, home), "home must never be re-bound writable");
//
// BUG 2: `.git/config` (plain repo) and `<common>/config` (worktree) are only
// ro-bound `if (exists(cfg))`. With no config file yet, the agent can create one
// inside the writable project bind and set core.hooksPath/core.fsmonitor to a
// directory it controls; the next UNSANDBOXED host git command (commit, status)
// then runs that hook. Rare — git always writes config — but the protection is
// conditional on a file that can appear later. The .git dir itself would need a
// ro-bind (or a stub config ro-bound over a writable .git) to close it.
//
//   // const home = mkHome(), proj = mkProj(home);
//   // put(path.join(proj, ".git", "HEAD"));              // .git exists, config does NOT
//   // const a = args({ agent: "grok", dir: proj, env: envFor(home) });
//   // SHOULD keep .git/config unwritable even when absent; currently there is
//   // no ro-bind at all, so `--bind <proj>` leaves .git/config creatable:
//   // assert.ok(hasMount(a, "ro-bind", path.join(proj, ".git", "config")), ".git/config protected even when missing");
//   // (this assert FAILS today — that is the bug)

fs.rmSync(tmp, { recursive: true, force: true });
console.log("constance-sandbox.deep: tests passed");
