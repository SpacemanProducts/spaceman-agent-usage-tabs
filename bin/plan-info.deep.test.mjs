// Deep edge-case pass for bin/plan-info.mjs on top of plan-info.test.mjs.
// parseAmpUsage is pure; planInfo reads/writes <stateDir>/plan-info.json and
// takes `run`/`now`/`onUnexpected` injections, so nothing here spawns the real
// `amp` binary and nothing touches the real home folder: every path lives in
// one mkdtemp root with HOME/XDG_* pointed inside it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAmpUsage, planInfo } from "./plan-info.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-info-deep-"));
const savedEnv = {};
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  savedEnv[k] = process.env[k];
  process.env[k] = path.join(tmp, k.toLowerCase());
  fs.mkdirSync(process.env[k], { recursive: true });
}

const AMP_OK = "Signed in as amp-user\n**Credits:** $9.59 remaining\n";
const TTL = 30 * 60 * 1000;
const NOW = 1_000_000;

// Each state dir starts missing; planInfo creates it only when it has an
// answer worth caching.
let seq = 0;
const stateDir = () => path.join(tmp, `sd${seq++}`);
const mkState = (name) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); return d; };
const seed = (d, obj) => {
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "plan-info.json"), typeof obj === "string" ? obj : JSON.stringify(obj));
};
const cacheFile = (d) => path.join(d, "plan-info.json");
const note = (out) => parseAmpUsage(out)?.note;

