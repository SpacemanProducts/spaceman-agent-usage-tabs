// Deep edge-case pass for bin/diagnostics.mjs on top of diagnostics.test.mjs
// (which covers the happy path, hourly rate limit, the 300-line cap and the
// basic checkAgentData messages). This file covers what that file does not:
// non-object/wrong-type agent records, every field's boundary values, corrupt
// or missing state/log files, cross-instance rate limiting through the shared
// state file, boundary timestamps, and the unguarded throw paths in flush().
//
// diagnostics.mjs is pure fs + injected clock: no subprocess, no HOME/XDG
// lookup of its own. Per job rules every path still lives under a mkdtemp dir
// with HOME/XDG_* pointed there, restored and removed at the end.
//
// Former '// BUG:' findings are now regression tests: flush() must never throw.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkAgentData, createDiagnostics } from "./diagnostics.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diag-deep-"));
const savedEnv = {};
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  savedEnv[k] = process.env[k];
  process.env[k] = path.join(tmp, k.toLowerCase());
  fs.mkdirSync(process.env[k], { recursive: true });
}

const good = {
  id: "grok", installed: true,
  limits: [{ title: "Session", percent: 0.5, resetsAt: "2026-11-21T06:00:00Z" }],
  models: [{ name: "grok-4", total: 5 }],
  days: Array.from({ length: 7 }, () => ({ tokens: 1 })),
};

// ------------------------------------------------------- checkAgentData: input shape
for (const bad of [null, undefined, "grok", 42, true]) {
  assert.deepEqual(checkAgentData(bad), ["agent record is not an object"], `input ${JSON.stringify(bad)}`);
}
// Quirk: an array IS an object, so it is checked as an agent record and yields
// three "not a list" problems instead of the "not an object" one.
assert.deepEqual(checkAgentData([]), ["limits is not a list", "models is not a list", "days is not a list"]);
assert.deepEqual(checkAgentData([good]), ["limits is not a list", "models is not a list", "days is not a list"], "array of records is not unwrapped");

// Only `installed === false` skips checks; every other falsy/truthy value is checked.
for (const v of [0, "", null, undefined, "false", 1]) {
  const r = checkAgentData({ ...good, installed: v, limits: "junk" });
  assert.ok(r.includes("limits is not a list"), `installed=${JSON.stringify(v)} should still be checked`);
}
assert.deepEqual(checkAgentData({ ...good, installed: false }), [], "installed === false is the only skip");

// ------------------------------------------------------- checkAgentData: limits entries
// Entries that are not objects still produce a percent problem (title reads "undefined").
for (const l of [null, undefined, 5, "x", {}]) {
  const msgs = checkAgentData({ ...good, limits: [l] });
  assert.ok(msgs.some((m) => m.includes('meter "undefined" has percent')), `entry ${JSON.stringify(l)}`);
}
// percent boundaries: 0 and 1 are fine; just outside, non-finite and non-number are not.
assert.deepEqual(checkAgentData({ ...good, limits: [{ title: "a", percent: 0 }, { title: "b", percent: 1 }] }), [], "0 and 1 inclusive");
for (const [p, re] of [[-0.001, /percent -0.001/], [1.001, /percent 1.001/], [Infinity, /percent null/], [NaN, /percent null/], ["0.5", /percent "0.5"/], [true, /percent true/], [null, /percent null/]]) {
  assert.match(checkAgentData({ ...good, limits: [{ title: "S", percent: p }] }).join("\n"), re, `percent ${String(p)}`);
}
// -0 is not < 0, so it passes like 0.
assert.deepEqual(checkAgentData({ ...good, limits: [{ title: "S", percent: -0 }] }), [], "-0 passes");

