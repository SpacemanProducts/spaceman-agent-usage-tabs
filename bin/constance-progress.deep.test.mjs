// Deeper edge-case tests for bin/constance-progress.mjs: wrong types and
// coercions in progressLine, every corrupt/empty/mis-shaped state file due()
// can meet, clock edges (backwards clock, future stamps, zero/negative
// intervals), notify()'s exec contract corners, and tick()'s behavior when
// the stamp can never persist. Same style as constance-progress.test.mjs:
// plain asserts, mktemp dirs, env pointed at the temp home, injected exec.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "constance-progress-deep-home-"));
process.env.HOME = home;
process.env.XDG_STATE_HOME = path.join(home, ".local", "state");
process.env.XDG_CONFIG_HOME = path.join(home, ".config");
process.env.XDG_CACHE_HOME = path.join(home, ".cache");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-progress-deep-"));

const { progressLine, due, notify, tick } = await import("./constance-progress.mjs");

// ---- progressLine: coercion and wrong types.
// Strings that look like numbers are NOT accepted for devinTokens (only
// Number.isFinite counts), but session pcts are Number()-coerced.
assert.equal(
  progressLine({ devinTokens: "42e6", sessionUsedPct: 62, sessionStartPct: "52", copiesRunning: 9 }),
  "Devin can't tell · can't tell per 1% of session (target 5M) · 9 copies running · session 62%");
// NaN and both infinities are "can't tell" for tokens — never InfinityT.
for (const bad of [NaN, Infinity, -Infinity]) {
  assert.equal(
    progressLine({ devinTokens: bad, sessionUsedPct: 62, sessionStartPct: 52 }),
    "Devin can't tell · can't tell per 1% of session (target 5M) · 0 copies running · session 62%",
    `devinTokens ${bad}`);
}
// sessionUsedPct NaN -> "no session spent yet" and "session ?%".
assert.equal(
  progressLine({ devinTokens: 42e6, sessionUsedPct: NaN, sessionStartPct: 52 }),
  "Devin 42M · no session spent yet · 0 copies running · session ?%");
// sessionUsedPct Infinity: delta is Infinity, perPct collapses to 0, the
// session percent itself stays honest ("?").
assert.equal(
  progressLine({ devinTokens: 42e6, sessionUsedPct: Infinity, sessionStartPct: 52 }),
  "Devin 42M · 0 per 1% of session (target 5M) · 0 copies running · session ?%");
// copiesRunning must be a real finite number: strings, NaN, Infinity -> 0;
// negative and fractional values pass through verbatim.
assert.equal(
  progressLine({ devinTokens: 1e6, sessionUsedPct: 60, sessionStartPct: 50, copiesRunning: "9" }),
  "Devin 1M · 100K per 1% of session (target 5M) · 0 copies running · session 60%");
assert.equal(
  progressLine({ devinTokens: 1e6, sessionUsedPct: 60, sessionStartPct: 50, copiesRunning: NaN }),
  "Devin 1M · 100K per 1% of session (target 5M) · 0 copies running · session 60%");
assert.equal(
  progressLine({ devinTokens: 1e6, sessionUsedPct: 60, sessionStartPct: 50, copiesRunning: 1.5 }),
  "Devin 1M · 100K per 1% of session (target 5M) · 1.5 copies running · session 60%");
// devinTokens 0 is a real reading: "Devin 0", and a spent window gives "0".
assert.equal(
  progressLine({ devinTokens: 0, sessionUsedPct: 60, sessionStartPct: 50 }),
  "Devin 0 · 0 per 1% of session (target 5M) · 0 copies running · session 60%");
// A negative delta counts as "not spent" even when used > start is false but
// tokens are known — covered above; here start > used with huge tokens.
assert.equal(
  progressLine({ devinTokens: 1e12, sessionUsedPct: 10, sessionStartPct: 90 }),
  "Devin 1T · no session spent yet · 0 copies running · session 10%");
// Over-100% session readings pass through.
assert.equal(
  progressLine({ devinTokens: 1e6, sessionUsedPct: 150, sessionStartPct: 140 }),
  "Devin 1M · 100K per 1% of session (target 5M) · 0 copies running · session 150%");
// target is only used for display; a negative target prints raw, a huge one
// goes through fmtTokens.
assert.equal(
  progressLine({ devinTokens: 1e6, sessionUsedPct: 60, sessionStartPct: 50, target: 0 }),
  "Devin 1M · 100K per 1% of session (target 0) · 0 copies running · session 60%");
