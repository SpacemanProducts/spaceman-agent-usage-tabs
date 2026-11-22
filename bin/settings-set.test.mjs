import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applySetting, applyHidden, applyVolume, applyOrder, DEFAULT_ORDER } from "./settings-set.mjs";

assert.deepEqual(applySetting({}, "hideUninstalledAgents", "false"), { hideUninstalledAgents: false });
assert.deepEqual(applySetting({ showUnusedModels: true }, "hideUninstalledAgents", "true"), { showUnusedModels: true, hideUninstalledAgents: true }, "other keys kept");
assert.deepEqual(applySetting(null, "showUnusedModels", "false"), { showUnusedModels: false });
assert.deepEqual(applySetting([1], "showUnusedModels", "true"), { showUnusedModels: true }, "garbage file replaced");
assert.deepEqual(applySetting({}, "resetAnimation", "false"), { resetAnimation: false });
assert.throws(() => applySetting({}, "tabOrder", "true"), /unknown setting/, "only the panel switches");
assert.throws(() => applySetting({}, "showUnusedModels", "yes"), /true or false/);

// Sound switch and volume
assert.deepEqual(applySetting({}, "resetSound", "false"), { resetSound: false });
assert.deepEqual(applySetting({}, "autoOpenOnReset", "false"), { autoOpenOnReset: false });
assert.deepEqual(applyVolume({}, "60"), { resetVolume: 60 }); assert.deepEqual(applyVolume({ resetSound: true }, 0), { resetSound: true, resetVolume: 0 });
assert.deepEqual(applyVolume({}, "100"), { resetVolume: 100 });
for (const bad of ["101", "-1", "6.5", "abc", "", "1e2", null]) assert.throws(() => applyVolume({}, bad), /integer 0-100/, `rejects ${bad}`);

// Per-agent hidden list
assert.deepEqual(applyHidden({}, "amp", "true"), { hiddenAgents: ["amp"] });
assert.deepEqual(applyHidden({ hiddenAgents: ["amp"] }, "amp", "true"), { hiddenAgents: ["amp"] }, "no duplicates");
assert.deepEqual(applyHidden({ hiddenAgents: ["amp", "kiro"] }, "amp", "false"), { hiddenAgents: ["kiro"] }, "unhide one");
assert.deepEqual(applyHidden({ hiddenAgents: [] }, "kiro", "false"), { hiddenAgents: [] }, "unhide something never hidden");
assert.deepEqual(applyHidden({ showUnusedModels: false, hiddenAgents: ["ghost", "amp"] }, "kiro", "true"), { showUnusedModels: false, hiddenAgents: ["amp", "kiro"] }, "other settings kept, junk ids dropped");
assert.throws(() => applyHidden({}, "ghost", "true"), /unknown agent/);
assert.throws(() => applyHidden({}, "amp", "maybe"), /true or false/);

// End to end through the CLI, in a throwaway state dir.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-")); const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "settings-set.mjs");
const run = (...a) => spawnSync(process.execPath, [script, ...a], { env: { ...process.env, XDG_STATE_HOME: dir }, encoding: "utf8" });
assert.equal(run("hideUninstalledAgents", "false").status, 0);
assert.equal(run("showUnusedModels", "true").status, 0);
const file = path.join(dir, "omarchy", "agent-usage-tabs", "settings.json");
assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { hideUninstalledAgents: false, showUnusedModels: true });
assert.equal(run("hidden", "amp", "true").status, 0);
assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).hiddenAgents, ["amp"]);
assert.equal(run("hidden", "amp", "false").status, 0);
assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).hiddenAgents, []);
assert.equal(run("volume", "35").status, 0); assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).resetVolume, 35);
assert.notEqual(run("volume", "999").status, 0);
assert.notEqual(run("bogus", "true").status, 0);
assert.notEqual(run("hidden", "ghost", "true").status, 0);
fs.rmSync(dir, { recursive: true });
console.log("settings-set: all tests passed");

// Tab order
assert.deepEqual(applyOrder({ resetSound: true }, "grok,claude"), { resetSound: true, tabOrder: ["grok", "claude"] }, "other keys kept");
assert.deepEqual(applyOrder({ tabOrder: ["grok"] }, "reset").tabOrder, DEFAULT_ORDER, "reset restores the default order");
assert.deepEqual(DEFAULT_ORDER.slice(0, 4), ["claude", "antigravity", "grok", "codex"]);
for (const bad of ["", "nope", "claude,claude", "claude,,"]) if (bad !== "claude,,") assert.throws(() => applyOrder({}, bad), /distinct known agent ids/, `rejects ${JSON.stringify(bad)}`);
console.log("settings-set: tab order tests passed");

// Catalog agents are real tabs: they can be hidden and reordered
assert.deepEqual(applyHidden({}, "droid", "true"), { hiddenAgents: ["droid"] });
assert.deepEqual(applyOrder({}, "qwen,claude").tabOrder, ["qwen", "claude"]);
assert.equal(DEFAULT_ORDER.indexOf("claude"), 0); assert.ok(DEFAULT_ORDER.indexOf("droid") > DEFAULT_ORDER.indexOf("hermes"), "catalog agents come after the core twelve");
console.log("settings-set: catalog ids ok");
