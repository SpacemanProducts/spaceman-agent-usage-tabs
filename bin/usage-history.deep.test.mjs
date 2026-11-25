import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Everything this test touches lives under one fresh temp dir; the module only
// reads/writes the files it is handed, but HOME and the XDG roots are pointed
// at the sandbox anyway so nothing can ever leak into the real home folder.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "usage-history-deep-"));
process.env.HOME = SANDBOX;
process.env.XDG_STATE_HOME = path.join(SANDBOX, "state");
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.XDG_CACHE_HOME = path.join(SANDBOX, "cache");
// Pin a DST-observing zone so the clock-edge tests below exercise a real
// spring/fall transition; every other assertion is local-date based and stays
// correct under any zone.
process.env.TZ = "America/New_York";

const {
  loadHistory, saveHistory, recordDay, agentSeries, localDate, KEEP_DAYS,
} = await import("./usage-history.mjs");

// Fixed "now": local noon so localDate is unambiguous in any timezone.
const NOW = new Date(2026, 10, 24, 12, 0, 0).getTime(); // 2026-11-24
const TODAY = localDate(NOW);
const NOON = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0).getTime();
const shift = (dateStr, days) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
};
const empty = () => ({ schemaVersion: 1, days: {} });
const AGENT = (over = {}) => ({
  id: "claude", installed: true, hasTokens: true, today: 1000,
  days: [{ date: TODAY, tokens: 1000 }],
  limits: [{ title: "Session", percent: 0.5 }],
  ...over,
});
const rec = (over = {}) => ({ tokens: null, peaks: {}, resets: 0, ...over });

// ---- localDate clock edges: day boundaries and year rollover
assert.equal(localDate(NOON(2026, 11, 24)), "2026-11-24");
assert.equal(localDate(new Date(2026, 10, 24, 0, 0, 0, 0).getTime()), "2026-11-24", "just after midnight is the new day");
assert.equal(localDate(new Date(2026, 10, 24, 23, 59, 59, 999).getTime()), "2026-11-24", "last ms of the day");
assert.equal(localDate(new Date(2026, 11, 31, 23, 59, 59).getTime()), "2026-12-31");
assert.equal(localDate(new Date(2027, 0, 1, 0, 0, 1).getTime()), "2027-01-01", "year rollover");
assert.equal(localDate(NOON(2024, 2, 29)), "2024-02-29", "leap day exists");
assert.equal(localDate(NOON(2026, 3, 1)), "2026-03-01", "day after non-leap February");

// ---- agentSeries date arithmetic across month, leap and year boundaries
{
  const h = empty();
  const mar1_2024 = agentSeries(h, "x", NOON(2024, 3, 1), 3).map((s) => s.date);
  assert.deepEqual(mar1_2024, ["2024-02-28", "2024-02-29", "2024-03-01"], "leap February has 29 days");
  const mar1_2026 = agentSeries(h, "x", NOON(2026, 3, 1), 3).map((s) => s.date);
  assert.deepEqual(mar1_2026, ["2026-02-27", "2026-02-28", "2026-03-01"], "non-leap February has 28 days");
  const jan2 = agentSeries(h, "x", NOON(2026, 1, 2), 3).map((s) => s.date);
  assert.deepEqual(jan2, ["2025-12-31", "2026-01-01", "2026-01-02"], "series crosses the year boundary");
}

// ---- agentSeries across the US fall-back DST transition (Nov 1 2026, 2am)
{
  const h = empty();
  const s = agentSeries(h, "x", NOON(2026, 11, 2), 5).map((x) => x.date);
  assert.deepEqual(s, ["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"],
    "no duplicated or skipped calendar day across DST");
  assert.equal(new Set(s).size, 5);
}

