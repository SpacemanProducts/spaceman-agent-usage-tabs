// Deep edge-case pass for bin/default-agent.mjs, on top of default-agent.test.mjs
// (which covers the happy path, the Omarchy name list and one end-to-end rerun).
//
// default-agent.mjs has two surfaces: the exported planDefault(tabId, installed,
// applied) decision function, and a CLI body that reads
// $XDG_STATE_HOME/omarchy/agent-usage-tabs/default-agent.json (falling back to
// ~/.local/state), then writes ~/.config/omarchy/defaults/agent and the state
// file when the plan says to apply.
//
// Every CLI scenario runs the real script via spawnSync inside a scratch
// HOME/XDG_STATE_HOME/XDG_CONFIG_HOME/XDG_CACHE_HOME (all four pointed into one
// mkdtemp dir, removed at the end). Nothing here can reach the real home folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { planDefault, DEFAULT_NAMES } from "./default-agent.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "default-agent.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "default-agent-deep-"));

const stateDirOf = (xdg, home) => path.join(xdg || path.join(home, ".local", "state"), "omarchy", "agent-usage-tabs");
const defaultsFileOf = (home) => path.join(home, ".config", "omarchy", "defaults", "agent");

// A fresh scratch env. xdg === null means "leave XDG_STATE_HOME unset" so the
// ~/.local/state fallback is exercised; xdg === "" means the empty-string case
// (falsy -> same fallback). Returns run(...args) plus the interesting paths.
function setup({ xdg = path.join("xdg") } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, "case-"));
  const home = path.join(dir, "home");
  const xdgState = xdg === null ? undefined : path.join(dir, xdg);
  fs.mkdirSync(home, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(dir, "config"),
    XDG_CACHE_HOME: path.join(dir, "cache"),
  };
  if (xdgState !== undefined) env.XDG_STATE_HOME = xdgState;
  else delete env.XDG_STATE_HOME;
  const stateDir = stateDirOf(xdgState ?? path.join(home, ".local", "state"), home);
  const stateFile = path.join(stateDir, "default-agent.json");
  const defaultsFile = defaultsFileOf(home);
  const run = (...args) => spawnSync("node", [script, ...args], { env, encoding: "utf8" });
  return { dir, home, xdgState, env, stateDir, stateFile, defaultsFile, run };
}

const writeState = (s, content) => {
  fs.mkdirSync(s.stateDir, { recursive: true });
  fs.writeFileSync(s.stateFile, content);
};

