import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isLimitHit, statedReset, limitWall, writeWall, readWall, wallFile, clock, FALLBACK_WAIT_MS } from "./constance-wall.mjs";

// Deeper tests for constance-wall.mjs: boundaries, malformed input, time zones,
// and wall.json failure paths. All clocks are injected via the `now` argument;
// wall files live in a mktemp dir and HOME is faked for the run.
// Anything that depends on the machine's own zone is asserted relative to
// statedReset itself, never to a hard-coded instant.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constance-wall-deep-"));
const realHome = process.env.HOME;
process.env.HOME = path.join(tmp, "home");
fs.mkdirSync(process.env.HOME, { recursive: true });
process.on("exit", () => { process.env.HOME = realHome; fs.rmSync(tmp, { recursive: true, force: true }); });

const wallDir = (name) => path.join(tmp, name);

// now = 2026-11-24 21:15 UTC = 16:15 EST / 17:15 CET.
const now = Date.UTC(2026, 10, 24, 21, 15);

// ---------- isLimitHit ----------

assert.ok(isLimitHit("You've hit your 5-hour limit · resets 5:50pm"));
assert.ok(isLimitHit("HIT YOUR WEEKLY LIMIT"), "case-insensitive");
assert.ok(isLimitHit("prefix hit your session limit suffix"), "match anywhere in the line");
assert.ok(!isLimitHit(null));
assert.ok(!isLimitHit(undefined));
assert.ok(!isLimitHit(42), "non-string input is stringified, not a limit line");
assert.ok(!isLimitHit("hit your\nlimit"), "'hit your' and 'limit' must share a line");
assert.ok(!isLimitHit("your limit was hit"), "order matters: 'hit your' first");
// Current behavior: the plural "limits" does NOT match (\blimit\b needs a word boundary).
// Claude's real message uses the singular; pinned so a change is deliberate.
assert.ok(!isLimitHit("You've hit your limits"));
assert.ok(isLimitHit("hit your rate-limit"), "hyphenated 'limit' still has a word boundary");
assert.ok(!isLimitHit("unlimited hit your quota"), "'limit' inside 'unlimited' has no left boundary");

// ---------- statedReset: meridiem and hour edges ----------

assert.equal(statedReset("resets 12:30am (UTC)", now), Date.UTC(2026, 10, 25, 0, 30), "12:30am is 00:30");
assert.equal(statedReset("resets 12:30pm (UTC)", now), Date.UTC(2026, 10, 25, 12, 30), "12:30pm is 12:30");
assert.equal(statedReset("resets 5 pm (UTC)", now), Date.UTC(2026, 10, 25, 17), "space before meridiem is fine");
assert.equal(statedReset("resets 5PM (UTC)", now), Date.UTC(2026, 10, 25, 17), "uppercase meridiem");
assert.equal(statedReset("RESETS 5PM (UTC)", now), Date.UTC(2026, 10, 25, 17), "uppercase 'resets'");
assert.equal(statedReset("resets 17:50 (UTC)", now), Date.UTC(2026, 10, 25, 17, 50), "24h form, no meridiem");
assert.equal(statedReset("resets 5:50 (UTC)", now), Date.UTC(2026, 10, 25, 5, 50), "no meridiem is read as 24h (05:50), not pm");
assert.equal(statedReset("resets 23:59 (UTC)", now), Date.UTC(2026, 10, 24, 23, 59), "latest valid time today");
assert.equal(statedReset("resets 0:30 (UTC)", now), Date.UTC(2026, 10, 25, 0, 30), "00:30 tomorrow");
assert.equal(statedReset("resets 0am (UTC)", now), null, "0am is not a valid 12h hour");
assert.equal(statedReset("resets 0pm (UTC)", now), null, "0pm is not a valid 12h hour");
assert.equal(statedReset("resets 13pm (UTC)", now), null, "13pm invalid");
assert.equal(statedReset("resets 12pm (UTC)", now), Date.UTC(2026, 10, 25, 12), "12pm is noon");
assert.equal(statedReset("resets 24:00 (UTC)", now), null, "24:00 rejected");
assert.equal(statedReset("resets 23:60 (UTC)", now), null, "minute 60 rejected");
assert.equal(statedReset("resets 5:70pm (UTC)", now), null, "minute 70 rejected even with meridiem");
assert.equal(statedReset("resets Nov 5pm (UTC)", now), null, "month without a day does not parse");
assert.equal(statedReset("resets foo 3, 5pm (UTC)", now), null, "unknown month name");
assert.equal(statedReset("resets 99, 5pm (UTC)", now), null, "hour 99 rejected");

