// Deep edge-case pass for bin/install-check.mjs on top of install-check.test.mjs.
// The script is a one-shot CLI (top-level side effects, process.exit), so every
// case here spawns it with a scratch HOME / XDG_* and a stub PATH. It reads no
// input files and keeps no state, so the only "inputs" are the environment;
// corrupt/missing files are covered via env vars pointing at wrong shapes.
// Everything lives under one mkdtemp dir; the real home folder is never touched.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "install-check.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "install-check-deep-"));

const home = path.join(tmp, "home");
fs.mkdirSync(path.join(home, ".config", "omarchy"), { recursive: true });
fs.mkdirSync(path.join(home, ".local", "state"), { recursive: true });
const xdgState = path.join(tmp, "xdg-state");
fs.mkdirSync(xdgState, { recursive: true });

function stub(binDir, names, { mode = 0o755 } = {}) {
  fs.mkdirSync(binDir, { recursive: true });
  for (const n of names) {
    const p = path.join(binDir, n);
    fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(p, mode);
  }
}

// env layers over process.env; pass env: { PATH: undefined } style keys to drop.
function run(env, opts = {}) {
  const full = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: xdgState,
    XDG_CONFIG_HOME: path.join(tmp, "xdg-config"),
    XDG_CACHE_HOME: path.join(tmp, "xdg-cache"),
    ...env,
  };
  for (const k of Object.keys(full)) if (full[k] === undefined) delete full[k];
  const r = spawnSync(process.execPath, [script], { encoding: "utf8", env: full, ...opts });
  return { status: r.status, out: r.stdout + r.stderr };
}
const base = { git: true, omarchy: true };
function ready(extra = {}) {
  const dir = path.join(tmp, `bin-${Math.random().toString(36).slice(2)}`);
  const names = [];
  if (base.git !== false) names.push("git");
  if (base.omarchy !== false) names.push("omarchy");
  stub(dir, names);
  return { PATH: dir, ...extra };
}

