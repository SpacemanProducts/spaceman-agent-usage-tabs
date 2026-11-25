// Deep edge-case tests for kilo-usage.mjs — complements kilo-usage.test.mjs,
// which covers the happy paths. Everything here lives in fresh mkdtemp dirs;
// the real home folder is never touched.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  kiloDbPath,
  kiloTokens,
  kiloCost,
  kiloModel,
  summarizeKiloUsage,
  readKiloUsage,
} from "./kilo-usage.mjs";

const DAY = 86400000;
const NOW = new Date(2026, 10, 25, 15, 30).getTime();
const UNAVAILABLE = { agent: "kilo", available: false, status: "local data not available" };

// Point every XDG/HOME var at a throwaway dir so nothing can leak into the
// real home folder even if a code path ignores the explicit options.
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-deep-"));
process.env.HOME = BASE;
process.env.XDG_STATE_HOME = path.join(BASE, "state");
process.env.XDG_CONFIG_HOME = path.join(BASE, "config");
process.env.XDG_CACHE_HOME = path.join(BASE, "cache");
process.env.XDG_DATA_HOME = path.join(BASE, "data");

const tmpHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-deep-home-"));
  return { home, env: {} };
};

const kiloDir = (home) => {
  const dir = path.join(home, ".local", "share", "kilo");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// Build a db at <home>/.local/share/kilo/kilo.db (or XDG_DATA_HOME) with the
// given schema/messages. `spec` shapes:
//   { messageCols, sessionCols, messages: [[id, time_created, data], ...],
//     sessions: [row objects] }
function makeStore(home, spec = {}) {
  const env = spec.xdg ? { XDG_DATA_HOME: spec.xdg } : {};
  const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const dir = path.join(dataHome, "kilo");
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "kilo.db");
  const db = new DatabaseSync(dbPath);
  if (spec.messageCols) {
    // No declared type: keeps whatever affinity the bound values carry, so a
    // numeric time_created stays a number (TEXT affinity would stringify it
    // as "<n>.0", which toMs rightly rejects — that's a fixture artifact,
    // not behavior under test).
    db.exec(`CREATE TABLE message (${spec.messageCols.join(", ")})`);
    if (spec.messages) {
      const names = spec.messageCols;
      const stmt = db.prepare(`INSERT INTO message (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`);
      for (const row of spec.messages) stmt.run(...row);
    }
  }
  if (spec.sessionCols) {
    db.exec(`CREATE TABLE session (${spec.sessionCols.join(", ")})`);
    if (spec.sessions) {
      const names = spec.sessionCols;
      const stmt = db.prepare(`INSERT INTO session (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`);
      for (const row of spec.sessions) stmt.run(...names.map((n) => (row[n] === undefined ? null : row[n])));
    }
  }
  if (spec.extra) db.exec(spec.extra);
  db.close();
  return { dbPath, env };
}

const entry = (over = {}) =>
  JSON.stringify({
    role: "assistant",
    providerID: "kilo",
    modelID: "kilo-auto",
    cost: 0.01,
    tokens: { input: 10, output: 5 },
    time: { created: NOW - 3600000 },
    ...over,
  });

const MSG_COLS = ["id", "session_id", "time_created", "data"];

// ---- kiloDbPath edge cases -------------------------------------------------
{
  const home = "/h";
  // Empty-string XDG_DATA_HOME is falsy -> default ~/.local/share.
  assert.equal(kiloDbPath({ home, env: { XDG_DATA_HOME: "" } }), path.join(home, ".local", "share", "kilo", "kilo.db"));
  // Trailing slash is normalized by path.join.
  assert.equal(kiloDbPath({ home, env: { XDG_DATA_HOME: "/xdg/" } }), "/xdg/kilo/kilo.db");
  // Relative XDG_DATA_HOME stays relative (caller's responsibility).
  assert.equal(kiloDbPath({ home, env: { XDG_DATA_HOME: "rel" } }), path.join("rel", "kilo", "kilo.db"));
  // No args at all: falls back to the real homedir + process.env (redirected
  // to BASE above, so this never resolves into the real home folder).
  assert.equal(kiloDbPath(), path.join(BASE, "data", "kilo", "kilo.db"));
}

