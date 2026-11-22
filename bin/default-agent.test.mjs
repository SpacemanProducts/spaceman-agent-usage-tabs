import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { planDefault, DEFAULT_NAMES } from "./default-agent.mjs";
assert.deepEqual(planDefault("claude", true, ""), { name: "claude" });
assert.deepEqual(planDefault("antigravity", true, "claude"), { name: "agy" }, "tab id maps to Omarchy's name");
assert.deepEqual(planDefault("cursor", true, ""), { name: "cursor-agent" });
assert.ok(planDefault("nope", true, "").skip, "unsupported agents are skipped");
assert.ok(planDefault("grok", false, "").skip, "uninstalled agents are skipped (no surprise install)");
assert.ok(planDefault("grok", true, "grok").skip, "only changes are applied");
// Every name must be one omarchy-default-agent accepts.
const src = fs.readFileSync("/usr/share/omarchy/bin/omarchy-default-agent", "utf8");
for (const n of Object.values(DEFAULT_NAMES)) assert.ok(new RegExp(`agent="${n}"`).test(src), `${n} is a supported default`);
// End to end in a scratch HOME: writes the file and remembers it, and a second call does nothing.
const home = fs.mkdtempSync("/tmp/da-test-");
const run = (...a) => execFileSync("node", [new URL("./default-agent.mjs", import.meta.url).pathname, ...a], { env: { ...process.env, HOME: home, XDG_STATE_HOME: "" } });
run("codex", "installed");
assert.equal(fs.readFileSync(`${home}/.config/omarchy/defaults/agent`, "utf8"), "codex\n");
fs.writeFileSync(`${home}/.config/omarchy/defaults/agent`, "claude\n");
run("codex", "installed");
assert.equal(fs.readFileSync(`${home}/.config/omarchy/defaults/agent`, "utf8"), "claude\n", "no change -> the user's own pick stays");
run("hermes");  // not installed
assert.equal(fs.readFileSync(`${home}/.config/omarchy/defaults/agent`, "utf8"), "claude\n");
fs.rmSync(home, { recursive: true });
console.log("default-agent: all tests passed");
