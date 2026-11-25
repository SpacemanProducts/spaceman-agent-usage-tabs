// Deeper edge-case pass on bin/qwen-usage.mjs (Qwen Code usage from chat
// transcripts under <runtime>/projects/<project>/chats/*.jsonl). Complements
// qwen-usage.test.mjs, which covers the happy path: total-vs-sum token rule,
// openai/cached/thoughts variants, 30-day window, model label, QWEN_RUNTIME_DIR,
// settings.json runtimeOutputDir and the null-vs-empty store contract. This
// file covers what it doesn't:
//
//   - parseQwenUsageText: wrong-type/scalar input, malformed payload shapes,
//     timestamp/key/forkedFrom edge cases, token coercion quirks, CRLF/BOM
//   - readQwenUsage: QWEN_HOME / runtime-dir resolution edges (~ expansion,
//     relative paths, wrong types, corrupt settings.json), dedup across
//     dirs, file-vs-dir entries, mtime fallback, 7-day model cutoff,
//     window boundaries, future dates, invalid `now`
//   - reentrancy: the module is fully synchronous with no cache, so the only
//     "race" surface is state leaking between calls
//
// Everything lives under one fs.mkdtempSync dir; HOME and the XDG vars are
// pointed there even though this module only honours `home`/`env` arguments.
// Tests that pin down SUSPECTED BUGS assert the current behaviour and say so;
// the one clear data-loss bug is kept commented out under a // BUG line.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseQwenUsageText, readQwenUsage } from "./qwen-usage.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-usage-deep-"));
for (const d of ["home", "state", "config", "cache"])
  fs.mkdirSync(path.join(tmp, d), { recursive: true });
process.env.HOME = path.join(tmp, "home");
process.env.XDG_STATE_HOME = path.join(tmp, "state");
process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
process.env.XDG_CACHE_HOME = path.join(tmp, "cache");