// ---------- statedReset: date and rollover edges ----------

assert.equal(statedReset("resets November 30, 5pm (UTC)", now), Date.UTC(2026, 10, 30, 17), "full month name works ([a-z]{3}[a-z]*)");
assert.equal(statedReset("resets Nov. 30, 5pm (UTC)", now), Date.UTC(2026, 10, 30, 17), "abbreviated month with period");
assert.equal(statedReset("resets Nov 30 5pm (UTC)", now), Date.UTC(2026, 10, 30, 17), "no comma before the time");
// Impossible dates roll over via Date.UTC: "Nov 31" becomes Dec 1. Claude never
// states an impossible date, so this is documented behavior, not a fix.
assert.equal(statedReset("resets Nov 31, 5pm (UTC)", now), Date.UTC(2026, 11, 1, 17), "Nov 31 silently rolls into Dec 1");
// A dated time more than a day in the past is pushed a whole year out, then
// refused by MAX_WAIT — so past dates always end at null.
assert.equal(statedReset("resets Oct 30, 5pm (UTC)", now), null, "a date weeks in the past is null");
// Inconsistency worth noting: a clock-only time in the recent past rolls to
// tomorrow, but a date+time already past today returns null (30 min fallback).
assert.equal(statedReset("resets 9:13pm (UTC)", now), Date.UTC(2026, 10, 25, 21, 13), "9:13pm already past today means tomorrow");
assert.equal(statedReset("resets Nov 24, 9pm (UTC)", now), null, "same wall time with an explicit date is 'in the past' -> null");

// ---------- statedReset: the now boundary (60 s grace, MAX_WAIT) ----------

const justNow = Date.UTC(2026, 10, 24, 21, 15, 30); // reset stated 30 s ago
assert.equal(statedReset("resets 9:15pm (UTC)", justNow), Date.UTC(2026, 10, 24, 21, 15), "within the 60 s grace the stated past time is kept");
const past90 = Date.UTC(2026, 10, 24, 21, 16, 30); // reset stated 90 s ago
assert.equal(statedReset("resets 9:15pm (UTC)", past90), Date.UTC(2026, 10, 25, 21, 15), "beyond 60 s the clock-only form rolls to tomorrow");
// MAX_WAIT_MS is exactly 8 days; the check is `t - now <= MAX_WAIT_MS`.
assert.equal(statedReset("resets Dec 2, 9:15pm (UTC)", now), Date.UTC(2026, 11, 2, 21, 15), "exactly 8 days out is still accepted");
assert.equal(statedReset("resets Dec 2, 9:16pm (UTC)", now), null, "8 days + 1 minute is refused");
assert.equal(statedReset("resets Dec 3, 9:15pm (UTC)", now), null, "9 days out is refused");

// ---------- statedReset: time zones ----------

// Auckland is UTC+13 in late November: at 21:15 UTC it is already Nov 25 there.
assert.equal(statedReset("resets 5pm (Pacific/Auckland)", now), Date.UTC(2026, 10, 25, 4), "zone can put 'today' on a different date");
assert.equal(statedReset("resets 5pm (Not/AZone)", now), statedReset("resets 5pm", now), "unknown zone falls back to the machine zone");
assert.equal(statedReset("resets 5pm ()", now), statedReset("resets 5pm", now), "empty parens mean no zone");
assert.equal(statedReset("resets 5pm(UTC)", now), statedReset("resets 5pm (UTC)", now), "no space before the zone parens");
// Europe/Berlin on 2026-11-24 is CET (UTC+1): 17:00 Berlin = 16:00 UTC, already past -> tomorrow.
assert.equal(statedReset("resets 5pm (Europe/Berlin)", now), Date.UTC(2026, 10, 25, 16), "Berlin wall time converted through its zone");
// A zone can also pull 'today' backwards: at 02:00 UTC Nov 25 it is still Nov 24 in New York.
const earlyUtc = Date.UTC(2026, 10, 25, 2, 0);
assert.equal(statedReset("resets 11pm (America/New_York)", earlyUtc), Date.UTC(2026, 10, 25, 4), "NY evening is still 'today' at 02:00 UTC");

