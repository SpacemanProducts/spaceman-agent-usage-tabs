// Deep edge-case pass for bin/handoff-answer.mjs, on top of handoff.test.mjs
// (which covers answerPending() in-process: allow/dismiss, the plugins-dir
// skip, stale sessions). handoff-answer.mjs itself is only a CLI shell: it
// picks the pending-file path from $XDG_STATE_HOME (falling back to
// ~/.local/state) and maps argv[2] to "allow"/"dismiss". None of that is
// covered there, so every scenario here runs the real script via spawnSync
// inside a scratch HOME/XDG_STATE_HOME/XDG_CONFIG_HOME/XDG_CACHE_HOME — all
// pointed into mkdtemp dirs removed at the end. Nothing touches the real
// home folder.
//
// Suspected bugs are kept commented out under // BUG lines (not fixed); the
// report lists them.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MARKER } from "./handoff.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "handoff-answer.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-answer-deep-"));

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};

function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => spawnSync("git", ["-C", dir, ...a], { env: { ...process.env, ...GIT_ENV } });
  g("init", "-q");
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  g("add", "-A"); g("commit", "-q", "-m", "init");
  return dir;
}

const trigger = { agent: "Claude Code", percent: 0.97, title: "Session", resetsIn: "resets in 1h", level: "warn" };
const pendingJson = (repo, trig = trigger) => JSON.stringify({ repo, trigger: trig, at: Date.now() }) + "\n";

// A fresh scratch env per scenario. xdg === null leaves XDG_STATE_HOME unset
// (exercises the ~/.local/state fallback); xdg === "" sets it to the empty
// string (falsy -> same fallback). Returns run(...args) plus the paths the
// script will actually use.
function setup({ xdg = true } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, "case-"));
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(dir, "config"),
    XDG_CACHE_HOME: path.join(dir, "cache"),
  };
  let stateBase;
  if (xdg === null) { delete env.XDG_STATE_HOME; stateBase = path.join(home, ".local", "state"); }
  else if (xdg === "") { env.XDG_STATE_HOME = ""; stateBase = path.join(home, ".local", "state"); }
  else { env.XDG_STATE_HOME = path.join(dir, "xdg"); stateBase = env.XDG_STATE_HOME; }
  const stateDir = path.join(stateBase, "omarchy", "agent-usage-tabs");
  const pendingFile = path.join(stateDir, "handoff-pending.json");
  const run = (...args) => spawnSync("node", [script, ...args], { env, encoding: "utf8" });
  const runEnv = (extraEnv, ...args) => spawnSync("node", [script, ...args], { env: { ...env, ...extraEnv }, encoding: "utf8" });
  return { dir, home, env, stateDir, pendingFile, run, runEnv };
}

function writePending(s, content) {
  fs.mkdirSync(s.stateDir, { recursive: true });
  fs.writeFileSync(s.pendingFile, typeof content === "string" ? content : pendingJson(content));
}
// A well-formed pending note for `repo` (what maybeWriteHandoff would write).
const pendRepo = (s, repo, extra = {}) => writePending(s, JSON.stringify({ repo, trigger, at: Date.now(), ...extra }) + "\n");