// ---- loadHistory: every non-conforming input degrades to an empty history
{
  const dir = path.join(SANDBOX, "load-edges");
  fs.mkdirSync(dir, { recursive: true });
  const EMPTY = { schemaVersion: 1, days: {} };
  const asDir = path.join(dir, "a-directory");
  fs.mkdirSync(asDir);
  assert.deepEqual(loadHistory(asDir), EMPTY, "a directory is not a history file");
  for (const [name, content] of [
    ["empty", ""],
    ["blank", "   \n\t  "],
    ["null", "null"],
    ["num", "123"],
    ["str", '"history"'],
    ["bool", "true"],
    ["truncated", '{"schemaVersion":1,"days":{"2026-'],
    ["bom", "\uFEFF" + JSON.stringify({ schemaVersion: 1, days: {} })],
  ]) {
    const f = path.join(dir, name + ".json");
    fs.writeFileSync(f, content);
    assert.deepEqual(loadHistory(f), EMPTY, `loadHistory(${name})`);
  }
  for (const [name, content] of [
    ["sv-string", '{"schemaVersion":"1","days":{}}'],
    ["sv-zero", '{"schemaVersion":0,"days":{}}'],
    ["sv-missing", '{"days":{}}'],
    ["days-null", '{"schemaVersion":1,"days":null}'],
    ["days-string", '{"schemaVersion":1,"days":"x"}'],
    ["days-number", '{"schemaVersion":1,"days":5}'],
    ["days-bool", '{"schemaVersion":1,"days":true}'],
  ]) {
    const f = path.join(dir, name + ".json");
    fs.writeFileSync(f, content);
    assert.deepEqual(loadHistory(f), EMPTY, `loadHistory(${name})`);
  }
  // Wrong inner shapes still load (the reader is deliberately lenient); the
  // important part is that recordDay/agentSeries must not crash on them.
  const weird = path.join(dir, "weird.json");
  fs.writeFileSync(weird, JSON.stringify({
    schemaVersion: 1,
    days: {
      "2026-11-20": null,
      "2026-11-21": "oops",
      "2026-11-22": 42,
      "2026-11-23": { claude: "not-a-record", codex: { tokens: "NaN-ish", peaks: null, resets: "x" } },
    },
    extra: "ignored",
  }));
  const hw = loadHistory(weird);
  assert.equal(hw.schemaVersion, 1);
  assert.doesNotThrow(() => recordDay(hw, [AGENT()], NOW));
  assert.doesNotThrow(() => agentSeries(hw, "claude", NOW, 4));
  assert.doesNotThrow(() => agentSeries(hw, "codex", NOW, 4));
}

// ---- saveHistory: directory creation, tmp hygiene, error paths
{
  const dir = path.join(SANDBOX, "save-edges", "nested", "deeper");
  const file = path.join(dir, "history.json");
  const h = recordDay(empty(), [AGENT()], NOW, { claude: 1 });
  saveHistory(file, h);
  assert.deepEqual(loadHistory(file), h, "roundtrip through nested dirs");
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes(".tmp-")).length, 0, "no tmp file left behind");

  // A stale tmp file from a crashed earlier save is simply overwritten.
  const stale = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(stale, "garbage");
  saveHistory(file, h);
  assert.deepEqual(loadHistory(file), h, "save over a stale tmp file");
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes(".tmp-")).length, 0);

  // Parent path occupied by a regular file -> mkdir/write must throw, and no
  // tmp file may be left at the target location.
  const blocker = path.join(SANDBOX, "save-edges", "blocker");
  fs.writeFileSync(blocker, "i am a file");
  const badTarget = path.join(blocker, "history.json");
  assert.throws(() => saveHistory(badTarget, h), "saving under a file parent throws");
  assert.equal(fs.readdirSync(SANDBOX + "/save-edges").includes("history.json.tmp-" + process.pid), false);

  // Read-only directory -> write fails (uid is unprivileged in this env).
  const roDir = path.join(SANDBOX, "save-edges", "readonly");
  fs.mkdirSync(roDir);
  fs.chmodSync(roDir, 0o500);
  try {
    assert.throws(() => saveHistory(path.join(roDir, "h.json"), h), "read-only dir rejects the write");
  } finally {
    fs.chmodSync(roDir, 0o700);
  }
}