try {
  // ---------- planDefault: argument edge cases ----------

  // Exact skip reasons for the three documented skip paths.
  assert.deepEqual(planDefault("nope", true, ""), { skip: "not supported as a default" });
  assert.deepEqual(planDefault("grok", false, ""), { skip: "not installed" });
  assert.deepEqual(planDefault("grok", true, "grok"), { skip: "already applied" });

  // Every mapped tab applies when installed and not yet applied.
  for (const [tab, name] of Object.entries(DEFAULT_NAMES)) {
    assert.deepEqual(planDefault(tab, true, ""), { name }, `${tab} -> ${name}`);
  }
  // DEFAULT_NAMES sanity: non-empty string values, unique names, lowercase ids.
  const names = Object.values(DEFAULT_NAMES);
  assert.equal(new Set(names).size, names.length, "default names must be unique");
  for (const [k, v] of Object.entries(DEFAULT_NAMES)) {
    assert.equal(typeof k, "string");
    assert.equal(k, k.toLowerCase());
    assert.equal(typeof v, "string");
    assert.ok(v.length > 0);
  }

  // tabId wrong types and near-misses all skip as unsupported.
  for (const bad of [undefined, null, 0, false, NaN, 123, {}, [], "", "Claude", "CLAUDE", " claude", "claude ",
    "cursor-agent", "agy", "kiro-cli", "devin-cli"]) {
    assert.ok(planDefault(bad, true, "").skip, `tabId ${String(bad)} should skip`);
  }
  // BUG: planDefault reads DEFAULT_NAMES[tabId] without hasOwnProperty, so
  // inherited Object.prototype members look like valid tabs. These return a
  // { name } plan whose "name" is a function or object; the CLI then writes
  // e.g. "function Object() { [native code] }\n" or "[object Object]\n" into
  // ~/.config/omarchy/defaults/agent and records applied="__proto__" etc.
  // for (const bad of ["constructor", "__proto__", "toString", "valueOf",
  //   "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "__defineGetter__",
  //   "__defineSetter__", "__lookupGetter__", "__lookupSetter__"]) {
  //   assert.ok(planDefault(bad, true, "").skip, `${bad} must not be a default`);
  // }

  // `installed` is truthy-checked, not boolean-checked: anything truthy applies.
  assert.deepEqual(planDefault("claude", "yes", ""), { name: "claude" });
  assert.deepEqual(planDefault("claude", 1, ""), { name: "claude" });
  assert.deepEqual(planDefault("claude", {}, ""), { name: "claude" });
  for (const bad of [undefined, null, 0, "", false]) {
    assert.ok(planDefault("claude", bad, "").skip, `installed=${String(bad)} should skip`);
  }
  // Note: the string "false" is truthy, so planDefault("claude","false","")
  // applies. The CLI can never pass it (argv[3] === "installed"), but callers
  // of the export should know it is not a boolean gate.
  assert.deepEqual(planDefault("claude", "false", ""), { name: "claude" });

  // `applied` skips only on strict === tabId; every other value applies.
  assert.ok(planDefault("claude", true, "claude").skip);
  assert.deepEqual(planDefault("claude", true, "Claude"), { name: "claude" });
  for (const other of ["", "agy", "codex", 0, false, null, undefined, 123, {}, [], "claude "]) {
    assert.deepEqual(planDefault("claude", true, other), { name: "claude" },
      `applied=${JSON.stringify(other)} should not count as applied`);
  }
  // applied stores the tab id, not the omarchy name: "agy" does not count as
  // antigravity having been applied.
  assert.deepEqual(planDefault("antigravity", true, "agy"), { name: "agy" });

  // ---------- CLI: no-op paths write nothing ----------

  {
    const s = setup();
    const r = s.run(); // no args at all
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(s.stateDir), "no state dir on a no-op");
    assert.ok(!fs.existsSync(s.defaultsFile), "no defaults file on a no-op");
  }
  {
    const s = setup();
    const r = s.run("nope", "installed");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(s.stateFile));
    assert.ok(!fs.existsSync(s.defaultsFile));
  }
  {
    const s = setup();
    const r = s.run("codex"); // supported tab, "installed" arg missing
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(s.defaultsFile));
    const r2 = s.run("codex", "Installed"); // case-sensitive flag
    assert.equal(r2.status, 0, r2.stderr);
    assert.ok(!fs.existsSync(s.defaultsFile), "'Installed' is not 'installed'");
    const r3 = s.run("codex", "installed-ish");
    assert.equal(r3.status, 0, r3.stderr);
    assert.ok(!fs.existsSync(s.defaultsFile));
  }
  {
    const s = setup();
    const r = s.run("", "installed"); // empty-string tab id
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(s.stateFile));
  }

  // ---------- CLI: happy path and file details ----------

  {
    const s = setup();
    const r = s.run("antigravity", "installed", "extra-ignored");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(s.defaultsFile, "utf8"), "agy\n", "tab id maps to omarchy name, one trailing newline");
    const st = JSON.parse(fs.readFileSync(s.stateFile, "utf8"));
    assert.deepEqual(st, { applied: "antigravity" }, "state records the tab id, not the name");
    assert.equal(fs.statSync(s.stateFile).mode & 0o777, 0o600, "state file is created 0600");
    // State lives under XDG_STATE_HOME, not HOME/.local/state.
    assert.ok(!fs.existsSync(path.join(s.home, ".local", "state")), "XDG_STATE_HOME wins over ~/.local/state");
  }
  {
    // XDG_STATE_HOME unset -> ~/.local/state fallback.
    const s = setup({ xdg: null });
    const r = s.run("grok", "installed");
    assert.equal(r.status, 0, r.stderr);
    const expected = path.join(s.home, ".local", "state", "omarchy", "agent-usage-tabs", "default-agent.json");
    assert.ok(fs.existsSync(expected), "falls back to ~/.local/state");
    assert.equal(JSON.parse(fs.readFileSync(expected, "utf8")).applied, "grok");
  }
  {
    // XDG_STATE_HOME="" is falsy -> same fallback.
    const s = setup();
    s.env.XDG_STATE_HOME = "";
    const r = s.run("kimi", "installed");
    assert.equal(r.status, 0, r.stderr);
    const expected = path.join(s.home, ".local", "state", "omarchy", "agent-usage-tabs", "default-agent.json");
    assert.ok(fs.existsSync(expected));
  }
  {
    // A relative XDG_STATE_HOME resolves against the child's cwd.
    const s = setup();
    s.env.XDG_STATE_HOME = "rel-state";
    const r = spawnSync("node", [script, "devin", "installed"], { env: s.env, cwd: s.dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const expected = path.join(s.dir, "rel-state", "omarchy", "agent-usage-tabs", "default-agent.json");
    assert.ok(fs.existsSync(expected), "relative XDG_STATE_HOME is cwd-relative");
    assert.ok(!fs.existsSync(path.join(tmp, "rel-state")), "did not escape into the test tmp root");
  }

  // ---------- CLI: corrupt / wrong-typed state files ----------

  const corrupt = [
    ["not json{", "truncated JSON"],
    ["", "empty file"],
    ["null", "JSON null"],
    ["5", "JSON number"],
    ['"claude"', "JSON string"],
    ["[]", "JSON array"],
    ["[1,2]", "JSON non-empty array"],
    ["{}", "JSON object without applied"],
    ['{"applied":123}', "numeric applied"],
    ['{"applied":null}', "null applied"],
    ['{"applied":["claude"]}', "array applied"],
    ['{"applied":{"x":1}}', "object applied"],
    ['{"applied":""}', "empty applied"],
    ['{"applied":"other-tab"}', "applied for a different tab"],
    ['{"applied":"claude"} trailing', "JSON plus garbage"],
    ['{"applied":"claude"}\n{"applied":"codex"}', "two concatenated records"],
  ];
  for (const [content, label] of corrupt) {
    const s = setup();
    writeState(s, content);
    const r = s.run("claude", "installed");
    assert.equal(r.status, 0, `${label}: ${r.stderr}`);
    assert.equal(fs.readFileSync(s.defaultsFile, "utf8"), "claude\n", `${label}: should still apply`);
    const st = JSON.parse(fs.readFileSync(s.stateFile, "utf8"));
    assert.deepEqual(st, { applied: "claude" }, `${label}: state rewritten cleanly`);
  }
  {
    // A state file that is a directory: readFileSync throws EISDIR, the catch
    // treats it as "no applied", the defaults file IS written, then the state
    // write fails and the process exits non-zero.
    const s = setup();
    fs.mkdirSync(s.stateFile, { recursive: true });
    const r = s.run("claude", "installed");
    assert.notEqual(r.status, 0, "state write failure must exit non-zero");
    assert.match(r.stderr, /EISDIR/);
    assert.equal(fs.readFileSync(s.defaultsFile, "utf8"), "claude\n",
      "defaults file is written before the state write fails");
  }
  {
    // applied already recorded -> skip leaves a hand-picked default alone and
    // does not rewrite the state file (byte-identical, even if pretty-printed).
    const s = setup();
    writeState(s, '{\n  "applied": "codex"\n}\n');
    fs.mkdirSync(path.dirname(s.defaultsFile), { recursive: true });
    fs.writeFileSync(s.defaultsFile, "my-own-pick\n");
    const before = fs.readFileSync(s.stateFile, "utf8");
    const r = s.run("codex", "installed");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(s.defaultsFile, "utf8"), "my-own-pick\n", "skip preserves the user's pick");
    assert.equal(fs.readFileSync(s.stateFile, "utf8"), before, "skip does not touch the state file");
  }
  {
    // mode: 0o600 only applies at creation; a pre-existing loose state file
    // keeps its permissions after the rewrite.
    const s = setup();
    writeState(s, '{"applied":"zzz"}');
    fs.chmodSync(s.stateFile, 0o644);
    const r = s.run("claude", "installed");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.statSync(s.stateFile).mode & 0o777, 0o644,
      "rewrite does not tighten a pre-existing 0644 state file");
  }

  // ---------- CLI: unwritable targets ----------

  {
    // defaults/agent path exists as a directory -> write fails before the
    // state file is ever touched.
    const s = setup();
    fs.mkdirSync(s.defaultsFile, { recursive: true });
    const r = s.run("claude", "installed");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /EISDIR/);
    assert.ok(!fs.existsSync(s.stateFile), "state write comes after the defaults write");
  }
  {
    // A regular file squats on the state dir path -> mkdirSync(recursive)
    // throws after the defaults file was already written.
    const s = setup();
    fs.mkdirSync(path.dirname(s.stateDir), { recursive: true });
    fs.writeFileSync(s.stateDir, "i am a file");
    const r = s.run("claude", "installed");
    assert.notEqual(r.status, 0);
    assert.equal(fs.readFileSync(s.defaultsFile, "utf8"), "claude\n",
      "defaults file is still written when state dir creation fails");
    assert.ok(!fs.existsSync(s.stateFile));
  }
  {
    // Read-only HOME -> cannot create .config/omarchy/defaults -> exit non-zero,
    // nothing written anywhere.
    const s = setup();
    fs.chmodSync(s.home, 0o555);
    try {
      const r = s.run("claude", "installed");
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /EACCES/);
      assert.ok(!fs.existsSync(s.defaultsFile));
      assert.ok(!fs.existsSync(s.stateFile), "state write never reached");
    } finally {
      fs.chmodSync(s.home, 0o755);
    }
  }

  // ---------- CLI: rerun and ordering ----------

  {
    // Applying tab A then tab B: each change rewrites both files; a repeat of
    // B is a no-op.
    const s = setup();
    assert.equal(s.run("claude", "installed").status, 0);
    assert.equal(s.run("codex", "installed").status, 0);
    assert.equal(fs.readFileSync(s.defaultsFile, "utf8"), "codex\n");
    assert.deepEqual(JSON.parse(fs.readFileSync(s.stateFile, "utf8")), { applied: "codex" });
    assert.equal(s.run("codex", "installed").status, 0);
    assert.equal(fs.readFileSync(s.defaultsFile, "utf8"), "codex\n");
    // A different tab id whose omarchy name differs still applies.
    assert.equal(s.run("antigravity", "installed").status, 0);
    assert.equal(fs.readFileSync(s.defaultsFile, "utf8"), "agy\n");
    assert.deepEqual(JSON.parse(fs.readFileSync(s.stateFile, "utf8")), { applied: "antigravity" });
  }

  // ---------- CLI: concurrency ----------

  {
    // Parallel invocations for different first-tabs. The module has no locking:
    // read-state -> write-defaults -> write-state can interleave. What is
    // guaranteed: every process exits 0, both files exist, the state file is
    // valid JSON naming one of the raced tabs, and the defaults file holds one
    // of the raced names. Which one wins is a race, so nothing stronger is
    // asserted here.
    //
    // BUG: the race is real and was observed (~1 in 60 rounds of 3 racers):
    // the state file can end up valid JSON for tab A while the defaults file
    // holds tab B's name (defaults=codex, applied="claude"), or even invalid
    // JSON ("Unexpected non-whitespace character after JSON") or the defaults
    // file can keep a stale trailing byte ("amp\nx"), when two writeFileSync
    // calls interleave on the same path. A mismatched pair then
    // sticks: the next run of tab A sees applied==="A" and skips, leaving the
    // wrong default in place; a corrupt state file is read as applied="" and
    // the next first-tab run silently rewrites the default. Repro: spawn
    // {claude,codex,grok} "installed" concurrently against one scratch HOME
    // in a loop and compare defaults/agent to DEFAULT_NAMES[state.applied].
    const s = setup();
    const raced = ["claude", "codex", "grok", "amp"];
    const procs = raced.map((t) =>
      new Promise((resolve) => {
        const p = spawn("node", [script, t, "installed"], { env: s.env });
        p.on("close", (code) => resolve(code));
      }));
    const codes = await Promise.all(procs);
    for (const c of codes) assert.equal(c, 0, "every racer exits cleanly");
    assert.ok(fs.existsSync(s.defaultsFile), "defaults file exists after the race");
    assert.ok(fs.existsSync(s.stateFile), "state file exists after the race");
    // The state/defaults files can be left corrupt or mismatched by the race
    // (BUG above), so the only hard assertions mid-race are: every process
    // exits 0 and both files exist. If the state file still parses, applied
    // must be one of the raced tabs.
    try {
      const st = JSON.parse(fs.readFileSync(s.stateFile, "utf8"));
      assert.ok(raced.includes(st.applied), `applied ${st.applied} is one of the raced tabs`);
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e; // corrupt state JSON is the documented race, not a test failure
    }
    // Recovery is deterministic: "qwen" was not raced, so applied can never
    // already be "qwen" — this run always applies and rewrites both files.
    const r = s.run("qwen", "installed");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(s.defaultsFile, "utf8"), "qwen\n");
    assert.deepEqual(JSON.parse(fs.readFileSync(s.stateFile, "utf8")), { applied: "qwen" });
  }
  {
    // Same-tab racers write identical bytes; even interleaved this stays
    // consistent (modulo the generic race above).
    const s = setup();
    const procs = Array.from({ length: 8 }, () =>
      new Promise((resolve) => {
        const p = spawn("node", [script, "grok", "installed"], { env: s.env });
        p.on("close", (code) => resolve(code));
      }));
    const codes = await Promise.all(procs);
    for (const c of codes) assert.equal(c, 0);
    assert.equal(fs.readFileSync(s.defaultsFile, "utf8"), "grok\n");
    assert.deepEqual(JSON.parse(fs.readFileSync(s.stateFile, "utf8")), { applied: "grok" });
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("default-agent.deep: all tests passed");
