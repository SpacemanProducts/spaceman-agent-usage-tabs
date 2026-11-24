import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// grok.mjs is a script (it exits on run), so it is exercised as a subprocess
// against a scratch GROK_HOME. PATH points nowhere: the `grok models` kick can
// never find the real CLI, and no test here ever reaches the network — every
// fixture stops at a login check that exits before fetch.
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "grok.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-test-"));
const grokHome = path.join(tmp, "grok-home");
const xdg = path.join(tmp, "xdg");
fs.mkdirSync(path.join(grokHome, "logs"), { recursive: true });
const run = () => spawnSync(process.execPath, [script], {
  encoding: "utf8", timeout: 30000,
  env: { ...process.env, HOME: path.join(tmp, "nohome"), GROK_HOME: grokHome, XDG_STATE_HOME: xdg, PATH: "/nonexistent" },
});
const out = (r) => { assert.equal(r.status, 0, `grok.mjs failed: ${r.stderr}`); return JSON.parse(r.stdout); };

// 1. Empty GROK_HOME: the signed-out line, no limits, no plan.
let j = out(run());
assert.equal(j.status, "Not signed in — run `grok login`.");
assert.deepEqual(j.limits, []); assert.equal(j.plan, "");

// 2. Plan from settings_cache + a standing free-cap wall from the log tail:
//    the cap meter leads the limits even while signed out (out() always prepends it).
fs.writeFileSync(path.join(grokHome, "settings_cache.json"),
  JSON.stringify({ payload: JSON.stringify({ settings: { subscription_tier_display: "SuperGrok" } }) }));
const hit = JSON.stringify({ ts: new Date().toISOString(), src: "shell", msg: "shell.turn.inference_failed", ctx: { kind: "rate_limited", status_code: 429,
  message: "API error (status 429 Too Many Requests): subscription:free-usage-exhausted: You've used all the included free usage for model grok-4.7 for now. Usage resets over a rolling 24-hour window — tokens (actual/limit): 674276/600000." } });
fs.writeFileSync(path.join(grokHome, "logs", "unified.jsonl"), hit + "\n");
j = out(run());
assert.equal(j.plan, "SuperGrok");
assert.equal(j.limits[0].cap, true); assert.equal(j.limits[0].percent, 1);
assert.match(j.limits[0].title, /grok-4\.7/);
assert.equal(j.status, "Not signed in — run `grok login`.", "the wall is shown even before sign-in");

// 3. An expired login kicks `grok models` once; with no grok on PATH the kick
//    fails and the status says so. A second run inside the 10-minute cooldown
//    must not kick again: the kick file stays byte-identical.
fs.writeFileSync(path.join(grokHome, "auth.json"), JSON.stringify({ entry: { key: "tok", expires_at: "2020-01-01T00:00:00Z" } }));
j = out(run());
assert.equal(j.status, "Sign-in expired and Grok couldn't refresh it — run `grok login`.");
const kickFile = path.join(xdg, "omarchy", "agent-usage-tabs", "grok-kick.json");
assert.ok(fs.existsSync(kickFile), "the kick attempt is remembered");
const kickBytes = fs.readFileSync(kickFile, "utf8");
j = out(run());
assert.equal(j.status, "Sign-in expired and Grok couldn't refresh it — run `grok login`.");
assert.equal(fs.readFileSync(kickFile, "utf8"), kickBytes, "cooled down: no second kick");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("grok: all tests passed");
