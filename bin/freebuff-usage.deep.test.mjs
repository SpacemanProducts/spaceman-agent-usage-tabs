// Deep edge-case pass for bin/freebuff-usage.mjs on top of
// freebuff-usage.test.mjs. The shallow test already covers the happy paths
// (both layouts, nested-vs-top-level fields, dedup by timestamp name, the
// unavailable shapes). This file goes after what it does not: wrong JSON
// types, invalid field values, time-source precedence and parsing forms,
// bucket boundaries, the unreachable-in-practice chat-meta time fallback
// (reached here by making statSync fail, the delete-between-read-and-stat
// race the fallback exists for), limits quirks, and statelessness.
// Everything lives under one mkdtemp root; HOME/XDG_* are pointed inside it
// for the duration (the module takes `home` explicitly and os.homedir()
// honours $HOME, so even the default-argument calls stay in the sandbox).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFreebuffUsage } from "./freebuff-usage.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "freebuff-usage-deep-"));
const savedEnv = {};
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  savedEnv[k] = process.env[k];
  process.env[k] = path.join(tmp, k.toLowerCase());
  fs.mkdirSync(process.env[k], { recursive: true });
}

const now = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime(); })();
const iso = (ms) => new Date(ms).toISOString();
const hoursAgo = (h) => now - h * 3600 * 1000;
const daysAgo = (d, hour = 10) => { const t = new Date(now); t.setDate(t.getDate() - d); t.setHours(hour, 0, 0, 0); return t.getTime(); };
const midnight = (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); })();
const DAY = 24 * 3600 * 1000;

const nested = (agent) => ({ sessionState: { mainAgentState: agent } });

// One scratch home per scenario group; chats go under
// <home>/.config/manicode/... exactly like the real store.
const mkHome = () => {
  const home = fs.mkdtempSync(path.join(tmp, "home-"));
  return { home, manicode: path.join(home, ".config", "manicode") };
};
const chatsRoot = (manicode, ...segs) => path.join(manicode, ...segs, "chats");

// run/meta: undefined -> file absent; string -> written verbatim (so a JSON
// document like "[1,2]" or "{ not json" or raw "1e999" can be planted);
// anything else -> JSON.stringify'd. meta === null writes the JSON literal
// null (a parseable non-object), distinct from undefined (absent).
const mkChat = (root, name, run, meta) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const put = (file, v) => {
    if (v === undefined) return;
    fs.writeFileSync(file, typeof v === "string" ? v : JSON.stringify(v));
  };
  put(path.join(dir, "run-state.json"), run);
  put(path.join(dir, "chat-meta.json"), meta);
};

