import assert from "node:assert/strict";
import { parseUsage, usedFraction } from "./openclaw-usage.mjs";
// The real output on a machine whose provider could not answer: no bars, one calm line saying why (never an error card)
const real = { usage: { updatedAt: 1795346185857, providers: [{ provider: "openai", displayName: "OpenAI", windows: [], error: 'Agent harness runtime "codex" is unavailable.' }] } };
assert.deepEqual(parseUsage(real), { limits: [], status: "", failed: ["OpenAI"] }, "a provider that really failed is named; no repair hint");
assert.deepEqual(parseUsage({ usage: { providers: [] } }), { limits: [], status: "", failed: [] }, "no windows and no failure: nothing to say");
assert.deepEqual(parseUsage({}), { limits: [], status: "", failed: [] });
assert.deepEqual(parseUsage(null), { limits: [], status: "", failed: [] });
// Windows, in the spellings a provider might use: used or left, percent or fraction, ISO or epoch resets
const r = parseUsage({ usage: { providers: [
  { provider: "anthropic", displayName: "Claude", windows: [{ label: "5-hour", usedPercent: 42, resetsAt: "2026-11-22T15:00:00Z" }, { label: "Weekly (7-day)", percentLeft: 30, resetAt: 1795600000000 }] },
  { provider: "minimax", displayName: "MiniMax", windows: [{ window: "week", remainingFraction: 0.75, resetTime: 1795600 }] },
  { provider: "x", displayName: "NoNumbers", windows: [{ label: "Session", note: "no percent here" }] },
] } });
assert.deepEqual(r.limits.map((l) => [l.title, Math.round(l.percent * 100)]), [["Claude Session", 42], ["Claude Weekly", 70], ["MiniMax Weekly", 25]], "a window with no percent gets no bar");
assert.equal(r.limits[0].resetsAt, "2026-11-22T15:00:00.000Z"); assert.equal(r.limits[1].resetsAt, new Date(1795600000000).toISOString()); assert.equal(r.limits[2].resetsAt, new Date(1795600000).toISOString(), "seconds are read as seconds");
assert.equal(r.status, ""); assert.deepEqual(r.failed, [], "windows with no percent are not failures");
assert.equal(usedFraction({ usedPercent: 150 }), 1); assert.equal(usedFraction({ usedPercent: -5 }), 0); assert.equal(usedFraction({}), null); assert.equal(usedFraction({ usedPercent: "42" }), null, "only real numbers");
console.log("openclaw-usage: all tests passed");
