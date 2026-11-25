import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFreebuffUsage } from "./freebuff-usage.mjs";

const now = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime(); })();
const todayStart = (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); })();
const iso = (ms) => new Date(ms).toISOString();
const hoursAgo = (h) => now - h * 3600 * 1000;
const daysAgo = (d, hour = 10) => { const t = new Date(now); t.setDate(t.getDate() - d); t.setHours(hour, 0, 0, 0); return t.getTime(); };

// Fixture home: ~/.config/manicode/projects/<project>/chats/<ts>/{run-state,chat-meta}.json
const home = fs.mkdtempSync(path.join(os.tmpdir(), "freebuff-home-"));
const chatsRoot = path.join(home, ".config", "manicode", "projects", "proj-a", "chats");
const mkChat = (name, runState, meta) => {
  const dir = path.join(chatsRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "run-state.json"), JSON.stringify(runState));
  if (meta !== undefined) fs.writeFileSync(path.join(dir, "chat-meta.json"), JSON.stringify(meta));
};

// Chat 1: today, both metrics, explicit updatedAt.
mkChat("c-today", { creditsUsed: 1.5, contextTokenCount: 12000, updatedAt: iso(hoursAgo(2)) });
// Chat 2: within 24 h but before midnight, epoch-seconds timestamp.
mkChat("c-24h", { creditsUsed: 0.5, contextTokenCount: 3000, updatedAt: Math.floor(hoursAgo(20) / 1000) });
// Chat 3: yesterday — total only.
mkChat("c-old", { creditsUsed: 2, contextTokenCount: 50000, updatedAt: iso(daysAgo(1)) });
// Chat 4: no timestamp fields at all -> falls back to file mtime (today, since just written).
mkChat("c-mtime", { creditsUsed: 1, contextTokenCount: 700 });
// Chat 5: corrupt run-state -> skipped entirely.
const badDir = path.join(chatsRoot, "c-bad");
fs.mkdirSync(badDir, { recursive: true });
fs.writeFileSync(path.join(badDir, "run-state.json"), "{ not json");
// Chat 6: run-state with only tokens -> credits stays absent for it.
mkChat("c-tokens-only", { contextTokenCount: 42, createdAt: iso(hoursAgo(1)) }, { title: "hi", lastMessageAt: iso(hoursAgo(1)) });
// Chat 7: empty object -> still a chat, contributes nothing.
mkChat("c-empty", {});

const result = readFreebuffUsage({ home, now });
assert.equal(result.agent, "freebuff");
assert.equal(result.available, true);

// total: 6 valid run-state files (bad one skipped). credits: 1.5+0.5+2+1 = 5
// (c-tokens-only and c-empty have none). tokens: 12000+3000+50000+700+42 = 65742.
assert.equal(result.total.chats, 6);
assert.equal(result.total.credits, 5);
assert.equal(result.total.tokens, 65742);

// today: c-today (2h ago) + c-mtime and c-empty (file mtime = real now,
// after midnight) + c-tokens-only (1h ago). c-24h/c-old predate midnight.
assert.equal(result.today.chats, 4);
assert.equal(result.today.credits, 2.5);
assert.equal(result.today.tokens, 12000 + 700 + 42);

// last24h: c-today, c-24h (20h ago), c-mtime, c-tokens-only, c-empty;
// c-old is >24h.
assert.equal(result.last24h.chats, 5);
assert.equal(result.last24h.credits, 3);
assert.equal(result.last24h.tokens, 12000 + 3000 + 700 + 42);

assert.deepEqual(result.limits, []);
assert.match(result.note, /cloud-only/);

// A file that does hold limits surfaces them and changes the note.
const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "freebuff-home2-"));
const dir2 = path.join(home2, ".config", "manicode", "projects", "p", "chats", "c1");
fs.mkdirSync(dir2, { recursive: true });
fs.writeFileSync(path.join(dir2, "run-state.json"), JSON.stringify({ creditsUsed: 1, rateLimits: { session: 80 } }));
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
const dir3 = path.join(home3, ".config", "manicode", "projects", "p", "chats", "c1");
fs.mkdirSync(dir3, { recursive: true });
fs.writeFileSync(path.join(dir3, "run-state.json"), "junk");
const r4 = readFreebuffUsage({ home: home3, now });
assert.equal(r4.available, false);

// Only credits, no tokens: tokens key must be absent, not zeroed.
const home4 = fs.mkdtempSync(path.join(os.tmpdir(), "freebuff-home4-"));
const dir4 = path.join(home4, ".config", "manicode", "projects", "p", "chats", "c1");
fs.mkdirSync(dir4, { recursive: true });
fs.writeFileSync(path.join(dir4, "run-state.json"), JSON.stringify({ creditsUsed: 3 }));
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
