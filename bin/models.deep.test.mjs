// Deep edge-case pass for bin/models.mjs on top of models.test.mjs (which
// covers the headline cases: used/zero/unavailable states, live-list
// availability, variant merging, plan blocks, the swe-2-flash ownership rule
// and basic junk input).
//
// models.mjs is a small synchronous, stateless module: buildModels(opts)
// merges config entries, a live model list and recent-usage records into
// sorted rows; norm() normalizes names. There is no clock, cache, env lookup,
// file read or shared state, so there is no timing surface to race — every
// case here is in-process with node:assert over synthetic inputs. HOME and
// the XDG dirs are still pointed at a scratch dir so nothing can touch the
// real home folder.
//
// Tests that pin down QUIRKS / SUSPECTED BUGS assert the current behaviour
// and say so in a comment (or sit commented out under "// BUG:"); nothing is
// fixed - this job is test-only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildModels, norm } from "./models.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "models-deep-"));
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  const d = path.join(tmp, k.toLowerCase());
  fs.mkdirSync(d, { recursive: true });
  process.env[k] = d;
}

const U = (name, total, extra = {}) => ({ name, total, input: total, output: 0, cacheRead: 0, cacheWrite: 0, ...extra });
const states = (rows) => Object.fromEntries(rows.map((r) => [r.name, r.state]));
const ROW_KEYS = ["name", "id", "input", "output", "cacheRead", "cacheWrite", "total", "state", "removing"];

