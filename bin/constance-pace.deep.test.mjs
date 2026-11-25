// Deeper edge-case pass for bin/constance-pace.mjs, on top of
// constance-pace.test.mjs (which covers the headline stop/delegate/normal
// cases, Keep going, wall.json and the first canResume checks).
//
// Everything here is pure or dir-injected: windowPace() and canResume() do
// no I/O, and pace() gets a mkdtemp state dir, so no real claude/devin, no
// network and no real home are touched. `now` is fixed so every
// elapsed/burn/nearReset number is exact.
//
// Sections: windowPace burn math -> pace() boundaries (burn = 1, the 70/90/97%
// lines, missing windows, nearReset edges, a window at 100%) -> Keep going
// edges -> unsure/out-of-date readings -> wall.json edges.
//
// The bottom section covers malformed limits: null entries are ignored and
// a non-array `limits` value reads as no windows.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pace, canResume, windowPace, keepGoingFile, WINDOWS, STOP_AT, NEAR_END_AT, NEAR_RESET_SHARE, LEAN_AT, HARD_AT, SAME_RESET_MS } from "./constance-pace.mjs";
import { writeWall, wallFile } from "./constance-wall.mjs";

const now = Date.UTC(2026, 10, 25, 12);
const H = 3600e3, D = 86400e3;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-pace-deep-"));
const P = (c, t = now) => pace(c, t, dir);
const W = (l, t = now) => windowPace(l, t);
const iso = (ms) => new Date(ms).toISOString();
const lim = (title, percent, leftMs) => ({ title, percent, resetsAt: leftMs === null ? "" : iso(now + leftMs) });
const claude = (...ls) => ({ limits: ls });
// A benign weekly reading reused by the two-window cases: 30% used with ~4 of
// 7 days left is under every line (used < 70%, burn < 1, reset not close).
const WKL = lim("Weekly", 0.3, 4 * D);

// ------------------------------------------------- windowPace: the burn math
// burn = used / elapsed share, with elapsed floored at 0.05 so a window that
// just opened can't report an infinite burn.
{
  const w = W(lim("Session", 0.5, 2.5 * H)); // half the 5 h window gone, half used
  assert.equal(w.elapsed, 0.5);
  assert.equal(w.burn, 1, "used matching the elapsed share exactly is burn 1");
  assert.equal(W(lim("Weekly", 0.5, 3.5 * D)).burn, 1, "same on the weekly window");
}
{
  const fresh = W(lim("Session", 0.1, WINDOWS.Session)); // the whole length still ahead
  assert.equal(fresh.elapsed, 0);
  assert.equal(fresh.burn, 2, "10% of a brand-new window reads as burn 2 via the floor");
  assert.equal(W(lim("Session", 0.1, 10 * H)).burn, fresh.burn, "a reset past the window's end clamps the same way");
  assert.ok(Number.isFinite(W(lim("Session", 1, WINDOWS.Session)).burn), "the floor keeps burn finite even at 100%");
}
{
  const w = W(lim("Session", 0.4, -H)); // reset time already past: the window is over
  assert.equal(w.elapsed, 1);
  assert.equal(w.burn, 0.4);
  assert.equal(w.nearReset, true, "nothing left means 'close' by definition");
}
{
  const w = W(lim("Session", 0.95, null)); // no usable reset time
  assert.equal(w.elapsed, null); assert.equal(w.burn, null);
  assert.equal(w.nearReset, false, "no reset time can't prove the reset is close");
  assert.equal(w.resetsAt, null);
  assert.equal(W({ title: "Session", percent: 0.4, resetsAt: "soon" }).burn, null, "unparseable resetsAt is the same as none");
}
assert.equal(W({ title: "Monthly", percent: 0.5, resetsAt: iso(now + H) }), null, "a title outside WINDOWS isn't a pace window");
assert.equal(W({ title: "Session", percent: "abc", resetsAt: iso(now + H) }), null, "NaN percent");
assert.equal(W({ title: "Session", resetsAt: iso(now + H) }), null, "missing percent");
assert.equal(W(lim("Session", "0.5", H)).used, 0.5, "a numeric-string percent is still a number");