// ---- recordDay: hostile / missing inputs never throw and never mutate
{
  for (const badHistory of [null, undefined, {}, "junk", 5, [], { days: "x" }, { days: { "2026-11-20": null } }]) {
    const out = recordDay(badHistory, [AGENT()], NOW);
    assert.equal(out.schemaVersion, 1);
    assert.equal(out.days[TODAY].claude.tokens, 1000, `history=${JSON.stringify(badHistory)}`);
  }
  for (const badAgents of [null, undefined, "junk", [null, 5, "x", {}, { id: 42 }]]) {
    assert.doesNotThrow(() => recordDay(empty(), badAgents, NOW), `agents=${JSON.stringify(badAgents)}`);
  }
  // A truthy non-iterable `agents` is a caller-contract violation and throws
  // a plain TypeError from the for..of — pinned here so a future refactor
  // doesn't silently change it to something weirder.
  for (const notIterable of [5, {}, true]) {
    assert.throws(() => recordDay(empty(), notIterable, NOW), TypeError, `agents=${JSON.stringify(notIterable)}`);
  }
  // Non-object and malformed agent entries are skipped; only explicit
  // installed === false excludes an agent (absent/null/0 still record).
  const messy = recordDay(empty(), [
    null, 5, "x", {}, { id: 42, installed: true }, { id: null },
    { id: "noFlag", hasTokens: true, today: 7, days: [], limits: [] },
    { id: "nullFlag", installed: null, hasTokens: true, today: 8, days: [], limits: [] },
    { id: "zeroFlag", installed: 0, hasTokens: true, today: 9, days: [], limits: [] },
    AGENT({ id: "off", installed: false }),
  ], NOW);
  assert.equal(messy.days[TODAY]["noFlag"].tokens, 7, "missing installed flag still records");
  assert.equal(messy.days[TODAY]["nullFlag"].tokens, 8);
  assert.equal(messy.days[TODAY]["zeroFlag"].tokens, 9);
  assert.equal(messy.days[TODAY][42], undefined, "numeric id skipped");
  assert.equal(messy.days[TODAY].off, undefined, "installed:false skipped");
  assert.equal(messy.days[TODAY]["5"], undefined);
}

// ---- recordDay: malformed fields inside an otherwise valid agent
{
  const h = recordDay(empty(), [AGENT({
    days: [
      null, 5, "x",
      { tokens: 1 },                          // no date -> skipped
      { date: 20261120, tokens: 1 },          // non-string date -> skipped
      { date: "not-a-date", tokens: 1 },      // unparseable key -> pruned later
      { date: shift(TODAY, -3), tokens: Infinity },  // non-finite -> null
      { date: shift(TODAY, -4), tokens: -250 },       // finite negative kept verbatim
      { date: shift(TODAY, -5), tokens: "500" },      // string -> null
      { date: shift(TODAY, 2), tokens: 999 },         // future -> pruned
    ],
    limits: [
      null, 5, "x",
      { title: 7, percent: 0.5 },             // non-string title -> skipped
      { title: "Session", percent: NaN },
      { title: "Session", percent: Infinity },
      { title: "Session", percent: -Infinity },
      { title: "Session", percent: "0.9" },   // string percent -> skipped
      { title: "Session", percent: null },
      { title: "Zero", percent: 0 },          // a real 0 is recorded
    ],
  })], NOW);
  assert.equal(h.days[shift(TODAY, -3)].claude.tokens, null, "Infinity folds to null");
  assert.equal(h.days[shift(TODAY, -4)].claude.tokens, -250, "finite numbers pass through verbatim");
  assert.equal(h.days[shift(TODAY, -5)].claude.tokens, null, "string tokens fold to null");
  assert.equal(h.days[shift(TODAY, 2)], undefined, "future-dated day entries are pruned");
  const peaks = h.days[TODAY].claude.peaks;
  assert.equal(peaks.Session, undefined, "no finite percent -> no peak at all");
  assert.equal(peaks.Zero, 0, "percent 0 is a real reading, kept as 0");
}

// ---- recordDay: resetsByAgent edge values
{
  const h = recordDay(empty(), [AGENT(), AGENT({ id: "grok", hasTokens: false, today: 0, days: [] })], NOW,
    { claude: 1.9, grok: "2", missing: 5 });
  assert.equal(h.days[TODAY].claude.resets, 1, "fractional count truncates via |0");
  assert.equal(h.days[TODAY].grok.resets, 2, "numeric string coerces via |0");
  assert.equal(h.days[TODAY].claude.resets + h.days[TODAY].grok.resets, 3);
  // BUG (documented, not fixed): a negative resetsByAgent value drives the
  // stored count negative — resets are counts and should never go below 0.
  //   const hn = recordDay(empty(), [AGENT({ hasTokens: false, days: [] })], NOW, { claude: -3 });
  //   assert.ok(hn.days[TODAY].claude.resets >= 0);   // currently -3
}

