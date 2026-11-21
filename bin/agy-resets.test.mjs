import assert from "node:assert/strict";
import { corroborate, fetchResets, WINDOW_BEFORE_MS } from "./agy-resets.mjs";
const NOW = Date.parse("2026-11-21T12:00:00Z"); const ago = (ms) => new Date(NOW - ms).toISOString();
const R = (over = {}) => ({ id: "1", announced_at: ago(3600e3), models: ["all"], plans: ["all"], kind: "unspecified", text: "resetting everyone", source: { author: "announcer", url: "https://x.com/announcer/status/1" }, ...over });
const S = (title) => [{ title, surprise: true, dueAt: "2026-11-24T00:00:00Z" }];

// matching announcements
assert.equal(corroborate([R()], S("Gemini Session"), NOW, "Free").id, "1", "an hour-old 'all models, all plans' announcement backs it up");
assert.equal(corroborate([R({ models: ["gemini"] })], S("Gemini Weekly"), NOW, "Free").id, "1", "model pool matches the meter family");
assert.equal(corroborate([R({ models: ["argon", "gemini"] })], S("Gemini Session"), NOW, "").id, "1");
assert.equal(corroborate([R({ plans: ["free", "pro"] })], S("Claude/GPT Weekly"), NOW, "Free") && "x", "x", "plan list containing the user's plan");
assert.equal(corroborate([R({ announced_at: new Date(NOW + 10 * 60e3).toISOString() })], S("Gemini Session"), NOW, "Free").id, "1", "announced just after we noticed also counts");
// non-matching
assert.equal(corroborate([R({ announced_at: ago(WINDOW_BEFORE_MS + 60e3) })], S("Gemini Session"), NOW, "Free"), null, "too old (the Nov 17 announcement must not back up a Nov 21 drop)");
assert.equal(corroborate([R({ announced_at: new Date(NOW + 3 * 3600e3).toISOString() })], S("Gemini Session"), NOW, "Free"), null, "announced hours AFTER: not this reset");
assert.equal(corroborate([R({ models: ["gemini"] })], S("Claude/GPT Weekly"), NOW, "Free"), null, "a Gemini-only reset does not explain a Claude/GPT meter");
assert.equal(corroborate([R({ plans: ["ultra"] })], S("Gemini Session"), NOW, "Free"), null, "a reset for another plan");
assert.equal(corroborate([], S("Gemini Session"), NOW, "Free"), null, "nothing announced");
assert.equal(corroborate(null, S("Gemini Session"), NOW), null); assert.equal(corroborate([R()], [], NOW), null, "no surprise, nothing to back up");
assert.equal(corroborate([R()], [{ title: "Gemini Session", surprise: false }], NOW), null, "a scheduled reset is never 'confirmed'");
assert.equal(corroborate([{ announced_at: "junk" }, R()], S("Gemini Session"), NOW, "Free").id, "1", "junk entries skipped");

// fetch: success, http error, bad body, network failure -> always an array, never throws
const ok = (body) => async () => ({ ok: true, json: async () => body });
assert.deepEqual((await fetchResets({ now: NOW, fetchFn: ok({ data: [R()] }) })).map((r) => r.id), ["1"]);
assert.deepEqual(await fetchResets({ now: NOW, fetchFn: async () => ({ ok: false }) }), []);
assert.deepEqual(await fetchResets({ now: NOW, fetchFn: ok({ nope: 1 }) }), []);
assert.deepEqual(await fetchResets({ now: NOW, fetchFn: async () => { throw new Error("offline"); } }), []);
let seen; await fetchResets({ now: NOW, fetchFn: async (u, o) => { seen = { u, o }; return { ok: true, json: async () => ({ data: [] }) }; } });
assert.match(seen.u, /\/api\/v1\/resets\?limit=10&from=/); assert.equal(seen.o.headers["User-Agent"], "agent-usage-tabs"); assert.ok(!JSON.stringify(seen.o).match(/token|auth|cookie|email/i), "nothing about the user is sent");
console.log("agy-resets: all tests passed");
