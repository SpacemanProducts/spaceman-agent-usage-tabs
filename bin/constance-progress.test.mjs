// constance-progress: progressLine's segments and honest edges (zero delta,
// sub-0.1 delta, unknown tokens, singular copy), due()'s once-per-interval
// stamp in a mktemp file, notify()'s notify-send args through a fake exec,
// and tick() combining them — the line always comes back, notified only when
// the interval elapsed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "constance-progress-home-"));
process.env.HOME = home;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-progress-"));

const { progressLine, due, notify, tick } = await import("./constance-progress.mjs");

// progressLine: the happy path matches the spec's shape exactly.
assert.equal(
  progressLine({ devinTokens: 42e6, sessionUsedPct: 62, sessionStartPct: 52, copiesRunning: 9 }),
  "Devin 42M · 4.2M per 1% of session (target 5M) · 9 copies running · session 62%");

// A delta of zero (and a negative one, e.g. the window just reset) says so
// instead of dividing.
assert.equal(
  progressLine({ devinTokens: 42e6, sessionUsedPct: 62, sessionStartPct: 62, copiesRunning: 9 }),
  "Devin 42M · no session spent yet · 9 copies running · session 62%");
assert.equal(
  progressLine({ devinTokens: 42e6, sessionUsedPct: 40, sessionStartPct: 62, copiesRunning: 9 }),
  "Devin 42M · no session spent yet · 9 copies running · session 40%");

// A positive delta under 0.1 still divides — by the 0.1 floor.
assert.equal(
  progressLine({ devinTokens: 1e6, sessionUsedPct: 50.05, sessionStartPct: 50, copiesRunning: 2 }),
  "Devin 1M · 10M per 1% of session (target 5M) · 2 copies running · session 50%");

// Unknown tokens are "can't tell", never a guess; target is overridable.
assert.equal(
  progressLine({ devinTokens: null, sessionUsedPct: 62, sessionStartPct: 52, copiesRunning: 0, target: 2e6 }),
  "Devin can't tell · can't tell per 1% of session (target 2M) · 0 copies running · session 62%");

// Singular/plural copy, fractional session percent, defaults.
assert.equal(
  progressLine({ devinTokens: 500e3, sessionUsedPct: 62.5, sessionStartPct: 60, copiesRunning: 1 }),
  "Devin 500K · 200K per 1% of session (target 5M) · 1 copy running · session 62.5%");
assert.equal(progressLine().includes("can't tell"), true, "no args still yields a line");

// due: true the first time, then at most once per interval.
const state = path.join(dir, "progress.json");
const t0 = 1_000_000;
assert.equal(due(state, t0, 1000), true);
assert.equal(due(state, t0 + 999, 1000), false);
assert.equal(due(state, t0 + 1000, 1000), true, "exactly at the interval is due again");
assert.equal(due(state, t0 + 1999, 1000), false);
assert.equal(due(state, t0 + 2000, 1000), true);

// A missing parent dir is created; a broken file counts as never notified.
const nested = path.join(dir, "a", "b", "state.json");
assert.equal(due(nested, t0, 1000), true);
fs.writeFileSync(state, "{broken");
assert.equal(due(state, t0 + 5000, 1000), true);
assert.equal(JSON.parse(fs.readFileSync(state, "utf8")).at, t0 + 5000, "the stamp was rewritten");

// notify: notify-send with app Constance, suppressed sound, line as body —
// through the injected exec, never the real one.
const calls = [];
const fakeExec = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0 }; };
assert.equal(notify("the line", { exec: fakeExec }), true);
assert.equal(calls.length, 1);
assert.equal(calls[0].cmd, "notify-send");
assert.deepEqual(calls[0].args, ["-a", "Constance", "-h", "boolean:suppress-sound:true", "Constance", "the line"]);
assert.equal(notify("x", { exec: () => ({ status: 1 }) }), false, "nonzero exit is not a send");
assert.equal(notify("x", { exec: () => { throw new Error("no notify-send"); } }), false, "a throwing exec is not a send");
assert.equal(calls.length, 1, "failed sends pushed no more calls");

// tick: the line always comes back; notified only when due, and the fake exec
// sees exactly the notify-send calls.
const tickState = path.join(dir, "tick.json");
const tickCalls = [];
const exec = (cmd, args) => { tickCalls.push({ cmd, args }); return { status: 0 }; };
const t = { devinTokens: 42e6, sessionUsedPct: 62, sessionStartPct: 52, copiesRunning: 9 };
const line = "Devin 42M · 4.2M per 1% of session (target 5M) · 9 copies running · session 62%";
const r1 = tick({ ...t, stateFile: tickState, now: 5000, every: 1000, exec });
assert.deepEqual(r1, { line, notified: true });
assert.equal(tickCalls.length, 1);
const r2 = tick({ ...t, stateFile: tickState, now: 5500, every: 1000, exec });
assert.deepEqual(r2, { line, notified: false }, "inside the interval: line but no notify");
assert.equal(tickCalls.length, 1);
const r3 = tick({ ...t, stateFile: tickState, now: 6000, every: 1000, exec });
assert.deepEqual(r3, { line, notified: true });
assert.equal(tickCalls.length, 2);
assert.equal(tick({ ...t, now: 99999, exec }).notified, false, "no stateFile -> never notifies");
assert.equal(tickCalls.length, 2);

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
console.log("constance-progress: tests passed");