// resetsAt: empty/null/undefined are skipped; anything Date.parse rejects is flagged.
// Quirk: resetsAt is stringified first, so a small number like 0 parses as a date
// (Date.parse("0") is valid) and is NOT flagged, while a 13-digit epoch-ms number
// ("1764072000000") IS flagged as unreadable — numeric timestamps are rejected.
assert.deepEqual(checkAgentData({ ...good, limits: [{ title: "S", percent: 0.1, resetsAt: 0 }] }), [], "resetsAt 0 parses via String(0)");
assert.match(checkAgentData({ ...good, limits: [{ title: "S", percent: 0.1, resetsAt: 1764072000000 }] }).join("\n"), /unreadable reset time 1764072000000/);
assert.deepEqual(checkAgentData({ ...good, limits: [{ title: "S", percent: 0.1, resetsAt: new Date("2026-11-21T06:00:00Z") }] }), [], "Date object stringifies to a parseable date");
for (const rt of ["  ", "2026-13-45", {}, true, ["x"]]) {
  assert.match(checkAgentData({ ...good, limits: [{ title: "S", percent: 0.1, resetsAt: rt }] }).join("\n"), /unreadable/, `resetsAt ${JSON.stringify(rt)}`);
}
assert.deepEqual(checkAgentData({ ...good, limits: [{ title: "S", percent: 0.1, resetsAt: "November 21, 2026" }] }), [], "any Date.parse-able string is fine");
// A limit can produce BOTH problems at once.
const both = checkAgentData({ ...good, limits: [{ title: "S", percent: 9, resetsAt: "junk" }] });
assert.equal(both.length, 2, "percent and resetsAt problems both reported");

// ------------------------------------------------------- checkAgentData: models / days
assert.match(checkAgentData({ ...good, models: "x" })[0], /models is not a list/);
assert.match(checkAgentData({ ...good, models: {} })[0], /models is not a list/);
// Non-object model entries and bad totals.
for (const m of [null, 5, "x", {}, { name: "m" }, { name: "m", total: -1 }, { name: "m", total: Infinity }, { name: "m", total: "5" }, { name: "m", total: NaN }]) {
  assert.ok(checkAgentData({ ...good, models: [m] }).some((x) => x.includes("token total")), `model entry ${JSON.stringify(m)}`);
}
assert.deepEqual(checkAgentData({ ...good, models: [{ name: "m", total: 0 }, { name: "n", total: 1e9 }] }), [], "0 and large finite totals fine");
assert.match(checkAgentData({ ...good, models: [{ total: -1 }] }).join("\n"), /model "undefined"/, "missing name reads undefined");

assert.match(checkAgentData({ ...good, days: "x" })[0], /days is not a list/);
assert.match(checkAgentData({ ...good, days: {} })[0], /days is not a list/);
assert.match(checkAgentData({ ...good, days: 7 })[0], /days is not a list/);
// Lengths other than 0 or 7 are flagged; a bad token count is flagged on top.
for (const n of [1, 6, 8, 14]) {
  const days = Array.from({ length: n }, () => ({ tokens: 1 }));
  assert.match(checkAgentData({ ...good, days }).join("\n"), new RegExp(`${n} entries \\(expected 7\\)`), `days length ${n}`);
}
// 7 entries with one bad token: only the token problem, not the length one.
const oneBad = checkAgentData({ ...good, days: [...Array.from({ length: 6 }, () => ({ tokens: 1 })), { tokens: -2 }] });
assert.deepEqual(oneBad, ["a day has an invalid token count"]);
for (const tok of [null, undefined, "5", Infinity, NaN, -0.5]) {
  const days = Array.from({ length: 7 }, () => ({ tokens: tok }));
  assert.ok(checkAgentData({ ...good, days }).includes("a day has an invalid token count"), `tokens ${String(tok)}`);
}
// Non-object day entries and missing tokens property.
for (const d of [null, 5, "x", {}, { tokens: 0 }]) {
  const r = checkAgentData({ ...good, days: Array.from({ length: 7 }, () => d) });
  const bad = d && typeof d === "object" && "tokens" in d ? !r.includes("a day has an invalid token count") : r.includes("a day has an invalid token count");
  assert.ok(bad, `day entry ${JSON.stringify(d)}`);
}
// All problems accumulate in a fixed order: limits, models, days.
const all = checkAgentData({ limits: "x", models: "x", days: "x" });
assert.deepEqual(all, ["limits is not a list", "models is not a list", "days is not a list"]);

