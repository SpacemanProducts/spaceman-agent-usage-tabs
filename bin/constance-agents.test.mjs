import assert from "node:assert/strict";
import fs from "node:fs";
import { judge, judgeAll, launchCommand, LAUNCH, DEVIN_FREE_UNTIL, RED } from "./constance-agents.mjs";
const now = Date.UTC(2026, 10, 23, 12);
const at = { now, generatedAt: now - 60e3 };
const ag = (id, extra = {}) => ({ id, name: id, installed: true, signedIn: true, limits: [{ title: "Weekly", percent: 0.2 }], ...extra });

assert.equal(judge(ag("grok"), at).available, true, "a free agent under its limits is available");
assert.equal(judge(ag("claude"), at).available, false, "Claude is Constance herself, never a worker");
assert.equal(judge(ag("grok", { installed: false }), at).available, false);
assert.equal(judge(ag("grok", { signedIn: false }), at).reason, "sign-in needed");
assert.equal(judge(ag("grok", { cantRead: "Can't read" }), at).reason, "can't read its limits");
assert.equal(judge(ag("grok", { unsure: "old" }), at).available, false);
assert.equal(judge(ag("grok", { limits: [] }), at).reason, "reports no limits", "no reading can't prove it is under its limit");
assert.equal(judge(ag("copilot", { limits: [{ percent: 0.943 }] }), at).available, false, "Copilot at 94% is near the wall");
assert.equal(judge(ag("copilot", { limits: [{ percent: RED - 0.01 }] }), at).available, true);
assert.equal(judge(ag("cursor", { limits: [{ percent: 1, hitAt: "x" }] }), at).reason, "hit its limit");
assert.equal(judge(ag("antigravity", { limits: [{ percent: 0.1 }], accounts: [{ limits: [{ percent: 0.9 }] }] }), at).available, false, "any account's limit counts");
assert.equal(judge(ag("grok"), { now, generatedAt: now - 20 * 60e3 }).reason, "usage reading is out of date");
assert.equal(judge(ag("kimi"), at).reason, "no headless launch known");
assert.equal(judge(ag("qwen", { usageType: "byok_no_limits" }), at).available, false);
assert.equal(judge(ag("devin"), at).available, true, "Devin while SWE-2 Flash is free");
assert.match(judge(ag("devin"), { now: DEVIN_FREE_UNTIL, generatedAt: DEVIN_FREE_UNTIL }).reason, /would charge/, "Devin after its free window: skipped");
assert.equal(judgeAll({ generatedAt: now, agents: [ag("grok")] }, now)[0].available, true);

// Launches: the prompt is passed whole, Devin runs its free model, and the skip flags match bin/agent-here.sh.
for (const id of Object.keys(LAUNCH)) assert.ok(launchCommand(id, "do it; rm -rf x").includes("do it; rm -rf x"), `${id} gets the prompt as one argument`);
assert.ok(launchCommand("devin", "x").includes("swe-2-flash-medium"));
const here = fs.readFileSync(new URL("./agent-here.sh", import.meta.url), "utf8");
for (const [id, l] of Object.entries(LAUNCH)) {
  const m = here.match(new RegExp(`^\\s*${l.cli.replace(/[-]/g, "\\-")}(\\|[a-z]+)?\\) echo "([^"]*)"`, "m"));
  assert.ok(m, `${id}: agent-here.sh has a skip flag for ${l.cli}`);
  assert.equal(m[2], l.skip, `${id}: same skip flag as Start`);
  for (const f of l.skip.split(" ")) assert.ok(launchCommand(id, "p").includes(f), `${id} launch carries ${f}`);
}
// The Devin free date is the collector's.
const collect = fs.readFileSync(new URL("./collect.mjs", import.meta.url), "utf8");
const d = collect.match(/DEVIN_FLASH_FREE_UNTIL = Date\.UTC\(([^)]*)\)/)[1].split(",").map(Number);
assert.equal(Date.UTC(...d), DEVIN_FREE_UNTIL, "same Devin free date as bin/collect.mjs");
console.log("constance-agents: tests passed");