// ---- kiloTokens wrong/odd types ----------------------------------------------
{
  // Negative and non-finite numbers clamp to 0 via num().
  assert.equal(kiloTokens({ tokens: { input: -5, output: 3 } }), 3);
  assert.equal(kiloTokens({ tokens: { input: Infinity, output: NaN, reasoning: -1 } }), 0);
  // String values are not numbers -> 0 (type-strict, documented behavior).
  assert.equal(kiloTokens({ tokens: { input: "100", output: "5" } }), 0);
  assert.equal(kiloTokens({ tokens: { input: 10, output: "5" } }), 10);
  // cache spelled wrong / non-object -> contributes nothing.
  assert.equal(kiloTokens({ tokens: { input: 1, cache: "big" } }), 1);
  assert.equal(kiloTokens({ tokens: { input: 1, cache: [1, 2] } }), 1); // arrays are not objects here
  // tokens itself being an array/string/object-without-fields -> 0.
  assert.equal(kiloTokens({ tokens: [1, 2, 3] }), 0);
  assert.equal(kiloTokens({ tokens: "lots" }), 0);
  assert.equal(kiloTokens({ tokens: null }), 0);
  assert.equal(kiloTokens({ tokens: { input_tokens: 4, output_tokens: 6, reasoning_tokens: 1 } }), 11);
  assert.equal(kiloTokens({ tokens: { cache: { read_tokens: 2, write_tokens: 3 } } }), 5);
  // Mixed spellings in one object all add up.
  assert.equal(kiloTokens({ tokens: { inputTokens: 1, output: 2, reasoningTokens: 3, cache: { readTokens: 4, write: 5 } } }), 15);
  // Entry itself of the wrong type.
  assert.equal(kiloTokens(null), 0);
  assert.equal(kiloTokens(42), 0);
  assert.equal(kiloTokens("x"), 0);
  assert.equal(kiloTokens([{ tokens: 5 }]), 0);
}

// ---- kiloCost / kiloModel odd inputs -------------------------------------------
{
  assert.equal(kiloCost(null), 0);
  assert.equal(kiloCost({ cost: -0.5 }), 0);
  assert.equal(kiloCost({ cost: "0.5" }), 0); // strings not accepted
  assert.equal(kiloCost({ cost: Infinity }), 0);
  assert.equal(kiloCost({ cost: 1e-9 }), 1e-9);
  assert.equal(kiloModel(null), "unknown");
  assert.equal(kiloModel({ modelID: "   " }), "unknown");
  assert.equal(kiloModel({ modelID: 0 }), "unknown"); // falsy -> ""
  assert.equal(kiloModel({ modelID: 123 }), "123");
  assert.equal(kiloModel({ modelID: { id: "x" } }), "[object Object]"); // String() coercion, ugly but honest
  assert.equal(kiloModel({ modelID: "  spaced/model  " }), "spaced/model"); // trimmed
}

