// Deeper edge-case pass on bin/weekly-summary.mjs (pure functions: formatTokens
// and weeklySummary over the shared history.json shape). Complements
// weekly-summary.test.mjs, which covers the happy path: week boundaries within
// one month, null-vs-number tokens, busiest-day ties, empty history and basic
// formatTokens. This file covers what it doesn't:
//
//   - week windows crossing month and year boundaries (addDays rollover)
//   - `now` given as a Date / garbage (NaN -> "NaN-NaN-NaN" quirk)
//   - formatTokens rounding and sign edges, including the "1000K" plateau
//   - wrong-type history/days/day/record/peak/names inputs
//   - prototype-named peak titles and agent ids (BUG, commented out)
//   - null record crash (BUG, commented out)
//   - reentrancy: input history is never mutated, outputs are fresh
//
// The module is fully synchronous and touches no files, so there are no
// timing races; HOME and the XDG vars are pointed at a mkdtemp dir anyway per
// the house rule, and the module keeps no cache so "stale state" reduces to
// input/output independence.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatTokens, weeklySummary } from "./weekly-summary.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "weekly-summary-deep-"));
for (const d of ["home", "state", "config", "cache"])
  fs.mkdirSync(path.join(tmp, d), { recursive: true });
process.env.HOME = path.join(tmp, "home");
process.env.XDG_STATE_HOME = path.join(tmp, "state");
process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
process.env.XDG_CACHE_HOME = path.join(tmp, "cache");

// Fixed "now": 2026-11-24 is a Tuesday. Week = 2026-11-18 .. 2026-11-24.
const NOW = new Date(2026, 10, 24, 15, 30).getTime();
const hist = (days, extra = {}) => ({ schemaVersion: 1, days, ...extra });
const rec = (o = {}) => ({ tokens: null, peaks: {}, resets: 0, ...o });

// ------------------------------------------------------------- week windows
// Same-month window is covered by weekly-summary.test.mjs; here the window
// must roll over month and year boundaries correctly.
{
  // 2026-12-01 (Tuesday): week = 2026-11-25 .. 2026-12-01, crossing November.
  const now = new Date(2026, 11, 1, 9, 0).getTime();
  const s = weeklySummary(hist({ "2026-11-25": { a: rec({ tokens: 5 }) }, "2026-12-01": { a: rec({ tokens: 7 }) } }), now);
  assert.equal(s.from, "2026-11-25");
  assert.equal(s.to, "2026-12-01");
  assert.equal(s.agents[0].tokens, 12);
  assert.deepEqual(s.busiestDay, { date: "2026-12-01", tokens: 7 });
}
{
  // 2027-01-03 (Sunday): week = 2026-12-28 .. 2027-01-03, crossing the year.
  const now = new Date(2027, 0, 3, 23, 59).getTime();
  const s = weeklySummary(hist({
    "2026-12-28": { a: rec({ tokens: 1 }) },
    "2027-01-03": { a: rec({ tokens: 2 }) },
    "2027-01-04": { a: rec({ tokens: 99 }) }, // tomorrow: outside the window
  }), now);
  assert.equal(s.from, "2026-12-28");
  assert.equal(s.to, "2027-01-03");
  assert.equal(s.agents[0].tokens, 3);
  assert.deepEqual(s.busiestDay, { date: "2027-01-03", tokens: 2 });
}
{
  // Leap-year February: 2028-03-01 minus 6 days lands on 2028-02-24 (2028 is
  // a leap year, Feb has 29 days).
  const now = new Date(2028, 2, 1, 12, 0).getTime();
  const s = weeklySummary(hist({}), now);
  assert.equal(s.from, "2028-02-24");
  assert.equal(s.to, "2028-03-01");
}
{
  // `now` may be a Date object; new Date(dateObj) copies it.
  const s = weeklySummary(hist({ "2026-11-24": { a: rec({ tokens: 3 }) } }), new Date(2026, 10, 24));
  assert.equal(s.to, "2026-11-24");
  assert.equal(s.agents[0].tokens, 3);
}
{
  // Quirk (pinned, reported): a NaN `now` produces "NaN-NaN-NaN" window keys
  // instead of throwing or falling back to Date.now().
  const s = weeklySummary(hist({ "NaN-NaN-NaN": { a: rec({ tokens: 5 }) } }), NaN);
  assert.equal(s.from, "NaN-NaN-NaN");
  assert.equal(s.to, "NaN-NaN-NaN");
  // ...and because all seven generated keys collapse to that one string, a day
  // literally keyed "NaN-NaN-NaN" is summed SEVEN times.
  assert.equal(s.agents[0].tokens, 35);
  assert.deepEqual(s.busiestDay, { date: "NaN-NaN-NaN", tokens: 35 });
}

