// Deep edge-case pass for bin/reset-detect.mjs on top of reset-detect.test.mjs
// (which covers the headline paths: the 50-point boundary, scheduled vs
// surprise, window naming and magnitude).
//
// The module is pure: five exported functions over plain arrays, no file I/O,
// no module-level state, and the only clock is the `now` parameter (default
// Date.now()). There is nothing to race and no state to go stale, so this file
// covers what a pure module CAN get wrong: garbage input shapes, coercion
// quirks, boundary strictness, option handling, and clock edges via `now`.
// HOME/XDG_* still point at a mkdtemp dir per the job rules, though nothing
// here should ever read them.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectResets, classifyResets, windowKind, windowKinds, windowPhrase, magnitudeOf, WATCHED } from "./reset-detect.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reset-detect-deep-"));
const savedEnv = {};
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  savedEnv[k] = process.env[k];
  process.env[k] = path.join(tmp, k.toLowerCase());
  fs.mkdirSync(process.env[k], { recursive: true });
}

const NOW = Date.parse("2026-11-21T12:00:00Z");
const iso = (ms) => new Date(NOW + ms).toISOString();
const L = (title, percent, extra = {}) => ({ title, percent, ...extra });

try {
  // ---- WATCHED itself: substring matching, case, and the /g lastIndex trap ----
  // The regex has no /g flag, so repeated .test calls cannot alternate.
  for (let i = 0; i < 5; i++) assert.equal(WATCHED.test("Session"), true, `WATCHED.test stable on call ${i}`);
  assert.equal(WATCHED.test("SESSION"), true, "case-insensitive");
  // QUIRK: plain substring matching — any title CONTAINING a window word is
  // watched, including words that only look like one.
  for (const t of ["Obsession", "Biweekly", "unsessioned"]) {
    assert.equal(WATCHED.test(t), true, `${t} contains a window substring`);
    assert.equal(detectResets([L(t, 0.9)], [L(t, 0)]).length, 1, `${t} counts as a watched meter`);
  }
  assert.equal(WATCHED.test("preweekend"), false, "no window word, no match");

  // ---- detectResets: what makes a meter "the same meter" ----
  // prev is keyed by RAW title: 5 and "5" are different meters.
  assert.deepEqual(detectResets([L(5, 0.9, { window: "session" })], [L("5", 0, { window: "session" })]), [], "number 5 != string \"5\"");
  assert.deepEqual(detectResets([L(5, 0.9, { window: "session" })], [L(5, 0, { window: "session" })]), [5], "same numeric title matches");
  // A meter watched only through its `window` field still matches by title.
  assert.deepEqual(detectResets([L("Credits", 0.9, { window: "session" })], [L("Credits", 0, { window: "session" })]), ["Credits"]);
  // QUIRK: the window field on EITHER side makes the pair watched; matching
  // itself ignores window, so a window on only the next side is enough.
  assert.deepEqual(detectResets([L("Credits", 0.9)], [L("Credits", 0, { window: "session" })]), ["Credits"],
    "window on the next side alone still counts as a watched reset");
  // Two entries with the same title in prevLimits: the LAST one wins (Map).
  assert.deepEqual(detectResets([L("Session", 0.9), L("Session", 0.1)], [L("Session", 0)]), [], "last prev entry (0.1) decides");
  assert.deepEqual(detectResets([L("Session", 0.1), L("Session", 0.9)], [L("Session", 0)]), ["Session"], "reversed order resets");
  // Duplicate titles in nextLimits each report.
  assert.deepEqual(detectResets([L("Session", 0.9)], [L("Session", 0), L("Session", 0.2)]), ["Session", "Session"]);
  // Output order follows nextLimits order, not prev order.
  assert.deepEqual(
    detectResets([L("Weekly", 0.9), L("Session", 0.9)], [L("Session", 0), L("Weekly", 0)]),
    ["Session", "Weekly"]);
  // Meters with no title on either side share the `undefined` Map key: a drop
  // is reported with `undefined` as the title.
  const untitled = detectResets([{ percent: 0.9, window: "session" }], [{ percent: 0, window: "session" }]);
  assert.equal(untitled.length, 1);
  assert.equal(untitled[0], undefined, "QUIRK: titleless watched meters reset to an undefined title");
  // A null/primitive prev entry maps title->undefined->percent undefined, so it
  // can never satisfy the numeric check even against a titleless next meter.
  assert.deepEqual(detectResets([null, 5, "x"], [{ percent: 0, window: "session" }]), []);

  // ---- detectResets: minDrop coercion ----
  const P = [L("Session", 0.9)], N = [L("Session", 0.4)]; // drop = 0.5 exactly
  assert.deepEqual(detectResets(P, N), [], "default 0.5: exactly 50 points is not a reset");
  assert.deepEqual(detectResets(P, N, 0.5), [], "explicit 0.5 same");
  assert.deepEqual(detectResets(P, N, 0.4), ["Session"], "a smaller minDrop counts it");
  assert.deepEqual(detectResets(P, N, 0), ["Session"], "minDrop 0: any decrease counts");
  assert.deepEqual(detectResets([L("Session", 0.4)], [L("Session", 0.9)], -0.6), ["Session"],
    "QUIRK: a negative minDrop makes a RISE look like a reset (-0.5 > -0.6)");
  assert.deepEqual(detectResets(P, N, null), ["Session"], "null minDrop coerces to 0: any decrease counts");
  assert.deepEqual(detectResets(P, N, NaN), [], "NaN minDrop: no comparison is ever true");
  assert.deepEqual(detectResets(P, N, "0.4"), ["Session"], "string minDrop is coerced numerically");
  assert.deepEqual(detectResets(P, N, undefined), [], "explicit undefined falls back to the 0.5 default");

  // ---- detectResets: percent edge values ----
  // typeof NaN === "number" passes the guard but every comparison is false.
  assert.deepEqual(detectResets([L("Session", NaN)], [L("Session", 0)]), []);
  assert.deepEqual(detectResets([L("Session", 0.9)], [L("Session", NaN)]), []);
  // Infinity arithmetic: Infinity - 0 > 0.5, and 0.9 - (-Infinity) > 0.5.
  assert.deepEqual(detectResets([L("Session", Infinity)], [L("Session", 0)]), ["Session"]);
  assert.deepEqual(detectResets([L("Session", 0.9)], [L("Session", -Infinity)]), ["Session"]);
  assert.deepEqual(detectResets([L("Session", -Infinity)], [L("Session", 0)]), [], "-Infinity - 0 is -Infinity, not a drop");
  // Non-number percents are skipped: boolean, bigint, string, null.
  for (const p of [true, 1n, "0.9", null, undefined, {}]) {
    assert.deepEqual(detectResets([L("Session", p)], [L("Session", 0)]), [], `prev percent ${String(p)}`);
    assert.deepEqual(detectResets([L("Session", 0.9)], [L("Session", p)]), [], `next percent ${String(p)}`);
  }
  // -0 and 0 are the same meter value; no drop.
  assert.deepEqual(detectResets([L("Session", -0)], [L("Session", 0)]), []);
  // Over-100% and negative percents still subtract arithmetically.
  assert.deepEqual(detectResets([L("Session", 1.4)], [L("Session", 0.5)]), ["Session"], "140% -> 50% is a 90-point drop");

  // ---- detectResets / classifyResets: non-array and primitive entries ----
  for (const bad of ["junk", 5, {}, true, new Uint8Array(3)]) {
    assert.deepEqual(detectResets(bad, [L("Session", 0)]), [], `prev=${Object.prototype.toString.call(bad)}`);
    assert.deepEqual(detectResets([L("Session", 0.9)], bad), [], `next=${Object.prototype.toString.call(bad)}`);
    assert.deepEqual(classifyResets(bad, [L("Session", 0, { resetsAt: iso(-1000) })], NOW), [], "classify prev");
    assert.deepEqual(classifyResets([L("Session", 0.9)], bad, NOW), [], "classify next");
  }
  // Array-likes that are not real arrays are ignored (Array.isArray is strict).
  assert.deepEqual(detectResets({ 0: L("Session", 0.9), length: 1 }, [L("Session", 0)]), []);
  // Primitive entries inside real arrays never throw.
  assert.doesNotThrow(() => detectResets([null, undefined, 5, "x", true], [null, L("Session", 0)]));
  assert.doesNotThrow(() => classifyResets([null, undefined, 5], [L("Session", 0)], NOW));

  // ---- classifyResets: the surprise boundary is STRICT ----
  const FUTURE = iso(86400e3), PAST = iso(-86400e3);
  // due - now === toleranceMs exactly: still scheduled (the check is `>`).
  assert.equal(
    classifyResets([L("Session", 0.9, { resetsAt: iso(300e3) })], [L("Session", 0)], NOW, { toleranceMs: 300e3 })[0].surprise,
    false, "exactly at the tolerance is scheduled");
  assert.equal(
    classifyResets([L("Session", 0.9, { resetsAt: iso(300e3 + 1) })], [L("Session", 0)], NOW, { toleranceMs: 300e3 })[0].surprise,
    true, "1 ms past the tolerance is a surprise");
  // A due time in the past is scheduled even with toleranceMs 0 or negative...
  assert.equal(classifyResets([L("Session", 0.9, { resetsAt: PAST })], [L("Session", 0)], NOW, { toleranceMs: 0 })[0].surprise, false);
  assert.equal(classifyResets([L("Session", 0.9, { resetsAt: PAST })], [L("Session", 0)], NOW, { toleranceMs: -1 })[0].surprise, false);
  // ...but toleranceMs 0 makes ANY future due a surprise, even 1 ms out.
  const tiny = classifyResets([L("Session", 0.9, { resetsAt: iso(1) })], [L("Session", 0)], NOW, { toleranceMs: 0 });
  assert.equal(tiny[0].surprise, true);
  assert.equal(tiny[0].dueAt, iso(1), "dueAt is the previous meter's resetsAt, ISO-normalized");
  // NaN toleranceMs: every `>` comparison is false -> nothing is ever a surprise.
  assert.equal(classifyResets([L("Session", 0.9, { resetsAt: FUTURE })], [L("Session", 0)], NOW, { toleranceMs: NaN })[0].surprise, false);
  // A huge toleranceMs swallows even far-future dues.
  assert.equal(classifyResets([L("Session", 0.9, { resetsAt: iso(86400e3) })], [L("Session", 0)], NOW, { toleranceMs: 90 * 86400e3 })[0].surprise, false);

  // ---- classifyResets: options object handling ----
  // Partial options keep the other defaults.
  const part = classifyResets([L("Session", 0.9, { resetsAt: FUTURE })], [L("Session", 0.5)], NOW, { minDrop: 0.1 });
  assert.equal(part.length, 1, "custom minDrop 0.1 counts a 40-point drop");
  assert.equal(part[0].surprise, true, "default 5-minute tolerance still applies");
  // String minDrop coerces like detectResets.
  assert.deepEqual(classifyResets([L("Session", 0.9, { resetsAt: PAST })], [L("Session", 0.5)], NOW, { minDrop: "0.5" }), [],
    "string \"0.5\" minDrop: 0.4 is not > 0.5");
  // Empty options object = all defaults.
  assert.equal(classifyResets([L("Session", 0.9, { resetsAt: iso(6 * 60e3) })], [L("Session", 0)], NOW, {})[0].surprise, true,
    "6 minutes out with default tolerance is a surprise");
  // BUG: passing null (or any non-object) as the options argument throws a
  // TypeError — the `= {}` default only covers undefined. Every other input to
  // this module is guarded; this one is not.
  // assert.doesNotThrow(() => classifyResets([], [], NOW, null));
  // assert.deepEqual(classifyResets([L("Session", 0.9, { resetsAt: FUTURE })], [L("Session", 0)], NOW, null)[0].surprise, true);

  // ---- classifyResets: `now` coercion ----
  // NaN now: due - NaN is NaN, never > tolerance -> always scheduled.
  assert.equal(classifyResets([L("Session", 0.9, { resetsAt: FUTURE })], [L("Session", 0)], NaN)[0].surprise, false);
  // A numeric-string now coerces and classifies normally.
  assert.equal(classifyResets([L("Session", 0.9, { resetsAt: FUTURE })], [L("Session", 0)], String(NOW))[0].surprise, true);
  // An unparseable now string -> NaN arithmetic -> scheduled.
  assert.equal(classifyResets([L("Session", 0.9, { resetsAt: FUTURE })], [L("Session", 0)], "soon")[0].surprise, false);

  // ---- classifyResets: resetsAt coercion (Date.parse stringifies its input) ----
  // A number is NOT a timestamp: Date.parse(1893456000000) is NaN -> scheduled.
  assert.equal(classifyResets([L("Session", 0.9, { resetsAt: NOW + 86400e3 })], [L("Session", 0)], NOW)[0].surprise, false,
    "QUIRK: a millisecond-number resetsAt is unreadable, never a surprise");
  // A Date object stringifies to a parseable date -> surprise works.
  assert.equal(classifyResets([L("Session", 0.9, { resetsAt: new Date(NOW + 86400e3) })], [L("Session", 0)], NOW)[0].surprise, true,
    "QUIRK: a Date object resetsAt parses via toString");
  // A one-element array stringifies to its element -> also parses.
  assert.equal(classifyResets([L("Session", 0.9, { resetsAt: [FUTURE] })], [L("Session", 0)], NOW)[0].surprise, true,
    "QUIRK: resetsAt:[iso] parses because [x].toString() === x");
  // An object with a custom toString parses too.
  assert.equal(classifyResets([L("Session", 0.9, { resetsAt: { toString: () => FUTURE } })], [L("Session", 0)], NOW)[0].surprise, true);
  // Booleans, null, empty string, unparseable strings -> scheduled.
  for (const ra of [true, false, null, undefined, "", "soon-ish", {}, []]) {
    assert.equal(classifyResets([L("Session", 0.9, { resetsAt: ra })], [L("Session", 0)], NOW)[0].surprise, false, `resetsAt=${JSON.stringify(ra)}`);
  }
  // dueAt is only populated for surprises; scheduled entries always carry "".
  const mixed = classifyResets(
    [L("Session", 0.9, { resetsAt: FUTURE }), L("Weekly", 0.9, { resetsAt: PAST })],
    [L("Session", 0), L("Weekly", 0)], NOW);
  assert.deepEqual(mixed.map((x) => [x.surprise, x.dueAt]), [[true, FUTURE], [false, ""]]);

  // ---- classifyResets: prev matching quirks (mirrors detectResets) ----
  // Duplicate prev titles: the LAST entry supplies BOTH percent and resetsAt.
  assert.deepEqual(classifyResets(
    [L("Session", 0.9, { resetsAt: PAST }), L("Session", 0.8, { resetsAt: FUTURE })],
    [L("Session", 0)], NOW),
    [{ title: "Session", surprise: true, dueAt: FUTURE }], "last prev wins, resetsAt included");
  // Duplicate next titles: each is classified on its own.
  assert.deepEqual(classifyResets(
    [L("Session", 0.9, { resetsAt: FUTURE })],
    [L("Session", 0), L("Session", 0.1)], NOW).length, 2);
  // Matching is by title only: prev and next `window` fields may differ.
  assert.equal(classifyResets(
    [{ title: "Credits", window: "weekly", percent: 0.9, resetsAt: FUTURE }],
    [{ title: "Credits", window: "monthly", percent: 0 }], NOW).length, 1,
    "window field differences do not break title matching");
  // The exact-50 boundary is exclusive here too (<= minDrop skips).
  assert.deepEqual(classifyResets([L("Session", 0.9, { resetsAt: FUTURE })], [L("Session", 0.4)], NOW), [], "exactly 50 points is not a reset");
  assert.equal(classifyResets([L("Session", 0.9, { resetsAt: FUTURE })], [L("Session", 0.39)], NOW).length, 1, "51 points is");

  // ---- statelessness, purity, and the real-clock default ----
  // No module-level state: identical calls return identical results, and
  // frozen inputs are never mutated.
  const pf = Object.freeze([Object.freeze(L("Session", 0.9, { resetsAt: FUTURE }))]);
  const nf = Object.freeze([Object.freeze(L("Session", 0))]);
  const r1 = classifyResets(pf, nf, NOW);
  const r2 = classifyResets(pf, nf, NOW);
  assert.deepEqual(r1, r2);
  assert.deepEqual(r1, [{ title: "Session", surprise: true, dueAt: FUTURE }]);
  assert.deepEqual(detectResets(pf, nf), ["Session"]);
  // Omitting `now` uses the real clock: a 2100 reset is a surprise, a 2020 one is not.
  assert.equal(classifyResets([L("Session", 0.9, { resetsAt: "2100-01-01T00:00:00Z" })], [L("Session", 0)])[0].surprise, true);
  assert.equal(classifyResets([L("Session", 0.9, { resetsAt: "2020-01-01T00:00:00Z" })], [L("Session", 0)])[0].surprise, false);

  // ---- windowKind: fixed priority, substring reach, coercion ----
  // The check order is ["session","weekly","monthly","daily"] — NOT position in
  // the string. "Monthly Session" reports session because session is checked first.
  assert.equal(windowKind("Monthly Session"), "session");
  // "Daily Weekly" contains weekly, which is checked before daily.
  assert.equal(windowKind("Daily Weekly"), "weekly");
  // Substring quirks mirror WATCHED.
  assert.equal(windowKind("Obsession"), "session");
  assert.equal(windowKind("Biweekly"), "weekly");
  assert.equal(windowKind("unsessioned"), "session");
  // Non-string titles are coerced with String(): numbers, objects, booleans.
  for (const [v, want] of [[5, ""], [{}, ""], [true, ""], [null, ""], [undefined, ""], [["Weekly"], "weekly"]]) {
    assert.equal(windowKind(v), want, `windowKind(${JSON.stringify(v) ?? String(v)})`);
  }
  // String(Symbol()) works here (unlike the template literal in detectResets).
  assert.equal(windowKind(Symbol("session")), "session", "Symbol coerces via String()");
  // BUG: the same Symbol title crashes detectResets/classifyResets with
  // "Cannot convert a Symbol value to a string" — the module guards every
  // other input shape but the WATCHED template literal still throws.
  // assert.doesNotThrow(() => detectResets([L(Symbol("x"), 0.9, { window: "session" })], [L(Symbol("x"), 0, { window: "session" })]));

  // ---- windowKinds / windowPhrase / magnitudeOf ----
  assert.deepEqual(windowKinds("not an array"), [], "non-array titles -> no windows");
  assert.deepEqual(windowKinds(null), []);
  assert.deepEqual(windowKinds([null, 5, "Session", "session", "WEEKLY"]), ["session", "weekly"],
    "non-strings ignored, case-insensitive, duplicates collapsed");
  // Canonical order is session, daily, weekly, monthly — daily BEFORE weekly,
  // which differs from windowKind's check order.
  assert.deepEqual(windowKinds(["Monthly", "Weekly", "Daily", "Session"]), ["session", "daily", "weekly", "monthly"]);
  assert.equal(windowPhrase(["Weekly", "Daily"]), "daily and weekly", "phrase follows the canonical order, not input order");
  assert.equal(windowPhrase(["Session", "Daily", "Weekly", "Monthly"]), "session, daily, weekly and monthly");
  assert.equal(windowPhrase(["Daily", "Session"]), "session and daily");
  assert.equal(windowPhrase(null), "limit");
  assert.equal(windowPhrase([null, undefined]), "limit");
  // magnitudeOf: monthly dominates weekly dominates baseline; daily never raises it.
  assert.equal(magnitudeOf(["Daily", "Weekly"]), 1.25);
  assert.equal(magnitudeOf(["Daily", "Monthly"]), 1.5);
  assert.equal(magnitudeOf(["Session", "Monthly", "Weekly"]), 1.5);
  assert.equal(magnitudeOf(null), 1);
  assert.equal(magnitudeOf("Weekly"), 1, "non-array titles -> baseline");

  console.log("reset-detect deep: all tests passed");
} finally {
  for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
