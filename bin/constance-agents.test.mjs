import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { judge, judgeAll, launchCommand, accountEnv, LAUNCH, DEVIN_FREE_UNTIL, RED } from "./constance-agents.mjs";
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
// A blocked agent carries the fullest limit's reset time and title, so the panel can say when it frees up.
{
  const v = judge(ag("grok", { limits: [{ title: "Daily", percent: 0.4, resetsAt: "d1" }, { title: "Weekly", percent: 0.99, resetsAt: "w1" }] }), at);
  assert.equal(v.available, false); assert.equal(v.resetsAt, "w1"); assert.equal(v.blockTitle, "Weekly");
  assert.equal(judge(ag("grok"), at).resetsAt, null, "an available agent has no blocker");
}
assert.equal(judge(ag("antigravity", { limits: [{ percent: 0.1 }], accounts: [{ limits: [{ percent: 0.9 }] }] }), at).available, false, "any account's limit counts");

// ---- Multiple accounts: each login is its own source of free capacity.
const acct = (id, label, percent, extra = {}) => ({ id, label, limits: [{ title: "Weekly", percent, ...extra }] });
{
  // One account hot, one cool: she uses the cool one and names it.
  const v = judge(ag("grok", { limits: [{ percent: 0.1 }], accounts: [acct("main", "Main", 0.95), acct("work", "Work", 0.3)] }), at);
  assert.equal(v.available, true); assert.equal(v.account, "Work"); assert.equal(v.accountId, "work"); assert.equal(v.worst, 0.3);
  assert.equal(v.reason, "under its limits (fullest 30%)");
  // Both blocked: unavailable, and she names the one closest to freeing up.
  const b = judge(ag("grok", { limits: [], accounts: [acct("main", "Main", 0.9, { resetsAt: "r1" }), acct("work", "Work", 0.95)] }), at);
  assert.equal(b.available, false); assert.equal(b.account, "Main"); assert.equal(b.reason, "at 90% of a limit"); assert.equal(b.resetsAt, "r1");
  // A wall on one account doesn't hide the other account's room.
  const h = judge(ag("codex", { limits: [], accounts: [acct("a", "A", 1, { hitAt: "x" }), acct("b", "B", 0.2)] }), at);
  assert.equal(h.available, true); assert.equal(h.account, "B");
  // Every account walled: still "hit its limit", blamed on the least-bad one.
  const wall = judge(ag("codex", { limits: [], accounts: [acct("a", "A", 1, { hitAt: "x" }), acct("b", "B", 1, { hitAt: "y" })] }), at);
  assert.equal(wall.available, false); assert.equal(wall.reason, "hit its limit");
  // accounts[] entries with no readable limits fall back to the agent's own limits.
  const fb = judge(ag("grok", { limits: [{ percent: 0.2 }], accounts: [{ id: "x", label: "X", limits: [] }] }), at);
  assert.equal(fb.available, true); assert.equal(fb.account, "");
  // A single-account agent reports no account at all — unchanged shape.
  const s = judge(ag("grok"), at);
  assert.equal(s.account, ""); assert.equal(s.accountId, null); assert.equal(s.reason, "under its limits (fullest 20%)");
}

// ---- accountEnv: pin a CLI to a registered account's home, never the seated one.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acct-env-"));
  const xdg = path.join(dir, "xdg");
  const regDir = path.join(xdg, "omarchy", "agents", "accounts");
  fs.mkdirSync(regDir, { recursive: true });
  fs.writeFileSync(path.join(regDir, "grok.json"), JSON.stringify({ active: "main", accounts: [
    { id: "main", home: "/h/.grok", login: "/h/.grok", active: true },
    { id: "work", home: "/state/grok/work", login: "/state/grok/work" }] }));
  const env = { HOME: "/h", XDG_STATE_HOME: xdg };
  assert.deepEqual(accountEnv("grok", "work", env), { GROK_HOME: "/state/grok/work" }, "a non-seated account pins its own home");
  assert.deepEqual(accountEnv("grok", "main", env), {}, "the seated account needs no pin");
  assert.deepEqual(accountEnv("grok", "", env), {}, "no account picked: no pin");
  assert.deepEqual(accountEnv("grok", "ghost", env), {}, "unknown id: no pin");
  assert.deepEqual(accountEnv("copilot", "work", env), {}, "single-account providers have no homes");
  assert.deepEqual(accountEnv("grok", "work", { HOME: "/h", XDG_STATE_HOME: path.join(dir, "empty") }), {}, "no registry: no pin");
  fs.rmSync(dir, { recursive: true, force: true });
}
// The panel names the account she picked and the log does too.
{
  const qml = fs.readFileSync(new URL("../Panel.qml", import.meta.url), "utf8");
  assert.match(qml, /constanceAgentName\(modelData\.id\)\) \+ \(modelData\.account \? " \(" \+ modelData\.account \+ "\)" : ""\)/, "agent rows show 'Name (Account)'");
  assert.match(qml, /constanceAgentName\(e\.agent\) \+ \(e\.account \? " \(" \+ e\.account \+ "\)" : ""\)/, "log lines name the account too");
}
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