// ------------------------------------------------------- createDiagnostics: no/partial config
{
  const d = createDiagnostics();
  d.add("grok", "msg");
  assert.match(d.summary("grok"), /1 problem/);
  assert.equal(d.flush(), 0, "no logFile: nothing written, returns 0");
  assert.equal(d.problemsFor("grok").length, 1, "problems still tracked without files");
}
{
  const d = createDiagnostics({ logFile: path.join(tmp, "only-log", "collector.log") });
  d.add("grok", "msg");
  assert.equal(d.flush(), 1, "missing stateFile is tolerated");
  const lines = fs.readFileSync(path.join(tmp, "only-log", "collector.log"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
}
{
  const stateOnly = path.join(tmp, "state-only.json");
  const d = createDiagnostics({ stateFile: stateOnly });
  d.add("grok", "msg");
  assert.equal(d.flush(), 0, "no logFile: early return before touching state");
  assert.ok(!fs.existsSync(stateOnly), "state file not created when there is no logFile");
}
// logFile's parent dirs are created recursively.
{
  const deep = path.join(tmp, "a", "b", "c", "collector.log");
  const d = createDiagnostics({ logFile: deep, stateFile: path.join(tmp, "deep-state.json"), now: () => 1_000 });
  d.add("x", "m");
  assert.equal(d.flush(), 1);
  assert.ok(fs.existsSync(deep));
  assert.equal(fs.statSync(deep).mode & 0o777, 0o600, "freshly created log is 0600");
}

// ------------------------------------------------------- state file: corrupt / wrong types
{
  const dir = path.join(tmp, "corrupt"); fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, "collector.log"), stateFile = path.join(dir, "s.json");
  // Not JSON at all.
  fs.writeFileSync(stateFile, "{not json!!");
  let t = 5_000; let d = createDiagnostics({ logFile, stateFile, now: () => t });
  d.add("grok", "first"); assert.equal(d.flush(), 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")), { "grok|first": 5000 }, "corrupt state replaced by clean object");
  // Valid JSON scalar `5`: treated as empty state (regression: used to throw
  // TypeError on `state[key] = t`, and collect.mjs calls diag.flush() unguarded).
  fs.writeFileSync(stateFile, "5");
  d = createDiagnostics({ logFile, stateFile, now: () => t });
  d.add("grok", "second");
  assert.equal(d.flush(), 1, "scalar state file does not crash flush");
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")), { "grok|second": t }, "scalar state replaced by clean object");
  // A JSON array survives: arrays accept arbitrary properties.
  fs.writeFileSync(stateFile, "[1,2]");
  d = createDiagnostics({ logFile, stateFile, now: () => t + 61 * 60e3 });
  d.add("grok", "third"); assert.equal(d.flush(), 1, "array state file does not crash");
  // `null` falls back to {} via `|| {}`.
  fs.writeFileSync(stateFile, "null");
  d = createDiagnostics({ logFile, stateFile, now: () => t + 122 * 60e3 });
  d.add("grok", "fourth"); assert.equal(d.flush(), 1, "null state file does not crash");
}
// State file that is a directory: read fails (caught), write fails (caught) —
// logging still works, rate limiting just never persists.
{
  const dir = path.join(tmp, "dirstate"); fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, "collector.log"), stateDir = path.join(dir, "s.json");
  fs.mkdirSync(stateDir);
  const d = createDiagnostics({ logFile, stateFile: stateDir, now: () => 1 });
  d.add("grok", "m");
  assert.equal(d.flush(), 1, "directory stateFile tolerated");
  d.add("grok", "m2"); assert.equal(d.flush(), 2, "no persisted state: nothing rate-limited");
}
// logFile that is a directory: read fails (caught) and the write fails too —
// flush() skips the log write quietly instead of throwing EISDIR (regression:
// collect.mjs calls diag.flush() unguarded).
{
  const dir = path.join(tmp, "dirlog"); fs.mkdirSync(path.join(dir, "collector.log"), { recursive: true });
  const d = createDiagnostics({ logFile: path.join(dir, "collector.log"), stateFile: path.join(dir, "s.json"), now: () => 1 });
  d.add("grok", "m");
  assert.equal(d.flush(), 1, "directory logFile does not crash flush");
  assert.ok(fs.existsSync(path.join(dir, "s.json")), "state still written when the log write fails");
}
// details that JSON.stringify cannot serialize (BigInt) are stringified safely.
{
  const dir = path.join(tmp, "bigint"); fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, "collector.log");
  const d = createDiagnostics({ logFile, stateFile: path.join(dir, "s.json"), now: () => 1 });
  d.add("grok", "m", 1n);
  assert.equal(d.flush(), 1, "BigInt details do not crash flush");
  const row = JSON.parse(fs.readFileSync(logFile, "utf8").trim());
  assert.equal(row.details, "1", "BigInt details serialized as a string");
}
// A clock that returns NaN falls back to Date.now() instead of throwing.
{
  const dir = path.join(tmp, "badclock"); fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, "collector.log");
  const d = createDiagnostics({ logFile, stateFile: path.join(dir, "s.json"), now: () => NaN });
  d.add("grok", "m");
  assert.equal(d.flush(), 1, "NaN now() does not crash flush");
  const row = JSON.parse(fs.readFileSync(logFile, "utf8").trim());
  assert.ok(!Number.isNaN(Date.parse(row.at)), "log line still gets a valid timestamp");
}

