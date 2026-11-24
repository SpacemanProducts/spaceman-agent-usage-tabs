// Deeper edge-case pass on the Claude collector. Two layers:
//
//   1. Pure parsers (bin/claude-limits.mjs): percent boundaries, malformed
//      payload shapes, resetsAt passthrough quirks, Fable scope matching,
//      cedar_ember grant field quirks. Complements claude-limits.test.mjs.
//
//   2. End to end through bin/collect.mjs for the logic that is not exported:
//      claudeLimits() (credentials, cache, fetch outcomes) and
//      claudeTranscripts() (jsonl parsing, dedupe, day bucketing). collect.mjs
//      is spawned with a fake HOME/XDG and a stub PATH; the network is replaced
//      by a --import preload that stubs globalThis.fetch, so no real endpoint,
//      credential or notification is ever touched. `--volume 0` keeps any
//      detected reset from playing a sound.
//
// Tests that pin down SUSPECTED BUGS assert the current (buggy) behaviour and
// say so in a comment; they are reported, not fixed (this job is test-only).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseClaudeLimits, parseClaudeResets } from "./claude-limits.mjs";

// ============================================================ part 1: parsers
const lim = (p) => parseClaudeLimits(p);
const titles = (p) => lim(p).map((l) => l.title);
const fable = (model, extra = {}) => ({ kind: "weekly_scoped", scope: { model }, percent: 10, ...extra });

// ---- utilization boundaries: 0 / 60 / 85 / 100 are all real readings
assert.equal(lim({ five_hour: { utilization: 0 } })[0].percent, 0, "0% is shown, not treated as missing");
assert.equal(lim({ five_hour: { utilization: 60 } })[0].percent, 0.6);
assert.equal(lim({ five_hour: { utilization: 85 } })[0].percent, 0.85);
assert.equal(lim({ five_hour: { utilization: 100 } })[0].percent, 1);
assert.equal(lim({ five_hour: { utilization: 100.4 } })[0].percent, 1, "just over 100 still clamps");
assert.equal(lim({ five_hour: { utilization: "0" } })[0].percent, 0, "string \"0\" is a reading");
assert.equal(lim({ five_hour: { utilization: " 42 " } })[0].percent, 0.42, "whitespace-padded numeric string counts");
// Number() semantics: hex and exponent strings parse too
assert.equal(lim({ five_hour: { utilization: "0x10" } })[0].percent, 0.16, "\"0x10\" parses as 16 via Number()");
assert.equal(lim({ five_hour: { utilization: "1e2" } })[0].percent, 1, "\"1e2\" parses as 100");

// ---- utilization values that are NOT a reading (never 0%)
for (const v of [null, undefined, true, false, "", "   ", "85abc", "1e", "Infinity", Infinity, -Infinity, NaN, {}, [], [5]])
  assert.deepEqual(lim({ five_hour: { utilization: v }, seven_day: { utilization: 1 } }).map((l) => l.title), ["Weekly"],
    `utilization ${JSON.stringify(v)} is no value, Weekly still shows`);

// ---- window slots that are not really window objects
for (const w of [null, undefined, 0, "", "x", 42, [], true, {}])
  assert.deepEqual(lim({ five_hour: w, seven_day: { utilization: 1 } }).map((l) => l.title), ["Weekly"],
    `five_hour=${JSON.stringify(w)} is skipped, not zeroed`);

// ---- resets_at passthrough quirks
assert.equal(lim({ five_hour: { utilization: 5, resets_at: 0 } })[0].resetsAt, "", "falsy resets_at becomes empty string");
assert.equal(lim({ five_hour: { utilization: 5, resets_at: false } })[0].resetsAt, "");
assert.equal(lim({ five_hour: { utilization: 5, resets_at: null } })[0].resetsAt, "");
// QUIRK: a non-string resets_at passes through raw (a number stays a number).
assert.equal(lim({ five_hour: { utilization: 5, resets_at: 1764000000000 } })[0].resetsAt, 1764000000000,
  "numeric resets_at is NOT coerced to a string");

// ---- payload shapes that must not throw and must not invent meters
for (const p of [null, undefined, "str", 42, true, [], [[]], { limits: {} }, { five_hour: "x" }, { seven_day: 7 }])
  assert.deepEqual(lim(p), [], `payload ${JSON.stringify(p)} yields no meters`);
// result rows carry exactly {title, percent, resetsAt} - nothing leaks through
assert.deepEqual(lim({ five_hour: { utilization: 5, resets_at: "r", extra: 1 } })[0],
  { title: "Session", percent: 0.05, resetsAt: "r" }, "no extra payload fields leak into a meter");

// ---- Fable scoped entries: matching quirks
assert.deepEqual(titles({ limits: [fable({ display_name: "Opus", id: "claude-fable-5-2" })] }), [],
  "display_name wins over id: a non-fable name hides a fable id");
assert.deepEqual(titles({ limits: [fable({ display_name: " ", id: "claude-fable-5-2" })] }), [],
  "QUIRK: a whitespace display_name is truthy, so it suppresses the fable id too");
