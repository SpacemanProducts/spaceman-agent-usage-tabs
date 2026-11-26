// Deeper edge-case pass on bin/opencode-usage.mjs. Complements
// opencode-usage.test.mjs (happy-path v1+v2 dedup, corrupt JSON, empty store,
// basic path resolution). Here: wrong types, boundary timestamps, missing
// columns, env/path oddities, unreadable inputs, and the few races the
// synchronous module can still have (stale `now`, repeated calls).
//
// The module is synchronous and touches only the SQLite file opencodeDbPath
// resolves; every fixture lives under a fresh fs.mkdtempSync dir with HOME and
// the XDG vars pointed there, and all of them are removed at the end.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { opencodeDbPath, opencodeTokens, opencodeModelName, summarizeOpencodeUsage, readOpencodeUsage } from "./opencode-usage.mjs";

const DAY = 86400000;
const NOW = new Date(2026, 10, 24, 15, 30).getTime(); // fixed "now" for fixtures
const MIN_MS = Date.UTC(2000, 0, 1);
const MAX_MS = Date.UTC(2100, 0, 1);
const localDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const daysAgo = (n, hour = 12) => { const d = new Date(NOW); d.setDate(d.getDate() - n); d.setHours(hour, 0, 0, 0); return d.getTime(); };

const TMP = [];
const tmpdir = (prefix = "oc-deep-") => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP.push(d);
  return d;
};
// A fresh sandbox: HOME + every XDG dir inside one temp root, so nothing the
// module resolves can ever land in the real home folder.
const sandbox = () => {
  const root = tmpdir();
  const env = {
    HOME: root,
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
  };
  for (const v of Object.values(env).slice(1)) fs.mkdirSync(v, { recursive: true });
  return { root, env, home: root };
};

const entryJson = (over = {}) => JSON.stringify({
  role: "assistant", providerID: "opencode", modelID: "gpt-5",
  tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } },
  time: { created: daysAgo(1) },
  ...over,
});