// nearReset = the last NEAR_RESET_SHARE of the window, inclusive. The share is
// fractional in floating point (the session's is ~3600000.0000000005 ms), so
// the +1 ms case is the first provably outside it.
assert.equal(W(lim("Session", 0.4, H)).nearReset, true, "exactly one hour of a 5 h window left is 'close'");
assert.equal(W(lim("Session", 0.4, H + 1)).nearReset, false);
assert.equal(W(lim("Weekly", 0.4, Math.round(WINDOWS.Weekly * NEAR_RESET_SHARE))).nearReset, true);
assert.equal(W(lim("Weekly", 0.4, Math.round(WINDOWS.Weekly * NEAR_RESET_SHARE) + 1)).nearReset, false);
assert.equal(W(lim("Session", 0.4, null)).nearReset, false);

// ------------------------------------------------------- pace(): the mode lines
// burn exactly 1 is NOT "too fast" — the fast line is strictly burn > 1.
{
  const p = P(claude(lim("Session", 0.5, 2.5 * H), WKL));
  assert.equal(p.mode, "normal", "burn exactly 1 with 50% used stays normal");
  assert.equal(p.windows[0].burn, 1);
}
// A hair over burn 1 with real usage delegates — the reason says it's pace.
{
  const p = P(claude(lim("Session", 0.5, 3 * H), WKL)); // elapsed ~0.4, burn ~1.25
  assert.equal(p.mode, "delegate");
  assert.match(p.reason, /of the window gone/);
}
// ...but the burn line only counts once 20% of the window is used: a fresh
// window burning fast on a sliver of use doesn't trip it.
{
  const p = P(claude(lim("Session", 0.1, WINDOWS.Session), WKL)); // burn 2 via the floor
  assert.equal(p.windows[0].burn, 2);
  assert.equal(p.mode, "normal", "under 20% used the burn rate alone can't delegate");
}
// The 70% line (LEAN_AT): exactly at it she delegates even on an easy burn;
// a hair under with the same burn stays normal. (1.2 h left of 5 h is elapsed
// 0.76, so burn is ~0.92 for both — the level alone decides.)
{
  const timing = 1.2 * H;
  const at = P(claude(lim("Session", LEAN_AT, timing), WKL));
  assert.equal(at.mode, "delegate");
  assert.match(at.reason, /at 70%/);
  assert.equal(P(claude(lim("Session", 0.69, timing), WKL)).mode, "normal", "69% on the same pace is still normal work");
}
// The 90% line (STOP_AT) far from the reset: exactly at it she stops; a hair
// under she delegates (the level alone already leans her on the free agents).
{
  const far = 3 * H;
  const stop = P(claude(lim("Session", STOP_AT, far), WKL));
  assert.equal(stop.mode, "stop");
  assert.equal(stop.until, now + far);
  assert.equal(P(claude(lim("Session", 0.8999, far), WKL)).mode, "delegate", "just under 90% far from reset delegates, not stops");
}
// Near the reset the stop line moves to NEAR_END_AT (97%): between the two
// she rides it out on delegate pace; exactly at it she still stops.
{
  const near = 0.5 * H;
  const held = P(claude(lim("Session", 0.9699, near), WKL));
  assert.equal(held.mode, "delegate", "96.99% with the reset close keeps delegate pace");
  assert.match(held.reason, /reset is close/);
  const stop = P(claude(lim("Session", NEAR_END_AT, near), WKL));
  assert.equal(stop.mode, "stop");
  assert.equal(stop.until, now + near);
}
// The same near-reset rule on the weekly window, at its own ~33.6 h share:
// inside it a 92% week delegates, outside it the plain 90% stop applies.
{
  const share = Math.round(WINDOWS.Weekly * NEAR_RESET_SHARE);
  const s = lim("Session", 0.3, 3 * H); // benign: elapsed 0.4, burn 0.75
  assert.equal(P(claude(s, lim("Weekly", 0.92, share))).mode, "delegate");
  assert.equal(P(claude(s, lim("Weekly", 0.92, share + H))).mode, "stop");
}