assert.deepEqual(titles({ limits: [fable({ display_name: "", id: "claude-fable-5-2" })] }), ["Fable Weekly"],
  "empty display_name falls back to id");
assert.deepEqual(titles({ limits: [fable({ display_name: "MyFableClone" })] }), ["Fable Weekly"],
  "substring match: any name containing 'fable' counts");
assert.deepEqual(titles({ limits: [fable({ id: "FABLE-9" })] }), ["Fable Weekly"], "match is case-insensitive");

// ---- Fable entries that are not usable
for (const e of [
  null, "x", 5, {},
  { kind: "weekly_scoped" },                                   // no scope
  { kind: "weekly_scoped", scope: null, percent: 5 },
  { kind: "weekly_scoped", scope: { model: "fable" }, percent: 5 },   // model not an object
  { kind: "weekly_scoped", scope: { model: {} }, percent: 5 },        // model with no name
  fable({ display_name: "Fable" }, { percent: null }),
  fable({ display_name: "Fable" }, { percent: "abc" }),
  fable({ display_name: "Fable" }, { percent: true }),
  { kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, utilization: 50 },  // entries read `percent`, not `utilization`
])
  assert.deepEqual(lim({ limits: [e] }), [], `entry ${JSON.stringify(e)} yields no meter`);

// ---- Fable window titles, kind quirks and dedupe order
assert.deepEqual(titles({ limits: [fable({ display_name: "Fable" }, { kind: "WEEKLY_SCOPED" })] }), ["Fable Weekly"], "kind match is case-insensitive");
assert.deepEqual(titles({ limits: [fable({ display_name: "Fable" }, { kind: "day_scoped" })] }), ["Fable Weekly"], "'day' kinds read as Weekly");
assert.deepEqual(titles({ limits: [fable({ display_name: "Fable" }, { kind: "holiday" })] }), ["Fable Weekly"],
  "QUIRK: windowTitle is a substring match - 'holiday' contains 'day'");
assert.deepEqual(titles({ limits: [fable({ display_name: "Fable" }, { kind: "monthly" })] }), ["Fable Monthly"]);
assert.deepEqual(titles({ limits: [fable({ display_name: "Fable" }, { kind: "hourly" })] }), ["Fable Session"], "'hour' kinds read as Session");
assert.deepEqual(titles({ limits: [fable({ display_name: "Fable" }, { kind: 123 })] }), ["Fable"], "non-string kind still shows the meter, unsuffixed");
assert.deepEqual(titles({ limits: [fable({ display_name: "Fable" }), fable({ display_name: "Fable" }, { kind: "monthly_scoped" })] }),
  ["Fable Weekly", "Fable Monthly"], "different windows are both kept");
{
  const dup = lim({ limits: [fable({ display_name: "Fable" }, { percent: 10 }), fable({ display_name: "Fable" }, { percent: 99 })] });
  assert.equal(dup.length, 1);
  assert.equal(dup[0].percent, 0.1, "on duplicate windows the FIRST entry wins");
}
assert.equal(lim({ limits: [fable({ display_name: "Fable" }, { percent: 0 })] })[0].percent, 0, "Fable at 0% is still shown");
assert.equal(lim({ limits: [fable({ display_name: "Fable" }, { percent: " 60 " })] })[0].percent, 0.6, "padded numeric string percent counts");
assert.equal(lim({ limits: [fable({ display_name: "Fable" }, { percent: 250 })] })[0].percent, 1, "Fable percent clamps at 1");

// ---- parseClaudeResets: cedar_ember quirks
const R = parseClaudeResets;
assert.deepEqual(R({ cedar_ember: { eligible: 0, grants: [{ resets_left: 1 }] } }), { left: 1, usableNow: false, expiresAt: "" },
  "QUIRK: only literal `eligible === false` blocks; eligible:0 still counts grants");
assert.equal(R({ cedar_ember: { eligible: "false", grants: [{ resets_left: 1 }] } })?.left, 1,
  "QUIRK: the string \"false\" does not block either");
for (const b of [null, undefined, true, 5, "x", []])
  assert.equal(R({ cedar_ember: b }), null, `cedar_ember=${JSON.stringify(b)} yields nothing`);