// ------------------------------------------------------------- wrong-type history / days
{
  // history itself: scalars and arrays degrade to an empty week, never throw.
  for (const bad of [undefined, null, 0, 42, "x", true, [], [1, 2]]) {
    const s = weeklySummary(bad, NOW);
    assert.deepEqual(s.agents, [], `history=${JSON.stringify(bad)} should give no agents`);
    assert.equal(s.busiestDay, null);
    assert.equal(s.from, "2026-11-18");
  }
  // history.days wrong types: only a plain lookup happens, so arrays and
  // strings just miss every date key.
  for (const badDays of [null, undefined, 5, "2026-11-24", [], ["x"]]) {
    const s = weeklySummary({ schemaVersion: 1, days: badDays }, NOW);
    assert.deepEqual(s.agents, [], `days=${JSON.stringify(badDays)} should give no agents`);
  }
  // schemaVersion is never checked: a wrong/missing version still summarizes.
  const s = weeklySummary({ schemaVersion: 99, days: { "2026-11-24": { a: rec({ tokens: 4 }) } } }, NOW);
  assert.equal(s.agents[0].tokens, 4, "schemaVersion is ignored");
}
{
  // Day values of wrong types.
  const s = weeklySummary(hist({
    "2026-11-24": {
      ok: rec({ tokens: 10 }),
    },
    "2026-11-23": "abc",   // string day: Object.entries yields index->char pairs
    "2026-11-22": 7,       // number day: Object.entries(7) is []
    "2026-11-21": null,    // falsy day: skipped
    "2026-11-20": true,    // boolean day: Object.entries(true) is []
  }), NOW);
  // Quirk (pinned, reported): a STRING day is treated like an array of chars —
  // each character becomes an "agent" keyed by its index. They carry no data,
  // so they surface as token-less agents named "0", "1", "2".
  const phantom = s.agents.filter((a) => ["0", "1", "2"].includes(a.id));
  assert.equal(phantom.length, 3, "string day spawns phantom index agents");
  assert.ok(phantom.every((a) => a.tokens === null && a.resets === 0));
  assert.equal(s.agents.find((a) => a.id === "ok").tokens, 10);
  // ...and an ARRAY day does the same, but its elements can carry real data:
  // agent id becomes the array index.
  const s2 = weeklySummary(hist({ "2026-11-24": [rec({ tokens: 50, resets: 1 })] }), NOW);
  assert.equal(s2.agents[0].id, "0");
  assert.equal(s2.agents[0].tokens, 50, "array day element becomes agent '0'");
  assert.equal(s2.resetsHit, 1);
}
{
  // Record values of wrong types: numbers/strings/booleans/arrays are
  // tolerated (property reads just miss); only null/undefined crash — see BUG.
  const s = weeklySummary(hist({
    "2026-11-24": {
      num: 5, str: "x", bool: true, arr: [1, 2], empty: {},
    },
  }), NOW);
  assert.equal(s.agents.length, 5, "scalar records still create (empty) agents");
  assert.ok(s.agents.every((a) => a.tokens === null && a.resets === 0 && Object.keys(a.peaks).length === 0));
}