// ------------------------------------------- missing or unreadable windows
// No usable window at all: delegate, she plays it safe.
assert.equal(P({ limits: [] }).mode, "delegate");
assert.equal(P({}).mode, "delegate", "no limits key at all");
assert.equal(P(claude(lim("Fable", 0.9, H), { title: "Session", percent: "abc", resetsAt: iso(now + H) })).mode, "delegate",
  "unknown titles and NaN percents are filtered until nothing is left");
// One window is enough: pace judges whatever it can read.
assert.equal(P(claude(lim("Session", 0.5, 2.5 * H))).mode, "normal", "a lone session window still paces");
// A window with no reset time is judged on level alone: no elapsed share, no
// burn, no 'close' — so 95% stops at the plain 90% line while 50% is normal.
{
  const noReset = { title: "Session", percent: 0.95, resetsAt: "" };
  const p = P(claude(noReset, WKL));
  assert.equal(p.mode, "stop");
  assert.equal(p.until, null, "nothing to wait for but the reading itself");
  assert.equal(P(claude({ ...noReset, percent: 0.5 }, WKL)).mode, "normal");
}

// ----------------------------------------------------- a window at 100%
// HARD_AT: the real limit is hit — a hard stop until that window's reset,
// whichever window it is, and however far past 100 the reading goes.
{
  const s = P(claude(lim("Session", HARD_AT, 3 * H), WKL));
  assert.equal(s.mode, "stop"); assert.equal(s.hard, true);
  assert.equal(s.until, now + 3 * H); assert.equal(s.title, "Session");
  const w = P(claude(lim("Session", 0.3, 3 * H), lim("Weekly", 1, 4 * D)));
  assert.equal(w.mode, "stop"); assert.equal(w.hard, true); assert.equal(w.title, "Weekly");
  assert.equal(P(claude(lim("Session", 1.4, 3 * H), WKL)).hard, true, "over 100% is still the wall");
  const under = P(claude(lim("Session", 0.999, 3 * H), WKL));
  assert.equal(under.mode, "stop"); assert.equal(under.hard, undefined, "99.9% is a normal stop, not the wall");
}

// ------------------------------------------------------- Keep going, deeper
// The reset-time match is inclusive at SAME_RESET_MS and exclusive 1 ms past.
fs.writeFileSync(keepGoingFile(dir), JSON.stringify({ title: "Session", resetsAt: now + 3 * H + SAME_RESET_MS, at: now }));
assert.equal(P(claude(lim("Session", 0.95, 3 * H), WKL)).mode, "delegate", "jitter up to 5 min still matches");
fs.writeFileSync(keepGoingFile(dir), JSON.stringify({ title: "Session", resetsAt: now + 3 * H + SAME_RESET_MS + 1, at: now }));
assert.equal(P(claude(lim("Session", 0.95, 3 * H), WKL)).mode, "stop", "5 min + 1 ms is a different window");
// A keep-going file that names a reset can't cover a window that can't:
// sameReset(null, number) is no match, so the plain 90% stop stands.
fs.writeFileSync(keepGoingFile(dir), JSON.stringify({ title: "Session", resetsAt: now + 3 * H, at: now }));
assert.equal(P(claude({ title: "Session", percent: 0.95, resetsAt: "" }, WKL)).mode, "stop");
// The no-reset-time keep-going lasts one window length from `at` — and `at`
// is trusted as written, so a future `at` (clock skew) stretches it.
fs.writeFileSync(keepGoingFile(dir), JSON.stringify({ title: "Session", resetsAt: null, at: now + 2 * H }));
const noRes = { title: "Session", percent: 0.95, resetsAt: "" };
assert.equal(P(claude(noRes, WKL)).mode, "delegate", "a future `at` still counts: validity runs from `at`");
assert.equal(P(claude(noRes, WKL), now + WINDOWS.Session + 3 * H).mode, "stop", "past at + one window length it expires");
// A corrupt keep-going file is simply no keep-going.
fs.writeFileSync(keepGoingFile(dir), "{not json");
assert.equal(P(claude(lim("Session", 0.95, 3 * H), WKL)).mode, "stop");
fs.rmSync(keepGoingFile(dir));

