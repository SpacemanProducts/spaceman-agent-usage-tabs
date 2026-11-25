// Deep edge-case pass for bin/claude-limits.mjs (parseClaudeLimits +
// parseClaudeResets), on top of claude-limits.test.mjs and the parser half of
// claude-deep.test.mjs. Those already pin the headline shapes: window
// boundaries, malformed payloads, display_name/id precedence, substring
// 'fable' matching, kind->window titles, first-wins dedupe, and the cedar_ember
// grant coercion quirks. This file covers what is left:
//
//   - windowTitle() precedence when a kind matches more than one window word
//   - Fable name/id coercion edge cases (falsy non-strings, arrays, objects)
//   - percent/utilization string forms Number() accepts or rejects
//   - cedar_ember shapes nobody else tries, including `eligible: false`
//     itself, which no existing test asserts
//   - purity: no shared state between calls, inputs are never mutated
//
// Both exports are synchronous pure functions: no fs, no env, no clock, no
// shared state — so there are no file races, clock edges or stale-state bugs
// to exercise. The mkdtemp HOME/XDG dirs below are only a guard in case the
// module ever grows I/O; nothing in it is read or written today.
//
// QUIRKS below assert the current behaviour and are reported, not fixed
// (this job is test-only).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseClaudeLimits, parseClaudeResets } from "./claude-limits.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-limits-deep-"));
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  const d = path.join(tmp, k.toLowerCase());
  fs.mkdirSync(d, { recursive: true });
  process.env[k] = d;
}

const lim = (p) => parseClaudeLimits(p);
const titles = (p) => lim(p).map((l) => l.title);
const fable = (model, extra = {}) => ({ kind: "weekly_scoped", scope: { model }, percent: 10, ...extra });
const R = parseClaudeResets;

// ===================================================== windowTitle() precedence
// windowTitle checks month, then week/day, then hour/session — first hit wins.
assert.deepEqual(titles({ limits: [fable({ display_name: "Fable" }, { kind: "weekly_session" })] }),
  ["Fable Weekly"], "QUIRK: 'weekly_session' contains 'week', which is checked before 'session'");
assert.deepEqual(titles({ limits: [fable({ display_name: "Fable" }, { kind: "monthly_week" })] }),
  ["Fable Monthly"], "QUIRK: 'monthly_week' contains 'month', checked before 'week'");
assert.deepEqual(titles({ limits: [fable({ display_name: "Fable" }, { kind: "monday" })] }),
  ["Fable Weekly"], "QUIRK: 'monday' contains 'day' — any kind with 'day' reads Weekly");
assert.deepEqual(titles({ limits: [fable({ display_name: "Fable" }, { kind: "friday" })] }),
  ["Fable Weekly"], "same substring quirk: 'friday' contains 'day'");
// Whitespace and non-string kinds still classify by substring after String()+lower.
assert.deepEqual(titles({ limits: [fable({ display_name: "Fable" }, { kind: "  Weekly_Scoped " })] }),
  ["Fable Weekly"], "padded kind still matches");
assert.deepEqual(titles({ limits: [fable({ display_name: "Fable" }, { kind: ["weekly_scoped"] })] }),
  ["Fable Weekly"], "QUIRK: an array kind stringifies to 'weekly_scoped' and matches");
// Every kind that maps to no window collapses to the same "Fable" title,
// so they dedupe against each other even though the kinds differ.
{
  const out = lim({ limits: [
    fable({ display_name: "Fable" }, { kind: "", percent: 10 }),
    fable({ display_name: "Fable" }, { kind: null, percent: 20 }),
    fable({ display_name: "Fable" }, { kind: undefined, percent: 30 }),
    fable({ display_name: "Fable" }, { kind: 0, percent: 40 }),
    fable({ display_name: "Fable" }, { kind: "weekly_scoped", percent: 50 }),
  ] });
  assert.deepEqual(out.map((l) => l.title), ["Fable", "Fable Weekly"],
    "all windowless kinds share one 'Fable' title; the weekly one is separate");
  assert.equal(out[0].percent, 0.1, "first windowless entry wins the dedupe");
}
// All three window flavours coexist, in payload order.
assert.deepEqual(titles({ limits: [
  fable({ display_name: "Fable" }, { kind: "monthly_scoped" }),
  fable({ display_name: "Fable" }, { kind: "weekly_scoped" }),
  fable({ display_name: "Fable" }, { kind: "hourly_scoped" }),
  fable({ display_name: "Fable" }, { kind: "mystery" }),
] }), ["Fable Monthly", "Fable Weekly", "Fable Session", "Fable"],
  "dedupe is per-title; distinct windows keep payload order");