// ------------------------------------------------------------- record field wrong types
{
  const s = weeklySummary(hist({
    "2026-11-24": {
      strTok: rec({ tokens: "500" }),        // string: not counted
      nanTok: rec({ tokens: NaN }),
      infTok: rec({ tokens: Infinity }),
      boolTok: rec({ tokens: true }),
      strRes: rec({ tokens: 1, resets: "2" }),
      nanRes: rec({ tokens: 1, resets: NaN }),
      fracRes: rec({ tokens: 1, resets: 1.5 }),
      negRes: rec({ tokens: 1, resets: -2 }),
      strPeak: rec({ tokens: 1, peaks: { Session: "0.9" } }),
      nanPeak: rec({ tokens: 1, peaks: { Weekly: NaN, Session: Infinity } }),
      overPeak: rec({ tokens: 1, peaks: { Session: 1.4, Other: -0.2 } }),
      arrPeak: rec({ tokens: 1, peaks: [0.7, 0.2] }), // array peaks: indices are titles
      numPeak: rec({ tokens: 1, peaks: 5 }),
      strPeakObj: rec({ tokens: 1, peaks: "high" }),
    },
  }), NOW);
  const byId = Object.fromEntries(s.agents.map((a) => [a.id, a]));
  assert.equal(byId.strTok.tokens, null, "string tokens ignored -> null, not 0");
  assert.equal(byId.nanTok.tokens, null);
  assert.equal(byId.infTok.tokens, null);
  assert.equal(byId.boolTok.tokens, null);
  assert.equal(byId.strRes.resets, 0, "string resets ignored");
  assert.equal(byId.nanRes.resets, 0);
  assert.equal(byId.fracRes.resets, 1.5, "fractional resets summed as-is (schema says int, not enforced)");
  assert.equal(byId.negRes.resets, -2, "negative resets summed as-is");
  assert.equal(s.resetsHit, 1.5 - 2, "resetsHit nets fractional and negative resets");
  assert.deepEqual(byId.strPeak.peaks, {}, "string peak fraction ignored");
  assert.deepEqual(byId.nanPeak.peaks, {}, "NaN/Infinity peak fractions ignored");
  assert.deepEqual(byId.overPeak.peaks, { Session: 1.4, Other: -0.2 },
    "peak fractions outside 0..1 are kept unclamped");
  assert.deepEqual(byId.arrPeak.peaks, { "0": 0.7, "1": 0.2 },
    "quirk: an ARRAY peaks value records index->fraction entries");
  assert.deepEqual(byId.numPeak.peaks, {});
  assert.deepEqual(byId.strPeakObj.peaks, {});
}
{
  // Zero is real data, distinct from null: tokens 0 sorts above null and can
  // itself be the busiest day.
  const s = weeklySummary(hist({
    "2026-11-23": { zero: rec({ tokens: 0 }) },
    "2026-11-22": { nul: rec({ tokens: null }) },
  }), NOW);
  assert.equal(s.agents[0].id, "zero", "tokens=0 sorts before tokens=null");
  assert.equal(s.agents[0].tokens, 0);
  assert.deepEqual(s.busiestDay, { date: "2026-11-23", tokens: 0 },
    "a 0-token day still counts as busiest (only undefined totals are skipped)");
  // All-null week -> busiestDay null.
  const s2 = weeklySummary(hist({ "2026-11-24": { a: rec({ tokens: null }) } }), NOW);
  assert.equal(s2.busiestDay, null);
}
{
  // Negative tokens flow through: per-day totals can go negative and the
  // "busiest" day is then the least-negative one.
  const s = weeklySummary(hist({
    "2026-11-23": { a: rec({ tokens: -50 }) },
    "2026-11-22": { a: rec({ tokens: -10 }), b: rec({ tokens: 5 }) },
  }), NOW);
  assert.equal(s.agents.find((a) => a.id === "a").tokens, -60);
  assert.deepEqual(s.busiestDay, { date: "2026-11-22", tokens: -5 },
    "negative totals still pick a winner");
}

