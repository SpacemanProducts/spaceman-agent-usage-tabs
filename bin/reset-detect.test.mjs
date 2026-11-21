import assert from "node:assert/strict";
import { detectResets, classifyResets } from "./reset-detect.mjs";
import { parseClaudeResets } from "./claude-limits.mjs";
const L = (title, percent) => ({ title, percent });
assert.deepEqual(detectResets([L("Session", 0.9)], [L("Session", 0.02)]), ["Session"], "big drop");
assert.deepEqual(detectResets([L("Weekly", 0.99)], [L("Weekly", 0)]), ["Weekly"]);
assert.deepEqual(detectResets([L("Session", 0.9)], [L("Session", 0.41)]), [], "49 points is not a reset");
assert.deepEqual(detectResets([L("Session", 0.9)], [L("Session", 0.4)]), [], "exactly 50 is not more than 50");
assert.deepEqual(detectResets([L("Session", 0.9)], [L("Session", 0.39)]), ["Session"], "51 points is");
assert.deepEqual(detectResets([L("Session", 0.3)], [L("Session", 0.7)]), [], "rises are ignored");
assert.deepEqual(detectResets([L("Monthly", 0.9)], [L("Monthly", 0)]), [], "monthly is not watched");
assert.deepEqual(detectResets([], [L("Session", 0)]), [], "no previous data");
assert.deepEqual(detectResets(null, null), []);
assert.deepEqual(detectResets([L("Session", "x")], [L("Session", 0)]), [], "non-numeric previous");
assert.deepEqual(detectResets([L("Claude/GPT Weekly", 0.99)], [L("Claude/GPT Weekly", 0.1)]), ["Claude/GPT Weekly"], "any agent's weekly title");
// banked resets
assert.equal(parseClaudeResets(null), null);
assert.equal(parseClaudeResets({ cedar_ember: null }), null, "your Pro account's real shape");
assert.equal(parseClaudeResets({ cedar_ember: { eligible: false, grants: [{ resets_left: 3 }] } }), null);
const r = parseClaudeResets({ cedar_ember: { eligible: true, grants: [
  { resets_left: 2, paused: false, usable_now: true, ends_at: "2026-12-10T22:00:00Z" },
  { resets_left: 1, paused: false, ends_at: "2026-12-01T00:00:00Z" },
  { resets_left: 5, paused: true, ends_at: "2026-11-25T00:00:00Z" },
  { resets_left: 0, ends_at: "2026-11-22T00:00:00Z" }] } });
assert.deepEqual(r, { left: 3, usableNow: true, expiresAt: "2026-12-01T00:00:00.000Z" });

// ---- classifyResets: scheduled vs surprise
const NOW = Date.parse("2026-11-21T12:00:00Z");
const M = (title, percent, resetsAt) => ({ title, percent, resetsAt });
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();
// reset time still 3 days away, meter fell from 99% to 2%: a surprise
let c = classifyResets([M("Claude/GPT Weekly", 0.99, iso(3 * 86400e3))], [M("Claude/GPT Weekly", 0.02, iso(7 * 86400e3))], NOW);
assert.deepEqual(c.map((x) => [x.title, x.surprise]), [["Claude/GPT Weekly", true]]); assert.equal(c[0].dueAt, iso(3 * 86400e3));
// reset time already passed: a normal, scheduled reset
c = classifyResets([M("Weekly", 0.99, iso(-10 * 60e3))], [M("Weekly", 0, iso(7 * 86400e3))], NOW); assert.equal(c[0].surprise, false); assert.equal(c[0].dueAt, "");
// within the 5-minute tolerance (clock skew, rounding): still scheduled
assert.equal(classifyResets([M("Session", 0.9, iso(4 * 60e3))], [M("Session", 0, iso(5 * 3600e3))], NOW)[0].surprise, false);
assert.equal(classifyResets([M("Session", 0.9, iso(6 * 60e3))], [M("Session", 0, iso(5 * 3600e3))], NOW)[0].surprise, true, "just over the tolerance is early");
// no readable previous reset time: never claim a surprise without evidence
assert.equal(classifyResets([M("Session", 0.9)], [M("Session", 0)], NOW)[0].surprise, false);
assert.equal(classifyResets([M("Session", 0.9, "not a date")], [M("Session", 0)], NOW)[0].surprise, false);
// not a reset at all: nothing, early or not
assert.deepEqual(classifyResets([M("Session", 0.9, iso(3600e3))], [M("Session", 0.5, iso(3600e3))], NOW), [], "a 40-point drop is not a reset");
assert.deepEqual(classifyResets([M("Monthly", 0.9, iso(3600e3))], [M("Monthly", 0, iso(3600e3))], NOW), [], "monthly is not watched");
assert.deepEqual(classifyResets(null, null, NOW), []);
// each meter is classified on its own
c = classifyResets([M("Gemini Session", 0.95, iso(-1000)), M("Gemini Weekly", 0.95, iso(86400e3))], [M("Gemini Session", 0, iso(5 * 3600e3)), M("Gemini Weekly", 0, iso(7 * 86400e3))], NOW);
assert.deepEqual(c.map((x) => x.surprise), [false, true]);
// detectResets still agrees with classifyResets on WHICH meters reset
assert.deepEqual(detectResets([M("Weekly", 0.99, iso(86400e3))], [M("Weekly", 0)]), ["Weekly"]);
console.log("reset-detect: all tests passed");
