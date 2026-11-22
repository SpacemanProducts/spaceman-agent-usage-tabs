import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mergeProfiles } from "./squad-profiles.mjs";
const cfg = { default_program: "claude", auto_yes: false, profiles: [{ name: "Mine", program: "aider" }, { name: "Grok", program: "old-grok" }] };
const r = mergeProfiles(cfg, ["claude", "agy", "nope"]);
assert.equal(r.default_program, "claude", "other keys untouched");
assert.deepEqual(r.profiles, [{ name: "Mine", program: "aider" }, { name: "Claude Code", program: "claude" }, { name: "Antigravity", program: "agy" }], "own profiles kept, managed ones replaced, unknown agents skipped");
assert.deepEqual(mergeProfiles(null, ["codex"]).profiles, [{ name: "Codex", program: "codex" }]);
// the command line writes the file
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sp-")), file = path.join(dir, "sub/config.json");
spawnSync("node", [path.join(path.dirname(fileURLToPath(import.meta.url)), "squad-profiles.mjs"), file, "grok", "amp"]);
assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).profiles, [{ name: "Grok", program: "grok" }, { name: "Amp", program: "amp" }]);
fs.rmSync(dir, { recursive: true });
console.log("squad-profiles: all tests passed");