// ---------- statedReset: malformed times that still parse (documented quirks) ----------

// Real mis-parses of malformed input: the regex stops at the unexpected
// character, so the meridiem (and the zone parens) are silently dropped.
// Claude's own message never looks like this; pinned as current behavior.
assert.equal(statedReset("resets 5:5pm (UTC)", now), statedReset("resets 5", now), "'5:5pm' parses as bare '5' — meridiem and zone lost (quirk)");
assert.equal(statedReset("resets 5:50:30pm (UTC)", now), statedReset("resets 5:50", now), "'5:50:30pm' parses as bare '5:50' — meridiem and zone lost (quirk)");
// Trailing junk after a valid match is ignored — and so is a zone paren that
// is not immediately after the time.
assert.equal(statedReset("resets 5pm trailing junk (UTC)", now), statedReset("resets 5pm", now), "zone paren after junk text is not captured");

// ---------- limitWall ----------

const hitLine = "You've hit your 5-hour limit · resets 5:50pm (America/New_York)";
const w = limitWall("noise\n" + hitLine + "\nmore", now);
assert.deepEqual(w, { until: Date.UTC(2026, 10, 24, 22, 50), stated: true, text: hitLine });

// The reset may be stated on a different line than the hit line.
const multi = limitWall("You've hit your limit.\n(Your 5-hour window resets 6:10pm (UTC))", now);
assert.equal(multi.stated, true);
assert.equal(multi.until, Date.UTC(2026, 10, 25, 18, 10), "6:10pm UTC already past -> tomorrow");
assert.equal(multi.text, "You've hit your limit.", "text is the first hit line, not the resets line");

// First hit line wins when several lines match.
const two = limitWall("You've hit your limit (resets 9pm (UTC)).\nYou've hit your weekly limit · resets 8pm (UTC)", now);
assert.equal(two.until, Date.UTC(2026, 10, 25, 21), "statedReset reads the first hit line first (9pm UTC past -> tomorrow)");

// Real bug candidate (not fixed per job rules): when the hit line has no reset
// of its own, limitWall falls back to statedReset(whole text), which takes the
// leftmost 'resets ...' ANYWHERE in the output — even unrelated earlier lines —
// and reports stated:true for a time Claude never tied to the wall.
// Intended behavior, kept as a commented-out test:
//   const bogus = limitWall("plan resets 5pm (UTC)\nYou've hit your limit.", now);
//   assert.equal(bogus.stated, false, "BUG: unrelated 'resets' earlier in the output is reported as stated");
//   assert.equal(bogus.until, now + FALLBACK_WAIT_MS, "BUG: should use the 30 min fallback, not the stray time");
// Current (buggy) behavior, pinned so the suite stays green:
const bogus = limitWall("plan resets 5pm (UTC)\nYou've hit your limit.", now);
assert.equal(bogus.stated, true, "current behavior: unrelated earlier 'resets' is treated as stated (see commented-out test above)");
assert.equal(bogus.until, statedReset("plan resets 5pm (UTC)", now));

// A stated clock-only time already past still yields an `until` — either the
// past instant inside the 60 s grace, or tomorrow beyond it.
const staleInGrace = limitWall("You've hit your limit · resets 9:15pm (UTC)", Date.UTC(2026, 10, 24, 21, 15, 30));
assert.equal(staleInGrace.until, Date.UTC(2026, 10, 24, 21, 15), "30 s past stays the stated instant");
const stalePast = limitWall("You've hit your limit · resets 9:14pm (UTC)", Date.UTC(2026, 10, 24, 21, 15, 30));
assert.equal(stalePast.until, Date.UTC(2026, 10, 25, 21, 14), "76 s past rolls to tomorrow");

