import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "folder-preferences.py");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "folder-preferences-"));
const home = path.join(tmp, "home");
const state = path.join(tmp, "state");
const bulk = path.join(home, "Projects", "Bulk Radar");
const plugin = path.join(home, ".config", "omarchy", "plugins", "spaceman.agent-usage-tabs");
const project = path.join(home, "Projects", "sample");
const idle = path.join(home, "Projects", "idle");
for (const folder of [bulk, plugin, project, idle]) fs.mkdirSync(folder, { recursive: true });

const env = { ...process.env, HOME: home, XDG_STATE_HOME: state };
const run = (...args) => spawnSync("python3", [script, ...args], { encoding: "utf8", env });
const prefs = (result) => {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

let result = prefs(run("list"));
assert.deepEqual(result.pinned, [bulk, plugin], "Bulk Radar and the plugin folder are pinned initially");
assert.deepEqual(result.hidden, {});

result = prefs(run("hide", project, "1234"));
assert.equal(result.hidden[project], 1234);
assert.ok(fs.statSync(project).isDirectory(), "hiding never removes a folder");

result = prefs(run("pin", project));
assert.ok(result.pinned.includes(project), "pinning persists");
result = prefs(run("restore", project));
assert.equal(Object.hasOwn(result.hidden, project), false, "restoring clears the manual hide");
assert.ok(result.pinned.includes(project), "restoring preserves the pin");

result = prefs(run("unpin", bulk));
assert.ok(!result.pinned.includes(bulk), "unpinning persists");
assert.ok(fs.statSync(bulk).isDirectory(), "preference changes never delete folders");

result = prefs(run("hide", idle, "0"));
assert.equal(result.hidden[idle], 0);
result = prefs(run("restore", idle, "--pin"));
assert.equal(Object.hasOwn(result.hidden, idle), false);
assert.ok(result.pinned.includes(idle), "restoring an inactive folder pins it so it is visible");
assert.equal(fs.statSync(path.join(state, "omarchy", "agent-usage-tabs", "folder-preferences.json")).mode & 0o777, 0o600,
  "folder preferences are private to the user");
assert.notEqual(run("pin", "relative/path").status, 0, "preference commands reject relative paths");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("folder-preferences: all tests passed");
