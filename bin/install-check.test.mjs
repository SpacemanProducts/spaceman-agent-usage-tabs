// install-check.mjs is the new-user preflight: required checks must fail loudly
// (exit 1) when something's missing, optional pieces only inform. Runs the real
// script against a stub PATH and a scratch HOME.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "install-check.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "install-check-"));

function stub(binDir, names) {
  fs.mkdirSync(binDir, { recursive: true });
  for (const n of names) {
    const p = path.join(binDir, n);
    fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(p, 0o755);
  }
}
function run(env) {
  const r = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, ...env } });
  return { status: r.status, out: r.stdout + r.stderr };
}

// A bare machine: only the stubs we plant exist. node itself is already running.
const bare = path.join(tmp, "bare-bin");
stub(bare, []);
const home = path.join(tmp, "home");
fs.mkdirSync(path.join(home, ".config", "omarchy"), { recursive: true });
fs.mkdirSync(path.join(home, ".local", "state"), { recursive: true });

{
  const r = run({ HOME: home, PATH: bare, XDG_STATE_HOME: path.join(tmp, "xdg-state") });
  assert.equal(r.status, 1, "missing git/omarchy fails the check");
  assert.match(r.out, /MISS\] git/); assert.match(r.out, /MISS\] omarchy/);
  assert.match(r.out, /plugin folder .* not writable|plugin folder/, "plugin dir reported");
  assert.doesNotMatch(r.out, /Ready\./);
}

// Everything required present: passes and prints the install command.
{
  stub(bare, ["git", "omarchy", "notify-send", "paplay", "secret-tool", "gh", "python3", "tmux", "cs", "claude", "codex"]);
  const r = run({ HOME: home, PATH: bare, XDG_STATE_HOME: path.join(tmp, "xdg-state") });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /ok.*node /); assert.match(r.out, /ok.*git/); assert.match(r.out, /ok.*omarchy CLI/);
  assert.match(r.out, /agents found.*Claude Code, Codex/);
  assert.match(r.out, /omarchy plugin add https:\/\/github\.com\/SpacemanProducts\/spaceman-agent-usage-tabs\.git --enable/);
}

// Optional tools missing only downgrade to info lines, never a failure.
{
  const r = run({ HOME: home, PATH: bare, XDG_STATE_HOME: path.join(tmp, "xdg-state") }); // bare-bin now has everything; make a sparse dir instead
  const sparse = path.join(tmp, "sparse-bin");
  stub(sparse, ["git", "omarchy"]);
  const r2 = run({ HOME: home, PATH: sparse, XDG_STATE_HOME: path.join(tmp, "xdg-state") });
  assert.equal(r2.status, 0, r2.out);
  assert.match(r2.out, /info.*notify-send/); assert.match(r2.out, /info.*pw-play \/ paplay \/ ffplay/);
  assert.match(r2.out, /agents found.*none/);
  assert.equal(r.status, 0);
}

// A read-only plugin folder is a required failure.
{
  const ro = path.join(tmp, "ro-home");
  fs.mkdirSync(path.join(ro, ".config", "omarchy", "plugins"), { recursive: true });
  fs.chmodSync(path.join(ro, ".config", "omarchy", "plugins"), 0o555);
  const r = run({ HOME: ro, PATH: bare, XDG_STATE_HOME: path.join(tmp, "xdg-state") });
  assert.equal(r.status, 1);
  assert.match(r.out, /MISS\] .*plugin folder/);
  fs.chmodSync(path.join(ro, ".config", "omarchy", "plugins"), 0o755);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("install-check: all tests passed");