// ------------------------------------------- unsure and out-of-date readings
// pace() judges the numbers it is given — it does not look at `unsure`; the
// resume gate (canResume) is what refuses a stale reading.
{
  const good = claude(lim("Session", 0.3, 3 * H), WKL);
  const p = P(good);
  assert.equal(p.mode, "normal");
  assert.equal(canResume(p, { ...good, unsure: "Last reading from 4:02 PM; couldn't refresh." }), false,
    "a normal pace can't resume her on a reading the collector couldn't refresh");
  // Same for a delegate pace that isn't Keep going.
  const del = { ...claude(lim("Session", 0.5, 3 * H), WKL), unsure: "old" }; // burn ~1.25 -> delegate
  assert.equal(P(del).mode, "delegate", "pace itself ignores the unsure flag");
  assert.equal(canResume(P(del), del), false, "delegate on a stale reading still can't resume");
  // Keep going is the owner's call: it resumes even on a stale flag.
  fs.writeFileSync(keepGoingFile(dir), JSON.stringify({ title: "Session", resetsAt: now + 3 * H, at: now }));
  const kept = { ...claude(lim("Session", 0.95, 3 * H), WKL), unsure: "old" };
  const kp = P(kept);
  assert.match(kp.reason, /Keep going/);
  assert.equal(canResume(kp, kept), true);
  fs.rmSync(keepGoingFile(dir));
  // canResume's other refusals: no pace, a stop, no reading, no limits.
  assert.equal(canResume(null, good), false);
  assert.equal(canResume(P(claude(lim("Session", HARD_AT, 3 * H), WKL)), good), false, "a hard stop never resumes");
  assert.equal(canResume(p, null), false);
  assert.equal(canResume(p, { limits: [] }), false, "an empty limits array is no reading");
  assert.equal(canResume(p, {}), false);
}

// ------------------------------------------------------------- wall.json edges
// The wall falls exactly at its stated time; a broken file is no wall.
{
  const good = claude(lim("Session", 0.3, 3 * H), WKL);
  writeWall(dir, { until: now, stated: true, text: "x" }, now);
  assert.equal(P(good).mode, "normal", "a wall whose time is exactly now has fallen");
  writeWall(dir, { until: now + 1, stated: true, text: "x" }, now);
  assert.equal(P(good).mode, "stop", "one ms before the stated time it still stands");
  fs.writeFileSync(wallFile(dir), "{broken");
  assert.equal(P(good).mode, "normal", "a corrupt wall.json can't hold her");
  fs.rmSync(wallFile(dir));
}
// Claude's own wall outranks the owner's Keep going: the file can't resume her
// into a limit Claude itself reported.
fs.writeFileSync(keepGoingFile(dir), JSON.stringify({ title: "Session", resetsAt: now + 3 * H, at: now }));
writeWall(dir, { until: now + H, stated: true, text: "hit your limit" }, now);
const walled = P(claude(lim("Session", 0.95, 3 * H), WKL));
assert.equal(walled.mode, "stop"); assert.equal(walled.hard, true);
assert.equal(walled.until, now + H, "the wall's own time, not the meter's");
fs.rmSync(keepGoingFile(dir)); fs.rmSync(wallFile(dir));

// ------------------------------------------- malformed limits (fixed)
// pace() assumes claude.limits is an array of limit objects. It used to throw
// ".map is not a function" on a truthy non-array and inside windowPace on a
// null entry, and the driver calls pace() unguarded, so one malformed agent
// record in data.json would kill it. Now a non-array `limits` reads as no
// windows and null entries are ignored.
assert.equal(windowPace(null), null);
assert.equal(windowPace(undefined), null);
assert.equal(P({ limits: "junk" }).mode, "delegate", "a non-array limits value is no windows");
assert.equal(P({ limits: "junk" }).reason, P({}).reason);
assert.equal(P({ limits: [null] }).mode, "delegate", "null entries are ignored until nothing is left");
assert.equal(P(claude(null, lim("Session", 0.5, 2.5 * H), WKL)).mode, "normal", "a null entry among real windows changes nothing");