const noteOf = (repo) => path.join(repo, "handoff", "HANDOFF.md");
const markerCount = (file) => (fs.readFileSync(file, "utf8").match(new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;

// Async variant for the concurrency scenarios (spawnSync cannot overlap).
function runAsync(env, args) {
  return new Promise((resolve) => {
    const p = spawn("node", [script, ...args], { env });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (status) => resolve({ status, stdout, stderr }));
    p.on("error", (e) => resolve({ status: -1, stdout, stderr: String(e) }));
  });
}

try {
  // ---------- allow: the happy path through the real CLI ----------
  {
    const s = setup();
    const repo = gitRepo(path.join(s.dir, "proj"));
    pendRepo(s, repo, { surprise: "unknown fields are ignored" });
    const r = s.run("allow");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    const note = noteOf(repo);
    assert.equal(r.stdout, note + "\n", "allow prints the written note path");
    assert.match(fs.readFileSync(note, "utf8"), /Claude Code\*\* is at 97% of its session limit/);
    assert.ok(!fs.existsSync(s.pendingFile), "the waiting note is consumed by the answer");
    assert.ok(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8").includes("handoff/"));
    assert.match(fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8"), /^handoff\/$/m);
    // A second allow finds nothing waiting: silent no-op, exit 0.
    const r2 = s.run("allow");
    assert.equal(r2.status, 0);
    assert.equal(r2.stdout, "");
    assert.equal(r2.stderr, "");
  }

  // ---------- dismiss: forgets the waiting note, writes nothing ----------
  {
    const s = setup();
    const repo = gitRepo(path.join(s.dir, "proj"));
    pendRepo(s, repo);
    const r = s.run("dismiss");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
    assert.ok(!fs.existsSync(s.pendingFile), "dismiss deletes the pending file");
    assert.ok(!fs.existsSync(path.join(repo, "handoff")), "dismiss writes no note");
    assert.ok(!fs.existsSync(path.join(repo, "AGENTS.md")), "dismiss touches no AGENTS.md");
  }

  // ---------- no pending file at all: both actions are silent no-ops ----------
  for (const action of ["allow", "dismiss"]) {
    const s = setup();
    const r = s.run(action);
    assert.equal(r.status, 0, `${action} with no pending file`);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
    assert.ok(!fs.existsSync(path.join(s.stateDir, "handoff-pending.json")));
  }

  // ---------- corrupt pending contents: ignored like a missing file ----------
  {
    const s = setup();
    const repo = gitRepo(path.join(s.dir, "proj"));
    const bad = [
      "", "   \n\t ", "not json {", "{", "[1,2",
      "null", "[]", "5", "\"str\"", "true",
      "{}", "{\"repo\":null}", "{\"repo\":\"\"}",
      JSON.stringify({ repo, at: 1 }) + "\n", // valid JSON, missing trigger
    ];
    for (const content of bad) {
      fs.mkdirSync(s.stateDir, { recursive: true });
      fs.writeFileSync(s.pendingFile, content);
      const r = s.run("allow");
      assert.equal(r.status, 0, `allow on ${JSON.stringify(content.slice(0, 40))}: ${r.stderr}`);
      assert.equal(r.stdout, "", `no output for corrupt pending: ${JSON.stringify(content.slice(0, 40))}`);
      assert.ok(!fs.existsSync(s.pendingFile), `corrupt pending is still consumed: ${JSON.stringify(content.slice(0, 40))}`);
      assert.ok(!fs.existsSync(path.join(repo, "handoff")), "nothing is written for corrupt pending");
    }
    // Same sweep for dismiss: corrupt content must not crash it either.
    for (const content of ["{", "null", "[]"]) {
      writePending(s, content);
      const r = s.run("dismiss");
      assert.equal(r.status, 0);
      assert.equal(r.stdout, "");
      assert.ok(!fs.existsSync(s.pendingFile));
    }
  }

  // ---------- the pending path is a directory: cannot be read or unlinked ----------
  {
    const s = setup();
    fs.mkdirSync(s.pendingFile, { recursive: true });
    const r = s.run("allow");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
    assert.ok(fs.statSync(s.pendingFile).isDirectory(), "unlink of a directory fails silently; it stays");
  }

  // ---------- env resolution: XDG_STATE_HOME wins, empty/unset falls back to HOME ----------
  for (const xdg of [null, ""]) {
    const s = setup({ xdg });
    const repo = gitRepo(path.join(s.dir, "proj"));
    pendRepo(s, repo);
    // The pending file must sit where the fallback puts it: ~/.local/state/...
    assert.equal(s.pendingFile, path.join(s.home, ".local", "state", "omarchy", "agent-usage-tabs", "handoff-pending.json"));
    const r = s.run("allow");
    assert.equal(r.status, 0, `xdg=${JSON.stringify(xdg)}: ${r.stderr}`);
    assert.equal(r.stdout, noteOf(repo) + "\n", `xdg=${JSON.stringify(xdg)} still finds the pending note`);
    assert.ok(fs.existsSync(noteOf(repo)));
  }

  // ---------- XDG_STATE_HOME pointing at a regular file: pending path unresolvable ----------
  {
    const s = setup({ xdg: null });
    const blocker = path.join(s.dir, "xdg-is-a-file");
    fs.writeFileSync(blocker, "x");
    const r = s.runEnv({ XDG_STATE_HOME: blocker }, "allow");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
  }

  // ---------- argv handling: extra args after "allow" are ignored ----------
  {
    const s = setup();
    const repo = gitRepo(path.join(s.dir, "proj"));
    pendRepo(s, repo);
    const r = s.run("allow", "now", "--force");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, noteOf(repo) + "\n", "argv[2] alone decides the action");
  }

  // ---------- pending file reached through a symlink ----------
  {
    const s = setup();
    const repo = gitRepo(path.join(s.dir, "proj"));
    const target = path.join(s.dir, "real-pending.json");
    fs.writeFileSync(target, pendingJson(repo));
    fs.mkdirSync(s.stateDir, { recursive: true });
    fs.symlinkSync(target, s.pendingFile);
    const r = s.run("dismiss");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(s.pendingFile), "the symlink itself is removed");
    assert.ok(fs.existsSync(target), "the symlink target is never touched");
    assert.ok(!fs.existsSync(path.join(repo, "handoff")));
  }

  // ---------- concurrency: several allows racing on one pending file ----------
  {
    const s = setup();
    const repo = gitRepo(path.join(s.dir, "proj"));
    pendRepo(s, repo);
    const results = await Promise.all(Array.from({ length: 6 }, () => runAsync(s.env, ["allow"])));
    for (const r of results) {
      assert.equal(r.status, 0, `concurrent allow crashed: ${r.stderr}`);
    }
    const note = noteOf(repo);
    assert.ok(fs.existsSync(note), "at least one racer wrote the note");
    const printed = results.map((r) => r.stdout.trim()).filter(Boolean);
    assert.ok(printed.length >= 1, "at least one process saw the pending file before it was consumed");
    for (const p of printed) assert.equal(p, note, "every writer reports the same note path");
    assert.deepEqual(fs.readdirSync(path.join(repo, "handoff")).sort(), ["HANDOFF.md"], "one note file, no debris");
    assert.equal(markerCount(path.join(repo, "AGENTS.md")), 1, "the AGENTS.md marker is never duplicated by racers");
    assert.ok(!fs.existsSync(s.pendingFile), "the pending file is gone once the dust settles");
  }

  // ---------- concurrency: allows and dismisses racing ----------
  {
    const s = setup();
    const repo = gitRepo(path.join(s.dir, "proj"));
    pendRepo(s, repo);
    const results = await Promise.all([
      ...Array.from({ length: 3 }, () => runAsync(s.env, ["allow"])),
      ...Array.from({ length: 3 }, () => runAsync(s.env, ["dismiss"])),
    ]);
    for (const r of results) {
      assert.equal(r.status, 0, `mixed race crashed: ${r.stderr}`);
      assert.equal(r.stderr, "");
    }
    assert.ok(!fs.existsSync(s.pendingFile), "whoever wins, the pending file is consumed exactly once");
    const note = noteOf(repo);
    if (fs.existsSync(note)) assert.match(fs.readFileSync(note, "utf8"), /# Handoff/, "a note written mid-race is still a real note");
    if (fs.existsSync(path.join(repo, "AGENTS.md"))) assert.equal(markerCount(path.join(repo, "AGENTS.md")), 1);
  }

  // ---------- a pending note pointing inside ~/.config/omarchy/plugins ----------
  {
    const s = setup();
    // The plugin check reads the CHILD's HOME, so this case needs its own home.
    const plugHome = path.join(s.dir, "plug-home");
    const plugRepo = gitRepo(path.join(plugHome, ".config", "omarchy", "plugins", "spaceman.some-plugin"));
    pendRepo(s, plugRepo);
    const r = s.runEnv({ HOME: plugHome }, "allow");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "", "a repo inside the plugins dir gets nothing, even via the CLI");
    assert.ok(!fs.existsSync(s.pendingFile), "the pending file is still consumed");
    assert.ok(!fs.existsSync(path.join(plugRepo, "handoff")), "no handoff folder inside a plugin");
    assert.ok(!fs.existsSync(path.join(plugRepo, "AGENTS.md")), "no AGENTS.md inside a plugin");
  }

  // ---------- sequential stale state: pending consumed, later answers are no-ops ----------
  {
    const s = setup();
    const repo = gitRepo(path.join(s.dir, "proj"));
    pendRepo(s, repo);
    assert.equal(s.run("dismiss").stdout, "");
    const again = s.run("allow");
    assert.equal(again.status, 0);
    assert.equal(again.stdout, "", "a dismissed note is not resurrected by a later allow");
    assert.ok(!fs.existsSync(noteOf(repo)));
  }

  // ---------- suspected bugs (commented out, NOT fixed) ----------
  //
  // BUG 1: a pending file whose JSON parses but has the wrong types crashes
  // the CLI with an uncaught exception instead of being ignored like every
  // other corrupt payload. The pending file is still deleted first, so the
  // user's answer is lost AND they get a stack trace. Verified 2026-11-25:
  //   {"repo":42,...}            -> TypeError in path.resolve (insidePluginsDir)
  //   {"repo":<regular file>}    -> ENOTDIR in mkdirSync(repo/handoff)
  //   {"repo":<dir>,"trigger":{}}-> TypeError: trigger.title.toLowerCase (buildNote)
  //   {"repo":<dir>,"trigger":"x"}-> same
  // Each of these should exit 0 with no output and write nothing:
  /*
  {
    const s = setup();
    const repo = gitRepo(path.join(s.dir, "proj"));
    const plainFile = path.join(s.dir, "a-file"); fs.writeFileSync(plainFile, "x");
    const badPayloads = [
      { repo: 42, trigger },
      { repo: {}, trigger },
      { repo: [repo], trigger },
      { repo: plainFile, trigger },
      { repo, trigger: {} },
      { repo, trigger: "x" },
      { repo, trigger: { agent: "A", percent: 0.5, level: "warn" } }, // no title
    ];
    for (const p of badPayloads) {
      writePending(s, JSON.stringify(p) + "\n");
      const r = s.run("allow");
      assert.equal(r.status, 0, `corrupt-but-parseable pending crashed: ${r.stderr}`);
      assert.equal(r.stdout, "");
      assert.ok(!fs.existsSync(s.pendingFile));
    }
    assert.ok(!fs.existsSync(path.join(repo, "handoff")), "no note for malformed triggers");
  }
  */
  //
  // BUG 2: `allow` trusts pending.repo blindly. If the repo was deleted between
  // the question and the answer, writeHandoff mkdirSync's the whole missing
  // path and drops AGENTS.md + handoff/HANDOFF.md into it — resurrecting a
  // directory the user removed. It should write nothing when repo is not an
  // existing directory.
  /*
  {
    const s = setup();
    const gone = path.join(s.dir, "deleted-repo"); // never created
    pendRepo(s, gone);
    const r = s.run("allow");
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "", "BUG: a missing repo must not get a note");
    assert.ok(!fs.existsSync(gone), "BUG: the deleted repo path must not be recreated");
  }
  */
  //
  // BUG 3: same trust issue one step softer — a pending note whose repo is an
  // existing directory that is NOT a git repo still gets handoff/HANDOFF.md
  // ("No commits yet.") and an AGENTS.md marker line. maybeWriteHandoff only
  // ever pends real repos, so this needs a stale or hand-edited pending file,
  // but the note it writes is misleading.
  /*
  {
    const s = setup();
    const plain = path.join(s.dir, "plain-dir"); fs.mkdirSync(plain);
    pendRepo(s, plain);
    const r = s.run("allow");
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "", "BUG: a non-repo directory should not get a handoff note");
    assert.ok(!fs.existsSync(path.join(plain, "handoff")));
    assert.ok(!fs.existsSync(path.join(plain, "AGENTS.md")));
  }
  */
  //
  // BUG 4: the CLI maps ANY argv[2] other than exactly "allow" to "dismiss",
  // so a typo (`Allow`, `dsimiss`), `--help`, or a bare invocation silently
  // forgets the waiting note. Dismiss loses the pending question until the
  // next warning fires; an unrecognized action should be rejected without
  // touching the pending file.
  /*
  {
    const s = setup();
    const repo = gitRepo(path.join(s.dir, "proj"));
    pendRepo(s, repo);
    for (const args of [["Allow"], ["bogus"], ["--help"], []]) {
      const r = s.run(...args);
      assert.equal(r.status, 0);
      assert.ok(fs.existsSync(s.pendingFile), `BUG: unrecognized action ${JSON.stringify(args)} must not delete the pending note`);
    }
  }
  */

  console.log("handoff-answer deep: all tests passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
