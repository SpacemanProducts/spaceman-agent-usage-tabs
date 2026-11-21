import assert from "node:assert/strict";
import { detectResets } from "./reset-detect.mjs";
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
console.log("reset-detect: all tests passed");