assert.equal(R({ cedar_ember: { grants: [{ resets_left: 0 }, { resets_left: -2 }, { resets_left: 2.5 }] } }), null,
  "zero, negative and fractional counts are all unusable");
{
  // Grant field quirks: Number() coercion on resets_left, strict === on the flags.
  const r = R({ cedar_ember: { grants: [
    { resets_left: "2" },              // string count -> Number -> 2
    { resets_left: true },             // Number(true) === 1 -> counts!
    { resets_left: 1, paused: 1 },     // paused must be literal true -> NOT paused
    { resets_left: 1, paused: "yes" }, // same
    { resets_left: 1, usable_now: 1 }, // usable_now must be literal true -> false
    { resets_left: 1.5 }, { resets_left: "x" }, { resets_left: null },
    null, "x", 5,
  ] } });
  assert.deepEqual(r, { left: 6, usableNow: false, expiresAt: "" },
    "\"2\"+true+three unpaused 1s = 6; non-literal flags are ignored");
}
{
  const r = R({ cedar_ember: { grants: [
    { resets_left: 1, usable_now: true, paused: true },  // paused: skipped before usable_now is read
    { resets_left: 1, usable_now: "yes" },               // string is not usable_now
  ] } });
  assert.deepEqual(r, { left: 1, usableNow: false, expiresAt: "" },
    "a paused grant contributes neither its count nor its usable_now");
}
{
  const r = R({ cedar_ember: { grants: [
    { resets_left: 1, ends_at: "2020-01-01T00:00:00Z" },  // past but valid: still the earliest
    { resets_left: 1, ends_at: "2099-01-01T00:00:00Z" },
    { resets_left: 1, ends_at: 1767225600000 },           // number -> Date.parse -> NaN -> ignored
    { resets_left: 1, ends_at: "junk" },
  ] } });
  assert.deepEqual(r, { left: 4, usableNow: false, expiresAt: "2020-01-01T00:00:00.000Z" },
    "QUIRK: an already-expired grant still counts, and its past ends_at becomes expiresAt");
}
assert.equal(R({}), null);
assert.equal(R(null), null);

// ============================================================ part 2: collect.mjs end to end
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-deep-"));
const home = path.join(tmp, "home");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(tmp, "xdg-runtime"), { recursive: true });

// Stub PATH: only these resolve (plus the /usr/bin,/usr/local/bin collect.mjs
// always appends - where only `agy`/`antigravity` exist, and agy.mjs exits
// "Not signed in" immediately with a dead bus and empty AGY_DIR).
const bin = path.join(tmp, "bin");
fs.mkdirSync(bin);
const stub = (name, body) => { const p = path.join(bin, name); fs.writeFileSync(p, `#!/bin/sh\n${body}\n`); fs.chmodSync(p, 0o755); };
stub("claude", "exit 0");                                  // makes the claude tab "installed"
stub("omarchy-agent-usage-update", "exit 0");
stub("omarchy-agent-account-list", "echo '[]'");
stub("secret-tool", "exit 1");                            // keyring can never answer
const notifyLog = path.join(tmp, "notify.log");
stub("notify-send", `printf '%s\\n' "$@" >> "${notifyLog}"`);   // captures, never shows

// --import preload: replaces globalThis.fetch inside the collect process.
// FAKE_FETCH_MODE: ok (FAKE_FETCH_BODY JSON) | badjson | throw; FAKE_FETCH_STATUS
// sets the HTTP status; FAKE_FETCH_LOG records every requested URL.
const fetchStub = path.join(tmp, "fake-fetch.mjs");
fs.writeFileSync(fetchStub, `import fs from "node:fs";
globalThis.fetch = async (url) => {
  const s = String(url);
  if (process.env.FAKE_FETCH_LOG) fs.appendFileSync(process.env.FAKE_FETCH_LOG, s + "\\n");
  if (!s.includes("api.anthropic.com/api/oauth/usage")) return new Response("nope", { status: 404 });
  const mode = process.env.FAKE_FETCH_MODE || "ok";
  if (mode === "throw") throw new Error("network down");
  if (mode === "badjson") return new Response("this is not json{", { status: 200 });
  return new Response(process.env.FAKE_FETCH_BODY || "{}", { status: Number(process.env.FAKE_FETCH_STATUS || 200) });
};
`);

const cdirs = {};
function claudeDir(name) {
  const d = path.join(tmp, `claude-${name}`);
  fs.mkdirSync(d, { recursive: true });
  return (cdirs[name] = d);
}
function writeCreds(dir, value) {
  fs.writeFileSync(path.join(dir, ".credentials.json"), typeof value === "string" ? value : JSON.stringify(value));
}
const goodCreds = (extra = {}) => ({ claudeAiOauth: { accessToken: "fake-token", expiresAt: Date.now() + 3600e3, ...extra } });