// ------------------------------------------- wrong types inside windowPace
// Titles are matched exactly: "session" isn't "Session", and a missing title
// isn't a window either.
assert.equal(W({ percent: 0.5, resetsAt: iso(now + H) }), null, "no title");
assert.equal(W({ title: "session", percent: 0.5, resetsAt: iso(now + H) }), null, "lowercase title");
assert.equal(W({ title: " Session", percent: 0.5, resetsAt: iso(now + H) }), null, "padded title");
assert.equal(W({ title: 7, percent: 0.5, resetsAt: iso(now + H) }), null, "numeric title");
// resetsAt is read through String(): an epoch-number resetsAt doesn't parse
// (treated as no reset time), while a Date object does.
{
  const epoch = W({ title: "Session", percent: 0.5, resetsAt: now + 2 * H });
  assert.equal(epoch.burn, null, "a numeric epoch resetsAt is unparseable: no reset time");
  assert.equal(epoch.nearReset, false);
  const asDate = W({ title: "Session", percent: 0.5, resetsAt: new Date(now + 2 * H) });
  assert.equal(asDate.resetsAt, now + 2 * H, "a Date object stringifies to something parseable");
}
// Number() coercion: null/"" percent is 0 (a real, benign window), " 0.5 " is
// 0.5, Infinity is rejected, and a negative percent is a valid low reading.
assert.equal(W({ title: "Session", percent: null, resetsAt: iso(now + H) }).used, 0, "null percent coerces to 0%");
assert.equal(W({ title: "Session", percent: "", resetsAt: iso(now + H) }).used, 0, "empty-string percent coerces to 0%");
assert.equal(W({ title: "Session", percent: " 0.5 ", resetsAt: iso(now + H) }).used, 0.5);
assert.equal(W({ title: "Session", percent: Infinity, resetsAt: iso(now + H) }), null, "Infinity percent");
assert.equal(W({ title: "Session", percent: -0.2, resetsAt: iso(now + H) }).used, -0.2, "a negative percent is still finite");
assert.equal(P(claude({ title: "Session", percent: -0.2, resetsAt: iso(now + H) })).mode, "normal", "negative use can't trip any line");
// Non-object limits entries (numbers, strings, booleans) are filtered like null.
assert.equal(P({ limits: [5, "x", true] }).mode, "delegate", "scalar entries are no windows");
assert.equal(P(claude(5, lim("Session", 0.5, 2.5 * H))).mode, "normal", "a scalar among real windows changes nothing");
// pace() itself takes anything: a scalar or array "agent" has no .limits.
assert.equal(P("junk").mode, "delegate");
assert.equal(P(42).mode, "delegate");
assert.equal(P(["a"]).mode, "delegate", "an array has no limits key");
// A state dir that doesn't exist reads as no files: no wall, no Keep going.
const missingDir = path.join(dir, "no-such-dir");
assert.equal(pace(claude(lim("Session", 0.3, 3 * H), WKL), now, missingDir).mode, "normal");
assert.equal(pace(claude(lim("Session", 0.95, 3 * H), WKL), now, missingDir).mode, "stop");

