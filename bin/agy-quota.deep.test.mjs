// Deep edge-case pass for bin/agy-quota.mjs on top of agy-quota.test.mjs.
// The module is pure (no I/O, no clock, no shared state), so nothing here
// touches the real HOME: the scratch dir only exists to satisfy the "never
// touch the real home folder" rule, and env vars are pointed at it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { used, resetOf, poolLabel, quotaGroups, parseQuota } from "./agy-quota.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-quota-deep-"));
const savedEnv = {};
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  savedEnv[k] = process.env[k];
  process.env[k] = path.join(tmp, k.toLowerCase());
  fs.mkdirSync(process.env[k], { recursive: true });
}

const R = "2026-11-26T11:27:25Z";
const ISO_R = "2026-11-26T11:27:25.000Z";

try {
  // ---- used(): non-object and falsy buckets ----
  for (const bad of [null, undefined, 0, false, "", NaN]) {
    assert.equal(used(bad), null, `used(${String(bad)}) is null`);
  }
  // Truthy primitives have no quota fields: still null, never a throw.
  for (const bad of [5, "x", true, [], {}]) {
    assert.equal(used(bad), null, `used(${JSON.stringify(bad) ?? String(bad)}) is null`);
  }

  // ---- used(): disabled is a strict === true check ----
  assert.equal(used({ disabled: true, remainingFraction: 0.2 }), null);
  for (const d of [1, "true", "yes", {}, []]) {
    assert.equal(used({ disabled: d, remainingFraction: 0.2 }), 0.8,
      `disabled: ${JSON.stringify(d)} does NOT disable (strict === true)`);
  }
  assert.equal(used({ disabled: false, remainingFraction: 0.2 }), 0.8);

  // ---- used(): remainingFraction beats remaining_fraction; nullish falls through ----
  assert.equal(used({ remainingFraction: 0.25, remaining_fraction: 0.75 }), 0.75,
    "camelCase wins when both are present");
  assert.equal(used({ remainingFraction: null, remaining_fraction: 0.75 }), 0.25);
  assert.equal(used({ remainingFraction: undefined, remaining_fraction: 0.75 }), 0.25);
  assert.equal(used({ remainingFraction: 0, remaining_fraction: 0.75 }), 1,
    "0 is not nullish: camelCase 0 wins and means fully used");
  assert.equal(used({ remaining_fraction: 0.5 }), 0.5, "snake_case alone works");

  // ---- used(): coercion of the fraction ----
  assert.equal(used({ remainingFraction: "0.25" }), 0.75, "numeric string coerces");
  assert.equal(used({ remainingFraction: "" }), 1, "empty string coerces to 0 remaining = fully used");
  assert.equal(used({ remainingFraction: "  " }), 1, "whitespace string coerces to 0");
  assert.equal(used({ remainingFraction: true }), 0, "true coerces to 1 remaining = unused");
  assert.equal(used({ remainingFraction: false }), 1, "false coerces to 0 remaining = fully used");
  assert.equal(used({ remainingFraction: [] }), 1, "[] coerces to 0");
  assert.equal(used({ remainingFraction: [0.5] }), 0.5, "single-element array coerces to its element");
  for (const bad of ["junk", NaN, Infinity, -Infinity, {}, [0.5, 0.6], "0.5x"]) {
    assert.equal(used({ remainingFraction: bad, resetTime: R }), null,
      `unparseable fraction ${JSON.stringify(bad)} poisons the bucket even with a resetTime`);
  }

  // ---- used(): out-of-range fractions clamp to [0,1] ----
  assert.equal(used({ remainingFraction: -0.5 }), 1, "negative remaining clamps to fully used");
  assert.equal(used({ remainingFraction: 1.5 }), 0, "remaining > 1 clamps to unused");
  assert.equal(used({ remainingFraction: 0 }), 1);
  assert.equal(used({ remainingFraction: 1 }), 0);
  {
    const u = used({ remainingFraction: 0.999999999 });
    assert.ok(u > 0 && u < 1e-8, "tiny positive stays positive (float dust is fine)");
  }

  // ---- used(): no fraction falls back to 'has a reset time => fully used' ----
  assert.equal(used({ resetTime: R }), 1);
  assert.equal(used({ reset_time: R }), 1, "snake_case reset time counts too");
  assert.equal(used({ resetTime: "", reset_time: R }), 1, "empty camelCase falls through to snake_case");
  assert.equal(used({}), null, "no fraction and no reset time = no data");
  assert.equal(used({ resetTime: null, reset_time: null }), null);
  assert.equal(used({ resetTime: 0, reset_time: R }), 1, "0 is falsy: falls through to reset_time");
  // A truthy-but-unparseable resetTime still counts as 'has a reset time'.
  assert.equal(used({ resetTime: "garbage" }), 1);
  assert.equal(used({ resetTime: {} }), 1, "any truthy resetTime value counts");

  // ---- resetOf(): date parsing edges ----
  assert.equal(resetOf({ resetTime: R }), ISO_R);
  assert.equal(resetOf({ reset_time: R }), ISO_R);
  assert.equal(resetOf({ resetTime: "", reset_time: R }), ISO_R);
  assert.equal(resetOf({}), "", "missing reset time is empty string, not a throw");
  assert.equal(resetOf({ resetTime: "not a date" }), "");
  assert.equal(resetOf({ resetTime: "2026-13-45T99:99:99Z" }), "", "impossible date is invalid");
  assert.equal(resetOf({ resetTime: 0 }), "", "0 is falsy and there is no reset_time");
  // A numeric epoch-ms resetTime is truthy and parses.
  assert.equal(resetOf({ resetTime: 1764242845000 }), new Date(1764242845000).toISOString());
  // camelCase wins over snake_case when both are set.
  assert.equal(resetOf({ resetTime: R, reset_time: "2020-01-01T00:00:00Z" }), ISO_R);

  // ---- poolLabel(): names it does not recognise keep their own text ----
  assert.equal(poolLabel("  Gemini  "), "Gemini", "trimmed before matching");
  assert.equal(poolLabel("gemini models"), "Gemini");
  assert.equal(poolLabel("Gemini4"), "Gemini");
  assert.equal(poolLabel("Claude"), "Claude/GPT");
  assert.equal(poolLabel("gpt-5"), "Claude/GPT");
  assert.equal(poolLabel("Claude and GPT models"), "Claude/GPT");
  assert.equal(poolLabel("Kimi K2"), "Kimi K2", "unknown names are kept verbatim, not 'Other'");
  assert.equal(poolLabel("  "), "Other");
  assert.equal(poolLabel(null), "Other");
  assert.equal(poolLabel(undefined), "Other");
  assert.equal(poolLabel(0), "Other");
  assert.equal(poolLabel(123), "123", "numbers stringify");

  // ---- quotaGroups(): corrupt and wrong-typed input ----
  for (const bad of [null, undefined, 0, "x", 42, true, [], {}]) {
    assert.deepEqual(quotaGroups(bad), [], `quotaGroups(${JSON.stringify(bad) ?? String(bad)})`);
  }
  // groups present but not an array -> falls through to the flat buckets shape.
  assert.deepEqual(quotaGroups({ groups: "yes", buckets: [{ a: 1 }] }), [{ displayName: "Gemini", buckets: [{ a: 1 }] }]);
  assert.deepEqual(quotaGroups({ groups: { 0: {} }, buckets: [{ a: 1 }] }), [{ displayName: "Gemini", buckets: [{ a: 1 }] }]);
  // groups array whose entries are ALL non-objects filters to empty -> ALSO falls back to buckets.
  assert.deepEqual(quotaGroups({ groups: [null, "x", 5], buckets: [{ a: 1 }] }),
    [{ displayName: "Gemini", buckets: [{ a: 1 }] }],
    "an all-junk groups array is treated as 'no groups'");
  // ...but one surviving object keeps the groups path and buckets is ignored.
  assert.deepEqual(quotaGroups({ groups: [null, {}], buckets: [{ a: 1 }] }), [{}]);
  // Flat buckets that are not an array produce nothing.
  assert.deepEqual(quotaGroups({ buckets: "nope" }), []);
  assert.deepEqual(quotaGroups({ groups: [] }), []);

  // ---- parseQuota(): top-level wrong types ----
  for (const bad of [null, undefined, 0, "x", 42, true, [], "[]"]) {
    assert.deepEqual(parseQuota(bad), [], `parseQuota(${JSON.stringify(bad) ?? String(bad)})`);
  }
  assert.deepEqual(parseQuota({ groups: "junk", buckets: "junk" }), []);
  assert.deepEqual(parseQuota({ groups: [{}] }), [], "a group with no buckets yields nothing");
  assert.deepEqual(parseQuota({ groups: [{ displayName: "Gemini models" }] }), [],
    "even a Gemini-labelled group with no buckets yields nothing");

  // ---- parseQuota(): junk inside groups and buckets ----
  assert.deepEqual(parseQuota({ groups: [null, "x", 5, { displayName: "Gemini models", buckets: [null, "s", 7, false] }] }), [],
    "non-object groups and non-object buckets are skipped without throwing");
  assert.deepEqual(parseQuota({ groups: [{ displayName: "Gemini models", buckets: "nope" }] }), []);
  assert.deepEqual(parseQuota({ groups: [{ displayName: "Gemini models", buckets: { length: 1 } }] }), []);

  // ---- parseQuota(): weekly detection via each of the three fields ----
  const weeklyBy = (field, value) => {
    const b = { window: "5-hour", bucketId: "b1", displayName: "x", remainingFraction: 0.5, resetTime: R };
    b[field] = value;
    return parseQuota({ groups: [{ displayName: "Gemini models", buckets: [b] }] })[0].title;
  };
  assert.equal(weeklyBy("window", "weekly"), "Gemini Weekly");
  assert.equal(weeklyBy("window", "WEEKLY"), "Gemini Weekly", "case-insensitive");
  assert.equal(weeklyBy("bucketId", "3p-weekly"), "Gemini Weekly", "bucketId alone can mark weekly");
  assert.equal(weeklyBy("displayName", "Weekly allowance"), "Gemini Weekly", "displayName alone can mark weekly");
  assert.equal(weeklyBy("window", "5-hour"), "Gemini Session");
  assert.equal(weeklyBy("bucketId", "3p-session"), "Gemini Session");
  // 'week' anywhere in the concatenated fields counts, even across fields.
  assert.equal(weeklyBy("window", "rolling"), "Gemini Session");
  assert.equal(weeklyBy("bucketId", "biweekly"), "Gemini Weekly", "substring 'week' matches 'biweekly'");

  // ---- parseQuota(): non-Gemini visibility boundary ----
  // Every row at exactly 0 used hides the whole non-Gemini pool.
  assert.deepEqual(parseQuota({ groups: [{ displayName: "Claude and GPT models", buckets: [
    { window: "weekly", remainingFraction: 1, resetTime: R },
    { window: "5-hour", remainingFraction: 1, resetTime: R }] }] }), [],
    "percent exactly 0 on every row hides a scoped pool");
  // One millionth of a percent used is enough to show the whole pool.
  const tiny = parseQuota({ groups: [{ displayName: "Claude and GPT models", buckets: [
    { window: "weekly", remainingFraction: 0.999999, resetTime: R },
    { window: "5-hour", remainingFraction: 1, resetTime: R }] }] });
  assert.deepEqual(tiny.map((l) => l.title), ["Claude/GPT Session", "Claude/GPT Weekly"],
    "any percent > 0 reveals every window of the pool, untouched ones included");
  assert.ok(tiny[1].percent > 0 && tiny[1].percent < 1e-5, "percent is the tiny used fraction");
  // A resetTime-only bucket reads as fully used, so it reveals the pool.
  assert.deepEqual(parseQuota({ groups: [{ displayName: "Claude and GPT models", buckets: [
    { window: "weekly", resetTime: R }] }] }).map((l) => [l.title, l.percent]),
    [["Claude/GPT Weekly", 1]]);
  // An out-of-range fraction can also reveal the pool (clamped to 1).
  assert.deepEqual(parseQuota({ groups: [{ displayName: "Claude and GPT models", buckets: [
    { window: "weekly", remainingFraction: -2, resetTime: R }] }] }).map((l) => l.percent), [1]);
  // ...but a fraction that coerces to exactly 1 remaining cannot.
  assert.deepEqual(parseQuota({ groups: [{ displayName: "Claude and GPT models", buckets: [
    { window: "weekly", remainingFraction: "1", resetTime: R }] }] }), []);
  // A pool whose only 'use' is an unparseable fraction stays hidden (bucket dropped entirely).
  assert.deepEqual(parseQuota({ groups: [{ displayName: "Claude and GPT models", buckets: [
    { window: "weekly", remainingFraction: "junk", resetTime: R }] }] }), []);

  // ---- parseQuota(): unnamed groups are 'Other' and follow the scoped-pool rule ----
  assert.deepEqual(parseQuota({ groups: [{ buckets: [{ window: "weekly", remainingFraction: 1, resetTime: R }] }] }), [],
    "unnamed untouched pool is hidden like any non-Gemini pool");
  assert.deepEqual(parseQuota({ groups: [{ buckets: [{ window: "weekly", remainingFraction: 0.4, resetTime: R }] }] })
    .map((l) => l.title), ["Other Weekly"]);

  // ---- parseQuota(): sort is Session-then-Weekly, stable within each ----
  {
    const mk = (id, frac, reset) => ({ bucketId: id, window: id.includes("week") ? "weekly" : "5-hour", remainingFraction: frac, resetTime: reset });
    const limits = parseQuota({ groups: [{ displayName: "Gemini models", buckets: [
      mk("week-a", 0.9, "2026-11-27T00:00:00Z"), mk("sess-a", 0.5, "2026-11-26T00:00:00Z"),
      mk("week-b", 0.8, "2026-11-28T00:00:00Z"), mk("sess-b", 0.4, "2026-11-26T01:00:00Z")] }] });
    assert.deepEqual(limits.map((l) => l.resetsAt),
      ["2026-11-26T00:00:00.000Z", "2026-11-26T01:00:00.000Z", "2026-11-27T00:00:00.000Z", "2026-11-28T00:00:00.000Z"],
      "sessions first in input order, then weeklies in input order");
  }

  // ---- parseQuota(): the flat-buckets fallback is labelled Gemini (always shown) ----
  assert.deepEqual(parseQuota({ buckets: [{ window: "5-hour", remainingFraction: 1, resetTime: R }] })
    .map((l) => [l.title, l.percent]), [["Gemini Session", 0]],
    "flat buckets are hard-labelled Gemini, so even an untouched one shows");
  assert.deepEqual(parseQuota({ buckets: [{ disabled: true, remainingFraction: 0 }] }), []);
  // groups:[...] junk + flat buckets -> the fallback wins and relabels as Gemini.
  assert.deepEqual(parseQuota({ groups: [null, "junk"], buckets: [{ window: "weekly", remainingFraction: 0.5, resetTime: R }] })
    .map((l) => l.title), ["Gemini Weekly"]);

  // ---- parseQuota(): multiple groups keep their order and labels ----
  {
    const limits = parseQuota({ groups: [
      { displayName: "Gemini models", buckets: [{ window: "weekly", remainingFraction: 0.5, resetTime: R }] },
      { displayName: "Claude and GPT models", buckets: [{ window: "weekly", remainingFraction: 0.5, resetTime: R }] },
      { displayName: "Kimi", buckets: [{ window: "weekly", remainingFraction: 0.5, resetTime: R }] },
    ] });
    assert.deepEqual(limits.map((l) => l.title), ["Gemini Weekly", "Claude/GPT Weekly", "Kimi Weekly"]);
  }

  // ---- parseQuota(): does not mutate its input, and is not memoized ----
  {
    const q = { groups: [{ displayName: "Gemini models", buckets: [{ window: "weekly", remainingFraction: 0.5, resetTime: R }] }] };
    const before = JSON.stringify(q);
    const first = parseQuota(q);
    assert.equal(JSON.stringify(q), before, "input is untouched");
    q.groups[0].buckets[0].remainingFraction = 0.25;
    const second = parseQuota(q);
    assert.notDeepEqual(second, first, "a mutated input is re-read: no caching");
    assert.equal(second[0].percent, 0.75);
    // Interleaved calls on two payloads stay independent (no shared state).
    const a = { groups: [{ displayName: "Gemini models", buckets: [{ window: "weekly", remainingFraction: 0.5, resetTime: R }] }] };
    const b = { groups: [{ displayName: "Claude and GPT models", buckets: [{ window: "weekly", remainingFraction: 0.5, resetTime: R }] }] };
    const ra = parseQuota(a); parseQuota(b); const rb = parseQuota(b); const ra2 = parseQuota(a);
    assert.deepEqual(ra, ra2);
    assert.deepEqual(rb.map((l) => l.title), ["Claude/GPT Weekly"]);
  }

  // ---- parseQuota(): disabled beats everything, even a resetTime-only bucket ----
  assert.deepEqual(parseQuota({ groups: [{ displayName: "Gemini models", buckets: [
    { disabled: true, resetTime: R, window: "weekly" }] }] }), []);

  console.log("agy-quota deep: all tests passed");
} finally {
  for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
