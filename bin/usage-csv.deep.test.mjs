// Deeper edge-case pass on bin/usage-csv.mjs (historyToCsv) and its CLI
// bin/export-csv.mjs. The unit half is pure/in-process; the CLI half spawns
// the real script with HOME, XDG_STATE_HOME, XDG_CONFIG_HOME and
// XDG_CACHE_HOME pointed at a fresh mkdtemp dir - the real home is never
// touched. Complements usage-csv.test.mjs (header/union/sorting, quoting,
// --out, Downloads fallback, missing history).
//
// QUIRK: pins behaviour that is odd but real; a deliberate fix turns the
// assertion into a failure to revisit, not a silent change.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { historyToCsv } from "./usage-csv.mjs";

const H = "date,agent,tokens,resets\n";
const csv = (rows) => H + rows.map((r) => r + "\n").join("");

// ============================================================ wrong top-level shapes
// Anything without a usable `days` object degrades to the bare header; the
// `|| {}` guards on days/agents/entry/peaks are what keep junk from crashing.
for (const h of [undefined, null, 0, "", "x", 5, true, false, [], {}, { days: null }, { days: 0 }, { days: false }, { days: {} }])
  assert.equal(historyToCsv(h), H, `history=${JSON.stringify(h)}`);
// A Map's entries are not own properties, so it looks empty too.
assert.equal(historyToCsv({ days: new Map([["2026-01-01", { a: { tokens: 1 } }]]) }), H);

// ============================================================ wrong `days` value types
// days must be an object; primitives either yield no rows or - for strings
// and arrays - produce phantom rows out of their indices (QUIRK).
assert.equal(historyToCsv({ days: 5 }), H);
assert.equal(historyToCsv({ days: true }), H);
assert.equal(historyToCsv({ days: "abc" }), csv(["0,0,,", "1,0,,", "2,0,,"]),
  "QUIRK: a string `days` iterates its characters as dates/agents");
assert.equal(historyToCsv({ days: [null, { a: { tokens: 1, peaks: {}, resets: 0 } }] }), csv(["1,a,1,0"]),
  "QUIRK: an array `days` uses indices as dates; a null day emits no rows");
assert.equal(historyToCsv({ days: { "2026-01-01": null, "2026-01-02": 7, "2026-01-03": false } }), H,
  "null/number/false day values produce no rows");

// ============================================================ wrong agent-map types
// A day whose value is a string iterates character indices as agent names
// and each character as the entry (QUIRK). Numbers/bools yield nothing.
assert.equal(historyToCsv({ days: { "2026-01-01": "abc" } }), csv(["2026-01-01,0,,", "2026-01-01,1,,", "2026-01-01,2,,"]),
  "QUIRK: string agent map -> one empty row per character index");
assert.equal(historyToCsv({ days: { "2026-01-01": 5 } }), H);
assert.equal(historyToCsv({ days: { "2026-01-01": [null, { tokens: 2, peaks: {}, resets: 1 }] } }),
  csv(["2026-01-01,0,,", "2026-01-01,1,2,1"]),
  "QUIRK: array agent map -> indices are agent names; null entry -> empty row");

// ============================================================ wrong entry types
// A null/primitive entry still emits a row - it just has no data.
for (const e of [null, undefined, 0, "", "x", 5, true, false, []])
  assert.equal(historyToCsv({ days: { "2026-01-01": { a: e } } }), csv(["2026-01-01,a,,"]),
    `entry=${JSON.stringify(e)} -> empty row, no crash`);

// ============================================================ wrong `peaks` types
// peaks is read with Object.keys/Object.entries: strings give index "titles"
// whose values are never finite (empty columns, QUIRK); an array's indices
// ARE valid titles and its numbers ARE written.
assert.equal(historyToCsv({ days: { "2026-01-01": { a: { tokens: 1, peaks: "ab", resets: 0 } } } }),
  "date,agent,tokens,resets,peak_0,peak_1\n2026-01-01,a,1,0,,\n",
  "QUIRK: string peaks -> phantom peak_0/peak_1 columns, always empty");
