import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { grokWall } from "./grok-wall.mjs";
import { grokWalls } from "./grok-account-walls.mjs";

// Second deep pass over the Grok collector, complementary to grok-deep.test.mjs
// (which covers grokWall/grokWalls happy-path edges, plan/auth shapes, the kick
// cooldown, the 4 MiB log tail and a collect.mjs run). This file covers what is
// left: corrupt-but-parseable inputs, wrong JSON types, env-var fallbacks,
// fetch failures including the 10 s abort, kick-state edge cases, and the
// concurrent-caller race on the kick file. Everything runs against a scratch
// HOME/XDG; the billing endpoint is stubbed via NODE_OPTIONS=--import so no
// test touches the network or the real home.

const here = path.dirname(fileURLToPath(import.meta.url));
const grokScript = path.join(here, "grok.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-dotdeep-"));
const stubBin = path.join(tmp, "stub-bin");
fs.mkdirSync(stubBin, { recursive: true });

// A `grok` CLI stub: appends "kick" to a per-fixture marker and prints a model
// list (the same answer live-models wants).
const grokStub = (marker) => {
  fs.writeFileSync(path.join(stubBin, "grok"),
    `#!/bin/sh\n${marker ? `echo kick >> "${marker}"\n` : ""}echo "Available models:"; echo "  * grok-4.7 (default)"\n`);
  fs.chmodSync(path.join(stubBin, "grok"), 0o755);
};

// Fetch stub: hands out spec.calls in order (last one repeats). Supports
// {status, body, raw} like grok-deep's stub plus {hang:true}, which never
// resolves on its own — only rejects when grok.mjs's AbortSignal.timeout(10s)
// fires, exercising the timeout path. Logs url/auth/hasSignal per request.
const fetchStubPath = path.join(tmp, "fetch-stub.mjs");
fs.writeFileSync(fetchStubPath, `
import fs from "node:fs";
const spec = JSON.parse(fs.readFileSync(process.env.GROK_FETCH_SPEC, "utf8"));
let n = 0;
globalThis.fetch = (url, opts) => {
  fs.appendFileSync(process.env.GROK_FETCH_LOG, JSON.stringify({
    url: String(url), auth: opts?.headers?.Authorization || "",
    signal: opts?.signal instanceof AbortSignal,
  }) + "\\n");
  const c = spec.calls[Math.min(n++, spec.calls.length - 1)] || { status: 500 };
  if (c.hang) return new Promise((_, rej) => {
    // A real hung fetch holds a socket (a ref'd handle); a bare pending promise
    // would let the event loop drain and Node exit 13 before the abort fires.
    const t = setTimeout(() => {}, 120000);
    opts?.signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("fetch aborted")); });
  });
  return Promise.resolve({
    ok: c.status >= 200 && c.status < 300,
    status: c.status,
    json: async () => { if (c.raw !== undefined) throw new SyntaxError("Unexpected token"); return c.body; },
  });
};
`);
const FETCH_IMPORT = `--import=${pathToFileURL(fetchStubPath).href}`;

let homeSeq = 0;
const mkHome = ({ logsDir = true } = {}) => {
  const n = ++homeSeq;
  const home = path.join(tmp, `home${n}`);
  const grokHome = path.join(home, ".grok");
  const xdg = path.join(home, "xdg");
  fs.mkdirSync(grokHome, { recursive: true });
  if (logsDir) fs.mkdirSync(path.join(grokHome, "logs"), { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  return { home, grokHome, xdg };
};
const baseEnv = (h, extra = {}) => ({
  ...process.env,
  HOME: h.home,
  GROK_HOME: h.grokHome,
  XDG_STATE_HOME: h.xdg,
  XDG_CONFIG_HOME: path.join(h.home, "xdg-config"),
  XDG_CACHE_HOME: path.join(h.home, "xdg-cache"),
  PATH: stubBin,
  ...extra,
});
const runGrok = (h, extra = {}) => spawnSync(process.execPath, [grokScript], {
  encoding: "utf8", timeout: 60000, env: baseEnv(h, extra),
});
const runGrokAsync = (h, extra = {}) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [grokScript], { env: baseEnv(h, extra) });
  let stdout = "", stderr = "";
  p.stdout.on("data", (d) => { stdout += d; });
  p.stderr.on("data", (d) => { stderr += d; });
  p.on("error", reject);
  p.on("close", (code) => resolve({ status: code, stdout, stderr }));
});
const out = (r) => { assert.equal(r.status, 0, `grok.mjs failed: ${r.stderr}`); return JSON.parse(r.stdout); };
const writeJson = (p, v) => fs.writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v));
const settingsCache = (h, tier) => writeJson(path.join(h.grokHome, "settings_cache.json"),
  { payload: JSON.stringify({ settings: { subscription_tier_display: tier } }) });
