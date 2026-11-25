// Deep edge-case pass for bin/mcode-usage.mjs on top of mcode-usage.test.mjs.
// The module is synchronous with no shared state, so the "races" here are
// stale-state and repeat-call checks. Every file lives in a fresh mkdtemp dir
// and HOME/XDG_* are pointed there; nothing touches the real home folder.
// TZ is pinned to UTC so local-day math is deterministic; the DST-sensitive
// window bugs are kept as commented-out BUG tests at the bottom.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMcodeUsage, mcodeUsageFromSessions, addMcodeMessages, messageTokens, localDay } from "./mcode-usage.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-usage-deep-"));
const savedEnv = {};
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TZ"]) {
  savedEnv[k] = process.env[k];
  if (k === "TZ") {
    process.env[k] = "UTC";
  } else {
    process.env[k] = path.join(tmp, k.toLowerCase());
    fs.mkdirSync(process.env[k], { recursive: true });
  }
}

// now is local noon on 2026-11-24 UTC: the 30-day window is 2026-10-26..24 and
// the 7-day model window starts at 2026-11-18 00:00 local.
const now = new Date(Date.UTC(2026, 10, 24, 12, 0, 0)).getTime();
const day = (offset) => new Date(Date.UTC(2026, 10, 24 - offset, 9, 0, 0))
  .toISOString().slice(0, 10);
const iso = (offset) => new Date(Date.UTC(2026, 10, 24 - offset, 9, 0, 0)).toISOString();

const line = (o) => JSON.stringify(o);
const asst = (timestamp, model, usage, extra = {}) =>
  line({ timestamp, message: { role: "assistant", model, provider: "minimax", usage, ...extra } });