try {
  // ================================================================ norm()
  {
    // nullish -> "", everything else stringified then stripped to [a-z0-9-].
    assert.equal(norm(undefined), "");
    assert.equal(norm(null), "");
    assert.equal(norm(""), "");
    assert.equal(norm(0), "0", "0 is kept (?? not ||): String(0) = '0'");
    assert.equal(norm(false), "false");
    assert.equal(norm(NaN), "nan");
    assert.equal(norm(3.14), "3-14");
    assert.equal(norm("---"), "");
    assert.equal(norm("  "), "");
    assert.equal(norm("a__b"), "a-b", "runs of separators collapse to one dash");
    assert.equal(norm("_lead trail_"), "lead-trail");
    assert.equal(norm("Café au lait"), "caf-au-lait", "non-ascii letters are separators");
    assert.equal(norm("GPT-OSS 120B (Medium)"), "gpt-oss-120b-medium", "parens become dashes");
    assert.equal(norm(norm("Weird  Name!!")), norm("Weird  Name!!"), "norm is idempotent");
    // A name that normalizes to "" can never match anything (matches() needs !!a && !!b).
    assert.deepEqual(buildModels({ used: [U("!!!", 5)] }).map((r) => [r.name, r.state]),
      [["!!!", "used"]], "a punctuation-only used name stays an unowned row");
  }

  // ================================================================ argument shapes
  {
    // Whole-argument edge cases. Destructuring tolerates scalars but not
    // null/undefined — see BUG note at the bottom.
    assert.deepEqual(buildModels({}), []);
    assert.deepEqual(buildModels({ used: [], live: [], config: [] }), []);
    for (const bad of ["x", 5, true, [], {}]) {
      assert.deepEqual(buildModels(bad), [], `scalar/array argument ${JSON.stringify(bad)} -> defaults -> []`);
    }
    // Non-array containers are ignored, not crashed on.
    assert.deepEqual(buildModels({ config: "nope", used: {}, live: 7 }), []);
    assert.deepEqual(buildModels({ config: [{ name: "A" }], used: "abc", live: {} })[0].state, "zero",
      "non-array used/live degrade to empty");
  }

  // ================================================================ config entries
  {
    // Entries need only a truthy `name`; every other field is optional or
    // duck-typed. Wrong types are kept or coerced, never rejected.
    const r = buildModels({ config: [
      { name: 5 },                                  // numeric name -> String(5)
      { name: "  " },                              // whitespace name is truthy
      { name: "!!!" },                             // normalizes to id ""
      { name: "Flag", removing: 2026 },            // non-string removing kept verbatim
      { name: "MatchStr", match: "not-an-array" }, // match must be an array; a string is ignored
      { name: "MatchNum", match: [0, "", "real-key", null] }, // falsy match keys filtered
      {}, null, "x", 0,                            // dropped: no truthy name
    ] });
    assert.deepEqual(r.map((x) => x.name), ["5", "  ", "!!!", "Flag", "MatchStr", "MatchNum"]);
    assert.equal(r[0].id, "5");
    assert.equal(r[1].id, "", "whitespace-only name normalizes to empty id");
    assert.equal(r[2].id, "", "punctuation-only name normalizes to empty id");
    assert.equal(r[3].removing, 2026, "QUIRK: removing is `e.removing || ''` — a number survives");
    // match:["real-key"] adds an alias: a used record under that name lands here.
    const r2 = buildModels({ config: [{ name: "MatchNum", match: ["real-key"] }], used: [U("real-key", 3)] });
    assert.equal(r2[0].name, "MatchNum");
    assert.equal(r2[0].total, 3, "a `match` alias owns the usage record");
    assert.equal(r2[0].state, "used");
  }
  {
    // Duplicate config names produce duplicate rows; a used record goes to the
    // FIRST slot only (strictly-greater length comparison loses ties).
    const r = buildModels({ config: [{ name: "Dup" }, { name: "Dup" }], used: [U("dup", 9)] });
    assert.equal(r.length, 2);
    assert.deepEqual(r.map((x) => [x.state, x.total]), [["used", 9], ["zero", 0]],
      "QUIRK: identical entries both render; usage lands on the first only");
  }
  {
    // unavailableOn matches on norm() both sides, case/dash-insensitive.
    const r = buildModels({ plan: "free tier", config: [
      { name: "A", unavailableOn: ["Free-Tier"] },
      { name: "B", unavailableOn: ["pro"] },
    ] });
    assert.deepEqual(states(r), { A: "unavailable", B: "zero" });
    // QUIRK: norm(null)/norm("")/norm(undefined) are all "", so an empty-string
    // normalizing entry in unavailableOn blocks the EMPTY plan too.
    for (const p of [null, "", "!!!"]) {
      const rr = buildModels({ plan: "", config: [{ name: "X", unavailableOn: [p] }] });
      assert.equal(rr[0].state, "unavailable", `QUIRK: unavailableOn [${JSON.stringify(p)}] blocks plan ""`);
    }
    // ...but not a real plan.
    assert.equal(buildModels({ plan: "Pro", config: [{ name: "X", unavailableOn: [null] }] })[0].state, "zero");
    // unavailableOn entries are not filtered for type: numbers compare via norm().
    assert.equal(buildModels({ plan: "5", config: [{ name: "X", unavailableOn: [5] }] })[0].state, "unavailable");
  }

  // ================================================================ live list
  {
    // A live entry needs neither field; missing pieces degrade to ""/fallbacks.
    const r = buildModels({ live: [
      { id: "only-id" },
      { name: "Only Name" },          // no id -> row id is ""
      {},                             // neither -> name "undefined", id ""
      { id: "", name: "" },           // empty strings -> same
    ], config: [] });
    assert.deepEqual(r.map((x) => [x.name, x.id, x.state]), [
      ["only-id", "only-id", "zero"],
      ["Only Name", "", "zero"],
      ["undefined", "", "zero"],
      ["", "", "zero"],
    ]);
    // QUIRK: live rows always have removing "" and never "unavailable" — the
    // live list is the source of truth, so presence means usable.
    for (const row of r) {
      assert.equal(row.removing, "");
      assert.ok(ROW_KEYS.every((k) => k in row), "live rows have the fixed row shape");
    }
  }
  {
    // Duplicate live ids are not deduped; a used record lands on the first.
    const r = buildModels({ live: [{ id: "dup", name: "Dup" }, { id: "dup", name: "Dup" }],
      used: [U("dup", 4)], config: [] });
    assert.equal(r.length, 2);
    assert.deepEqual(r.map((x) => [x.state, x.total]), [["used", 4], ["zero", 0]]);
  }
  {
    // Matching is directional: matches(liveId, key) requires the live id to be
    // the same or MORE specific (key + "-"). A config entry more specific than
    // the live id does NOT claim it — both rows appear and the entry is
    // "unavailable" because the live list exists but lacks it.
    const r = buildModels({
      live: [{ id: "claude-sonnet-4-6", name: "Sonnet" }],
      config: [{ name: "Claude Sonnet 4.6 Thinking" }], // more specific than the live id
    });
    assert.deepEqual(r.map((x) => [x.name, x.state]), [
      ["Sonnet", "zero"],
      ["Claude Sonnet 4.6 Thinking", "unavailable"],
    ], "zero sorts before unavailable even though the config row was first");
    // The reverse — a less specific entry — DOES claim the live row.
    const r2 = buildModels({
      live: [{ id: "gemini-3.8-flash-high", name: "Flash High" }],
      config: [{ name: "Gemini 3.8 Flash" }],
    });
    assert.deepEqual(r2.map((x) => [x.name, x.state]), [["Gemini 3.8 Flash", "zero"]],
      "one entry absorbs every more-specific live variant");
    // A very short key claims everything under its dash boundary.
    const r3 = buildModels({
      live: [{ id: "gpt-6-luna", name: "Luna" }, { id: "gpt-oss-120b", name: "OSS" }],
      config: [{ name: "GPT" }],
    });
    assert.deepEqual(r3.map((x) => x.name), ["GPT"], "QUIRK: key 'gpt' swallows 'gpt-6-luna' and 'gpt-oss-120b'");
    // ...but NOT a sibling that only shares a prefix without the dash:
    // "swe2-max" normalizes to "swe2-max" which does not start with "swe-",
    // so it survives as its own live row while "swe-2" is claimed.
    const r4 = buildModels({
      live: [{ id: "swe2-max", name: "SWE2" }, { id: "swe-2", name: "SWE-2" }],
      config: [{ name: "SWE" }],
    });
    assert.deepEqual(r4.map((x) => [x.name, x.id]), [["SWE", "swe"], ["SWE2", "swe2-max"]]);
  }
  {
    // Boundary: "swe-2" matches key "swe" (dash boundary) but "swe2" does not.
    const r = buildModels({ used: [U("swe-2", 1), U("swe2", 2)], config: [{ name: "SWE", match: ["swe"] }] });
    // "swe" key: 'swe-2' startsWith 'swe-' -> owned; 'swe2' does not -> unowned row.
    const cfgRow = r.find((x) => x.name === "SWE");
    const stray = r.find((x) => x.name === "swe2");
    assert.equal(cfgRow.total, 1);
    assert.equal(stray.total, 2);
  }
  {
    // inLive/claimedLive also consult l.name, not just l.id.
    const r = buildModels({
      live: [{ id: "zzz-9", name: "Gemini 3.8 Flash" }],
      config: [{ name: "Gemini 3.8 Flash" }],
    });
    assert.deepEqual(r.map((x) => x.name), ["Gemini 3.8 Flash"],
      "a live entry is claimed when its NAME matches the key, id irrelevant");
    // And a `match` alias can make an entry "in live" without naming it.
    const r2 = buildModels({
      live: [{ id: "gemini-3.8-flash-high", name: "H" }],
      config: [{ name: "Unrelated", match: ["gemini-3.8-flash-high"] }],
    });
    assert.deepEqual(states(r2), { Unrelated: "zero" }, "match alias counts for inLive");
  }
  {
    // Empty live list means "no data", not "missing": entries stay "zero".
    assert.equal(buildModels({ live: [], config: [{ name: "A" }] })[0].state, "zero");
    assert.equal(buildModels({ live: null, config: [{ name: "A" }] })[0].state, "zero");
  }

  // ================================================================ used records
  {
    // Ownership picks the LONGEST matching key across all slots; ties -> earlier.
    const r = buildModels({
      config: [{ name: "SWE-2" }, { name: "SWE-2 Flash" }],
      used: [U("swe-2-flash-medium", 10)],
    });
    assert.deepEqual(r.map((x) => [x.name, x.total]), [["SWE-2 Flash", 10], ["SWE-2", 0]],
      "the more specific config key owns the record");
    // A used record can be owned by a live-only slot too.
    const r2 = buildModels({
      live: [{ id: "alpha-beta", name: "AB" }],
      config: [{ name: "Unrelated" }],
      used: [U("alpha-beta-gamma", 7)],
    });
    assert.equal(r2.find((x) => x.name === "AB").total, 7);
    assert.equal(r2.find((x) => x.name === "Unrelated").total, 0);
  }
  {
    // Totals are summed per key via Number(x)||0: strings, booleans and junk.
    // (Owned by a config row — unowned records are NOT merged, each becomes
    // its own row; covered below.)
    const r = buildModels({ config: [{ name: "M" }], used: [U("m", 1), U("m", 2), { name: "m", input: "3", output: "x", total: "4" }] });
    const row = r[0];
    assert.equal(row.input, 6, '"3" stringifies; "x" -> 0; numbers add');
    assert.equal(row.total, 7);
    assert.equal(row.state, "used");
    // Two unowned records for the same model are NOT merged: two rows.
    const rm = buildModels({ used: [U("dup-u", 1), U("dup-u", 2)] });
    assert.equal(rm.length, 2, "QUIRK: unowned used records are never deduplicated");
    assert.deepEqual(rm.map((x) => x.total), [2, 1], "used rows sort by total desc");
    // QUIRK: Number(true) === 1 — a boolean total counts as one token for
    // state, though the row keeps the raw `true` value.
    const rb = buildModels({ used: [{ name: "b", total: true }] });
    assert.equal(rb[0].total, true);
    assert.equal(rb[0].state, "used");
    // QUIRK: negative totals are kept; a config row with only negative usage
    // stays "zero" (state needs total > 0) while an unowned one is "zero" too.
    const rn = buildModels({ config: [{ name: "N" }], used: [{ name: "n", total: -5 }] });
    assert.equal(rn[0].state, "zero", "QUIRK: negative total never reaches 'used'");
    assert.equal(rn[0].total, -5);
    const ru = buildModels({ used: [{ name: "neg-only", total: -1 }] });
    assert.equal(ru[0].state, "zero", "QUIRK: unowned negative-total row is 'zero', not 'used'");
    // NaN/Infinity pass through Number()||0 — Infinity survives (!truthy).
    const ri = buildModels({ used: [{ name: "inf", total: Infinity }] });
    assert.equal(ri[0].total, Infinity, "QUIRK: Infinity is not filtered");
    assert.equal(ri[0].state, "used");
  }
  {
    // Unowned used records become rows verbatim-plus: every original field is
    // kept, id/state/removing are overwritten.
    const u = { name: "mystery", total: 8, input: 8, output: 0, cacheRead: 0, cacheWrite: 0,
      removing: "SHOULD-BE-CLEARED", extra: { keep: [1] }, id: "old-id", state: "bogus" };
    const r = buildModels({ used: [u], config: [], live: [] });
    assert.equal(r.length, 1);
    assert.equal(r[0].extra.keep[0], 1, "unknown fields survive the spread");
    assert.equal(r[0].id, "mystery");
    assert.equal(r[0].state, "used");
    assert.equal(r[0].removing, "", "removing is reset on used-only rows");
    // A zero-total unowned record still becomes a "zero" row.
    const rz = buildModels({ used: [{ name: "quiet", total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }] });
    assert.deepEqual(rz.map((x) => [x.name, x.state]), [["quiet", "zero"]]);
    // A used record with NO name can never be owned (norm("") matches nothing)
    // and lands as a row with name undefined / id "".
    const rn = buildModels({ used: [{ total: 3, input: 3, output: 0, cacheRead: 0, cacheWrite: 0 }] });
    assert.equal(rn.length, 1);
    assert.equal(rn[0].name, undefined);
    assert.equal(rn[0].id, "");
    assert.equal(rn[0].state, "used");
    // QUIRK: a non-object used entry (string) spreads into character keys.
    const rs = buildModels({ used: ["abc"] });
    assert.equal(rs.length, 1);
    assert.equal(rs[0][0], "a", "QUIRK: {...'abc'} yields {0:'a',1:'b',2:'c'}");
    assert.equal(rs[0].name, undefined);
    assert.equal(rs[0].state, "zero");
  }

  // ================================================================ sorting
  {
    // used rows sort by total desc; equal totals and all zero/unavailable rows
    // keep insertion order (config order, then live order, then stray used).
    const r = buildModels({
      plan: "Pro",
      config: [
        { name: "ZeroA" }, { name: "Blocked", unavailableOn: ["Pro"] },
        { name: "UsedSmall", match: ["small"] }, { name: "UsedBig", match: ["big"] },
        { name: "ZeroB" },
      ],
      used: [U("small", 10), U("big", 100), U("big", 50), U("stray", 1)],
      live: [],
    });
    assert.deepEqual(r.map((x) => x.name), ["UsedBig", "UsedSmall", "stray", "ZeroA", "ZeroB", "Blocked"]);
    // Equal totals: stable by slot order, not alphabetical.
    const r2 = buildModels({ config: [{ name: "B" }, { name: "A" }], used: [U("a", 5), U("b", 5)] });
    assert.deepEqual(r2.map((x) => [x.name, x.total]), [["B", 5], ["A", 5]]);
    // used always outranks zero, zero always outranks unavailable.
    const r3 = buildModels({ plan: "Free", config: [
      { name: "U", unavailableOn: ["Free"] }, { name: "Z" }, { name: "W", match: ["w"] },
    ], used: [U("w", 1)] });
    assert.deepEqual(r3.map((x) => x.state), ["used", "zero", "unavailable"]);
  }

  // ================================================================ purity / repeatability
  {
    // Stateless: same input -> identical output, interleaved calls don't leak.
    const args = { plan: "Pro", config: [{ name: "A", match: ["a-x"] }], live: [{ id: "b", name: "B" }], used: [U("a-x", 1)] };
    const a = buildModels(args);
    const junk = buildModels({ config: [{ name: "JUNK" }], used: [U("zzz", 999)] });
    const b = buildModels(args);
    assert.deepEqual(a, b, "repeat calls are identical");
    assert.notEqual(a, junk);
    // Inputs are never mutated: deep-freeze everything (strict mode throws on
    // any write attempt inside buildModels).
    const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
    const frozen = deepFreeze({ plan: "Pro", config: [{ name: "F", match: ["f-1"], removing: "x" }],
      live: [{ id: "g-1", name: "G" }], used: [U("f-1", 2)] });
    const fr = buildModels(frozen); // must not throw
    assert.equal(fr.find((x) => x.name === "F").total, 2);
    // A thousand back-to-back calls stay deterministic (no hidden cache drift).
    for (let i = 0; i < 1000; i++) assert.deepEqual(buildModels(args), a);
  }

  // ================================================================ row shape
  {
    const r = buildModels({ plan: "Pro", config: [{ name: "Shape", match: ["shape-x"] }],
      live: [{ id: "live-only", name: "LiveOnly" }], used: [U("stray", 3)] });
    for (const row of r) {
      assert.deepEqual(Object.keys(row).sort(), [...ROW_KEYS].sort(), `row ${row.name} has exactly the fixed keys`);
      assert.equal(typeof row.state, "string");
      assert.ok(["used", "zero", "unavailable"].includes(row.state));
    }
  }

  // BUG (reported, not fixed): buildModels destructures its parameter with no
  // default, so the two most natural "empty" calls throw instead of returning
  // [] like buildModels({}) does:
  //   buildModels()      -> TypeError: Cannot destructure ... of undefined
  //   buildModels(null)  -> TypeError: Cannot destructure ... of null
  // Scalar arguments happen to survive (string/number/array coerce to an
  // object with no matching keys), which makes the null crash inconsistent.
  // A `= {}` default on the parameter would close it.
  // assert.deepEqual(buildModels(), []);
  // assert.deepEqual(buildModels(null), []);

  // BUG (reported, not fixed): non-object entries inside `used`/`live` crash
  // on property access before any filtering can happen:
  //   buildModels({ used: [null] })        -> TypeError: Cannot read properties of null (u.name)
  //   buildModels({ used: [undefined] })   -> same
  //   buildModels({ live: [null] })        -> TypeError (l.id in the claim pass)
  //   buildModels({ live: [{}], config:[{name:"A"}] }) is fine, but live:[null]
  //   crashes even with an empty config because slotKeys reads l.id directly.
  // config entries ARE guarded (e && e.name), so the asymmetry looks accidental.
  // assert.doesNotThrow(() => buildModels({ used: [null] }));
  // assert.doesNotThrow(() => buildModels({ live: [null] }));

  // BUG (reported, not fixed): `unavailableOn` is duck-typed as an array via
  // `(e.unavailableOn || []).some(...)`. A truthy non-array (a string like
  // "Free", a number, an object) has no .some and crashes the whole call:
  //   buildModels({ config: [{ name: "X", unavailableOn: "Free" }] })
  //     -> TypeError: (intermediate value).some is not a function
  // Array.isArray(e.unavailableOn) ? ... : [] would match how `match` and
  // `config` themselves are already guarded.
  // assert.doesNotThrow(() => buildModels({ config: [{ name: "X", unavailableOn: "Free" }] }));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log("models.deep: all tests passed");