const writeAuth = (h, v) => writeJson(path.join(h.grokHome, "auth.json"), v);
const writeLog = (h, text) => writeJson(path.join(h.grokHome, "logs", "unified.jsonl"), text);
const kickFile = (h) => path.join(h.xdg, "omarchy", "agent-usage-tabs", "grok-kick.json");
const kickDir = (h) => path.dirname(kickFile(h));
const FRESH_AUTH = { a: { key: "tok-dotdeep", expires_at: "2099-01-01T00:00:00Z" } };
const EXPIRED_AUTH = { a: { key: "tok-old", expires_at: "2020-01-01T00:00:00Z" } };

// Fetch-stub plumbing shared by every billing-path test (kept at top level so
// later sections can use it too). The spec/log paths live inside each fixture
// home so parallel-ish fixtures never share state.
const specPath = (h) => path.join(h.home, "fetch-spec.json");
const logPath = (h) => path.join(h.home, "fetch-log.jsonl");
const fetchEnv = (h) => ({
  NODE_OPTIONS: FETCH_IMPORT,
  GROK_FETCH_SPEC: specPath(h),
  GROK_FETCH_LOG: logPath(h),
});
const billing = (extra = {}) => ({ config: { currentPeriod: { type: "WEEKLY", end: "2026-12-01T00:00:00Z" }, creditUsagePercent: 45, isUnifiedBillingUser: false, ...extra } });
const fetchRun = (h, calls, extraEnv = {}) => {
  fs.writeFileSync(specPath(h), JSON.stringify({ calls }));
  fs.writeFileSync(logPath(h), "");
  return out(runGrok(h, { ...fetchEnv(h), ...extraEnv }));
};
const fetchLog = (h) => fs.readFileSync(logPath(h), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);

const iso = (ms) => new Date(ms).toISOString();
const wallLine = (ts, model = "grok-4.7", actual = 674276, limit = 600000) => JSON.stringify({
  ts, src: "shell", msg: "shell.turn.inference_failed",
  ctx: { kind: "rate_limited", status_code: 429,
    message: `API error (status 429 Too Many Requests): subscription:free-usage-exhausted: You've used all the included free usage for model ${model} for now. Usage resets over a rolling 24-hour window — tokens (actual/limit): ${actual}/${limit}.` },
});
const doneLine = (ts, prompt = 0, cached = 0, completion = 0) => JSON.stringify({
  ts, src: "shell", msg: "shell.turn.inference_done",
  ctx: { prompt_tokens: prompt, cached_prompt_tokens: cached, completion_tokens: completion },
});