// ------------------------------------- keep-going.json: wrong shapes, deeper
// Every non-object or object-without-a-string-title parses to "no Keep going",
// so the plain 90% stop stands. Fresh dir per shape isn't needed: each write
// replaces the file and a stop result proves it wasn't honored.
for (const [label, text] of [
  ["empty file", ""],
  ["whitespace only", "   \n"],
  ["JSON null", "null"],
  ["JSON array", "[]"],
  ["JSON string", '"Session"'],
  ["JSON number", "42"],
  ["empty object", "{}"],
  ["numeric title", '{"title": 7, "resetsAt": ' + (now + 3 * H) + ', "at": ' + now + '}'],
  ["string resetsAt", '{"title": "Session", "resetsAt": "soon", "at": ' + now + '}'],
]) {
  fs.writeFileSync(keepGoingFile(dir), text);
  assert.equal(P(claude(lim("Session", 0.95, 3 * H), WKL)).mode, "stop", `keep-going.json ${label} isn't honored`);
}
// A directory where keep-going.json should be is just as unreadable.
fs.rmSync(keepGoingFile(dir), { force: true });
fs.mkdirSync(keepGoingFile(dir));
assert.equal(P(claude(lim("Session", 0.95, 3 * H), WKL)).mode, "stop", "a directory named keep-going.json can't be read");
fs.rmSync(keepGoingFile(dir), { recursive: true });
// Clock edges on the no-reset-time Keep going: validity is
// `now - at < window length`, so exactly one length later it has expired, and
// one ms before it still holds. A missing `at` is 0 — epoch-old, expired.
fs.writeFileSync(keepGoingFile(dir), JSON.stringify({ title: "Session", resetsAt: null, at: now - WINDOWS.Session }));
assert.equal(P(claude(noRes, WKL)).mode, "stop", "at exactly one window length ago it has expired");
fs.writeFileSync(keepGoingFile(dir), JSON.stringify({ title: "Session", resetsAt: null, at: now - WINDOWS.Session + 1 }));
assert.equal(P(claude(noRes, WKL)).mode, "delegate", "1 ms inside the window it still holds");
fs.writeFileSync(keepGoingFile(dir), JSON.stringify({ title: "Session", resetsAt: null }));
assert.equal(P(claude(noRes, WKL)).mode, "stop", "no `at` at all is epoch-old: expired");
fs.writeFileSync(keepGoingFile(dir), '{"title": "Session", "resetsAt": null, "at": "now"}');
assert.equal(P(claude(noRes, WKL)).mode, "stop", "a non-numeric `at` coerces to 0: epoch-old, expired");
// With a reset time the rule is `now < resetsAt`: at the exact reset instant
// the Keep going is already dead. 98% used is past NEAR_END_AT, so without the
// match it stops; with it (one instant earlier) it delegates.
fs.writeFileSync(keepGoingFile(dir), JSON.stringify({ title: "Session", resetsAt: now + H, at: now }));
assert.equal(P(claude(lim("Session", 0.98, H), WKL)).mode, "delegate", "Keep going still covers the window inside its time");
assert.equal(P(claude(lim("Session", 0.98, H), WKL), now + H).mode, "stop", "at the reset instant the Keep going is expired and she stops");
// Keep going for one title never covers the other, even when both are over
// their lines: only the named window's stop is held.
fs.writeFileSync(keepGoingFile(dir), JSON.stringify({ title: "Weekly", resetsAt: now + 4 * D, at: now }));
{
  const both = claude(lim("Session", 0.95, 3 * H), lim("Weekly", 0.95, 4 * D));
  const p = P(both);
  assert.equal(p.mode, "stop");
  assert.equal(p.title, "Session", "the unnamed window still stops her");
  fs.writeFileSync(keepGoingFile(dir), JSON.stringify({ title: "Session", resetsAt: now + 3 * H, at: now }));
  const p2 = P(both);
  assert.equal(p2.mode, "stop");
  assert.equal(p2.title, "Weekly", "and vice versa");
}
// A Keep going naming a real reset can't cover a window whose own resetsAt is
// null — sameReset(number, null) is no match — and the reverse holds too.
fs.writeFileSync(keepGoingFile(dir), JSON.stringify({ title: "Session", resetsAt: null, at: now }));
assert.equal(P(claude(lim("Session", 0.95, 3 * H), WKL)).mode, "stop", "kg resetsAt null vs window's real time: no match");
fs.rmSync(keepGoingFile(dir));