assert.equal(historyToCsv({ days: { "2026-01-01": { a: { tokens: 1, peaks: [0.5], resets: 0 } } } }),
  "date,agent,tokens,resets,peak_0\n2026-01-01,a,1,0,50\n",
  "QUIRK: array peaks -> index titles with real values");
assert.equal(historyToCsv({ days: { "2026-01-01": { a: { tokens: 1, peaks: 5, resets: 0 } } } }),
  csv(["2026-01-01,a,1,0"]));
assert.equal(historyToCsv({ days: { "2026-01-01": { a: { tokens: 1, peaks: true, resets: 0 } } } }),
  csv(["2026-01-01,a,1,0"]));

// ============================================================ peak fraction filtering
// Only real finite numbers count: strings, booleans, null and objects are
// skipped even when they would coerce to a number.
{
  const r = historyToCsv({ days: { "2026-01-01": { a: { tokens: 1, peaks: { S: "0.5", T: true, U: null, V: {}, W: "x", X: [0.5] }, resets: 0 } } } });
  assert.equal(r, "date,agent,tokens,resets,peak_s,peak_t,peak_u,peak_v,peak_w,peak_x\n2026-01-01,a,1,0,,,,,,\n",
    "non-number fracs are skipped but still claim header columns");
}
// A title whose every fraction is non-finite still gets a column (the header
// pass collects titles before finiteness is checked) - QUIRK.
assert.equal(historyToCsv({ days: { "2026-01-01": { a: { tokens: 1, peaks: { Ghost: NaN }, resets: 0 } } } }),
  "date,agent,tokens,resets,peak_ghost\n2026-01-01,a,1,0,\n",
  "QUIRK: all-NaN peak title still produces an all-empty column");
// Colliding normalized titles: the FIRST finite fraction in entry order wins;
// a non-finite earlier title does not block a later finite one.
assert.equal(historyToCsv({ days: { "2026-01-01": { a: { tokens: 1, peaks: { Session: 0.1, session: 0.9 }, resets: 0 } } } }),
  "date,agent,tokens,resets,peak_session\n2026-01-01,a,1,0,10\n",
  "QUIRK: 'Session' and 'session' share peak_session; first finite wins");
assert.equal(historyToCsv({ days: { "2026-01-01": { a: { tokens: 1, peaks: { Session: NaN, session: 0.5 }, resets: 0 } } } }),
  "date,agent,tokens,resets,peak_session\n2026-01-01,a,1,0,50\n",
  "a skipped non-finite title lets the colliding finite one through");
// Rounding is Math.round(frac*100) on the float product - classic .5 edges.
{
  const p = (f) => historyToCsv({ days: { "2026-01-01": { a: { tokens: 1, peaks: { S: f }, resets: 0 } } } });
  assert.match(p(0.5), /,50\n$/, "0.5 -> 50");
  assert.match(p(0.575), /,57\n$/, "QUIRK: 0.575*100 is 57.4999... -> 57, not 58");
  assert.match(p(0.505), /,51\n$/, "0.505*100 is exactly 50.5 -> rounds up to 51");
  assert.match(p(-0.3), /,-30\n$/, "negative fractions are written raw");
  assert.match(p(1.2), /,120\n$/, "fractions over 1 are written raw (no clamp)");
  assert.match(p(1e-9), /,0\n$/, "tiny fractions round to 0");
}
// Integer-like peak keys iterate in numeric order before string keys.
assert.equal(historyToCsv({ days: { "2026-01-01": { a: { tokens: 1, peaks: { "10": 0.1, "2": 0.2, S: 0.3 }, resets: 0 } } } }),
  "date,agent,tokens,resets,peak_10,peak_2,peak_s\n2026-01-01,a,1,0,10,20,30\n",
  "columns sorted lexically regardless of key iteration order");

