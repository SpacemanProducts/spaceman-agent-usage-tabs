import assert from "node:assert/strict";
import { parseClaudeLimits } from "./claude-limits.mjs";
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
console.log("claude-limits: all tests passed");