try {
  // ---- parseAmpUsage: falsy and non-string inputs ----
  for (const bad of [undefined, null, "", 0, false, NaN]) {
    assert.equal(parseAmpUsage(bad), null, `falsy ${String(bad)} is no data`);
  }
  assert.equal(parseAmpUsage(42), null, "a bare number has no sign-in line");
  assert.equal(parseAmpUsage({}), null, "a plain object stringifies to [object Object]");
  assert.equal(parseAmpUsage(Symbol("x")), null, "String(symbol) does not throw");
  assert.throws(() => parseAmpUsage({ toString() { throw new Error("nope"); } }), /nope/,
    "a throwing toString propagates out of parseAmpUsage");
  // String() coercion means these DO parse.
  assert.equal(parseAmpUsage(["Signed in as x"]).signedIn, true, "a one-element array stringifies to its element");
  assert.equal(parseAmpUsage(Buffer.from("Signed in as b")).signedIn, true, "a Buffer stringifies to its text");

  // ---- parseAmpUsage: the sign-in gate ----
  assert.equal(parseAmpUsage("SIGNED IN AS root").signedIn, true, "the sign-in match is case-insensitive");
  assert.equal(parseAmpUsage("prefix noise\nSigned in as x\nsuffix").signedIn, true, "the match is unanchored");
  assert.equal(parseAmpUsage("Signed in as").signedIn, true, "the bare phrase itself is enough");
  // Quirk: /Signed in as/i is a substring test, so "unsigned in as" contains
  // "signed in as" and reports signedIn.
  assert.equal(parseAmpUsage("unsigned in as bob").signedIn, true, "substring quirk: 'un'+'signed in as'");
  assert.equal(parseAmpUsage("signed in"), null, "the phrase 'signed in as' is required in full");
  assert.equal(parseAmpUsage("Signed in"), null);
  // A daily line without the sign-in gate is still no data.
  assert.equal(parseAmpUsage("Daily allowance: $10.00 remaining"), null);

  // ---- parseAmpUsage: the daily-allowance regex ----
  assert.equal(note("Signed in as x\nDaily allowance: $10.00 remaining today"), "Daily allowance $10.00");
  assert.equal(note("Signed in as x\nper day limit: $5"), "Daily allowance $5",
    "the 'per day' alternative needs the $ AFTER the words 'per day'");
  assert.equal(note("Signed in as x\nYou have $5 per day"), "",
    "a $ BEFORE 'per day' on the same line is not matched");
  assert.equal(note("Signed in as x\n$5 per day, cap $9"), "Daily allowance $9",
    "with two $ on the line, 'per day' binds to the later one");
  assert.equal(note("Signed in as x\nDaily\n$10.00"), "",
    "[^\\n$] cannot cross a newline: 'daily' and the $ must share a line");
  assert.equal(note("Signed in as x\nDaily allowance: $10.00\nDaily top-up: $99.00"), "Daily allowance $10.00",
    "the first match wins");
  assert.equal(note("Signed in as x\nDaily: costs $3, cap $9"), "Daily allowance $3,",
    "the capture stops at the first $ but keeps trailing commas ([\\d,.]+)");
  assert.equal(note("Signed in as x\nDaily allowance: $"), "", "no [\\d,.] after the $");
  assert.equal(note("Signed in as x\nDaily allowance: $."), "Daily allowance $.",
    "a lone dot satisfies [\\d,.]+");
  assert.equal(note("Signed in as x\nDaily allowance: $1,234.56 today"), "Daily allowance $1,234.56",
    "commas are kept verbatim in the note");
  assert.equal(note("Signed in as x\ndaily$5"), "Daily allowance $5", "no space needed after 'daily'");
  assert.equal(note("Signed in as x\nnot daily anything\nno dollars"), "", "no allowance -> empty note");

  // ---- planInfo: option and agent validation ----
  assert.equal(planInfo(), null, "no agentId is no data");
  assert.equal(planInfo("kimi", { stateDir: stateDir(), env: {}, run: () => { throw new Error("must not run"); } }), null);
  assert.equal(planInfo("AMP", { stateDir: stateDir(), env: {}, run: () => AMP_OK }), null, "agent ids are case-sensitive");
  assert.equal(planInfo(" amp", { stateDir: stateDir(), env: {}, run: () => AMP_OK }), null);
  assert.throws(() => planInfo("amp"), TypeError, "a missing stateDir cannot be joined");
  assert.throws(() => planInfo("amp", { stateDir: 123, env: {}, run: () => AMP_OK }), TypeError);
  assert.throws(() => planInfo("amp", { stateDir: null, env: {}, run: () => AMP_OK }), TypeError);

  // ---- planInfo: run/env passthrough and the cache write ----
  {
    const d = stateDir();
    const env = { MARKER: "deep" };
    let seen;
    const out = planInfo("amp", { stateDir: d, env, now: NOW, run: (cmd, e) => { seen = { cmd, e }; return AMP_OK; } });
    assert.deepEqual(seen.cmd, ["amp", "usage"], "the runner gets the spec's argv");
    assert.equal(seen.e, env, "the env object is passed through untouched");
    assert.deepEqual(out, { signedIn: true, note: "" });
    assert.ok(fs.existsSync(cacheFile(d)), "a successful parse creates the missing stateDir and cache file");
    const cache = JSON.parse(fs.readFileSync(cacheFile(d), "utf8"));
    assert.equal(cache.amp.at, NOW, "the cached timestamp is the injected `now`, not Date.now()");
    assert.deepEqual(cache.amp.info, { signedIn: true, note: "" });
  }
  {
    const d = stateDir();
    let e;
    planInfo("amp", { stateDir: d, now: NOW, run: (cmd, env) => { e = env; return AMP_OK; } });
    assert.equal(e, undefined, "env may be omitted; run just sees undefined");
  }
  {
    // `now` defaults to Date.now(): the stored `at` lands inside the call.
    const d = stateDir();
    const before = Date.now();
    planInfo("amp", { stateDir: d, env: {}, run: () => AMP_OK });
    const after = Date.now();
    const at = JSON.parse(fs.readFileSync(cacheFile(d), "utf8")).amp.at;
    assert.ok(at >= before && at <= after, "default now is the wall clock at call time");
  }
  {
    // Unrelated keys already in the cache survive a write.
    const d = mkState("keep");
    seed(d, { other: { at: 1, info: { x: 1 } } });
    planInfo("amp", { stateDir: d, env: {}, now: NOW, run: () => AMP_OK });
    const cache = JSON.parse(fs.readFileSync(cacheFile(d), "utf8"));
    assert.deepEqual(cache.other, { at: 1, info: { x: 1 } }, "foreign cache entries are preserved");
    assert.ok(cache.amp, "the amp entry is added alongside them");
  }

  // ---- planInfo: unwritable / hostile stateDir ----
  {
    const f = path.join(tmp, "afile");
    fs.writeFileSync(f, "x");
    let n = 0;
    const out = planInfo("amp", { stateDir: f, env: {}, now: NOW, run: () => { n++; return AMP_OK; } });
    assert.equal(out.signedIn, true, "stateDir being a file still returns the fresh parse");
    assert.equal(n, 1);
    assert.equal(fs.readFileSync(f, "utf8"), "x", "nothing was written through the file-as-dir path");
  }
  {
    const d = mkState("dircache");
    fs.mkdirSync(cacheFile(d)); // plan-info.json exists as a directory
    const out = planInfo("amp", { stateDir: d, env: {}, now: NOW, run: () => AMP_OK });
    assert.equal(out.signedIn, true, "an unreadable cache file is ignored, not fatal");
  }

  // ---- planInfo: corrupt cache contents ----
  for (const [i, bad] of ["{not json", "", "   ", "\uFEFF{}", "[1,2", '"unterminated', "nullx"].entries()) {
    const d = stateDir();
    seed(d, bad);
    let n = 0;
    const out = planInfo("amp", { stateDir: d, env: {}, now: NOW, run: () => { n++; return AMP_OK; } });
    assert.equal(out.signedIn, true, `corrupt cache #${i} (${JSON.stringify(bad)}) is ignored`);
    assert.equal(n, 1, "corrupt cache forces exactly one fresh run");
  }
  // Falsy-but-valid JSON parses to {} via `|| {}` and behaves like no cache.
  for (const good of ["null", "false", "0", '""']) {
    const d = stateDir();
    seed(d, good);
    let n = 0;
    assert.equal(planInfo("amp", { stateDir: d, env: {}, now: NOW, run: () => { n++; return AMP_OK; } }).signedIn, true);
    assert.equal(n, 1, `valid-but-falsy cache ${good} still runs the tool`);
    assert.ok(JSON.parse(fs.readFileSync(cacheFile(d), "utf8")).amp, `and is then rewritten as a real cache (${good})`);
  }

  // A syntactically valid plan-info.json holding a TRUTHY JSON primitive
  // (nonzero number, nonempty string, true) must be treated as an empty
  // cache, not crash `cache[agentId] = ...` on a primitive.
  for (const prim of ["5", '"x"', "true"]) {
    const d = stateDir(); seed(d, prim);
    assert.equal(planInfo("amp", { stateDir: d, env: {}, now: NOW, run: () => AMP_OK }).signedIn, true,
      `cache ${prim} should be treated as empty, not crash`);
  }
  // An array cache must also be treated as empty: `cache["amp"]=...` would
  // succeed on an array but JSON.stringify drops non-index properties, so
  // the fresh answer would never persist.
  {
    const d = stateDir(); seed(d, "[]");
    let n = 0; const run = () => { n++; return AMP_OK; };
    planInfo("amp", { stateDir: d, env: {}, now: NOW, run });
    planInfo("amp", { stateDir: d, env: {}, now: NOW + 1, run });
    assert.equal(n, 1, "an array cache should still persist the amp entry");
  }

  // ---- planInfo: cache entry shapes and TTL edges ----
  {
    const d = mkState("fresh");
    seed(d, { amp: { at: NOW, info: { signedIn: true, note: "cached" } } });
    let n = 0;
    const out = planInfo("amp", { stateDir: d, env: {}, now: NOW + 1000, run: () => { n++; return "garbage"; } });
    assert.deepEqual(out, { signedIn: true, note: "cached" }, "a fresh hit returns the cached info");
    assert.equal(n, 0, "a fresh hit never runs the tool");
  }
  {
    // Boundary: `now - at < TTL` is strict, so exactly-TTL-old is stale.
    const d = mkState("ttl");
    seed(d, { amp: { at: NOW, info: { signedIn: true, note: "old" } } });
    let n = 0;
    planInfo("amp", { stateDir: d, env: {}, now: NOW + TTL - 1, run: () => { n++; return AMP_OK; } });
    assert.equal(n, 0, "one ms inside the TTL is still fresh");
    planInfo("amp", { stateDir: d, env: {}, now: NOW + TTL, run: () => { n++; return AMP_OK; } });
    assert.equal(n, 1, "exactly TTL old is expired (<, not <=)");
  }
  {
    // Clock edges: a future `at` and a backwards `now` both read as fresh.
    const d = mkState("clock");
    seed(d, { amp: { at: NOW + 60_000, info: { signedIn: true, note: "future" } } });
    let n = 0;
    const out = planInfo("amp", { stateDir: d, env: {}, now: NOW, run: () => { n++; return "garbage"; } });
    assert.equal(out.note, "future", "a future timestamp is trusted as fresh");
    assert.equal(n, 0);
    const d2 = stateDir();
    n = 0;
    planInfo("amp", { stateDir: d2, env: {}, now: NOW, run: () => { n++; return AMP_OK; } });
    const back = planInfo("amp", { stateDir: d2, env: {}, now: NOW - 5000, run: () => { n++; return "garbage"; } });
    assert.equal(n, 1, "a backwards clock still counts as fresh (negative age < TTL)");
    assert.equal(back.signedIn, true);
  }
  {
    // at:null coerces to 0: fresh while now < TTL, stale after.
    const d = mkState("nullat");
    seed(d, { amp: { at: null, info: { signedIn: true, note: "epoch" } } });
    let n = 0;
    assert.equal(planInfo("amp", { stateDir: d, env: {}, now: 1000, run: () => { n++; return "garbage"; } }).note, "epoch");
    assert.equal(n, 0, "at:null behaves like at:0");
    assert.equal(planInfo("amp", { stateDir: d, env: {}, now: TTL + 1, run: () => { n++; return AMP_OK; } }).signedIn, true);
    assert.equal(n, 1, "...and expires once now passes the TTL");
  }
  {
    // Malformed entries: missing/garbage `at` is stale (NaN < TTL is false),
    // and a stale entry's info is still the last-good fallback.
    const d = mkState("noat");
    seed(d, { amp: { info: { signedIn: true, note: "no-at" } } });
    let n = 0;
    const out = planInfo("amp", { stateDir: d, env: {}, now: NOW, run: () => { n++; return "not logged in"; } });
    assert.equal(n, 1, "a missing `at` is always stale");
    assert.equal(out.note, "no-at", "...but its info is still the failure fallback");
  }
  for (const [label, entry, expected] of [
    ["numeric-string at", { at: "soon", info: { signedIn: true, note: "x" } }, { signedIn: true, note: "x" }],
    ["numeric hit", 5, null],
    ["string hit", "str", null],
    ["null hit", null, null],
  ]) {
    const d = stateDir();
    seed(d, { amp: entry });
    let n = 0;
    const out = planInfo("amp", { stateDir: d, env: {}, now: NOW, run: () => { n++; return "garbage"; } });
    assert.equal(n, 1, `${label}: never counts as fresh`);
    assert.deepEqual(out, expected, `${label}: stale failure falls back to hit.info or null`);
  }
  {
    // A fresh entry with no usable info short-circuits BEFORE running: the
    // tool is never consulted and null is returned. Only reachable via a
    // hand-seeded cache (the writer only stores truthy info).
    const d = mkState("emptyinfo");
    seed(d, { amp: { at: NOW } });
    let n = 0;
    assert.equal(planInfo("amp", { stateDir: d, env: {}, now: NOW + 1, run: () => { n++; return AMP_OK; } }), null);
    assert.equal(n, 0, "fresh hit with info:undefined returns null without running");
    // Quirk: `hit.info ?? null` does not filter falsy non-null info.
    const d2 = mkState("zero");
    seed(d2, { amp: { at: NOW, info: 0 } });
    n = 0;
    assert.equal(planInfo("amp", { stateDir: d2, env: {}, now: NOW + 1, run: () => { n++; return AMP_OK; } }), 0,
      "info:0 is returned verbatim (?? only maps null/undefined)");
    assert.equal(n, 0);
  }
  {
    // Stale entry + auth-flavoured failure: last good returned AND
    // onUnexpected stays silent (the raw matches the auth-failure regex).
    const d = mkState("stalefail");
    seed(d, { amp: { at: 0, info: { signedIn: true, note: "old-good" } } });
    let n = 0; const calls = [];
    const out = planInfo("amp", {
      stateDir: d, env: {}, now: 2 * TTL,
      run: () => { n++; return "Error: not authenticated, please log in"; },
      onUnexpected: (...a) => calls.push(a),
    });
    assert.equal(out.note, "old-good");
    assert.equal(n, 1);
    assert.equal(calls.length, 0, "auth-shaped failures are not 'unexpected'");
  }

  // ---- planInfo: onUnexpected ----
  {
    const d = stateDir();
    const calls = [];
    const out = planInfo("amp", {
      stateDir: d, env: {}, now: NOW, run: () => "  weird cli noise  ", onUnexpected: (...a) => calls.push(a),
    });
    assert.equal(out, null, "unrecognized output with no cache is no data");
    assert.equal(calls.length, 1, "unrecognized non-auth output reports once");
    assert.equal(calls[0][0], "usage output didn't match the expected format");
    assert.deepEqual(calls[0][1].command, "amp usage");
    assert.equal(calls[0][1].head, "  weird cli noise  ", "head is the raw slice, spaces included");
  }
  {
    const d = stateDir();
    const calls = [];
    planInfo("amp", { stateDir: d, env: {}, now: NOW, run: () => "y".repeat(500), onUnexpected: (...a) => calls.push(a) });
    assert.equal(calls[0][1].head.length, 200, "head is capped at 200 chars");
    assert.ok(calls[0][1].head.startsWith("yyy"));
  }
  for (const [label, out] of [
    ["not logged in", "amp says: not logged in"],
    ["not signed in", "not signed in"],
    ["not authenticated", "Error: not authenticated"],
    ["log in", "please log in to continue"],
    ["login", "run `amp login` first"],
    ["sign in", "sign in to your account"],
    ["only available for", "usage stats only available for teams"],
    ["whitespace only", "   \n\t  "],
    ["empty", ""],
  ]) {
    const d = stateDir();
    const calls = [];
    const res = planInfo("amp", { stateDir: d, env: {}, now: NOW, run: () => out, onUnexpected: (...a) => calls.push(a) });
    assert.equal(res, null, `${label}: still no data`);
    assert.equal(calls.length, 0, `${label}: does not count as unexpected`);
  }
  {
    const d = stateDir();
    const calls = [];
    planInfo("amp", { stateDir: d, env: {}, now: NOW, run: () => AMP_OK, onUnexpected: (...a) => calls.push(a) });
    assert.equal(calls.length, 0, "a successful parse is never unexpected");
    // onUnexpected omitted entirely: garbage is silent, no crash.
    const d2 = stateDir();
    assert.equal(planInfo("amp", { stateDir: d2, env: {}, now: NOW, run: () => "garbage" }), null);
  }
  {
    const d = stateDir();
    assert.throws(() => planInfo("amp", {
      stateDir: d, env: {}, now: NOW, run: () => "garbage",
      onUnexpected: () => { throw new Error("cb boom"); },
    }), /cb boom/, "a throwing onUnexpected propagates");
  }
  {
    // A throwing `run` also propagates: planInfo has no error boundary around it.
    const d = stateDir();
    assert.throws(() => planInfo("amp", {
      stateDir: d, env: {}, now: NOW, run: () => { throw new Error("spawn died"); },
    }), /spawn died/);
  }
  // A `run` that returns null (or any non-string) is no data, not a TypeError.
  for (const bad of [null, undefined, 42]) {
    const d = stateDir();
    assert.equal(planInfo("amp", { stateDir: d, env: {}, now: NOW, run: () => bad }), null,
      `run() -> ${String(bad)} should be no data, not a TypeError`);
  }

  // ---- planInfo: sequential calls share no state ----
  {
    const dA = stateDir(); const dB = stateDir();
    let nA = 0; let nB = 0;
    planInfo("amp", { stateDir: dA, env: {}, now: NOW, run: () => { nA++; return AMP_OK; } });
    // Interleave: dB is empty so it must run even though dA just cached.
    assert.equal(planInfo("amp", { stateDir: dB, env: {}, now: NOW, run: () => { nB++; return "garbage"; } }), null);
    assert.equal(nA, 1); assert.equal(nB, 1);
    // And dA still serves its own cache afterwards.
    assert.equal(planInfo("amp", { stateDir: dA, env: {}, now: NOW + 1, run: () => { nA++; return "garbage"; } }).signedIn, true);
    assert.equal(nA, 1, "one state's cache cannot leak into another's");
  }

  console.log("plan-info deep: all tests passed");
} finally {
  for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