try {
  // ---- structural edge cases: nothing parseable -> unavailable ----
  {
    // .config/manicode exists but is a regular file, not a directory.
    const { home, manicode } = mkHome();
    fs.mkdirSync(path.dirname(manicode), { recursive: true });
    fs.writeFileSync(manicode, "i am a file");
    const r = readFreebuffUsage({ home, now });
    assert.equal(r.available, false);
    assert.equal(r.status, "local data not available");
  }
  {
    // chats/ exists but is empty and projects/ is absent entirely.
    const { home, manicode } = mkHome();
    fs.mkdirSync(chatsRoot(manicode), { recursive: true });
    const r = readFreebuffUsage({ home, now });
    assert.equal(r.available, false);
  }
  {
    // A chat dir with only chat-meta.json (no run-state.json) reports nothing.
    const { home, manicode } = mkHome();
    mkChat(chatsRoot(manicode), "c1", undefined, { title: "meta only" });
    const r = readFreebuffUsage({ home, now });
    assert.equal(r.available, false);
  }
  {
    // run-state.json that is a directory, not a file.
    const { home, manicode } = mkHome();
    const dir = path.join(chatsRoot(manicode), "c1");
    fs.mkdirSync(path.join(dir, "run-state.json"), { recursive: true });
    const r = readFreebuffUsage({ home, now });
    assert.equal(r.available, false);
  }
  {
    // run-state.json holding invalid UTF-8 bytes.
    const { home, manicode } = mkHome();
    const dir = path.join(chatsRoot(manicode), "c1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "run-state.json"), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    const r = readFreebuffUsage({ home, now });
    assert.equal(r.available, false);
  }
  {
    // Valid JSON that is not an object (null/true/number/string/array) parses
    // fine but obj() rejects it: every one of these chats is skipped.
    const { home, manicode } = mkHome();
    const root = chatsRoot(manicode);
    for (const [i, doc] of ["null", "true", "42", '"just a string"', "[1,2,3]", ""].entries()) {
      mkChat(root, `c${i}`, doc);
    }
    const r = readFreebuffUsage({ home, now });
    assert.equal(r.available, false);
  }
  {
    // projects/ being a regular file must not break the direct chats/ scan.
    const { home, manicode } = mkHome();
    fs.mkdirSync(path.dirname(path.join(manicode, "projects")), { recursive: true });
    fs.writeFileSync(path.join(manicode, "projects"), "not a dir");
    mkChat(chatsRoot(manicode), "c1", nested({ creditsUsed: 2, lastActivityAt: hoursAgo(1) }));
    const r = readFreebuffUsage({ home, now });
    assert.equal(r.available, true);
    assert.equal(r.total.chats, 1);
    assert.equal(r.total.credits, 2);
  }

  // ---- field validation: num() rejects non-finite/negative/wrong types ----
  {
    const { home, manicode } = mkHome();
    const root = chatsRoot(manicode);
    // Nested creditsUsed invalid (-1) falls through to directCreditsUsed;
    // the valid nested value wins over a different top-level creditsUsed.
    mkChat(root, "a", {
      ...nested({ creditsUsed: -1, directCreditsUsed: 2.5, lastActivityAt: hoursAgo(1) }),
      creditsUsed: 7,
    });
    // Nested credit keys all invalid (string) -> top-level fallback, where
    // creditsUsed still beats credits in CREDIT_KEYS order.
    mkChat(root, "b", {
      sessionState: { mainAgentState: { creditsUsed: "9", contextTokenCount: "x" } },
      creditsUsed: 8, credits: 3, lastActivityAt: hoursAgo(1),
    });
    // Raw 1e999 parses to Infinity: num() rejects it, next key wins.
    mkChat(root, "c", '{"creditsUsed":1e999,"credits":4,"updatedAt":"' + iso(hoursAgo(1)) + '"}');
    // Zero is a real reported value, not "missing".
    mkChat(root, "d", nested({ creditsUsed: 0, contextTokenCount: 0, lastActivityAt: hoursAgo(1) }));
    // sessionState/mainAgentState of the wrong type -> top-level fallback.
    mkChat(root, "e", { sessionState: "nope", creditsUsed: 5, tokensUsed: 50, updatedAt: iso(hoursAgo(1)) });
    mkChat(root, "f", { sessionState: { mainAgentState: [1, 2] }, credits: 6, updatedAt: iso(hoursAgo(1)) });
    const r = readFreebuffUsage({ home, now });
    // a=2.5 (nested directCreditsUsed; top-level 7 ignored), b=8, c=4, d=0,
    // e=5, f=6 -> 25.5; tokens: e=50 only (d's 0 is reported but adds 0; f has
    // no token key) -> tokens key present with value 50.
    assert.equal(r.total.chats, 6);
    assert.equal(r.total.credits, 25.5);
    assert.equal(r.total.tokens, 50);
    assert.equal(r.today.chats, 6);
  }
  {
    // Token key order: contextTokenCount invalid -> tokensUsed -> totalTokens.
    const { home, manicode } = mkHome();
    const root = chatsRoot(manicode);
    mkChat(root, "a", { contextTokenCount: -3, tokensUsed: 11, updatedAt: iso(hoursAgo(1)) });
    mkChat(root, "b", { contextTokenCount: "lots", totalTokens: 22, updatedAt: iso(hoursAgo(1)) });
    const r = readFreebuffUsage({ home, now });
    assert.equal(r.total.tokens, 33);
  }

  // ---- time sources: precedence, parsing forms, bucket boundaries ----
  {
    const { home, manicode } = mkHome();
    const root = chatsRoot(manicode);
    // agent.lastActivityAt beats every run/meta field.
    mkChat(root, "a", {
      ...nested({ creditsUsed: 1, lastActivityAt: hoursAgo(1) }),
      updatedAt: iso(daysAgo(5)),
    }, { lastMessageAt: iso(hoursAgo(0.5)) });
    // Within run-state, TIME_KEYS order decides: updatedAt is checked before
    // createdAt even though createdAt is the fresher value here.
    mkChat(root, "b", { creditsUsed: 1, createdAt: iso(hoursAgo(1)), updatedAt: iso(daysAgo(3)) });
    const r = readFreebuffUsage({ home, now });
    assert.equal(r.total.chats, 2);
    assert.equal(r.today.chats, 1, "only chat a is today; b's updatedAt is 3 days old");
    assert.equal(r.last24h.chats, 1);
    assert.equal(r.today.credits, 1);
  }
  {
    // Every timeMs() input form: epoch seconds, epoch ms, digit strings of
    // both, ISO strings; plus invalid forms that must fall through.
    const { home, manicode } = mkHome();
    const root = chatsRoot(manicode);
    const sec = Math.floor(hoursAgo(1) / 1000);
    const forms = [
      nested({ creditsUsed: 1, lastActivityAt: sec }),          // epoch seconds number
      nested({ creditsUsed: 1, lastActivityAt: hoursAgo(1) }),  // epoch ms number
      nested({ creditsUsed: 1, lastActivityAt: String(sec) }),  // digit string, seconds
      nested({ creditsUsed: 1, lastActivityAt: String(hoursAgo(1)) }), // digit string, ms
      nested({ creditsUsed: 1, lastActivityAt: iso(hoursAgo(1)) }),    // ISO
    ];
    forms.forEach((run, i) => mkChat(root, `f${i}`, run));
    // g: invalid lastActivityAt falls through to the run-level updatedAt.
    mkChat(root, "g", {
      sessionState: { mainAgentState: { creditsUsed: 1, lastActivityAt: "not a time" } },
      updatedAt: iso(hoursAgo(2)),
    });
    // h: boolean lastActivityAt is rejected; lastActiveAt is next in TIME_KEYS.
    mkChat(root, "h", {
      sessionState: { mainAgentState: { creditsUsed: 1, lastActivityAt: true } },
      lastActiveAt: iso(hoursAgo(3)),
    });
    const r = readFreebuffUsage({ home, now });
    assert.equal(r.total.chats, 7);
    assert.equal(r.today.chats, 7, "every form resolves to a recent time");
    assert.equal(r.today.credits, 7);
  }
  {
    // Out-of-range times are rejected: a 1999 ISO string and a 2200 one both
    // fail the 2000..2100 year check, so the chat falls back to file mtime
    // (today, since the file was just written) — still today, but via mtime.
    const { home, manicode } = mkHome();
    const root = chatsRoot(manicode);
    mkChat(root, "old", nested({ creditsUsed: 1, lastActivityAt: "1999-06-01T00:00:00Z" }));
    mkChat(root, "far", nested({ creditsUsed: 1, lastActivityAt: "2200-01-01T00:00:00Z" }));
    const r = readFreebuffUsage({ home, now });
    assert.equal(r.total.chats, 2);
    assert.equal(r.today.chats, 2, "rejected times fall back to run-state mtime (today)");
  }
  {
    // Bucket boundaries, all measured against local midnight / now-24h.
    const { home, manicode } = mkHome();
    const root = chatsRoot(manicode);
    mkChat(root, "atMidnight", nested({ creditsUsed: 1, lastActivityAt: midnight }));       // == todayStart -> today
    mkChat(root, "beforeMidnight", nested({ creditsUsed: 1, lastActivityAt: midnight - 1 })); // yesterday 23:59:59.999 -> last24h only
    mkChat(root, "atDayAgo", nested({ creditsUsed: 1, lastActivityAt: now - DAY }));          // == now-24h -> last24h (boundary is inclusive)
    mkChat(root, "beforeDayAgo", nested({ creditsUsed: 1, lastActivityAt: now - DAY - 1 }));  // 1 ms too old -> total only
    const r = readFreebuffUsage({ home, now });
    assert.equal(r.total.chats, 4);
    assert.equal(r.total.credits, 4);
    assert.equal(r.today.chats, 1, "only the exact-midnight chat is today");
    assert.equal(r.today.credits, 1);
    assert.equal(r.last24h.chats, 3, "midnight + the two boundary chats are within 24h");
    assert.equal(r.last24h.credits, 3);
  }
  {
    // chat-meta.json times are the LAST resort: run-state mtime beats them.
    // Backdate run-state.json's mtime so the ordering is observable.
    const { home, manicode } = mkHome();
    const root = chatsRoot(manicode);
    const dir = path.join(root, "c1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "run-state.json"), JSON.stringify({ creditsUsed: 1 }));
    fs.writeFileSync(path.join(dir, "chat-meta.json"), JSON.stringify({ lastMessageAt: iso(hoursAgo(1)) }));
    const old = new Date(daysAgo(4));
    fs.utimesSync(path.join(dir, "run-state.json"), old, old);
    const r = readFreebuffUsage({ home, now });
    assert.equal(r.total.chats, 1);
    assert.equal(r.today.chats, 0, "run mtime (4 days old) beats the fresh meta timestamp");
    assert.equal(r.last24h.chats, 0);
  }
  {
    // The delete-between-read-and-stat race the meta fallback exists for:
    // make statSync fail for run-state.json so chatUsage falls through to
    // chat-meta's own timestamp, then to chat-meta's mtime.
    const { home, manicode } = mkHome();
    const root = chatsRoot(manicode);
    const dir = path.join(root, "c1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "run-state.json"), JSON.stringify({ creditsUsed: 1 }));
    fs.writeFileSync(path.join(dir, "chat-meta.json"), JSON.stringify({ lastMessageAt: iso(hoursAgo(1)) }));
    const realStat = fs.statSync;
    fs.statSync = function (p, ...a) {
      if (String(p).endsWith("run-state.json")) { const e = new Error("gone"); e.code = "ENOENT"; throw e; }
      return realStat.call(this, p, ...a);
    };
    let r;
    try {
      r = readFreebuffUsage({ home, now });
    } finally {
      fs.statSync = realStat;
    }
    assert.equal(r.total.chats, 1);
    assert.equal(r.today.chats, 1, "meta lastMessageAt reached once run mtime is unavailable");
    assert.equal(r.today.credits, 1);
  }
  {
    // Same race, but meta carries no time either and its stat fails too:
    // ms stays null — the chat counts toward total only, never today/24h.
    const { home, manicode } = mkHome();
    const root = chatsRoot(manicode);
    const dir = path.join(root, "c1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "run-state.json"), JSON.stringify({ creditsUsed: 1 }));
    fs.writeFileSync(path.join(dir, "chat-meta.json"), JSON.stringify({ title: "no time" }));
    const realStat = fs.statSync;
    fs.statSync = function (p, ...a) {
      if (String(p).endsWith(".json")) { const e = new Error("gone"); e.code = "ENOENT"; throw e; }
      return realStat.call(this, p, ...a);
    };
    let r;
    try {
      r = readFreebuffUsage({ home, now });
    } finally {
      fs.statSync = realStat;
    }
    assert.equal(r.total.chats, 1);
    assert.equal(r.total.credits, 1);
    assert.equal(r.today.chats, 0);
    assert.equal(r.last24h.chats, 0);
  }
  // BUG: a future-dated lastActivityAt is counted in BOTH today and last24h
  // — there is no upper-bound check on parsed times. A chat "active" next
  // year shows up as today's usage. The correct-behavior test is kept
  // commented out per the job rules; today the module reports
  // today.chats === 1 and last24h.chats === 1 for this fixture.
  //   const { home, manicode } = mkHome();
  //   const root = chatsRoot(manicode);
  //   mkChat(root, "fut", nested({ creditsUsed: 1, lastActivityAt: now + 365 * DAY }));
  //   const r = readFreebuffUsage({ home, now });
  //   assert.equal(r.total.chats, 1);
  //   assert.equal(r.today.chats, 0, "a future timestamp is not today's usage");
  //   assert.equal(r.last24h.chats, 0, "a future timestamp is not in the last 24h");

  // ---- dedup and layout precedence ----
  {
    // chats/<ts> is scanned before projects/<p>/chats/<ts>: the direct copy
    // wins over a same-named project copy.
    const { home, manicode } = mkHome();
    mkChat(chatsRoot(manicode), "same-ts", nested({ creditsUsed: 5, lastActivityAt: hoursAgo(1) }));
    mkChat(chatsRoot(manicode, "projects", "p"), "same-ts", nested({ creditsUsed: 50, lastActivityAt: hoursAgo(1) }));
    const r = readFreebuffUsage({ home, now });
    assert.equal(r.total.chats, 1);
    assert.equal(r.total.credits, 5);
  }
  {
    // Discrepancy (flagged, not fixed): chatDirs' comment says "the direct
    // chats/ copy wins when both parse", but projects/chats is scanned FIRST,
    // so a same-named chat under projects/chats/<ts> beats the one under
    // chats/<ts> — the opposite of the comment (and of the per-project rule
    // asserted above). The header comment calls projects/chats the layout
    // "seen on the host", so the code may be right and the comment wrong;
    // the assertion below pins the actual behavior either way.
    //   assert.equal(r.total.credits, 222); // what the chatDirs comment implies
    const { home, manicode } = mkHome();
    // projects/chats/<ts> directly (not via chatsRoot, which appends "chats").
    mkChat(path.join(manicode, "projects", "chats"), "dup", nested({ creditsUsed: 111, lastActivityAt: hoursAgo(1) }));
    mkChat(chatsRoot(manicode), "dup", nested({ creditsUsed: 222, lastActivityAt: hoursAgo(1) }));
    const r = readFreebuffUsage({ home, now });
    assert.equal(r.total.chats, 1);
    assert.equal(r.total.credits, 111, "actual: projects/chats wins over chats/");
  }
  {
    // Two different projects carrying the same timestamp folder: only one
    // survives (readdir order decides which — assert the dedup, not the
    // winner).
    const { home, manicode } = mkHome();
    mkChat(chatsRoot(manicode, "projects", "aaa"), "dup", nested({ creditsUsed: 1, lastActivityAt: hoursAgo(1) }));
    mkChat(chatsRoot(manicode, "projects", "zzz"), "dup", nested({ creditsUsed: 2, lastActivityAt: hoursAgo(1) }));
    const r = readFreebuffUsage({ home, now });
    assert.equal(r.total.chats, 1);
    assert.ok(r.total.credits === 1 || r.total.credits === 2, "one of the two copies survived");
  }
  {
    // Non-directory entries in chats/ are skipped; a symlinked chat dir is
    // skipped too (Dirent.isDirectory() is false for symlinks).
    const { home, manicode } = mkHome();
    const root = chatsRoot(manicode);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "not-a-dir"), "junk");
    const real = path.join(root, "real-target");
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, "run-state.json"), JSON.stringify(nested({ creditsUsed: 9, lastActivityAt: hoursAgo(1) })));
    fs.symlinkSync(real, path.join(root, "link-chat"), "dir");
    const r = readFreebuffUsage({ home, now });
    // Only real-target parses; not-a-dir is a file, link-chat is a symlink.
    assert.equal(r.total.chats, 1);
    assert.equal(r.total.credits, 9);
  }

  // ---- limits collection quirks ----
  {
    // Identical limits objects across chats dedup via JSON.stringify.
    const { home, manicode } = mkHome();
    const root = chatsRoot(manicode);
    mkChat(root, "a", nested({ creditsUsed: 1, rateLimits: { session: 80 }, lastActivityAt: hoursAgo(1) }));
    mkChat(root, "b", nested({ creditsUsed: 1, rateLimits: { session: 80 }, lastActivityAt: hoursAgo(2) }));
    const r = readFreebuffUsage({ home, now });
    assert.deepEqual(r.limits, [{ session: 80 }]);
    assert.match(r.note, /local files/);
  }
  {
    // Limits are collected from agent state, run state AND chat-meta, in
    // that order per chat; falsy-but-present values (0, false) are kept.
    const { home, manicode } = mkHome();
    const root = chatsRoot(manicode);
    mkChat(root, "a", {
      sessionState: { mainAgentState: { rateLimits: { agent: 1 } } },
      limits: "run-level",
      updatedAt: iso(hoursAgo(1)),
    }, { rate_limits: [1, 2] });
    mkChat(root, "b", { rateLimits: 0, updatedAt: iso(hoursAgo(1)) });
    const r = readFreebuffUsage({ home, now });
    assert.deepEqual(r.limits, [{ agent: 1 }, "run-level", [1, 2], 0]);
  }
  {
    // Dedup is by JSON.stringify, so key order matters: {a,b} and {b,a} are
    // "different" limits and both survive.
    const { home, manicode } = mkHome();
    const root = chatsRoot(manicode);
    mkChat(root, "a", { limits: { a: 1, b: 2 }, updatedAt: iso(hoursAgo(1)) });
    mkChat(root, "b", { limits: { b: 2, a: 1 }, updatedAt: iso(hoursAgo(1)) });
    const r = readFreebuffUsage({ home, now });
    assert.equal(r.limits.length, 2);
  }

  // ---- statelessness: no caching, concurrent calls share nothing ----
  {
    const { home, manicode } = mkHome();
    const root = chatsRoot(manicode);
    const file = path.join(root, "c1", "run-state.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(nested({ creditsUsed: 1, lastActivityAt: hoursAgo(1) })));
    assert.equal(readFreebuffUsage({ home, now }).total.credits, 1);
    // Rewrite the file: the next call must see the new value (no cache).
    fs.writeFileSync(file, JSON.stringify(nested({ creditsUsed: 9, lastActivityAt: hoursAgo(1) })));
    assert.equal(readFreebuffUsage({ home, now }).total.credits, 9, "second call sees the rewrite");
    // Two calls in one tick agree and leave no residue.
    const [r1, r2] = [readFreebuffUsage({ home, now }), readFreebuffUsage({ home, now })];
    assert.deepEqual(r1, r2);
    assert.equal(r1.total.credits, 9);
  }
  {
    // `now` is a parameter, not hidden state: the same files bucket
    // differently under different readings.
    const { home, manicode } = mkHome();
    const root = chatsRoot(manicode);
    mkChat(root, "c1", nested({ creditsUsed: 1, lastActivityAt: hoursAgo(30) })); // ~30 h ago
    const early = readFreebuffUsage({ home, now });
    assert.equal(early.total.chats, 1);
    assert.equal(early.today.chats, 0);
    assert.equal(early.last24h.chats, 0, "30 h ago is outside the 24 h window");
    // 6 h earlier the same chat sits exactly on the now-24h boundary
    // (inclusive), still before local midnight -> last24h only.
    const later = readFreebuffUsage({ home, now: now - 6 * 3600 * 1000 });
    assert.equal(later.last24h.chats, 1, "on the boundary the chat is inside 24 h");
    assert.equal(later.today.chats, 0);
    // BUG: a non-numeric `now` makes todayStart/dayAgo NaN, and every
    // comparison `usage.ms < NaN` is false — so EVERY dated chat is counted
    // in both today and last24h. Internal callers pass Date.now(), but the
    // parameter is not validated. Correct-behavior test kept commented out:
    //   const bad = readFreebuffUsage({ home, now: "junk" });
    //   assert.equal(bad.today.chats, 0);
    //   assert.equal(bad.last24h.chats, 0);
  }

  // ---- argument and return-shape edges ----
  {
    // The default `home` is os.homedir(), which honours the $HOME we pointed
    // at the scratch dir: still unavailable, and the real home is untouched.
    const r = readFreebuffUsage();
    assert.equal(r.available, false);
    assert.equal(r.status, "local data not available");
    // Non-object options cannot be destructured.
    assert.throws(() => readFreebuffUsage(null), TypeError);
    // A non-string home reaches path.join and throws a type error.
    assert.throws(() => readFreebuffUsage({ home: 42, now }), TypeError);
  }
  {
    // unavailable carries no usage keys at all — honest shape, no zeroed
    // buckets pretending to be data.
    const { home } = mkHome();
    const r = readFreebuffUsage({ home, now });
    for (const k of ["today", "last24h", "total", "limits", "note"]) {
      assert.equal(k in r, false, `${k} must be absent when unavailable`);
    }
    // available always carries the full shape.
    const { home: h2, manicode } = mkHome();
    mkChat(chatsRoot(manicode), "c1", nested({ creditsUsed: 1, lastActivityAt: hoursAgo(1) }));
    const r2 = readFreebuffUsage({ home: h2, now });
    for (const k of ["today", "last24h", "total", "limits", "note"]) {
      assert.ok(k in r2, `${k} present when available`);
    }
    assert.equal(typeof r2.note, "string");
  }

  console.log("freebuff-usage deep: all tests passed");
} finally {
  for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