// ------------------------------------------------------------- peaks merging
{
  // Max wins across days; a later LOWER value does not overwrite.
  const s = weeklySummary(hist({
    "2026-11-20": { a: rec({ tokens: 1, peaks: { Session: 0.9 } }) },
    "2026-11-24": { a: rec({ tokens: 1, peaks: { Session: 0.4, Weekly: 0.6 } }) },
  }), NOW);
  assert.deepEqual(s.agents[0].peaks, { Session: 0.9, Weekly: 0.6 });
  // Peak titles are per-agent: the same title on another agent is independent.
  const s2 = weeklySummary(hist({
    "2026-11-24": {
      a: rec({ tokens: 1, peaks: { Session: 0.3 } }),
      b: rec({ tokens: 1, peaks: { Session: 0.8 } }),
    },
  }), NOW);
  assert.equal(s2.agents.find((x) => x.id === "a").peaks.Session, 0.3);
  assert.equal(s2.agents.find((x) => x.id === "b").peaks.Session, 0.8);
  // Peaks on days OUTSIDE the window never merge in.
  const s3 = weeklySummary(hist({
    "2026-11-17": { a: rec({ tokens: 1, peaks: { Session: 0.99 } }) },
    "2026-11-18": { a: rec({ tokens: 1, peaks: { Session: 0.1 } }) },
  }), NOW);
  assert.equal(s3.agents[0].peaks.Session, 0.1);
}
{
  // BUG (commented out, not fixed): peak titles that collide with
  // Object.prototype members are silently dropped. `title in a.peaks` is true
  // through the prototype chain, and `frac > a.peaks[title]` compares against
  // an inherited non-number, so "constructor", "toString", "hasOwnProperty"
  // and "__proto__" meters never record — even though usage-history.mjs can
  // write any string title. Real history comes from JSON.parse, where
  // "__proto__" IS an own property, so this is reachable.
  //
  // const bugHist = JSON.parse(JSON.stringify({ schemaVersion: 1, days: {
  //   "2026-11-24": { a: { tokens: 1, peaks: { constructor: 0.9, toString: 0.8, "__proto__": 0.7 }, resets: 0 } },
  // } }));
  // assert.deepEqual(weeklySummary(bugHist, NOW).agents[0].peaks,
  //   { constructor: 0.9, toString: 0.8 },
  //   "BUG: prototype-named peak titles should be recorded, not dropped");
}

// ------------------------------------------------------------- sorting
{
  const s = weeklySummary(hist({
    "2026-11-24": {
      c: rec({ tokens: 10 }), d: rec({ tokens: 10 }), b: rec({ tokens: 10 }),
      z: rec({ tokens: null }), y: rec({ tokens: null }),
    },
  }), NOW);
  const ids = s.agents.map((a) => a.id);
  assert.deepEqual(ids, ["b", "c", "d", "y", "z"],
    "equal token counts tie-break by id ascending; nulls last, also by id");
  // names: explicit name wins; empty-string name falls back to id (falsy).
  const s2 = weeklySummary(hist({ "2026-11-24": { a: rec({ tokens: 1 }), b: rec({ tokens: 1 }) } }),
    NOW, { a: "Agent A", b: "" });
  assert.equal(s2.agents.find((x) => x.id === "a").name, "Agent A");
  assert.equal(s2.agents.find((x) => x.id === "b").name, "b", "empty name falls back to id");
  // Quirk (pinned, reported): `names[id] || id` reads through the prototype
  // chain, so an agent id that is an Object.prototype member name gets an
  // inherited function as its "name".
  const s3 = weeklySummary(hist({ "2026-11-24": { constructor: rec({ tokens: 1 }) } }), NOW);
  assert.strictEqual(s3.agents[0].name, Object, "agent id 'constructor' inherits Object as its name");
}
{
  // `names` wrong types: scalars/arrays are harmless (property reads miss);
  // only null throws, because `names[a.id]` dereferences it. undefined hits
  // the {} default. Pinned: the module does not guard its third argument.
  const h = hist({ "2026-11-24": { a: rec({ tokens: 1 }) } });
  assert.equal(weeklySummary(h, NOW, "names").agents[0].name, "a");
  assert.equal(weeklySummary(h, NOW, []).agents[0].name, "a");
  assert.equal(weeklySummary(h, NOW, 5).agents[0].name, "a", "number names: property reads miss, no throw");
  assert.throws(() => weeklySummary(h, NOW, null), TypeError, "null names dereferences null");
  assert.equal(weeklySummary(h, NOW, undefined).agents[0].name, "a", "undefined names hits the {} default");
  // ...but with an EMPTY agent list the names lookup never runs, so null is fine.
  assert.deepEqual(weeklySummary(hist({}), NOW, null).agents, []);
}