// ---- summarizeKiloUsage edge cases ---------------------------------------------
{
  // null / undefined / non-array events.
  assert.deepEqual(summarizeKiloUsage(null, NOW).total, { tokens: 0, requests: 0, cost: 0 });
  assert.deepEqual(summarizeKiloUsage(undefined, NOW).models, []);
  // A string is iterable, so for..of walks its chars — each counts as an
  // event with zeroed fields. Quirky, but callers always pass arrays.
  assert.equal(summarizeKiloUsage("nope", NOW).total.requests, 4);
  assert.equal(summarizeKiloUsage("nope", NOW).total.tokens, 0);
  // A non-iterable truthy value throws (readKiloUsage's try/catch would turn
  // that into UNAVAILABLE; the pure helper itself does not guard).
  assert.throws(() => summarizeKiloUsage({}, NOW), TypeError);
  assert.throws(() => summarizeKiloUsage(5, NOW), TypeError);

  // ms that is not a finite number still counts in total/models but never in
  // the dated buckets.
  const sum = summarizeKiloUsage(
    [
      { ms: NaN, model: "a", tokens: 1, cost: 0 },
      { ms: Infinity, model: "a", tokens: 1, cost: 0 },
      { ms: "not a number", model: "a", tokens: 1, cost: 0 },
      { ms: "1764000000000", model: "a", tokens: 1, cost: 0 }, // numeric string: still not a number
    ],
    NOW,
  );
  assert.equal(sum.total.requests, 4);
  assert.equal(sum.total.tokens, 4);
  assert.deepEqual(sum.today, { tokens: 0, requests: 0, cost: 0 });
  assert.deepEqual(sum.last24h, { tokens: 0, requests: 0, cost: 0 });

  // last24h is (now - DAY, now] — strictly greater than now-DAY, at most now.
  const edge = summarizeKiloUsage(
    [
      { ms: NOW - DAY, model: "a", tokens: 1, cost: 0 }, // exactly 24h old: excluded
      { ms: NOW - DAY + 1, model: "a", tokens: 2, cost: 0 }, // 1ms inside: included
      { ms: NOW, model: "a", tokens: 4, cost: 0 }, // exactly now: included
      { ms: NOW + 1, model: "a", tokens: 8, cost: 0 }, // future: excluded from last24h
    ],
    NOW,
  );
  assert.equal(edge.last24h.requests, 2);
  assert.equal(edge.last24h.tokens, 6);
  assert.equal(edge.total.requests, 4);
  // today bucket: the two ~24h-old events are yesterday; NOW and NOW+1 are
  // today (NOW is mid-afternoon, +1ms can't cross midnight).
  assert.equal(edge.today.tokens, 4 + 8);

  // Negative tokens/cost clamp to 0 in the buckets.
  const neg = summarizeKiloUsage([{ ms: NOW, model: "a", tokens: -50, cost: -1 }], NOW);
  assert.deepEqual(neg.today, { tokens: 0, requests: 1, cost: 0 });
  assert.equal(neg.total.requests, 1);

  // Models sort: most tokens first, ties broken by most requests.
  const tie = summarizeKiloUsage(
    [
      { ms: NOW, model: "few", tokens: 10, cost: 0 },
      { ms: NOW, model: "many", tokens: 10, cost: 0 },
      { ms: NOW, model: "many", tokens: 10, cost: 0 },
      { ms: NOW, model: "zero", tokens: 0, cost: 0 },
    ],
    NOW,
  );
  assert.deepEqual(tie.models.map((m) => m.model), ["many", "few", "zero"]);
  assert.equal(tie.models[0].requests, 2);

  // Missing model field -> "unknown".
  const noModel = summarizeKiloUsage([{ ms: NOW, tokens: 1, cost: 0 }], NOW);
  assert.equal(noModel.models[0].model, "unknown");
  // Empty-string model also -> "unknown".
  const emptyModel = summarizeKiloUsage([{ ms: NOW, model: "", tokens: 1, cost: 0 }], NOW);
  assert.equal(emptyModel.models[0].model, "unknown");
}

