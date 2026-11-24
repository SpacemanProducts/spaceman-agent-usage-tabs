import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseWireJsonl, readKimiUsage } from "./kimi-usage.mjs";

const NOW = new Date(2026, 10, 24, 15, 30).getTime(); // 2026-11-24 local, mid-afternoon

function dateOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const DAY = 86400000;
const at = (daysAgo, hour = 12) => NOW - daysAgo * DAY - (15 - hour) * 3600000;

function usageRecord({ agentId = "main", model = "kimi-for-coding", time, tokens = {}, scope }) {
  const usage = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0, ...tokens };
  return JSON.stringify({ type: "usage.record", agentId, model, usage, usageScope: scope || "turn", time });
}

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-usage-"));
  const dir = path.join(home, ".kimi-code", "sessions", "ws-1", "sess-1", "agents");
  fs.mkdirSync(path.join(dir, "main"), { recursive: true });
  fs.mkdirSync(path.join(dir, "sub-1"), { recursive: true });
  return { home, dir };
}

// ---- parseWireJsonl (pure) ----
{
  const text = [
    usageRecord({ time: 1000, tokens: { inputOther: 10, output: 5, inputCacheRead: 3 } }),
    JSON.stringify({ type: "turn.prompt", time: 1000, promptId: "p1" }),
    "not json at all",
    JSON.stringify({ type: "usage.record", time: 2000, model: "x", usage: { inputOther: "bad" } }),
    usageRecord({ time: 3000, model: "", tokens: { output: 7 } }),
  ].join("\n");
  const rows = parseWireJsonl(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tokens, 18);
  assert.equal(rows[0].model, "kimi-for-coding");
  assert.equal(rows[1].model, "unknown");
  assert.equal(rows[1].tokens, 7);
  assert.deepEqual(parseWireJsonl(""), []);
  assert.deepEqual(parseWireJsonl(null), []);
}

// ---- readKimiUsage over a realistic store ----
{
  const { home, dir } = fakeHome();
  const today = at(0);
  const yesterday = at(1);
  const tenDays = at(10);
  const fortyDays = at(40);
  const main = [
    usageRecord({ time: today, tokens: { inputOther: 100, output: 50, inputCacheRead: 20, inputCacheCreation: 10 } }),
    usageRecord({ time: today + 1000, model: "kimi-for-coding", tokens: { inputOther: 30, output: 10 } }),
    usageRecord({ time: yesterday, tokens: { inputOther: 200, output: 100 } }),
    usageRecord({ time: tenDays, tokens: { inputOther: 500, output: 500 } }),
    usageRecord({ time: fortyDays, tokens: { inputOther: 9999, output: 9999 } }),
    JSON.stringify({ type: "turn.prompt", time: today, promptId: "p1", origin: { kind: "user" } }),
    "garbage line",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "main", "wire.jsonl"), main);
  // A fork's wire.jsonl copies the source's records verbatim: identical
  // (agentId,time,model,counts) rows must be counted once.
  fs.writeFileSync(path.join(dir, "sub-1", "wire.jsonl"), [
    usageRecord({ time: today, tokens: { inputOther: 100, output: 50, inputCacheRead: 20, inputCacheCreation: 10 } }),
    usageRecord({ time: today + 2000, model: "k3", tokens: { output: 40 } }),
  ].join("\n"));

  const r = readKimiUsage({ home, now: NOW });
  assert.ok(r, "expected a result");
  assert.equal(r.days.length, 30);
  assert.deepEqual(r.limits, []);

  const byDate = Object.fromEntries(r.days.map((d) => [d.date, d.tokens]));
  assert.equal(byDate[dateOf(today)], 180 + 40 + 40); // 100+50+20+10 + 30+10 + fork's 40; dup of first not double-counted
  assert.equal(byDate[dateOf(yesterday)], 300);
  assert.equal(byDate[dateOf(tenDays)], 1000);
  assert.equal(byDate[dateOf(fortyDays)], undefined);
  assert.equal(r.days.at(-1).date, dateOf(NOW));
  assert.equal(r.days[0].date, dateOf(NOW - 29 * DAY));
  assert.ok(r.days.every((d) => d.tokens >= 0));

  // models covers the last 7 days only: today+yesterday+k3, not the 10-day-old record
  assert.deepEqual(r.models, { "kimi-for-coding": 520, k3: 40 });
}

// ---- missing store -> null ----
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-usage-empty-"));
  assert.equal(readKimiUsage({ home, now: NOW }), null);
  // KIMI_CODE_HOME pointing at a bare dir is also "nothing readable"
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-usage-kch-"));
  assert.equal(readKimiUsage({ home, env: { KIMI_CODE_HOME: other }, now: NOW }), null);
}

// ---- corrupt file -> skipped without throwing ----
{
  const { home, dir } = fakeHome();
  fs.writeFileSync(path.join(dir, "main", "wire.jsonl"), "{bad json\n\n{\"type\":\"usage.record\",\"time\":\"nope\"}\n");
  const r = readKimiUsage({ home, now: NOW });
  assert.ok(r, "a present-but-corrupt store still yields a zeroed result");
  assert.equal(r.days.length, 30);
  assert.ok(r.days.every((d) => d.tokens === 0));
  assert.deepEqual(r.models, {});
}

// ---- KIMI_CODE_HOME is honoured ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-usage-kch2-"));
  const kimiHome = path.join(root, "custom-kimi");
  const agents = path.join(kimiHome, "sessions", "w", "s", "agents", "main");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, "wire.jsonl"), usageRecord({ time: at(0), tokens: { output: 11 } }));
  const r = readKimiUsage({ home: root, env: { KIMI_CODE_HOME: kimiHome }, now: NOW });
  assert.equal(r.days.at(-1).tokens, 11);
  assert.deepEqual(r.models, { "kimi-for-coding": 11 });
}

console.log("kimi-usage: all tests passed");