// ------------------------------------------------------------- input immutability / reentrancy
{
  const h = hist({
    "2026-11-18": { a: rec({ tokens: 5, peaks: { Session: 0.5 }, resets: 1 }) },
    "2026-11-24": { a: rec({ tokens: 5, peaks: { Session: 0.9 }, resets: 1 }), b: rec({ tokens: 3 }) },
  });
  const before = JSON.stringify(h);
  const s1 = weeklySummary(h, NOW);
  const s2 = weeklySummary(h, NOW);
  assert.equal(JSON.stringify(h), before, "history is never mutated");
  assert.notEqual(s1.agents[0].peaks, s2.agents[0].peaks, "each call returns fresh objects");
  s1.agents[0].peaks.Session = 0; // mutating a result cannot leak into the next call
  s1.agents.length = 0;
  const s3 = weeklySummary(h, NOW);
  assert.equal(s3.agents[0].peaks.Session, 0.9);
  assert.equal(s3.agents.length, 2, "no cache: repeated calls are independent");
}
{
  // BUG (commented out, not fixed): a null or undefined record inside a day
  // crashes the whole summary with TypeError (`rec.tokens` on null). One
  // corrupt agent entry takes down every other agent's week. usage-history's
  // recordDay always writes objects, but a hand-edited or partially-written
  // history.json reaches this path.
  //
  // assert.throws(() => weeklySummary(hist({ "2026-11-24": { a: null } }), NOW),
  //   undefined, "BUG: null record should be skipped like other wrong types, not crash");
  // assert.throws(() => weeklySummary(hist({ "2026-11-24": { a: undefined } }), NOW),
  //   undefined, "BUG: undefined record should be skipped, not crash");
}

// ------------------------------------------------------------- formatTokens edges
{
  // Non-finite and non-number inputs -> em dash.
  for (const bad of [null, undefined, NaN, Infinity, -Infinity, "500", "1.2M", true, {}, []])
    assert.equal(formatTokens(bad), "—", `formatTokens(${JSON.stringify(bad)})`);
  // Zero and sign of zero.
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(-0), "0");
  // Sub-1000 values round to integers (banker's? no — Math.round, half up).
  assert.equal(formatTokens(999.4), "999");
  assert.equal(formatTokens(999.5), "1000", "rounds up at .5");
  assert.equal(formatTokens(-999.5), "-999", "Math.round(-999.5) === -999 (toward +inf at .5)");
  // The "1000K" plateau: anything in [~999950, 1e6) prints as 1000K rather
  // than rolling up to 1.0M — the M branch only starts AT 1e6.
  assert.equal(formatTokens(999949), "999.9K");
  assert.equal(formatTokens(999950), "1000K");
  assert.equal(formatTokens(999999.9), "1000K", "just under 1M still prints 1000K");
  assert.equal(formatTokens(1000000), "1M");
  // Negative values format symmetrically, including the plateau.
  assert.equal(formatTokens(-999), "-999");
  assert.equal(formatTokens(-1000), "-1K");
  assert.equal(formatTokens(-1500), "-1.5K");
  assert.equal(formatTokens(-999999), "-1000K");
  assert.equal(formatTokens(-1500000), "-1.5M");
  // Millions rounding and trailing-.0 trim.
  assert.equal(formatTokens(1050000), "1.1M", "1.05M rounds up to 1.1M");
  assert.equal(formatTokens(1049999), "1M", "1.049999M rounds down to 1M");
  assert.equal(formatTokens(1500000), "1.5M");
  assert.equal(formatTokens(123456789), "123.5M");
  // Tiny negative fractions round to "-0"? Math.round(-0.4) === -0 -> "0".
  assert.equal(formatTokens(-0.4), "0");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("weekly-summary.deep: all tests passed");