// ---- recordDay: existing records with wrong inner types are sanitized
{
  const h0 = {
    schemaVersion: 1,
    days: {
      [TODAY]: {
        claude: { tokens: "lots", peaks: null, resets: 2.9 },
        codex: { tokens: 50, peaks: { "Five Hour": "high" }, resets: "3" },
      },
    },
  };
  const h = recordDay(h0, [], NOW);
  const c = h.days[TODAY].claude;
  assert.equal(c.tokens, null, "non-numeric stored tokens -> null");
  assert.deepEqual(c.peaks, {}, "null peaks -> {}");
  assert.equal(c.resets, 2, "float resets truncated");
  const x = h.days[TODAY].codex;
  assert.equal(x.tokens, 50);
  assert.equal(x.resets, 3, "string resets coerced");
  assert.deepEqual(x.peaks, { "Five Hour": "high" }, "peak values are carried verbatim (lenient reader)");
}

// ---- recordDay output is a fresh object graph (no shared nested refs)
{
  const before = {
    schemaVersion: 1,
    days: { [TODAY]: { claude: rec({ tokens: 5, peaks: { Session: 0.1 }, resets: 1 }) } },
  };
  const after = recordDay(before, [AGENT()], NOW);
  assert.notEqual(after, before);
  assert.notEqual(after.days, before.days);
  assert.notEqual(after.days[TODAY], before.days[TODAY]);
  assert.notEqual(after.days[TODAY].claude, before.days[TODAY].claude);
  assert.notEqual(after.days[TODAY].claude.peaks, before.days[TODAY].claude.peaks);
  after.days[TODAY].claude.peaks.Session = 0.99;
  assert.equal(before.days[TODAY].claude.peaks.Session, 0.1, "mutating output cannot reach the input");
}

// ---- pruning still runs when there are no agents at all
{
  const old = shift(TODAY, -KEEP_DAYS);
  const edge = shift(TODAY, -(KEEP_DAYS - 1));
  const h0 = { schemaVersion: 1, days: { [old]: { a: rec({ tokens: 1 }) }, [edge]: { a: rec({ tokens: 2 }) } } };
  const h = recordDay(h0, [], NOW);
  assert.equal(h.days[old], undefined, "stale day pruned even with zero agents");
  assert.equal(h.days[edge].a.tokens, 2, "in-window day survives an empty run");
}

// ---- duplicate agent ids in one snapshot fold deterministically
{
  const h = recordDay(empty(), [
    AGENT({ today: 100, days: [{ date: TODAY, tokens: 100 }] }),
    AGENT({ today: 200, days: [{ date: TODAY, tokens: 200 }] }),
  ], NOW);
  assert.equal(h.days[TODAY].claude.tokens, 200, "later entry wins for today");
}

// ---- agentSeries: size edges and missing data
{
  assert.deepEqual(agentSeries(empty(), "claude", NOW, 0), [], "n=0 -> empty");
  assert.deepEqual(agentSeries(empty(), "claude", NOW, -3), [], "negative n -> empty");
  const one = agentSeries(empty(), "claude", NOW, 1);
  assert.equal(one.length, 1);
  assert.equal(one[0].date, TODAY);
  assert.equal(one[0].tokens, null);
  for (const bad of [null, undefined, "junk", 5, { days: "x" }]) {
    const s = agentSeries(bad, "claude", NOW, 3);
    assert.equal(s.length, 3, `history=${JSON.stringify(bad)}`);
    assert.ok(s.every((x) => x.tokens === null && x.resets === 0), "all-empty series");
  }
  // BUG (documented, not fixed): agentSeries does not validate n.
  //   - a fractional n shifts every date by the fraction and silently drops
  //     today: agentSeries(h, "x", NOW, 2.5) returns dates for today-2 and
  //     today-1 instead of today-1 and today.
  //   - n = Infinity loops forever (i never reaches 0).
  //   const frac = agentSeries(empty(), "x", NOW, 2.5);
  //   assert.equal(frac[frac.length - 1].date, TODAY);   // currently today-1
}