// ============================================================ tokens / resets coercion
// tokens: only null/undefined become ""; EVERY other value is String()'d,
// including NaN, Infinity and objects (QUIRKs - honest-data rule only covers
// the writer side, this just echoes whatever JSON held).
{
  const r = historyToCsv({ days: { "2026-01-01": {
    a: { tokens: NaN, peaks: {}, resets: 0 },
    b: { tokens: Infinity, peaks: {}, resets: 0 },
    c: { tokens: {}, peaks: {}, resets: 0 },
    d: { tokens: "1,000", peaks: {}, resets: 0 },
    e: { tokens: -0, peaks: {}, resets: 0 },
    f: { tokens: 10n, peaks: {}, resets: 0 },
  } } });
  assert.equal(r, csv([
    "2026-01-01,a,NaN,0", "2026-01-01,b,Infinity,0", "2026-01-01,c,[object Object],0",
    '2026-01-01,d,"1,000",0', "2026-01-01,e,0,0", "2026-01-01,f,10,0",
  ]), "QUIRK: NaN/Infinity/objects leak into the tokens cell verbatim");
}
// resets: Number.isFinite gate - numeric strings, NaN, Infinity, booleans and
// objects all become ""; finite non-integers and negatives pass through raw.
{
  const r = historyToCsv({ days: { "2026-01-01": {
    a: { tokens: 1, peaks: {}, resets: 2.5 },
    b: { tokens: 1, peaks: {}, resets: "3" },
    c: { tokens: 1, peaks: {}, resets: NaN },
    d: { tokens: 1, peaks: {}, resets: Infinity },
    e: { tokens: 1, peaks: {}, resets: true },
    f: { tokens: 1, peaks: {}, resets: -1 },
    g: { tokens: 1, peaks: {} },
  } } });
  assert.equal(r, csv([
    "2026-01-01,a,1,2.5", "2026-01-01,b,1,", "2026-01-01,c,1,", "2026-01-01,d,1,",
    "2026-01-01,e,1,", "2026-01-01,f,1,-1", "2026-01-01,g,1,",
  ]), "QUIRK: resets 2.5 is written unrounded; only finite numbers count");
}

// ============================================================ sorting quirks
// Date and agent keys sort as STRINGS, not chronologically or naturally.
assert.equal(historyToCsv({ days: {
  "2026-1-5": { a: { tokens: 1, peaks: {}, resets: 0 } },
  "2026-01-10": { a: { tokens: 2, peaks: {}, resets: 0 } },
} }), csv(["2026-01-10,a,2,0", "2026-1-5,a,1,0"]),
  "QUIRK: lexical date sort puts 2026-01-10 before 2026-1-5");
assert.equal(historyToCsv({ days: { "2026-01-01": {
  b: { tokens: 1, peaks: {}, resets: 0 }, A: { tokens: 2, peaks: {}, resets: 0 }, a: { tokens: 3, peaks: {}, resets: 0 },
} } }), csv(["2026-01-01,A,2,0", "2026-01-01,a,3,0", "2026-01-01,b,1,0"]),
  "agent sort is lexical: A < a < b");
// Empty-string keys are legal and sort first.
assert.equal(historyToCsv({ days: { "": { "": { tokens: 1, peaks: {}, resets: 0 } } } }),
  csv([",,1,0"]));

// ============================================================ quoting edge cases
// cell() quotes a cell containing a comma, quote, CR or LF; a bare tab or
// other control char is NOT quoted (only , " CR LF trigger it - QUIRK).
{
  const r = historyToCsv({ days: { "2026-01-01": {
    'cr\rhere': { tokens: 1, peaks: {}, resets: 0 },
    'tab\there': { tokens: 2, peaks: {}, resets: 0 },
  } } });
  assert.ok(r.includes('"cr\rhere",1,0'), "CR inside a cell is quoted");
  assert.ok(r.includes("tab\there,2,0"), "QUIRK: a bare tab is NOT quoted (only , \" CR LF are)");
}
// A title needing no normalization still lands in a safe column; titles that
// normalize to the same column across DIFFERENT days share it.
assert.equal(historyToCsv({ days: {
  "2026-01-01": { a: { tokens: 1, peaks: { "Session Limit": 0.5 }, resets: 0 } },
  "2026-01-02": { b: { tokens: 2, peaks: { session_limit: 0.7, "!!!": 0.1 }, resets: 0 } },
} }), "date,agent,tokens,resets,peak____,peak_session_limit\n" +
  "2026-01-01,a,1,0,,50\n2026-01-02,b,2,0,10,70\n",
  "colliding titles across days merge into one column; '!!!' -> 'peak____'");

