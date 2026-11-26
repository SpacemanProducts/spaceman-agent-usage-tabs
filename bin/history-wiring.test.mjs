import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Wires bin/usage-history.mjs + bin/weekly-summary.mjs into bin/collect.mjs:
// every agent in data.json gains `history` (30 {date,tokens} entries, oldest
// first, ending today) and the top level gains `weekly`. A fresh install is
// backfilled from our own collectors' local logs (here: Kimi's wire.jsonl)
// for dates that have no tokens yet; the Omarchy record stays primary.
// Runs the real collector end to end in a scratch HOME/XDG_* with stub scripts
// on PATH (same pattern as devin-deep.test.mjs): no real home, no network, no
// real notifications.
//   - a fake `kimi` CLI in stub-bin makes the agent "installed";
//   - <xdg>/omarchy/agents/usage/kimi.json is the seeded Omarchy record;
//   - ~/.kimi-code/sessions/.../wire.jsonl holds one usage.record 10 days ago
//     (backfilled: outside Omarchy's 7-day window) and one 2 days ago
//     (overwritten by the Omarchy record's 0, proving precedence);
//   - a second run must not double-count anything.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLLECT = path.join(HERE, "collect.mjs");

const localDate = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// Calendar-day arithmetic in local time, like shiftDate in usage-history.mjs:
// subtracting fixed 24 h steps lands on the wrong date across a DST change.
// `hour` exists for timestamps that must stay inside the intended day.
const localDay = (n, hour = 0) => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n, hour).getTime();
};
const daysAgoDate = (n) => localDate(localDay(n));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "history-wiring-"));
const home = path.join(tmp, "home");
const xdg = path.join(tmp, "xdg");
const outDir = path.join(xdg, "omarchy", "agent-usage-tabs");
const usageDir = path.join(xdg, "omarchy", "agents", "usage");
const stubBin = path.join(tmp, "stub-bin");
for (const d of [path.join(home, ".local", "bin"), path.join(home, ".claude"), outDir, usageDir, stubBin,
  path.join(tmp, "xdg-config"), path.join(tmp, "xdg-data"), path.join(tmp, "xdg-runtime"), path.join(tmp, "agy-home")])
  fs.mkdirSync(d, { recursive: true });

const stub = (name, body) => {
  const f = path.join(stubBin, name);
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(f, 0o755);
};
stub("notify-send", `echo "$@" >> "${path.join(tmp, "notify.log")}"`);
stub("omarchy-agent-usage-update", `echo "$@" >> "${path.join(tmp, "update.log")}"`);
stub("omarchy-agent-account-list", `echo '[]'`);
stub("secret-tool", `exit 1`);
stub("kimi", `exit 0`); // only needs to exist on PATH for isInstalled

// Keep the 6 h live-models cache warm for Antigravity so `agy models` is never spawned.
fs.writeFileSync(path.join(outDir, "live-models.json"),
  JSON.stringify({ antigravity: { at: Date.now(), models: [{ id: "gemini-x", name: "Gemini X" }] } }));

// The seeded Omarchy record: today 200, yesterday 100 messageCounts; every
// other day in the 7-day window reports an implicit 0.
const today = localDate(Date.now());
const yesterday = daysAgoDate(1);
const twoDaysAgo = daysAgoDate(2);
const tenDaysAgo = daysAgoDate(10);
fs.writeFileSync(path.join(usageDir, "kimi.json"), JSON.stringify({
  tierLabel: "Go",
  ready: true,
  limits: [],
  recentDays: [
    { date: today, messageCount: 200 },
    { date: yesterday, messageCount: 100 },
  ],
  modelUsage: {},
}));

// Kimi's own session log: a 10-day-old record (outside Omarchy's window, so it
// must be backfilled) and a 2-day-old one (inside it, so Omarchy's 0 wins).
const wireDir = path.join(home, ".kimi-code", "sessions", "ws", "sess", "agents", "main");
fs.mkdirSync(wireDir, { recursive: true });
const rec = (daysAgo, inputOther, output) => JSON.stringify({
  type: "usage.record", agentId: "a1", model: "kimi-k2",
  usage: { inputOther, output, inputCacheRead: 0, inputCacheCreation: 0 },
  time: localDay(daysAgo, 12),
});
fs.writeFileSync(path.join(wireDir, "wire.jsonl"),
  `${rec(10, 1000, 500)}\n${rec(2, 700, 77)}\n`);

