import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { opencodeDbPath, opencodeTokens, opencodeModelName, summarizeOpencodeUsage, readOpencodeUsage } from "./opencode-usage.mjs";

const localDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const DAY = 86400000;
const NOW = new Date(2026, 10, 24, 15, 30).getTime(); // fixed "now" for the fixture
const daysAgo = (n, hour = 12) => { const d = new Date(NOW); d.setDate(d.getDate() - n); d.setHours(hour, 0, 0, 0); return d.getTime(); };

function makeDb(dir) {
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, fork_session_id TEXT, time_created INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  const msg = db.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, 's1', ?, ?, ?, ?)");
  const leg = db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, 's1', ?, ?)");
  const entry = (over = {}) => JSON.stringify({
    role: "assistant", providerID: "opencode", modelID: "gpt-5",
    tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } },
    time: { created: daysAgo(2) },
    ...over,
  });
  // V2 rows: two models, one nested-model shape, one compaction, one old, one undated-in-entry.
  msg.run("m1", "assistant", 1, daysAgo(2), entry()); // total 185
  msg.run("m2", "assistant", 2, daysAgo(1), entry({
    modelID: undefined, model: { providerID: "opencode-go", id: "anthropic/claude-sonnet-4-5:high" },
    tokens: { input: 1000, output: 500, cache: { read: 100, write: 0 } },
    time: { created: daysAgo(1, 9) },
  })); // total 1600
  msg.run("m3", "compaction", 3, daysAgo(3), entry({ tokens: { input: 10, output: 5 }, time: { created: daysAgo(3) } })); // 15
  msg.run("m4", "assistant", 4, daysAgo(40), entry({ time: { created: daysAgo(40) } })); // outside the 30-day window
  msg.run("m5", "assistant", 5, daysAgo(2), entry({ time: {} })); // no own time -> row time_created (2 days ago)
  msg.run("m6", "user", 6, daysAgo(1), entry()); // user row: filtered by type
  msg.run("m7", "assistant", 7, daysAgo(1), "{not json"); // corrupt: skipped
  msg.run("m8", "assistant", 8, daysAgo(1), entry({ tokens: {} })); // no tokens: skipped
  // Legacy v1 rows: one assistant (counts), one user (skipped), one id shared
  // with the V2 store (deduped), one 8 days ago (days only, not models).
  leg.run("m1", daysAgo(2), entry()); // same id as V2 m1 -> counted once
  leg.run("m9", daysAgo(1), entry({ role: "user" }));
  leg.run("m10", daysAgo(8), entry({ modelID: "glm-4.6", tokens: { input: 7, output: 3 }, time: { created: daysAgo(8) } })); // 10
  db.close();
  return dbPath;
}

// ---- pure helpers -------------------------------------------------------
assert.deepEqual(opencodeTokens({ tokens: { input: 3, output: 4, reasoning: 5, cache: { read: 6, write: 7 } } }),
  { input: 3, output: 9, cacheRead: 6, cacheWrite: 7 });