// ============================================================ weird-but-legal keys
// JSON.parse can produce own "__proto__" keys; the module reads them fine.
{
  const h = JSON.parse('{"days":{"2026-01-01":{"__proto__":{"tokens":1,"peaks":{"__proto__":0.5},"resets":1}}}}');
  assert.equal(historyToCsv(h),
    "date,agent,tokens,resets,peak___proto__\n2026-01-01,__proto__,1,1,50\n");
}
// "constructor"/"hasOwnProperty" as agent names are ordinary own keys.
assert.equal(historyToCsv({ days: { "2026-01-01": {
  constructor: { tokens: 1, peaks: {}, resets: 0 },
  hasOwnProperty: { tokens: 2, peaks: {}, resets: 0 },
} } }), csv(["2026-01-01,constructor,1,0", "2026-01-01,hasOwnProperty,2,0"]));

// ============================================================ purity / determinism
// The function must not mutate its input (deep-frozen input still works) and
// repeated calls are identical - no hidden cache or shared state, so there
// are no concurrency or stale-state races inside the module itself.
{
  const h = { days: { "2026-01-01": { a: { tokens: 1, peaks: { S: 0.5 }, resets: 1 } } } };
  const before = JSON.stringify(h);
  const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } };
  deepFreeze(h);
  const r1 = historyToCsv(h);
  const r2 = historyToCsv(h);
  assert.equal(r1, r2, "deterministic");
  assert.equal(JSON.stringify(h), before, "input untouched");
}

// ============================================================ CLI: bin/export-csv.mjs
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "export-csv.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usage-csv-deep-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const home = path.join(tmp, "home");
const state = path.join(tmp, "state");
const cfg = path.join(tmp, "config");
const cache = path.join(tmp, "cache");
const stateDir = path.join(state, "omarchy", "agent-usage-tabs");
fs.mkdirSync(stateDir, { recursive: true });
for (const d of [home, cfg, cache]) fs.mkdirSync(d, { recursive: true });
// A PATH with no xdg-user-dir in it, so no-out runs fall back to ~/Downloads.
const noXdg = path.join(tmp, "noxdg-bin");
fs.mkdirSync(noXdg);

const smallHist = { days: { "2026-01-01": { a: { tokens: 7, peaks: { Session: 0.5 }, resets: 1 } } } };
const smallCsv = "date,agent,tokens,resets,peak_session\n2026-01-01,a,7,1,50\n";
fs.writeFileSync(path.join(stateDir, "history.json"), JSON.stringify(smallHist));

const env = (e = {}) => ({
  PATH: "/usr/bin:/bin", HOME: home, XDG_STATE_HOME: state,
  XDG_CONFIG_HOME: cfg, XDG_CACHE_HOME: cache, ...e,
});
const run = (args, e = {}, opts = {}) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: env(e), ...opts });
const today = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();