const NOW = new Date(2026, 10, 24, 12, 0, 0).getTime(); // local noon, Tuesday Nov 24 2026
const iso = (y, m, d, h = 10) => new Date(y, m - 1, d, h, 0, 0).toISOString();
const dayStr = (y, m, d) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${y}-${p(m)}-${p(d)}`;
};

// One chat-transcript line. eventOver goes inside systemPayload.uiEvent,
// recordOver at the record level. uuid defaults to a random id.
function telemetry(eventOver = {}, recordOver = {}) {
  return JSON.stringify({
    type: "system",
    subtype: "ui_telemetry",
    uuid: "u-" + Math.random().toString(36).slice(2),
    timestamp: iso(2026, 11, 20),
    systemPayload: {
      uiEvent: {
        "event.name": "qwen-code.api_response",
        "event.timestamp": iso(2026, 11, 20),
        model: "qwen3-coder-plus",
        auth_type: "qwen-oauth",
        response_id: "resp-1",
        input_token_count: 100,
        output_token_count: 50,
        total_token_count: 150,
        ...eventOver,
      },
    },
    ...recordOver,
  });
}

// ------------------------------------------------- parseQwenUsageText: input shapes
assert.deepEqual(parseQwenUsageText(null), []);
assert.deepEqual(parseQwenUsageText(undefined), []);
assert.deepEqual(parseQwenUsageText(""), []);
assert.deepEqual(parseQwenUsageText("   \n\n  \n"), []);
assert.deepEqual(parseQwenUsageText(42), [], "non-string input stringifies to nothing parseable");
assert.deepEqual(parseQwenUsageText({}), [], "objects stringify to '[object Object]' -> unparseable");
// JSON scalars and arrays parse but are skipped.
assert.deepEqual(parseQwenUsageText(["5", '"str"', "null", "true", "[1,2]", "{\"a\":1}"].join("\n")), []);
// A line can mention the event name inside a string value and still parse,
// but wrong record type/subtype/payload shape all drop it.
assert.deepEqual(parseQwenUsageText(JSON.stringify({
  type: "user", subtype: "ui_telemetry", uuid: "x",
  systemPayload: { uiEvent: { "event.name": "qwen-code.api_response", output_token_count: 5 } },
})), [], "right payload under type:user is skipped");
assert.deepEqual(parseQwenUsageText(JSON.stringify({
  type: "system", subtype: "ui_telemetry", uuid: "x",
  systemPayload: { uiEvent: { "event.name": "qwen-code.api_response", output_token_count: 5 } },
}).replace('"type":"system"', '"type":"System"')), [], "type match is case-sensitive");
for (const bad of [null, "str", 5, [], [{ uiEvent: null }]]) {
  assert.deepEqual(parseQwenUsageText(JSON.stringify({
    type: "system", subtype: "ui_telemetry", uuid: "x", systemPayload: bad,
  })), [], `systemPayload=${JSON.stringify(bad)} skipped`);
}
// uiEvent present but not an object / missing event.name.
for (const ev of [null, "str", 5, [], {}]) {
  assert.deepEqual(parseQwenUsageText(JSON.stringify({
    type: "system", subtype: "ui_telemetry", uuid: "x",
    systemPayload: { uiEvent: ev },
  })), [], `uiEvent=${JSON.stringify(ev)} skipped`);
}
assert.deepEqual(parseQwenUsageText(telemetry({ "event.name": "QWEN-CODE.API_RESPONSE" })), [],
  "event.name match is case-sensitive");
assert.deepEqual(parseQwenUsageText(telemetry({ "event.name": "qwen-code.api_response " })), [],
  "trailing space in event.name does not match");

// ------------------------------------------------- parseQwenUsageText: token coercion
// num() quirks: negatives/non-finite -> 0, numeric strings parse, booleans count.
assert.equal(parseQwenUsageText(telemetry({ total_token_count: "500" }))[0].tokens, 500,
  "numeric-string total parses");
assert.equal(parseQwenUsageText(telemetry({ total_token_count: "abc", input_token_count: 10, output_token_count: 5 }))[0].tokens, 15,
  "junk total falls through to the sum");
assert.equal(parseQwenUsageText(telemetry({ total_token_count: -5, input_token_count: 10, output_token_count: 5 }))[0].tokens, 15,
  "negative total falls through to the sum");
assert.equal(parseQwenUsageText(telemetry({ total_token_count: 0, input_token_count: true, output_token_count: 2 }))[0].tokens, 3,
  "quirk: boolean true counts as 1 token");
assert.equal(parseQwenUsageText(telemetry({ total_token_count: 0, input_token_count: Infinity, output_token_count: NaN })).length, 0,
  "non-finite counts -> 0 -> entry skipped (JSON.stringify turns them into null anyway)");
// input wins over cached even when smaller; a non-positive input falls back to cached.
assert.equal(parseQwenUsageText(telemetry({
  total_token_count: 0, input_token_count: 3, cached_content_token_count: 100, output_token_count: 0,
}))[0].tokens, 3, "positive input beats a larger cached count");
assert.equal(parseQwenUsageText(telemetry({
  total_token_count: 0, input_token_count: -5, cached_content_token_count: 30, output_token_count: 0,
}))[0].tokens, 30, "non-positive input falls back to cached");
// auth_type matching is exact: only the three openai-family spellings exclude
// thoughts; anything else (including case variants and missing) adds them.
assert.equal(parseQwenUsageText(telemetry({
  total_token_count: 0, input_token_count: 10, output_token_count: 5, thoughts_token_count: 7, auth_type: "OpenAI",
}))[0].tokens, 22, "auth_type case-sensitive: 'OpenAI' still adds thoughts");
assert.equal(parseQwenUsageText(telemetry({
  total_token_count: 0, input_token_count: 10, output_token_count: 5, thoughts_token_count: 7, auth_type: undefined,
}))[0].tokens, 22, "missing auth_type adds thoughts");
assert.equal(parseQwenUsageText(telemetry({
  total_token_count: 0, input_token_count: 10, output_token_count: 5, thoughts_token_count: 7, auth_type: "openai-responses",
}))[0].tokens, 15, "openai-responses is in the no-thoughts set");

// ------------------------------------------------- parseQwenUsageText: timestamps & keys
// event.timestamp wins over record.timestamp when both parse.
{
  const e = parseQwenUsageText(telemetry(
    { "event.timestamp": iso(2026, 11, 21, 8) },
    { timestamp: iso(2026, 11, 1) },
  ));
  assert.equal(e[0].at, Date.parse(iso(2026, 11, 21, 8)), "event.timestamp beats record.timestamp");
}
// event.timestamp null/undefined falls back to record.timestamp (?? is nullish).
for (const evTs of [null, undefined]) {
  const e = parseQwenUsageText(telemetry({ "event.timestamp": evTs }, { timestamp: iso(2026, 11, 2) }));
  assert.equal(e[0].at, Date.parse(iso(2026, 11, 2)), `event.timestamp=${evTs} falls back to record.timestamp`);
}
// An EMPTY-STRING event.timestamp is not nullish, so the good record.timestamp
// is never consulted and `at` becomes null (the caller then dates the record by
// file mtime). BUG: a blank event.timestamp should fall back like null does.
//
// {
//   const e = parseQwenUsageText(telemetry({ "event.timestamp": "" }, { timestamp: iso(2026, 11, 2) }));
//   assert.equal(e[0].at, Date.parse(iso(2026, 11, 2)),
//     "BUG: empty event.timestamp should fall back to record.timestamp, not drop to null");
// }
assert.equal(parseQwenUsageText(telemetry({ "event.timestamp": "" }, { timestamp: iso(2026, 11, 2) }))[0].at, null,
  "pinned: empty event.timestamp yields at=null despite a valid record.timestamp");
// Numeric / epoch-ms timestamps are not parsed (Date.parse gets a number).
assert.equal(parseQwenUsageText(telemetry({ "event.timestamp": 1764000000000 }))[0].at, null,
  "numeric event.timestamp -> at=null");
assert.equal(parseQwenUsageText(telemetry({ "event.timestamp": "1764000000000" }))[0].at, null,
  "epoch-ms-as-string -> at=null");
// Neither timestamp usable -> at=null; the reader substitutes file mtime.
{
  const e = parseQwenUsageText(telemetry(
    { "event.timestamp": "not-a-date" }, { timestamp: undefined },
  ));
  assert.equal(e[0].at, null, "unparseable timestamps -> at=null");
}
// Key: uuid wins; response_id is the fallback; neither -> record dropped
// (a fork repeats records verbatim and without an id they can't be deduped).
{
  const e = parseQwenUsageText(telemetry({ response_id: "rid-9" }, { uuid: "" }));
  assert.equal(e[0].key, "rid-9", "empty uuid falls back to response_id");
  const noKey = telemetry({ response_id: "" }, { uuid: "" });
  assert.deepEqual(parseQwenUsageText(noKey), [], "no uuid and no response_id -> dropped");
  const numUuid = telemetry({}, { uuid: 123 });
  assert.equal(parseQwenUsageText(numUuid)[0].key, "123", "numeric uuid stringifies");
}
// forkedFrom: any non-null value marks the record as a fork copy — including
// values that aren't session ids ("", 0, false all count as 'forked'). Pinned.
assert.equal(parseQwenUsageText(telemetry({}, { forkedFrom: "parent" }))[0].copy, true);
assert.equal(parseQwenUsageText(telemetry({}, { forkedFrom: "" }))[0].copy, true,
  "quirk: empty-string forkedFrom still marks a copy");
assert.equal(parseQwenUsageText(telemetry({}, { forkedFrom: 0 }))[0].copy, true,
  "quirk: numeric 0 forkedFrom still marks a copy");
assert.equal(parseQwenUsageText(telemetry({}, { forkedFrom: null }))[0].copy, false);
assert.equal(parseQwenUsageText(telemetry({}, { forkedFrom: undefined }))[0].copy, false);
// model is trimmed and stringified at parse time; the 120-char cap is applied
// later by modelLabel inside readQwenUsage.
assert.equal(parseQwenUsageText(telemetry({ model: "  padded/model  " }))[0].model, "padded/model");
assert.equal(parseQwenUsageText(telemetry({ model: 42 }))[0].model, "42", "numeric model stringifies");
// Line-ending quirks: CRLF parses; a UTF-8 BOM kills only the first line.
assert.equal(parseQwenUsageText(telemetry() + "\r\n")[0].tokens, 150, "CRLF tolerated");
assert.deepEqual(parseQwenUsageText("﻿" + [telemetry({ total_token_count: 9 }, { uuid: "bom-1" }),
  telemetry({ total_token_count: 3 }, { uuid: "bom-2" })].join("\n")).map((e) => e.key),
  ["bom-2"], "BOM corrupts the first line only");
// Parse does NOT dedup: two identical records come back as two entries.
assert.equal(parseQwenUsageText(telemetry({}, { uuid: "dup" }) + "\n" + telemetry({}, { uuid: "dup" })).length, 2,
  "dedup happens in readQwenUsage, not here");

// ------------------------------------------------- readQwenUsage: helpers
function makeRoot() {
  const root = fs.mkdtempSync(path.join(tmp, "case-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  return { root, home };
}
// Standard layout: <home>/.qwen/projects/<proj>/chats/<file>.jsonl
const qwenDir = (home) => path.join(home, ".qwen");
const chatsDir = (base, proj = "p", name = "s.jsonl") => {
  const d = path.join(base, "projects", proj, "chats");
  fs.mkdirSync(d, { recursive: true });
  return { dir: d, file: path.join(d, name) };
};
const dayTokens = (r, y, m, d) => r.days.find((x) => x.date === dayStr(y, m, d))?.tokens ?? 0;
const totalTokens = (r) => (r ? r.days.reduce((s, d) => s + d.tokens, 0) : 0);

// ------------------------------------------------- readQwenUsage: dir resolution
// QWEN_HOME relocates the whole qwen home (projects AND settings.json live there).
{
  const { root, home } = makeRoot();
  const qhome = path.join(root, "my-qwen");
  const { file } = chatsDir(qhome);
  fs.writeFileSync(file, telemetry({ "event.timestamp": iso(2026, 11, 23), total_token_count: 11 }, { uuid: "qh-1" }));
  const r = readQwenUsage({ home, env: { QWEN_HOME: qhome }, now: NOW });
  assert.equal(dayTokens(r, 2026, 11, 23), 11, "QWEN_HOME is scanned");
  // ...and the default ~/.qwen is NOT scanned when QWEN_HOME is set.
  const def = chatsDir(qwenDir(home));
  fs.writeFileSync(def.file, telemetry({ "event.timestamp": iso(2026, 11, 23), total_token_count: 999 }, { uuid: "qh-2" }));
  const r2 = readQwenUsage({ home, env: { QWEN_HOME: qhome }, now: NOW });
  assert.equal(dayTokens(r2, 2026, 11, 23), 11, "QWEN_HOME replaces ~/.qwen, not adds to it");
}
// QWEN_HOME="~" expands to the home dir itself: projects live at <home>/projects.
{
  const { root, home } = makeRoot();
  const { file } = chatsDir(home); // <home>/projects/p/chats/s.jsonl
  fs.writeFileSync(file, telemetry({ "event.timestamp": iso(2026, 11, 23), total_token_count: 5 }, { uuid: "tilde-1" }));
  const r = readQwenUsage({ home, env: { QWEN_HOME: "~" }, now: NOW });
  assert.equal(dayTokens(r, 2026, 11, 23), 5, "QWEN_HOME='~' -> home itself");
}
// QWEN_HOME="~/sub" expands under home.
{
  const { root, home } = makeRoot();
  const qhome = path.join(home, "sub-qwen");
  const { file } = chatsDir(qhome);
  fs.writeFileSync(file, telemetry({ "event.timestamp": iso(2026, 11, 23), total_token_count: 6 }, { uuid: "tilde-2" }));
  const r = readQwenUsage({ home, env: { QWEN_HOME: "~/sub-qwen" }, now: NOW });
  assert.equal(dayTokens(r, 2026, 11, 23), 6, "QWEN_HOME='~/x' expands under home");
}
// Relative and wrong-type dir values are ignored (resolveDir requires absolute).
{
  const { root, home } = makeRoot();
  const { file } = chatsDir(qwenDir(home));
  fs.writeFileSync(file, telemetry({ "event.timestamp": iso(2026, 11, 23), total_token_count: 8 }, { uuid: "rel-1" }));
  for (const bad of ["relative/path", "  ", "", 42, null, {}, ["/x"]]) {
    const r = readQwenUsage({ home, env: { QWEN_RUNTIME_DIR: bad, QWEN_HOME: bad }, now: NOW });
    assert.equal(dayTokens(r, 2026, 11, 23), 8, `env value ${JSON.stringify(bad)} ignored -> ~/.qwen still read`);
  }
}
// QWEN_RUNTIME_DIR="~" -> projects at <home>/projects; "~/rt" likewise.
{
  const { root, home } = makeRoot();
  const { file } = chatsDir(home);
  fs.writeFileSync(file, telemetry({ "event.timestamp": iso(2026, 11, 23), total_token_count: 4 }, { uuid: "rt-tilde" }));
  const r = readQwenUsage({ home, env: { QWEN_RUNTIME_DIR: "~" }, now: NOW });
  assert.equal(dayTokens(r, 2026, 11, 23), 4, "QWEN_RUNTIME_DIR='~' -> home/projects");
}
// QWEN_HOME pointing at a regular FILE: resolveDir accepts it (it's absolute),
// projects/<...> under a file can't be read -> no store -> null. The default
// ~/.qwen is NOT used as a fallback because QWEN_HOME was set. Pinned.
{
  const { root, home } = makeRoot();
  const fileHome = path.join(root, "qwen-is-a-file");
  fs.writeFileSync(fileHome, "not a dir");
  const { file } = chatsDir(qwenDir(home)); // would be found via default, but QWEN_HOME overrides
  fs.writeFileSync(file, telemetry({ total_token_count: 50 }, { uuid: "file-home" }));
  assert.equal(readQwenUsage({ home, env: { QWEN_HOME: fileHome }, now: NOW }), null,
    "QWEN_HOME=file -> null (no fallback to ~/.qwen)");
}

// ------------------------------------------------- readQwenUsage: settings.json edges
// Corrupt / non-object / wrong-typed runtimeOutputDir all degrade to qhome only.
{
  const { root, home } = makeRoot();
  fs.mkdirSync(qwenDir(home), { recursive: true });
  const rt = path.join(root, "rt-from-settings");
  const good = chatsDir(rt);
  fs.writeFileSync(good.file, telemetry({ "event.timestamp": iso(2026, 11, 23), total_token_count: 21 }, { uuid: "set-1" }));
  for (const [label, contents] of [
    ["corrupt JSON", "{not json"],
    ["JSON null", "null"],
    ["JSON array", "[1,2]"],
    ["JSON string", '"hello"'],
    ["advanced not object", JSON.stringify({ advanced: "nope" })],
    ["runtimeOutputDir relative", JSON.stringify({ advanced: { runtimeOutputDir: "rel/dir" } })],
    ["runtimeOutputDir number", JSON.stringify({ advanced: { runtimeOutputDir: 42 } })],
    ["runtimeOutputDir empty", JSON.stringify({ advanced: { runtimeOutputDir: "  " } })],
  ]) {
    fs.writeFileSync(path.join(qwenDir(home), "settings.json"), contents);
    const r = readQwenUsage({ home, env: {}, now: NOW });
    assert.equal(totalTokens(r), 0, `settings.json ${label} -> runtime dir ignored (null or zero-map)`);
  }
  // settings.json that is a DIRECTORY: readFileSync throws EISDIR -> caught.
  fs.rmSync(path.join(qwenDir(home), "settings.json"));
  fs.mkdirSync(path.join(qwenDir(home), "settings.json"));
  assert.equal(totalTokens(readQwenUsage({ home, env: {}, now: NOW })), 0,
    "settings.json as a directory -> ignored");
  fs.rmSync(path.join(qwenDir(home), "settings.json"), { recursive: true });
  // A valid one works, including "~" expansion inside it.
  fs.writeFileSync(path.join(qwenDir(home), "settings.json"),
    JSON.stringify({ advanced: { runtimeOutputDir: "~/rt-from-tilde" } }));
  const tildeRt = chatsDir(path.join(home, "rt-from-tilde"));
  fs.writeFileSync(tildeRt.file, telemetry({ "event.timestamp": iso(2026, 11, 23), total_token_count: 33 }, { uuid: "set-2" }));
  const r = readQwenUsage({ home, env: {}, now: NOW });
  assert.equal(dayTokens(r, 2026, 11, 23), 33, "settings.json runtimeOutputDir='~/x' expands under home");
}
// settings.json is read from QWEN_HOME when set, not from ~/.qwen.
{
  const { root, home } = makeRoot();
  const qhome = path.join(root, "qwh");
  fs.mkdirSync(qhome, { recursive: true });
  const rt = path.join(root, "rt-via-qwh");
  const c = chatsDir(rt);
  fs.writeFileSync(c.file, telemetry({ "event.timestamp": iso(2026, 11, 23), total_token_count: 17 }, { uuid: "qwh-set" }));
  fs.writeFileSync(path.join(qhome, "settings.json"), JSON.stringify({ advanced: { runtimeOutputDir: rt } }));
  const r = readQwenUsage({ home, env: { QWEN_HOME: qhome }, now: NOW });
  assert.equal(dayTokens(r, 2026, 11, 23), 17, "settings.json honoured under QWEN_HOME");
}
// Both env runtime dir and settings runtime dir are scanned; equal dirs dedup.
{
  const { root, home } = makeRoot();
  const rtA = path.join(root, "rt-a");
  const rtB = path.join(root, "rt-b");
  const a = chatsDir(rtA); const b = chatsDir(rtB);
  fs.writeFileSync(a.file, telemetry({ "event.timestamp": iso(2026, 11, 23), total_token_count: 10 }, { uuid: "multi-a" }));
  fs.writeFileSync(b.file, telemetry({ "event.timestamp": iso(2026, 11, 22), total_token_count: 20 }, { uuid: "multi-b" }));
  fs.mkdirSync(qwenDir(home), { recursive: true });
  fs.writeFileSync(path.join(qwenDir(home), "settings.json"),
    JSON.stringify({ advanced: { runtimeOutputDir: rtB } }));
  const r = readQwenUsage({ home, env: { QWEN_RUNTIME_DIR: rtA }, now: NOW });
  assert.equal(dayTokens(r, 2026, 11, 23), 10);
  assert.equal(dayTokens(r, 2026, 11, 22), 20, "env dir AND settings dir both scanned");
  // Same dir via env and settings (and a trailing-slash variant) -> files deduped.
  const r2 = readQwenUsage({ home, env: { QWEN_RUNTIME_DIR: rtB + "/" }, now: NOW });
  assert.equal(dayTokens(r2, 2026, 11, 22), 20, "same file reachable twice is counted once");
}

// ------------------------------------------------- readQwenUsage: filesystem edges
// projects/ exists but is a regular FILE -> readdirSync throws -> that dir skipped.
{
  const { root, home } = makeRoot();
  fs.mkdirSync(qwenDir(home), { recursive: true });
  fs.writeFileSync(path.join(qwenDir(home), "projects"), "i am a file");
  const good = path.join(root, "other");
  const c = chatsDir(good);
  fs.writeFileSync(c.file, telemetry({ "event.timestamp": iso(2026, 11, 23), total_token_count: 3 }, { uuid: "fs-1" }));
  const r = readQwenUsage({ home, env: { QWEN_RUNTIME_DIR: good }, now: NOW });
  assert.equal(dayTokens(r, 2026, 11, 23), 3, "broken projects/ in qhome doesn't sink the env dir");
}
// chats/ as a regular file, and project entries that are files -> skipped.
{
  const { root, home } = makeRoot();
  const base = qwenDir(home);
  fs.mkdirSync(path.join(base, "projects"), { recursive: true });
  fs.writeFileSync(path.join(base, "projects", "a-file-project"), "x"); // project that is a file
  fs.mkdirSync(path.join(base, "projects", "p2"));
  fs.writeFileSync(path.join(base, "projects", "p2", "chats"), "x"); // chats that is a file
  const c = chatsDir(base, "p3");
  fs.writeFileSync(c.file, telemetry({ "event.timestamp": iso(2026, 11, 23), total_token_count: 9 }, { uuid: "fs-2" }));
  const r = readQwenUsage({ home, env: {}, now: NOW });
  assert.equal(dayTokens(r, 2026, 11, 23), 9, "non-dir projects/chats entries skipped");
}
// File-name filter: only *.jsonl, never *.ledger.jsonl. Case-sensitive; a file
// literally named "ledger.jsonl" (no dot before 'ledger') is NOT excluded —
// pinned quirk. ".jsonl" alone and "x.JSONL" behave as expected.
{
  const { home } = makeRoot();
  const c = chatsDir(qwenDir(home));
  fs.writeFileSync(c.file.replace("s.jsonl", "a.JSONL"),
    telemetry({ "event.timestamp": iso(2026, 11, 23), total_token_count: 100 }, { uuid: "case-1" }));
  fs.writeFileSync(c.file.replace("s.jsonl", "b.jsonl.bak"),
    telemetry({ "event.timestamp": iso(2026, 11, 23), total_token_count: 100 }, { uuid: "case-2" }));
  fs.writeFileSync(c.file.replace("s.jsonl", "ledger.jsonl"),
    telemetry({ "event.timestamp": iso(2026, 11, 23), total_token_count: 77 }, { uuid: "case-3" }));
  const r = readQwenUsage({ home, env: {}, now: NOW });
  assert.equal(dayTokens(r, 2026, 11, 23), 77, "uppercase .JSONL and .bak skipped; bare 'ledger.jsonl' is read");
}
// A DIRECTORY named x.jsonl: readdirSync lists it, readFileSync throws EISDIR,
// the file is skipped — and because storePresent is only set after a
// SUCCESSFUL read, a chats dir containing only that yields null, not a
// zero-map. Inconsistent with a corrupt-but-readable file (which gives the
// zero-map). Pinned, reported.
{
  const { home } = makeRoot();
  const c = chatsDir(qwenDir(home));
  fs.mkdirSync(path.join(c.dir, "dir.jsonl"), { recursive: true });
  assert.equal(readQwenUsage({ home, env: {}, now: NOW }), null,
    "only an unreadable 'x.jsonl' directory -> null (store treated as absent)");
  // ...but add a readable corrupt file and the store counts as present.
  fs.writeFileSync(path.join(c.dir, "real.jsonl"), "garbage\n");
  const r = readQwenUsage({ home, env: {}, now: NOW });
  assert.ok(r, "readable file present -> result object");
  assert.equal(r.days.reduce((s, d) => s + d.tokens, 0), 0);
}
// Empty chats dir / no jsonl at all -> null (no store).
{
  const { home } = makeRoot();
  chatsDir(qwenDir(home)); // creates dirs, no files
  assert.equal(readQwenUsage({ home, env: {}, now: NOW }), null, "empty chats dir -> null");
}
// Unreadable-timestamp records are dated by the file's MTIME (like Qwen Code's
// own statistics). utimesSync gives the file a known mtime inside the window.
{
  const { home } = makeRoot();
  const c = chatsDir(qwenDir(home));
  // No event.timestamp and no record.timestamp at all.
  const line = JSON.stringify({
    type: "system", subtype: "ui_telemetry", uuid: "mtime-1",
    systemPayload: { uiEvent: {
      "event.name": "qwen-code.api_response", model: "m",
      output_token_count: 40, total_token_count: 40,
    } },
  });
  fs.writeFileSync(c.file, line + "\n");
  const mtime = new Date(2026, 10, 21, 15, 0, 0);
  fs.utimesSync(c.file, mtime, mtime);
  const r = readQwenUsage({ home, env: {}, now: NOW });
  assert.equal(dayTokens(r, 2026, 11, 21), 40, "timestamp-less record dated by file mtime");
  assert.equal(dayTokens(r, 2026, 11, 20), 0, "not counted on any other day");
}

// ------------------------------------------------- readQwenUsage: dedup & windows
// Same uuid in two runtime dirs: counted once; an original beats a fork copy
// regardless of scan order (dir order is deterministic: env, settings, qhome).
{
  const { root, home } = makeRoot();
  const rt = path.join(root, "rt-dedup");
  const envChats = chatsDir(rt);
  const homeChats = chatsDir(qwenDir(home));
  // env dir scanned FIRST: put the fork copy there, the original in qhome.
  fs.writeFileSync(envChats.file,
    telemetry({ total_token_count: 100 }, { uuid: "shared-1", forkedFrom: "parent" }));
  fs.writeFileSync(homeChats.file,
    telemetry({ total_token_count: 200 }, { uuid: "shared-1" }));
  const r = readQwenUsage({ home, env: { QWEN_RUNTIME_DIR: rt }, now: NOW });
  assert.equal(dayTokens(r, 2026, 11, 20), 200, "original wins over fork copy even when copy scanned first");
  // Reverse: original in env dir, copy in qhome.
  const { root: root2, home: home2 } = makeRoot();
  const rt2 = path.join(root2, "rt-dedup2");
  fs.writeFileSync(chatsDir(rt2).file,
    telemetry({ total_token_count: 300 }, { uuid: "shared-2" }));
  fs.writeFileSync(chatsDir(qwenDir(home2)).file,
    telemetry({ total_token_count: 100 }, { uuid: "shared-2", forkedFrom: "p" }));
  const r2 = readQwenUsage({ home: home2, env: { QWEN_RUNTIME_DIR: rt2 }, now: NOW });
  assert.equal(dayTokens(r2, 2026, 11, 20), 300, "original wins when scanned first too");
}
// Window boundaries: the 30-day window is the last 30 LOCAL dates ending today.
// Oct 26 is exactly 29 days before Nov 24 -> included; Oct 25 -> excluded;
// a future-dated record is excluded too.
{
  const { home } = makeRoot();
  const c = chatsDir(qwenDir(home));
  fs.writeFileSync(c.file, [
    telemetry({ "event.timestamp": new Date(2026, 9, 26, 0, 1).toISOString(), total_token_count: 1 }, { uuid: "edge-in" }),
    telemetry({ "event.timestamp": new Date(2026, 9, 25, 23, 59).toISOString(), total_token_count: 2 }, { uuid: "edge-out" }),
    telemetry({ "event.timestamp": new Date(2026, 10, 25, 0, 1).toISOString(), total_token_count: 4 }, { uuid: "edge-future" }),
  ].join("\n"));
  const r = readQwenUsage({ home, env: {}, now: NOW });
  assert.equal(dayTokens(r, 2026, 10, 26), 1, "first day of window included");
  assert.equal(dayTokens(r, 2026, 10, 25) + dayTokens(r, 2026, 10, 24), 0, "day 30 back excluded");
  assert.equal(r.days.reduce((s, d) => s + d.tokens, 0), 1, "future record excluded; total is just the boundary hit");
}
// Models map covers only the last 7 local days (Nov 18..24); a record 8 days
// back still lands in `days`. Label rules: last path segment, <=120 chars,
// empty/unlabelable models drop out of `models` but keep their day tokens.
{
  const { home } = makeRoot();
  const c = chatsDir(qwenDir(home));
  fs.writeFileSync(c.file, [
    telemetry({ model: "vendor/a/b/final-model", "event.timestamp": iso(2026, 11, 20), total_token_count: 10 }, { uuid: "mod-1" }),
    telemetry({ model: "old-model", "event.timestamp": iso(2026, 11, 16), total_token_count: 20 }, { uuid: "mod-2" }),
    telemetry({ model: "", "event.timestamp": iso(2026, 11, 20), total_token_count: 30 }, { uuid: "mod-3" }),
    telemetry({ model: "vendor/" + "y".repeat(130), "event.timestamp": iso(2026, 11, 20), total_token_count: 40 }, { uuid: "mod-4" }),
  ].join("\n"));
  const r = readQwenUsage({ home, env: {}, now: NOW });
  assert.equal(dayTokens(r, 2026, 11, 16), 20, "8-day-old record still in days");
  assert.deepEqual(r.models, { "final-model": 10 },
    "models: last-7-days only, last path segment, empty and >120-char labels dropped");
  assert.equal(r.days.reduce((s, d) => s + d.tokens, 0), 100, "all four records counted in days");
}
// `now` edges: an ISO string works; an invalid `now` doesn't throw — it
// produces NaN-dated rows and (store present) a zero-token result. Pinned.
{
  const { home } = makeRoot();
  const c = chatsDir(qwenDir(home));
  fs.writeFileSync(c.file, telemetry({ total_token_count: 5 }, { uuid: "now-1" }));
  const r = readQwenUsage({ home, env: {}, now: "2026-11-24T12:00:00" });
  assert.equal(dayTokens(r, 2026, 11, 20), 5, "ISO-string now works");
  const bad = readQwenUsage({ home, env: {}, now: "not-a-date" });
  assert.ok(bad, "invalid now still returns a result (store present)");
  assert.ok(bad.days.every((d) => Number.isNaN(Date.parse(d.date + "T00:00:00")) || d.tokens === 0),
    "invalid now -> no day can match -> zero tokens");
}

// ------------------------------------------------- reentrancy / no shared state
// The module keeps no cache: every call re-reads disk, results are fresh
// objects, and mutating one cannot leak into the next.
{
  const { home } = makeRoot();
  const c = chatsDir(qwenDir(home));
  fs.writeFileSync(c.file, telemetry({ "event.timestamp": iso(2026, 11, 20), total_token_count: 5 }, { uuid: "re-1" }));
  const a = readQwenUsage({ home, env: {}, now: NOW });
  const b = readQwenUsage({ home, env: {}, now: NOW });
  assert.deepEqual(a, b, "two calls agree");
  assert.notEqual(a.days, b.days);
  a.days[0].tokens = 999999;
  a.models["injected"] = 1;
  const c2 = readQwenUsage({ home, env: {}, now: NOW });
  assert.equal(c2.days.find((d) => d.date === dayStr(2026, 11, 20)).tokens, 5, "mutation doesn't leak");
  assert.equal(c2.models.injected, undefined);
  // parseQwenUsageText likewise returns fresh arrays per call.
  const t = telemetry();
  const p1 = parseQwenUsageText(t), p2 = parseQwenUsageText(t);
  assert.notEqual(p1, p2);
  assert.notEqual(p1[0], p2[0]);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("qwen-usage.deep.test.mjs: ok");