// A non-finite target is unknown, like a missing one: "can't tell", never a
// crash (fmtTokens(NaN) throws; Infinity would print "InfinityT").
for (const bad of [NaN, Infinity, -Infinity]) {
  assert.equal(
    progressLine({ devinTokens: 1e6, sessionUsedPct: 60, sessionStartPct: 50, target: bad }),
    "Devin 1M · 100K per 1% of session (target can't tell) · 0 copies running · session 60%",
    `target ${bad}`);
}

// ---- due: every shape of state file content.
const state = (...parts) => path.join(dir, ...parts);
// Valid JSON that isn't an object with a numeric .at all count as "never".
for (const [name, content] of [
  ["null.json", "null"],
  ["num.json", "5"],
  ["str.json", '"hello"'],
  ["arr.json", "[]"],
  ["empty-obj.json", "{}"],
  ["at-str.json", '{"at":"abc"}'],
  ["at-neg.json", '{"at":-5}'],
  ["empty.json", ""],
  ["ws.json", "  \n\t "]
]) {
  const f = state(name);
  fs.writeFileSync(f, content);
  assert.equal(due(f, 1000, 500), true, `${name} counts as never notified`);
}
// A numeric string "at" IS honored (Number() coercion in the module).
{
  const f = state("at-str-num2.json");
  fs.writeFileSync(f, '{"at":"900"}');
  assert.equal(due(f, 1000, 500), false, "string at within interval suppresses");
  assert.equal(due(f, 1401, 500), true, "string at past interval is due");
}
// A state path that is a directory: read fails, write fails, still "due".
{
  const d = state("as-dir");
  fs.mkdirSync(d);
  assert.equal(due(d, 1000, 500), true, "unwritable stamp still reports due");
}
// A parent component that is a file: mkdir/write fail, still due, and the
// next call tries again (no stamp ever lands).
{
  const blocker = state("blocker");
  fs.writeFileSync(blocker, "x");
  const f = path.join(blocker, "state.json");
  assert.equal(due(f, 1000, 500), true);
  assert.equal(due(f, 1001, 500), true, "nothing persisted -> due again");
}
// degenerate intervals: every=0 and negative every make every call due
// (a stamp can't be "less than" a non-positive interval away).
{
  const f = state("zero-every.json");
  assert.equal(due(f, 1000, 0), true);
  assert.equal(due(f, 1000, 0), true, "every=0 -> always due");
  const g = state("neg-every.json");
  assert.equal(due(g, 1000, -1), true);
  assert.equal(due(g, 1000, -1), true, "negative every -> always due");
}
// Clock edges: a stamp in the future (clock jumped back, or a bad write)
// suppresses until `every` ms past THAT future time — now-last is negative.
{
  const f = state("future.json");
  assert.equal(due(f, 5000, 1000), true);
  assert.equal(due(f, 4999, 1000), false, "clock one ms back is still inside the interval");
  assert.equal(due(f, 4000, 1000), false, "clock far back still suppressed by the future stamp");
  assert.equal(due(f, 5999, 1000), false);
  assert.equal(due(f, 6000, 1000), true, "due once the interval clears the stamp");
}
// now given as a string: the arithmetic still works and the stamp stores
// whatever was passed.
{
  const f = state("str-now.json");
  assert.equal(due(f, "1000", 500), true);
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).at, "1000", "stamp stores the raw now");
  assert.equal(due(f, "1200", 500), false, "string now still compares numerically");
  assert.equal(due(f, "1501", 500), true);
}
// Non-string stateFile: due() never throws and always reports due, because
// both the read and the mkdir/write land in the swallowed try/catch.
for (const weird of [null, undefined, "", 0, 123, {}, []]) {
  assert.equal(due(weird, 1000, 500), true, `due(${JSON.stringify(weird) ?? String(weird)})`);
}
// The stamp file content is exactly {"at":now}\n and the parent dir is made.
{
  const f = state("shape", "deep", "stamp.json");
  due(f, 4242, 500);
  assert.equal(fs.readFileSync(f, "utf8"), '{"at":4242}\n');
}
// A stamp written by someone else between calls is honored — due() re-reads
// the file every call, there is no in-memory cache to go stale.
{
  const f = state("external.json");
  assert.equal(due(f, 1000, 500), true);
  fs.writeFileSync(f, JSON.stringify({ at: 5000 }));
  assert.equal(due(f, 5100, 500), false, "externally advanced stamp suppresses");
  assert.equal(due(f, 5501, 500), true);
}

