// Deep edge-case pass for bin/agy.mjs on top of agy.test.mjs (which covers the
// three headline paths: signed out, expired token + failed kick, cooldown).
// This file exercises everything else that is only reachable as a subprocess:
// token-file and keyring payload shapes, expiry/margin boundaries, kick-state
// file corruption, plan-name and project-id extraction, every fetch error
// path, and the get-then-set race on the kick cooldown.
//
// No real credential, CLI or endpoint is touched: PATH holds only stubs
// (secret-tool, agy), globalThis.fetch is replaced by an --import preload that
// answers from a per-test spec file, and HOME/XDG_* point into a mkdtemp dir.
// NOTE: agy.mjs appends /usr/bin to PATH for the `agy models` kick, and real
// /usr/bin/agy + /usr/bin/secret-tool exist on this machine — the stubs below
// always win because stubBin is first on PATH (secret-tool is spawned with the
// plain PATH, the kick with PATH_ENV).
//
// Tests that pin down QUIRKS / SUSPECTED BUGS assert the current behaviour and
// say so in a comment; they are reported, not fixed (this job is test-only).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "agy.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-deep-"));

// Point every XDG/HOME lookup at the scratch dir, for this process and (via
// explicit env) every child.
const savedEnv = {};
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  savedEnv[k] = process.env[k];
  process.env[k] = path.join(tmp, k.toLowerCase());
  fs.mkdirSync(process.env[k], { recursive: true });
}

// ---------------------------------------------------------------- stubs
const stubBin = path.join(tmp, "stub-bin");
fs.mkdirSync(stubBin, { recursive: true });
const writeStub = (name, body) => {
  const p = path.join(stubBin, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, 0o755);
};
// secret-tool: env-driven. STUB_SECRET_STDOUT is printed verbatim, STUB_SECRET_SLEEP
// delays (to hit the 4 s spawnSync timeout), STUB_SECRET_EXIT sets the exit code
// (default 1 = "no entry"). agy.mjs ignores the exit code when stdout parses.
writeStub("secret-tool",
  `[ -n "$STUB_SECRET_SLEEP" ] && sleep "$STUB_SECRET_SLEEP"\n` +
  `if [ -n "$STUB_SECRET_STDOUT" ]; then printf '%s' "$STUB_SECRET_STDOUT"; fi\n` +
  `exit "\${STUB_SECRET_EXIT:-1}"`);
// agy: `agy models` is the login kick. STUB_AGY_MODE=refresh rewrites the token
// file in $AGY_DIR (inherited through the kick env); every invocation is logged.
writeStub("agy",
  `echo kick >> "$STUB_AGY_LOG"\n` +
  `if [ "$STUB_AGY_MODE" = "refresh" ]; then printf '%s' "$STUB_AGY_TOKEN" > "$AGY_DIR/antigravity-oauth-token"; fi\n` +
  `exit 0`);

// Fetch stub loaded via --import: replaces globalThis.fetch inside agy.mjs.
// Spec file (AGY_FETCH_SPEC) maps endpoint -> {body} | {raw} | {status} | {throw}
// | {badjson}; every request is logged to AGY_FETCH_LOG with its auth header.
const fetchStub = path.join(tmp, "fetch-stub.mjs");
fs.writeFileSync(fetchStub, `import fs from "node:fs";
const spec = JSON.parse(fs.readFileSync(process.env.AGY_FETCH_SPEC, "utf8"));
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ep = u.includes("loadCodeAssist") ? "assist" : u.includes("retrieveUserQuotaSummary") ? "quota" : "other";
  fs.appendFileSync(process.env.AGY_FETCH_LOG, JSON.stringify({
    ep, url: u, body: opts.body || "", auth: opts.headers?.Authorization || "",
  }) + "\\n");
  const c = spec[ep] || spec.other || { status: 500 };
  if (c.throw) throw new Error("network down");
  if (c.badjson) return new Response("this is not json{", { status: c.status || 200 });
  const payload = c.raw !== undefined ? c.raw : JSON.stringify(c.body ?? {});
  return new Response(payload, { status: c.status || 200 });
};
`);
const FETCH_ARGS = ["--import", pathToFileURL(fetchStub).href];

