import assert from "node:assert/strict";
import { parseClaudeLimits, parseClaudeResets } from "./claude-limits.mjs";
const titles = (p) => parseClaudeLimits(p).map((l) => l.title);

// 1. Real Pro-account shape captured from the endpoint: no scoped entries.
const pro = { five_hour: { utilization: 77, resets_at: "x" }, seven_day: { utilization: 36, resets_at: "y" },
  seven_day_opus: null, seven_day_sonnet: null, usage_scopes: null,
  limits: [{ kind: "session", scope: null, percent: 77 }, { kind: "weekly_all", scope: null, percent: 36 }] };
assert.deepEqual(titles(pro), ["Session", "Weekly"], "Pro: no Fable meter");

// 2. Documented scoped shape with a Fable weekly entry.
const max = { ...pro, limits: [...pro.limits, { kind: "weekly_scoped", scope: { model: { display_name: "Fable 5.2", id: "claude-fable-5-2" } }, percent: 41, resets_at: "z" }] };
const out = parseClaudeLimits(max);
assert.deepEqual(out.map((l) => l.title), ["Session", "Weekly", "Fable Weekly"]);
assert.equal(out[2].percent, 0.41); assert.equal(out[2].resetsAt, "z");

// 3. Id only, no display name.
assert.ok(titles({ limits: [{ kind: "weekly_scoped", scope: { model: { id: "claude-fable-5-2" } }, percent: 5 }] }).includes("Fable Weekly"));

// 4. Other scoped models are not Fable; garbage and null are ignored; no guessing.
assert.deepEqual(titles({ limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "Opus 5" } }, percent: 90 }] }), []);
assert.deepEqual(titles(null), []); assert.deepEqual(titles({ limits: "nope" }), []);
assert.deepEqual(titles({ limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: null }] }), []);
assert.deepEqual(titles({ limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: "abc" }] }), []);

// 5. Duplicate Fable windows collapse to one.
const dup = { limits: [1, 2].map((n) => ({ kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: n })) };
assert.equal(parseClaudeLimits(dup).length, 1);

// 6. Fable window kinds: monthly gets its own title, an unrecognized kind
//    still shows the meter as plain "Fable", and pct edge cases hold.
assert.deepEqual(titles({ limits: [{ kind: "monthly_scoped", scope: { model: { display_name: "Fable" } }, percent: 10 }] }), ["Fable Monthly"]);
assert.deepEqual(titles({ limits: [{ kind: "hourly_scoped", scope: { model: { display_name: "Fable" } }, percent: 10 }] }), ["Fable Session"], "hour kinds read as Session");
assert.deepEqual(titles({ limits: [{ kind: "mystery", scope: { model: { display_name: "Fable" } }, percent: 10 }] }), ["Fable"], "no known window: no suffix, still shown");
assert.equal(parseClaudeLimits({ five_hour: { utilization: "85" } })[0].percent, 0.85, "numeric strings count");
assert.equal(parseClaudeLimits({ five_hour: { utilization: 250 } })[0].percent, 1, "over 100% clamps");
assert.deepEqual(titles({ five_hour: { utilization: -5 }, seven_day: { utilization: 20 } }), ["Weekly"], "negative utilization is no value, not 0%");
assert.deepEqual(titles({ five_hour: null, seven_day: { utilization: 20, resets_at: "r" } }), ["Weekly"], "a missing window is skipped, not zeroed");
assert.equal(parseClaudeLimits({ five_hour: { utilization: 10 } })[0].resetsAt, "", "missing resets_at stays empty");

// ---- parseClaudeResets: banked "limit resets" from the cedar_ember block
assert.equal(parseClaudeResets({}), null, "no block: nothing");
assert.equal(parseClaudeResets({ cedar_ember: "yes" }), null, "non-object block: nothing");
assert.equal(parseClaudeResets({ cedar_ember: {} }), null, "no grants list: nothing");
assert.equal(parseClaudeResets({ cedar_ember: { grants: "nope" } }), null, "non-list grants: nothing");
assert.equal(parseClaudeResets({ cedar_ember: { grants: [{ resets_left: 1.5 }] } }), null, "a fractional count is not a reset");
assert.equal(parseClaudeResets({ cedar_ember: { grants: [{ resets_left: -1 }] } }), null, "negative is not a reset");
assert.equal(parseClaudeResets({ cedar_ember: { grants: [{ resets_left: 3, paused: true }] } }), null, "all paused: nothing usable");
{
  const r = parseClaudeResets({ cedar_ember: { grants: [
    { resets_left: 1, paused: false, usable_now: false, ends_at: "2026-12-10T00:00:00Z" },
    { resets_left: 2, paused: false, usable_now: true, ends_at: "not a date" },
    { resets_left: 1, paused: false, ends_at: "2026-12-05T00:00:00Z" }] } });
  assert.deepEqual(r, { left: 4, usableNow: true, expiresAt: "2026-12-05T00:00:00.000Z" },
    "usable_now from any grant, earliest VALID ends_at wins, garbage dates ignored");
}
assert.equal(parseClaudeResets({ cedar_ember: { grants: [{ resets_left: 1, ends_at: "junk" }] } }).expiresAt, "", "no readable date: empty, not invented");
console.log("claude-limits: all tests passed");