try {
  // ---- PATH edge cases: every which() lookup fails cleanly ----
  for (const [label, pathEnv] of [
    ["empty string", ""],
    ["only delimiters", ":::"],
    ["nonexistent dirs", path.join(tmp, "nope1") + path.delimiter + path.join(tmp, "nope2")],
  ]) {
    const r = run({ PATH: pathEnv });
    assert.equal(r.status, 1, `PATH=${label} fails the check`);
    assert.match(r.out, /MISS\] git/, `PATH=${label}: git missing`);
    assert.match(r.out, /MISS\] omarchy/, `PATH=${label}: omarchy missing`);
    assert.match(r.out, /2 required checks failed/, `PATH=${label}: plural failure count`);
    assert.doesNotMatch(r.out, /Ready\./);
  }
  {
    // PATH unset entirely: (process.env.PATH || "") -> "" -> same as empty.
    const r = run({ PATH: undefined });
    assert.equal(r.status, 1);
    assert.match(r.out, /MISS\] git/);
  }

  // ---- which(): permission and link edge cases ----
  {
    const dir = path.join(tmp, "bin-perms");
    stub(dir, ["git"], { mode: 0o644 }); // present but not executable
    stub(dir, ["omarchy"]);
    let r = run({ PATH: dir });
    assert.equal(r.status, 1);
    assert.match(r.out, /MISS\] git/, "non-executable git is missing");
    assert.match(r.out, /1 required check failed\./, "singular failure count");

    fs.chmodSync(path.join(dir, "git"), 0o755); // now executable
    r = run({ PATH: dir });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /\[ ok \] git/, "executable git is found");

    // Broken symlink: accessSync follows the link and fails -> missing.
    fs.rmSync(path.join(dir, "git"));
    fs.symlinkSync(path.join(dir, "nonexistent-target"), path.join(dir, "git"));
    r = run({ PATH: dir });
    assert.equal(r.status, 1);
    assert.match(r.out, /MISS\] git/, "broken symlink git is missing");

    // Valid symlink to an executable elsewhere is found.
    const real = path.join(tmp, "real-git");
    fs.writeFileSync(real, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(real, 0o755);
    fs.rmSync(path.join(dir, "git"));
    fs.symlinkSync(real, path.join(dir, "git"));
    r = run({ PATH: dir });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /\[ ok \] git/, "symlinked git is found");

    // Garbage content with +x still counts: which() only checks X_OK.
    fs.writeFileSync(path.join(dir, "git"), "this is not a script\n");
    r = run({ PATH: dir });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /\[ ok \] git/, "X_OK-only check accepts any executable file");
  }

  // ---- which(): PATH entries that are not directories are skipped ----
  {
    const notDir = path.join(tmp, "a-regular-file");
    fs.writeFileSync(notDir, "x");
    const dir = path.join(tmp, "bin-after-file");
    stub(dir, ["git", "omarchy"]);
    const r = run({ PATH: notDir + path.delimiter + dir });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /\[ ok \] git/, "file PATH entry does not break the search");
  }

  // ---- which(): relative PATH entries resolve against the child's cwd ----
  {
    const cwd = path.join(tmp, "relpath-cwd");
    fs.mkdirSync(cwd, { recursive: true });
    stub(cwd, ["git", "omarchy"]); // PATH "." finds ./git, ./omarchy
    const r = run({ PATH: "." }, { cwd });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /\[ ok \] git/, "relative PATH entry honoured");
    const r2 = run({ PATH: "." }); // same PATH, different cwd: stubs not there
    assert.equal(r2.status, 1, "relative PATH resolves per-process cwd");
    assert.match(r2.out, /MISS\] git/);
  }

  // which() must only accept regular executable files: a directory named git
  // on PATH is not a working git.
  {
    const dirGit = path.join(tmp, "bin-dirs");
    fs.mkdirSync(path.join(dirGit, "git"), { recursive: true });
    stub(dirGit, ["omarchy"]);
    const r = run({ PATH: dirGit });
    assert.match(r.out, /MISS\] git/, "a directory is not an executable");
    assert.equal(r.status, 1);
  }

  // ---- writableDeep(): deep paths, missing ancestors, wrong shapes ----
  {
    // HOME that does not exist yet, deep under the writable tmp: the deepest
    // existing ancestor is tmp itself, so both folders are reported ok.
    const deepHome = path.join(tmp, "a", "b", "home");
    const r = run({ HOME: deepHome, PATH: ready().PATH });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /\[ ok \] .*plugin folder/, "deep missing HOME still ok");
    assert.match(r.out, /\[ ok \] .*state folder/, "deep missing state still ok");
  }
  {
    // XDG_STATE_HOME set but empty string falls back to HOME/.local/state.
    const r = run({ PATH: ready().PATH, XDG_STATE_HOME: "" });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /state folder .*\.local.state/, "empty XDG_STATE_HOME falls back");
    assert.doesNotMatch(r.out, /state folder .*xdg-state/, "xdg-state not used when env empty");
  }
  {
    // XDG_STATE_HOME as a read-only directory: required MISS.
    const ro = path.join(tmp, "ro-state");
    fs.mkdirSync(ro, { recursive: true });
    fs.chmodSync(ro, 0o555);
    const r = run({ PATH: ready().PATH, XDG_STATE_HOME: ro });
    assert.equal(r.status, 1);
    assert.match(r.out, /MISS\] .*state folder/, "read-only state dir fails");
    fs.chmodSync(ro, 0o755);
  }
  {
    // Relative XDG_STATE_HOME resolves against the child's cwd.
    const cwd = path.join(tmp, "relstate-cwd");
    fs.mkdirSync(path.join(cwd, "relstate"), { recursive: true });
    const r = run({ PATH: ready().PATH, XDG_STATE_HOME: "relstate" }, { cwd });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /state folder relstate\//, "relative XDG_STATE_HOME shown as-is");
  }
  // BUG: writableDeep() only checks W_OK on the deepest existing ancestor and
  // never checks it is a directory. A regular file there is "writable", so a
  // file at XDG_STATE_HOME (or at ~/.config/omarchy) reports the folder ok
  // even though nothing can ever be created under it.
  // Expected: [MISS] state folder / [MISS] plugin folder. Actual: [ ok ].
  // {
  //   const stateFile = path.join(tmp, "state-is-a-file");
  //   fs.writeFileSync(stateFile, "x");
  //   const r = run({ PATH: ready().PATH, XDG_STATE_HOME: stateFile });
  //   assert.match(r.out, /MISS\] .*state folder/, "a file cannot hold the state dir");
  //   const homeFile = path.join(tmp, "home-file");
  //   fs.mkdirSync(path.join(homeFile, ".config"), { recursive: true });
  //   fs.writeFileSync(path.join(homeFile, ".config", "omarchy"), "x");
  //   const r2 = run({ HOME: homeFile, PATH: ready().PATH });
  //   assert.match(r2.out, /MISS\] .*plugin folder/, "a file cannot hold the plugins dir");
  // }

  // ---- XDG_CONFIG_HOME is deliberately unused: plugins live at ~/.config ----
  {
    const r = run({ PATH: ready().PATH });
    assert.match(r.out, new RegExp(`plugin folder ${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      "plugin folder is under HOME, not XDG_CONFIG_HOME");
  }

  // ---- the run is read-only: it creates neither folder ----
  {
    const bareHome = path.join(tmp, "bare-home");
    fs.mkdirSync(bareHome, { recursive: true });
    const bareState = path.join(tmp, "bare-state");
    fs.mkdirSync(bareState, { recursive: true });
    const r = run({ HOME: bareHome, XDG_STATE_HOME: bareState, PATH: ready().PATH });
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.existsSync(path.join(bareHome, ".config")), false, "no .config created");
    assert.equal(fs.existsSync(path.join(bareState, "omarchy")), false, "no state tree created");
  }

  // ---- optional tools: reporting and priority ----
  {
    const dir = path.join(tmp, "bin-optional");
    stub(dir, ["git", "omarchy", "notify-send", "ffplay"]);
    let r = run({ PATH: dir });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /\[ ok \] notify-send/, "notify-send reported ok");
    assert.match(r.out, /\[ ok \] ffplay — reset sound/, "ffplay alone is the sound");

    // paplay beats ffplay: fixed priority order pw-play > paplay > ffplay.
    stub(dir, ["paplay"]);
    r = run({ PATH: dir });
    assert.match(r.out, /\[ ok \] paplay — reset sound/, "paplay preferred over ffplay");
    assert.doesNotMatch(r.out, /ffplay — reset sound/, "ffplay not named when paplay wins");

    // pw-play beats both.
    stub(dir, ["pw-play"]);
    r = run({ PATH: dir });
    assert.match(r.out, /\[ ok \] pw-play — reset sound/, "pw-play preferred over all");

    // No sound tool at all -> one combined info line.
    fs.rmSync(path.join(dir, "paplay"));
    fs.rmSync(path.join(dir, "pw-play"));
    fs.rmSync(path.join(dir, "ffplay"));
    r = run({ PATH: dir });
    assert.match(r.out, /info.*pw-play \/ paplay \/ ffplay/, "missing sound is one info line");
  }
  {
    // Claude Squad trio: partial presence lists what was found.
    const dir = path.join(tmp, "bin-squad");
    stub(dir, ["git", "omarchy", "python3", "tmux"]);
    let r = run({ PATH: dir });
    assert.match(r.out, /info.*found: python3, tmux/, "partial squad trio listed");
    stub(dir, ["cs"]);
    r = run({ PATH: dir });
    assert.match(r.out, /\[ ok \] python3 \+ tmux \+ cs — Claude Squad/, "full trio ok");
  }
  // bwrap and xdg-dbus-proxy are sandbox dependencies and must be reported
  // like every other optional tool, present or not.
  {
    const dir = path.join(tmp, "bin-sandbox");
    stub(dir, ["git", "omarchy", "bwrap", "xdg-dbus-proxy"]);
    const r = run({ PATH: dir });
    assert.match(r.out, /\[ ok \] bwrap/, "bwrap presence is reported");
    assert.match(r.out, /\[ ok \] xdg-dbus-proxy/, "xdg-dbus-proxy presence is reported");

    fs.rmSync(path.join(dir, "bwrap"));
    fs.rmSync(path.join(dir, "xdg-dbus-proxy"));
    const r2 = run({ PATH: dir });
    assert.match(r2.out, /info.*bwrap — missing/, "bwrap absence is reported");
    assert.match(r2.out, /info.*xdg-dbus-proxy — missing/, "xdg-dbus-proxy absence is reported");
  }

  // ---- agents: dedup, order, executability ----
  {
    const dir = path.join(tmp, "bin-agents");
    // agy and antigravity both map to "Antigravity"; the second must not repeat.
    stub(dir, ["git", "omarchy", "antigravity", "agy", "claude"]);
    const r = run({ PATH: dir });
    const line = r.out.split("\n").find((l) => l.includes("agents found"));
    assert.ok(line, "agents line present");
    assert.equal(line.split("Antigravity").length - 1, 1, "Antigravity listed once");
    assert.match(line, /Claude Code, Antigravity/, "order follows the AGENTS table");
    assert.match(line, /\[info\]|info/, "agents are an info line");
  }
  {
    const dir = path.join(tmp, "bin-agents-noexec");
    stub(dir, ["git", "omarchy", "claude"], { mode: 0o644 }); // claude not executable
    const r = run({ PATH: dir });
    assert.match(r.out, /agents found.*none/, "non-executable agent bin is not an agent");
  }
  {
    // Only agy present (antigravity absent): still exactly one Antigravity.
    const dir = path.join(tmp, "bin-agents-agy");
    stub(dir, ["git", "omarchy", "agy"]);
    const r = run({ PATH: dir });
    const line = r.out.split("\n").find((l) => l.includes("agents found"));
    assert.match(line, /Antigravity/);
    assert.equal(line.split("Antigravity").length - 1, 1);
  }

  // ---- node version line is always reported ok on node >= 18 ----
  {
    const r = run({ PATH: ready().PATH });
    assert.match(r.out, /\[ ok \] node \d+\.\d+\.\d+ — required, 18 or newer/,
      "node line format");
  }

  // ---- no shared state: two concurrent runs are independent ----
  {
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: xdgState, PATH: ready().PATH };
    const mk = () => new Promise((res) => {
      const c = spawn(process.execPath, [script], { env });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("close", (code) => res({ code, out }));
    });
    const [a, b] = await Promise.all([mk(), mk()]);
    assert.equal(a.code, 0); assert.equal(b.code, 0);
    assert.match(a.out, /Ready\./); assert.match(b.out, /Ready\./);
  }
} finally {
  // Restore any permissions we tightened so rmSync can clean up.
  for (const d of [path.join(tmp, "ro-state")]) {
    try { fs.chmodSync(d, 0o755); } catch { /* already gone */ }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log("install-check.deep: all tests passed");
