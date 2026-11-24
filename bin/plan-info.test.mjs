import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { parseAmpUsage, planInfo } from "./plan-info.mjs";

const amp = "Signed in as x\n**Individual credits:** $9.59 remaining (set up auto-reload) - https://ampcode.com/settings\n\n## How Usage Is Charged\n- Models served by Amp: the token list price.\n";
assert.deepEqual(parseAmpUsage(amp), { signedIn: true, note: "" }, "a purchased balance is never shown; no daily allowance reported -> none");
assert.deepEqual(parseAmpUsage(amp + "Daily free allowance: $10.00 remaining today\n"), { signedIn: true, note: "Daily allowance $10.00" });
assert.equal(parseAmpUsage("Not signed in"), null);

// runner: cached 30 min, last good kept on failure, null for agents with no source
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-")); let calls = 0;
const goodAmp = "Signed in as x\n";
assert.equal(planInfo("kimi", { stateDir: dir, env: {}, run: () => "" }), null);
assert.equal(planInfo("amp", { stateDir: dir, env: {}, now: 0, run: () => { calls++; return goodAmp; } }).signedIn, true);
planInfo("amp", { stateDir: dir, env: {}, now: 60e3, run: () => { calls++; return goodAmp; } }); assert.equal(calls, 1);
assert.equal(planInfo("amp", { stateDir: dir, env: {}, now: 31 * 60e3, run: () => { calls++; return "garbage"; } }).signedIn, true, "keeps last good"); assert.equal(calls, 2);
fs.rmSync(dir, { recursive: true });
console.log("plan-info: all tests passed");