function runCollect(name, { creds, fetchEnv = {}, seedData, makeFiles } = {}) {
  const dir = claudeDir(name);
  if (creds !== undefined) writeCreds(dir, creds);
  if (makeFiles) makeFiles(dir);
  const stateDir = path.join(tmp, `state-${name}`);
  const outDir = path.join(stateDir, "omarchy", "agent-usage-tabs");
  fs.mkdirSync(outDir, { recursive: true });
  // Pre-seed the live-model cache so `agy models` is never spawned.
  fs.writeFileSync(path.join(outDir, "live-models.json"),
    JSON.stringify({ antigravity: { at: Date.now(), models: [] } }));
  if (seedData !== undefined) fs.writeFileSync(path.join(outDir, "data.json"), JSON.stringify(seedData));
  const fetchLog = path.join(tmp, `fetch-${name}.log`);
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: stateDir,
    XDG_CONFIG_HOME: path.join(tmp, "xdg-config"),
    XDG_RUNTIME_DIR: path.join(tmp, "xdg-runtime"),
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
    CLAUDE_CONFIG_DIR: dir,
    GROK_HOME: path.join(home, ".grok"),
    AGY_DIR: path.join(tmp, "agy-empty"),
    PATH: bin,
    FAKE_FETCH_LOG: fetchLog,
    ...fetchEnv,
  };
  const r = spawnSync(process.execPath,
    ["--import", pathToFileURL(fetchStub).href, path.join(here, "collect.mjs"), "--volume", "0"],
    { encoding: "utf8", env, timeout: 120000 });
  assert.equal(r.status, 0, `collect run "${name}" failed:\n${r.stderr}\n${r.stdout}`);
  const data = JSON.parse(fs.readFileSync(path.join(outDir, "data.json"), "utf8"));
  const fetchCalls = fs.existsSync(fetchLog) ? fs.readFileSync(fetchLog, "utf8").trim().split("\n").filter(Boolean) : [];
  return {
    claude: data.agents.find((a) => a.id === "claude"),
    outDir, fetchCalls,
    collectorLog: (() => { try { return fs.readFileSync(path.join(outDir, "collector.log"), "utf8"); } catch { return ""; } })(),
    notifyText: (() => { try { return fs.readFileSync(notifyLog, "utf8"); } catch { return ""; } })(),
  };
}
const usageCalls = (calls) => calls.filter((u) => u.includes("api.anthropic.com/api/oauth/usage"));
const FUTURE = "2099-01-01T00:00:00Z";
const PAST = "2020-01-01T00:00:00Z";
const okPayload = (over = {}) => JSON.stringify({
  five_hour: { utilization: 42, resets_at: FUTURE },
  seven_day: { utilization: 10, resets_at: FUTURE },
  limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "Fable 5.2", id: "claude-fable-5-2" } }, percent: 41, resets_at: FUTURE }],
  cedar_ember: { eligible: true, grants: [
    { resets_left: 2, usable_now: true, ends_at: "2026-12-20T00:00:00Z" },
    { resets_left: 1, ends_at: "2026-12-10T00:00:00Z" },
    { resets_left: 1, paused: true, ends_at: "2026-12-01T00:00:00Z" },  // paused: count AND ends_at ignored
  ] },
  ...over,
});
const prevData = (limits, fetchedAt, extra = {}) => ({
  schemaVersion: 1, version: "test", generatedAt: Date.now(),
  agents: [{ id: "claude", name: "Claude Code", installed: true, plan: "Pro", status: "",
    limits, limitsFetchedAt: fetchedAt, resets: null, models: [], modelScope: "", days: [], today: 0, hasTokens: true, ...extra }],
});

// ---- E2E 1: no credentials at all -> honest "not signed in", no fetch
{
  const { claude, fetchCalls } = runCollect("signedout");
  assert.equal(claude.status, "Not signed in — run `claude` to log in.");
  assert.equal(claude.signedIn, false);
  assert.equal(claude.plan, "");
  assert.deepEqual(claude.limits, []);
  assert.equal(claude.resets, null);
  assert.equal(claude.limitsFetchedAt, 0);
  assert.equal(claude.unsure, undefined);
  assert.equal(usageCalls(fetchCalls).length, 0, "no token -> endpoint never called");
  // QUIRK: claude.days is always 7 entries, so hasTokens is true even with zero usage
  // (unlike cursor, which special-cases an all-zero week). Asserted as-is.
  assert.equal(claude.days.length, 7);
  assert.equal(claude.hasTokens, true, "QUIRK: claude reports hasTokens with no transcripts at all");
}

// ---- E2E 2: malformed / empty credentials files
{
  const { claude } = runCollect("creds-badjson", { creds: "{not json" });
  assert.equal(claude.status, "Not signed in — run `claude` to log in.");
  // QUIRK: signedIn only checks the file exists, so a corrupt credentials file
  // still reports signedIn:true while the status says not signed in.
  assert.equal(claude.signedIn, true, "QUIRK: signedIn is 'file exists', not 'login readable'");
}
{
  const { claude } = runCollect("creds-empty", { creds: {} });
  assert.equal(claude.status, "Not signed in — run `claude` to log in.");
  assert.equal(claude.signedIn, true, "same quirk: {} credentials still count as 'signed in'");
}

// ---- E2E 3: expired token -> early return, fetch never happens
{
  const { claude, fetchCalls } = runCollect("expired", { creds: goodCreds({ expiresAt: Date.now() - 1000 }) });
  assert.equal(claude.status, "Sign-in expired — open Claude Code once to refresh.");
  assert.deepEqual(claude.limits, []);
  assert.equal(claude.signedIn, true);
  assert.equal(usageCalls(fetchCalls).length, 0, "expired creds return before fetch");
}

