import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { grokWall } from "./grok-wall.mjs";
import { grokWalls } from "./grok-account-walls.mjs";

// Deeper edge-case pass over the Grok collector. grok.test.mjs / grok-wall.test.mjs /
// grok-account-walls.test.mjs cover the happy paths; this file covers malformed
// input, boundary values and the parts of grok.mjs only reachable as a subprocess.
// Everything runs against scratch dirs: fake HOME/XDG, a stub `grok` on PATH for
// the login kick, and — for the billing endpoint — a fetch stub injected with
// NODE_OPTIONS=--import so no test ever touches the network or the real home.

const here = path.dirname(fileURLToPath(import.meta.url));
const grokScript = path.join(here, "grok.mjs");
const collectScript = path.join(here, "collect.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-deep-"));
const stubBin = path.join(tmp, "stub-bin");
fs.mkdirSync(stubBin, { recursive: true });

// A `grok` CLI stub: answers `models` for live-models, and can be told to "kick"
// by appending to a marker file (KICK_MARKER is baked in per fixture).
const grokStub = (marker) => {
  fs.writeFileSync(path.join(stubBin, "grok"),
    `#!/bin/sh\nif [ -n "${marker || ""}" ]; then echo kick >> "${marker}"; fi\necho "Available models:"; echo "  * grok-4.7 (default)"\n`);
  fs.chmodSync(path.join(stubBin, "grok"), 0o755);
};

// Fetch stub loaded via NODE_OPTIONS=--import. Reads a spec file describing the
// responses to hand out (in order, last one repeats) and appends every request
// to a log file so tests can assert which URLs were hit and with which token.
const fetchStubPath = path.join(tmp, "fetch-stub.mjs");
fs.writeFileSync(fetchStubPath, `
import fs from "node:fs";
const spec = JSON.parse(fs.readFileSync(process.env.GROK_FETCH_SPEC, "utf8"));
let n = 0;
globalThis.fetch = async (url, opts) => {
  fs.appendFileSync(process.env.GROK_FETCH_LOG, JSON.stringify({ url: String(url), auth: opts?.headers?.Authorization || "" }) + "\\n");
  const c = spec.calls[Math.min(n++, spec.calls.length - 1)] || { status: 500 };
  return {
    ok: c.status >= 200 && c.status < 300,
    status: c.status,
    json: async () => { if (c.raw !== undefined) throw new SyntaxError("Unexpected token"); return c.body; },
  };
};
`);
const FETCH_IMPORT = `--import=${pathToFileURL(fetchStubPath).href}`;

// ---------------------------------------------------------------- grok.mjs fixtures
let homeSeq = 0;
const mkHome = () => {
  const n = ++homeSeq;
  const home = path.join(tmp, `home${n}`);
  const grokHome = path.join(home, ".grok");
  const xdg = path.join(home, "xdg");
  fs.mkdirSync(path.join(grokHome, "logs"), { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  return { home, grokHome, xdg };
};
const baseEnv = (h, extra = {}) => ({
  ...process.env,
  HOME: h.home,
  GROK_HOME: h.grokHome,
  XDG_STATE_HOME: h.xdg,
  PATH: stubBin,
  ...extra,
});
const runGrok = (h, extra = {}) => spawnSync(process.execPath, [grokScript], {
  encoding: "utf8", timeout: 30000, env: baseEnv(h, extra),
});
const out = (r) => { assert.equal(r.status, 0, `grok.mjs failed: ${r.stderr}`); return JSON.parse(r.stdout); };
const writeJson = (p, v) => fs.writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v));
const settingsCache = (h, tier) => writeJson(path.join(h.grokHome, "settings_cache.json"),
  { payload: JSON.stringify({ settings: { subscription_tier_display: tier } }) });
const writeAuth = (h, v) => writeJson(path.join(h.grokHome, "auth.json"), v);
const FRESH_AUTH = { a: { key: "tok-deep", expires_at: "2099-01-01T00:00:00Z" } };
const EXPIRED_AUTH = { a: { key: "tok-old", expires_at: "2020-01-01T00:00:00Z" } };
const writeLog = (h, text) => writeJson(path.join(h.grokHome, "logs", "unified.jsonl"), text);

const iso = (ms) => new Date(ms).toISOString();
const wallLine = (ts, msg, model = "grok-4.7", actual = 674276, limit = 600000) => JSON.stringify({
  ts, src: "shell", msg: "shell.turn.inference_failed",
  ctx: { kind: "rate_limited", status_code: 429,
    message: `API error (status 429 Too Many Requests): subscription:free-usage-exhausted: You've used all the included free usage for model ${model} for now. Usage resets over a rolling 24-hour window — tokens (actual/limit): ${actual}/${limit}.` },
});
const doneLine = (ts, prompt = 0, cached = 0, completion = 0) => JSON.stringify({
  ts, src: "shell", msg: "shell.turn.inference_done",
  ctx: { prompt_tokens: prompt, cached_prompt_tokens: cached, completion_tokens: completion },
});

