import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { kiloDbPath, kiloTokens, kiloCost, kiloModel, summarizeKiloUsage, readKiloUsage } from "./kilo-usage.mjs";

const DAY = 86400000;
const NOW = new Date(2026, 10, 25, 15, 30).getTime(); // fixed "now" for the fixture
const localDate = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const todayAt = (hour) => { const d = new Date(NOW); d.setHours(hour, 0, 0, 0); return d.getTime(); };
const daysAgo = (n, hour = 12) => { const d = new Date(NOW); d.setDate(d.getDate() - n); d.setHours(hour, 0, 0, 0); return d.getTime(); };

// ---- pure helpers ---------------------------------------------------------
assert.equal(kiloTokens({ tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } } }), 185);
assert.equal(kiloTokens({ tokens: { inputTokens: 7, outputTokens: 3 } }), 10);
assert.equal(kiloTokens({ tokens: 42 }), 42);
assert.equal(kiloTokens({}), 0);
assert.equal(kiloCost({ cost: 0.5 }), 0.5);
assert.equal(kiloCost({}), 0);
assert.equal(kiloModel({ modelID: "anthropic/claude-sonnet-4-5" }), "anthropic/claude-sonnet-4-5");
assert.equal(kiloModel({}), "unknown");

{
  const sum = summarizeKiloUsage([
    { ms: todayAt(9), model: "a", tokens: 10, cost: 0.1 },
    { ms: NOW - 2 * 3600000, model: "a", tokens: 5, cost: 0.05 },
    { ms: NOW - 25 * 3600000, model: "b", tokens: 7, cost: 0 }, // inside today? no: yesterday 14:30 -> last24h only if within 24h
    { ms: daysAgo(3), model: "b", tokens: 100, cost: 1 },
    { ms: null, model: "c", tokens: 1, cost: 0 }, // undated still counts in total
  ], NOW);
  assert.equal(sum.agent, "kilo");
  assert.equal(sum.available, true);
  assert.equal(sum.today.tokens, 15);
  assert.equal(sum.today.requests, 2);
  assert.ok(Math.abs(sum.today.cost - 0.15) < 1e-9);
  assert.equal(sum.last24h.tokens, 15);
  assert.equal(sum.last24h.requests, 2); // the 25 h-old row is outside
  assert.ok(Math.abs(sum.last24h.cost - 0.15) < 1e-9);
  assert.equal(sum.total.requests, 5);
  assert.equal(sum.total.tokens, 123);
  assert.deepEqual(sum.models.map((m) => m.model), ["b", "a", "c"]);
}

// precise last24h check: NOW-25h is outside the 24 h window
{
  const sum = summarizeKiloUsage([
    { ms: NOW - 3600000, model: "a", tokens: 1, cost: 0 },
    { ms: NOW - 25 * 3600000, model: "a", tokens: 2, cost: 0 },
  ], NOW);
  assert.deepEqual(sum.last24h, { tokens: 1, requests: 1, cost: 0 });
  assert.equal(sum.total.requests, 2);
}

// ---- path ------------------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-usage-"));
  assert.equal(kiloDbPath({ home, env: {} }), path.join(home, ".local", "share", "kilo", "kilo.db"));
  assert.equal(kiloDbPath({ home, env: { XDG_DATA_HOME: "/xdg" } }), "/xdg/kilo/kilo.db");
}

