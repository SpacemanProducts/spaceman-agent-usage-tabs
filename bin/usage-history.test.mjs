import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadHistory, saveHistory, recordDay, agentSeries, localDate, KEEP_DAYS } from "./usage-history.mjs";

// Fixed "now": local noon, so localDate is unambiguous in any timezone.
const NOW = new Date(2026, 10, 24, 12, 0, 0).getTime();
const TODAY = localDate(NOW);
const shift = (dateStr, days) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
};

const AGENT = (over = {}) => ({
  id: "claude", installed: true, hasTokens: true, today: 1000,
  days: [{ date: TODAY, tokens: 1000 }],
  limits: [{ title: "Session", percent: 0.5 }, { title: "Weekly", percent: null }],
  ...over,
});

// ---- localDate is the local calendar date
assert.equal(localDate(new Date(2026, 0, 5, 23, 59).getTime()), "2026-01-05");
assert.equal(TODAY, "2026-11-24");

// ---- a fresh record: today's tokens, peaks for finite percents only, resets
{
  const h = recordDay(loadHistory("/nonexistent/history.json"), [AGENT()], NOW, { claude: 2 });
  const rec = h.days[TODAY].claude;
  assert.equal(rec.tokens, 1000);
  assert.deepEqual(rec.peaks, { Session: 0.5 });
  assert.equal(rec.resets, 2);
}

// ---- recordDay does not mutate its input
{
  const before = { schemaVersion: 1, days: { [TODAY]: { claude: { tokens: 5, peaks: { Session: 0.1 }, resets: 1 } } } };
  const snapshot = JSON.stringify(before);
  const after = recordDay(before, [AGENT()], NOW, { claude: 3 });
  assert.equal(JSON.stringify(before), snapshot, "input history untouched");
  assert.equal(after.days[TODAY].claude.tokens, 1000);
  assert.equal(after.days[TODAY].claude.resets, 4, "resets accumulate on top of existing");
  assert.equal(after.days[TODAY].claude.peaks.Session, 0.5, "peak is the max");
}

// ---- peaks keep the max across runs; a lower reading never lowers them
{
  let h = recordDay(loadHistory("/nonexistent/x"), [AGENT({ limits: [{ title: "Session", percent: 0.9 }] })], NOW);
  h = recordDay(h, [AGENT({ limits: [{ title: "Session", percent: 0.4 }, { title: "Weekly", percent: 0.7 }] })], NOW);
  const peaks = h.days[TODAY].claude.peaks;
  assert.equal(peaks.Session, 0.9);
  assert.equal(peaks.Weekly, 0.7);
}

// ---- null tokens vs a real 0: no source -> null, a reported 0 stays 0
{
  const noTokens = AGENT({ id: "grok", hasTokens: false, today: 0, days: [{ date: TODAY, tokens: 0 }] });
  const h = recordDay(loadHistory("/nonexistent/x"), [noTokens], NOW);
  assert.equal(h.days[TODAY].grok.tokens, null, "hasTokens false: nothing invented, not even 0");
  const zero = recordDay(loadHistory("/nonexistent/x"), [AGENT({ today: 0, days: [{ date: TODAY, tokens: 0 }] })], NOW);
  assert.equal(zero.days[TODAY].claude.tokens, 0, "a reported 0 is kept as 0");
}

// ---- hasTokens false keeps an existing token count for today
{
  const h0 = recordDay(loadHistory("/nonexistent/x"), [AGENT()], NOW);
  const h1 = recordDay(h0, [AGENT({ hasTokens: false, today: 0, days: [] })], NOW);
  assert.equal(h1.days[TODAY].claude.tokens, 1000, "today keeps the last reported value");
}