// ============================================================ 1. grokWall unit edges
// (grok-wall.test.mjs covers the main hit/estimate/lift paths already.)
{
  const now = Date.parse("2026-11-24T12:00:00Z");
  const DAY = 24 * 3600 * 1000;

  // Malformed and partial lines never throw and never count.
  const junk = ["not json", '{"ts":"bad"}', '{"msg":"shell.turn.inference_done"}', // no ts
    '{"ts":"2026-11-24T10:00:00Z","msg":"shell.turn.inference_done","ctx":{"prompt_tokens":60000}}', // the one valid line
    '{"ts":"garbage","msg":"shell.turn.inference_done","ctx":{"prompt_tokens":999999}}',
    '{"ts":"2026-11-24T10:00:00Z","msg":"shell.turn.other","ctx":{"prompt_tokens":999999}}',
    '{"ts":"2026-11-24T10:00:00Z","msg":"unrelated"}',
  ].join("\n");
  const wj = grokWall(junk, now);
  assert.equal(wj.percent, 0.1, "only the one line with a usable ts/msg/counts");

  // A JSON line that parses but lacks "inference_" is skipped before parsing cost matters;
  // a done line always contains it, so this is just a guard on the filter.
  assert.equal(grokWall('{"ts":"2026-11-24T10:00:00Z","msg":"shell.turn.inference_done","ctx":{"prompt_tokens":300000}}', now).percent, 0.5);

  // Weight edges: null/undefined tokens count as 0; numeric strings count; cached
  // input above prompt input clamps the uncached part at 0; a NEGATIVE completion
  // token count is not clamped and can push percent below 0 (quirk: no lower bound).
  const wt = grokWall([
    doneLine("2026-11-24T10:00:00Z", null, undefined, null),
    doneLine("2026-11-24T10:01:00Z", "300000", "0", "0"),
    doneLine("2026-11-24T10:02:00Z", 100, 1000, 50000),   // cached > prompt -> weight = 50000
    doneLine("2026-11-24T10:03:00Z", 0, 0, -700000),      // negative completion
  ].join("\n"), now);
  // weight = 0 + 300000 + 50000 - 700000 = -350000 -> percent -350000/600000
  assert.ok(wt.percent < 0, `negative token counts leak a negative percent (current behaviour): ${wt.percent}`);
  assert.equal(grokWall(doneLine("2026-11-24T10:00:00Z", 0, 0, -700000), now).percent, -700000 / 600000);

  // Window boundaries are strict on the left, inclusive on the right: a call
  // exactly 24 h old is already out; a call exactly at `now` still counts; a
  // future-dated call never counts.
  const edge = grokWall([
    doneLine(iso(now - DAY), 600000),        // ts == from -> excluded (strict >)
    doneLine(iso(now - DAY + 1), 300000),    // inside
    doneLine(iso(now), 60000),               // ts == to -> included (<=)
    doneLine(iso(now + 60000), 999999),      // future -> excluded
  ].join("\n"), now);
  assert.equal(edge.percent, (300000 + 60000) / 600000);

  // Hit boundaries: at exactly wall.ts + 24 h the hit is forgotten; one ms before
  // it still shows 100%.
  const hitTs = "2026-11-23T12:00:00Z";
  const hit = wallLine(hitTs);
  assert.equal(grokWall(hit, Date.parse(hitTs) + DAY).hitAt, undefined, "hit forgotten exactly at +24 h");
  assert.equal(grokWall(hit, Date.parse(hitTs) + DAY - 1).percent, 1, "still a wall 1 ms before +24 h");
  // A hit timestamped in the future (clock skew) still reports as a wall.
  assert.equal(grokWall(hit, Date.parse(hitTs) - 3600e3).percent, 1);

  // A hit with limit 0 fails the `wall.limit > 0` check and falls through to the
  // estimate path, which then uses the DEFAULT limit but keeps the hit's model.
  const zeroLimit = grokWall(wallLine("2026-11-24T10:00:00Z", undefined, "grok-4.6", 100, 0), now);
  assert.equal(zeroLimit.percent, 0);
  assert.equal(zeroLimit.title, "Free grok-4.6 (24 h)", "estimate keeps the wall's model name");
  assert.equal(zeroLimit.hitAt, undefined);

  // free:false suppresses the estimate only when NO hit was ever seen. Once a hit
  // exists in the log, lastWall stays set forever and a paid plan keeps getting
  // an estimate row (quirk: historical hits are never forgotten for paid plans).
  const oldHit = wallLine(iso(now - 2 * DAY));
  assert.equal(grokWall(doneLine("2026-11-24T10:00:00Z", 300000), now, { free: false }), null, "paid, no hit ever: nothing");
  const paidAfterHit = grokWall([doneLine("2026-11-24T10:00:00Z", 300000), oldHit].join("\n"), now, { free: false });
  assert.equal(paidAfterHit.percent, 0.5, "paid plan still gets the estimate once any hit exists");
  // ...but a CURRENT hit reports 100% even on a paid plan (the hit check runs first).
  const paidHit = grokWall(wallLine("2026-11-24T11:00:00Z"), now, { free: false });
  assert.equal(paidHit.percent, 1);

  // A done call lifts the wall only when strictly newer; equal timestamps don't.
  const ts = "2026-11-24T11:00:00Z";
  const sameTs = grokWall([wallLine(ts), doneLine(ts, 1000)].join("\n"), now);
  assert.equal(sameTs.percent, 1, "a call at the same instant does not lift the wall");
  const lifted = grokWall([wallLine(ts), doneLine("2026-11-24T11:00:00.001Z", 1000)].join("\n"), now);
  assert.equal(lifted.percent, (1000) / 600000, "a later call lifts it into the estimate");

  // Several hits: the LAST one wins for model, limit and wall state.
  const twoHits = grokWall([
    wallLine("2026-11-24T09:00:00Z", undefined, "grok-4.6", 100, 500000),
    wallLine("2026-11-24T11:00:00Z", undefined, "grok-4.7-fast", 800000, 700000),
  ].join("\n"), now);
  assert.equal(twoHits.title, "Free grok-4.7-fast (24 h)");
  assert.equal(twoHits.percent, 1);
  assert.equal(twoHits.resetsAt, iso(Date.parse("2026-11-24T11:00:00Z") + DAY));

  // A hit whose message lacks the tokens clause, or a non-429 failure, is ignored.
  const noTokens = JSON.stringify({ ts: "2026-11-24T11:00:00Z", msg: "shell.turn.inference_failed",
    ctx: { message: "subscription:free-usage-exhausted: used all included free usage for model grok-4.7" } });
  assert.equal(grokWall(noTokens, now).percent, 0);
  const otherErr = JSON.stringify({ ts: "2026-11-24T11:00:00Z", msg: "shell.turn.inference_failed",
    ctx: { message: "connection reset by peer" } });
  assert.equal(grokWall(otherErr, now).percent, 0);

  // The post-hit correction ratio is clamped to [0.5, 2]: Grok's count vs the
  // log's own sum can disagree wildly.
  const mkLifted = (actual) => grokWall([
    doneLine("2026-11-24T08:00:00Z", 100000),
    wallLine("2026-11-24T09:00:00Z", undefined, "grok-4.7", actual, 600000),
    doneLine("2026-11-24T11:00:00Z", 100000),
  ].join("\n"), now).percent;
  // raw before hit = 100000. actual/raw: 10000/100000=0.1 -> clamp 0.5; used=(100k+100k)*0.5=100k -> /600k
  assert.ok(Math.abs(mkLifted(10000) - 100000 / 600000) < 1e-9, "ratio clamped at 0.5");
  // 1e6/100000=10 -> clamp 2; used=400k -> /600k
  assert.ok(Math.abs(mkLifted(1000000) - 400000 / 600000) < 1e-9, "ratio clamped at 2");
  // raw = 0 (no calls before the hit) -> ratio stays 1.
  const noRaw = grokWall([
    wallLine("2026-11-24T09:00:00Z", undefined, "grok-4.7", 999999, 600000),
    doneLine("2026-11-24T11:00:00Z", 300000),
  ].join("\n"), now).percent;
  assert.equal(noRaw, 0.5, "no pre-hit calls -> ratio 1, estimate = 300K/600K");

  // Estimate percent is capped just below full; a hit is the only way to 100%.
  assert.equal(grokWall(doneLine("2026-11-24T10:00:00Z", 9e6), now).percent, 0.99);
  assert.equal(grokWall(doneLine("2026-11-24T10:00:00Z", 0, 0, 0), now).percent, 0);
}

