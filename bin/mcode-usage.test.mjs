import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMcodeUsage, mcodeUsageFromSessions, addMcodeMessages, messageTokens, localDay } from "./mcode-usage.mjs";

// now is local noon on 2026-11-24: the 30-day window is 2026-10-26..24 and the
// 7-day model window is 2026-11-18..24.
const now = new Date(2026, 10, 24, 12, 0, 0).getTime();
const day = (offset) => {
  const d = new Date(2026, 10, 24 - offset, 9, 0, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const at = (offset) => new Date(2026, 10, 24 - offset, 9, 0, 0);
const iso = (offset) => at(offset).toISOString();

// Lines shaped like MiniMax Code's messages.jsonl (fields trimmed).
const line = (o) => JSON.stringify(o);
const asst = (timestamp, model, usage, extra = {}) =>
  line({ timestamp, message: { role: "assistant", model, provider: "minimax", usage, ...extra } });

const text = [
  line({ timestamp: at(1).getTime(), message: { role: "user", content: "hi" } }),
  asst(at(1).getTime(), "MiniMax-M2", { input: 100, output: 20, cacheRead: 50, cacheWrite: 10 }), // 180
  asst(iso(1), "MiniMax-M2", { input: 30, output: 10 }),                                          // 40, ISO stamp
  asst(iso(3), "MiniMax-M2", { input: 7, output: 3 }),                                            // 10
  asst(iso(10), "old-model", { input: 999, output: 1 }),                                          // 1000: in 30d, out of 7d models
  asst(iso(40), "ancient-model", { input: 5, output: 5 }),                                        // outside the window entirely
  asst(iso(1), "MiniMax-M2", null),                                                               // no usage: skipped
  asst(iso(1), "MiniMax-M2", { input: 0, output: 0 }),                                            // all zero: skipped
  line({ timestamp: at(2).getTime(), message: { role: "assistant", usage: { totalTokens: 55 } } }), // no model -> "unknown"
  line({ timestamp: "not-a-time", message: { role: "assistant", model: "bad", usage: { input: 1 } } }), // untrusted stamp: skipped
  "this is not json",
  "",
].join("\n");

// Unit checks on the pure pieces.
assert.equal(messageTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }), 10);
assert.equal(messageTokens({ totalTokens: 42 }), 42);
assert.equal(messageTokens(null), 0);
assert.equal(messageTokens({ input: "5", output: 1 }), 1); // strings are untrusted
assert.equal(localDay(at(0).getTime(), now), day(0));
assert.equal(localDay(iso(0), now), day(0));
assert.equal(localDay("1764000000000", now), localDay(1764000000000, now)); // digit string = ms epoch
assert.equal(localDay("not-a-time", now), null);
assert.equal(localDay(-5, now), null);
assert.equal(localDay(true, now), null);
assert.equal(localDay(null, now), day(0)); // no stamp books today, like Omarchy

// Pure parser: days and 7-day models.
{
  const acc = { days: {}, models: {} };
  addMcodeMessages(text, acc, now);
  assert.equal(acc.days[day(1)], 220); // 180 + 40
  assert.equal(acc.days[day(2)], 55);
  assert.equal(acc.days[day(3)], 10);
  assert.equal(acc.days[day(10)], 1000);
  assert.equal(acc.days[day(40)], 10); // counted, then windowed out below
  assert.deepEqual(acc.models, { "MiniMax-M2": 230, unknown: 55 });
}

// From disk: a realistic store in a fake home.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-usage-"));
const sessions = path.join(home, ".minimax", "v2", "sessions");
fs.mkdirSync(path.join(sessions, "sess-a"), { recursive: true });
fs.mkdirSync(path.join(sessions, "sess-b", "nested"), { recursive: true });
fs.writeFileSync(path.join(sessions, "sess-a", "messages.jsonl"), text);
fs.writeFileSync(path.join(sessions, "sess-b", "nested", "messages.jsonl"), asst(iso(0), "MiniMax-M2", { input: 5, output: 5 }) + "\n");

{
  const r = readMcodeUsage({ home, env: {}, now });
  assert.ok(r);
  assert.equal(r.days.length, 30);
  assert.equal(r.days[0].date, day(29));
  assert.equal(r.days[29].date, day(0));
  const byDate = Object.fromEntries(r.days.map((d) => [d.date, d.tokens]));
  assert.equal(byDate[day(1)], 220);
  assert.equal(byDate[day(0)], 10);
  assert.equal(byDate[day(10)], 1000);
  assert.equal(Object.values(byDate).reduce((a, b) => a + b, 0), 220 + 55 + 10 + 1000 + 10);
  assert.deepEqual(r.models, { "MiniMax-M2": 240, unknown: 55 }); // day(0)'s +10 joins the week
  assert.deepEqual(r.limits, []);
}

// Env override beats the default home dir.
{
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-env-"));
  const s2 = path.join(other, "custom", "v2", "sessions", "s");
  fs.mkdirSync(s2, { recursive: true });
  fs.writeFileSync(path.join(s2, "messages.jsonl"), asst(iso(0), "m", { input: 3, output: 2 }));
  const r = readMcodeUsage({ home, env: { MINIMAX_DATA_DIR: path.join(other, "custom") }, now });
  assert.equal(r.days[29].tokens, 5);
  assert.deepEqual(r.models, { m: 5 });
  fs.rmSync(other, { recursive: true, force: true });
}

// Missing store -> null; present-but-empty -> zeros, not null.
{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-none-"));
  assert.equal(readMcodeUsage({ home: empty, env: {}, now }), null);
  const bare = path.join(empty, ".minimax", "v2", "sessions");
  fs.mkdirSync(bare, { recursive: true });
  const r = readMcodeUsage({ home: empty, env: {}, now });
  assert.ok(r);
  assert.equal(r.days.length, 30);
  assert.ok(r.days.every((d) => d.tokens === 0));
  assert.deepEqual(r.models, {});
  fs.rmSync(empty, { recursive: true, force: true });
}

// Corrupt file -> skipped without throwing; unreadable lines lose only themselves.
{
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-bad-"));
  const s = path.join(bad, "v2", "sessions", "s");
  fs.mkdirSync(s, { recursive: true });
  fs.writeFileSync(path.join(s, "messages.jsonl"), "{\"message\": {\"role\":\"assistant\",\"usage\":{\"input\":9}}\n\"broken\n" + asst(iso(0), "m", { input: 1, output: 1 }));
  const r = mcodeUsageFromSessions(path.join(bad, "v2", "sessions"), now);
  assert.ok(r);
  assert.equal(r.days[29].tokens, 2);
  fs.rmSync(bad, { recursive: true, force: true });
}

fs.rmSync(home, { recursive: true, force: true });
console.log("mcode-usage ok");