// ===================================== 1. grokWall: inputs grok-deep didn't hit
{
  const now = Date.parse("2026-11-24T12:00:00Z");

  // Non-string logText is String()ed: null/undefined/0/{}/[] all become text
  // with no "inference_" lines. With the default free=true that is still a
  // 0% estimate row, NOT null — only paid/no-wall returns null.
  for (const bad of [null, undefined, 0, {}, [], true]) {
    const w = grokWall(bad, now);
    assert.equal(w?.cap, true, `grokWall(${JSON.stringify(bad)}) still returns a cap row when free`);
    assert.equal(w.percent, 0);
    assert.equal(w.resetsAt, "");
    assert.equal(grokWall(bad, now, { free: false }), null, `paid + ${JSON.stringify(bad)} -> null`);
  }
  // The `free` option is not boolean-normalized: explicit null/0/"" are falsy
  // and behave like a paid plan (no estimate without a hit); "no" is truthy.
  assert.equal(grokWall(null, now, { free: null }), null, "free:null is falsy -> paid behaviour");
  assert.equal(grokWall(null, now, { free: 0 }), null);
  assert.equal(grokWall(null, now, { free: "" }), null);
  assert.equal(grokWall(null, now, { free: "no" })?.cap, true, "any truthy free shows the estimate");

  // Negative cached_prompt_tokens SUBTRACTS a negative: the uncached part is
  // prompt - 0.75*cached, so a negative cache count inflates the weight past
  // the raw prompt size. No lower clamp on the cached term.
  assert.ok(Math.abs(
    grokWall(doneLine("2026-11-24T10:00:00Z", 100000, -40000, 0), now).percent - 130000 / 600000) < 1e-9,
    "negative cached tokens inflate the estimate");
  // Negative prompt_tokens clamps the uncached part at 0 via Math.max; only
  // completion_tokens still counts.
  assert.equal(grokWall(doneLine("2026-11-24T10:00:00Z", -5000, 0, 30000), now).percent, 30000 / 600000);
  // Non-numeric token fields: objects/arrays NaN out to 0; numeric strings work.
  assert.equal(grokWall(doneLine("2026-11-24T10:00:00Z", { val: 5 }, [1], "25000"), now).percent, 25000 / 600000);
  assert.equal(grokWall(doneLine("2026-11-24T10:00:00Z", "300000", 0, "0"), now).percent, 0.5);

  // A ctx-less inference_done still counts as a call (weight 0) and still
  // LIFTS a live wall: malformed lines are not exempt from the lift rule.
  const hit = wallLine("2026-11-24T10:00:00Z");
  const ctxlessDone = JSON.stringify({ ts: "2026-11-24T11:00:00Z", msg: "shell.turn.inference_done" });
  const liftedByEmpty = grokWall([hit, ctxlessDone].join("\n"), now);
  assert.equal(liftedByEmpty.percent, 0, "a done line with no ctx lifts the wall into a 0% estimate");
  assert.equal(liftedByEmpty.hitAt, undefined);
  // ...but a done call OLDER than the hit does not lift it.
  const olderDone = doneLine("2026-11-24T09:00:00Z", 1000);
  assert.equal(grokWall([hit, olderDone].join("\n"), now).percent, 1, "older call cannot lift the wall");
  // File order DOES matter for the lift: a done line written before the hit
  // is processed while wall is still null, so even a later ts cannot lift it.
  const earlyLine = doneLine("2026-11-24T11:30:00Z", 60000);
  assert.equal(grokWall([earlyLine, hit].join("\n"), now).percent, 1,
    "a done line before the hit in the file cannot lift it, whatever its ts");

  // ts must parse: a numeric epoch, a date-time without zone, and garbage are
  // all skipped. ("2026-11-24 10:00:00" parses in V8, so use clearly bad ones.)
  for (const badTs of [1767225600000, "not-a-date", "", null, {}]) {
    const line = JSON.stringify({ ts: badTs, msg: "shell.turn.inference_done", ctx: { prompt_tokens: 999999 } });
    assert.equal(grokWall(line, now).percent, 0, `ts=${JSON.stringify(badTs)} is skipped`);
  }
  // A JSON scalar containing "inference_" parses but has no .msg/.ts: skipped.
  assert.equal(grokWall('"just inference_ text"', now).percent, 0);
  assert.equal(grokWall("123", now).percent, 0, "a bare number line is ignored");
  // ctx.message of the wrong type never matches the wall regex.
  for (const m of [429, null, {}, ["x"]]) {
    const line = JSON.stringify({ ts: "2026-11-24T11:00:00Z", msg: "shell.turn.inference_failed", ctx: { message: m } });
    assert.equal(grokWall(line, now, { free: false }), null, `message=${JSON.stringify(m)} ignored`);
  }

  // Out-of-order hits: the LAST LINE wins, not the newest timestamp. A newer
  // hit written before an older one is completely shadowed — model, limit and
  // resetsAt all come from the older hit.
  const ooo = grokWall([
    wallLine("2026-11-24T11:00:00Z", "grok-new", 100, 600000),
    wallLine("2026-11-24T09:00:00Z", "grok-old", 50, 500000),
  ].join("\n"), now);
  assert.equal(ooo.title, "Free grok-old (24 h)");
  assert.equal(ooo.percent, 1);
  assert.equal(ooo.resetsAt, iso(Date.parse("2026-11-24T09:00:00Z") + 24 * 3600e3),
    "resetsAt follows the last line's ts, not the newest hit");
  // In file order the same two hits give the newer one — order is everything.
  const inOrder = grokWall([
    wallLine("2026-11-24T09:00:00Z", "grok-old", 50, 500000),
    wallLine("2026-11-24T11:00:00Z", "grok-new", 100, 600000),
  ].join("\n"), now);
  assert.equal(inOrder.title, "Free grok-new (24 h)");

  // A lifted wall keeps the hit's own limit as the estimate denominator.
  const customLimit = grokWall([
    wallLine("2026-11-24T09:00:00Z", "grok-4.6", 999999, 500000),
    doneLine("2026-11-24T11:00:00Z", 0, 0, 250000),
  ].join("\n"), now);
  assert.ok(Math.abs(customLimit.percent - 0.5) < 1e-9,
    `lifted wall with limit 500K: 250K used -> 0.5, got ${customLimit.percent}`);

  // k() formatting boundaries inside the note text.
  assert.match(grokWall(doneLine("2026-11-24T10:00:00Z", 999999), now).note, /About 1000K of 600K/,
    "999,999 rounds to 1000K, not 1.0M");
  assert.match(grokWall(doneLine("2026-11-24T10:00:00Z", 1000000), now).note, /About 1\.0M of 600K/);
  assert.match(grokWall(wallLine("2026-11-24T10:00:00Z", "grok-4.7", 674276, 600000), now).note,
    /674K of 600K/);
}

