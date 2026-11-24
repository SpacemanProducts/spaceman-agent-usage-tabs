import assert from "node:assert/strict";
import { buildModels, norm } from "./models.mjs";
const U = (name, total) => ({ name, total, input: total, output: 0, cacheRead: 0, cacheWrite: 0 });
const states = (rows) => Object.fromEntries(rows.map((r) => [r.name, r.state]));

assert.equal(norm("Gemini 3.8 Flash"), "gemini-3-8-flash"); assert.equal(norm("claude-sonnet-5-5"), norm("Claude Sonnet 5.5"));

// Claude: live usage first, unused known models dimmed zero.
let r = buildModels({ plan: "Pro", used: [U("claude-sonnet-5-5", 100), U("claude-haiku-5-5", 5)],
  config: [{ name: "Claude Fable 5.2" }, { name: "Claude Opus 5.5" }, { name: "Claude Sonnet 5.5" }, { name: "Claude Haiku 5.5" }] });
assert.deepEqual(r.map((x) => x.name), ["Claude Sonnet 5.5", "Claude Haiku 5.5", "Claude Fable 5.2", "Claude Opus 5.5"]);
assert.deepEqual(states(r), { "Claude Sonnet 5.5": "used", "Claude Haiku 5.5": "used", "Claude Fable 5.2": "zero", "Claude Opus 5.5": "zero" });
assert.equal(r[0].total, 100);

// Antigravity: the account's own live list decides availability.
const live = [{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }, { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" }, { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" }, { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" }];
r = buildModels({ plan: "Free", used: [U("gemini-3.8-flash-high", 50)], live, config: [{ name: "Gemini 4 Carbon" }, { name: "Gemini 3.8 Flash" }, { name: "Claude Sonnet 4.6", removing: "2026-11-18" }, { name: "GPT-OSS-120b", match: ["gpt-oss-120b"] }] });
assert.deepEqual(states(r), { "Gemini 3.8 Flash": "used", "Claude Sonnet 4.6": "zero", "GPT-OSS-120b": "zero", "Gemini 4 Carbon": "unavailable" });
assert.equal(r.find((x) => x.name === "Claude Sonnet 4.6").removing, "2026-11-18");
assert.equal(r.filter((x) => x.name.startsWith("Gemini 3.8")).length, 1, "variants merge into one row");

// Plan-blocked entries are unavailable, not zero, even without a live list.
r = buildModels({ plan: "Free", config: [{ name: "Grok 4.7" }, { name: "Claude Opus 5.5", unavailableOn: ["Free", "Plus"] }] });
assert.deepEqual(states(r), { "Grok 4.7": "zero", "Claude Opus 5.5": "unavailable" });
assert.equal(buildModels({ plan: "Premium", config: [{ name: "X", unavailableOn: ["Free"] }] })[0].state, "zero");

// Live models no entry names are still listed; used models nothing names too.
r = buildModels({ plan: "", used: [U("codex-auto-review", 7)], live: [{ id: "gpt-6-luna", name: "GPT-6-Luna" }], config: [{ name: "GPT-6 Luna" }] });
assert.deepEqual(r.map((x) => [x.name, x.state]), [["codex-auto-review", "used"], ["GPT-6 Luna", "zero"]]);
r = buildModels({ plan: "", live: [{ id: "opencode/big-pickle", name: "big-pickle" }], config: [] });
assert.deepEqual(r.map((x) => [x.name, x.state]), [["big-pickle", "zero"]]);

// A used model is never "unavailable" even if the live list lacks it.
r = buildModels({ plan: "Free", used: [U("claude-opus-4-6", 9)], live: [{ id: "x", name: "x" }], config: [{ name: "Claude Opus 4.6" }] });
assert.equal(states(r)["Claude Opus 4.6"], "used");

// Devin: swe-2-flash-medium is one model; it must not count under both swe-2 and swe-2-flash.
const devinLive = [{ id: "swe-2", name: "SWE-2" }, { id: "swe-2-flash", name: "SWE-2 Flash" }, { id: "swe-1.7", name: "SWE-1.7" }];
r = buildModels({ plan: "", used: [U("swe-2-flash-medium", 98603465), U("compactor", 248840)], live: devinLive, config: [] });
assert.deepEqual(r.map((x) => [x.name, x.state, x.total]), [
  ["SWE-2 Flash", "used", 98603465], ["compactor", "used", 248840], ["SWE-2", "zero", 0], ["SWE-1.7", "zero", 0],
]);
// A used record counts once even when a config entry and live entries could match it.
r = buildModels({ plan: "", used: [U("gemini-3.8-flash-high", 50)], live: devinLive, config: [{ name: "Gemini 3.8 Flash" }] });
assert.equal(r.find((x) => x.name === "Gemini 3.8 Flash").total, 50, "one record counts once, on its best-matching row");

// Junk in, no crash.
assert.deepEqual(buildModels({}), []); assert.deepEqual(buildModels({ config: [null, {}, { name: "A" }] }).map((x) => x.name), ["A"]);
console.log("models: all tests passed");