// ---- corrupt / wrong-type history.json
// Each corrupt variant must exit 1 with a single stderr line and write nothing.
for (const [label, content] of [
  ["empty file", ""],
  ["whitespace only", "   \n\t  "],
  ["not json", "this is not json{"],
  ["truncated json", '{"days":{"2026-01-01":'],
]) {
  const dir = path.join(tmp, "corrupt-" + label.replace(/\W+/g, "-"));
  const sd = path.join(dir, "state", "omarchy", "agent-usage-tabs");
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, "history.json"), content);
  const out = path.join(dir, "out.csv");
  const r = run(["--out", out], { XDG_STATE_HOME: path.join(dir, "state") });
  assert.equal(r.status, 1, `${label}: status`);
  assert.equal(r.stdout, "", `${label}: stdout`);
  assert.equal(r.stderr.trim().split("\n").length, 1, `${label}: one stderr line`);
  assert.ok(r.stderr.startsWith("could not read "), `${label}: message`);
  assert.ok(!fs.existsSync(out), `${label}: nothing written`);
}
// Valid JSON of the wrong shape still exports - historyToCsv treats it as
// empty, so the CLI exits 0 and writes a header-only CSV (QUIRK: "no history"
// only means missing/unreadable, not "no usable data").
for (const [label, content] of [
  ["null", "null"], ["array", "[]"], ["string", '"hello"'], ["number", "5"],
  ["bool", "true"], ["days number", '{"days":5}'], ["days null", '{"days":null}'],
]) {
  const dir = path.join(tmp, "shape-" + label.replace(/\W+/g, "-"));
  const sd = path.join(dir, "state", "omarchy", "agent-usage-tabs");
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, "history.json"), content);
  const out = path.join(dir, "out.csv");
  const r = run(["--out", out], { XDG_STATE_HOME: path.join(dir, "state") });
  assert.equal(r.status, 0, `${label}: status ${r.status} ${r.stderr}`);
  assert.equal(fs.readFileSync(out, "utf8"), H, `${label}: header-only CSV`);
}
// QUIRK: a UTF-8 BOM makes JSON.parse fail -> exit 1 even though the JSON is fine.
{
  const dir = path.join(tmp, "bom");
  const sd = path.join(dir, "state", "omarchy", "agent-usage-tabs");
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, "history.json"), String.fromCharCode(0xfeff) + JSON.stringify(smallHist));
  const out = path.join(dir, "out.csv");
  const r = run(["--out", out], { XDG_STATE_HOME: path.join(dir, "state") });
  assert.equal(r.status, 1, "BOM history -> could not read");
  assert.ok(!fs.existsSync(out));
}
// history.json that is a directory: existsSync passes, readFileSync throws.
{
  const dir = path.join(tmp, "histdir");
  fs.mkdirSync(path.join(dir, "state", "omarchy", "agent-usage-tabs", "history.json"), { recursive: true });
  const out = path.join(dir, "out.csv");
  const r = run(["--out", out], { XDG_STATE_HOME: path.join(dir, "state") });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.startsWith("could not read "));
  assert.ok(!fs.existsSync(out));
}
// Unreadable history.json (mode 000, we are not root) -> clean exit 1.
{
  const dir = path.join(tmp, "unreadable");
  const sd = path.join(dir, "state", "omarchy", "agent-usage-tabs");
  fs.mkdirSync(sd, { recursive: true });
  const hp = path.join(sd, "history.json");
  fs.writeFileSync(hp, JSON.stringify(smallHist));
  fs.chmodSync(hp, 0o000);
  const out = path.join(dir, "out.csv");
  const r = run(["--out", out], { XDG_STATE_HOME: path.join(dir, "state") });
  fs.chmodSync(hp, 0o600);
  assert.equal(r.status, 1, "chmod 000 -> could not read");
  assert.ok(r.stderr.startsWith("could not read "));
  assert.ok(!fs.existsSync(out));
}

// ---- argument parsing
{
  const out = path.join(tmp, "args-out.csv");
  const r = run(["--bogus"], {}, { cwd: tmp });
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), "usage: export-csv.mjs [--out <path>]");
  assert.ok(!fs.existsSync(out));
}
{
  // "--out" with no following arg is a usage error.
  const r = run(["--out"], {}, { cwd: tmp });
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), "usage: export-csv.mjs [--out <path>]");
}
{
  // A bad arg AFTER --out still fails before anything is written.
  const out = path.join(tmp, "args-late.csv");
  const r = run(["--out", out, "extra"], {}, { cwd: tmp });
  assert.equal(r.status, 1);
  assert.ok(!fs.existsSync(out), "usage failure happens before the write");
}
{
  // QUIRK: "--out" consumes the NEXT arg verbatim, even if it looks like a
  // flag - so "--out --bogus" writes a file literally named "--bogus".
  const cwd = path.join(tmp, "flagcwd");
  fs.mkdirSync(cwd, { recursive: true });
  const r = run(["--out", "--bogus"], {}, { cwd });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(cwd, "--bogus")), "QUIRK: flag-looking --out value is used as path");
}
{
  // Repeated --out: the LAST one wins.
  const a = path.join(tmp, "first.csv");
  const b = path.join(tmp, "second.csv");
  const r = run(["--out", a, "--out", b], {}, { cwd: tmp });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), b);
  assert.ok(!fs.existsSync(a));
  assert.equal(fs.readFileSync(b, "utf8"), smallCsv);
}
{
  // QUIRK: "--out ''" is falsy, so the Downloads fallback kicks in.
  const r = run(["--out", ""], { PATH: noXdg }, { cwd: tmp });
  assert.equal(r.status, 0, r.stderr);
  const want = path.join(home, "Downloads", `cook-meter-usage-${today}.csv`);
  assert.equal(r.stdout.trim(), want, "empty --out falls back to Downloads");
}

