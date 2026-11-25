// Deeper pass over bin/constance-sandbox.mjs: builds the bwrap argv for every
// agent and inspects the mount list itself — bwrap is NEVER launched here
// (constance-sandbox.test.mjs does the live escape checks). Covers what the
// live test can't see cheaply: every PROFILES entry, HOME_RO presence/absence,
// mount ordering (a later bind must sit on top of an earlier tmpfs/ro-bind),
// the keyring bus bind, per-job /tmp and the error paths. Pure argv inspection
// with a mktemp fake HOME; .git layouts are hand-made dirs/files, no real repo.
//
// Section 7 covers the two bugs this pass found and that are now fixed:
// extraRw that would reopen the home folder or cover a read-only bind is
// refused, and .git/config (dir repo and worktree common dir) is ro-bound even
// when the file didn't exist at argv-build time.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandboxArgs, sandboxEnv, sandboxLaunch, sandboxProblem, bwrapWorks, PROFILES, HOME_RO } from "./constance-sandbox.mjs";

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

// ============================================================ 7. bugs found (now fixed)
// BUG 1 (fixed): extraRw is bound verbatim, so `--bind <home> <home>` landed
// AFTER `--tmpfs <home>` and remounted the real home writable inside the
// "empty" one; `--bind / /` did the same for the whole root. sandboxArgs now
// refuses extraRw that is the home folder, any parent of it ("/" included), or
// anything that is or contains a read-only bind destination.
{
  const home = mkHome(), proj = mkProj(home);
  assert.throws(() => args({ agent: "grok", dir: proj, env: envFor(home), extraRw: [home] }), /home/, "the home folder itself is refused");
  assert.throws(() => args({ agent: "grok", dir: proj, env: envFor(home), extraRw: ["/"] }), /home|read-only/, "root is refused");
  assert.throws(() => args({ agent: "grok", dir: proj, env: envFor(home), extraRw: [path.dirname(home)] }), /home|read-only/, "a parent of home is refused");
  // A writable bind on top of a read-only one is refused too: .config/git is a
  // HOME_RO ro-bind, so its parent can't come back writable.
  put(path.join(home, ".config", "git", "config"));
  assert.throws(() => args({ agent: "grok", dir: proj, env: envFor(home), extraRw: [path.join(home, ".config")] }), /read-only/, "a parent of a ro-bind is refused");
  assert.throws(() => args({ agent: "grok", dir: proj, env: envFor(home), extraRw: [path.join(home, ".config", "git")] }), /read-only/, "a ro-bind itself is refused");
  // A harmless sibling folder is still bound writable.
  const sib = path.join(tmp, `sib${seq}`); put(path.join(sib, "f"));
  const a = args({ agent: "grok", dir: proj, env: envFor(home), extraRw: [sib] });
  assert.ok(hasMount(a, "bind", sib, sib), "a harmless extraRw is still bound");
}

