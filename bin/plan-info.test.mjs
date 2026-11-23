import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { parseKiroUsage, parseAmpUsage, planInfo } from "./plan-info.mjs";

const kiro = "Estimated Usage | resets on 2026-12-01 | KIRO FREE\nCredits (0.02 of 50 covered in plan), 0.0%\nManage your plan at https://app.kiro.dev/account/usage\n";
const k = parseKiroUsage(kiro);
assert.equal(k.plan, "Free"); assert.equal(k.limits[0].title, "Credits"); assert.equal(k.limits[0].percent, 0.02 / 50); assert.equal(k.limits[0].resetsAt, "2026-12-01T00:00:00Z");
assert.equal(parseKiroUsage("Credits (1,500 of 10,000 covered in plan)").limits[0].percent, 0.15, "thousands separators");
assert.equal(parseKiroUsage("Estimated Usage | resets on 2026-12-01 | KIRO PRO").plan, "Pro");
assert.equal(parseKiroUsage("Error: not logged in"), null); assert.equal(parseKiroUsage(""), null);

const amp = "Signed in as x\n**Individual credits:** $9.59 remaining (set up auto-reload) - https://ampcode.com/settings\n\n## How Usage Is Charged\n- Models served by Amp: the token list price.\n";
assert.deepEqual(parseAmpUsage(amp), { signedIn: true, note: "" }, "a purchased balance is never shown; no daily allowance reported -> none");
assert.deepEqual(parseAmpUsage(amp + "Daily free allowance: $10.00 remaining today\n"), { signedIn: true, note: "Daily allowance $10.00" });
assert.equal(parseAmpUsage("Not signed in"), null);



// runner: cached 30 min, last good kept on failure, null for agents with no source
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-")); let calls = 0;
assert.equal(planInfo("kimi", { stateDir: dir, env: {}, run: () => "" }), null);
assert.equal(planInfo("kiro", { stateDir: dir, env: {}, now: 0, run: () => { calls++; return kiro; } }).plan, "Free");
planInfo("kiro", { stateDir: dir, env: {}, now: 60e3, run: () => { calls++; return kiro; } }); assert.equal(calls, 1);
assert.equal(planInfo("kiro", { stateDir: dir, env: {}, now: 31 * 60e3, run: () => { calls++; return "garbage"; } }).plan, "Free", "keeps last good"); assert.equal(calls, 2);
fs.rmSync(dir, { recursive: true });
console.log("plan-info: all tests passed");