// ---- E2E 4: happy path - limits, plan name, banked resets
{
  const before = Date.now();
  const { claude, fetchCalls } = runCollect("ok-pro", { creds: goodCreds({ subscriptionType: "pro" }), fetchEnv: { FAKE_FETCH_BODY: okPayload() } });
  assert.equal(usageCalls(fetchCalls).length, 1, "exactly one usage call");
  assert.equal(claude.status, "");
  assert.equal(claude.plan, "Pro", "subscriptionType 'pro' -> 'Pro'");
  assert.equal(claude.signedIn, true);
  assert.ok(claude.limitsFetchedAt >= before && claude.limitsFetchedAt <= Date.now() + 5000, "fetchedAt is fresh");
  assert.equal(claude.unsure, undefined, "a fresh reading is never 'unsure'");
  assert.deepEqual(claude.limits.map((l) => [l.title, l.percent, l.resetsAt]),
    [["Session", 0.42, FUTURE], ["Weekly", 0.1, FUTURE], ["Fable Weekly", 0.41, FUTURE]]);
  assert.deepEqual(claude.resets, { left: 3, usableNow: true, expiresAt: "2026-12-10T00:00:00.000Z" },
    "2+1 unpaused grants; the paused grant's earlier ends_at is ignored");
}
{
  const { claude } = runCollect("ok-max", { creds: goodCreds({ subscriptionType: "max" }), fetchEnv: { FAKE_FETCH_BODY: okPayload() } });
  assert.equal(claude.plan, "Max");
}
{
  const { claude } = runCollect("ok-nosub", { creds: goodCreds(), fetchEnv: { FAKE_FETCH_BODY: okPayload() } });
  assert.equal(claude.plan, "", "no subscriptionType -> empty plan, limits still shown");
  assert.equal(claude.limits.length, 3);
}
{
  // BUG (asserted, not fixed): subscriptionType is indexed without a type
  // check. A non-string value throws inside the try, the catch reports
  // "network", and perfectly good limits are discarded.
  const { claude } = runCollect("badsub", { creds: goodCreds({ subscriptionType: 123 }), fetchEnv: { FAKE_FETCH_BODY: okPayload() } });
  assert.equal(claude.status, "Limits unavailable (network).",
    "BUG: a numeric subscriptionType turns a good response into a network error");
  assert.deepEqual(claude.limits, [], "BUG: the parsed limits are lost with it");
}

// ---- E2E 5: fresh cache -> no fetch at all
{
  const seeded = Date.now();
  const prev = prevData(
    [{ title: "Session", percent: 0.5, resetsAt: FUTURE }, { title: "Weekly", percent: 0.3, resetsAt: FUTURE }],
    seeded, { resets: { left: 9, usableNow: false, expiresAt: "2027-01-01T00:00:00.000Z" } });
  const { claude, fetchCalls } = runCollect("cache", { creds: goodCreds(), fetchEnv: { FAKE_FETCH_BODY: okPayload() }, seedData: prev });
  assert.equal(usageCalls(fetchCalls).length, 0, "fresh cache short-circuits before fetch");
  assert.deepEqual(claude.limits.map((l) => [l.title, l.percent]), [["Session", 0.5], ["Weekly", 0.3]], "cached limits win over the fetch body");
  assert.equal(claude.limitsFetchedAt, seeded, "cached fetchedAt is preserved exactly");
  assert.deepEqual(claude.resets, { left: 9, usableNow: false, expiresAt: "2027-01-01T00:00:00.000Z" }, "cached resets carried too");
  assert.equal(claude.plan, "Pro");
  assert.equal(claude.status, "");
}

// ---- E2E 6: cache older than 5 min -> refetch
{
  const staleAt = Date.now() - 10 * 60e3;
  const prev = prevData([{ title: "Session", percent: 0.9, resetsAt: FUTURE }], staleAt);
  const { claude, fetchCalls } = runCollect("stale-cache", { creds: goodCreds(), fetchEnv: { FAKE_FETCH_BODY: okPayload() }, seedData: prev });
  assert.equal(usageCalls(fetchCalls).length, 1, "a >5min-old reading is refreshed");
  assert.equal(claude.limits.find((l) => l.title === "Session").percent, 0.42, "fresh data replaces the stale meter");
  assert.ok(claude.limitsFetchedAt > staleAt, "fetchedAt moves forward");
}