// ---- notify: the exec contract corners.
// exec returning undefined counts as success (!r).
assert.equal(notify("x", { exec: () => undefined }), true, "undefined result is treated as sent");
// status must be exactly 0; null, "0", missing all fail.
for (const r of [{ status: null }, { status: "0" }, {}, { status: 1 }, null]) {
  assert.equal(notify("x", { exec: () => r }), r === null ? true : false,
    `exec result ${JSON.stringify(r)}`);
}
// exec explicitly null (not undefined) is not the default: calling it throws,
// caught -> false.
assert.equal(notify("x", { exec: null }), false);
// Non-string lines are String()-coerced into a single body arg; the opts
// carry the 5s timeout and ignored stdio.
{
  const calls = [];
  const spy = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0 }; };
  assert.equal(notify(12345, { exec: spy }), true);
  assert.equal(notify(null, { exec: spy }), true);
  assert.deepEqual(calls[0].args.at(-1), "12345");
  assert.deepEqual(calls[1].args.at(-1), "null");
  assert.equal(calls[0].opts.timeout, 5000);
  assert.equal(calls[0].opts.stdio, "ignore");
}
// A line with a newline stays one argv element (no shell involved).
{
  const calls = [];
  notify("a\nb", { exec: (cmd, args) => { calls.push(args); return { status: 0 }; } });
  assert.equal(calls[0].at(-1), "a\nb");
}

// ---- tick: combinations and the unwritable-stamp path.
const t = { devinTokens: 42e6, sessionUsedPct: 62, sessionStartPct: 52, copiesRunning: 9 };
const line = "Devin 42M · 4.2M per 1% of session (target 5M) · 9 copies running · session 62%";
// stateFile truthy but unusable (a number): due() reports due every call, so
// EVERY tick notifies — the stamp can never persist. Documented best-effort
// behavior; a real caller always passes a path string.
{
  const calls = [];
  const exec = (cmd, args) => { calls.push(args); return { status: 0 }; };
  const r1 = tick({ ...t, stateFile: 123, now: 1000, every: 500, exec });
  const r2 = tick({ ...t, stateFile: 123, now: 1100, every: 500, exec });
  assert.deepEqual(r1, { line, notified: true });
  assert.deepEqual(r2, { line, notified: true }, "no persistable stamp -> notifies every tick");
  assert.equal(calls.length, 2);
}
// stateFile under a blocked parent: due() is true (write failed) so the
// notification still fires — best-effort throttle, notify is not gated on
// the stamp actually landing.
{
  const blocker = state("tick-blocker");
  fs.writeFileSync(blocker, "x");
  const calls = [];
  const exec = (cmd, args) => { calls.push(args); return { status: 0 }; };
  const r = tick({ ...t, stateFile: path.join(blocker, "s.json"), now: 1000, every: 500, exec });
  assert.equal(r.notified, true, "unwritable stamp still notifies once per call");
  assert.equal(calls.length, 1);
}
// exec failure inside tick surfaces as notified:false but the line survives.
{
  const f = state("tick-exec-fail.json");
  const r = tick({ ...t, stateFile: f, now: 1000, every: 500, exec: () => ({ status: 1 }) });
  assert.deepEqual(r, { line, notified: false });
  // The stamp was still written: an immediate retry inside the interval
  // does not even try to notify.
  const calls = [];
  const r2 = tick({ ...t, stateFile: f, now: 1100, every: 500, exec: (c, a) => { calls.push(a); return { status: 0 }; } });
  assert.equal(r2.notified, false);
  assert.equal(calls.length, 0);
}
// now/every/stateFile are consumed by tick, not forwarded into progressLine;
// unknown extra keys are ignored.
{
  const f = state("tick-extra.json");
  const r = tick({ ...t, stateFile: f, now: 1000, every: 500, exec: () => ({ status: 0 }), bogus: 1, copiesRunning: undefined });
  assert.equal(r.line.includes("copies running"), true);
}
// tick with no arguments at all still returns a line and never notifies.
{
  const r = tick();
  assert.equal(typeof r.line, "string");
  assert.equal(r.notified, false);
}
// tick({ stateFile }) with default now=Date.now(): two rapid calls throttle.
{
  const f = state("tick-realclock.json");
  const calls = [];
  const exec = (cmd, args) => { calls.push(args); return { status: 0 }; };
  const r1 = tick({ ...t, stateFile: f, every: 60e3, exec });
  const r2 = tick({ ...t, stateFile: f, every: 60e3, exec });
  assert.equal(r1.notified, true);
  assert.equal(r2.notified, false, "real-clock second call inside the interval");
  assert.equal(calls.length, 1);
}

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
console.log("constance-progress.deep: tests passed");