// Second preload for the concurrency test: when AGY_RACE_DIR is set, the first
// readFileSync of the kick file blocks on a two-process barrier so both
// collectors observe the same pre-kick state.
const slowStub = path.join(tmp, "slow-state.mjs");
fs.writeFileSync(slowStub, `import fs from "node:fs";
const origRead = fs.readFileSync;
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const barrier = (tag, n) => {
  fs.writeFileSync(process.env.AGY_RACE_DIR + "/" + tag + "-" + process.pid, "1");
  const deadline = Date.now() + 8000;
  for (;;) {
    const c = fs.readdirSync(process.env.AGY_RACE_DIR).filter((f) => f.startsWith(tag + "-")).length;
    if (c >= n || Date.now() > deadline) return;
    nap(10);
  }
};
fs.readFileSync = function (p, ...rest) {
  const s = String(p);
  if (!s.endsWith("agy-kick.json") || !process.env.AGY_RACE_DIR) return origRead.call(this, p, ...rest);
  // Two-phase barrier: both processes must have ARRIVED, then both must have
  // READ, before either get() returns — so neither can see the other's set().
  barrier("arrived", 2);
  let value, error;
  try { value = origRead.call(this, p, ...rest); } catch (e) { error = e; }
  barrier("readdone", 2);
  if (error) throw error;
  return value;
};
`);
const SLOW_ARGS = ["--import", pathToFileURL(slowStub).href];

// ---------------------------------------------------------------- fixtures
const DEFAULT_SPEC = {
  assist: { body: { cloudaicompanionProject: { id: "proj-9" }, paidTier: { id: "pro-tier", name: "Google AI Pro" } } },
  quota: { body: { groups: [{ displayName: "Gemini models", buckets: [{ bucketId: "g5h", window: "5-hour", remainingFraction: 0.5, resetTime: "2026-12-01T00:00:00Z" }] }] } },
};
const FUTURE = "2099-01-01T00:00:00Z";
const PAST = "2020-01-01T00:00:00Z";
const FRESH_TOKEN = { token: { access_token: "tok-deep", expiry: FUTURE } };
const EXPIRED_TOKEN = { token: { access_token: "tok-old", expiry: PAST } };

