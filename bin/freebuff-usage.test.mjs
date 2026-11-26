import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFreebuffUsage } from "./freebuff-usage.mjs";

const now = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime(); })();
const iso = (ms) => new Date(ms).toISOString();
const hoursAgo = (h) => now - h * 3600 * 1000;
const daysAgo = (d, hour = 10) => { const t = new Date(now); t.setDate(t.getDate() - d); t.setHours(hour, 0, 0, 0); return t.getTime(); };

// Real run-state shape: counters nested at
// sessionState.mainAgentState.{creditsUsed,directCreditsUsed,
// contextTokenCount,lastActivityAt}. creditsUsed and directCreditsUsed are
// incremented together upstream, so creditsUsed is the total.
const nested = (agent) => ({ sessionState: { mainAgentState: agent } });

// Fixture home with BOTH real layouts:
//   ~/.config/manicode/chats/<ts>/run-state.json            (primary)
//   ~/.config/manicode/projects/<project>/chats/<ts>/...    (also seen)
const home = fs.mkdtempSync(path.join(os.tmpdir(), "freebuff-home-"));
const manicode = path.join(home, ".config", "manicode");
const directChats = path.join(manicode, "chats");
const projectChats = path.join(manicode, "projects", "proj-a", "chats");
const mkChat = (root, name, runState, meta) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "run-state.json"), JSON.stringify(runState));
  if (meta !== undefined) fs.writeFileSync(path.join(dir, "chat-meta.json"), JSON.stringify(meta));
};

// Direct layout.
// Chat 1: today, all nested metrics; directCreditsUsed equals creditsUsed
// upstream and must NOT be added on top.
mkChat(directChats, "2026-11-25T08-00-00.000Z", nested({
  creditsUsed: 1.5, directCreditsUsed: 1.5, contextTokenCount: 12000,
  lastActivityAt: hoursAgo(2),
}));
// Chat 2: nested metrics but no lastActivityAt -> file mtime (today).
mkChat(directChats, "2026-11-25T09-00-00.000Z", nested({
  creditsUsed: 1, contextTokenCount: 700,
}));
// Chat 3: empty object -> still a chat, contributes nothing (mtime = today).
mkChat(directChats, "2026-11-25T09-30-00.000Z", {});
// Chat 4: corrupt run-state -> skipped entirely.
const badDir = path.join(directChats, "2026-11-25T09-45-00.000Z");
fs.mkdirSync(badDir, { recursive: true });
fs.writeFileSync(path.join(badDir, "run-state.json"), "{ not json");
// Chat 5: old top-level shape (fallback) — yesterday, total only.
mkChat(directChats, "2026-11-24T15-00-00.000Z", {
  creditsUsed: 2, contextTokenCount: 50000, updatedAt: iso(daysAgo(1)),
});

// Projects layout.
// Chat 6: 20 h ago — inside last24h, before midnight.
mkChat(projectChats, "2026-11-24T20-00-00.000Z", nested({
  creditsUsed: 0.5, directCreditsUsed: 0.5, contextTokenCount: 3000,
  lastActivityAt: hoursAgo(20),
}));
// Chat 7: same timestamp folder name as chat 1 -> deduped, the direct
// chats/ copy wins and this 99-credit copy is ignored.
mkChat(projectChats, "2026-11-25T08-00-00.000Z", nested({
  creditsUsed: 99, directCreditsUsed: 99, contextTokenCount: 999999,
  lastActivityAt: hoursAgo(1),
}));
// Chat 8: only directCreditsUsed nested -> used when creditsUsed absent.
mkChat(projectChats, "2026-11-25T10-30-00.000Z", nested({
  directCreditsUsed: 0.25, contextTokenCount: 42, lastActivityAt: hoursAgo(1),
}), { title: "hi", lastMessageAt: iso(hoursAgo(1)) });
// Chat 9: tokens only, no credits, no time -> mtime (today).
mkChat(projectChats, "2026-11-25T11-00-00.000Z", nested({ contextTokenCount: 8 }));

const result = readFreebuffUsage({ home, now });
assert.equal(result.agent, "freebuff");
assert.equal(result.available, true);

// total: 7 chats (corrupt skipped, duplicate timestamp deduped).
// credits: 1.5+1+2+0.5+0.25 = 5.25 (chat 7's 99 not counted).
// tokens: 12000+700+50000+3000+42+8 = 65750 (chat 3 has none, chat 7's
// 999999 not counted).
assert.equal(result.total.chats, 7);
assert.equal(result.total.credits, 5.25);
assert.equal(result.total.tokens, 65750);

// today: chats 1, 2, 3, 8, 9 (mtime/lastActivityAt today). Chats 5 (yesterday)
// and 6 (yesterday 16:00) predate midnight.
assert.equal(result.today.chats, 5);
assert.equal(result.today.credits, 2.75);
assert.equal(result.today.tokens, 12750);

// last24h: today chats + chat 6 (20 h ago); chat 5 is >24 h.
assert.equal(result.last24h.chats, 6);
assert.equal(result.last24h.credits, 3.25);
assert.equal(result.last24h.tokens, 15750);

assert.deepEqual(result.limits, []);
assert.match(result.note, /cloud-only/);

// A file that does hold limits (nested in mainAgentState) surfaces them.
const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "freebuff-home2-"));
mkChat(path.join(home2, ".config", "manicode", "chats"), "c1", nested({
  creditsUsed: 1, rateLimits: { session: 80 },
}));
const r2 = readFreebuffUsage({ home: home2, now });
assert.deepEqual(r2.limits, [{ session: 80 }]);
assert.match(r2.note, /local files/);

// Missing store -> honest unavailable.
const empty = fs.mkdtempSync(path.join(os.tmpdir(), "freebuff-empty-"));
const r3 = readFreebuffUsage({ home: empty, now });
assert.equal(r3.available, false);
assert.equal(r3.status, "local data not available");

// Store exists but no parseable run-state -> still unavailable.
const home3 = fs.mkdtempSync(path.join(os.tmpdir(), "freebuff-home3-"));
mkChat(path.join(home3, ".config", "manicode", "chats"), "c1", "junk");
const r4 = readFreebuffUsage({ home: home3, now });
assert.equal(r4.available, false);

// Only credits, no tokens: tokens key must be absent, not zeroed.
const home4 = fs.mkdtempSync(path.join(os.tmpdir(), "freebuff-home4-"));
mkChat(path.join(home4, ".config", "manicode", "projects", "p", "chats"), "c1", nested({
  creditsUsed: 3,
}));
const r5 = readFreebuffUsage({ home: home4, now });
assert.equal(r5.total.credits, 3);
assert.equal("tokens" in r5.total, false);
assert.equal(r5.total.chats, 1);

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(home2, { recursive: true, force: true });
fs.rmSync(home3, { recursive: true, force: true });
fs.rmSync(home4, { recursive: true, force: true });
fs.rmSync(empty, { recursive: true, force: true });
console.log("freebuff-usage ok");
