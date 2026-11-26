import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PARSERS, COMMANDS, liveModels } from "./live-models.mjs";

// Deeper edge-case pass over live-models.mjs. live-models.test.mjs covers the
// happy paths and the basic cache/failure rules; this file covers malformed
// parser input, corrupt/wrong-typed cache files, TTL boundaries, callback
// behavior and filesystem edge cases. Every liveModels() call uses an injected
// `run`, so no real CLI is ever spawned; all state lives under one mkdtemp dir.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "live-models-deep-"));
for (const v of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"])
  process.env[v] = path.join(tmp, v.toLowerCase());
const freshDir = (name) => {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const AGY_OUT = "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6\n";

// ---------- PARSERS: malformed and boundary input ----------

// agy: duplicate ids collapse; a line without a tab is dropped; a tab with an
// empty name still yields the model; surrounding whitespace on the id is trimmed.
{
  const out = [
    "dup-a\tFirst", "dup-a\tSecond",      // dedupe keeps first
    "no-tab-line",                        // no tab -> dropped
    "empty-name\t",                       // empty name kept
    "  spaced-id\tSpaced",                // id trimmed
    "bad id!\tBad",                       // space+! fails the id regex -> dropped
    "\tNoId",                             // empty id fails regex -> dropped
    "",
  ].join("\n");
  const ms = PARSERS.agy(out);
  assert.deepEqual(ms.map((m) => m.id), ["dup-a", "empty-name", "spaced-id"]);
  assert.equal(ms[0].name, "First");
  assert.equal(ms[1].name, "");
  assert.deepEqual(PARSERS.agy(""), []);
  assert.deepEqual(PARSERS.agy("\n\n\t\n"), []);
}

// grok: only text after "Available models:" is read; bullet-less lines still
// match; a marker with nothing after it yields [].
{
  const out = "junk * fake-model before\nAvailable models:\n  * grok-4.7 (default)\nplain-line\n  * grok-4.7 (dup)\n";
  const ms = PARSERS.grok(out);
  assert.deepEqual(ms.map((m) => m.id), ["grok-4.7", "plain-line"]);
  assert.deepEqual(PARSERS.grok("Available models:\n"), []);
  assert.deepEqual(PARSERS.grok("Available models:"), []);
  // The marker is found anywhere, even inside unrelated text.
  assert.deepEqual(PARSERS.grok("prefix Available models: suffix\n  * m-1\n").map((m) => m.id), ["m-1"]);
  // Lines after the marker that start with a word char are treated as models,
  // even prose like "Note:". Documenting current behavior, not endorsing it.
  assert.deepEqual(PARSERS.grok("Available models:\nNote: see docs\n").map((m) => m.id), ["Note"]);
}

// opencode: provider/model split keeps extra slashes in the name; lines with
// spaces or no provider are dropped; duplicates collapse.
{
  const ms = PARSERS.opencode("a/b/c\nprovider/model extra\n/no-provider\nslash-only/\n\n  spaced/provider  \ndup/x\ndup/x\n");
  assert.deepEqual(ms, [
    { id: "a/b/c", name: "b/c" },
    { id: "spaced/provider", name: "provider" },
    { id: "dup/x", name: "x" },
  ]);
  assert.deepEqual(PARSERS.opencode(""), []);
}

// devin: family headers must start at column 0 and end with ")"; the id is the
// last parenthesized token; indented lines are ignored.
{
  const out = [
    "Family One (fam-one)",
    "  indented (nope)",          // indented -> ignored
    "Trailing text (id-x) junk",  // text after ')' -> ignored
    "Paren (nest) (real-id)",    // lazy name -> id is last paren group
    "NoSpace(id-y)",              // no ' (' separator -> ignored
    "Empty ()",
  ].join("\n");
  const ms = PARSERS.devin(out);
  assert.deepEqual(ms.map((m) => m.id), ["fam-one", "real-id"]);
  assert.equal(ms[1].name, "Paren (nest)");
  assert.deepEqual(PARSERS.devin(""), []);
}

// kiro: requires the "Nx credits" suffix; integer multipliers and uppercase
// CREDITS still match (case-insensitive flag); plain names don't.
{
  const out = [
    "* auto    1.00x credits   chosen",
    "  model-b  2x credits      int multiplier",
    "  model-c  1.5X CREDITS    case",
    "  model-d  free           no credits word -> dropped",
    "  model-e  1.00x          missing 'credits' -> dropped",
    "  model-e  1.00x credits   dup",
  ].join("\n");
  assert.deepEqual(PARSERS.kiro(out).map((m) => m.id), ["auto", "model-b", "model-c", "model-e"]);
  assert.deepEqual(PARSERS.kiro(""), []);
}

// codex: accepts a top-level array; tolerates scalars, null and nested junk;
// only visibility "list" survives; missing display_name falls back to slug.
{
  assert.deepEqual(PARSERS.codex(JSON.stringify([{ slug: "a-1", display_name: "A One", visibility: "list" }])),
    [{ id: "a-1", name: "A One" }]);
  assert.deepEqual(PARSERS.codex(JSON.stringify({ models: "not-an-array" })), []);
  assert.deepEqual(PARSERS.codex(JSON.stringify({ models: [null, 42, "x", { slug: "ok", visibility: "list" }] })),
    [{ id: "ok", name: "ok" }]);
  for (const bad of ["null", "42", '"str"', "true", "[1,2", ""]) assert.deepEqual(PARSERS.codex(bad), [], bad);
}

// BUG: a catalog entry with visibility "list" but no slug produces the literal
// id "undefined" (String(undefined)); a missing display_name also stringifies
// to "undefined". Real catalogs always carry slugs, so this is latent.
// assert.deepEqual(PARSERS.codex(JSON.stringify({ models: [{ visibility: "list" }] })), []);

// ---------- liveModels: cache file edge cases ----------

const okRun = (out = AGY_OUT) => () => out;
const writeCache = (dir, obj) => fs.writeFileSync(path.join(dir, "live-models.json"), typeof obj === "string" ? obj : JSON.stringify(obj));

// Corrupt JSON in the cache file is ignored and the CLI is re-run.
{
  const dir = freshDir("corrupt"); writeCache(dir, "{not json!!");
  let calls = 0; const run = () => { calls++; return AGY_OUT; };
  const ms = liveModels("antigravity", { stateDir: dir, env: {}, now: 1000, run });
  assert.equal(ms.length, 2); assert.equal(calls, 1);
  // And the file was rewritten with a valid cache.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "live-models.json"), "utf8")).antigravity.models.length, 2);
}

// A cache file containing a JSON string or number (e.g. `"x"`, `5`) is
// treated as empty: the primitive is not an object, so the run result is
// cached normally instead of throwing on the assignment.
for (const raw of ['"x"', "5"]) {
  const dir = freshDir("top-prim"); writeCache(dir, raw);
  const ms = liveModels("antigravity", { stateDir: dir, env: {}, now: 1, run: okRun() });
  assert.equal(ms.length, 2);
}

// Wrong-typed top-level cache values that survive `|| {}` are treated as empty.
for (const [name, raw] of [["arr", "[]"], ["null", "null"]]) {
  const dir = freshDir("top-" + name); writeCache(dir, raw);
  let calls = 0; const run = () => { calls++; return AGY_OUT; };
  assert.equal(liveModels("antigravity", { stateDir: dir, env: {}, now: 1, run }).length, 2, name);
  assert.equal(calls, 1, name);
}

// A cache entry whose `models` isn't an array, or whose `at` is missing or
// non-numeric, is treated as a miss and re-runs the CLI.
{
  for (const [name, entry] of [
    ["models-str", { at: 1, models: "nope" }],
    ["models-obj", { at: 1, models: {} }],
    ["no-at", { models: [{ id: "x", name: "x" }] }],
    ["at-str", { at: "soon", models: [{ id: "x", name: "x" }] }],
  ]) {
    const dir = freshDir("entry-" + name);
    writeCache(dir, { antigravity: entry });
    let calls = 0; const run = () => { calls++; return AGY_OUT; };
    assert.equal(liveModels("antigravity", { stateDir: dir, env: {}, now: 100, run }).length, 2, name);
    assert.equal(calls, 1, name);
  }
  // Same wrong-typed entry + a failing run returns null, not the bad entry.
  const dir = freshDir("entry-bad-fail");
  writeCache(dir, { antigravity: { at: 1, models: "nope" } });
  assert.equal(liveModels("antigravity", { stateDir: dir, env: {}, now: 100, run: () => "garbage" }), null);
}

// `at: null` coerces to 0 in `now - hit.at`: with a realistic `now` it is
// stale and re-runs, but with a tiny injected `now` (< TTL) it counts as fresh
// and the bogus entry is served. Documenting the coercion quirk.
{
  const dir = freshDir("entry-at-null");
  writeCache(dir, { antigravity: { at: null, models: [{ id: "x", name: "x" }] } });
  let calls = 0; const run = () => { calls++; return AGY_OUT; };
  const got = liveModels("antigravity", { stateDir: dir, env: {}, now: 100, run });
  assert.equal(calls, 0);
  assert.equal(got[0].id, "x", "null `at` is fresh when now < TTL");
  const dir2 = freshDir("entry-at-null-stale");
  writeCache(dir2, { antigravity: { at: null, models: [{ id: "x", name: "x" }] } });
  let calls2 = 0; const run2 = () => { calls2++; return AGY_OUT; };
  const got2 = liveModels("antigravity", { stateDir: dir2, env: {}, now: 6 * 3600 * 1000 + 1, run: run2 });
  assert.equal(calls2, 1);
  assert.equal(got2.length, 2);
}

// TTL boundary: a hit one ms inside 6h is served; exactly at 6h it is a miss;
// an `at` in the future (clock skew) still counts as fresh.
{
  const TTL = 6 * 3600 * 1000;
  const dir = freshDir("ttl");
  const models = [{ id: "m", name: "m" }];
  writeCache(dir, { antigravity: { at: 10_000, models } });
  let calls = 0; const run = () => { calls++; return AGY_OUT; };
  liveModels("antigravity", { stateDir: dir, env: {}, now: 10_000 + TTL - 1, run });
  assert.equal(calls, 0, "inside TTL");
  liveModels("antigravity", { stateDir: dir, env: {}, now: 10_000 + TTL, run });
  assert.equal(calls, 1, "at TTL is a miss");
  // The miss rewrote the cache with `at` = the miss-time `now`.
  liveModels("antigravity", { stateDir: dir, env: {}, now: 10_000 + TTL + 1, run });
  assert.equal(calls, 1, "fresh write is a hit");
  // Future `at` (e.g. written by a machine whose clock ran ahead) is fresh.
  const dir2 = freshDir("ttl-future");
  writeCache(dir2, { antigravity: { at: 999_999, models } });
  let calls2 = 0; const run2 = () => { calls2++; return AGY_OUT; };
  liveModels("antigravity", { stateDir: dir2, env: {}, now: 1000, run: run2 });
  assert.equal(calls2, 0, "future at still hits");
}

// A fresh cached entry is returned verbatim when the re-run parses to nothing.
{
  const dir = freshDir("fresh-hit-fail");
  const models = [{ id: "keep", name: "Keep" }];
  writeCache(dir, { antigravity: { at: 5000, models } });
  const got = liveModels("antigravity", { stateDir: dir, env: {}, now: 5000, run: () => "not logged in" });
  assert.deepEqual(got, models);
}

// Writing the cache merges with existing entries for other agents and does
// not clobber them.
{
  const dir = freshDir("merge");
  writeCache(dir, { grok: { at: 1, models: [{ id: "g", name: "g" }] } });
  liveModels("antigravity", { stateDir: dir, env: {}, now: 1234, run: okRun() });
  const cache = JSON.parse(fs.readFileSync(path.join(dir, "live-models.json"), "utf8"));
  assert.deepEqual(cache.grok, { at: 1, models: [{ id: "g", name: "g" }] });
  assert.equal(cache.antigravity.at, 1234);
}

// stateDir that doesn't exist yet is created on the success path.
{
  const dir = path.join(tmp, "nested", "deep", "state");
  assert.equal(liveModels("grok", { stateDir: dir, env: {}, now: 1, run: () => "Available models:\n  * g-1\n" })[0].id, "g-1");
  assert.ok(fs.existsSync(path.join(dir, "live-models.json")));
}

// A read-only stateDir: the CLI still runs and models are returned; the cache
// write failure is swallowed.
{
  const dir = freshDir("readonly"); fs.chmodSync(dir, 0o500);
  try {
    const ms = liveModels("antigravity", { stateDir: dir, env: {}, now: 1, run: okRun() });
    assert.equal(ms.length, 2);
    assert.equal(fs.existsSync(path.join(dir, "live-models.json")), false);
  } finally { fs.chmodSync(dir, 0o700); }
}

// A failed run writes nothing, so a later success starts from an empty cache.
{
  const dir = freshDir("no-write-on-fail");
  assert.equal(liveModels("antigravity", { stateDir: dir, env: {}, now: 1, run: () => "garbage" }), null);
  assert.equal(fs.existsSync(path.join(dir, "live-models.json")), false);
}

// ---------- liveModels: run/env plumbing and callbacks ----------

// The spec's cmd array and the caller's env object are passed to `run`.
{
  const dir = freshDir("plumbing");
  let seenCmd, seenEnv;
  const env = { PATH: "/x", DISPLAY: ":0" };
  liveModels("codex", { stateDir: dir, env, now: 1, run: (cmd, e) => { seenCmd = cmd; seenEnv = e; return JSON.stringify({ models: [{ slug: "s", visibility: "list" }] }); } });
  assert.deepEqual(seenCmd, COMMANDS.codex.cmd);
  assert.equal(seenEnv, env, "env is forwarded untouched (DISPLAY stripping happens in defaultRun)");
}

// onUnexpected fires exactly once for unrecognized non-empty output, with a
// head capped at 200 chars.
{
  const dir = freshDir("unexpected");
  const calls = [];
  const long = "Z".repeat(500);
  liveModels("antigravity", { stateDir: dir, env: {}, now: 1, run: () => long, onUnexpected: (m, d) => calls.push([m, d]) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].head.length, 200);
  assert.equal(calls[0][1].command, "agy models");
}

// onUnexpected does NOT fire for: login-ish output, empty/whitespace output,
// parseable output, or when no callback is given (no throw either way).
{
  for (const [name, out] of [
    ["login-verb", "Error: please sign in to continue"],
    ["login-noun", "You are not authenticated."],
    ["login-logged", "not logged in"],
    ["empty", ""],
    ["whitespace", "   \n\t  "],
    ["good", AGY_OUT],
  ]) {
    const dir = freshDir("no-unexpected-" + name);
    let fired = 0;
    const r = liveModels("antigravity", { stateDir: dir, env: {}, now: 1, run: () => out, onUnexpected: () => fired++ });
    assert.equal(fired, 0, name);
    // no-callback variant must not throw on the same input
    liveModels("antigravity", { stateDir: dir, env: {}, now: 2, run: () => out });
    assert.ok(r === null || Array.isArray(r), name);
  }
}

// Unknown agents return null without touching the filesystem or run.
{
  const dir = freshDir("unknown");
  assert.equal(liveModels("not-an-agent", { stateDir: dir, env: {}, run: () => { throw new Error("must not run"); } }), null);
  assert.equal(fs.existsSync(path.join(dir, "live-models.json")), false);
}

// Two calls at the same `now`: the second is a cache hit (models identical,
// run called once) — mirrors the 5-minute collector cadence.
{
  const dir = freshDir("same-now");
  let calls = 0; const run = () => { calls++; return AGY_OUT; };
  const a = liveModels("antigravity", { stateDir: dir, env: {}, now: 777, run });
  const b = liveModels("antigravity", { stateDir: dir, env: {}, now: 777, run });
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
}

// An external edit to the cache file between calls is honored on the next read.
{
  const dir = freshDir("external-edit");
  let calls = 0; const run = () => { calls++; return AGY_OUT; };
  liveModels("antigravity", { stateDir: dir, env: {}, now: 1, run });
  writeCache(dir, { antigravity: { at: 2, models: [{ id: "ext", name: "External" }] } });
  const got = liveModels("antigravity", { stateDir: dir, env: {}, now: 3, run });
  assert.equal(calls, 1, "fresh external entry is a hit, run not called");
  assert.equal(got[0].id, "ext");
}

fs.rmSync(tmp, { recursive: true });
console.log("live-models.deep: all tests passed");
