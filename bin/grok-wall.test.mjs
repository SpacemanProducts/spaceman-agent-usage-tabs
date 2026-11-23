import assert from "node:assert/strict";
import { grokWall } from "./grok-wall.mjs";
// Lines as Grok 1.0.92 wrote them (trimmed ctx).
const fail = (ts, actual = 674276) => JSON.stringify({ ts, src: "shell", msg: "shell.turn.inference_failed", ctx: { kind: "rate_limited", status_code: 429,
  message: `API error (status 429 Too Many Requests): subscription:free-usage-exhausted: You've used all the included free usage for model grok-4.7 for now. Usage resets over a rolling 24-hour window — tokens (actual/limit): ${actual}/600000. Upgrade to a Grok subscription for higher limits: https://grok.com/super` } });
// weight = prompt - 0.75*cached + completion
const done = (ts, prompt = 0, cached = 0, completion = 0) => JSON.stringify({ ts, src: "shell", msg: "shell.turn.inference_done",
  ctx: { prompt_tokens: prompt, cached_prompt_tokens: cached, completion_tokens: completion } });
const at = (iso) => Date.parse(iso);

// Hit: red at 100%, Grok's own count, and the note that Grok doesn't say what's left.
const hit = fail("2026-11-23T01:18:32.175Z");
const w = grokWall([done("2026-11-23T01:18:26Z", 100000, 0, 0), hit].join("\n"), at("2026-11-23T02:00:00Z"));
assert.equal(w.title, "Free grok-4.7 (24 h)"); assert.equal(w.percent, 1); assert.equal(w.cap, true);
assert.equal(w.resetsAt, "2026-11-24T01:18:32.175Z"); assert.ok(w.hitAt);
assert.match(w.note, /674K of 600K tokens/); assert.match(w.note, /doesn't report how much is left/);

// No hit on a Free plan: estimate from the last 24 h of calls (old calls drop out), never shown full.
const est = grokWall([done("2026-11-21T00:00:00Z", 900000), done("2026-11-22T12:00:00Z", 200000, 80000, 10000), done("2026-11-22T13:00:00Z", 50000)].join("\n"),
  at("2026-11-22T14:00:00Z"));
assert.equal(est.percent, (200000 - 60000 + 10000 + 50000) / 600000); assert.equal(est.hitAt, undefined); assert.equal(est.resetsAt, "");
assert.match(est.note, /About 200K of 600K tokens in the last 24 h, estimated from Grok's log/);
assert.equal(grokWall(done("2026-11-22T12:00:00Z", 5e6), at("2026-11-22T13:00:00Z")).percent, 0.99, "not hit -> never 100%");
assert.equal(grokWall("", Date.now()).percent, 0, "Free plan, no turns: an empty green bar");

// After a hit lifts, the estimate is scaled by Grok's count at the hit (here 2x what the log sums).
const lifted = grokWall([done("2026-11-23T00:00:00Z", 300000), fail("2026-11-23T01:00:00Z", 600000), done("2026-11-23T02:00:00Z", 30000)].join("\n"),
  at("2026-11-23T03:00:00Z"));
assert.equal(lifted.hitAt, undefined); assert.equal(lifted.percent, 0.99);   // (300K+30K)*2 = 660K of 600K, capped below full
// A hit is forgotten 24 h later; a paid plan with no hit seen shows no cap; junk lines are ignored.
assert.equal(grokWall(hit, at("2026-11-24T01:18:33Z")).hitAt, undefined);
assert.equal(grokWall(done("2026-11-22T12:00:00Z", 1000), at("2026-11-22T13:00:00Z"), { free: false }), null);
assert.equal(grokWall("not json\n{}\n", at("2026-11-23T02:00:00Z")).percent, 0);
console.log("grok-wall ok");