// ------------------------------------------- wall.json: wrong shapes, deeper
for (const [label, text] of [
  ["empty file", ""],
  ["JSON null", "null"],
  ["JSON array", "[]"],
  ["JSON string", '"soon"'],
  ["until as string", '{"until": "' + (now + H) + '", "stated": true}'],
  ["until null", '{"until": null}'],
  ["until missing", '{"stated": true}'],
]) {
  fs.writeFileSync(wallFile(dir), text);
  assert.equal(P(claude(lim("Session", 0.3, 3 * H), WKL)).mode, "normal", `wall.json ${label} isn't a wall`);
}
fs.rmSync(wallFile(dir), { force: true });
fs.mkdirSync(wallFile(dir));
assert.equal(P(claude(lim("Session", 0.3, 3 * H), WKL)).mode, "normal", "a directory named wall.json can't be read");
fs.rmSync(wallFile(dir), { recursive: true });
// A wall standing at `now` exactly has fallen (readWall is `now < until`);
// the pace-level check one ms before is already covered above.
writeWall(dir, { until: now, stated: false, text: "" }, now);
assert.equal(P(claude(lim("Session", 0.3, 3 * H), WKL)).mode, "normal");
fs.rmSync(wallFile(dir));

// ------------------------------------------------- clock edge: the reset now
// resetsAt === now is a finished window: elapsed 1, 'close' by definition, so
// 95% rides out on delegate pace while 98% still stops.
{
  const over = lim("Session", 0.95, 0);
  assert.equal(W(over).elapsed, 1);
  assert.equal(W(over).nearReset, true);
  const p = P(claude(over, WKL));
  assert.equal(p.mode, "delegate");
  assert.match(p.reason, /reset is close/);
  assert.equal(P(claude(lim("Session", 0.98, 0), WKL)).mode, "stop", "98% of a just-ended window still stops");
}

// ------------------------------------------- mode precedence between windows
// A held window (past 90% but riding out near its reset) beats a merely fast
// one: the held branch returns before the fast check.
{
  const held = lim("Session", 0.92, 0.5 * H);            // near reset: held at delegate
  const hot = lim("Weekly", 0.5, 5.6 * D);               // elapsed ~0.2, burn ~2.5: fast
  const p = P(claude(held, hot));
  assert.equal(p.mode, "delegate");
  assert.match(p.reason, /reset is close/, "the held window's reason wins over the fast one");
}
// A stopping window anywhere stops her even when another window is held.
{
  const p = P(claude(lim("Session", 0.92, 0.5 * H), lim("Weekly", STOP_AT, 3 * D)));
  assert.equal(p.mode, "stop");
  assert.equal(p.title, "Weekly", "the far 90% stop outranks the near-reset held window");
}
// Two windows both over their stop lines: the first in the limits array is
// the one reported (ws.find order), whichever it is.
{
  const p = P(claude(lim("Session", STOP_AT, 3 * H), lim("Weekly", 0.95, 4 * D)));
  assert.equal(p.mode, "stop");
  assert.equal(p.title, "Session", "array order decides which stop is named");
  const p2 = P(claude(lim("Weekly", 0.95, 4 * D), lim("Session", STOP_AT, 3 * H)));
  assert.equal(p2.title, "Weekly", "reversed order names the other");
}

// ------------------------------------------------------- canResume, deeper
// The stop check comes first: even a hand-built "stop" pace whose reason
// mentions Keep going can't resume her.
assert.equal(canResume({ mode: "stop", reason: "Session at 95%: you chose Keep going" }, claude(lim("Session", 0.3, 3 * H), WKL)), false,
  "mode stop beats a Keep going-looking reason");
// keptGoing() is a pure reason-string test: any delegate/normal pace carrying
// the phrase counts, which is how the panel's own reason is recognized.
assert.equal(canResume({ mode: "delegate", reason: "Session at 95%: you chose Keep going, so she delegates" }, null), true,
  "Keep going needs no reading at all — it's the owner's call");
// A non-empty limits array counts as a reading even when every entry is
// unreadable: pace() delegates on it and canResume() lets her resume into
// delegate pace. (limits: [] is the only 'no reading' shape.)
{
  const junk = { limits: [null, "x"] };
  const p = P(junk);
  assert.equal(p.mode, "delegate");
  assert.equal(canResume(p, junk), true, "present-but-unreadable limits still count as a current reading");
}
console.log("constance-pace.deep: tests passed");
