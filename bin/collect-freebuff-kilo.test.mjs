import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// collect.mjs runs its whole collection at import time, so this test sets up a
// scratch HOME/XDG first, then imports it once: the run doubles as the
// end-to-end check (fake `kilo`/`freebuff` binaries on PATH, a fake kilo.db
// and fake manicode run state) and `localUsageFields` is then exercised
// directly with fake reader results.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "collect-fb-kilo-"));
const home = path.join(tmp, "home");
const xdg = path.join(tmp, "xdg");
const fakeBin = path.join(tmp, "bin");
const outDir = path.join(xdg, "omarchy", "agent-usage-tabs");
fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(fakeBin, { recursive: true });
fs.mkdirSync(path.join(tmp, "xdg-runtime"), { recursive: true });
fs.writeFileSync(path.join(outDir, "live-models.json"),
  JSON.stringify({ antigravity: { at: Date.now(), models: [{ id: "m", name: "M" }] } }));
for (const b of ["kilo", "freebuff"]) {
  const f = path.join(fakeBin, b);
  fs.writeFileSync(f, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

// Kilo: a real (tiny) kilo.db with two assistant messages today. XDG_DATA_HOME
// is pinned so the reader never looks at the real data home.
const xdgData = path.join(tmp, "xdg-data");
const kiloDir = path.join(xdgData, "kilo");
fs.mkdirSync(kiloDir, { recursive: true });
{
  const db = new DatabaseSync(path.join(kiloDir, "kilo.db"));
  db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)");
  const msg = db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, 's1', ?, ?)");
  const now = Date.now();
  for (const [id, cost] of [["m1", 0.25], ["m2", 0.25]]) {
    msg.run(id, now, JSON.stringify({
      role: "assistant", providerID: "kilo", modelID: "kilo/kilo-auto/free",
      cost, tokens: { input: 1000, output: 500 }, time: { created: now },
    }));
  }
  db.close();
}

// Freebuff: one chat's run state, nested shape, active just now.
const chatDir = path.join(home, ".config", "manicode", "chats", "2026-11-25T00-00-00.000Z");
fs.mkdirSync(chatDir, { recursive: true });
fs.writeFileSync(path.join(chatDir, "run-state.json"), JSON.stringify({
  sessionState: { mainAgentState: { creditsUsed: 2.5, contextTokenCount: 8000, lastActivityAt: new Date().toISOString() } },
}));

process.env.HOME = home;
process.env.XDG_STATE_HOME = xdg;
process.env.XDG_DATA_HOME = xdgData;
process.env.XDG_RUNTIME_DIR = path.join(tmp, "xdg-runtime");
process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/nonexistent";
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
process.env.GROK_HOME = path.join(home, ".grok");
process.env.AGY_DIR = path.join(tmp, "agy-home");
process.env.PATH = `${fakeBin}:/usr/bin:/bin`;

const { localUsageFields } = await import("./collect.mjs");

// ---- the pure mapping, with fake reader results --------------------------
{
  // Unavailable: the one calm status line, and the can't-read note still shows.
  const k = localUsageFields("kilo", { agent: "kilo", available: false, status: "local data not available" });
  assert.equal(k.status, "local data not available");
  assert.match(k.cantRead, /^Can't read: Kilo's plan limits/);
  const f = localUsageFields("freebuff", { agent: "freebuff", available: false });
  assert.equal(f.status, "local data not available");
  assert.match(f.cantRead, /^Can't read: Freebuff's plan limits/);
  // A different unavailable reason is passed through, never invented.
  assert.equal(localUsageFields("kilo", { available: false, status: "reader broke" }).status, "reader broke");
  assert.equal(localUsageFields("kilo", null).status, "local data not available");

  // Kilo available: tokens, requests and cost for today and last 24h.
  const k2 = localUsageFields("kilo", {
    agent: "kilo", available: true,
    today: { tokens: 1500, requests: 2, cost: 0.5 },
    last24h: { tokens: 3000, requests: 5, cost: 1.25 },
    total: { tokens: 9000, requests: 9, cost: 2 },
    models: [],
  });
  assert.equal(k2.status, "Today: 1.5K tokens · 2 requests · $0.50 · last 24h: 3K tokens · 5 requests · $1.25");
  assert.equal(k2.cantRead.includes("kilo.db"), true);

  // Session fallback: requests is null -> the word is omitted, never "null".
  const k3 = localUsageFields("kilo", {
    available: true,
    today: { tokens: 10, requests: null, cost: 0 },
    last24h: { tokens: 20, requests: null, cost: 0 },
  });
  assert.equal(k3.status, "Today: 10 tokens · last 24h: 20 tokens");

  // Zero cost is omitted (a missing cost field reads as 0 and is not reported).
  const k4 = localUsageFields("kilo", {
    available: true,
    today: { tokens: 0, requests: 0, cost: 0 },
    last24h: { tokens: 0, requests: 0, cost: 0 },
  });
  assert.equal(k4.status, "Today: 0 tokens · 0 requests · last 24h: 0 tokens · 0 requests");

  // Freebuff: chats, credits and tokens; absent metrics are omitted.
  const f2 = localUsageFields("freebuff", {
    agent: "freebuff", available: true,
    today: { chats: 2, credits: 2.5, tokens: 8000 },
    last24h: { chats: 6, credits: 3.25, tokens: 32000 },
    total: { chats: 7, credits: 5.25, tokens: 65750 }, limits: [], note: "",
  });
  assert.equal(f2.status, "Today: 2 chats · 2.5 credits · 8K tokens · last 24h: 6 chats · 3.25 credits · 32K tokens");
  const f3 = localUsageFields("freebuff", {
    available: true,
    today: { chats: 1 },
    last24h: { chats: 3 },
  });
  assert.equal(f3.status, "Today: 1 chat · last 24h: 3 chats");

  // Not one of these agents: nothing is invented.
  assert.deepEqual(localUsageFields("kiro", { available: true }), { status: "", cantRead: "" });
}

// ---- the wired run: data.json carries the same fields ----------------------
const data = JSON.parse(fs.readFileSync(path.join(outDir, "data.json"), "utf8"));
const byId = Object.fromEntries(data.agents.map((a) => [a.id, a]));
for (const id of ["kilo", "freebuff"]) {
  const a = byId[id];
  assert.ok(a, `${id} keeps its tab slot`);
  assert.equal(a.installed, true, `${id} detected by its fake binary`);
  assert.deepEqual(a.limits, [], `${id}: no plan-limit percentages -> no meters`);
  assert.equal(a.status.startsWith("Today: "), true, `${id} status is the usage line: ${a.status}`);
  assert.match(a.cantRead, /^Can't read: /);
}
assert.equal(byId.kilo.status, "Today: 3K tokens · 2 requests · $0.50 · last 24h: 3K tokens · 2 requests · $0.50");
assert.equal(byId.freebuff.status, "Today: 1 chat · 2.5 credits · 8K tokens · last 24h: 1 chat · 2.5 credits · 8K tokens");
assert.equal(byId.kilo.name, "Kilo Code");
assert.equal(byId.freebuff.name, "Freebuff");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("collect-freebuff-kilo: all assertions passed");