// ===================================== 2. grokWalls: shapes grok-deep skipped
{
  // registry itself null/undefined -> {}.
  assert.deepEqual(grokWalls(null), {});
  assert.deepEqual(grokWalls(undefined), {});
  // accounts as a string iterates characters (none have .id) -> {}, no throw.
  assert.deepEqual(grokWalls({ accounts: "xy" }), {});
  assert.deepEqual(grokWalls({ accounts: "" }), {});
  // ...but a non-iterable truthy still throws (already covered for {} and 5;
  // true/false behave the same way).
  assert.throws(() => grokWalls({ accounts: true }), TypeError);

  // Falsy ids are skipped even with a usable home.
  const seen = [];
  const r = grokWalls({ accounts: [
    { id: 0, home: "/h/zero" }, { id: "", home: "/h/empty" },
    { id: "ok", home: "/h/ok" },
  ] }, { run: (hh) => { seen.push(hh); return { limits: [] }; } });
  assert.deepEqual(r, {});
  assert.deepEqual(seen, ["/h/ok"], "id 0 and empty-string ids are skipped");

  // No run() injected: every account is probed with nothing -> no walls.
  assert.deepEqual(grokWalls({ accounts: [{ id: "a", home: "/h/a" }] }), {});

  // "~x" (tilde NOT followed by a slash) still gets homeDir prepended:
  // "~x" -> "/h" + "x" = "/hx", not a literal "~x".
  const tilde = [];
  grokWalls({ accounts: [{ id: "t", home: "~x" }] }, { homeDir: "/h", run: (hh) => { tilde.push(hh); return { limits: [] }; } });
  assert.deepEqual(tilde, ["/hx"], "tilde expansion is a bare prefix replace");

  // primaryHome is NOT tilde-expanded: "~/g" resolves against the process cwd,
  // so it never matches an account home that WAS expanded with homeDir.
  const prim = [];
  grokWalls({ accounts: [{ id: "p", home: "~/g" }] },
    { homeDir: "/h", primaryHome: "~/g", run: (hh) => { prim.push(hh); return { limits: [] }; } });
  assert.deepEqual(prim, ["/h/g"], "unexpanded primaryHome fails to match the expanded account home");

  // run() may return the same limits array for several accounts; the filter
  // produces fresh arrays, so later mutation of one result can't alias.
  const shared = [{ cap: true, title: "t" }];
  const walls2 = grokWalls({ accounts: [{ id: "a", home: "/h/a" }, { id: "b", home: "/h/b" }] },
    { run: () => ({ limits: shared }) });
  assert.equal(walls2.a.length, 1);
  assert.equal(walls2.b.length, 1);
  assert.notEqual(walls2.a, walls2.b, "each account gets its own filtered array");
}

