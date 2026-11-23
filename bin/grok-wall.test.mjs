import assert from "node:assert/strict";
import { grokWall } from "./grok-wall.mjs";
// Lines as Grok 1.0.92 wrote them (trimmed ctx).
const fail = JSON.stringify({ ts: "2026-11-23T01:18:32.175Z", src: "shell", msg: "shell.turn.inference_failed", ctx: { kind: "rate_limited", status_code: 429,
  message: "API error (status 429 Too Many Requests): subscription:free-usage-exhausted: You've used all the included free usage for model grok-4.7 for now. Usage resets over a rolling 24-hour window — tokens (actual/limit): 674276/600000. Upgrade to a Grok subscription for higher limits: https://grok.com/super" } });
const done = (ts) => JSON.stringify({ ts, src: "shell", msg: "shell.turn.inference_done", ctx: {} });
const at = (iso) => Date.parse(iso);

const w = grokWall([done("2026-11-23T01:18:26Z"), fail].join("\n"), at("2026-11-23T02:00:00Z"));
assert.equal(w.title, "Free grok-4.7 (24 h)");
assert.equal(w.percent, 1);
assert.equal(w.resetsAt, "2026-11-24T01:18:32.175Z");
assert.match(w.note, /674K of 600K tokens/);
// A later successful turn clears it; so does the 24 h window passing; junk lines are ignored.
assert.equal(grokWall([fail, done("2026-11-23T03:00:00Z")].join("\n"), at("2026-11-23T04:00:00Z")), null);
assert.equal(grokWall(fail, at("2026-11-24T01:18:33Z")), null);
assert.equal(grokWall("not json\n{}\n", at("2026-11-23T02:00:00Z")), null);
assert.equal(grokWall("", Date.now()), null);
console.log("grok-wall ok");