let seq = 0;
function fixture(name, opts = {}) {
  const n = ++seq;
  const dir = path.join(tmp, `f${String(n).padStart(2, "0")}-${name}`);
  const home = path.join(dir, "home");
  const agyDir = path.join(dir, "agy");
  const stateDir = path.join(dir, "state");
  const cfgDir = path.join(dir, "config");
  const cacheDir = path.join(dir, "cache");
  for (const d of [home, agyDir, stateDir, cfgDir, cacheDir]) fs.mkdirSync(d, { recursive: true });

  const tokenPath = path.join(agyDir, "antigravity-oauth-token");
  if (opts.tokenDir) fs.mkdirSync(tokenPath, { recursive: true });
  else if (opts.token !== undefined && opts.token !== null)
    fs.writeFileSync(tokenPath, typeof opts.token === "string" ? opts.token : JSON.stringify(opts.token));

  if (opts.kickAt !== undefined) {
    const kd = path.join(stateDir, "omarchy", "agent-usage-tabs");
    fs.mkdirSync(kd, { recursive: true });
    fs.writeFileSync(path.join(kd, "agy-kick.json"), typeof opts.kickAt === "string" ? opts.kickAt : JSON.stringify({ at: opts.kickAt }));
  }
  if (opts.kickRaw !== undefined) {
    const kd = path.join(stateDir, "omarchy", "agent-usage-tabs");
    fs.mkdirSync(kd, { recursive: true });
    fs.writeFileSync(path.join(kd, "agy-kick.json"), opts.kickRaw);
  }

  const specFile = path.join(dir, "fetch-spec.json");
  fs.writeFileSync(specFile, JSON.stringify({ ...DEFAULT_SPEC, ...(opts.spec || {}) }));
  const fetchLog = path.join(dir, "fetch.log");
  const kickLog = path.join(dir, "kicks.log");

  const env = (extra = {}) => ({
    ...process.env,
    HOME: home, XDG_STATE_HOME: stateDir, XDG_CONFIG_HOME: cfgDir, XDG_CACHE_HOME: cacheDir,
    PATH: stubBin, AGY_DIR: agyDir,
    AGY_FETCH_SPEC: specFile, AGY_FETCH_LOG: fetchLog,
    STUB_AGY_LOG: kickLog,
    ...extra,
  });
  const run = (extra, args = FETCH_ARGS) =>
    spawnSync(process.execPath, [...args, script], { encoding: "utf8", timeout: 30000, env: env(extra) });
  const out = (r) => { assert.equal(r.status, 0, `agy.mjs exited ${r.status}: ${r.stderr}`); return JSON.parse(r.stdout); };
  const fetchCalls = () => (fs.existsSync(fetchLog) ? fs.readFileSync(fetchLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
  const kicks = () => (fs.existsSync(kickLog) ? fs.readFileSync(kickLog, "utf8").trim().split("\n").filter(Boolean).length : 0);
  const kickFile = () => path.join(stateDir, "omarchy", "agent-usage-tabs", "agy-kick.json");
  return { dir, home, agyDir, stateDir, env, run, out, fetchCalls, kicks, kickFile, tokenPath };
}
const readJson = (f) => JSON.parse(fs.readFileSync(f.kickFile(), "utf8"));

try {
  // ================================================================ login: token file shapes
  {
    const f = fixture("signedout", {});
    const j = f.out(f.run());
    assert.equal(j.status, "Not signed in — run `agy` to log in.");
    assert.deepEqual(j.limits, []);
    assert.equal(j.plan, "");
    assert.equal(f.fetchCalls().length, 0, "no login -> fetch never happens");
  }
  for (const [name, raw] of [
    ["tok-badjson", "{not json"],
    ["tok-empty", ""],
    ["tok-null", "null"],
    ["tok-num", "42"],
    ["tok-str", '"just a string"'],
    ["tok-arr", "[1,2]"],
    ["tok-emptyobj", "{}"],
    ["tok-accessless", '{"token":{"expiry":"' + FUTURE + '"}}'],
  ]) {
    const f = fixture(name, { token: raw });
    const j = f.out(f.run());
    assert.equal(j.status, "Not signed in — run `agy` to log in.", `${name} -> ${JSON.stringify(j)}`);
    assert.equal(f.fetchCalls().length, 0);
  }
  {
    const f = fixture("tok-isdir", { tokenDir: true });
    const j = f.out(f.run());
    assert.equal(j.status, "Not signed in — run `agy` to log in.", "a directory where the token file should be");
  }

  // ---- token payload shapes that DO sign in
  {
    // Flat shape (no `token` wrapper): access_token/expiry at top level.
    const f = fixture("flat", { token: { access_token: "flat-tok", expiry: FUTURE } });
    const j = f.out(f.run());
    assert.equal(j.status, "");
    assert.equal(f.fetchCalls()[0].auth, "Bearer flat-tok");
  }
  {
    // `token` present but NOT an object -> the flat fields are used instead.
    const f = fixture("token-notobj", { token: { token: "not-an-object", access_token: "flat2", expiry: FUTURE } });
    const j = f.out(f.run());
    assert.equal(j.status, "");
    assert.equal(f.fetchCalls()[0].auth, "Bearer flat2", "a non-object `token` does not shadow flat fields");
  }
  {
    // QUIRK: an object `token` shadows ALL flat fields — a perfectly good flat
    // access_token is ignored because the wrapper has no access_token.
    const f = fixture("token-shadows", { token: { token: { expiry: FUTURE }, access_token: "flat3", expiry: FUTURE } });
    const j = f.out(f.run());
    assert.equal(j.status, "Not signed in — run `agy` to log in.", "QUIRK: {token:{...}} shadows flat access_token");
  }
  {
    // Same quirk with an array `token` (typeof [] === "object").
    const f = fixture("token-array", { token: { token: [], access_token: "flat4", expiry: FUTURE } });
    const j = f.out(f.run());
    assert.equal(j.status, "Not signed in — run `agy` to log in.", "QUIRK: token:[] also shadows flat fields");
  }
  {
    // expiry precedence: t.expiry || data.expiry — an empty-string inner expiry
    // falls through to the outer one.
    const f = fixture("expiry-fallthrough", { token: { token: { access_token: "tk", expiry: "" }, expiry: FUTURE } });
    const j = f.out(f.run());
    assert.equal(j.status, "", "empty inner expiry falls back to outer expiry");
    assert.equal(f.fetchCalls()[0].auth, "Bearer tk");
  }
  {
    // ...but a non-empty inner expiry wins even when it is the expired one.
    const f = fixture("expiry-innerwins", { token: { token: { access_token: "tk", expiry: PAST }, expiry: FUTURE } },
      { spec: { assist: { body: { cloudaicompanionProject: null } } } });
    // expired inner -> kick attempted; agy stub does not refresh -> lapsed status
    const j = f.out(f.run());
    assert.equal(j.status, "Sign-in expired and agy couldn't refresh it — run `agy` and sign in again.",
      "inner expiry wins over outer: token treated as expired");
    assert.equal(f.kicks(), 1);
  }
  {
    // QUIRK: a missing expiry parses to NaN, and NaN expiresMs means "fresh
    // forever" — the token never lapses and agy is never kicked.
    const f = fixture("no-expiry", { token: { access_token: "tk-noexpiry" } });
    const j = f.out(f.run());
    assert.equal(j.status, "");
    assert.equal(f.kicks(), 0, "QUIRK: no expiry field = never lapses");
    assert.equal(f.fetchCalls()[0].auth, "Bearer tk-noexpiry");
  }
  {
    // QUIRK: an unparseable expiry is also NaN -> fresh forever.
    const f = fixture("bad-expiry", { token: { access_token: "tk-badexp", expiry: "not-a-date" } });
    const j = f.out(f.run());
    assert.equal(j.status, "", "QUIRK: corrupt expiry still counts as fresh");
    assert.equal(f.kicks(), 0);
  }
  {
    // access_token is coerced with String(): a number becomes its digits...
    const f = fixture("access-num", { token: { access_token: 12345, expiry: FUTURE } });
    const j = f.out(f.run());
    assert.equal(j.status, "");
    assert.equal(f.fetchCalls()[0].auth, "Bearer 12345", "numeric access_token is stringified");
  }
  {
    // ...and an object becomes "[object Object]" — still truthy, still sent.
    const f = fixture("access-obj", { token: { access_token: { weird: true }, expiry: FUTURE } });
    const j = f.out(f.run());
    assert.equal(j.status, "");
    assert.equal(f.fetchCalls()[0].auth, "Bearer [object Object]", "QUIRK: object access_token stringifies to [object Object]");
  }

  // ================================================================ login: keyring (secret-tool) path
  {
    // A fresh keyring entry wins over an expired token file, and the exit code
    // is ignored — stdout that parses is used even on exit 1.
    const f = fixture("keyring-wins", {
      token: EXPIRED_TOKEN,
      spec: {},
    });
    // re-create with secret-tool env: run() extra env carries STUB_SECRET_*
    const j = f.out(f.run({
      STUB_SECRET_STDOUT: JSON.stringify({ token: { access_token: "keyring-tok", expiry: FUTURE } }),
      STUB_SECRET_EXIT: "1",
    }));
    assert.equal(j.status, "");
    assert.equal(f.fetchCalls()[0].auth, "Bearer keyring-tok", "keyring token beats the file; exit 1 ignored");
    assert.equal(f.kicks(), 0, "fresh keyring login never kicks agy");
  }
  {
    // Keyring JSON that does not parse falls through to the token file.
    const f = fixture("keyring-badjson", { token: FRESH_TOKEN });
    const j = f.out(f.run({ STUB_SECRET_STDOUT: "{oops", STUB_SECRET_EXIT: "0" }));
    assert.equal(j.status, "");
    assert.equal(f.fetchCalls()[0].auth, "Bearer tok-deep", "unparseable keyring output -> file login used");
  }
  {
    // Whitespace-only keyring output is falsy after trim -> file login.
    const f = fixture("keyring-spaces", { token: FRESH_TOKEN });
    const j = f.out(f.run({ STUB_SECRET_STDOUT: "   \n  ", STUB_SECRET_EXIT: "0" }));
    assert.equal(j.status, "");
    assert.equal(f.fetchCalls()[0].auth, "Bearer tok-deep");
  }
  {
    // Flat-shaped keyring JSON (no `token` wrapper) works too.
    const f = fixture("keyring-flat", {});
    const j = f.out(f.run({ STUB_SECRET_STDOUT: JSON.stringify({ access_token: "kr-flat", expiry: FUTURE }), STUB_SECRET_EXIT: "0" }));
    assert.equal(j.status, "");
    assert.equal(f.fetchCalls()[0].auth, "Bearer kr-flat");
  }
  {
    // secret-tool slower than the 4 s timeout is killed; the file login is used.
    const f = fixture("keyring-timeout", { token: FRESH_TOKEN });
    const t0 = Date.now();
    const j = f.out(f.run({ STUB_SECRET_SLEEP: "10", STUB_SECRET_EXIT: "0" }));
    assert.equal(j.status, "");
    assert.ok(Date.now() - t0 < 9000, "the 4 s spawnSync timeout fired");
    assert.equal(f.fetchCalls()[0].auth, "Bearer tok-deep");
  }
  {
    // secret-tool not on PATH at all (ENOENT) -> file login, no throw.
    const f = fixture("keyring-enoent", { token: FRESH_TOKEN });
    const emptyBin = path.join(tmp, "empty-bin");
    fs.mkdirSync(emptyBin, { recursive: true });
    // PATH has no secret-tool AND no agy; PATH_ENV still appends /usr/bin for
    // the kick, but the token is fresh so no kick happens anyway.
    const j = f.out(f.run({ PATH: emptyBin }));
    assert.equal(j.status, "");
    assert.equal(f.fetchCalls()[0].auth, "Bearer tok-deep");
  }

  // ================================================================ expiry boundaries (the 2-minute margin)
  {
    // Expires in 3 minutes: outside the margin -> fresh, fetch happens.
    const f = fixture("fresh-3min", { token: { access_token: "tk", expiry: new Date(Date.now() + 180e3).toISOString() } });
    const j = f.out(f.run());
    assert.equal(j.status, "");
    assert.equal(f.kicks(), 0);
  }
  {
    // Expires in 1 minute: inside the margin -> treated as lapsed, agy kicked,
    // kick fails to refresh -> the "couldn't refresh" status.
    const f = fixture("lapsed-1min", { token: { access_token: "tk", expiry: new Date(Date.now() + 60e3).toISOString() } });
    const j = f.out(f.run());
    assert.equal(j.status, "Sign-in expired and agy couldn't refresh it — run `agy` and sign in again.");
    assert.equal(f.kicks(), 1, "a token inside the 2-minute margin is kicked");
  }
  {
    // Kick succeeds: the agy stub rewrites the token file mid-run, the second
    // readLogin picks it up and the fetch uses the NEW token.
    const f = fixture("kick-refresh", { token: EXPIRED_TOKEN });
    const j = f.out(f.run({
      STUB_AGY_MODE: "refresh",
      STUB_AGY_TOKEN: JSON.stringify({ token: { access_token: "refreshed-tok", expiry: FUTURE } }),
    }));
    assert.equal(j.status, "");
    assert.equal(f.kicks(), 1);
    assert.equal(f.fetchCalls()[0].auth, "Bearer refreshed-tok", "post-kick re-read uses the refreshed token");
    assert.ok(fs.existsSync(f.kickFile()), "the kick is remembered in agy-kick.json");
    const at = readJson(f).at;
    assert.ok(Number.isFinite(at) && at > 0 && at <= Date.now() + 5000, "kick file holds a plausible timestamp");
  }
  {
    // Expired token, agy runs but changes nothing -> lapsed status, kick logged.
    const f = fixture("kick-norefresh", { token: EXPIRED_TOKEN });
    const j = f.out(f.run());
    assert.equal(j.status, "Sign-in expired and agy couldn't refresh it — run `agy` and sign in again.");
    assert.equal(f.kicks(), 1);
  }

  // ================================================================ kick-state file edge cases
  {
    // Cooldown active (kick timestamp = now): no second kick, same lapsed status.
    const f = fixture("cooldown-now", { token: EXPIRED_TOKEN, kickAt: Date.now() });
    const j = f.out(f.run());
    assert.equal(j.status, "Sign-in expired and agy couldn't refresh it — run `agy` and sign in again.");
    assert.equal(f.kicks(), 0, "inside the cooldown agy is not run again");
  }
  {
    // Kick timestamp in the future (clock skew): still counts as "just kicked".
    const f = fixture("cooldown-future", { token: EXPIRED_TOKEN, kickAt: Date.now() + 60000 });
    const j = f.out(f.run());
    assert.equal(j.status, "Sign-in expired and agy couldn't refresh it — run `agy` and sign in again.");
    assert.equal(f.kicks(), 0, "a future kick timestamp suppresses the kick");
  }
  {
    // Kick timestamp older than the 10-minute cooldown: kick happens again.
    const f = fixture("cooldown-old", { token: EXPIRED_TOKEN, kickAt: Date.now() - 700000 });
    const j = f.out(f.run());
    assert.equal(f.kicks(), 1, "past the cooldown agy is kicked again");
    assert.equal(j.status, "Sign-in expired and agy couldn't refresh it — run `agy` and sign in again.");
  }
  for (const [name, raw] of [
    ["kick-badjson", "{corrupt"],
    ["kick-empty", ""],
    ["kick-null", "null"],
    ["kick-num", "42"],
    ["kick-str", '"hello"'],
    ["kick-noat", '{"other":1}'],
    ["kick-atstr", '{"at":"junk"}'],
    ["kick-atnull", '{"at":null}'],
  ]) {
    const f = fixture(name, { token: EXPIRED_TOKEN, kickRaw: raw });
    const j = f.out(f.run());
    assert.equal(f.kicks(), 1, `${name}: unreadable kick state must not block the kick`);
    assert.equal(j.status, "Sign-in expired and agy couldn't refresh it — run `agy` and sign in again.");
  }
  {
    // The kick file path itself is a directory: get() fails -> 0, set() fails
    // silently, and the kick still runs (best effort, never an error).
    const f = fixture("kick-isdir", { token: EXPIRED_TOKEN });
    fs.mkdirSync(f.kickFile(), { recursive: true });
    const j = f.out(f.run());
    assert.equal(f.kicks(), 1, "a directory as kick file does not stop the kick");
    assert.equal(j.status, "Sign-in expired and agy couldn't refresh it — run `agy` and sign in again.");
  }
  {
    // XDG_STATE_HOME unset -> the kick file lands under ~/.local/state.
    const f = fixture("kick-default-xdg", { token: EXPIRED_TOKEN });
    const e = f.env();
    delete e.XDG_STATE_HOME;
    const r = spawnSync(process.execPath, [...FETCH_ARGS, script], { encoding: "utf8", timeout: 30000, env: e });
    const j = JSON.parse(r.stdout);
    assert.equal(j.status, "Sign-in expired and agy couldn't refresh it — run `agy` and sign in again.");
    const fallback = path.join(f.home, ".local", "state", "omarchy", "agent-usage-tabs", "agy-kick.json");
    assert.ok(fs.existsSync(fallback), "without XDG_STATE_HOME the kick file goes to ~/.local/state");
    assert.equal(fs.existsSync(f.kickFile()), false, "and not to the fixture's XDG dir");
  }

  // ================================================================ fetch: project id + plan extraction
  const quotaBody = (f) => f.fetchCalls().find((c) => c.ep === "quota")?.body;
  {
    // Object project -> its id is sent as {project}.
    const f = fixture("proj-object", { token: FRESH_TOKEN });
    f.out(f.run());
    assert.deepEqual(JSON.parse(quotaBody(f)), { project: "proj-9" });
  }
  for (const [name, project, expected] of [
    ["proj-string", "proj-str", { project: "proj-str" }],
    ["proj-emptyid", { id: "" }, {}],
    ["proj-noid", { name: "x" }, {}],
    ["proj-number", 42, {}],
    ["proj-array", [1], {}],
    ["proj-missing", undefined, {}],
    ["proj-blank", "   ", {}],
  ]) {
    const body = project === undefined ? {} : { cloudaicompanionProject: project };
    const f = fixture(name, { token: FRESH_TOKEN, spec: { assist: { body } } });
    f.out(f.run());
    assert.deepEqual(JSON.parse(quotaBody(f)), expected, `${name}: quota request body`);
  }
  for (const [name, assistBody, plan] of [
    ["plan-paidtier", { paidTier: { name: "Google AI Pro" }, currentTier: { name: "ignored" } }, "Pro"],
    ["plan-ultra-name", { paidTier: { name: "some ultra plan" } }, "Ultra"],
    ["plan-free-id", { paidTier: { id: "tier-free-9" } }, "Free"],
    ["plan-custom", { paidTier: { name: "Acme Corp", id: "acme-1" } }, "Acme Corp"],
    ["plan-idonly-pro", { paidTier: { id: "x-pro-y" } }, "Pro"],
    ["plan-empty-then-current", { paidTier: { name: "", id: "" }, currentTier: { name: "Team Plan" } }, "Team Plan"],
    ["plan-current-only", { currentTier: { name: "Google AI Ultra" } }, "Ultra"],
    ["plan-current-free", { currentTier: { id: "free" } }, "Free"],
    ["plan-none", {}, ""],
    ["plan-paidtier-string", { paidTier: "pro", currentTier: { name: "Fallback" } }, "Fallback"],
    ["plan-paidtier-null", { paidTier: null, currentTier: { name: "Solo" } }, "Solo"],
    ["plan-garbage", { paidTier: 42, currentTier: "x" }, ""],
  ]) {
    const f = fixture(name, { token: FRESH_TOKEN, spec: { assist: { body: { cloudaicompanionProject: null, ...assistBody } } } });
    const j = f.out(f.run());
    assert.equal(j.plan, plan, `${name}: plan extraction`);
  }
  {
    // tierOf keyword match is substring + case-insensitive on BOTH id and name.
    const f = fixture("plan-case", { token: FRESH_TOKEN, spec: { assist: { body: { paidTier: { id: "TIER_X", name: "pRo Max" } } } } });
    assert.equal(f.out(f.run()).plan, "Pro");
  }

  // ================================================================ fetch: quota -> limits/status
  {
    // Happy path already asserted in fixtures above; here: mixed pools ->
    // multiple bars, status empty because a Gemini bar exists.
    const f = fixture("quota-mixed", {
      token: FRESH_TOKEN,
      spec: { quota: { body: { groups: [
        { displayName: "Gemini models", buckets: [{ window: "5-hour", remainingFraction: 0.5, resetTime: "2026-12-01T00:00:00Z" }] },
        { displayName: "Claude and GPT models", buckets: [{ window: "weekly", remainingFraction: 0.25, resetTime: "2026-12-08T00:00:00Z" }] },
      ] } } },
    });
    const j = f.out(f.run());
    assert.equal(j.status, "");
    assert.deepEqual(j.limits.map((l) => l.title), ["Gemini Session", "Claude/GPT Weekly"]);
  }
  {
    // No Gemini bar but other bars -> the honest "no Gemini limit" status.
    const f = fixture("quota-nogemini", {
      token: FRESH_TOKEN,
      spec: { quota: { body: { groups: [{ displayName: "Claude and GPT models", buckets: [{ window: "weekly", remainingFraction: 0.25, resetTime: FUTURE }] }] } } },
    });
    const j = f.out(f.run());
    assert.equal(j.status, "Google reports no Gemini limit for this plan.");
    assert.deepEqual(j.limits.map((l) => l.title), ["Claude/GPT Weekly"]);
  }
  {
    // QUIRK: a plan whose only pool is an UNTOUCHED Claude/GPT allowance parses
    // to zero limits, so the status says "reported no quota windows" even
    // though Google did report a (fresh) window.
    const f = fixture("quota-untouched", {
      token: FRESH_TOKEN,
      spec: { quota: { body: { groups: [{ displayName: "Claude and GPT models", buckets: [{ window: "weekly", remainingFraction: 1, resetTime: FUTURE }] }] } } },
    });
    const j = f.out(f.run());
    assert.equal(j.status, "Antigravity reported no quota windows.", "QUIRK: untouched non-Gemini pool -> 'no quota windows'");
    assert.deepEqual(j.limits, []);
  }
  for (const [name, quotaBodyVal] of [
    ["quota-empty", {}],
    ["quota-null", null],
    ["quota-groups-str", { groups: "junk" }],
    ["quota-buckets-str", { buckets: "junk" }],
    ["quota-str", "hello"],
    ["quota-num", 7],
  ]) {
    const f = fixture(name, { token: FRESH_TOKEN, spec: { quota: { raw: JSON.stringify(quotaBodyVal) } } });
    const j = f.out(f.run());
    assert.equal(j.status, "Antigravity reported no quota windows.", `${name}: ${JSON.stringify(j)}`);
    assert.deepEqual(j.limits, []);
  }
  {
    // A bucket with a reset time but NO remainingFraction counts as fully used.
    const f = fixture("quota-nofrac", {
      token: FRESH_TOKEN,
      spec: { quota: { body: { groups: [{ displayName: "Gemini models", buckets: [{ window: "weekly", resetTime: FUTURE }] }] } } },
    });
    const j = f.out(f.run());
    assert.deepEqual(j.limits, [{ title: "Gemini Weekly", percent: 1, resetsAt: "2099-01-01T00:00:00.000Z" }]);
  }
  {
    // Flat top-level `buckets` (no groups) still parses -> Gemini Weekly.
    const f = fixture("quota-flatbuckets", {
      token: FRESH_TOKEN,
      spec: { quota: { body: { buckets: [{ window: "weekly", remainingFraction: 0.75, resetTime: FUTURE }] } } },
    });
    const j = f.out(f.run());
    assert.equal(j.status, "");
    assert.deepEqual(j.limits.map((l) => l.title), ["Gemini Weekly"]);
  }

  // ================================================================ fetch: error paths
  for (const [name, spec] of [
    ["err-assist-401", { assist: { status: 401 } }],
    ["err-assist-403", { assist: { status: 403 } }],
    ["err-assist-500", { assist: { status: 500 } }],
    ["err-assist-badjson", { assist: { badjson: true } }],
    ["err-assist-throw", { assist: { throw: true } }],
    ["err-quota-401", { quota: { status: 401 } }],
    ["err-quota-403", { quota: { status: 403 } }],
    ["err-quota-500", { quota: { status: 500 } }],
    ["err-quota-badjson", { quota: { badjson: true } }],
    ["err-quota-throw", { quota: { throw: true } }],
  ]) {
    const f = fixture(name, { token: FRESH_TOKEN, spec });
    const j = f.out(f.run());
    const isAuth = [spec.assist?.status, spec.quota?.status].includes(401) || [spec.assist?.status, spec.quota?.status].includes(403);
    const expected = isAuth ? "Google refused the agy sign-in — run `agy`." : "Antigravity limits unavailable right now.";
    assert.equal(j.status, expected, `${name}: got ${JSON.stringify(j)}`);
    assert.deepEqual(j.limits, []);
    assert.equal(j.plan, "");
  }
  {
    // A 401 on the SECOND call still reports auth (not a generic failure).
    const f = fixture("err-quota-401-check", { token: FRESH_TOKEN, spec: { quota: { status: 401 } } });
    assert.equal(f.out(f.run()).status, "Google refused the agy sign-in — run `agy`.");
    assert.equal(f.fetchCalls().length, 2, "both endpoints were attempted");
  }
  {
    // AGY_DEBUG_RAW=1 logs bucket diagnostics to stderr without touching stdout.
    const f = fixture("debug-raw", {
      token: FRESH_TOKEN,
      spec: { quota: { body: { groups: [{ displayName: "Gemini models", buckets: [{ bucketId: "b1", window: "weekly", remainingFraction: 0.5, resetTime: FUTURE }] }] } } },
    });
    const r = f.run({ AGY_DEBUG_RAW: "1" });
    const j = f.out(r);
    assert.equal(j.status, "");
    assert.ok(r.stderr.includes('"pool"'), "debug output names the pool");
    assert.ok(r.stderr.includes("Gemini models"), "debug output includes the raw displayName");
  }
  {
    // AGY_DEBUG_RAW empty string is falsy -> no debug output.
    const f = fixture("debug-raw-off", { token: FRESH_TOKEN });
    const r = f.run({ AGY_DEBUG_RAW: "" });
    f.out(r);
    assert.equal(r.stderr, "", "empty AGY_DEBUG_RAW stays quiet");
  }
  {
    // Every output shape carries the same three keys, even on failures.
    const f = fixture("shape", {});
    const j = f.out(f.run());
    for (const k of ["limits", "plan", "status"]) assert.ok(k in j, `output has ${k}`);
    assert.ok(Array.isArray(j.limits));
  }

  // ================================================================ concurrency: the kick-cooldown race
  {
    // Two agy.mjs processes with the same expired token and the same kick
    // file, held at the state read by a barrier: BOTH observe "no recent
    // kick" and BOTH run `agy models`. The cooldown is check-then-act with no
    // locking — a real (benign: agy refresh is idempotent) race.
    const f = fixture("race", { token: EXPIRED_TOKEN });
    const raceDir = path.join(f.dir, "race");
    fs.mkdirSync(raceDir, { recursive: true });
    const runAsync = () => new Promise((resolve) => {
      const c = spawn(process.execPath, [...FETCH_ARGS, ...SLOW_ARGS, script], {
        env: f.env({ AGY_RACE_DIR: raceDir }),
      });
      let out = "", err = "";
      c.stdout.on("data", (d) => { out += d; });
      c.stderr.on("data", (d) => { err += d; });
      c.on("close", (code) => resolve({ code, out, err }));
    });
    const [a, b] = await Promise.all([runAsync(), runAsync()]);
    assert.equal(a.code, 0, `race child A failed: ${a.err}`);
    assert.equal(b.code, 0, `race child B failed: ${b.err}`);
    assert.equal(f.kicks(), 2,
      "RACE: both collectors passed the cooldown check before either wrote it — agy was kicked twice");
    assert.equal(JSON.parse(a.out).status, "Sign-in expired and agy couldn't refresh it — run `agy` and sign in again.");
    assert.equal(JSON.parse(b.out).status, "Sign-in expired and agy couldn't refresh it — run `agy` and sign in again.");
  }

  console.log("agy deep: all tests passed");
} finally {
  for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