// ---- E2E 7: HTTP 429 with an old reading -> rate-limit status + stale limits + unsure
{
  const oldAt = Date.now() - 20 * 60e3;
  const prev = prevData([{ title: "Session", percent: 0.5, resetsAt: FUTURE }], oldAt, { plan: "Pro" });
  const { claude, fetchCalls } = runCollect("http429", { creds: goodCreds(), fetchEnv: { FAKE_FETCH_STATUS: "429", FAKE_FETCH_BODY: okPayload() }, seedData: prev });
  assert.equal(usageCalls(fetchCalls).length, 1);
  assert.equal(claude.status, "Rate limited — showing last known limits.");
  assert.equal(claude.limits[0].percent, 0.5, "last known limits are kept");
  assert.equal(claude.limitsFetchedAt, oldAt, "the stale timestamp is kept, so 'unsure' can fire");
  assert.match(claude.unsure || "", /Last reading from .*couldn't refresh/, "a >15min-old carried reading is flagged unsure");
}

// ---- E2E 8: HTTP 500 -> unavailable + diagnostic
{
  const { claude, collectorLog } = runCollect("http500", { creds: goodCreds(), fetchEnv: { FAKE_FETCH_STATUS: "500", FAKE_FETCH_BODY: okPayload() } });
  assert.equal(claude.status, "Limits unavailable (HTTP 500).");
  assert.deepEqual(claude.limits, []);
  assert.match(claude.dataWarning || "", /Data looks wrong/, "the failure is surfaced as a data warning");
  assert.match(collectorLog, /usage endpoint returned HTTP 500/, "and written to collector.log");
}

// ---- E2E 9: 200 with non-JSON body -> unavailable + diagnostic
{
  const { claude, collectorLog } = runCollect("badjson", { creds: goodCreds(), fetchEnv: { FAKE_FETCH_MODE: "badjson" } });
  assert.equal(claude.status, "Limits unavailable.");
  assert.deepEqual(claude.limits, []);
  assert.match(collectorLog, /not valid JSON/);
}

// ---- E2E 10: empty payload -> unavailable, fetchedAt stays 0
{
  const { claude, collectorLog } = runCollect("empty", { creds: goodCreds(), fetchEnv: { FAKE_FETCH_BODY: "{}" } });
  assert.equal(claude.status, "Limits unavailable.");
  assert.deepEqual(claude.limits, []);
  assert.equal(claude.limitsFetchedAt, 0, "no meters -> fetchedAt is not stamped");
  assert.equal(claude.resets, null);
  assert.match(collectorLog, /no session or weekly window/);
}

// ---- E2E 11: payload with ONLY banked resets -> resets survive "unavailable"
{
  const body = JSON.stringify({ cedar_ember: { eligible: true, grants: [{ resets_left: 1, usable_now: true, ends_at: "2027-01-01T00:00:00Z" }] } });
  const { claude } = runCollect("resets-only", { creds: goodCreds(), fetchEnv: { FAKE_FETCH_BODY: body } });
  assert.equal(claude.status, "Limits unavailable.", "no windows -> unavailable");
  assert.deepEqual(claude.limits, []);
  assert.equal(claude.limitsFetchedAt, 0);
  // QUIRK: resets are still parsed and returned even though there are no meters.
  assert.deepEqual(claude.resets, { left: 1, usableNow: true, expiresAt: "2027-01-01T00:00:00.000Z" },
    "QUIRK: banked resets are reported with zero limit meters");
}

// ---- E2E 12: network failure -> unavailable (network)
{
  const { claude } = runCollect("neterr", { creds: goodCreds(), fetchEnv: { FAKE_FETCH_MODE: "throw" } });
  assert.equal(claude.status, "Limits unavailable (network).");
  assert.deepEqual(claude.limits, []);
}

// ---- E2E 13: past resets_at -> expireResets zeroes a >0% meter; a 0% meter keeps its stale resetsAt
{
  const body = JSON.stringify({
    five_hour: { utilization: 30, resets_at: PAST },
    seven_day: { utilization: 0, resets_at: PAST },
    limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: 25 }],
  });
  const { claude } = runCollect("past-reset", { creds: goodCreds(), fetchEnv: { FAKE_FETCH_BODY: body } });
  const session = claude.limits.find((l) => l.title === "Session");
  const weekly = claude.limits.find((l) => l.title === "Weekly");
  const fableW = claude.limits.find((l) => l.title === "Fable Weekly");
  assert.deepEqual([session.percent, session.resetsAt, session.note], [0, "", "Reset, waiting for fresh data."],
    "a passed reset with usage >0 is zeroed immediately");
  // QUIRK: expireResets only touches meters with percent > 0, so a 0% meter keeps
  // its already-past resetsAt instead of being cleared like the Session meter.
  assert.equal(weekly.percent, 0);
  assert.equal(weekly.resetsAt, PAST, "QUIRK: a 0% meter keeps its stale resetsAt");
  assert.equal(weekly.note, undefined);
  assert.equal(fableW.resetsAt, "", "missing resets_at stays empty");
  assert.equal(fableW.percent, 0.25);
}