// ---- toMs / entryTime via the message table --------------------------------------
{
  const { home } = tmpHome();
  const t = (over) => ({
    role: "assistant",
    modelID: "m",
    tokens: { input: 1 },
    ...over,
  });
  makeStore(home, {
    messageCols: MSG_COLS,
    messages: [
      // epoch SECONDS (<= 1e11 -> *1000) lands today.
      ["s1", "sess", null, JSON.stringify(t({ time: { created: 1764000000 } }))],
      // epoch-ms as a numeric STRING.
      ["s2", "sess", null, JSON.stringify(t({ time: { created: "1764000000000" } }))],
      // ISO string.
      ["s3", "sess", null, JSON.stringify(t({ time: { created: "2026-11-25T10:00:00Z" } }))],
      // completed used when created is absent.
      ["s4", "sess", null, JSON.stringify(t({ time: { completed: NOW - 7200000 } }))],
      // created:null falls through to completed.
      ["s5", "sess", null, JSON.stringify(t({ time: { created: null, completed: NOW - 3600000 } }))],
      // created:0 is "provided" -> toMs(0) -> null -> row skipped entirely.
      ["s6", "sess", null, JSON.stringify(t({ time: { created: 0 } }))],
      // time as a bare epoch-seconds number (not wrapped in {created}).
      ["s7", "sess", null, JSON.stringify(t({ time: 1764000000 }))],
      // time as an unparseable object with no created/completed -> row's time_created.
      ["s8", "sess", NOW - 60000, JSON.stringify(t({ time: { other: 1 } }))],
      // time as boolean true -> Date.parse fails -> row skipped.
      ["s9", "sess", NOW - 60000, JSON.stringify(t({ time: true }))],
      // duplicate id: second row with same id is deduped.
      ["dup", "sess", null, JSON.stringify(t({ time: { created: NOW - 3600000 }, tokens: { input: 100 } }))],
      ["dup", "sess", null, JSON.stringify(t({ time: { created: NOW - 3600000 }, tokens: { input: 999 } }))],
    ],
  });
  const r = readKiloUsage({ home, env: {}, now: NOW });
  assert.equal(r.available, true);
  // s6 and s9 skipped (untrusted explicit time). dup counted once (100 tokens).
  // s1/s2/s3/s7 land wherever their timestamps land; s4,s5,s8 counted once each.
  const expected = ["s1", "s2", "s3", "s4", "s5", "s7", "s8", "dup"];
  assert.equal(r.total.requests, expected.length);
  // dup contributed 100 tokens; every other kept row contributes 1 (input:1).
  assert.equal(r.total.tokens, 100 + (expected.length - 1));
  // s6/s9 contributed nothing anywhere.
  assert.ok(!r.models.some((m) => m.requests === 9));
}

// ---- message table schema variants ------------------------------------------------
{
  // No `id` column -> falls back to m.rowid for dedup keys.
  const { home } = tmpHome();
  makeStore(home, {
    messageCols: ["session_id", "time_created", "data"],
    messages: [
      ["sess", null, entry({ time: { created: NOW - 3600000 } })],
      ["sess", null, entry({ time: { created: NOW - 1800000 } })],
      ["sess", null, entry({ time: { created: NOW - 900000 } })],
    ],
  });
  const r = readKiloUsage({ home, env: {}, now: NOW });
  assert.equal(r.total.requests, 3, "rowid keys keep every row");

  // No time_created column -> row_created is NULL -> entry's own time or "now".
  const h2 = tmpHome().home;
  makeStore(h2, {
    messageCols: ["id", "data"],
    messages: [
      ["a", JSON.stringify({ role: "assistant", modelID: "m", tokens: 5, time: { created: NOW - DAY } })],
      // no own time, no row time -> "now".
      ["b", JSON.stringify({ role: "assistant", modelID: "m", tokens: 7 })],
    ],
  });
  const r2 = readKiloUsage({ home: h2, env: {}, now: NOW });
  assert.equal(r2.total.requests, 2);
  // Row "a" is exactly 24h old -> outside the strict (now-DAY, now] window;
  // only the untimed row (treated as now) lands in last24h and today.
  assert.equal(r2.last24h.requests, 1);
  assert.equal(r2.today.requests, 1, "the untimed row counts as now -> today; 'a' is yesterday");

  // message table exists but has no `data` column -> messageEvents null ->
  // session fallback if a usable session table exists.
  const h3 = tmpHome().home;
  makeStore(h3, {
    messageCols: ["id", "time_created"],
    messages: [["m1", "123"]],
    sessionCols: ["id", "cost", "tokens_input", "time_updated"],
    sessions: [{ id: "s1", cost: 2.5, tokens_input: 100, time_updated: NOW - 3600000 }],
  });
  const r3 = readKiloUsage({ home: h3, env: {}, now: NOW });
  assert.equal(r3.available, true);
  assert.equal(r3.total.tokens, 100);
  assert.equal(r3.total.cost, 2.5);
  assert.equal(r3.total.requests, null, "session fallback: requests stay null");
  assert.deepEqual(r3.models, []);

  // message table usable (has data) but zero assistant rows -> events = []
  // (not null), so session rows are NOT consulted even though present.
  const h4 = tmpHome().home;
  makeStore(h4, {
    messageCols: MSG_COLS,
    messages: [
      ["u1", "s", null, JSON.stringify({ role: "user", modelID: "m" })],
      ["c1", "s", null, "{broken json"],
      ["n1", "s", null, "null"],
      ["a1", "s", null, "[1,2,3]"], // JSON array: typeof object but role undefined -> skipped
      ["s1", "s", null, '"just a string"'],
      ["n2", "s", null, "42"],
    ],
    sessionCols: ["id", "cost", "tokens_input", "time_updated"],
    sessions: [{ id: "sx", cost: 9, tokens_input: 999, time_updated: NOW }],
  });
  const r4 = readKiloUsage({ home: h4, env: {}, now: NOW });
  assert.equal(r4.available, true);
  assert.deepEqual(r4.total, { tokens: 0, requests: 0, cost: 0 }, "message table wins; sessions ignored");
  assert.equal(r4.total.requests, 0, "0, not null — this is the message path");
}