const env = {
  ...process.env,
  HOME: home,
  XDG_STATE_HOME: xdg,
  XDG_CONFIG_HOME: path.join(tmp, "xdg-config"),
  XDG_DATA_HOME: path.join(tmp, "xdg-data"),
  XDG_RUNTIME_DIR: path.join(tmp, "xdg-runtime"),
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
  CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
  GROK_HOME: path.join(home, ".grok"),
  AGY_DIR: path.join(tmp, "agy-home"),
  PATH: stubBin,
};

function run() {
  return spawnSync(process.execPath, [COLLECT, "--notify", "101", "--volume", "0"],
    { encoding: "utf8", env, timeout: 120000 });
}
const readData = () => JSON.parse(fs.readFileSync(path.join(outDir, "data.json"), "utf8"));
const readHistory = () => JSON.parse(fs.readFileSync(path.join(outDir, "history.json"), "utf8"));
const kimiHistory = (data) => {
  const k = data.agents.find((a) => a.id === "kimi");
  assert.ok(k, "kimi keeps its tab");
  return k.history;
};
const tokensOn = (series, date) => series.find((h) => h.date === date)?.tokens;

// ------------------------------------------------------------------ run one
let r = run();
assert.equal(r.status, 0, `collect.mjs failed:\n${r.stderr}\n${r.stdout}`);

const data = readData();
assert.equal(data.schemaVersion, 1);
assert.ok(data.weekly && typeof data.weekly === "object", "top-level weekly present");
assert.ok(Array.isArray(data.weekly.agents), "weekly.agents is a list");
assert.equal(data.weekly.to, today, "weekly ends today");

for (const a of data.agents) {
  assert.ok(Array.isArray(a.history), `${a.id}: history is a list`);
  assert.equal(a.history.length, 30, `${a.id}: exactly 30 days`);
  assert.equal(a.history[29].date, today, `${a.id}: series ends today`);
  assert.equal(a.history[0].date, daysAgoDate(29), `${a.id}: series starts 29 days ago`);
  for (const h of a.history) {
    assert.deepEqual(Object.keys(h).sort(), ["date", "tokens"], `${a.id}: only date+tokens kept`);
    assert.match(h.date, /^\d{4}-\d{2}-\d{2}$/, `${a.id}: ISO date`);
    assert.ok(h.tokens === null || (typeof h.tokens === "number" && Number.isFinite(h.tokens)), `${a.id}: tokens number|null`);
  }
}

// history.json itself: written, owner-only.
const histFile = path.join(outDir, "history.json");
assert.ok(fs.existsSync(histFile), "history.json written");
assert.equal(fs.statSync(histFile).mode & 0o777, 0o600, "history.json is mode 0600");
const hist = readHistory();
assert.equal(hist.schemaVersion, 1);
assert.equal(hist.days[tenDaysAgo]?.kimi?.tokens, 1500, "backfilled 10-day-old Kimi day in history.json");

// The agent-facing series carries the same numbers.
const series = kimiHistory(data);
assert.equal(tokensOn(series, tenDaysAgo), 1500, "backfilled Kimi day in data.json history");
assert.equal(tokensOn(series, today), 200, "Omarchy record owns today");
assert.equal(tokensOn(series, yesterday), 100, "Omarchy record owns yesterday");
assert.equal(tokensOn(series, twoDaysAgo), 0, "Omarchy's implicit 0 beats the backfilled 777");

// weekly: last 7 days of kimi = 200 + 100 + five implicit zeros.
const kimiWeek = data.weekly.agents.find((a) => a.id === "kimi");
assert.ok(kimiWeek, "kimi appears in weekly");
assert.equal(kimiWeek.tokens, 300, "weekly sums the Omarchy-recorded days");

// ------------------------------------------------------------------ run two
r = run();
assert.equal(r.status, 0, `second collect.mjs failed:\n${r.stderr}\n${r.stdout}`);
const data2 = readData();
const series2 = kimiHistory(data2);
assert.equal(tokensOn(series2, tenDaysAgo), 1500, "second run must not double-count the backfill");
assert.equal(tokensOn(series2, today), 200, "second run must not double-count today");
assert.equal(tokensOn(series2, yesterday), 100);
assert.equal(readHistory().days[tenDaysAgo]?.kimi?.tokens, 1500, "history.json stable across runs");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("history-wiring: all tests passed");