// ---- E2E 14: surprise reset (meter drops >50pts before its due time) -> celebrate, honest wording
{
  const due = new Date(Date.now() + 3 * 3600e3).toISOString();
  const prev = prevData(
    [{ title: "Session", percent: 0.9, resetsAt: due }, { title: "Weekly", percent: 0.2, resetsAt: due }],
    Date.now() - 10 * 60e3);
  const body = JSON.stringify({ five_hour: { utilization: 5, resets_at: due }, seven_day: { utilization: 20, resets_at: due } });
  const run = runCollect("surprise", { creds: goodCreds(), fetchEnv: { FAKE_FETCH_BODY: body }, seedData: prev });
  const claude = run.claude;
  assert.equal(claude.resetKind, "surprise", "a >50pt drop before the recorded reset time is a surprise");
  assert.deepEqual(claude.resetWindows, ["Session"]);
  assert.equal(claude.resetDetails[0].surprise, true);
  assert.equal(claude.resetDetails[0].dueAt, due);
  assert.match(run.notifyText || "", /reset came early/, "Claude always gets the honest wording (no announcement lookup)");
  assert.equal(claude.limits.find((l) => l.title === "Session").percent, 0.05);
}

// ---- E2E 15: scheduled reset (due time already passed) -> normal celebration
{
  const pastDue = new Date(Date.now() - 3600e3).toISOString();
  const prev = prevData([{ title: "Session", percent: 0.9, resetsAt: pastDue }], Date.now() - 10 * 60e3);
  const body = JSON.stringify({ five_hour: { utilization: 5, resets_at: FUTURE }, seven_day: { utilization: 20, resets_at: FUTURE } });
  const run = runCollect("scheduled", { creds: goodCreds(), fetchEnv: { FAKE_FETCH_BODY: body }, seedData: prev });
  const claude = run.claude;
  assert.equal(claude.resetKind, "scheduled", "a drop after the due time is a normal reset");
  assert.deepEqual(claude.resetWindows, ["Session"]);
  assert.equal(claude.resetDetails[0].surprise, false);
  assert.match(run.notifyText || "", /Claude Code session reset, go cook\./, "scheduled copy, no 'early' wording");
}