// Minimal v2 store; `withCreated` adds the time_created column.
function makeV2Db(dir, { withCreated = true, extraCols = "" } = {}) {
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER${withCreated ? ", time_created INTEGER" : ""}${extraCols}, data TEXT);
  `);
  return { db, dbPath, insert: (id, type, data, created = null) => {
    if (withCreated) db.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, 's1', ?, 1, ?, ?)").run(id, type, created, data);
    else db.prepare("INSERT INTO session_message (id, session_id, type, seq, data) VALUES (?, 's1', ?, 1, ?)").run(id, type, data);
  } };
}
const close = (db) => { try { db.close(); } catch {} };

// ============================================================ opencodeTokens: wrong types
// num() only accepts finite numbers > 0; everything else is 0, never NaN.
for (const bad of [-5, "10", NaN, Infinity, -Infinity, true, null, undefined, [3], { v: 3 }]) {
  const t = opencodeTokens({ tokens: { input: bad, output: bad, reasoning: bad, cache: { read: bad, write: bad } } });
  assert.deepEqual(t, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, `bad token value ${String(bad)}`);
}
for (const bad of [null, undefined, 0, "x", true, [], [1, 2], { tokens: "nope" }, { tokens: [1] }, { tokens: { cache: "x" } }]) {
  assert.deepEqual(opencodeTokens(bad), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, `entry ${JSON.stringify(bad)}`);
}
// Fractional and zero-boundary numbers still count; reasoning folds into output.
assert.deepEqual(opencodeTokens({ tokens: { input: 0.5, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
  { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0 });
assert.deepEqual(opencodeTokens({ tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } }),
  { input: 1, output: 5, cacheRead: 4, cacheWrite: 5 }, "reasoning rides with output");
// tokens.cache as an array is rejected by obj() even though arrays are objects.
assert.deepEqual(opencodeTokens({ tokens: { input: 1, cache: [9, 9] } }),
  { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 });

// ============================================================ opencodeModelName: odd shapes
assert.equal(opencodeModelName({ modelID: 123 }), "123", "numeric modelID stringified");
assert.equal(opencodeModelName({ modelID: "   " }), "", "whitespace-only model id");
assert.equal(opencodeModelName({ modelID: "a/b/c:d:e" }), "c", "last path segment, first colon variant dropped");
assert.equal(opencodeModelName({ modelID: "glm" }), "GLM", "bare glm uppercased");
assert.equal(opencodeModelName({ modelID: "GLM-4.6" }), "GLM-4.6", "already-uppercase GLM untouched");
assert.equal(opencodeModelName({ modelID: "x/glm" }), "GLM");
// modelID wins over the nested model object; a falsy modelID falls through to it.
assert.equal(opencodeModelName({ modelID: "top/model", model: { id: "nested/model" } }), "model");
assert.equal(opencodeModelName({ modelID: "", model: { modelID: "nested/m2" } }), "m2", "empty modelID -> nested.modelID");
assert.equal(opencodeModelName({ modelID: 0, model: { id: "nested/m3" } }), "m3", "falsy modelID -> nested.id");
assert.equal(opencodeModelName(null), "");
assert.equal(opencodeModelName("str"), "");
assert.equal(opencodeModelName({ model: "not-an-object" }), "");
assert.equal(opencodeModelName({ modelID: ":high" }), "", "variant-only id is empty after split");

// ============================================================ summarizeOpencodeUsage: pure edges
{
  // null/undefined/empty input -> honest empty 30-day shape, never throws.
  for (const bad of [null, undefined, []]) {
    const r = summarizeOpencodeUsage(bad, NOW);
    assert.equal(r.days.length, 30);
    assert.ok(r.days.every((d) => d.tokens === 0));
    assert.deepEqual(r.models, {});
    assert.deepEqual(r.limits, []);
  }
  // BUG: a truthy non-iterable (object, number) crashes `for...of` with a
  // TypeError instead of yielding the empty shape like null does.
  // for (const bad of [{}, 5]) summarizeOpencodeUsage(bad, NOW); // TypeError
}
{
  const r = summarizeOpencodeUsage([
    { createdMs: NaN, model: "a", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    { createdMs: Infinity, model: "a", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    { createdMs: "1760000000000", model: "a", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, // string, not number
    { createdMs: -1, model: "a", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, // pre-1970 date
    { createdMs: daysAgo(1), model: "a", input: -9, output: "x", cacheRead: NaN, cacheWrite: 0 }, // all clamp to 0
    { createdMs: daysAgo(1), model: "  ", input: 4, output: 0, cacheRead: 0, cacheWrite: 0 }, // blank model
    { createdMs: daysAgo(1), model: 42, input: 6, output: 0, cacheRead: 0, cacheWrite: 0 }, // numeric model
  ], NOW);
  assert.equal(r.days.find((d) => d.date === localDate(daysAgo(1))).tokens, 10, "only the two real entries count (4 + 6)");
  assert.deepEqual(r.models, { unknown: 4, "42": 6 }, "blank model -> unknown, numeric model -> String()");
}
{
  // Day window edge: lastDays(30) spans now-29d..now by LOCAL date.
  const r = summarizeOpencodeUsage([
    { createdMs: daysAgo(29), model: "edge", input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
    { createdMs: daysAgo(30), model: "edge", input: 2, output: 0, cacheRead: 0, cacheWrite: 0 },
    { createdMs: NOW - 29 * DAY - 1, model: "edge", input: 4, output: 0, cacheRead: 0, cacheWrite: 0 }, // same local date as 29d? depends on time-of-day
  ], NOW);
  const oldest = localDate(NOW - 29 * DAY);
  const tokens = r.days.find((d) => d.date === oldest).tokens;
  // daysAgo(29) and daysAgo(30) land on distinct local dates; the -1ms entry
  // shares the oldest date only if NOW isn't within 1ms of midnight (it isn't).
  assert.ok(tokens >= 1 && tokens <= 5, `oldest-day bucket got ${tokens}`);
  assert.equal(r.days.find((d) => d.date === localDate(daysAgo(30))), undefined, "30 days ago is outside the 30-day window");
}
{
  // Model window edge: entries >= local midnight minus 6 days count as models,
  // even when they are older than the 30-day day window is impossible, but the
  // boundary itself is exact.
  const midnight = new Date(NOW); midnight.setHours(0, 0, 0, 0);
  const weekStart = midnight.getTime() - 6 * DAY;
  const r = summarizeOpencodeUsage([
    { createdMs: weekStart, model: "m", input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
    { createdMs: weekStart - 1, model: "m", input: 2, output: 0, cacheRead: 0, cacheWrite: 0 },
    { createdMs: weekStart - DAY, model: "m", input: 4, output: 0, cacheRead: 0, cacheWrite: 0 }, // still inside 30d days
  ], NOW);
  assert.equal(r.models.m, 1, "exactly at weekStart counts; 1ms before does not");
  // weekStart-1ms and weekStart-DAY share the same local date (today-7d): 2 + 4.
  assert.equal(r.days.find((d) => d.date === localDate(weekStart - DAY)).tokens, 6, "older entries still land in days");
}
{
  // `now` at local midnight: the week/day math must not shift a day.
  const midnightNow = new Date(2026, 10, 24, 0, 0, 0, 0).getTime();
  const r = summarizeOpencodeUsage([
    { createdMs: midnightNow - 1, model: "m", input: 3, output: 0, cacheRead: 0, cacheWrite: 0 },
    { createdMs: midnightNow, model: "m", input: 5, output: 0, cacheRead: 0, cacheWrite: 0 },
  ], midnightNow);
  assert.equal(r.days[29].date, localDate(midnightNow));
  assert.equal(r.days[28].date, localDate(midnightNow - DAY));
  assert.equal(r.days[28].tokens, 3, "1ms before midnight lands on the previous local day");
  assert.equal(r.days[29].tokens, 5);
  assert.equal(r.models.m, 8, "both are inside the 7-day model window");
}
{
  // Repeated calls with different `now` are independent (no module-level state).
  const entries = [{ createdMs: daysAgo(1), model: "m", input: 7, output: 0, cacheRead: 0, cacheWrite: 0 }];
  const a = summarizeOpencodeUsage(entries, NOW);
  const b = summarizeOpencodeUsage(entries, NOW + 40 * DAY); // entry now 41 days old
  assert.equal(a.days.find((d) => d.date === localDate(daysAgo(1))).tokens, 7);
  assert.equal(b.days.every((d) => d.tokens === 0), true, "stale entries don't leak into a later window");
  assert.deepEqual(b.models, {}, "outside the 7-day model window too");
}

// ============================================================ opencodeDbPath: env edge cases
{
  const { home, env } = sandbox();
  // Whitespace-only OPENCODE_DB is trimmed away -> normal/legacy resolution.
  assert.equal(opencodeDbPath({ home, env: { ...env, OPENCODE_DB: "   " } }),
    path.join(env.XDG_DATA_HOME, "opencode", "opencode-v2.db"), "blank OPENCODE_DB ignored");
  // "~" expansion uses the passed home, not os.homedir().
  assert.equal(opencodeDbPath({ home, env: { ...env, OPENCODE_DB: "~/custom/dir.db" } }),
    path.join(home, "custom", "dir.db"));
  // Relative OPENCODE_DB resolves inside <data>/opencode/, not cwd.
  assert.equal(opencodeDbPath({ home, env: { ...env, OPENCODE_DB: "sub/dir.db" } }),
    path.join(env.XDG_DATA_HOME, "opencode", "sub", "dir.db"));
  // XDG_DATA_HOME wins over ~/.local/share.
  fs.mkdirSync(path.join(env.XDG_DATA_HOME, "opencode"), { recursive: true });
  fs.writeFileSync(path.join(env.XDG_DATA_HOME, "opencode", "opencode.db"), "");
  assert.equal(opencodeDbPath({ home, env }), path.join(env.XDG_DATA_HOME, "opencode", "opencode.db"));
  // No XDG_DATA_HOME -> ~/.local/share/opencode.
  const bare = { HOME: home, XDG_STATE_HOME: env.XDG_STATE_HOME, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME, XDG_CACHE_HOME: env.XDG_CACHE_HOME };
  assert.equal(opencodeDbPath({ home, env: bare }), path.join(home, ".local", "share", "opencode", "opencode-v2.db"));
}

// ============================================================ timestamp edges in stored rows
{
  const { home, env } = sandbox();
  const dir = path.join(env.XDG_DATA_HOME, "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const { db, insert } = makeV2Db(dir);
  const good = entryJson({ tokens: { input: 10, output: 0, cache: { read: 0, write: 0 } }, time: { created: daysAgo(1) } });
  insert("good", "assistant", good, daysAgo(1));
  // entry.time.created present but unusable -> row skipped ENTIRELY, even
  // though the row's own time_created is valid (Omarchy's rule: no fallback).
  insert("t1", "assistant", entryJson({ tokens: { input: 1, output: 0 }, time: { created: 0 } }), daysAgo(1));
  insert("t2", "assistant", entryJson({ tokens: { input: 2, output: 0 }, time: { created: -100 } }), daysAgo(1));
  insert("t3", "assistant", entryJson({ tokens: { input: 4, output: 0 }, time: { created: "1760000000000" } }), daysAgo(1)); // string
  insert("t4", "assistant", entryJson({ tokens: { input: 8, output: 0 }, time: { created: MIN_MS - 1 } }), daysAgo(1)); // pre-2000
  insert("t5", "assistant", entryJson({ tokens: { input: 16, output: 0 }, time: { created: MAX_MS + 1 } }), daysAgo(1)); // post-2100
  // Boundary values themselves are accepted.
  insert("t6", "assistant", entryJson({ tokens: { input: 32, output: 0 }, time: { created: MIN_MS } }), daysAgo(1)); // 2000-01-01: outside 30d but kept
  insert("t7", "assistant", entryJson({ tokens: { input: 64, output: 0 }, time: { created: MAX_MS } }), daysAgo(1)); // 2100: inside model window
  // No time anywhere in the entry -> row's time_created is the fallback.
  insert("t8", "assistant", entryJson({ tokens: { input: 128, output: 0 }, time: {} }), daysAgo(2));
  // entry.time entirely absent (not just empty) -> still row fallback.
  const noTime = JSON.parse(entryJson({ tokens: { input: 256, output: 0 } }));
  delete noTime.time;
  insert("t9", "assistant", JSON.stringify(noTime), daysAgo(3));
  close(db);
  const r = readOpencodeUsage({ home, env, now: NOW });
  assert.ok(r);
  assert.equal(r.days.find((d) => d.date === localDate(daysAgo(1))).tokens, 10, "only the clean row counts for yesterday");
  assert.equal(r.days.find((d) => d.date === localDate(daysAgo(2))).tokens, 128, "empty time -> row time_created");
  assert.equal(r.days.find((d) => d.date === localDate(daysAgo(3))).tokens, 256, "missing time -> row time_created");
  assert.equal(r.models["gpt-5"], 10 + 128 + 256 + 64, "MIN/MAX boundary rows count in the model window (32 is year-2000, outside 7d)");
  // t1..t5 (created 0/-100/string/pre-2000/post-2100) are skipped outright.
}
{
  // session_message WITHOUT a time_created column and an entry with no time:
  // falls back to `now` -> counted on today.
  const { home, env } = sandbox();
  const dir = path.join(env.XDG_DATA_HOME, "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const { db, insert } = makeV2Db(dir, { withCreated: false });
  const noTime = JSON.parse(entryJson({ tokens: { input: 50, output: 0 } }));
  delete noTime.time;
  insert("n1", "assistant", JSON.stringify(noTime));
  // Same row but WITH an entry time still uses the entry time.
  insert("n2", "assistant", entryJson({ tokens: { input: 70, output: 0 }, time: { created: daysAgo(4) } }));
  close(db);
  const r = readOpencodeUsage({ home, env, now: NOW });
  assert.ok(r);
  assert.equal(r.days[29].tokens, 50, "no time anywhere -> now (today)");
  assert.equal(r.days.find((d) => d.date === localDate(daysAgo(4))).tokens, 70);
}

// ============================================================ v1 store quirks
{
  const { home, env } = sandbox();
  const dir = path.join(env.XDG_DATA_HOME, "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  // v1 `message` table with NO id and NO time_created columns.
  db.exec("CREATE TABLE message (session_id TEXT, data TEXT)");
  const ins = db.prepare("INSERT INTO message (session_id, data) VALUES ('s1', ?)");
  // No role in the entry -> rowType "" -> filtered out (v1 has no type column,
  // so role is the only assistant signal; absent means skip).
  const noRole = JSON.parse(entryJson({ tokens: { input: 1, output: 0 } }));
  delete noRole.role;
  ins.run(JSON.stringify(noRole));
  // role "Assistant" capitalized -> filtered (exact match only).
  ins.run(entryJson({ role: "Assistant", tokens: { input: 2, output: 0 } }));
  // A real assistant row counts; without id/time_created the rowid is the dedup
  // key and `now` is the timestamp fallback.
  ins.run(entryJson({ tokens: { input: 4, output: 0 }, time: {} }));
  close(db);
  const r = readOpencodeUsage({ home, env, now: NOW });
  assert.ok(r);
  assert.equal(r.days[29].tokens, 4, "only the lowercase-role assistant row, stamped now");
}
{
  // v1 `message` table with an id column: identical rows dedupe on id.
  const { home, env } = sandbox();
  const dir = path.join(env.XDG_DATA_HOME, "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "opencode.db"));
  db.exec("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)");
  const ins = db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, 's1', ?)");
  ins.run("dup", entryJson({ tokens: { input: 9, output: 0 }, time: { created: daysAgo(1) } }));
  ins.run("dup", entryJson({ tokens: { input: 9, output: 0 }, time: { created: daysAgo(1) } })); // same id -> skipped
  ins.run("other", entryJson({ tokens: { input: 3, output: 0 }, time: { created: daysAgo(1) } }));
  close(db);
  const r = readOpencodeUsage({ home, env, now: NOW });
  assert.ok(r);
  assert.equal(r.days.find((d) => d.date === localDate(daysAgo(1))).tokens, 12, "dup id counted once");
}
{
  // BUG: two session_message rows with NULL id, same session/type/createdMs,
  // collide on the fallback dedup key `${sessionId}:${rowType}:${createdMs}`
  // and the second row's tokens are silently dropped. `id` is nullable here
  // because the collector does not require a PRIMARY KEY.
  // const { home, env } = sandbox(); ... insert("s1","assistant",data1,null) and
  // insert(null,"assistant",data2,null) with identical time.created -> only data1 counts.
}

// ============================================================ corrupt / odd `data` payloads
{
  const { home, env } = sandbox();
  const dir = path.join(env.XDG_DATA_HOME, "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const { db, insert } = makeV2Db(dir);
  const payloads = [
    "null", "[1,2,3]", "\"just a string\"", "5", "true", "{}", // valid JSON, not an entry object
    "{bad json", // invalid JSON
    JSON.stringify({ role: "assistant", tokens: "not-an-object", time: { created: daysAgo(1) } }),
    JSON.stringify({ role: "assistant", tokens: { input: "x" }, time: { created: daysAgo(1) } }), // clamps to 0 -> skipped
    JSON.stringify([1, 2]), // JSON array -> Array.isArray -> skipped
    entryJson({ tokens: { input: 1, output: 0 }, time: { created: daysAgo(1) } }), // the one good row
  ];
  payloads.forEach((p, i) => insert(`c${i}`, "assistant", p, daysAgo(1)));
  // A row whose type column is neither assistant nor compaction is filtered by SQL.
  insert("cuser", "user", entryJson({ tokens: { input: 99, output: 0 } }), daysAgo(1));
  close(db);
  const r = readOpencodeUsage({ home, env, now: NOW });
  assert.ok(r);
  assert.equal(r.days.find((d) => d.date === localDate(daysAgo(1))).tokens, 1, "only the one well-formed assistant row");
}
{
  // A `data` column that is literally NULL never matches the LIKE filter.
  const { home, env } = sandbox();
  const dir = path.join(env.XDG_DATA_HOME, "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "opencode.db"));
  db.exec("CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, data TEXT)");
  db.prepare("INSERT INTO session_message (id, session_id, type, data) VALUES ('x','s1','assistant',?)").run(null);
  db.prepare("INSERT INTO session_message (id, session_id, type, data) VALUES ('y','s1','assistant',?)")
    .run(entryJson({ tokens: { input: 3, output: 0 } }));
  close(db);
  const r = readOpencodeUsage({ home, env, now: NOW });
  assert.ok(r);
  assert.equal(r.days.find((d) => d.date === localDate(daysAgo(1))).tokens, 3, "NULL data row ignored, real row counted");
}

// ============================================================ store-shape fallthrough
{
  // session_message exists but lacks required columns; the v1 `message` table
  // still counts (foundStore comes from whichever store is usable).
  const { home, env } = sandbox();
  const dir = path.join(env.XDG_DATA_HOME, "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "opencode.db"));
  db.exec(`
    CREATE TABLE session_message (foo TEXT); -- wrong shape entirely
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
  `);
  db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES ('v1','s1',?,?)")
    .run(daysAgo(1), entryJson({ tokens: { input: 11, output: 0 } }));
  close(db);
  const r = readOpencodeUsage({ home, env, now: NOW });
  assert.ok(r, "v1 store still found when v2 table is unusable");
  assert.equal(r.days.find((d) => d.date === localDate(daysAgo(1))).tokens, 11);
}
{
  // session_message has columns but is missing `type` -> v2 skipped, v1 used.
  const { home, env } = sandbox();
  const dir = path.join(env.XDG_DATA_HOME, "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "opencode.db"));
  db.exec(`
    CREATE TABLE session_message (id TEXT, session_id TEXT, data TEXT);
    CREATE TABLE message (id TEXT, session_id TEXT, data TEXT);
  `);
  db.prepare("INSERT INTO session_message (id, session_id, data) VALUES ('a','s1',?)")
    .run(entryJson({ tokens: { input: 100, output: 0 } })); // would count if read
  db.prepare("INSERT INTO message (id, session_id, data) VALUES ('b','s1',?)")
    .run(entryJson({ tokens: { input: 5, output: 0 } }));
  close(db);
  const r = readOpencodeUsage({ home, env, now: NOW });
  assert.ok(r);
  assert.equal(r.days.find((d) => d.date === localDate(daysAgo(1))).tokens, 5, "session_message without `type` is not a store; only v1 row counts");
}

// ============================================================ unreadable / odd files
{
  const { home, env } = sandbox();
  const dir = path.join(env.XDG_DATA_HOME, "opencode");
  fs.mkdirSync(dir, { recursive: true });
  // Zero-byte file: SQLite treats it as an empty database -> no store tables -> null.
  fs.writeFileSync(path.join(dir, "opencode.db"), "");
  assert.equal(readOpencodeUsage({ home, env, now: NOW }), null, "empty file -> null");
  // A directory where the db should be: existsSync passes, open fails -> null.
  fs.rmSync(path.join(dir, "opencode.db"));
  fs.mkdirSync(path.join(dir, "opencode.db"));
  assert.equal(readOpencodeUsage({ home, env, now: NOW }), null, "directory as db -> null, no throw");
  fs.rmSync(path.join(dir, "opencode.db"), { recursive: true });
  // OPENCODE_DB pointing nowhere -> null; pointing at a directory -> null.
  assert.equal(readOpencodeUsage({ home, env: { ...env, OPENCODE_DB: "missing.db" }, now: NOW }), null);
  const subdir = path.join(dir, "a-dir");
  fs.mkdirSync(subdir);
  assert.equal(readOpencodeUsage({ home, env: { ...env, OPENCODE_DB: subdir }, now: NOW }), null);
  // Unreadable file (chmod 000) -> open fails -> null. Skipped when root,
  // which can read anything.
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    const locked = path.join(dir, "locked.db");
    const { db } = makeV2Db(dir, {});
    close(db);
    fs.renameSync(path.join(dir, "opencode.db"), locked);
    fs.chmodSync(locked, 0o000);
    assert.equal(readOpencodeUsage({ home, env: { ...env, OPENCODE_DB: locked }, now: NOW }), null, "unreadable db -> null");
    fs.chmodSync(locked, 0o644);
  }
}
{
  // Legacy-only store end-to-end: opencode-v2.db with a v1 message table.
  const { home, env } = sandbox();
  const dir = path.join(env.XDG_DATA_HOME, "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "opencode-v2.db"));
  db.exec("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)");
  db.prepare("INSERT INTO message (id, session_id, data) VALUES ('l1','s1',?)")
    .run(entryJson({ tokens: { input: 21, output: 0 }, time: { created: daysAgo(1) } }));
  close(db);
  const r = readOpencodeUsage({ home, env, now: NOW });
  assert.ok(r, "legacy filename is used when the normal one is absent");
  assert.equal(r.days.find((d) => d.date === localDate(daysAgo(1))).tokens, 21);
}
{
  // Reading is read-only: the db file's bytes are unchanged afterwards.
  const { home, env } = sandbox();
  const dir = path.join(env.XDG_DATA_HOME, "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const { db, dbPath, insert } = makeV2Db(dir);
  insert("ro", "assistant", entryJson({ tokens: { input: 1, output: 0 } }), daysAgo(1));
  close(db);
  const before = fs.readFileSync(dbPath);
  const r = readOpencodeUsage({ home, env, now: NOW });
  assert.ok(r);
  assert.deepEqual(fs.readFileSync(dbPath), before, "readOpencodeUsage never writes to the db");
}

// ============================================================ repeated calls / determinism
{
  const { home, env } = sandbox();
  const dir = path.join(env.XDG_DATA_HOME, "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const { db, insert } = makeV2Db(dir);
  insert("r1", "assistant", entryJson({ tokens: { input: 10, output: 0 } }), daysAgo(1));
  insert("r2", "compaction", entryJson({ tokens: { input: 5, output: 0 }, modelID: "glm-4.6" }), daysAgo(1));
  close(db);
  const a = readOpencodeUsage({ home, env, now: NOW });
  const b = readOpencodeUsage({ home, env, now: NOW });
  assert.deepEqual(a, b, "same inputs -> identical output, no shared mutable state");
  // A later `now` slides the windows; the same rows age out honestly.
  const later = readOpencodeUsage({ home, env, now: NOW + 40 * DAY });
  assert.equal(later.days.every((d) => d.tokens === 0), true);
  assert.deepEqual(later.models, {});
}

// ---- cleanup -------------------------------------------------------------
for (const d of TMP) fs.rmSync(d, { recursive: true, force: true });

console.log("opencode-usage.deep.test.mjs: all assertions passed");