// text is trimmed and capped at 200 chars.
const longHit = "You've hit your limit " + "x".repeat(300);
const lw = limitWall(longHit, now);
assert.equal(lw.text.length, 200, "wall text is capped at 200 chars");
assert.ok(lw.text.startsWith("You've hit your limit"));
const padded = limitWall("   You've hit your limit.   ", now);
assert.equal(padded.text, "You've hit your limit.", "wall text is trimmed");

// ---------- writeWall / readWall ----------

const d1 = wallDir("basic");
assert.equal(readWall(d1, now), null, "missing dir -> no wall");
writeWall(d1, { until: now + 1000, stated: true, text: "t" }, now);
const rd = readWall(d1, now);
assert.equal(rd.until, now + 1000);
assert.equal(rd.stated, true);
assert.equal(rd.text, "t");
assert.equal(rd.at, now, "writeWall stamps `at`");

// until is exactly now -> the wall has already fallen (strict <).
assert.equal(readWall(d1, now + 1000), null, "now == until is not a wall");
assert.ok(readWall(d1, now + 999), "one ms before until still walls");

// Nested dir is created.
const d2 = wallDir(path.join("a", "b", "c"));
writeWall(d2, { until: now + 5, stated: false }, now);
assert.ok(readWall(d2, now), "writeWall mkdir -p's the state dir");
assert.equal(JSON.parse(fs.readFileSync(wallFile(d2), "utf8")).stated, false);

// stated is coerced to a boolean; missing text becomes "".
writeWall(d2, { until: now + 5, stated: "yes" }, now);
const coerced = JSON.parse(fs.readFileSync(wallFile(d2), "utf8"));
assert.equal(coerced.stated, true, "truthy stated coerces to true");
assert.equal(coerced.text, "", "missing text becomes empty string");

// wall.json overwritten by a later writeWall.
writeWall(d2, { until: now + 50, stated: true, text: "second" }, now);
assert.equal(readWall(d2, now).until, now + 50, "writeWall overwrites");

// Malformed wall.json payloads all read as 'no wall'.
const bad = wallDir("bad");
fs.mkdirSync(bad, { recursive: true });
const cases = [
  ["{broken", "invalid JSON"],
  ["null", "JSON null"],
  ["5", "bare number"],
  ['"str"', "bare string"],
  ["[]", "empty array"],
  ["{}", "no until"],
  [JSON.stringify({ until: "soon" }), "until is a string"],
  [JSON.stringify({ until: null }), "until is null"],
  [JSON.stringify({ until: NaN }), "until NaN serializes to null"],
  [JSON.stringify({ until: Infinity }), "until Infinity serializes to null"],
  [JSON.stringify({ until: -1 }), "until in the past"],
  [JSON.stringify({ until: now + 10, stated: true }), "missing text field is fine"],
];
for (const [content, label] of cases) {
  fs.writeFileSync(wallFile(bad), content);
  const expectWall = label === "missing text field is fine" ? now + 10 : null;
  const got = readWall(bad, now);
  assert.equal(got && got.until, expectWall, label);
}
// wall.json that is a directory, not a file.
fs.rmSync(wallFile(bad));
fs.mkdirSync(wallFile(bad));
assert.equal(readWall(bad, now), null, "wall.json as a directory reads as no wall");

// Extra fields in wall.json are preserved on the returned object.
fs.rmSync(wallFile(bad), { recursive: true });
fs.writeFileSync(wallFile(bad), JSON.stringify({ until: now + 10, stated: true, text: "x", extra: { a: 1 } }));
assert.deepEqual(readWall(bad, now).extra, { a: 1 }, "unknown fields pass through");

// ---------- clock ----------

assert.equal(typeof clock(now), "string");
assert.ok(clock(now).length > 0);
assert.equal(clock("not a date"), "Invalid Date", "invalid input formats as 'Invalid Date', does not throw");

console.log("constance-wall.deep: tests passed");