// ------------------------------------------------------- rate limiting edges
{
  const dir = path.join(tmp, "rate"); fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, "collector.log"), stateFile = path.join(dir, "s.json");
  let t = 10_000_000;
  const H = 60 * 60e3;
  // Seed the state file directly: same problem logged exactly REPEAT_MS ago.
  fs.writeFileSync(stateFile, JSON.stringify({ "grok|same": t - H }));
  let d = createDiagnostics({ logFile, stateFile, now: () => t });
  d.add("grok", "same");
  assert.equal(d.flush(), 1, "exactly REPEAT_MS old logs again (<, not <=)");
  // One ms inside the window does not.
  fs.writeFileSync(stateFile, JSON.stringify({ "grok|same": t - H + 1 }));
  d = createDiagnostics({ logFile, stateFile, now: () => t });
  d.add("grok", "same");
  assert.equal(d.flush(), 0, "1 ms inside the hour is still suppressed");
  // A state timestamp of 0 is falsy and treated as "never logged".
  fs.writeFileSync(stateFile, JSON.stringify({ "grok|zero": 0 }));
  d = createDiagnostics({ logFile, stateFile, now: () => t });
  d.add("grok", "zero");
  assert.equal(d.flush(), 1, "state timestamp 0 is falsy: logs again (quirk)");
  // Non-numeric state values compare as NaN and never suppress.
  fs.writeFileSync(stateFile, JSON.stringify({ "grok|str": "recent", "grok|nan": null }));
  d = createDiagnostics({ logFile, stateFile, now: () => t });
  d.add("grok", "str"); d.add("grok", "nan");
  assert.equal(d.flush(), 2, "string/null state values never suppress");
  // State keys older than 24 * REPEAT_MS are pruned; recent unrelated keys stay.
  fs.writeFileSync(stateFile, JSON.stringify({
    "old|x": t - 25 * H, "fresh|y": t - H, "edge|z": t - 24 * H,
  }));
  d = createDiagnostics({ logFile, stateFile, now: () => t });
  d.add("grok", "new");
  d.flush();
  const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.ok(!("old|x" in st), "key older than 24h pruned");
  assert.ok("fresh|y" in st, "recent unrelated key kept");
  assert.ok("edge|z" in st, "exactly 24h old is kept (> comparison)");
  assert.equal(st["grok|new"], t);
}

// ------------------------------------------------------- flush semantics
{
  const dir = path.join(tmp, "sem"); fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, "collector.log"), stateFile = path.join(dir, "s.json");
  const t = 50_000; const d = createDiagnostics({ logFile, stateFile, now: () => t });
  // Same id + same message twice in one flush: one log line (second hits the
  // just-written state), but summary counts both.
  d.add("grok", "dup"); d.add("grok", "dup");
  assert.equal(d.summary("grok").match(/2 problems/)[0], "2 problems");
  assert.equal(d.flush(), 1, "duplicate message logged once per flush");
  // Same message under different agents both log; different messages same agent both log.
  const d2 = createDiagnostics({ logFile, stateFile, now: () => t + 61 * 60e3 });
  d2.add("grok", "dup"); d2.add("agy", "dup"); d2.add("grok", "other");
  assert.equal(d2.flush(), 3);
  // details: undefined becomes null; false/0 are kept (?? not ||).
  const d3 = createDiagnostics({ logFile, stateFile, now: () => t + 122 * 60e3 });
  d3.add("a", "withUndef"); d3.add("b", "withFalse", false); d3.add("c", "withZero", 0);
  d3.flush();
  const rows = fs.readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse);
  const byAgent = Object.fromEntries(rows.map((r) => [r.agent + "|" + r.problem, r.details]));
  assert.equal(byAgent["a|withUndef"], null);
  assert.equal(byAgent["b|withFalse"], false);
  assert.equal(byAgent["c|withZero"], 0);
  // flush() does not clear problems: the same instance re-logs after the window
  // without anyone calling add() again.
  const dir2 = path.join(tmp, "persist"); fs.mkdirSync(dir2, { recursive: true });
  let tt = 1_000; const d4 = createDiagnostics({ logFile: path.join(dir2, "l.log"), stateFile: path.join(dir2, "s.json"), now: () => tt });
  d4.add("grok", "sticky"); assert.equal(d4.flush(), 1);
  tt += 61 * 60e3; assert.equal(d4.flush(), 1, "problems persist across flush calls");
  assert.match(d4.summary("grok"), /1 problem/, "summary still counts it");
  // problemsFor returns the live internal array.
  d4.problemsFor("grok").push({ message: "injected", details: null });
  assert.match(d4.summary("grok"), /2 problems/, "problemsFor exposes the internal array (quirk)");
}