// ============================================================ 2. grokWalls unit edges
{
  const cap = { title: "Free grok-4.7 (24 h)", cap: true, percent: 1 };

  // Degenerate registries.
  assert.deepEqual(grokWalls({}, { run: () => ({ limits: [cap] }) }), {});
  assert.deepEqual(grokWalls({ accounts: null }, { run: () => ({ limits: [cap] }) }), {});
  // accounts present but not iterable: current behaviour is a TypeError, which
  // would take down the whole collect run — flagged, not fixed (task rule).
  assert.throws(() => grokWalls({ accounts: {} }, { run: () => ({ limits: [cap] }) }), TypeError);
  assert.throws(() => grokWalls({ accounts: 5 }, { run: () => ({ limits: [cap] }) }), TypeError);

  // Entries without id or without any home are skipped; empty-string homes too.
  const seen = [];
  const reg = { accounts: [
    null, 42, {}, { id: "noid-home" }, { id: "empty", home: "" }, { id: "ok", home: "/h/ok" },
  ] };
  assert.deepEqual(grokWalls(reg, { run: (h) => { seen.push(h); return { limits: [] }; } }), {});
  assert.deepEqual(seen, ["/h/ok"]);

  // cap must be STRICTLY true: truthy lookalikes (1, "true") are billing rows, not walls.
  const mixed = { accounts: [{ id: "a", home: "/h/a" }] };
  const walls = grokWalls(mixed, { run: () => ({ limits: [{ cap: true }, { cap: 1 }, { cap: "true" }, { cap: true, title: "t" }, null] }) });
  assert.equal(walls.a.length, 2);

  // run() returning null / malformed limits: null limits -> no walls; a non-array
  // truthy limits value currently throws inside .filter (same fragility as above).
  assert.deepEqual(grokWalls(mixed, { run: () => null }), {});
  assert.deepEqual(grokWalls(mixed, { run: () => ({ limits: null }) }), {});
  assert.throws(() => grokWalls(mixed, { run: () => ({ limits: "nope" }) }), TypeError);
  assert.throws(() => grokWalls(mixed, { run: () => { throw new Error("boom"); } }), /boom/);

  // login wins over home when both are set; ~ expands against homeDir (empty
  // homeDir leaves a leading-slash path); non-string homes are String()ed.
  const prefs = { accounts: [
    { id: "both", home: "/h/home", login: "/h/login" },
    { id: "tilde", home: "~/.grok-x" },
    { id: "num", home: 42 },
    { id: "emptylogin", home: "/h/fb", login: "" },
  ] };
  const got = [];
  grokWalls(prefs, { homeDir: "/home/u", run: (h) => { got.push(h); return { limits: [cap] }; } });
  assert.deepEqual(got, ["/h/login", "/home/u/.grok-x", "42", "/h/fb"]);
  // ~ with no homeDir at all: "~/x" -> "/x".
  grokWalls({ accounts: [{ id: "t", home: "~/x" }] }, { run: (h) => { assert.equal(h, "/x"); return { limits: [cap] }; } });

  // Duplicate ids: the later entry overwrites the earlier one's walls.
  const dup = { accounts: [{ id: "d", home: "/h/1" }, { id: "d", home: "/h/2" }] };
  const order = [];
  grokWalls(dup, { run: (h) => { order.push(h); return { limits: [{ cap: true, title: h }] }; } });
  assert.deepEqual(order, ["/h/1", "/h/2"], "both homes are still probed");

  // primaryHome is compared after path.resolve: different spellings of the same
  // dir still count as the seated account; a relative primaryHome resolves
  // against the process cwd.
  const spellings = { accounts: [{ id: "p", home: "/h/./.grok" }, { id: "q", home: path.resolve("sub")} ] };
  const seen2 = [];
  grokWalls(spellings, { primaryHome: "/h/.grok", run: (h) => { seen2.push(h); return { limits: [cap] }; } });
  assert.deepEqual(seen2, [path.resolve("sub")], '"/h/./.grok" resolves onto the primary and is skipped');
  const seen3 = [];
  grokWalls({ accounts: [{ id: "r", home: path.resolve("sub") }] }, { primaryHome: "sub", run: (h) => { seen3.push(h); return { limits: [] }; } });
  assert.deepEqual(seen3, [], "relative primaryHome resolves against cwd too");
}