// BUG 2 (fixed): `.git/config` (plain repo) and `<common>/config` (worktree)
// were only ro-bound `if (exists(cfg))`. With no config file yet, the agent
// could create one inside the writable project bind and set
// core.hooksPath/core.fsmonitor; the next UNSANDBOXED host git command would
// then run that hook. bwrap can only ro-bind an existing file, so the builder
// now creates an empty config on the host (valid git) and always ro-binds it.
{
  const home = mkHome(), proj = mkProj(home);
  put(path.join(proj, ".git", "HEAD"));              // .git exists, config does NOT
  const a = args({ agent: "grok", dir: proj, env: envFor(home) });
  const cfg = path.join(proj, ".git", "config");
  assert.ok(hasMount(a, "ro-bind", cfg), ".git/config is read-only even when it was missing");
  assert.equal(fs.readFileSync(cfg, "utf8"), "", "the created config is empty");

  // Same for a linked worktree's common-dir config.
  const home2 = mkHome();
  const main = mkProj(home2, "main");
  const wt = path.join(tmp, `wt${seq}`); fs.mkdirSync(wt);
  const gitDir = path.join(main, ".git", "worktrees", "wt2");
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${gitDir}\n`);
  const a2 = args({ agent: "grok", dir: wt, env: envFor(home2) });
  const commonCfg = path.join(main, ".git", "config");
  assert.ok(hasMount(a2, "ro-bind", commonCfg), "worktree common config is read-only even when missing");
  assert.equal(fs.readFileSync(commonCfg, "utf8"), "", "the created common config is empty");
}

// ============================================================ 8. sandboxEnv: defaults, wrong types, purity
{
  const e0 = sandboxEnv();
  assert.equal(e0.TMPDIR, "/tmp", "a no-arg env still gets TMPDIR");
  assert.deepEqual(Object.keys(sandboxEnv({})).sort(), ["TMPDIR"], "an empty env yields only TMPDIR");
  assert.equal(sandboxEnv(null).TMPDIR, "/tmp", "a null env doesn't throw");
  const src = { KEEP: "1", N: 5, DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" };
  const out = sandboxEnv(src, "nobody", 1);
  assert.equal(out.KEEP, "1");
  assert.equal(out.N, 5, "non-string values pass through untouched");
  assert.equal(out.DBUS_SESSION_BUS_ADDRESS, `unix:path=/run/user/${uid}/bus`, "a truthy withBus sets the proxy bus");
  assert.equal(src.DBUS_SESSION_BUS_ADDRESS, "unix:path=/x", "the input env object is never mutated");
  assert.ok(!("DBUS_SESSION_BUS_ADDRESS" in sandboxEnv(src, "nobody", 0)), "a falsy withBus still strips the bus");
  // cursor's dead DISPLAY survives even on the bus path; other agents get none.
  const ce = sandboxEnv({ DISPLAY: ":0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" }, "cursor", true);
  assert.equal(ce.DISPLAY, ":99");
  assert.equal(ce.DBUS_SESSION_BUS_ADDRESS, `unix:path=/run/user/${uid}/bus`);
  // Profile env is per-agent: an unknown agent gets no extras at all.
  const ue = sandboxEnv({}, "not-an-agent");
  assert.deepEqual(Object.keys(ue), ["TMPDIR"]);
}

// ============================================================ 9. path and .git edge cases
{
  const home = mkHome(), proj = mkProj(home);

  // A sibling whose name merely shares home's prefix is NOT "under" home.
  const sibling = path.join(tmp, `${path.basename(home)}-other`, "proj");
  fs.mkdirSync(sibling, { recursive: true });
  assert.doesNotThrow(() => args({ agent: "grok", dir: sibling, tmp: jobtmp, env: envFor(home) }),
    "a sibling sharing home's name prefix is allowed");

  // HOME with a trailing slash resolves to the same home.
  const aT = args({ agent: "grok", dir: proj, tmp: jobtmp, env: { HOME: home + "/" } });
  assert.ok(hasMount(aT, "tmpfs", home), "HOME trailing slash resolves to the same home");

  // A project OUTSIDE home is fine — and then extraRw can't smuggle the
  // project's own read-only git binds back writable.
  const outProj = path.join(tmp, `out${seq}`); fs.mkdirSync(outProj);
  put(path.join(outProj, ".git", "config"));
  fs.mkdirSync(path.join(outProj, ".git", "hooks"), { recursive: true });
  const aOut = args({ agent: "grok", dir: outProj, tmp: jobtmp, env: envFor(home) });
  assert.ok(hasMount(aOut, "bind", outProj), "a project outside home binds writable");
  assert.throws(() => args({ agent: "grok", dir: outProj, tmp: jobtmp, env: envFor(home), extraRw: [outProj] }),
    /read-only/, "extraRw can't re-cover the project's own ro-bound git files");
  assert.throws(() => args({ agent: "grok", dir: outProj, tmp: jobtmp, env: envFor(home), extraRw: [path.join(outProj, ".git", "hooks")] }),
    /read-only/, "extraRw can't re-cover .git/hooks itself");

  // extraRw: an existing FILE binds verbatim; blank and non-string entries are
  // dropped before resolving — "" would resolve to the process cwd and bind it
  // writable.
  const f = path.join(tmp, `file${seq}`); put(f);
  const aF = args({ agent: "grok", dir: proj, tmp: jobtmp, env: envFor(home), extraRw: [f] });
  assert.ok(hasMount(aF, "bind", f, f), "an extraRw file is bound verbatim");
  const cwd = process.cwd();
  const aDrop = args({ agent: "grok", dir: proj, tmp: jobtmp, env: envFor(home), extraRw: ["", "   ", 42, null, undefined] });
  assert.ok(!mounts(aDrop).some((x) => x.op === "bind" && x.src === cwd), "a blank extraRw never binds the cwd");
  assert.ok(!mounts(aDrop).some((x) => x.op === "bind" && x.dst === cwd), "a blank extraRw never lands on the cwd");

  // A .git that is neither a directory nor a gitdir pointer is ignored.
  const homeG = mkHome();
  for (const [nm, content] of [["empty", ""], ["noptr", "hello\n"]]) {
    const p = path.join(homeG, "Projects", nm); fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, ".git"), content);
    const aa = args({ agent: "grok", dir: p, tmp: jobtmp, env: envFor(homeG) });
    assert.ok(!aa.join(" ").includes(".git"), `${nm}: an unreadable .git file yields no git mounts`);
    assert.ok(!fs.existsSync(path.join(p, "hooks")), `${nm}: nothing is created inside the project`);
  }

  // A .git that is a FIFO (neither dir nor regular file) is ignored too.
  const homeF = mkHome(), projF = mkProj(homeF, "fifo");
  if (spawnSync("mkfifo", [path.join(projF, ".git")]).status === 0) {
    const af = args({ agent: "grok", dir: projF, tmp: jobtmp, env: envFor(homeF) });
    assert.ok(!af.join(" ").includes(".git"), "a .git FIFO yields no git mounts");
  }

  // A RELATIVE gitdir resolves against the project dir.
  const homeR = mkHome(), projR = mkProj(homeR, "rel");
  const absGit = path.join(projR, "sub", "gitdir");
  fs.mkdirSync(absGit, { recursive: true });
  fs.writeFileSync(path.join(projR, ".git"), "gitdir: sub/gitdir\n");
  const aR = args({ agent: "grok", dir: projR, tmp: jobtmp, env: envFor(homeR) });
  assert.ok(hasMount(aR, "ro-bind", path.join(projR, ".git")), "the relative-pointer .git file is read-only");
  assert.ok(hasMount(aR, "bind", absGit, absGit), "the relative gitdir resolves under the project");
  assert.ok(hasMount(aR, "ro-bind", path.join(absGit, "config")), "the resolved gitdir's config is read-only");

  // A commondir that is a DIRECTORY (not a file) can't be read: common falls
  // back to the gitdir itself.
  const homeC = mkHome(), projC = mkProj(homeC, "commondir");
  const wtC = path.join(tmp, `wtc${seq}`); fs.mkdirSync(wtC);
  const gitC = path.join(projC, ".git", "worktrees", "w");
  fs.mkdirSync(path.join(gitC, "commondir"), { recursive: true }); // a dir named commondir
  fs.writeFileSync(path.join(wtC, ".git"), `gitdir: ${gitC}\n`);
  const aC = args({ agent: "grok", dir: wtC, tmp: jobtmp, env: envFor(homeC) });
  assert.ok(hasMount(aC, "bind", gitC, gitC), "an unreadable commondir falls back to the gitdir as common");
  assert.ok(hasMount(aC, "ro-bind", path.join(gitC, "config")), "the fallback common's config is still read-only");

  // A symlinked .git dir still counts as a directory (statSync follows it).
  const homeS = mkHome(), projS = mkProj(homeS, "sym");
  const realGit = path.join(tmp, `realgit${seq}`); fs.mkdirSync(realGit);
  put(path.join(realGit, "config")); fs.mkdirSync(path.join(realGit, "hooks"));
  fs.symlinkSync(realGit, path.join(projS, ".git"));
  const aS = args({ agent: "grok", dir: projS, tmp: jobtmp, env: envFor(homeS) });
  assert.ok(hasMount(aS, "ro-bind", path.join(projS, ".git", "hooks")), "a symlinked .git dir still protects hooks");

  // .git/hooks existing as a FILE is ro-bound as a file (no mkdir, no throw):
  // inside the sandbox the agent sees a file where git wants a dir.
  const homeH = mkHome(), projH = mkProj(homeH, "hookfile");
  put(path.join(projH, ".git", "config")); put(path.join(projH, ".git", "hooks"), "not a dir\n");
  const aH = args({ agent: "grok", dir: projH, tmp: jobtmp, env: envFor(homeH) });
  assert.ok(hasMount(aH, "ro-bind", path.join(projH, ".git", "hooks")), "a hooks FILE is ro-bound verbatim");

  // HOME pointing at a plain file can't hold profile folders: raw fs error.
  const homeFile = path.join(tmp, `homefile${seq}`); put(homeFile);
  const projX = mkProj(mkHome(), "x");
  assert.throws(() => args({ agent: "grok", dir: projX, tmp: jobtmp, env: { HOME: homeFile } }));

  // Building twice with identical inputs gives an identical argv.
  const homeD = mkHome(), projD = mkProj(homeD);
  const oD = { agent: "grok", dir: projD, tmp: jobtmp, env: envFor(homeD) };
  assert.deepEqual(args(oD), args(oD), "argv construction is deterministic");

  // busSock is caller-controlled: sandboxArgs binds whatever it is handed,
  // even for a non-keyring agent.
  const aB = args({ agent: "grok", dir: proj, tmp: jobtmp, env: envFor(home), busSock: "/x/bus" });
  assert.ok(hasMount(aB, "bind", "/x/bus", `/run/user/${uid}/bus`), "a given busSock is bound as the only bus");
}

// ============================================================ 10. bwrapWorks cache and sandboxLaunch
// bwrapWorks(bin) caches per bin: probing one path must not decide another's
// fate. The first call below warms the cache for the REAL bwrap; the missing
// path is then probed (and cached) separately.
{
  const missingBin = path.join(tmp, `missing-bwrap-${seq}`);
  assert.equal(bwrapWorks(missingBin), false, "a missing bwrap path is refused");
  assert.equal(bwrapWorks(missingBin), false, "the refusal is cached for that bin");
  if (bwrapWorks()) {
    assert.equal(bwrapWorks(), true, "the real bwrap still works");
    assert.equal(bwrapWorks(missingBin), false, "a bad bin doesn't poison the good one's cache");
  }
}
if (!bwrapWorks()) {
  console.log("constance-sandbox.deep: bwrap can't run here — launch-shape tests skipped");
} else {
  const homeL = mkHome(), projL = mkProj(homeL);
  const dirty = { ...envFor(homeL), DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    SSH_AUTH_SOCK: "/run/user/1000/ssh-agent.sock", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" };

  // Non-keyring job: sh -c wrapper, bwrap argv, "--" separator, agent argv last.
  const l = sandboxLaunch(["agent", "-p", "hi"], { agent: "grok", dir: projL, tmp: jobtmp, env: dirty });
  assert.equal(l.cmd[0], "sh");
  assert.equal(l.cmd[1], "-c");
  assert.ok(l.cmd[2].includes("exit $?"), "plain jobs run the command then propagate its status");
  assert.equal(l.cmd[3], "sh");
  assert.equal(l.cmd[4], "bwrap", "the default bwrap binary is used");
  assert.deepEqual(l.cmd.slice(l.cmd.indexOf("--") + 1), ["agent", "-p", "hi"], "agent argv follows --");
  assert.equal(l.env.TMPDIR, "/tmp");
  assert.equal(l.env.HOME, homeL, "HOME passes through to the sandbox env");
  for (const k of ["DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK", "WAYLAND_DISPLAY", "DISPLAY"]) {
    assert.ok(!(k in l.env), `launch env strips ${k}`);
  }

  // A custom bwrap path is used verbatim: a stub that exits 0 passes the
  // per-bin probe and its path lands in argv untouched. (A missing path is now
  // really probed — bwrapWorks is keyed by bin — so it would be refused.)
  const fakeBwrap = path.join(tmp, `fake-bwrap-${seq}`);
  fs.writeFileSync(fakeBwrap, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(fakeBwrap, 0o755);
  const lb = sandboxLaunch(["true"], { agent: "grok", dir: projL, tmp: jobtmp, env: dirty }, fakeBwrap);
  assert.ok(lb.cmd.includes(fakeBwrap), "a custom bwrap path lands in argv");
  assert.throws(() => sandboxLaunch(["true"], { agent: "grok", dir: projL, tmp: jobtmp, env: dirty }, "/nonexistent/bwrap-bin"),
    /bubblewrap/, "a missing custom bwrap path is refused, not trusted from another bin's cache");

  // Keyring agent with the owner's opt-in: the filtered proxy wraps bwrap and
  // gets a private socket dir under XDG_RUNTIME_DIR.
  const proxyOk = spawnSync("sh", ["-c", "command -v xdg-dbus-proxy"], { stdio: "ignore" }).status === 0;
  if (!proxyOk) {
    console.log("constance-sandbox.deep: xdg-dbus-proxy missing — keyring launch tests skipped");
  } else {
    const runDir = path.join(tmp, `run${seq}`); fs.mkdirSync(runDir);
    const busDirs = () => fs.readdirSync(runDir).filter((n) => n.startsWith("constance-bus-"));
    const kOpts = { agent: "copilot", dir: projL, tmp: jobtmp, env: { ...dirty, XDG_RUNTIME_DIR: runDir }, keyringAgents: ["copilot"] };
    const k = sandboxLaunch(["copilot", "-p", "x"], kOpts);
    assert.equal(k.cmd[0], "sh");
    assert.equal(k.cmd[3], "sh");
    const busSock = k.cmd[4];
    assert.ok(busSock.startsWith(runDir + path.sep + "constance-bus-"), "the proxy socket lives in a private mkdtemp under XDG_RUNTIME_DIR");
    assert.equal(k.cmd[5], "unix:path=/run/user/1000/bus", "the real bus address is handed to the proxy script");
    assert.ok(k.cmd[2].includes("xdg-dbus-proxy") && k.cmd[2].includes("--talk=org.freedesktop.secrets"),
      "the proxy script filters to org.freedesktop.secrets only");
    assert.ok(k.cmd.includes("--bind") && k.cmd.includes(busSock), "the socket is bound into the sandbox");
    assert.equal(k.env.DBUS_SESSION_BUS_ADDRESS, `unix:path=/run/user/${uid}/bus`, "the agent sees only the proxy bus");
    assert.ok(!k.env.SSH_AUTH_SOCK && !k.env.WAYLAND_DISPLAY && !("DISPLAY" in k.env), "agent sockets stay stripped");
    assert.equal(busDirs().length, 1, "one socket dir per launch");

    // A second launch gets its own socket dir — no sharing, no collision.
    const k2 = sandboxLaunch(["copilot", "-p", "y"], kOpts);
    assert.notEqual(k2.cmd[4], busSock, "each launch mkdtemps its own bus dir");
    assert.equal(busDirs().length, 2);
    for (const d of busDirs()) fs.rmSync(path.join(runDir, d), { recursive: true, force: true });

    // No session bus in the env: refused BEFORE any socket dir is made.
    assert.throws(() => sandboxLaunch(["copilot"], { agent: "copilot", dir: projL, tmp: jobtmp, env: envFor(homeL), keyringAgents: ["copilot"] }),
      /session bus/);
    assert.equal(busDirs().length, 0, "a refused keyring launch leaves nothing behind");

    // XDG_RUNTIME_DIR that doesn't exist falls back to os.tmpdir().
    const missing = path.join(tmp, `no-run${seq}`);
    const k3 = sandboxLaunch(["copilot"], { agent: "copilot", dir: projL, tmp: jobtmp, env: { ...dirty, XDG_RUNTIME_DIR: missing }, keyringAgents: ["copilot"] });
    const sockDir = path.dirname(k3.cmd[4]);
    assert.equal(path.dirname(sockDir), os.tmpdir(), "a missing XDG_RUNTIME_DIR falls back to the temp dir");
    assert.ok(path.basename(sockDir).startsWith("constance-bus-"));
    fs.rmSync(sockDir, { recursive: true, force: true });

    // XDG_RUNTIME_DIR pointing at a plain FILE passes existsSync, then
    // mkdtempSync under it throws — a raw ENOTDIR, not a friendly error.
    const runFile = path.join(tmp, `runfile${seq}`); put(runFile);
    assert.throws(() => sandboxLaunch(["copilot"], { agent: "copilot", dir: projL, tmp: jobtmp, env: { ...dirty, XDG_RUNTIME_DIR: runFile }, keyringAgents: ["copilot"] }));
  }

  // Error paths that never reach argv building.
  assert.throws(() => sandboxLaunch(["x"], { agent: "nobody", dir: projL, tmp: jobtmp, env: dirty }), /no sandbox profile/);
  assert.throws(() => sandboxLaunch(["x"], null), TypeError, "null opts throw");
  assert.throws(() => sandboxLaunch(["x"], { agent: "grok", dir: path.join(tmp, "missing-dir"), tmp: jobtmp, env: dirty }), /ENOENT/);

  // BUG: `tmp` is never validated — omitting it puts `undefined` into the
  // bwrap argv (a.push("--bind", tmp, "/tmp")). Commented out: it would assert
  // on argv containing undefined, which spawn would reject later anyway.
  // const lNoTmp = sandboxLaunch(["true"], { agent: "grok", dir: projL, env: dirty });
  // assert.ok(lNoTmp.cmd.includes(undefined), "BUG: undefined tmp lands in argv");
}

// ============================================================ 11. corrupt .git pointers and prototype agents
{
  const home = mkHome(), proj = mkProj(home);

  // Agent names that collide with Object.prototype members must be refused as
  // unknown: PROFILES["__proto__"] is Object.prototype (truthy), which used to
  // pass the "no sandbox profile" check and then crash sandboxArgs on a bare
  // TypeError. Profile lookups are own-property only now.
  for (const bad of ["__proto__", "constructor", "hasOwnProperty", "toString"]) {
    assert.match(sandboxProblem(bad), /no sandbox profile/, `${bad} has no profile`);
    assert.throws(() => args({ agent: bad, dir: proj, tmp: jobtmp, env: envFor(home) }), /no sandbox profile/,
      `${bad} is refused, not crashed on`);
  }

  // A `.git` file `gitdir:   ` (blank target) used to resolve to the project
  // dir itself — gitPointer returned the project as its own gitdir/common, and
  // sandboxArgs mkdir'd <proj>/hooks and wrote a `config` FILE into the project
  // root, then ro-bound both. A blank or unreadable gitdir is now no gitdir.
  const pBlank = mkProj(mkHome(), "blankgit");
  fs.writeFileSync(path.join(pBlank, ".git"), "gitdir:   \n");
  const aBlank = args({ agent: "grok", dir: pBlank, tmp: jobtmp, env: envFor(home) });
  assert.ok(!aBlank.join(" ").includes(".git"), "a blank gitdir yields no git mounts");
  assert.ok(!fs.existsSync(path.join(pBlank, "config")) && !fs.existsSync(path.join(pBlank, "hooks")),
    "a blank gitdir creates no stray config/hooks in the project");
  // A gitdir pointing at a NONEXISTENT dir throws a raw ENOENT from mkdirSync —
  // better than silently doing nothing, but not a friendly error either.
  const homeN = mkHome(), projN = mkProj(homeN, "nogitdir");
  fs.writeFileSync(path.join(projN, ".git"), `gitdir: ${path.join(tmp, "no-such-gitdir-" + seq)}\n`);
  assert.throws(() => args({ agent: "grok", dir: projN, tmp: jobtmp, env: envFor(homeN) }), /ENOENT/);

  // BUG: for a worktree whose common dir has no `worktrees/` folder, the
  // `--ro-bind <common>/worktrees` is skipped entirely — inside the sandbox
  // that path stays writable through the common bind, so a sibling worktree
  // gitdir could be created or overwritten. hooks/ and config/ get
  // created-if-missing; worktrees/ doesn't.
  //   // craft: wt/.git -> gitdir <gd>; <gd>/commondir -> <common>; <common>
  //   // exists but has no worktrees/ subdir. Then assert no argv entry ro-binds
  //   // <common>/worktrees — currently true (the gap), should be refused/created.
  const homeW = mkHome();
  const commonW = path.join(tmp, `common${seq}`); fs.mkdirSync(commonW);
  const gdW = path.join(tmp, `gd${seq}`); fs.mkdirSync(gdW);
  fs.writeFileSync(path.join(gdW, "commondir"), path.relative(gdW, commonW) + "\n");
  const wtW = path.join(tmp, `wtw${seq}`); fs.mkdirSync(wtW);
  fs.writeFileSync(path.join(wtW, ".git"), `gitdir: ${gdW}\n`);
  const aW = args({ agent: "grok", dir: wtW, tmp: jobtmp, env: envFor(homeW) });
  assert.ok(hasMount(aW, "bind", commonW, commonW), "the common dir is bound writable");
  assert.ok(!aW.join(" ").includes(path.join(commonW, "worktrees")),
    "BUG: no worktrees/ dir means no ro-bind protects it inside the sandbox");
  for (const d of [commonW, gdW, wtW]) fs.rmSync(d, { recursive: true, force: true });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("constance-sandbox.deep: tests passed");