// ---- store present -----------------------------------------------------------
function makeDb(dir, { sessions = false } = {}) {
  const dbPath = path.join(dir, "kilo.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE account (id TEXT PRIMARY KEY, email TEXT);
    CREATE TABLE credential (id TEXT PRIMARY KEY, account_id TEXT, data TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
  `);
  if (sessions) {
    db.prepare("INSERT INTO session (id, cost, tokens_input, tokens_output, tokens_reasoning, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("s1", 1.25, 1000, 500, 100, todayAt(8), todayAt(10));
    db.prepare("INSERT INTO session (id, cost, tokens_input, tokens_output, tokens_reasoning, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("s2", 0.5, 2000, 0, 0, daysAgo(2), daysAgo(2));
  }
  const msg = db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, 's1', ?, ?)");
  const entry = (over = {}) => JSON.stringify({
    role: "assistant", providerID: "kilo", modelID: "kilo-auto",
    cost: 0.01,
    tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } }, // 185
    time: { created: todayAt(9) },
    ...over,
  });
  msg.run("m1", todayAt(9), entry());
  msg.run("m2", todayAt(10), entry({ modelID: "anthropic/claude-sonnet-4-5", cost: 0.02, time: { created: NOW - 3600000 } })); // today + last24h
  msg.run("m3", daysAgo(1), entry({ time: { created: daysAgo(1) } })); // yesterday: total + last24h? daysAgo(1) at noon vs NOW 15:30 -> 27.5h ago, outside 24h
  msg.run("m4", daysAgo(2), entry({ tokens: { input: 7, output: 3 }, time: { created: daysAgo(2) } })); // 10 tokens
  msg.run("m5", todayAt(11), entry({ time: {} })); // no own time -> row time_created (today)
  msg.run("m6", todayAt(11), entry({ role: "user" })); // user row: skipped
  msg.run("m7", todayAt(11), "{not json"); // corrupt: skipped
  msg.run("m8", todayAt(11), entry({ time: { created: "not a time" } })); // untrusted time: skipped
  msg.run("m9", todayAt(12), entry({ time: 1764000000000 })); // bare epoch ms -> 2025-11-25? verify below
  db.close();
  return dbPath;
}

{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-usage-"));
  const dir = path.join(home, ".local", "share", "kilo");
  fs.mkdirSync(dir, { recursive: true });
  makeDb(dir);
  const r = readKiloUsage({ home, env: {}, now: NOW });
  // m1 185, m2 185, m3 185, m4 10, m5 185, m9 185 = 935
  assert.equal(r.total.tokens, 935);
  assert.equal(r.total.requests, 6);
  assert.ok(Math.abs(r.total.cost - 0.07) < 1e-9); // five rows at 0.01 + m2 at 0.02
  // today: m1, m2, m5, m9(if its epoch lands today) — compute m9's day
  const m9ms = 1764000000000;
  const m9Today = localDate(m9ms) === localDate(NOW);
  const expectedTodayRequests = 3 + (m9Today ? 1 : 0); // m1, m2, m5 (+m9 if it lands today)
  assert.equal(r.today.requests, expectedTodayRequests);
  assert.equal(r.today.tokens, 185 * expectedTodayRequests);
  const m9in24 = m9ms > NOW - DAY && m9ms <= NOW;
  assert.equal(r.last24h.requests, 3 + (m9in24 ? 1 : 0));
  // models
  const kiloAuto = r.models.find((m) => m.model === "kilo-auto");
  const claude = r.models.find((m) => m.model === "anthropic/claude-sonnet-4-5");
  assert.equal(kiloAuto.requests, 5);
  assert.equal(claude.requests, 1);
  assert.equal(r.models[0].tokens >= r.models[1].tokens, true);
}

// ---- missing / unreadable ---------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-usage-"));
  assert.deepEqual(readKiloUsage({ home, env: {}, now: NOW }), { agent: "kilo", available: false, status: "local data not available" });
  const dir = path.join(home, ".local", "share", "kilo");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "kilo.db"), "this is not sqlite");
  assert.deepEqual(readKiloUsage({ home, env: {}, now: NOW }).available, false, "corrupt db -> unavailable, no throw");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-usage-"));
  const edir = path.join(empty, ".local", "share", "kilo");
  fs.mkdirSync(edir, { recursive: true });
  const db = new DatabaseSync(path.join(edir, "kilo.db"));
  db.exec("CREATE TABLE unrelated (x TEXT)");
  db.close();
  assert.deepEqual(readKiloUsage({ home: empty, env: {}, now: NOW }).available, false, "db without kilo's tables -> unavailable");
}

// ---- empty store is still available ------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-usage-"));
  const dir = path.join(home, ".local", "share", "kilo");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "kilo.db"));
  db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)");
  db.close();
  const r = readKiloUsage({ home, env: {}, now: NOW });
  assert.equal(r.available, true);
  assert.deepEqual(r.total, { tokens: 0, requests: 0, cost: 0 });
  assert.deepEqual(r.models, []);
}

// ---- session fallback -----------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-usage-"));
  const dir = path.join(home, ".local", "share", "kilo");
  fs.mkdirSync(dir, { recursive: true });
  makeDb(dir, { sessions: true });
  // remove the message table so only sessions remain
  const dbPath = path.join(dir, "kilo.db");
  const db = new DatabaseSync(dbPath);
  db.exec("DROP TABLE message");
  db.close();
  const r = readKiloUsage({ home, env: {}, now: NOW });
  assert.equal(r.available, true);
  assert.equal(r.total.tokens, 1600 + 2000);
  assert.equal(r.total.cost, 1.75);
  assert.equal(r.total.requests, null, "sessions are not requests");
  assert.deepEqual(r.models, []);
}

console.log("kilo-usage.test.mjs: all assertions passed");