// ------------------------------------------------------- log file contents / cap
{
  const dir = path.join(tmp, "cap"); fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, "collector.log"), stateFile = path.join(dir, "s.json");
  // Pre-seed with garbage + valid lines; existing lines are kept verbatim and
  // count toward the 300-line cap.
  const seed = [];
  for (let i = 0; i < 295; i++) seed.push(i % 10 === 0 ? `garbage line ${i}` : JSON.stringify({ at: "x", agent: "old", problem: `p${i}`, details: null }));
  fs.writeFileSync(logFile, seed.join("\n") + "\n");
  const d = createDiagnostics({ logFile, stateFile, now: () => 9_000 });
  for (let i = 0; i < 10; i++) d.add("new", `n${i}`);
  assert.equal(d.flush(), 10);
  const all = fs.readFileSync(logFile, "utf8").trim().split("\n");
  assert.equal(all.length, 300, "existing + new capped at 300");
  assert.ok(all.includes("garbage line 10"), "verbatim non-JSON lines preserved");
  assert.ok(!all.includes("garbage line 0"), "oldest lines dropped first");
  assert.equal(all[0], seed[5], "first surviving line is seed index 5");
  assert.ok(all.some((l) => l.includes('"agent":"new"')), "new lines appended");
  // mode 0600 applies only when the file is created: the pre-existing log keeps
  // its 0644, while the freshly written state file is 0600 (quirk).
  assert.equal(fs.statSync(logFile).mode & 0o777, 0o644, "existing log keeps its mode");
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600, "new state file is 0600");
}
// Empty log file and missing log file both work.
{
  const dir = path.join(tmp, "empty"); fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, "collector.log"), stateFile = path.join(dir, "s.json");
  fs.writeFileSync(logFile, "");
  let d = createDiagnostics({ logFile, stateFile, now: () => 1 });
  d.add("g", "m"); assert.equal(d.flush(), 1);
  assert.equal(fs.readFileSync(logFile, "utf8").trim().split("\n").length, 1);
  fs.rmSync(logFile);
  d = createDiagnostics({ logFile, stateFile, now: () => 61 * 60e3 });
  d.add("g", "m2"); assert.equal(d.flush(), 1, "missing log file recreated");
}

// ------------------------------------------------------- shared state across instances
{
  const dir = path.join(tmp, "shared"); fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, "collector.log"), stateFile = path.join(dir, "s.json");
  const t = 777_000;
  // Two live diagnostics objects (e.g. two collector runs overlapping) share the
  // state file: whoever flushes first wins, the second sees the timestamp.
  const a = createDiagnostics({ logFile, stateFile, now: () => t });
  const b = createDiagnostics({ logFile, stateFile, now: () => t });
  a.add("grok", "same"); b.add("grok", "same");
  assert.equal(a.flush(), 1);
  assert.equal(b.flush(), 0, "second instance rate-limited by first's state write");
  assert.equal(fs.readFileSync(logFile, "utf8").trim().split("\n").length, 1);
  // Interleaved: b adds a different problem and flushes at the same t.
  const c = createDiagnostics({ logFile, stateFile, now: () => t });
  c.add("grok", "other"); assert.equal(c.flush(), 1);
}

// Cleanup: restore env, remove scratch dir.
for (const k of Object.keys(savedEnv)) {
  if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
}
fs.rmSync(tmp, { recursive: true });
console.log("diagnostics.deep: all tests passed");