assert.deepEqual(opencodeTokens({}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
assert.equal(opencodeModelName({ modelID: "openai/gpt-5:high" }), "gpt-5");
assert.equal(opencodeModelName({ model: { providerID: "x", id: "glm-4.6" } }), "GLM-4.6");
assert.equal(opencodeModelName({}), "");

const sum = summarizeOpencodeUsage([
  { createdMs: daysAgo(1), model: "a", input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  { createdMs: daysAgo(5), model: "b", input: 5, output: 0, cacheRead: 0, cacheWrite: 0 },
  { createdMs: daysAgo(40), model: "a", input: 9, output: 9, cacheRead: 9, cacheWrite: 9 }, // outside 30d
  { createdMs: daysAgo(1), model: "a", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // nothing spent
], NOW);
assert.equal(sum.days.length, 30);
assert.equal(sum.days[29].date, localDate(NOW));
assert.equal(sum.days.find((d) => d.date === localDate(daysAgo(1))).tokens, 10);
assert.equal(sum.days.find((d) => d.date === localDate(daysAgo(5))).tokens, 5);
assert.equal(sum.days.find((d) => d.date === localDate(daysAgo(40))), undefined);
assert.deepEqual(sum.models, { a: 10, b: 5 }); // the 40-day-old row is outside the 7-day model window too
assert.deepEqual(sum.limits, []);

// ---- path resolution ------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-usage-"));
  assert.equal(opencodeDbPath({ home, env: {} }), path.join(home, ".local", "share", "opencode", "opencode-v2.db"));
  fs.mkdirSync(path.join(home, ".local", "share", "opencode"), { recursive: true });
  fs.writeFileSync(path.join(home, ".local", "share", "opencode", "opencode-v2.db"), "");
  assert.equal(opencodeDbPath({ home, env: {} }).endsWith("opencode-v2.db"), true, "legacy fallback only when normal is absent");
  fs.writeFileSync(path.join(home, ".local", "share", "opencode", "opencode.db"), "");
  assert.equal(opencodeDbPath({ home, env: {} }).endsWith("opencode.db"), true, "normal wins over legacy");
  assert.equal(opencodeDbPath({ home, env: { XDG_DATA_HOME: "/xdg", OPENCODE_DB: "custom.db" } }), "/xdg/opencode/custom.db");
  assert.equal(opencodeDbPath({ home, env: { OPENCODE_DB: "/abs/custom.db" } }), "/abs/custom.db");
}

// ---- store present --------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-usage-"));
  const dir = path.join(home, ".local", "share", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  makeDb(dir);
  const r = readOpencodeUsage({ home, env: {}, now: NOW });
  assert.ok(r, "expected a result");
  assert.equal(r.days.length, 30);
  assert.equal(r.days[29].date, localDate(NOW));
  assert.equal(r.days[0].date, localDate(NOW - 29 * DAY));
  // Day totals: m1 once (185, deduped across stores), m2 1600, m3 15, m5 185 (row time fallback).
  const d1 = r.days.find((d) => d.date === localDate(daysAgo(1)));
  assert.equal(d1.tokens, 1600); // only m2; m6/m7/m8 skipped
  const d2 = r.days.find((d) => d.date === localDate(daysAgo(2)));
  assert.equal(d2.tokens, 185 + 185); // m1 + m5
  const d3 = r.days.find((d) => d.date === localDate(daysAgo(3)));
  assert.equal(d3.tokens, 15);
  const d8 = r.days.find((d) => d.date === localDate(daysAgo(8)));
  assert.equal(d8.tokens, 10); // legacy m10
  assert.equal(r.days.find((d) => d.date === localDate(daysAgo(40))), undefined, "40-day-old row is outside the window");
  // Models over the last 7 calendar days: gpt-5 = m1+m5 (370) + m3 compaction (15);
  // the 8-day-old glm row is outside the week.
  assert.deepEqual(r.models, { "claude-sonnet-4-5": 1600, "gpt-5": 385 });
  assert.deepEqual(r.limits, []);
}

// ---- nothing readable ------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-usage-"));
  assert.equal(readOpencodeUsage({ home, env: {}, now: NOW }), null, "missing store -> null");
  const dir = path.join(home, ".local", "share", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "opencode.db"), "this is not sqlite");
  assert.equal(readOpencodeUsage({ home, env: {}, now: NOW }), null, "corrupt db -> null, no throw");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "oc-usage-"));
  const edir = path.join(empty, ".local", "share", "opencode");
  fs.mkdirSync(edir, { recursive: true });
  const db = new DatabaseSync(path.join(edir, "opencode.db"));
  db.exec("CREATE TABLE unrelated (x TEXT)");
  db.close();
  assert.equal(readOpencodeUsage({ home: empty, env: {}, now: NOW }), null, "db without opencode's store tables -> null");
  const empty2 = fs.mkdtempSync(path.join(os.tmpdir(), "oc-usage-"));
  const edir2 = path.join(empty2, ".local", "share", "opencode");
  fs.mkdirSync(edir2, { recursive: true });
  const db2 = new DatabaseSync(path.join(edir2, "opencode.db"));
  db2.exec("CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, data TEXT, time_created INTEGER)");
  db2.close();
  const r = readOpencodeUsage({ home: empty2, env: {}, now: NOW });
  assert.ok(r, "store present but empty -> result, not null");
  assert.equal(r.days.length, 30);
  assert.ok(r.days.every((d) => d.tokens === 0), "no records that day = honest 0");
  assert.deepEqual(r.models, {});
  assert.deepEqual(r.limits, []);
}

console.log("opencode-usage.test.mjs: all assertions passed");
