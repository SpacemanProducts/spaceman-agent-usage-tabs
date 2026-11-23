import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "folder-picker.py");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "folder-picker-test-"));
const home = path.join(tmp, "home");
const state = path.join(tmp, "state");
const plugin = path.join(home, ".config", "omarchy", "plugins", "spaceman.agent-usage-tabs");
const stateDir = path.join(state, "omarchy", "agent-usage-tabs");
fs.mkdirSync(stateDir, { recursive: true });

const now = 1795474800000;
const at = (offset) => now - offset;
const dirs = [
  path.join(home, "Projects", "app", "src"),
  path.join(home, "Rough Rider Eats", "rough_rider_eats"),
  path.join(home, "Work", "sub"),
  path.join(home, "Picked", "plain", "sub"),
  path.join(home, "Squad", "repo"),
  path.join(home, "Documents", "notes", "src"),
  path.join(home, ".gemini", "tool", "log"),
  path.join(home, ".local", "state", "omarchy", "agents", "usage"),
  path.join(home, ".config", "omarchy", "plugins", "other-plugin"),
  path.join(home, ".config", "omarchy", "plugins", "spaceman.agent-usage-tabs", "bin"),
  path.join(home, "agents-backup", "foo"),
  path.join(home, ".claude-squad", "worktrees", "x"),
];
for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
for (const marker of [
  ["Projects", "app", ".git"],
  ["Projects", "app", "src", "package.json"],
  ["Rough Rider Eats", ".git"],
  ["Rough Rider Eats", "rough_rider_eats", "package.json"],
  ["Squad", "repo", ".git"],
  ["Documents", "notes", ".git"],
  [".config", "omarchy", "plugins", "other-plugin", "package.json"],
  [".config", "omarchy", "plugins", "spaceman.agent-usage-tabs", ".git"],
  [".claude-squad", "worktrees", "x", "package.json"],
]) {
  const file = path.join(home, ...marker);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, marker.at(-1) === ".git" ? "gitdir: x\n" : "{}\n");
}
fs.writeFileSync(path.join(home, ".git"), "gitdir: home\n");

const usageRecords = [
  ["claude", path.join(home, "Projects", "app"), at(2000)],
  ["claude", path.join(home, "Projects", "app", "src"), at(1000)],
  ["grok", path.join(home, "Rough Rider Eats", "rough_rider_eats"), at(3000)],
  ["claude", path.join(home, "Work", "sub"), at(4000)],
  ["claude", path.join(home, "Picked", "plain", "sub"), at(4500)],
  ["claude", path.join(home, ".gemini", "tool", "log"), at(5000)],
  ["claude", path.join(home, ".local", "state", "omarchy", "agents", "usage"), at(5500)],
  ["claude", path.join(home, ".config", "omarchy"), at(6000)],
  ["claude", path.join(home, ".config", "omarchy", "plugins", "other-plugin"), at(6500)],
  ["claude", path.join(plugin, "bin"), at(7000)],
  ["claude", path.join(home, "agents-backup", "foo"), at(7500)],
  ["claude", path.join(home, ".claude-squad", "worktrees", "x"), at(8000)],
  ["claude", path.join(home, "Documents", "notes", "src"), at(9000)],
  ["claude", path.join(home, "Squad", "repo"), at(9500)],
  ["claude", home, at(9900)],
];
fs.writeFileSync(path.join(stateDir, "folder-usage.json"), JSON.stringify({
  version: 1,
  refreshedAt: now,
  records: usageRecords.map(([agent, folder, time]) => ({ agent, folder, session: "s", amount: 1, unit: "tokens", time })),
}));
fs.writeFileSync(path.join(stateDir, "folder-preferences.json"), JSON.stringify({
  version: 1,
  pinned: [path.join(home, "Projects", "app", "src")],
  hidden: {
    [path.join(home, ".gemini")]: at(10000),
    [path.join(home, "Documents", "notes", "src")]: at(8500),
    [path.join(home, "Work")]: at(10000),
  },
}));
fs.writeFileSync(path.join(stateDir, "start-picks"), path.join(home, "Picked", "plain") + "\n");
fs.writeFileSync(path.join(stateDir, "squad-recent"), path.join(home, "Squad", "repo") + "\n");

const env = { ...process.env, HOME: home, XDG_STATE_HOME: state, FOLDER_PICKER_NOW_MS: String(now) };
const result = spawnSync("python3", [script, "scan", "--keep", plugin, "--keep", home,
  path.join(home, "Projects", "app", "src")], { encoding: "utf8", env });
assert.equal(result.status, 0, result.stderr);
const data = JSON.parse(result.stdout);
const by = Object.fromEntries(data.folders.map((folder) => [folder.folder, folder]));
const app = path.join(home, "Projects", "app");
const rough = path.join(home, "Rough Rider Eats");
const work = path.join(home, "Work");
const picked = path.join(home, "Picked", "plain");
const notes = path.join(home, "Documents", "notes");
const gemini = path.join(home, ".gemini");
const localState = path.join(home, ".local", "state");
const omarchy = path.join(home, ".config", "omarchy");
const squadWorktrees = path.join(home, ".claude-squad");
const backup = path.join(home, "agents-backup");
const squadRepo = path.join(home, "Squad", "repo");

assert.deepEqual(by[app].sources.sort(), [app, path.join(app, "src")].sort(), "subfolders roll up to the git project");
assert.equal(by[app].project, true);
assert.equal(by[app].pinned, true, "a pin inside the project pins the rolled-up entry");
assert.equal(by[app].activity, at(1000), "activity is the latest session under the project");
assert.deepEqual(by[rough].sources, [path.join(rough, "rough_rider_eats")], "only folders with sessions or picks are sources");
assert.equal(by[rough].project, true);
assert.equal(by[work].project, false);
assert.equal(by[work].system, false);
assert.equal(by[work].hiddenAt, at(10000));
assert.equal(by[picked].picked, true, "a folder started from the picker stays visible without project files");
assert.deepEqual(by[picked].sources.sort(), [picked, path.join(picked, "sub")].sort());
assert.equal(by[picked].project, false);
assert.equal(by[squadRepo].picked, true, "squad-recent counts as picker-started");
assert.equal(by[notes].project, true);
assert.equal(by[notes].hiddenAt, at(8500), "a hide inside a project hides the rolled-up entry");
assert.equal(by[gemini].system, true);
assert.ok(by[gemini].sources.includes(path.join(gemini, "tool", "log")));
assert.equal(by[localState].system, true);
assert.ok(by[omarchy].sources.includes(path.join(omarchy, "plugins", "other-plugin")), "project files under a system root still group into the system folder");
assert.equal(by[omarchy].project, false);
assert.ok(!by[omarchy].sources.includes(path.join(plugin, "bin")), "the kept plugin folder is not swallowed by omarchy");
assert.equal(by[plugin].keep, true);
assert.ok(by[plugin].sources.includes(path.join(plugin, "bin")));
assert.equal(by[squadWorktrees].system, true, "claude-squad worktrees stay hidden even with package.json");
assert.equal(by[squadWorktrees].project, false);
assert.equal(by[backup].system, true);
assert.equal(by[home].keep, true);
assert.equal(by[home].project, true);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("folder-picker: all tests passed");