// A sessions store under `root` holding one file per entry of `files`
// ({relpath: content}). Returns the sessions dir.
const store = (root, files = {}) => {
  const sessions = path.join(root, "v2", "sessions");
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(sessions, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return sessions;
};

try {
  // ---- localDay(): missing stamps and the nowMs parameter ----
  assert.equal(localDay(undefined, now), day(0), "undefined stamp books today");
  assert.equal(localDay(null, Date.UTC(2020, 5, 15, 8)), "2020-06-15",
    "null stamp books the caller's nowMs day, not Date.now()");
  assert.equal(localDay(undefined, Date.UTC(2020, 5, 15, 23, 59)), "2020-06-15");

  // ---- localDay(): epoch seconds vs milliseconds boundary ----
  // 946684800 s and 946684800000 ms are the same instant (2000-01-01T00:00Z);
  // the >10_000_000_000 test must send each down the right path.
  assert.equal(localDay(946684800, now), "2000-01-01", "epoch seconds");
  assert.equal(localDay(946684800000, now), "2000-01-01", "epoch milliseconds");
  assert.equal(localDay("946684800", now), "2000-01-01", "digit string seconds");
  assert.equal(localDay("946684800000", now), "2000-01-01", "digit string ms");
  // Just above the seconds/ms split both sides are out of range anyway.
  assert.equal(localDay(10000000000, now), null, "10^10 s lands past 2100");
  assert.equal(localDay(10000000001, now), null, "10^10+1 ms lands in 1970");
  // Upper bound of the accepted year range.
  assert.equal(localDay(4102444800, now), "2100-01-01", "2100-01-01 in seconds");
  assert.equal(localDay(4102444800000, now), "2100-01-01", "2100-01-01 in ms");
  assert.equal(localDay(Date.UTC(2101, 0, 1), now), null, "2101 rejected");
  assert.equal(localDay(Date.UTC(1999, 11, 31, 12), now), null, "1999 rejected");
  assert.equal(localDay(Date.UTC(2000, 0, 1, 12), now), "2000-01-01", "2000 accepted");

  // ---- localDay(): types and junk ----
  assert.equal(localDay(0, now), null);
  assert.equal(localDay(-1, now), null);
  assert.equal(localDay(false, now), null);
  assert.equal(localDay(NaN, now), null);
  assert.equal(localDay(Infinity, now), null);
  assert.equal(localDay(-Infinity, now), null);
  assert.equal(localDay({}, now), null, "plain object -> '[object Object]' unparseable");
  assert.equal(localDay([], now), null, "empty array -> '' unparseable");
  assert.equal(localDay([946684800000], now), null, "single-element array is not a digit string");
  assert.equal(localDay("", now), null);
  assert.equal(localDay("   ", now), null, "whitespace-only string");
  assert.equal(localDay("1e3", now), null, "exponent notation is not a digit string");
  assert.equal(localDay("999999999999999999999", now), null, "21-digit string: too long for the digit regex, Date.parse fails");
  assert.equal(localDay("  946684800000  ", now), "2000-01-01", "digit string is trimmed");
  assert.equal(localDay("2026-11-24", now), "2026-11-24", "date-only ISO");
  assert.equal(localDay("2026-11-24T23:30:00+02:00", now), "2026-11-24", "ISO with offset");
  assert.equal(localDay(new Date(Date.UTC(2026, 10, 24, 9)), now), "2026-11-24",
    "a Date object round-trips through String()+Date.parse");
  // Floats: the ms value is floored, not rejected.
  assert.equal(localDay(946684800000.9, now), "2000-01-01");

  // ---- messageTokens(): coercion and precedence ----
  assert.equal(messageTokens({ input: 1, output: 2, totalTokens: 999 }), 3,
    "bucket counts beat a disagreeing totalTokens");
  assert.equal(messageTokens({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 9 }), 9,
    "explicit zero buckets fall back to totalTokens");
  assert.equal(messageTokens({ input: -5, totalTokens: 9 }), 9,
    "negative buckets clamp to 0, then totalTokens is used");
  assert.equal(messageTokens({ input: -5, output: -2, cacheRead: -1, cacheWrite: -1, totalTokens: -4 }), 0);
  assert.equal(messageTokens({ cacheRead: 7 }), 7, "a lone cache bucket counts");
  assert.equal(messageTokens({ input: 0.5, output: 0.25 }), 0.75, "fractional counts are kept as-is");
  assert.equal(messageTokens({ input: Infinity, output: NaN, cacheRead: "3", cacheWrite: true }), 0,
    "non-finite and non-number fields are all untrusted");
  for (const bad of ["5", 5, true, [], null, undefined]) {
    assert.equal(messageTokens(bad), 0, `usage=${JSON.stringify(bad) ?? String(bad)} -> 0`);
  }

  // ---- addMcodeMessages(): malformed entries ----
  {
    const acc = { days: {}, models: {} };
    for (const bad of [null, undefined, 0, false, "", {}]) {
      addMcodeMessages(bad, acc, now); // must not throw
    }
    assert.deepEqual(acc, { days: {}, models: {} });
    // JSON scalars and arrays parse fine but are not message entries.
    for (const t of ["5", "null", "[]", "\"str\"", "true"]) {
      addMcodeMessages(t, acc, now);
    }
    assert.deepEqual(acc, { days: {}, models: {} });
    // entry.message in non-object shapes.
    for (const msg of [null, "x", 5, [], true]) {
      addMcodeMessages(line({ timestamp: iso(1), message: msg }), acc, now);
    }
    assert.deepEqual(acc, { days: {}, models: {} });
    // role is case-sensitive and must be exactly "assistant".
    for (const role of ["Assistant", "ASSISTANT", "assistant ", "", undefined]) {
      addMcodeMessages(line({ timestamp: iso(1), message: { role, usage: { input: 5 } } }), acc, now);
    }
    assert.deepEqual(acc, { days: {}, models: {} });
    // usage present but unusable.
    for (const usage of ["lots", 5, [], { input: "5" }, { input: -3 }]) {
      addMcodeMessages(asst(iso(1), "m", usage), acc, now);
    }
    assert.deepEqual(acc, { days: {}, models: {} });
  }

  // ---- addMcodeMessages(): timestamps ----
  {
    const acc = { days: {}, models: {} };
    // message.timestamp wins over the line's own timestamp.
    addMcodeMessages(line({
      timestamp: iso(5),
      message: { role: "assistant", model: "m", timestamp: iso(1), usage: { input: 5 } },
    }), acc, now);
    assert.equal(acc.days[day(1)], 5);
    assert.equal(acc.days[day(5)], undefined);
    // null/undefined message.timestamp falls back to the line timestamp.
    addMcodeMessages(line({
      timestamp: iso(2),
      message: { role: "assistant", model: "m", timestamp: null, usage: { input: 7 } },
    }), acc, now);
    assert.equal(acc.days[day(2)], 7);
    // Epoch seconds (not just ms/ISO) are accepted.
    addMcodeMessages(asst(Math.floor(Date.UTC(2026, 10, 20, 9) / 1000), "m", { input: 3 }), acc, now);
    assert.equal(acc.days["2026-11-20"], 3);
    // A stamp at exactly local midnight belongs to that day; 1 ms earlier does not.
    addMcodeMessages(asst(Date.UTC(2026, 10, 20, 0, 0, 0, 0), "m", { input: 2 }), acc, now);
    addMcodeMessages(asst(Date.UTC(2026, 10, 19, 23, 59, 59, 999), "m", { input: 4 }), acc, now);
    assert.equal(acc.days["2026-11-20"], 5);
    assert.equal(acc.days["2026-11-19"], 4);
    // Future-dated lines: days output is bounded to today, but the 7-day model
    // window has no upper bound, so a future model still counts there.
    const fut = { days: {}, models: {} };
    addMcodeMessages(asst(Date.UTC(2026, 11, 1, 12), "future-model", { input: 11 }), fut, now);
    assert.deepEqual(fut.days, { "2026-12-01": 11 }, "acc keeps the raw day");
    assert.deepEqual(fut.models, { "future-model": 11 });
    // BUG: message.timestamp = 0 or "" is present-but-unusable, so ?? keeps it
    // and localDay returns null — the whole line is dropped even though the
    // line's own valid timestamp was right there. Only null/undefined fall
    // back. Tokens reported by the transcript are silently lost.
    // const bugAcc = { days: {}, models: {} };
    // addMcodeMessages(line({ timestamp: iso(1),
    //   message: { role: "assistant", model: "m", timestamp: 0, usage: { input: 5 } } }), bugAcc, now);
    // addMcodeMessages(line({ timestamp: iso(1),
    //   message: { role: "assistant", model: "m", timestamp: "", usage: { input: 5 } } }), bugAcc, now);
    // assert.equal(bugAcc.days[day(1)], 10, "0/\"\" stamps should fall back to entry.timestamp");
  }

  // ---- addMcodeMessages(): models ----
  {
    const acc = { days: {}, models: {} };
    // message.model wins; empty/falsy falls through to entry.model; whitespace
    // trims to "unknown"; numbers stringify.
    addMcodeMessages(line({ timestamp: iso(1), model: "entry-model",
      message: { role: "assistant", model: "", usage: { input: 1 } } }), acc, now);
    assert.equal(acc.models["entry-model"], 1);
    addMcodeMessages(asst(iso(1), "   ", { input: 2 }), acc, now);
    assert.equal(acc.models.unknown, 2);
    addMcodeMessages(asst(iso(1), 123, { input: 4 }), acc, now);
    assert.equal(acc.models["123"], 4);
    addMcodeMessages(line({ timestamp: iso(1), model: "  padded  ",
      message: { role: "assistant", usage: { input: 8 } } }), acc, now);
    assert.equal(acc.models.padded, 8);
    // Model window boundary: exactly 6 days ago counts, 7 days ago does not.
    const wk = { days: {}, models: {} };
    addMcodeMessages(asst(new Date(Date.UTC(2026, 10, 18, 0, 30)).toISOString(), "edge6", { input: 1 })
      + "\n"
      + asst(new Date(Date.UTC(2026, 10, 17, 23, 59)).toISOString(), "edge7", { input: 1 }), wk, now);
    assert.deepEqual(wk.models, { edge6: 1 });
    assert.equal(wk.days["2026-11-17"], 1, "day 7 still lands in days, just not models");
    // Calls accumulate into the same acc and separate accs stay independent.
    addMcodeMessages(asst(iso(0), "m", { input: 5 }), acc, now);
    const other = { days: {}, models: {} };
    addMcodeMessages(asst(iso(0), "m", { input: 5 }), other, now);
    addMcodeMessages(asst(iso(0), "m", { input: 5 }), acc, now);
    assert.equal(acc.days[day(0)], 10);
    assert.equal(other.days[day(0)], 5);
  }

  // ---- addMcodeMessages(): file-text shapes ----
  {
    const acc = { days: {}, models: {} };
    // CRLF line endings parse fine.
    addMcodeMessages(asst(iso(1), "crlf", { input: 1 }) + "\r\n" + asst(iso(1), "crlf", { input: 2 }) + "\r\n", acc, now);
    assert.equal(acc.days[day(1)], 3);
    // A UTF-8 BOM poisons only the first line.
    const bom = { days: {}, models: {} };
    addMcodeMessages("﻿" + asst(iso(1), "bom-first", { input: 9 }) + "\n" + asst(iso(1), "bom-second", { input: 4 }), bom, now);
    assert.equal(bom.days[day(1)], 4);
    assert.equal(bom.models["bom-second"], 4);
    assert.equal(bom.models["bom-first"], undefined);
    // Whitespace-padded lines and a trailing line without newline.
    const pad = { days: {}, models: {} };
    addMcodeMessages("  " + asst(iso(1), "pad", { input: 6 }) + "  \n\n", pad, now);
    assert.equal(pad.days[day(1)], 6);
  }

  // ---- mcodeUsageFromSessions(): root edge cases ----
  {
    const d = fs.mkdtempSync(path.join(tmp, "roots-"));
    // A file where a directory is expected -> null, not a throw.
    const f = path.join(d, "afile");
    fs.writeFileSync(f, "x");
    assert.equal(mcodeUsageFromSessions(f, now), null);
    for (const bad of [null, undefined, "", 0]) {
      assert.equal(mcodeUsageFromSessions(bad, now), null, `root=${String(bad)}`);
    }
    // Existing but non-directory entries all behave.
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ---- mcodeUsageFromSessions(): what the walker finds ----
  {
    const d = fs.mkdtempSync(path.join(tmp, "walk-"));
    const sessions = store(d, {
      // messages.jsonl directly at the sessions root counts too.
      "messages.jsonl": asst(iso(1), "root-level", { input: 10 }),
      // Deep nesting is walked.
      "a/b/c/messages.jsonl": asst(iso(2), "deep", { input: 20 }),
      // Two files on the same day accumulate.
      "s1/messages.jsonl": asst(iso(3), "same", { input: 1 }) + "\n" + asst(iso(3), "same", { input: 2 }),
      "s2/messages.jsonl": asst(iso(3), "same", { input: 4 }),
      // A *directory* named messages.jsonl is recursed into, not read.
      "s3/messages.jsonl/messages.jsonl": asst(iso(4), "dir-named", { input: 8 }),
      // Lookalike filenames are ignored.
      "s4/messages.jsonl.bak": asst(iso(0), "bak", { input: 100 }),
      "s5/MESSAGES.JSONL": asst(iso(0), "case", { input: 100 }),
      "s6/messages.json": asst(iso(0), "json", { input: 100 }),
      "s7/notes.txt": asst(iso(0), "txt", { input: 100 }),
    });
    const r = mcodeUsageFromSessions(sessions, now);
    assert.ok(r);
    const byDate = Object.fromEntries(r.days.map((x) => [x.date, x.tokens]));
    assert.equal(byDate[day(1)], 10);
    assert.equal(byDate[day(2)], 20);
    assert.equal(byDate[day(3)], 7, "same-day files accumulate");
    assert.equal(byDate[day(4)], 8, "dir named messages.jsonl is recursed into");
    assert.equal(byDate[day(0)], 0, "lookalike filenames never count");
    assert.deepEqual(r.models, { "root-level": 10, deep: 20, same: 7, "dir-named": 8 });
    assert.deepEqual(r.limits, []);

    // Empty and blank-only files: the store is present, so zeros not null.
    const empty = store(d + "-e", { "s/messages.jsonl": "" });
    const re = mcodeUsageFromSessions(empty, now);
    assert.ok(re);
    assert.ok(re.days.every((x) => x.tokens === 0));
    const blanks = store(d + "-b", { "s/messages.jsonl": "\n  \n\t\n" });
    const rb = mcodeUsageFromSessions(blanks, now);
    assert.ok(rb.days.every((x) => x.tokens === 0));

    // Unreadable subdirectory loses only itself (guarded: root can read
    // anything, so only assert the skip when chmod actually bites).
    const locked = path.join(sessions, "s8", "locked");
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, "messages.jsonl"), asst(iso(0), "locked", { input: 50 }));
    fs.chmodSync(path.join(sessions, "s8"), 0o000);
    try {
      fs.accessSync(path.join(sessions, "s8", "messages.jsonl"), fs.constants.R_OK);
      // Running with enough privilege to read anyway: nothing to assert.
    } catch {
      const rl = mcodeUsageFromSessions(sessions, now);
      assert.equal(rl.days[29].tokens, 0, "chmod-0 session contributes nothing");
      assert.equal(rl.days.length, 30);
    } finally {
      fs.chmodSync(path.join(sessions, "s8"), 0o755);
    }

    // Stale state: no caching — a rewritten file is re-read every call.
    const sFile = path.join(sessions, "s1", "messages.jsonl");
    const before = mcodeUsageFromSessions(sessions, now).days.find((x) => x.date === day(3)).tokens;
    fs.writeFileSync(sFile, asst(iso(3), "same", { input: 100 }));
    const after = mcodeUsageFromSessions(sessions, now).days.find((x) => x.date === day(3)).tokens;
    assert.equal(before, 7);
    assert.equal(after, 104, "s1 now reports 100 + s2's 4; s3/s4.. unchanged");
    fs.writeFileSync(sFile, asst(iso(3), "same", { input: 1 }) + "\n" + asst(iso(3), "same", { input: 2 }));

    // Symlinked messages.jsonl: Dirent.isFile() is false for a symlink, so a
    // symlinked session file is silently skipped.
    // BUG: if a user symlinks ~/.minimax (or one session dir) to another
    // disk, those transcripts never count. The walker should probably follow
    // symlinks for files at least.
    // const sym = fs.mkdtempSync(path.join(tmp, "sym-"));
    // const symSessions = path.join(sym, "v2", "sessions", "s");
    // fs.mkdirSync(symSessions, { recursive: true });
    // fs.writeFileSync(path.join(sym, "real.jsonl"), asst(iso(0), "sy", { input: 4 }));
    // fs.symlinkSync(path.join(sym, "real.jsonl"), path.join(symSessions, "messages.jsonl"));
    // const rsym = mcodeUsageFromSessions(path.join(sym, "v2", "sessions"), now);
    // assert.equal(rsym.days[29].tokens, 4, "symlinked messages.jsonl should count");
    fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(d + "-e", { recursive: true, force: true });
    fs.rmSync(d + "-b", { recursive: true, force: true });
  }

  // ---- readMcodeUsage(): data dir resolution ----
  {
    const home = path.join(tmp, "home2");
    // Default layout: <home>/.minimax/v2/sessions — and with no `home` arg the
    // default is os.homedir(), which follows the redirected HOME env.
    const defSessions = store(path.join(home, ".minimax"), {
      "s/messages.jsonl": asst(iso(0), "default-home", { input: 3 }),
    });
    assert.ok(defSessions);
    // XDG-style data dirs get the same v2/sessions suffix.
    const r = readMcodeUsage({ env: {}, now }); // home defaults to os.homedir() = tmp/home, NOT home2
    // tmp/home has no .minimax yet -> null proves the default-home path was used.
    assert.equal(r, null);
    const homeReal = process.env.HOME;
    fs.mkdirSync(path.join(homeReal, ".minimax", "v2", "sessions", "s"), { recursive: true });
    fs.writeFileSync(path.join(homeReal, ".minimax", "v2", "sessions", "s", "messages.jsonl"),
      asst(iso(0), "os-home", { input: 2 }));
    const r2 = readMcodeUsage({ env: {}, now });
    assert.equal(r2.days[29].tokens, 2);
    assert.deepEqual(r2.models, { "os-home": 2 });

    // Env precedence: MINIMAX_DATA_DIR beats MAVIS_DATA_DIR; blank loses.
    const a = store(path.join(home, "a"), { "s/messages.jsonl": asst(iso(0), "minimax", { input: 1 }) });
    const b = store(path.join(home, "b"), { "s/messages.jsonl": asst(iso(0), "mavis", { input: 10 }) });
    assert.ok(a && b);
    let rr = readMcodeUsage({ home, env: { MINIMAX_DATA_DIR: path.join(home, "a"), MAVIS_DATA_DIR: path.join(home, "b") }, now });
    assert.deepEqual(rr.models, { minimax: 1 });
    rr = readMcodeUsage({ home, env: { MINIMAX_DATA_DIR: "", MAVIS_DATA_DIR: path.join(home, "b") }, now });
    assert.deepEqual(rr.models, { mavis: 10 });
    rr = readMcodeUsage({ home, env: { MINIMAX_DATA_DIR: "   \t ", MAVIS_DATA_DIR: path.join(home, "b") }, now });
    assert.deepEqual(rr.models, { mavis: 10 }, "whitespace-only env falls through");
    rr = readMcodeUsage({ home, env: { MAVIS_DATA_DIR: path.join(home, "b") }, now });
    assert.deepEqual(rr.models, { mavis: 10 });

    // "~" expands against the home argument; a relative path resolves against it.
    store(path.join(home, "tilde-home"), { "s/messages.jsonl": asst(iso(0), "tilde", { input: 5 }) });
    rr = readMcodeUsage({ home: path.join(home, "tilde-home"), env: { MINIMAX_DATA_DIR: "~" }, now });
    assert.deepEqual(rr.models, { tilde: 5 });
    rr = readMcodeUsage({ home: path.join(home, "tilde-home"), env: { MINIMAX_DATA_DIR: "~/sub" }, now });
    assert.equal(rr, null, "~/sub -> <home>/sub/v2/sessions, which does not exist");
    store(path.join(home, "tilde-home", "sub"), { "s/messages.jsonl": asst(iso(0), "sub", { input: 6 }) });
    rr = readMcodeUsage({ home: path.join(home, "tilde-home"), env: { MINIMAX_DATA_DIR: "~/sub" }, now });
    assert.deepEqual(rr.models, { sub: 6 });
    store(path.join(home, "tilde-home", "rel"), { "s/messages.jsonl": asst(iso(0), "rel", { input: 7 }) });
    rr = readMcodeUsage({ home: path.join(home, "tilde-home"), env: { MINIMAX_DATA_DIR: "rel" }, now });
    assert.deepEqual(rr.models, { rel: 7 }, "relative env resolves against home");
    // "~name" (no slash) concatenates with no separator: "~rel" becomes
    // <home>rel — e.g. tilde-home + "rel" = "tilde-homrel" — a nonsense path.
    // BUG: MINIMAX_DATA_DIR="~rel" silently resolves to <home>rel instead of
    // either <home>/rel or being rejected; tilde expansion only handles "~/"
    // sanely. If it expanded like "~/", it would find the rel store below.
    // const rq = readMcodeUsage({ home: path.join(home, "tilde-home"),
    //   env: { MINIMAX_DATA_DIR: "~rel" }, now });
    // assert.deepEqual(rq.models, { rel: 7 }, "~rel should expand to <home>/rel");

    // Env pointing at a file, or env:null (caller error), both surface.
    rr = readMcodeUsage({ home, env: { MINIMAX_DATA_DIR: path.join(home, "a", "v2", "sessions", "s", "messages.jsonl") }, now });
    assert.equal(rr, null, "data dir that is a file has no v2/sessions below it");
    assert.throws(() => readMcodeUsage({ home, env: null, now }), TypeError,
      "env:null is a caller error and is not guarded");
  }

  // ---- repeat calls / pseudo-concurrency ----
  {
    // The module keeps no cache: two reads of an unchanged store are deep-equal,
    // and interleaved pure-parser calls on separate accs cannot cross-talk.
    const d = fs.mkdtempSync(path.join(tmp, "repeat-"));
    const sessions = store(d, { "s/messages.jsonl": asst(iso(1), "m", { input: 9 }) });
    const r1 = mcodeUsageFromSessions(sessions, now);
    const r2 = mcodeUsageFromSessions(sessions, now);
    assert.deepEqual(r1, r2);
    assert.notEqual(r1, r2, "fresh objects each call, not a shared result");
    const a1 = { days: {}, models: {} };
    const a2 = { days: {}, models: {} };
    // Interleave at line granularity: split a two-line text across calls.
    const l1 = asst(iso(1), "x", { input: 1 });
    const l2 = asst(iso(1), "y", { input: 2 });
    addMcodeMessages(l1 + "\n", a1, now);
    addMcodeMessages(l1 + "\n", a2, now);
    addMcodeMessages(l2, a1, now);
    addMcodeMessages(l2, a2, now);
    assert.deepEqual(a1, a2);
    assert.equal(a1.days[day(1)], 3);
    fs.rmSync(d, { recursive: true, force: true });
  }

  console.log("mcode-usage deep: all tests passed");
} finally {
  for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TZ"]) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