// Different Fable display names still collide on the same window title.
{
  const out = lim({ limits: [
    fable({ display_name: "Fable 5.2" }, { percent: 10 }),
    fable({ display_name: "Fable 6" }, { percent: 90 }),
  ] });
  assert.equal(out.length, 1);
  assert.equal(out[0].percent, 0.1, "two different Fable models on one window: first wins");
}

// ===================================================== Fable name/id coercion
for (const dn of [0, false, null, NaN])
  assert.deepEqual(titles({ limits: [fable({ display_name: dn, id: "claude-fable-5-2" })] }), ["Fable Weekly"],
    `falsy display_name ${String(dn)} falls back to id`);
assert.deepEqual(titles({ limits: [fable({ display_name: ["Fable"] })] }), ["Fable Weekly"],
  "QUIRK: an array display_name stringifies to 'Fable' and matches");
assert.deepEqual(titles({ limits: [fable({ display_name: { toString: () => "Fable 9" } })] }), ["Fable Weekly"],
  "QUIRK: an object display_name is String()-coerced, toString included");
assert.deepEqual(titles({ limits: [fable({ display_name: "", id: ["x", "fable-1"] })] }), ["Fable Weekly"],
  "QUIRK: an array id stringifies to 'x,fable-1' and matches");
assert.deepEqual(titles({ limits: [fable({ display_name: "Fable" }, { kind: "weekly_scoped", scope: undefined })] }), [],
  "scope present-but-undefined is skipped");
for (const s of ["x", 5, () => {}, true])
  assert.deepEqual(lim({ limits: [{ kind: "weekly_scoped", scope: s, percent: 5, ...{} }] }), [],
    `scope=${typeof s} is not an object -> skipped`);
for (const m of ["fable", 5, () => {}, true])
  assert.deepEqual(lim({ limits: [{ kind: "weekly_scoped", scope: { model: m }, percent: 5 }] }), [],
    `model=${typeof m} is not an object -> skipped`);
assert.deepEqual(lim({ limits: [() => {}] }), [], "a function entry has no scope -> skipped");
assert.deepEqual(lim({ limits: [["weekly_scoped"]] }), [], "an array entry has no scope -> skipped");

// ===================================================== percent / utilization forms
// pct() only accepts finite numbers >= 0 after Number(); these all read as
// "no value" and must never surface as a 0% meter.
for (const v of ["5%", "50 percent", "0b102", "--5", "+", " ", "\t\n", "NaN", "-Infinity"])
  assert.deepEqual(lim({ five_hour: { utilization: v }, seven_day: { utilization: 1 } }).map((l) => l.title), ["Weekly"],
    `utilization ${JSON.stringify(v)} is no value`);
assert.equal(lim({ five_hour: { utilization: -0 } })[0].percent, 0, "-0 is a real 0% reading");
assert.equal(lim({ five_hour: { utilization: 1e308 } })[0].percent, 1, "huge finite utilization clamps to 1");
assert.equal(lim({ five_hour: { utilization: "5%" } })[0], undefined,
  "a percent-sign string is not a number -> Session meter absent entirely");
// Same coercion rules apply to scoped Fable `percent`.
for (const v of ["5%", "-5", "Infinity", " "])
  assert.deepEqual(lim({ limits: [fable({ display_name: "Fable" }, { percent: v })] }), [],
    `Fable percent ${JSON.stringify(v)} is no value`);
assert.equal(lim({ limits: [fable({ display_name: "Fable" }, { percent: "0.5" })] })[0].percent, 0.005,
  "a fractional string percent is divided by 100 like any other");

// ===================================================== resetsAt passthrough
// Truthy non-string resets_at values pass through raw on both window kinds.
{
  const out = lim({ five_hour: { utilization: 5, resets_at: { at: 1 } },
    seven_day: { utilization: 5, resets_at: ["r"] },
    limits: [fable({ display_name: "Fable" }, { resets_at: true })] });
  assert.deepEqual(out[0].resetsAt, { at: 1 }, "object resets_at passes through on Session");
  assert.deepEqual(out[1].resetsAt, ["r"], "array resets_at passes through on Weekly");
  assert.equal(out[2].resetsAt, true, "boolean resets_at passes through on Fable");
}

// ===================================================== exotic payload shapes
for (const p of [() => {}, Object.create(null), new Map(), new Date(0)])
  assert.deepEqual(lim(p), [], `payload ${Object.prototype.toString.call(p)} yields no meters`);
assert.deepEqual(lim({ limits: new Set([fable({ display_name: "Fable" })]) }), [],
  "a Set of limits is not an array -> no Fable meter");