// ---- --out destination handling
{
  // A pre-existing 0644 file is overwritten AND re-chmodded to 0600.
  const out = path.join(tmp, "perm.csv");
  fs.writeFileSync(out, "old", { mode: 0o644 });
  fs.chmodSync(out, 0o644);
  const r = run(["--out", out], {}, { cwd: tmp });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(out, "utf8"), smallCsv);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
}
{
  // --out through a path whose parent is a regular file: mkdirSync throws an
  // uncaught error - non-zero exit, stack on stderr (not the clean fail()).
  const blocker = path.join(tmp, "blocker");
  fs.writeFileSync(blocker, "x");
  const r = run(["--out", path.join(blocker, "sub", "out.csv")], {}, { cwd: tmp });
  assert.notEqual(r.status, 0, "unwritable --out fails");
  assert.ok(r.stderr.length > 0);
}
{
  // --out in a directory that does not exist yet is created (mkdirSync -p).
  const out = path.join(tmp, "deep", "nested", "dir", "out.csv");
  const r = run(["--out", out], {}, { cwd: tmp });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(out, "utf8"), smallCsv);
}

// ---- XDG_STATE_HOME edge cases
{
  // QUIRK: XDG_STATE_HOME="" is falsy -> falls back to ~/.local/state.
  const home2 = path.join(tmp, "home2");
  const sd2 = path.join(home2, ".local", "state", "omarchy", "agent-usage-tabs");
  fs.mkdirSync(sd2, { recursive: true });
  fs.writeFileSync(path.join(sd2, "history.json"), JSON.stringify(smallHist));
  const out = path.join(tmp, "empty-xdg.csv");
  const r = run(["--out", out], { HOME: home2, XDG_STATE_HOME: "" }, { cwd: tmp });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(out, "utf8"), smallCsv);
}
{
  // QUIRK: a RELATIVE XDG_STATE_HOME resolves against the process cwd.
  const cwd = path.join(tmp, "relcwd");
  const sd3 = path.join(cwd, "relstate", "omarchy", "agent-usage-tabs");
  fs.mkdirSync(sd3, { recursive: true });
  fs.writeFileSync(path.join(sd3, "history.json"), JSON.stringify(smallHist));
  const out = path.join(cwd, "rel-out.csv");
  const r = run(["--out", out], { XDG_STATE_HOME: "relstate" }, { cwd });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(out, "utf8"), smallCsv);
}

// ---- xdg-user-dir probing (no --out)
// A fake xdg-user-dir earlier on PATH decides the directory; its exit code,
// empty output and whitespace are all handled.
const fakeBin = path.join(tmp, "fakebin");
fs.mkdirSync(fakeBin, { recursive: true });
const writeXdg = (body) => {
  const p = path.join(fakeBin, "xdg-user-dir");
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, 0o755);
};
const noPath = { PATH: fakeBin };
{
  // Prints a custom dir -> file lands there (created if missing).
  const target = path.join(tmp, "xdg-target");
  writeXdg(`echo "${target}"`);
  const r = run([], noPath, { cwd: tmp });
  assert.equal(r.status, 0, r.stderr);
  const want = path.join(target, `cook-meter-usage-${today}.csv`);
  assert.equal(r.stdout.trim(), want);
  assert.equal(fs.readFileSync(want, "utf8"), smallCsv);
}
{
  // Non-zero exit -> ~/Downloads fallback.
  writeXdg("exit 1");
  const r = run([], noPath, { cwd: tmp });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), path.join(home, "Downloads", `cook-meter-usage-${today}.csv`));
}
{
  // Empty output -> ~/Downloads fallback.
  writeXdg("exit 0");
  const r = run([], noPath, { cwd: tmp });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), path.join(home, "Downloads", `cook-meter-usage-${today}.csv`));
}
{
  // QUIRK: a RELATIVE dir from xdg-user-dir is used as-is -> the CSV lands
  // relative to the process cwd, not $HOME.
  const cwd = path.join(tmp, "reldl");
  fs.mkdirSync(cwd, { recursive: true });
  writeXdg('echo "rel/dl"');
  const r = run([], noPath, { cwd });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), path.join("rel/dl", `cook-meter-usage-${today}.csv`));
  assert.ok(fs.existsSync(path.join(cwd, "rel/dl", `cook-meter-usage-${today}.csv`)));
}
{
  // Whitespace around the printed dir is trimmed.
  const target = path.join(tmp, "xdg-spaced");
  writeXdg(`echo "  ${target}  "`);
  const r = run([], noPath, { cwd: tmp });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), path.join(target, `cook-meter-usage-${today}.csv`));
}
{
  // xdg-user-dir missing from PATH entirely (spawnSync error, status null)
  // -> fallback. PATH has no shell either; the script lookup just fails.
  const emptyBin = path.join(tmp, "emptybin");
  fs.mkdirSync(emptyBin, { recursive: true });
  const r = run([], { PATH: emptyBin }, { cwd: tmp });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), path.join(home, "Downloads", `cook-meter-usage-${today}.csv`));
}