// ---- agentSeries: returned peaks are copies, not aliases into history
{
  const h = recordDay(empty(), [AGENT()], NOW);
  const s = agentSeries(h, "claude", NOW, KEEP_DAYS);
  const todayEntry = s[s.length - 1];
  assert.equal(todayEntry.tokens, 1000);
  assert.equal(todayEntry.resets, 0);
  todayEntry.peaks.Session = 0.99;
  todayEntry.tokens = -1;
  assert.equal(h.days[TODAY].claude.peaks.Session, 0.5, "series peaks are copies");
  assert.equal(h.days[TODAY].claude.tokens, 1000, "series scalars are copies");
}

// ---- BUG cluster: agent ids that collide with Object.prototype members.
// dayRecord does `(day[agentId] ||= {...})`; for "__proto__" the lookup returns
// Object.prototype itself (truthy), so tokens/resets get written onto
// Object.prototype — global pollution — and the record is never serialized
// ("__proto__" is not an own property). For "constructor"/"toString"/
// "hasOwnProperty"/"valueOf" the lookup returns an inherited function, and the
// limits loop then throws "Cannot read properties of undefined" because
// fn.peaks is undefined. Verified live:
//   recordDay(empty(), [{ id: "__proto__", hasTokens: true, today: 5, ... }], NOW)
//     -> ({}).tokens === 5 afterwards
//   recordDay(empty(), [{ id: "toString", limits: [{title:"S",percent:1}], ... }], NOW)
//     -> TypeError
// These tests document the desired behavior and FAIL today; they are kept
// commented out per the job rules (bugs are reported, not fixed here).
//   {
//     const polluted = recordDay(empty(), [AGENT({ id: "__proto__", today: 5, days: [] })], NOW);
//     assert.equal(({}).tokens, undefined, "no Object.prototype pollution");
//     assert.equal(JSON.stringify(polluted.days[TODAY]).includes("__proto__"), true);
//     assert.doesNotThrow(() =>
//       recordDay(empty(), [AGENT({ id: "toString", limits: [{ title: "S", percent: 1 }] })], NOW));
//   }

// ---- BUG: a non-finite `now` silently wipes the whole history.
// localDate("garbage") is "NaN-NaN-NaN"; every shiftDate() call produces the
// same string, so the keep-set collapses to one bogus key and recordDay drops
// every real day, storing new data under "NaN-NaN-NaN". Verified:
//   recordDay({days:{"2026-11-20":{...}}}, [], "garbage").days -> {}
// Desired: throw on an invalid timestamp, or at minimum keep existing days.
//   {
//     const h0 = { schemaVersion: 1, days: { "2026-11-20": { a: rec({ tokens: 1 }) } } };
//     assert.throws(() => recordDay(h0, [], "garbage"));
//     // or: assert.ok(recordDay(h0, [], "garbage").days["2026-11-20"]);
//   }

// ---- BUG: malformed per-day token entries erase previously stored values.
// `dayRecord(...).tokens = num(d.tokens)` runs unconditionally for every
// a.days entry, so a collector bug that sends tokens:"junk" (or omits `today`
// while hasTokens is true -> num(undefined) === null) overwrites a real stored
// count with null — silent data loss. Verified:
//   stored 500 for 2026-11-20 + days:[{date:"2026-11-20",tokens:"junk"}]
//   -> tokens becomes null; and days:[{date:today,tokens:777}] with no `today`
//      field -> today's tokens become null too.
// Desired: only overwrite when num() yields a number, or treat null as "no
// report" rather than "reported nothing".
//   {
//     const d = shift(TODAY, -2);
//     const h0 = { schemaVersion: 1, days: { [d]: { claude: rec({ tokens: 500 }) } } };
//     const h = recordDay(h0, [AGENT({ days: [{ date: d, tokens: "junk" }] })], NOW);
//     assert.equal(h.days[d].claude.tokens, 500, "garbage must not erase history");
//     const h2 = recordDay(empty(), [AGENT({ today: undefined, days: [{ date: TODAY, tokens: 777 }] })], NOW);
//     assert.equal(h2.days[TODAY].claude.tokens, 777, "a.days today value survives a missing `today`");
//   }

console.log("usage-history.deep: all tests passed");

fs.rmSync(SANDBOX, { recursive: true, force: true });