// ===================================================== parseClaudeResets: cedar_ember shapes
// The literal `eligible === false` is the ONLY block; false itself must block.
assert.equal(R({ cedar_ember: { eligible: false, grants: [{ resets_left: 3 }] } }), null,
  "eligible:false with real grants yields nothing");
assert.equal(R({ cedar_ember: { eligible: false } }), null);
assert.equal(R({ cedar_ember: { eligible: null, grants: [{ resets_left: 1 }] } })?.left, 1,
  "QUIRK: eligible:null is not false -> grants still count");
for (const b of [() => {}, new Date(0), new Map()])
  assert.equal(R({ cedar_ember: b }), null, `cedar_ember=${Object.prototype.toString.call(b)} yields nothing`);
for (const g of [{}, 5, true, "x"])
  assert.equal(R({ cedar_ember: { grants: g } }), null, `grants=${JSON.stringify(g)} yields nothing`);
for (const p of ["x", 5, [], () => {}, new Date(0)])
  assert.equal(R(p), null, `payload=${Object.prototype.toString.call(p)} yields nothing`);

// resets_left coercion: Number() accepts more string forms than plain digits.
{
  const r = R({ cedar_ember: { grants: [
    { resets_left: " 3 " },   // whitespace-padded -> 3
    { resets_left: "0x2" },   // hex -> 2
    { resets_left: "1e1" },   // exponent -> 10
    { resets_left: "" },      // Number("") === 0 -> unusable
    { resets_left: "  " },    // whitespace -> 0 -> unusable
    { resets_left: Infinity },// not an integer -> unusable
    { resets_left: NaN },
  ] } });
  assert.deepEqual(r, { left: 15, usableNow: false, expiresAt: "" },
    "\" 3 \"+\"0x2\"+\"1e1\" = 3+2+10 = 15; empty/whitespace/NaN/Infinity counts are unusable");
}
{
  // QUIRK: left is a plain running sum — it can leave the safe-integer range
  // and even become Infinity, and is reported verbatim.
  const r = R({ cedar_ember: { grants: [{ resets_left: 1e308 }, { resets_left: 1e308 }] } });
  assert.equal(r.left, Infinity, "QUIRK: two 1e308 grants sum to Infinity and are still reported");
}
{
  // usable_now is only read on grants that pass the count/paused checks.
  const r = R({ cedar_ember: { grants: [
    { resets_left: 0, usable_now: true },   // unusable count -> usable_now ignored
    { resets_left: 1, usable_now: true, paused: true }, // paused -> ignored
    { resets_left: 1 },
  ] } });
  assert.deepEqual(r, { left: 1, usableNow: false, expiresAt: "" },
    "usable_now from unusable or paused grants never surfaces");
}
{
  // ends_at parsing: empty/missing dates are ignored; date-only and offset
  // forms are valid and normalised to ISO UTC.
  const r = R({ cedar_ember: { grants: [
    { resets_left: 1, ends_at: "" },
    { resets_left: 1, ends_at: "2026-12-05" },                    // date-only -> local? no: UTC midnight
    { resets_left: 1, ends_at: "2026-12-06T05:30:00+05:30" },     // = 2026-12-06T00:00:00Z
    { resets_left: 1, ends_at: "junk" },
  ] } });
  assert.equal(r.expiresAt, "2026-12-05T00:00:00.000Z",
    "earliest VALID ends_at wins; '' and 'junk' are ignored, offsets normalise to UTC");
}

// ===================================================== purity / no shared state
{
  const payload = { five_hour: { utilization: 10, resets_at: "a" },
    limits: [fable({ display_name: "Fable" }, { percent: 20 })],
    cedar_ember: { grants: [{ resets_left: 1 }] } };
  const deepFreeze = (o) => { if (o && typeof o === "object") { for (const v of Object.values(o)) deepFreeze(v); Object.freeze(o); } return o; };
  const frozen = deepFreeze(JSON.parse(JSON.stringify(payload)));
  const a = lim(frozen);
  const b = lim(frozen);
  assert.deepEqual(a, b, "same input -> identical output on repeat calls");
  a[0].percent = 0.99; a[1].title = "mutated";
  assert.notDeepEqual(lim(frozen), a, "mutating a result does not leak into the next call");
  assert.equal(parseClaudeLimits(frozen).length, 2, "frozen payload parses without throwing");
  const r1 = R(frozen); const r2 = R(frozen);
  assert.deepEqual(r1, r2);
  r1.left = 999;
  assert.equal(R(frozen).left, 1, "mutating a resets result does not leak either");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("claude-limits.deep: all tests passed");
