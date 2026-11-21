import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { checkAgentData, createDiagnostics } from "./diagnostics.mjs";

const good = { id: "claude", installed: true, limits: [{ title: "Session", percent: 0.5, resetsAt: "2026-11-21T06:00:00Z" }], models: [{ name: "m", total: 5 }], days: Array.from({ length: 7 }, () => ({ tokens: 1 })) };
assert.deepEqual(checkAgentData(good), [], "a healthy record has no problems");
assert.deepEqual(checkAgentData({ ...good, installed: false, limits: "junk" }), [], "uninstalled agents are not checked");
assert.match(checkAgentData({ ...good, limits: [{ title: "S", percent: 1.4 }] })[0], /percent 1.4/);
assert.match(checkAgentData({ ...good, limits: [{ title: "S", percent: "x" }] })[0], /percent "x"/);
assert.match(checkAgentData({ ...good, limits: [{ title: "S", percent: 0.1, resetsAt: "not a date" }] })[0], /unreadable reset time/);
assert.match(checkAgentData({ ...good, limits: null })[0], /limits is not a list/);
assert.match(checkAgentData({ ...good, models: [{ name: "m", total: NaN }] })[0], /token total/);
assert.match(checkAgentData({ ...good, days: [{ tokens: 1 }] })[0], /1 entries \(expected 7\)/);
assert.deepEqual(checkAgentData({ ...good, days: [] }), [], "no token-history source is not a problem");
assert.match(checkAgentData({ ...good, days: Array.from({ length: 7 }, () => ({ tokens: -1 })) }).join(), /invalid token count/);
assert.deepEqual(checkAgentData(good.limits[0].percent === 0.5 ? { ...good, limits: [{ title: "ok", percent: 0, resetsAt: "" }] } : null), [], "zero percent and empty reset are fine");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dg-")); const logFile = path.join(dir, "collector.log"), stateFile = path.join(dir, "diag-state.json");
let t = 1_000_000_000_000; const mk = () => createDiagnostics({ logFile, stateFile, now: () => t });
let d = mk(); assert.equal(d.summary("grok"), ""); d.add("grok", "output was not JSON", { head: "<html>" }); d.add("grok", "second", null);
assert.match(d.summary("grok"), /2 problems/); assert.equal(d.flush(), 2);
const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse);
assert.equal(lines[0].agent, "grok"); assert.equal(lines[0].problem, "output was not JSON"); assert.deepEqual(lines[0].details, { head: "<html>" });
// same problem again within an hour: still shown on the tab, not logged again
d = mk(); d.add("grok", "output was not JSON"); assert.equal(d.flush(), 0); assert.match(d.summary("grok"), /1 problem\b/);
// after an hour it logs again
t += 61 * 60e3; d = mk(); d.add("grok", "output was not JSON"); assert.equal(d.flush(), 1);
// nothing wrong: nothing written
d = mk(); assert.equal(d.flush(), 0);
// the log is capped
t += 61 * 60e3; d = mk(); for (let i = 0; i < 400; i++) d.add("a", `p${i}`); d.flush();
assert.equal(fs.readFileSync(logFile, "utf8").trim().split("\n").length, 300);
fs.rmSync(dir, { recursive: true });
console.log("diagnostics: all tests passed");