// ============================ 3. grok.mjs: env fallbacks and weird files
{
  // GROK_HOME unset or empty -> $HOME/.grok is used instead. Expired auth keeps
  // the run off the network: the lapsed status proves the fallback auth.json
  // was read (signed-out would say otherwise).
  for (const [name, val] of [["unset", undefined], ["empty", ""]]) {
    const h = mkHome();
    const env = { ...baseEnv(h) };
    if (val === undefined) delete env.GROK_HOME; else env.GROK_HOME = val;
    // Auth now lives in HOME/.grok, not the GROK_HOME we created.
    const realHome = path.join(h.home, ".grok");
    fs.mkdirSync(path.join(realHome, "logs"), { recursive: true });
    writeJson(path.join(realHome, "auth.json"), EXPIRED_AUTH);
    const r = spawnSync(process.execPath, [grokScript], { encoding: "utf8", timeout: 30000, env });
    const j = out(r);
    assert.equal(j.status, "Sign-in expired and Grok couldn't refresh it — run `grok login`.",
      `GROK_HOME ${name}: the $HOME/.grok fallback auth is read`);
  }

  // XDG_STATE_HOME unset -> the kick file lands under $HOME/.local/state.
  {
    const h = mkHome();
    const marker = path.join(h.home, "kicks");
    grokStub(marker);
    writeAuth(h, EXPIRED_AUTH);
    const env = { ...baseEnv(h) };
    delete env.XDG_STATE_HOME;
    const r = spawnSync(process.execPath, [grokScript], { encoding: "utf8", timeout: 30000, env });
    const j = out(r);
    assert.equal(j.status, "Sign-in expired and Grok couldn't refresh it — run `grok login`.");
    assert.equal(fs.readFileSync(marker, "utf8").trim(), "kick", "kick ran via PATH stub");
    const fallbackKick = path.join(h.home, ".local", "state", "omarchy", "agent-usage-tabs", "grok-kick.json");
    assert.ok(fs.existsSync(fallbackKick), "kick state fell back to ~/.local/state");
  }

  // PATH_ENV appends ~/.local/bin and /usr/bin: a `grok` stub that exists ONLY
  // in $HOME/.local/bin is still found even when PATH points nowhere.
  {
    const h = mkHome();
    const marker = path.join(h.home, "kicks");
    const localBin = path.join(h.home, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(path.join(localBin, "grok"), `#!/bin/sh\necho kick >> "${marker}"\n`);
    fs.chmodSync(path.join(localBin, "grok"), 0o755);
    fs.rmSync(path.join(stubBin, "grok"), { force: true }); // no stub on PATH at all
    writeAuth(h, EXPIRED_AUTH);
    const r = runGrok(h, { PATH: "/nonexistent" });
    const j = out(r);
    assert.equal(j.status, "Sign-in expired and Grok couldn't refresh it — run `grok login`.");
    assert.equal(fs.readFileSync(marker, "utf8").trim(), "kick",
      "kick found grok in ~/.local/bin despite PATH=/nonexistent");
  }

  // GROK_HOME pointing at a plain FILE: every read fails -> signed out, no crash.
  {
    const h = mkHome();
    const fileHome = path.join(h.home, "grok-is-a-file");
    fs.writeFileSync(fileHome, "not a dir");
    const env = { ...baseEnv(h), GROK_HOME: fileHome };
    const r = spawnSync(process.execPath, [grokScript], { encoding: "utf8", timeout: 30000, env });
    assert.equal(out(r).status, "Not signed in — run `grok login`.");
  }

  // Directories where files are expected: settings_cache, auth.json and
  // unified.jsonl each degrade to "no data" rather than crashing.
  {
    const h = mkHome();
    fs.mkdirSync(path.join(h.grokHome, "settings_cache.json"));
    fs.mkdirSync(path.join(h.grokHome, "auth.json"));
    fs.rmSync(path.join(h.grokHome, "logs", "unified.jsonl"), { force: true });
    fs.mkdirSync(path.join(h.grokHome, "logs", "unified.jsonl"));
    const j = out(runGrok(h));
    assert.equal(j.plan, "", "settings_cache as a directory -> no plan");
    assert.equal(j.status, "Not signed in — run `grok login`.");
    assert.deepEqual(j.limits, [], "log as a directory -> no wall row");
  }
  // Missing logs/ dir entirely -> same as an empty log.
  {
    const h = mkHome({ logsDir: false });
    settingsCache(h, "Free");
    const j = out(runGrok(h));
    assert.equal(j.limits[0]?.cap, true, "no logs dir + Free plan -> 0% estimate row");
    assert.equal(j.limits[0].percent, 0);
  }
}

// ==================== 4. grok.mjs: auth expiry edge cases (the noted gap)
// grok-deep.test.mjs flagged but did not exercise: a MISSING expires_at parses
// to NaN, isFresh treats NaN as "no known expiry" -> fresh -> the collector
// reaches fetch with whatever key is there. Corrupt expiry strings do the same.
{
  // Missing expires_at -> NaN -> fresh -> billing proceeds; NO kick is
  // attempted (fresh path returns before touching kick state).
  for (const [name, entry] of [
    ["expires_at absent", { key: "tok-noexp" }],
    ["expires_at garbage", { key: "tok-garbage", expires_at: "not-a-date" }],
    ["expires_at empty string", { key: "tok-empty", expires_at: "" }],
    ["expires_at numeric", { key: "tok-num", expires_at: 1767225600000 }],
    ["expires_at null", { key: "tok-null", expires_at: null }],
  ]) {
    const h = mkHome();
    writeAuth(h, { a: entry });
    settingsCache(h, "SuperGrok");
    const j = fetchRun(h, [{ status: 200, body: billing() }]);
    assert.equal(j.limits[0]?.title, "Weekly", `expiry case: ${name} reaches fetch`);
    assert.equal(fetchLog(h)[0].auth, `Bearer ${entry.key}`, `expiry case: ${name} sends its key`);
    assert.ok(!fs.existsSync(kickFile(h)), `expiry case: ${name} never kicks (looks fresh)`);
  }

  // The 2-minute margin as a clock edge, end to end: an expiry 90 s out is
  // inside the margin -> lapsed -> kick; 200 s out is fresh -> fetch.
  {
    const h = mkHome();
    writeAuth(h, { a: { key: "tok-soon", expires_at: new Date(Date.now() + 90e3).toISOString() } });
    const marker = path.join(h.home, "kicks");
    grokStub(marker);
    const j = out(runGrok(h));
    assert.equal(j.status, "Sign-in expired and Grok couldn't refresh it — run `grok login`.",
      "expiry inside the 2-minute margin counts as lapsed");
    assert.equal(fs.readFileSync(marker, "utf8").trim(), "kick");
  }
  {
    const h = mkHome();
    writeAuth(h, { a: { key: "tok-later", expires_at: new Date(Date.now() + 200e3).toISOString() } });
    settingsCache(h, "SuperGrok");
    const j = fetchRun(h, [{ status: 200, body: billing() }]);
    assert.equal(j.limits[0]?.title, "Weekly", "expiry beyond the margin is fresh");
    assert.ok(!fs.existsSync(kickFile(h)), "fresh margin-side token never kicks");
  }

  // auth.json top-level primitives and weird entry shapes.
  for (const [name, auth, want] of [
    ["json null", "null", "Not signed in — run `grok login`."],
    ["json number", "42", "Not signed in — run `grok login`."],
    ["json string", '"just a string"', "Not signed in — run `grok login`."],
    ["json bool", "true", "Not signed in — run `grok login`."],
    ["fresh but key null", { a: { key: null, expires_at: "2099-01-01T00:00:00Z" } }, "Not signed in — run `grok login`."],
    ["fresh but key 0", { a: { key: 0, expires_at: "2099-01-01T00:00:00Z" } }, "Not signed in — run `grok login`."],
    ["fresh but key false", { a: { key: false, expires_at: "2099-01-01T00:00:00Z" } }, "Not signed in — run `grok login`."],
    ["fresh but key empty", { a: { key: "", expires_at: "2099-01-01T00:00:00Z" } }, "Not signed in — run `grok login`."],
  ]) {
    const h = mkHome();
    writeAuth(h, auth);
    assert.equal(out(runGrok(h)).status, want, `auth case: ${name}`);
  }

  // A non-string key is String()ed: an object key becomes "[object Object]"
  // and is sent as the bearer token. Quirky but harmless — the server decides.
  {
    const h = mkHome();
    writeAuth(h, { a: { key: { nested: 1 }, expires_at: "2099-01-01T00:00:00Z" } });
    settingsCache(h, "SuperGrok");
    const j = fetchRun(h, [{ status: 200, body: billing() }]);
    assert.equal(j.limits[0]?.title, "Weekly");
    assert.equal(fetchLog(h)[0].auth, "Bearer [object Object]");
  }

  // First object-valued entry wins even when a LATER entry is fresh: an
  // expired first entry dooms the run to the kick/lapsed path.
  {
    const h = mkHome();
    writeAuth(h, {
      a: { key: "tok-first-expired", expires_at: "2020-01-01T00:00:00Z" },
      b: { key: "tok-second-fresh", expires_at: "2099-01-01T00:00:00Z" },
    });
    const marker = path.join(h.home, "kicks");
    grokStub(marker);
    const j = out(runGrok(h));
    assert.equal(j.status, "Sign-in expired and Grok couldn't refresh it — run `grok login`.",
      "the fresher second entry is never considered");
    assert.equal(fs.readFileSync(marker, "utf8").trim(), "kick");
    assert.ok(!fs.existsSync(path.join(h.home, "fetch-log.jsonl")), "fetch never ran");
  }

  // Corrupt expiry + a refused token: NaN expiry looks fresh, the dead token
  // is sent, the server says 401 -> "sign-in refused", NOT the lapsed status.
  {
    const h = mkHome();
    writeAuth(h, { a: { key: "tok-dead", expires_at: "garbage" } });
    settingsCache(h, "SuperGrok");
    const j = fetchRun(h, [{ status: 401, body: {} }]);
    assert.equal(j.status, "Grok sign-in refused — run `grok login`.");
    assert.ok(!fs.existsSync(kickFile(h)), "a refused-but-fresh-looking token never kicks");
  }

  // Every request carries an AbortSignal (the 10 s timeout wiring).
  {
    const h = mkHome();
    writeAuth(h, FRESH_AUTH);
    settingsCache(h, "SuperGrok");
    fetchRun(h, [{ status: 200, body: billing({ isUnifiedBillingUser: true }) },
      { status: 200, body: { config: { monthlyLimit: 100, used: 10, billingPeriodEnd: "2026-12-05T00:00:00Z" } } }]);
    for (const c of fetchLog(h)) assert.equal(c.signal, true, "fetch called with an AbortSignal");
  }

  // Exact URLs: credits format first, plain billing second for unified users.
  {
    const h = mkHome();
    writeAuth(h, FRESH_AUTH);
    settingsCache(h, "SuperGrok");
    fetchRun(h, [
      { status: 200, body: billing({ isUnifiedBillingUser: true }) },
      { status: 200, body: { config: { monthlyLimit: 100, used: 10, billingPeriodEnd: "2026-12-05T00:00:00Z" } } },
    ]);
    const calls = fetchLog(h);
    assert.equal(calls[0].url, "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
    assert.equal(calls[1].url, "https://cli-chat-proxy.grok.com/v1/billing");
  }

  // Response bodies of the wrong JSON type all collapse to the calm status.
  for (const [name, call] of [
    ["body null", { status: 200, body: null }],
    ["body string", { status: 200, body: "nope" }],
    ["body number", { status: 200, body: 42 }],
    ["body array", { status: 200, body: [] }],
    ["body missing", { status: 200 }],
    ["body true", { status: 200, body: true }],
  ]) {
    const h = mkHome();
    writeAuth(h, FRESH_AUTH);
    settingsCache(h, "SuperGrok");
    const j = fetchRun(h, [call]);
    assert.equal(j.status, "Grok limits unavailable right now.", `billing case: ${name}`);
    assert.deepEqual(j.limits, []);
  }

  // The 10-second AbortSignal.timeout path: fetch hangs forever, the signal
  // fires, grok.mjs reports the calm unavailable status. Slow by design (~10 s).
  {
    const h = mkHome();
    writeAuth(h, FRESH_AUTH);
    settingsCache(h, "SuperGrok");
    const t0 = Date.now();
    const j = fetchRun(h, [{ hang: true }]);
    assert.equal(j.status, "Grok limits unavailable right now.", "hung fetch -> timeout -> calm status");
    assert.ok(Date.now() - t0 >= 9000, "the run really waited for the abort");
    assert.deepEqual(j.limits, []);
  }

  // A live wall clears the "no limit windows" status: billing succeeds but
  // reports no windows, the wall row still leads and status is "".
  {
    const h = mkHome();
    writeAuth(h, FRESH_AUTH);
    settingsCache(h, "SuperGrok");
    writeLog(h, wallLine(iso(Date.now() - 3600e3)));
    const noWindows = { config: { isUnifiedBillingUser: false } }; // no currentPeriod, no percent
    const j = fetchRun(h, [{ status: 200, body: noWindows }]);
    // currentPeriod missing -> the billing block throws -> unavailable status,
    // BUT the wall was already prepended... check what actually happens:
    // out() is only reached via the catch, which calls out({plan,status}) —
    // the wall is still prepended there. So status stays the failure line.
    assert.equal(j.limits[0]?.cap, true, "wall survives even a billing crash");
    assert.equal(j.limits[0].percent, 1);
    assert.equal(j.status, "Grok limits unavailable right now.");
  }
  {
    // Same but billing genuinely reports zero windows (percent absent, period present).
    const h = mkHome();
    writeAuth(h, FRESH_AUTH);
    settingsCache(h, "SuperGrok");
    writeLog(h, wallLine(iso(Date.now() - 3600e3)));
    const j = fetchRun(h, [{ status: 200, body: { config: { currentPeriod: { type: "MONTHLY", end: "2026-12-01T00:00:00Z" }, isUnifiedBillingUser: false } } }]);
    assert.equal(j.limits[0]?.cap, true);
    assert.equal(j.status, "", "wall + zero billing windows -> the 'no limit windows' status is cleared");
  }
}

// ==================== 5. kick-state edges and the concurrent race
{
  const markerFor = (h) => path.join(h.home, "kicks");
  const kickCount = (h) => fs.existsSync(markerFor(h)) ? fs.readFileSync(markerFor(h), "utf8").trim().split("\n").filter(Boolean).length : 0;

  // Cooldown boundary through the real file: ~10 min ago kicks again, ~9 min
  // 59 s ago does not. 1 s margins keep this deterministic.
  {
    const h = mkHome();
    grokStub(markerFor(h));
    writeAuth(h, EXPIRED_AUTH);
    fs.mkdirSync(kickDir(h), { recursive: true });
    fs.writeFileSync(kickFile(h), JSON.stringify({ at: Date.now() - 601e3 }));
    out(runGrok(h));
    assert.equal(kickCount(h), 1, "kick file older than 10 min -> kicks again");
  }
  {
    const h = mkHome();
    grokStub(markerFor(h));
    writeAuth(h, EXPIRED_AUTH);
    fs.mkdirSync(kickDir(h), { recursive: true });
    fs.writeFileSync(kickFile(h), JSON.stringify({ at: Date.now() - 599e3 }));
    out(runGrok(h));
    assert.equal(kickCount(h), 0, "kick file inside 10 min -> cooled down, no kick");
  }

  // at:null / at:"junk" / missing at all -> Number(x)||0 -> epoch -> kicks.
  for (const [name, content] of [
    ["at null", '{"at":null}'],
    ["at junk string", '{"at":"junk"}'],
    ["at missing", '{"other":1}'],
    ["bare array", "[1,2,3]"],
    ["bare number", "12345"],
  ]) {
    const h = mkHome();
    grokStub(markerFor(h));
    writeAuth(h, EXPIRED_AUTH);
    fs.mkdirSync(kickDir(h), { recursive: true });
    fs.writeFileSync(kickFile(h), content);
    out(runGrok(h));
    assert.equal(kickCount(h), 1, `kick file ${name} -> treated as never kicked`);
  }
  // at as a numeric STRING of a recent time still cools down (Number() parses it).
  {
    const h = mkHome();
    grokStub(markerFor(h));
    writeAuth(h, EXPIRED_AUTH);
    fs.mkdirSync(kickDir(h), { recursive: true });
    fs.writeFileSync(kickFile(h), JSON.stringify({ at: String(Date.now()) }));
    out(runGrok(h));
    assert.equal(kickCount(h), 0, "numeric-string at still counts as a recent kick");
  }

  // The kick file is a DIRECTORY: get() fails -> 0 -> kick runs; set() fails to
  // write -> caught -> nothing persists -> the NEXT run kicks again. The 10-min
  // cooldown silently disables itself when the state file can't be written.
  {
    const h = mkHome();
    grokStub(markerFor(h));
    writeAuth(h, EXPIRED_AUTH);
    fs.mkdirSync(kickFile(h), { recursive: true }); // a directory where the file should be
    let j = out(runGrok(h));
    assert.equal(j.status, "Sign-in expired and Grok couldn't refresh it — run `grok login`.");
    j = out(runGrok(h));
    assert.equal(kickCount(h), 2, "unwritable kick state -> cooldown never engages, kicks every run");
  }

  // The real race: two collector processes start together with an expired
  // login and no kick file. resolveLogin does state.set(now) BEFORE kick(),
  // so a second process that reads the file after the first writes sees the
  // cooldown; one that reads before sees nothing and kicks too. Both exits
  // are clean either way — kicks is 1 or 2 depending on timing.
  {
    const h = mkHome();
    grokStub(markerFor(h));
    writeAuth(h, EXPIRED_AUTH);
    const [r1, r2] = await Promise.all([runGrokAsync(h), runGrokAsync(h)]);
    for (const [i, r] of [r1, r2].entries()) {
      assert.equal(r.status, 0, `concurrent run ${i} exited cleanly: ${r.stderr}`);
      const j = JSON.parse(r.stdout);
      assert.equal(j.status, "Sign-in expired and Grok couldn't refresh it — run `grok login`.");
    }
    const kicks = kickCount(h);
    assert.ok(kicks >= 1 && kicks <= 2, `concurrent kicks bounded by process count, got ${kicks}`);
  }

  // Stale state across runs is only the kick file: a fresh login goes straight
  // to fetch and never creates kick state at all.
  {
    const h = mkHome();
    grokStub(markerFor(h));
    writeAuth(h, FRESH_AUTH);
    settingsCache(h, "SuperGrok");
    const j = fetchRun(h, [{ status: 200, body: billing() }]);
    assert.equal(j.limits[0]?.title, "Weekly");
    assert.ok(!fs.existsSync(kickFile(h)), "fresh login never writes kick state");
    assert.equal(kickCount(h), 0);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("grok.deep: all tests passed");