// ---- session table variants --------------------------------------------------------
{
  const sess = (cols, rows) => {
    const { home } = tmpHome();
    makeStore(home, { sessionCols: cols, sessions: rows });
    return readKiloUsage({ home, env: {}, now: NOW });
  };

  // Only cost, no token columns.
  let r = sess(["id", "cost", "time_updated"], [{ id: "a", cost: 1.5, time_updated: NOW - DAY / 2 }]);
  assert.equal(r.total.cost, 1.5);
  assert.equal(r.total.tokens, 0);
  assert.equal(r.total.requests, null);

  // Only token columns, no cost.
  r = sess(["id", "tokens_input", "tokens_output", "time_created"], [{ id: "a", tokens_input: 10, tokens_output: 5, time_created: NOW }]);
  assert.equal(r.total.tokens, 15);
  assert.equal(r.total.cost, 0);

  // Session table with neither cost nor token cols -> unusable -> unavailable.
  r = sess(["id", "title", "time_updated"], [{ id: "a", title: "x", time_updated: NOW }]);
  assert.deepEqual(r, UNAVAILABLE);

  // Session table with cost col but it's empty -> still usable (COALESCE 0).
  r = sess(["id", "cost"], [{ id: "a", cost: null }, { id: "b" }]);
  assert.equal(r.available, true);
  assert.equal(r.total.requests, null);
  // No time column -> events timed "now".
  assert.equal(r.today.requests, null);
  assert.equal(r.total.tokens + r.total.cost, 0);

  // Session row with an untrusted time value is skipped; NULL time -> now.
  r = sess(["id", "cost", "time_updated"], [
    { id: "bad", cost: 5, time_updated: "not a time" },
    { id: "nullt", cost: 2, time_updated: null },
  ]);
  assert.equal(r.total.cost, 2, "bad-time row skipped, null-time row kept as now");
  assert.equal(r.total.requests, null);

  // ISO-string session time parses.
  r = sess(["id", "cost", "updated_at"], [{ id: "a", cost: 3, updated_at: "2026-11-25T12:00:00" }]);
  assert.equal(r.available, true);
  assert.equal(r.total.cost, 3);
}