// ---- E2E 16: transcripts - dedupe, filtering, day bucketing, and the string-token bug
{
  const now = new Date();
  const iso = (ms) => new Date(ms).toISOString();
  const NOW = now.getTime();
  const YESTERDAY = NOW - 86400e3;
  const usage = (o) => JSON.stringify(o);
  const line = (o) => usage(o) + "\n";
  const mk = runCollect("transcripts", {
    makeFiles(dir) {
      const projA = path.join(dir, "projects", "proj-a");
      const projB = path.join(dir, "projects", "proj-b", "nested");
      fs.mkdirSync(projA, { recursive: true });
      fs.mkdirSync(projB, { recursive: true });

      // proj-a/main.jsonl: dedupe, synthetic, bad/missing fields, old+future timestamps
      const main = [
        // counted: claude-test m1/r1 -> in10 out5 cacheRead100 cacheWrite2 (day +117)
        line({ timestamp: iso(NOW), requestId: "r1", message: { id: "m1", model: "claude-test", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 2 } } }),
        // exact duplicate (same message.id + requestId) -> skipped
        line({ timestamp: iso(NOW), requestId: "r1", message: { id: "m1", model: "claude-test", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 2 } } }),
        // same requestId but different message.id -> counted (day +2)
        line({ timestamp: iso(NOW), requestId: "r1", message: { id: "m2", model: "claude-test", usage: { input_tokens: 1, output_tokens: 1 } } }),
        // <synthetic> model -> skipped entirely
        line({ timestamp: iso(NOW), requestId: "r3", message: { id: "m3", model: "<synthetic>", usage: { input_tokens: 999, output_tokens: 999 } } }),
        // line contains '"usage"' but message.usage is absent -> skipped
        line({ timestamp: iso(NOW), requestId: "r5", message: { id: "m5", model: "claude-test" }, usage: "seen" }),
        // unparseable timestamp -> skipped
        line({ timestamp: "garbage", requestId: "r6", message: { id: "m6", model: "claude-test", usage: { input_tokens: 7, output_tokens: 2 } } }),
        // timestamp older than the 8-day cutoff -> skipped
        line({ timestamp: iso(NOW - 9 * 86400e3), requestId: "r7", message: { id: "m7", model: "claude-test", usage: { input_tokens: 500, output_tokens: 500 } } }),
        // FUTURE timestamp: counted in model totals, invisible in days
        line({ timestamp: iso(NOW + 2 * 86400e3), requestId: "r8", message: { id: "m8", model: "claude-test", usage: { input_tokens: 50, output_tokens: 0 } } }),
        // no message.id and no requestId -> key "undefined:undefined": first counts (day +18)...
        line({ timestamp: iso(NOW), message: { model: "claude-test", usage: { input_tokens: 9, output_tokens: 9 } } }),
        // ...and every later id-less line is deduped away, however different
        line({ timestamp: iso(NOW), message: { model: "claude-test", usage: { input_tokens: 100, output_tokens: 100 } } }),
        // broken JSON that still contains '"usage"' -> skipped
        `{"timestamp":"${iso(NOW)}","message":{"usage":`,
        // a plain line with no '"usage"' substring -> skipped before parsing
        `{"timestamp":"${iso(NOW)}","message":{"id":"m9"}}`,
        // null message -> skipped
        line({ timestamp: iso(NOW), requestId: "r10", message: null, usage: { input_tokens: 1 } }),
      ].join("\n") + "\n";
      fs.writeFileSync(path.join(projA, "main.jsonl"), main);

      // proj-a/stale.jsonl: fresh content but mtime 10 days old -> whole file skipped
      const stale = path.join(projA, "stale.jsonl");
      fs.writeFileSync(stale, line({ timestamp: iso(NOW), requestId: "old", message: { id: "old", model: "claude-old", usage: { input_tokens: 999, output_tokens: 999 } } }));
      const old = new Date(NOW - 10 * 86400e3);
      fs.utimesSync(stale, old, old);

      // proj-a/notes.txt: not .jsonl -> ignored even with usage-looking content
      fs.writeFileSync(path.join(projA, "notes.txt"), line({ timestamp: iso(NOW), message: { id: "x", model: "claude-txt", usage: { input_tokens: 999 } } }));

      // proj-b/nested/deep.jsonl: zero/null tokens still create a model row; missing model -> "unknown"
      const deep = [
        line({ timestamp: iso(NOW), requestId: "z1", message: { id: "z1", model: "claude-zero", usage: { input_tokens: null, output_tokens: 0, cache_read_input_tokens: null, cache_creation_input_tokens: 0 } } }),
        line({ timestamp: iso(NOW), requestId: "u1", message: { id: "u1", usage: { input_tokens: 4, output_tokens: 1 } } }),
      ].join("\n") + "\n";
      fs.writeFileSync(path.join(projB, "deep.jsonl"), deep);

      // proj-b/strings.jsonl: token counts as STRINGS -> concatenation bug (yesterday's bucket)
      const strs = [
        line({ timestamp: iso(YESTERDAY), requestId: "s1", message: { id: "s1", model: "claude-str", usage: { input_tokens: "7", output_tokens: "3" } } }),
        line({ timestamp: iso(YESTERDAY), requestId: "s2", message: { id: "s2", model: "claude-str", usage: { input_tokens: "7", output_tokens: "3" } } }),
      ].join("\n") + "\n";
      fs.writeFileSync(path.join(projB, "..", "strings.jsonl"), strs);
    },
  });
  const { claude } = mk;
  assert.equal(claude.status, "In use, but no Claude plan login found to read limits (API-key logins have none).",
    "transcripts without a plan login get the honest 'in use' status");
  assert.equal(claude.signedIn, false);
  assert.equal(claude.plan, "");
  assert.equal(claude.limitsFetchedAt, 0);
  assert.equal(claude.resets, null);
  assert.equal(mk.fetchCalls.length, 0, "no credentials -> no fetch");

  const byName = Object.fromEntries(claude.models.map((m) => [m.name, m]));
  // claude-test counted lines: L1(10,5,100,2) + L3(1,1) + future(50,0) + undef-id(9,9) = in70 out15 cr100 cw2
  assert.equal(byName["Claude Test"].total, 187);
  assert.deepEqual([byName["Claude Test"].input, byName["Claude Test"].output, byName["Claude Test"].cacheRead, byName["Claude Test"].cacheWrite],
    [70, 15, 100, 2], "dedupe/synthetic/old/bad lines excluded; future timestamp still counted in totals");
  assert.equal(byName["Unlabeled usage"].total, 5, "missing model -> 'unknown' -> 'Unlabeled usage'");
  assert.equal(byName["Claude Zero"].total, 0, "an all-zero usage still creates a model row");
  assert.ok(!byName["Claude Old"] && !byName["Claude Txt"] && !byName["Claude Synthetic"],
    "mtime-skipped file, non-jsonl file and <synthetic> model produce no rows");
  // models.json's four claude entries are merged in as zero-state rows
  for (const n of ["Claude Fable 5.2", "Claude Opus 5.5", "Claude Sonnet 5.5", "Claude Haiku 5.5"])
    assert.equal(byName[n]?.state, "zero", `${n} comes from models.json`);

  assert.equal(claude.days.length, 7);
  const today = claude.days[claude.days.length - 1];
  const yesterday = claude.days[claude.days.length - 2];
  // today: 117 (L1) + 2 (L3) + 18 (undef-id) + 5 (unknown) = 142; the future-dated
  // line's 50 tokens are NOT in any day bucket.
  assert.equal(today.tokens, 142, "day buckets only cover the last 7 local days");
  // BUG (asserted, not fixed): string token counts concatenate instead of adding.
  // Two identical "7"/"3" lines should total 20 tokens; instead the day entry is
  // the string "073007300" and the model row reports 110.
  assert.strictEqual(yesterday.tokens, "073007300",
    "BUG: string token counts concatenate into a string day total instead of summing");
  assert.equal(byName["Claude Str"].total, 110, "BUG: the same concatenation inflates the model total (20 expected)");
  assert.match(claude.dataWarning || "", /Data looks wrong/, "the string day total is flagged by diagnostics");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("claude-deep: all tests passed");