// ============================================ 3. grok.mjs: plan, auth, kick, log tail
{
  // --- settings_cache.json plan parsing (signed out, so no fetch is ever reached)
  const planCases = [
    ["missing file", null, ""],
    ["malformed json", "{oops", ""],
    ["payload not json", { payload: "not-json{" }, ""],
    ["payload without settings", { payload: "{}" }, ""],
    ["settings without tier", { payload: JSON.stringify({ settings: {} }) }, ""],
    ["null tier", { payload: JSON.stringify({ settings: { subscription_tier_display: null } }) }, ""],
    ["SuperGrok", { payload: JSON.stringify({ settings: { subscription_tier_display: "SuperGrok" } }) }, "SuperGrok"],
    ["numeric tier", { payload: JSON.stringify({ settings: { subscription_tier_display: 123 } }) }, 123],
  ];
  for (const [name, file, want] of planCases) {
    const h = mkHome();
    if (file !== null) writeJson(path.join(h.grokHome, "settings_cache.json"), file);
    const j = out(runGrok(h));
    assert.equal(j.plan, want, `plan case: ${name}`);
    if (name === "numeric tier") assert.equal(typeof j.plan, "number", "a numeric tier is emitted as a number, not a string");
  }

  // Plan name drives grokWall's `free` flag via /free/i — including a quirk:
  // the regex is a substring match, so "not-free" counts as free.
  const planWall = (tier) => {
    const h = mkHome();
    if (tier !== undefined) settingsCache(h, tier);
    return out(runGrok(h));
  };
  let j = planWall("Free");
  assert.equal(j.plan, "Free");
  assert.equal(j.limits[0]?.cap, true, "Free plan + empty log -> 0% cap estimate row");
  assert.equal(j.limits[0].percent, 0);
  assert.equal(j.limits[0].title, "Free grok-4.7 (24 h)", "default model when the log has no hit");
  assert.equal(j.limits[0].resetsAt, "", "estimate rows never carry a reset time");
  j = planWall("SuperGrok");
  assert.deepEqual(j.limits, [], "paid plan + empty log + no hit -> no cap row at all");
  j = planWall("not-free");
  assert.equal(j.limits[0]?.cap, true, "quirk: /free/i matches 'not-free' -> estimate row shown");
  j = planWall(undefined);
  assert.deepEqual(j.limits, [], "no plan -> /free/i fails -> no cap row");
  // The signed-out status survives alongside the cap row.
  assert.equal(j.status, "Not signed in — run `grok login`.");
  j = planWall("Free");
  assert.equal(j.status, "Not signed in — run `grok login`.");

  // --- auth.json shapes (all stop before fetch: missing/empty access or lapsed)
  const authCases = [
    ["malformed", "{nope", "Not signed in — run `grok login`."],
    ["top-level string entry only", { a: "just-a-string" }, "Not signed in — run `grok login`."],
    ["entry without key", { a: { expires_at: "2020-01-01T00:00:00Z" } }, "Not signed in — run `grok login`."],
    ["array entry has no key", { a: [{ key: "k", expires_at: "2020-01-01T00:00:00Z" }] }, "Not signed in — run `grok login`."],
    ["expired, numeric key", { a: { key: 123, expires_at: "2020-01-01T00:00:00Z" } }, "Sign-in expired and Grok couldn't refresh it — run `grok login`."],
    ["top-level array", [{ key: "k", expires_at: "2020-01-01T00:00:00Z" }], "Sign-in expired and Grok couldn't refresh it — run `grok login`."],
    // Object.values().find(object) picks the FIRST object-valued entry — here "a",
    // which has no key, so the run reports signed-out even though "b" looks usable.
    ["first object entry wins", { s: "x", a: { expires_at: "2020-01-01T00:00:00Z" }, b: { key: "k", expires_at: "2020-01-01T00:00:00Z" } }, "Not signed in — run `grok login`."],
  ];
  for (const [name, auth, wantStatus] of authCases) {
    const h = mkHome();
    writeAuth(h, auth);
    const j2 = out(runGrok(h));
    assert.equal(j2.status, wantStatus, `auth case: ${name}`);
  }
  // No auth.json at all.
  {
    const h = mkHome();
    assert.equal(out(runGrok(h)).status, "Not signed in — run `grok login`.");
  }
  // Missing expires_at parses to NaN -> treated as fresh -> would reach fetch.
  // Not exercised here (no network); noted for the record.

  // --- the `grok models` kick: cooldown file and marker
  {
    const h = mkHome();
    const marker = path.join(h.home, "kicks");
    grokStub(marker);
    writeAuth(h, EXPIRED_AUTH);
    // Pre-seeded FUTURE kick timestamp -> cooled down, no kick at all.
    const kickDir = path.join(h.xdg, "omarchy", "agent-usage-tabs");
    fs.mkdirSync(kickDir, { recursive: true });
    fs.writeFileSync(path.join(kickDir, "grok-kick.json"), JSON.stringify({ at: Date.now() + 3600e3 }));
    let j3 = out(runGrok(h));
    assert.equal(j3.status, "Sign-in expired and Grok couldn't refresh it — run `grok login`.");
    assert.ok(!fs.existsSync(marker), "future kick timestamp -> cooled down, grok never ran");

    // Garbage kick file -> treated as never kicked -> kick happens once, then
    // a second run inside 10 min does not kick again.
    const h2 = mkHome();
    const marker2 = path.join(h2.home, "kicks");
    grokStub(marker2);
    writeAuth(h2, EXPIRED_AUTH);
    const kickDir2 = path.join(h2.xdg, "omarchy", "agent-usage-tabs");
    fs.mkdirSync(kickDir2, { recursive: true });
    fs.writeFileSync(path.join(kickDir2, "grok-kick.json"), "{garbage");
    j3 = out(runGrok(h2));
    assert.equal(j3.status, "Sign-in expired and Grok couldn't refresh it — run `grok login`.");
    assert.equal(fs.readFileSync(marker2, "utf8").trim().split("\n").length, 1, "first run kicked once");
    const kickBytes = fs.readFileSync(path.join(kickDir2, "grok-kick.json"), "utf8");
    j3 = out(runGrok(h2));
    assert.equal(fs.readFileSync(marker2, "utf8").trim().split("\n").length, 1, "cooldown: no second kick");
    assert.equal(fs.readFileSync(path.join(kickDir2, "grok-kick.json"), "utf8"), kickBytes);

    // A kick that DOES refresh the token proceeds to fetch — with the fetch stub
    // below this is exercised; here just confirm the stub refresh path reaches
    // the billing call by checking the kick ran and auth was re-read.
  }

  // --- unified.jsonl tail: the 4 MiB readLogTail window
  {
    const h = mkHome();
    settingsCache(h, "SuperGrok"); // paid plan: no hit -> no cap row at all
    const filler = "x".repeat(4_300_000);
    // Hit first, then filler: the hit falls outside the last-4MiB tail.
    writeLog(h, wallLine(iso(Date.now() - 3600e3)) + "\n" + filler);
    let j4 = out(runGrok(h));
    assert.deepEqual(j4.limits, [], "a hit older than the 4 MiB tail is invisible");
    // Same bytes, hit last: inside the tail -> wall reported.
    writeLog(h, filler + "\n" + wallLine(iso(Date.now() - 3600e3)));
    j4 = out(runGrok(h));
    assert.equal(j4.limits[0]?.cap, true, "a hit inside the tail leads the limits");
    assert.equal(j4.limits[0].percent, 1);

    // A wall hit ~25 h ago is forgotten (>24 h) even though it is in the tail.
    const h5 = mkHome();
    settingsCache(h5, "Free");
    writeLog(h5, wallLine(iso(Date.now() - 25 * 3600e3)));
    const j5 = out(runGrok(h5));
    assert.equal(j5.limits[0]?.cap, true, "forgotten hit -> estimate row, not a wall");
    assert.equal(j5.limits[0].percent, 0, "no calls in window -> 0%");
    assert.equal(j5.limits[0].hitAt, undefined);

    // ~23 h ago: still a live wall.
    const h6 = mkHome();
    settingsCache(h6, "SuperGrok");
    writeLog(h6, wallLine(iso(Date.now() - 23 * 3600e3)));
    const j6 = out(runGrok(h6));
    assert.equal(j6.limits[0]?.percent, 1);
    assert.ok(Date.parse(j6.limits[0].resetsAt) > Date.now(), "wall resetsAt is hit+24h, still in the future");

    // Junk lines around a real hit don't hide it; a later done call lifts it.
    const h7 = mkHome();
    settingsCache(h7, "Free");
    const hitTs = Date.now() - 3600e3;
    writeLog(h7, [
      "garbage line", '{"broken"', wallLine(iso(hitTs)),
      doneLine(iso(hitTs + 60e3), 300000),
    ].join("\n"));
    const j7 = out(runGrok(h7));
    assert.equal(j7.limits[0]?.cap, true);
    assert.equal(j7.limits[0].percent, 0.5, "lifted wall -> estimate of the post-hit call only");
    assert.equal(j7.limits[0].hitAt, undefined);

    // Multiple hits: the latest one's model/limit win.
    const h8 = mkHome();
    settingsCache(h8, "SuperGrok");
    writeLog(h8, [
      wallLine(iso(Date.now() - 7200e3), undefined, "grok-4.6", 100, 500000),
      wallLine(iso(Date.now() - 3600e3), undefined, "grok-4.7-fast", 800000, 700000),
    ].join("\n"));
    const j8 = out(runGrok(h8));
    assert.equal(j8.limits[0].title, "Free grok-4.7-fast (24 h)");
    assert.equal(j8.limits[0].percent, 1);

    // Token weight end-to-end through the collector (free plan, no hit):
    // 300K prompt uncached = 0.5; cached>prompt contributes only completion;
    // a future-dated call is excluded; a call exactly 24h+ old is excluded.
    const h9 = mkHome();
    settingsCache(h9, "Free");
    const t = Date.now();
    writeLog(h9, [
      doneLine(iso(t - 25 * 3600e3), 9e6),
      doneLine(iso(t - 3600e3), 300000, 0, 0),
      doneLine(iso(t - 3500e3), 100, 100000, 60000),
      doneLine(iso(t + 60000), 9e6),
    ].join("\n"));
    const j9 = out(runGrok(h9));
    assert.ok(Math.abs(j9.limits[0].percent - (300000 + 60000) / 600000) < 1e-9,
      `expected ${(300000 + 60000) / 600000}, got ${j9.limits[0].percent}`);
    assert.match(j9.limits[0].note, /estimated from Grok's log/);

    // A hit with limit 0 falls through to the estimate path (quirk covered in
    // unit tests; here just confirm the collector emits no 100% row for it).
    const h10 = mkHome();
    settingsCache(h10, "Free");
    writeLog(h10, wallLine(iso(Date.now() - 3600e3), undefined, "grok-4.6", 100, 0));
    const j10 = out(runGrok(h10));
    assert.notEqual(j10.limits[0]?.percent, 1);
    assert.equal(j10.limits[0]?.title, "Free grok-4.6 (24 h)");
  }
}

// ================================= 4. grok.mjs billing endpoint via fetch stub
{
  const specPath = (h) => path.join(h.home, "fetch-spec.json");
  const logPath = (h) => path.join(h.home, "fetch-log.jsonl");
  const fetchEnv = (h) => ({
    NODE_OPTIONS: FETCH_IMPORT,
    GROK_FETCH_SPEC: specPath(h),
    GROK_FETCH_LOG: logPath(h),
  });
  const billing = (currentPeriod, extra = {}) => ({ config: { currentPeriod, creditUsagePercent: 45.5, isUnifiedBillingUser: false, ...extra } });
  const mkBillingHome = (plan = "SuperGrok") => {
    const h = mkHome();
    writeAuth(h, FRESH_AUTH);
    if (plan !== null) settingsCache(h, plan);
    return h;
  };
  const fetchRun = (h, calls) => {
    fs.writeFileSync(specPath(h), JSON.stringify({ calls }));
    fs.writeFileSync(logPath(h), "");
    return out(runGrok(h, fetchEnv(h)));
  };
  const fetchLog = (h) => fs.readFileSync(logPath(h), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);

  // Happy path: weekly window, percent, resetsAt, single request, bearer token.
  {
    const h = mkBillingHome();
    const j = fetchRun(h, [{ status: 200, body: billing({ type: "WEEKLY", end: "2026-12-01T00:00:00Z" }) }]);
    assert.equal(j.status, "");
    assert.equal(j.limits.length, 1);
    assert.equal(j.limits[0].title, "Weekly");
    assert.equal(j.limits[0].percent, 0.455);
    assert.equal(j.limits[0].resetsAt, "2026-12-01T00:00:00.000Z");
    const calls = fetchLog(h);
    assert.equal(calls.length, 1, "not unified -> billing endpoint called once");
    assert.ok(calls[0].url.includes("format=credits"));
    assert.equal(calls[0].auth, "Bearer tok-deep");
  }

  // period.type -> title mapping, including quirks: the WEEK check is
  // case-sensitive and anything unrecognized falls back to "Monthly".
  for (const [type, want] of [["WEEKLY", "Weekly"], ["MONTHLY", "Monthly"], ["weekly", "Monthly"], ["ANNUAL", "Monthly"], [undefined, "Monthly"]]) {
    const h = mkBillingHome();
    const j = fetchRun(h, [{ status: 200, body: billing({ type, end: "2026-12-01T00:00:00Z" }) }]);
    assert.equal(j.limits[0]?.title, want, `type=${type}`);
  }

  // creditUsagePercent edges. `used !== undefined` gates the window: null is NOT
  // undefined, so null becomes a real 0% meter (quirk: null is not "no data").
  const pctCases = [
    [0, 0], [100, 1], [150, 1], [-5, 0], ["45", 0.45], [{ val: 50 }, 0.5], [null, 0],
  ];
  for (const [used, want] of pctCases) {
    const h = mkBillingHome();
    const j = fetchRun(h, [{ status: 200, body: billing({ type: "MONTHLY", end: "2026-12-01T00:00:00Z" }, { creditUsagePercent: used }) }]);
    assert.equal(j.limits[0]?.percent, want, `creditUsagePercent=${JSON.stringify(used)}`);
  }
  // Non-numeric percent throws inside num() and takes the WHOLE run down to the
  // generic unavailable status — one bad field loses every window (quirk).
  {
    const h = mkBillingHome();
    const j = fetchRun(h, [{ status: 200, body: billing({ type: "MONTHLY", end: "2026-12-01T00:00:00Z" }, { creditUsagePercent: "lots" }) }]);
    assert.equal(j.status, "Grok limits unavailable right now.");
    assert.deepEqual(j.limits, []);
  }
  // creditUsagePercent absent -> no window row at all.
  {
    const h = mkBillingHome();
    const body = { config: { currentPeriod: { type: "MONTHLY", end: "2026-12-01T00:00:00Z" }, isUnifiedBillingUser: false } };
    const j = fetchRun(h, [{ status: 200, body }]);
    assert.equal(j.status, "Grok reported no limit windows.");
    assert.deepEqual(j.limits, []);
  }

  // Malformed payloads and bad dates: each degrades the whole run to one calm line.
  const badBodies = [
    ["empty object", {}, "Grok limits unavailable right now."],
    ["no config", { config: null }, "Grok limits unavailable right now."],
    ["no currentPeriod", { config: { creditUsagePercent: 10 } }, "Grok limits unavailable right now."],
    ["unparseable end", { config: { currentPeriod: { type: "MONTHLY", end: "not-a-date" }, creditUsagePercent: 10 } }, "Grok limits unavailable right now."],
    ["missing end", { config: { currentPeriod: { type: "MONTHLY" }, creditUsagePercent: 10 } }, "Grok limits unavailable right now."],
    ["invalid json", { status: 200, raw: "<<<" }, "Grok limits unavailable right now."],
    ["http 500", { status: 500, body: {} }, "Grok limits unavailable right now."],
    ["http 429", { status: 429, body: {} }, "Grok limits unavailable right now."],
    ["http 404", { status: 404, body: {} }, "Grok limits unavailable right now."],
  ];
  for (const [name, call, want] of badBodies) {
    const h = mkBillingHome();
    const spec = call.status ? call : { status: 200, body: call };
    const j = fetchRun(h, [spec]);
    assert.equal(j.status, want, `billing case: ${name}`);
    assert.deepEqual(j.limits, [], `billing case: ${name}`);
    assert.equal(j.plan, "SuperGrok", "plan survives billing failures");
  }
  // Auth refusals get their own status.
  for (const status of [401, 403]) {
    const h = mkBillingHome();
    const j = fetchRun(h, [{ status, body: {} }]);
    assert.equal(j.status, "Grok sign-in refused — run `grok login`.", `HTTP ${status}`);
  }
  // A reset time in the past is emitted as-is: grok.mjs does no staleness check.
  {
    const h = mkBillingHome();
    const j = fetchRun(h, [{ status: 200, body: billing({ type: "MONTHLY", end: "2020-01-01T00:00:00Z" }) }]);
    assert.equal(j.limits[0].resetsAt, "2020-01-01T00:00:00.000Z", "past resetsAt passes through untouched");
  }

  // Unified billing: a second call adds the Monthly quota window.
  {
    const h = mkBillingHome();
    const j = fetchRun(h, [
      { status: 200, body: billing({ type: "WEEKLY", end: "2026-12-01T00:00:00Z" }, { isUnifiedBillingUser: true }) },
      { status: 200, body: { config: { monthlyLimit: 1000, used: 250, billingPeriodEnd: "2026-12-05T00:00:00Z" } } },
    ]);
    assert.equal(j.limits.length, 2);
    assert.equal(j.limits[1].title, "Monthly");
    assert.equal(j.limits[1].percent, 0.25);
    assert.equal(j.limits[1].resetsAt, "2026-12-05T00:00:00.000Z");
    const calls = fetchLog(h);
    assert.equal(calls.length, 2);
    assert.ok(!calls[1].url.includes("format=credits"), "second call hits the plain billing URL");
    assert.equal(calls[1].auth, "Bearer tok-deep");
  }
  // Unified quirks: the second call is fully wrapped in try/catch, so ANY failure
  // or bad field silently drops just the monthly row and keeps the first window.
  const unifiedSecond = [
    ["second call 500", { status: 500, body: {} }],
    ["second call invalid json", { status: 200, raw: "<<<" }],
    ["quota zero", { status: 200, body: { config: { monthlyLimit: 0, used: 5, billingPeriodEnd: "2026-12-05T00:00:00Z" } } }],
    ["quota negative", { status: 200, body: { config: { monthlyLimit: -10, used: 5, billingPeriodEnd: "2026-12-05T00:00:00Z" } } }],
    ["quota non-numeric", { status: 200, body: { config: { monthlyLimit: "lots", used: 5, billingPeriodEnd: "2026-12-05T00:00:00Z" } } }],
    ["bad period end", { status: 200, body: { config: { monthlyLimit: 100, used: 5, billingPeriodEnd: "junk" } } }],
    ["used over quota clamps", { status: 200, body: { config: { monthlyLimit: 100, used: 500, billingPeriodEnd: "2026-12-05T00:00:00Z" } } }],
  ];
  for (const [name, second] of unifiedSecond) {
    const h = mkBillingHome();
    const j = fetchRun(h, [
      { status: 200, body: billing({ type: "WEEKLY", end: "2026-12-01T00:00:00Z" }, { isUnifiedBillingUser: true }) },
      second,
    ]);
    assert.equal(j.status, "", `unified case: ${name} keeps the first window`);
    assert.equal(j.limits.length, name === "used over quota clamps" ? 2 : 1, `unified case: ${name}`);
    if (name === "used over quota clamps") assert.equal(j.limits[1].percent, 1);
  }
  // isUnifiedBillingUser must be strictly true: truthy lookalikes skip the 2nd call.
  for (const flag of ["yes", 1]) {
    const h = mkBillingHome();
    const j = fetchRun(h, [{ status: 200, body: billing({ type: "WEEKLY", end: "2026-12-01T00:00:00Z" }, { isUnifiedBillingUser: flag }) }]);
    assert.equal(fetchLog(h).length, 1, `isUnifiedBillingUser=${JSON.stringify(flag)} -> single call`);
    assert.equal(j.limits.length, 1);
  }

  // Wall row leads billing rows; plan name decides whether an empty log shows one.
  {
    const h = mkBillingHome("Free");
    const j = fetchRun(h, [{ status: 200, body: billing({ type: "WEEKLY", end: "2026-12-01T00:00:00Z" }) }]);
    assert.equal(j.limits[0].cap, true, "cap estimate row is prepended before billing windows");
    assert.equal(j.limits[1].title, "Weekly");
  }
  {
    const h = mkBillingHome("SuperGrok");
    writeLog(h, wallLine(iso(Date.now() - 3600e3)));
    const j = fetchRun(h, [{ status: 200, body: billing({ type: "WEEKLY", end: "2026-12-01T00:00:00Z" }) }]);
    assert.equal(j.limits[0].cap, true);
    assert.equal(j.limits[0].percent, 1, "a live wall reports 100% even on a paid plan");
    assert.equal(j.limits[1].title, "Weekly");
  }
  {
    // A kick that refreshes the token: expired auth + stub grok that rewrites
    // auth.json with a fresh token -> kicked once, then fetch proceeds.
    const h = mkHome();
    const marker = path.join(h.home, "kicks");
    const authPath = path.join(h.grokHome, "auth.json");
    fs.writeFileSync(path.join(stubBin, "grok"),
      `#!/bin/sh\necho kick >> "${marker}"\ncat > "${authPath}" <<'EOF'\n{"a":{"key":"tok-fresh","expires_at":"2099-01-01T00:00:00Z"}}\nEOF\n`);
    fs.chmodSync(path.join(stubBin, "grok"), 0o755);
    writeAuth(h, EXPIRED_AUTH);
    settingsCache(h, "SuperGrok");
    const j = fetchRun(h, [{ status: 200, body: billing({ type: "WEEKLY", end: "2026-12-01T00:00:00Z" }) }]);
    assert.equal(j.limits[0]?.title, "Weekly", "successful kick -> fresh token -> billing data");
    assert.equal(fs.readFileSync(marker, "utf8").trim(), "kick");
    // Restore the models-answering stub for later fixtures.
    grokStub("");
  }
}

// ============================== 5. collect.mjs: per-account walls end to end
// accountWalls is folded into agents[].accounts and deleted afterwards, and that
// only happens when `omarchy-agent-account-list --json` reports 2+ signed-in
// accounts for the provider. The real binary derives signedIn from credentials we
// must not touch, so it is stubbed (along with notify-send and
// omarchy-agent-usage-update) in the fixture PATH — same pattern as collect.test.mjs.
{
  const ctmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-deep-collect-"));
  const home = path.join(ctmp, "home");
  const xdg = path.join(ctmp, "xdg");
  const state = path.join(xdg, "omarchy");
  const outDir = path.join(state, "agent-usage-tabs");
  const binDir = path.join(ctmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(ctmp, "xdg-runtime"), { recursive: true });
  const stub = (name, body) => {
    const p = path.join(binDir, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(p, 0o755);
  };
  // `grok` on PATH so the tab counts as installed; it also answers `models`.
  stub("grok", "echo 'Available models:'; echo '  * grok-4.7 (default)'");
  stub("notify-send", "exit 0");
  stub("omarchy-agent-usage-update", "exit 0");
  // Two+ signed-in grok accounts so buildAccounts() emits the accounts array the
  // walls merge into. Omarchy's record carries no meters of its own here.
  stub("omarchy-agent-account-list", `cat <<'EOF'
[{"provider":"grok","name":"Grok","active":"main","threshold":95,"accounts":[
 {"id":"main","label":"Main","plan":"","primary":true,"home":"${path.join(home, ".grok")}","active":true,"signedIn":true,"limits":[]},
 {"id":"work","label":"Work","plan":"","home":"WORKHOME","active":false,"signedIn":true,"limits":[]},
 {"id":"idle","label":"Idle","plan":"","home":"IDLEHOME","active":false,"signedIn":true,"limits":[]}
]}]
EOF`);

  // Primary (seated) Grok home with a live wall for grok-4.7.
  const mainHome = path.join(home, ".grok");
  fs.mkdirSync(path.join(mainHome, "logs"), { recursive: true });
  fs.writeFileSync(path.join(mainHome, "logs", "unified.jsonl"), wallLine(iso(Date.now() - 3600e3), undefined, "grok-4.7") + "\n");
  // A second registered account home with its own wall for a different model.
  const workHome = path.join(ctmp, "accounts", "work");
  fs.mkdirSync(path.join(workHome, "logs"), { recursive: true });
  fs.writeFileSync(path.join(workHome, "logs", "unified.jsonl"), wallLine(iso(Date.now() - 1800e3), undefined, "grok-4.6", 100, 500000) + "\n");
  // A third account with no log at all: probed, but contributes no walls.
  const idleHome = path.join(ctmp, "accounts", "idle");
  fs.mkdirSync(idleHome, { recursive: true });
  // Point the stub's WORKHOME/IDLEHOME placeholders at the real dirs.
  const listPath = path.join(binDir, "omarchy-agent-account-list");
  fs.writeFileSync(listPath, fs.readFileSync(listPath, "utf8").replaceAll("WORKHOME", workHome).replaceAll("IDLEHOME", idleHome));
  fs.chmodSync(listPath, 0o755);
  // grokWalls reads Omarchy's registry directly for the per-home probe list.
  const acctDir = path.join(state, "agents", "accounts");
  fs.mkdirSync(acctDir, { recursive: true });
  fs.writeFileSync(path.join(acctDir, "grok.json"), JSON.stringify({ active: "main", accounts: [
    { id: "main", label: "Main", active: true, home: mainHome, login: mainHome },
    { id: "work", label: "Work", home: workHome },
    { id: "idle", label: "Idle", home: idleHome },
  ] }));
  fs.writeFileSync(path.join(outDir, "live-models.json"),
    JSON.stringify({ grok: { at: Date.now(), models: [{ id: "grok-4.7", name: "grok-4.7" }] } }));

  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: xdg,
    XDG_RUNTIME_DIR: path.join(ctmp, "xdg-runtime"),
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    GROK_HOME: mainHome,
    AGY_DIR: path.join(ctmp, "agy-home"),
    PATH: `${binDir}:/usr/bin:/bin`,
  };
  const r = spawnSync(process.execPath, [collectScript], { encoding: "utf8", env, timeout: 240000 });
  assert.equal(r.status, 0, `collect.mjs failed:\n${r.stderr}\n${r.stdout}`);
  const data = JSON.parse(fs.readFileSync(path.join(outDir, "data.json"), "utf8"));
  const grok = data.agents.find((a) => a.id === "grok");
  assert.ok(grok, "grok keeps its tab");
  assert.equal(grok.installed, true);
  assert.equal(grok.limits[0]?.cap, true, "primary wall leads the grok limits");
  assert.equal(grok.limits[0].title, "Free grok-4.7 (24 h)");
  assert.equal(grok.signedIn, false, "no auth.json anywhere -> signed out, walls still shown");

  // The walls surface per account: work's own log, the seated account pinned from
  // the primary run, and nothing for the account whose log is empty. The merge
  // keeps only title/percent/resetsAt (cap/hitAt/note are dropped there).
  const accts = Object.fromEntries((grok.accounts || []).map((a) => [a.id, a]));
  assert.ok(grok.accounts, "accounts array emitted for grok");
  assert.equal(accts.work?.limits?.[0]?.title, "Free grok-4.6 (24 h)", "work account's own wall");
  assert.equal(accts.work.limits[0].percent, 1);
  assert.equal(accts.main?.limits?.[0]?.title, "Free grok-4.7 (24 h)", "seated account pinned from primary run");
  assert.equal(accts.main.limits[0].percent, 1);
  assert.deepEqual(accts.idle?.limits, [], "account with no wall contributes no meters");
  for (const a of grok.accounts || [])
    for (const l of a.limits || [])
      assert.ok(Number(l.percent) >= 0 && Number(l.percent) <= 1, `${a.id}: merged meter percent in range`);

  fs.rmSync(ctmp, { recursive: true, force: true });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("grok-deep: all tests passed");