// ---- filesystem-level edge cases -----------------------------------------------------
{
  // kilo.db path exists but is a DIRECTORY -> DatabaseSync throws -> unavailable.
  const { home } = tmpHome();
  const dir = kiloDir(home);
  fs.mkdirSync(path.join(dir, "kilo.db"));
  assert.deepEqual(readKiloUsage({ home, env: {}, now: NOW }), UNAVAILABLE);

  // kilo.db is a zero-byte file -> not sqlite -> unavailable.
  const h2 = tmpHome().home;
  const d2 = kiloDir(h2);
  fs.writeFileSync(path.join(d2, "kilo.db"), "");
  assert.deepEqual(readKiloUsage({ home: h2, env: {}, now: NOW }), UNAVAILABLE);

  // kilo.db unreadable (chmod 000) -> unavailable, no throw.
  const h3 = tmpHome().home;
  const d3 = kiloDir(h3);
  fs.writeFileSync(path.join(d3, "kilo.db"), "junk");
  fs.chmodSync(path.join(d3, "kilo.db"), 0o000);
  try {
    assert.deepEqual(readKiloUsage({ home: h3, env: {}, now: NOW }), UNAVAILABLE);
  } finally {
    fs.chmodSync(path.join(d3, "kilo.db"), 0o644);
  }

  // XDG_DATA_HOME is honored by readKiloUsage itself (not just kiloDbPath).
  const h4 = tmpHome().home;
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-xdg-"));
  makeStore(h4, {
    xdg,
    messageCols: MSG_COLS,
    messages: [["a", "sess", NOW - 3600000, entry({ time: { created: NOW - 3600000 } })]],
  });
  const r4 = readKiloUsage({ home: h4, env: { XDG_DATA_HOME: xdg }, now: NOW });
  assert.equal(r4.available, true);
  assert.equal(r4.total.requests, 1);
  // Same home without the env var -> nothing there.
  assert.deepEqual(readKiloUsage({ home: h4, env: {}, now: NOW }), UNAVAILABLE);
}

// ---- repeated calls / handle hygiene ----------------------------------------------------
{
  const { home } = tmpHome();
  makeStore(home, {
    messageCols: MSG_COLS,
    messages: [["a", "sess", NOW - 3600000, entry()]],
  });
  // Many sequential calls: each opens and closes its own handle; results stable.
  const first = readKiloUsage({ home, env: {}, now: NOW });
  for (let i = 0; i < 25; i++) {
    const r = readKiloUsage({ home, env: {}, now: NOW });
    assert.deepEqual(r, first);
  }
  // A call on a different (empty) home interleaved doesn't disturb it.
  const { home: other } = tmpHome();
  kiloDir(other); // dir exists, no db
  assert.deepEqual(readKiloUsage({ home: other, env: {}, now: NOW }), UNAVAILABLE);
  assert.deepEqual(readKiloUsage({ home, env: {}, now: NOW }), first);
}

// ---- WAL-mode db ------------------------------------------------------------------------
{
  const { home } = tmpHome();
  const dir = kiloDir(home);
  const dbPath = path.join(dir, "kilo.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)`);
  db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)")
    .run("w1", "s", NOW - 3600000, entry());
  // Keep the writer open with un-checkpointed WAL frames, then read.
  try {
    const r = readKiloUsage({ home, env: {}, now: NOW });
    assert.equal(r.available, true);
    assert.equal(r.total.requests, 1);
  } finally {
    db.close();
  }
}

// ---- day-boundary edge for the today bucket ---------------------------------------------
{
  // Local midnight: an event 1ms before and 1ms after land in different
  // "today" buckets even though they're ~2ms apart in time.
  const midnight = new Date(2026, 10, 26, 0, 0, 0, 0).getTime();
  const sum = summarizeKiloUsage(
    [
      { ms: midnight - 1, model: "a", tokens: 1, cost: 0 },
      { ms: midnight, model: "a", tokens: 2, cost: 0 },
      { ms: midnight + 1, model: "a", tokens: 4, cost: 0 },
    ],
    midnight,
  );
  assert.equal(sum.today.tokens, 2 + 4, "midnight itself and after count as today");
  assert.equal(sum.today.requests, 2);
  assert.equal(sum.total.requests, 3);
  // last24h is (now-DAY, now]: midnight+1 is in the future -> excluded even
  // though it's "today".
  assert.equal(sum.last24h.requests, 2);
}

fs.rmSync(BASE, { recursive: true, force: true });
console.log("kilo-usage.deep.test.mjs: all assertions passed");