// ---- no stale state / concurrent invocations
{
  // The CLI re-reads history.json every run - no caching between invocations.
  const out = path.join(tmp, "fresh.csv");
  run(["--out", out], {}, { cwd: tmp });
  assert.equal(fs.readFileSync(out, "utf8"), smallCsv);
  fs.writeFileSync(path.join(stateDir, "history.json"), JSON.stringify({
    days: { "2026-02-02": { z: { tokens: 9, peaks: {}, resets: 0 } } },
  }));
  run(["--out", out], {}, { cwd: tmp });
  assert.equal(fs.readFileSync(out, "utf8"),
    "date,agent,tokens,resets\n2026-02-02,z,9,0\n", "second run sees the new history");
  // Restore for the concurrency check below.
  fs.writeFileSync(path.join(stateDir, "history.json"), JSON.stringify(smallHist));
}
{
  // Two concurrent exports to the SAME --out both succeed; identical input
  // means identical bytes, so the winner is irrelevant.
  const out = path.join(tmp, "race.csv");
  const once = () => new Promise((resolve) => {
    const p = spawn(process.execPath, [cli, "--out", out], { env: env() });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => resolve({ code, err }));
  });
  const [r1, r2] = await Promise.all([once(), once()]);
  assert.equal(r1.code, 0, r1.err);
  assert.equal(r2.code, 0, r2.err);
  assert.equal(fs.readFileSync(out, "utf8"), smallCsv);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
}
{
  // Concurrent exports to DIFFERENT --out paths and different histories do
  // not interfere (separate processes, no shared state).
  const dirA = path.join(tmp, "conc-a", "state", "omarchy", "agent-usage-tabs");
  const dirB = path.join(tmp, "conc-b", "state", "omarchy", "agent-usage-tabs");
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  fs.writeFileSync(path.join(dirA, "history.json"), JSON.stringify({ days: { "2026-01-01": { a: { tokens: 1, peaks: {}, resets: 0 } } } }));
  fs.writeFileSync(path.join(dirB, "history.json"), JSON.stringify({ days: { "2026-01-01": { b: { tokens: 2, peaks: {}, resets: 3 } } } }));
  const outA = path.join(tmp, "conc-a.csv");
  const outB = path.join(tmp, "conc-b.csv");
  const once = (stateDirX, outX) => new Promise((resolve) => {
    const p = spawn(process.execPath, [cli, "--out", outX], {
      env: env({ XDG_STATE_HOME: path.join(stateDirX, "..", "..") }),
    });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => resolve({ code, err }));
  });
  // stateDirX is the agent-usage-tabs dir; XDG_STATE_HOME is two levels up.
  const [rA, rB] = await Promise.all([once(dirA, outA), once(dirB, outB)]);
  assert.equal(rA.code, 0, rA.err);
  assert.equal(rB.code, 0, rB.err);
  assert.equal(fs.readFileSync(outA, "utf8"), "date,agent,tokens,resets\n2026-01-01,a,1,0\n");
  assert.equal(fs.readFileSync(outB, "utf8"), "date,agent,tokens,resets\n2026-01-01,b,2,3\n");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("usage-csv.deep.test.mjs: ok");