// ---- agent.days entries land on their own dates; uninstalled agents are skipped
{
  const past = shift(TODAY, -2);
  const agents = [
    AGENT({ days: [{ date: past, tokens: 500 }, { date: TODAY, tokens: 1000 }] }),
    AGENT({ id: "codex", installed: false, days: [{ date: TODAY, tokens: 999 }] }),
  ];
  const h = recordDay(loadHistory("/nonexistent/x"), agents, NOW);
  assert.equal(h.days[past].claude.tokens, 500);
  assert.equal(h.days[TODAY].claude.tokens, 1000);
  assert.equal(h.days[TODAY].codex, undefined, "installed:false never recorded");
  // peaks/resets only apply to today, not to past day entries
  assert.deepEqual(h.days[past].claude.peaks, {});
}

// ---- pruning: only the 30 most recent days up to today survive
{
  const old = shift(TODAY, -KEEP_DAYS);       // 31 days ago: dropped
  const edge = shift(TODAY, -(KEEP_DAYS - 1)); // 30 days ago: kept
  const future = shift(TODAY, 3);              // future: dropped
  const h0 = {
    schemaVersion: 1,
    days: {
      [old]: { claude: { tokens: 1, peaks: {}, resets: 0 } },
      [edge]: { claude: { tokens: 2, peaks: {}, resets: 0 } },
      [future]: { claude: { tokens: 3, peaks: {}, resets: 0 } },
    },
  };
  const h = recordDay(h0, [AGENT()], NOW);
  assert.equal(h.days[old], undefined, "older than 30 days dropped");
  assert.equal(h.days[future], undefined, "future dates dropped");
  assert.equal(h.days[edge].claude.tokens, 2, "the 30th day back is kept");
  assert.deepEqual(Object.keys(h.days).sort(), [TODAY, edge].sort(), "only in-window recorded days remain");
}

// ---- 35 recorded days collapse to the 30 most recent
{
  const days = [];
  for (let i = 34; i >= 0; i--) days.push({ date: shift(TODAY, -i), tokens: i });
  const h = recordDay(loadHistory("/nonexistent/x"), [AGENT({ days })], NOW);
  const dates = Object.keys(h.days).sort();
  assert.equal(dates.length, KEEP_DAYS);
  assert.equal(dates[0], shift(TODAY, -(KEEP_DAYS - 1)), "oldest kept is 29 days ago");
  assert.equal(h.days[shift(TODAY, -34)], undefined, "the 5 oldest are pruned");
}

// ---- agentSeries: exactly n entries, oldest first, ending today
{
  const h = recordDay(loadHistory("/nonexistent/x"), [AGENT()], NOW, { claude: 1 });
  const s = agentSeries(h, "claude", NOW, 5);
  assert.equal(s.length, 5);
  assert.equal(s[4].date, TODAY);
  assert.equal(s[0].date, shift(TODAY, -4));
  assert.equal(s[4].tokens, 1000);
  assert.equal(s[4].resets, 1);
  assert.deepEqual(s[0].peaks, {});
  assert.equal(s[0].tokens, null, "no record -> null, not 0");
  const def = agentSeries(h, "claude", NOW);
  assert.equal(def.length, KEEP_DAYS);
  assert.equal(def[KEEP_DAYS - 1].date, TODAY);
}

// ---- corrupt / missing file -> empty history
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-history-"));
  const missing = path.join(dir, "nope.json");
  assert.deepEqual(loadHistory(missing), { schemaVersion: 1, days: {} });
  for (const bad of ["not json", "{}", "[]", '{"schemaVersion":2,"days":{}}', '{"schemaVersion":1,"days":[]}']) {
    const f = path.join(dir, `bad-${Math.random()}.json`);
    fs.writeFileSync(f, bad);
    assert.deepEqual(loadHistory(f), { schemaVersion: 1, days: {} }, `corrupt: ${bad}`);
  }
  // a valid file loads back
  const good = path.join(dir, "history.json");
  const h = recordDay(loadHistory(good), [AGENT()], NOW, { claude: 1 });
  saveHistory(good, h);
  assert.deepEqual(loadHistory(good), h, "save/load roundtrip");
  assert.equal((fs.statSync(good).mode & 0o777), 0o600, "owner-only permissions");
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("usage-history: all tests passed");
