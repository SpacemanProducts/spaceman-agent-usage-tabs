import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Deeper pass on the Devin branch of bin/collect.mjs: the Omarchy usage record
// at <state>/omarchy/agents/usage/devin.json goes through fromBuiltin()
// (limits filter/clamp, titleFor label fallback, recentDays -> 7-day series,
// modelUsage -> modelRows, codexResets, ready/usageStatusText/authHelpText),
// then planLimitsOnly + expireResets, the models.json free-note rule and the
// reset celebration. fromBuiltin is not exported, so every case runs the real
// collector end to end in a scratch HOME/XDG_STATE_HOME:
//   - a fake `devin` CLI sits in <home>/.local/bin (auto-added to PATH_DIRS)
//     and answers `devin models` for live-models.mjs;
//   - stub-bin holds notify-send / omarchy-agent-usage-update /
//     omarchy-agent-account-list / secret-tool, all logging to files, so no
//     real notification, refresh or keyring lookup can happen;
//   - PATH is only stub-bin; collect.mjs appends ~/.local/bin, mise shims and
//     /usr/local/bin + /usr/bin itself, where only `agy` lives (Antigravity
//     stays signed-out via the dead DBUS address and empty AGY_DIR).
//   - --notify 101 keeps the alert threshold above 100% and --volume 0 mutes
//     the cha-ching; the reset-celebration notify-send is still observable.
// Cases marked BUG expose crashes or quirks in the current code; they assert
// the behaviour as it is today, not the behaviour we would want.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLLECT = path.join(HERE, "collect.mjs");
const PLUGIN = path.join(HERE, "..");
const MODELS_JSON = JSON.parse(fs.readFileSync(path.join(PLUGIN, "models.json"), "utf8"));
const DEVIN_FREE_NOTE = MODELS_JSON?.plans?.devin?.freeNote || "";
// bin/collect.mjs DEVIN_FLASH_FREE_UNTIL: SWE-2 Flash free note expires then.
const DEVIN_FREE_UNTIL = Date.UTC(2026, 11, 4, 18, 0);
const RESET_NOTE = "Reset, waiting for fresh data."; // bin/expire-resets.mjs

const localDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devin-deep-"));
  const home = path.join(tmp, "home");
  const xdg = path.join(tmp, "xdg");
  const outDir = path.join(xdg, "omarchy", "agent-usage-tabs");
  const usageDir = path.join(xdg, "omarchy", "agents", "usage");
  const stubBin = path.join(tmp, "stub-bin");
  const logDir = path.join(tmp, "logs");
  for (const d of [path.join(home, ".local", "bin"), path.join(home, ".claude"), outDir, usageDir, stubBin, logDir, path.join(tmp, "xdg-runtime"), path.join(tmp, "agy-home")])
    fs.mkdirSync(d, { recursive: true });

  const notifyLog = path.join(logDir, "notify.log");
  const updateLog = path.join(logDir, "update.log");
  const stub = (name, body) => {
    const f = path.join(stubBin, name);
    fs.writeFileSync(f, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(f, 0o755);
  };
  stub("notify-send", `echo "$@" >> "${notifyLog}"`);
  stub("omarchy-agent-usage-update", `echo "$@" >> "${updateLog}"`);
  stub("omarchy-agent-account-list", `echo '[]'`);
  stub("secret-tool", `exit 1`); // agy.mjs falls through to the (empty) token file

  // The fake Devin CLI: `devin models` prints the family-header format
  // live-models.mjs PARSERS.devin expects; anything else exits quietly.
  const devinBin = path.join(home, ".local", "bin", "devin");
  fs.writeFileSync(devinBin, `#!/bin/sh
if [ "$1" = "models" ]; then
cat <<'EOF'
SWE-2 Flash (swe-2-flash)
  swe-2-flash-high  SWE-2 Flash High
Adaptive (adaptive)
  adaptive   Adaptive
EOF
fi
exit 0
`);
  fs.chmodSync(devinBin, 0o755);

  // Keep the 6 h live-models cache warm for Antigravity so `agy models` is
  // never spawned; Devin's entry is left out on purpose so the fake CLI above
  // is exercised once and then cached.
  fs.writeFileSync(path.join(outDir, "live-models.json"),
    JSON.stringify({ antigravity: { at: Date.now(), models: [{ id: "gemini-x", name: "Gemini X" }] } }));

  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: xdg,
    XDG_CONFIG_HOME: path.join(tmp, "xdg-config"),
    XDG_RUNTIME_DIR: path.join(tmp, "xdg-runtime"),
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    GROK_HOME: path.join(home, ".grok"),
    AGY_DIR: path.join(tmp, "agy-home"),
    PATH: stubBin,
  };
  return { tmp, home, xdg, outDir, usageDir, notifyLog, updateLog, env };
}

// content: undefined -> no devin.json, string -> written raw (malformed JSON),
// anything else -> JSON.stringify'd. extraArgs are appended to the collector.
function run(ctx, content, extraArgs = []) {
  const file = path.join(ctx.usageDir, "devin.json");
  if (content === undefined) { try { fs.unlinkSync(file); } catch {} }
  else fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  const r = spawnSync(process.execPath,
    [COLLECT, "--notify", "101", "--volume", "0", ...extraArgs],
    { encoding: "utf8", env: ctx.env, timeout: 120000 });
  return r;
}

function data(ctx) {
  try { return JSON.parse(fs.readFileSync(path.join(ctx.outDir, "data.json"), "utf8")); } catch { return null; }
}
const devinOf = (d) => d?.agents?.find((a) => a.id === "devin") || null;
const readIf = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const notifyText = (ctx) => readIf(ctx.notifyLog);
const cleanup = (ctx) => fs.rmSync(ctx.tmp, { recursive: true, force: true });

const FUTURE = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
const PAST = new Date(Date.now() - 3600 * 1000).toISOString();

// --------------------------------------------------------------- record absent
{
  const ctx = setup();
  const r = run(ctx, undefined);
  assert.equal(r.status, 0, `collect failed:\n${r.stderr}`);
  const d = devinOf(data(ctx));
  assert.ok(d, "devin keeps its tab");
  assert.equal(d.installed, true);
  assert.equal(d.cli, "devin");
  assert.equal(d.status, "No usage recorded yet.");
  assert.equal(d.plan, "");
  assert.deepEqual(d.limits, []);
  assert.equal(d.signedIn, undefined, "no record -> signedIn key absent");
  assert.equal(d.resets, undefined);
  assert.equal(d.planNote, undefined);
  assert.deepEqual(d.days, [], "no record -> no day series at all");
  assert.equal(d.today, 0);
  assert.equal(d.hasTokens, false);
  assert.equal(d.unsure, undefined, "builtin records carry no freshness flag");
  assert.equal(d.fetchedAt, undefined, "fetchedAt is a Claude-only field");
  // devin is a builtin, so its Omarchy record is refreshed on our schedule.
  assert.match(readIf(ctx.updateLog), /\bdevin\b/, "omarchy-agent-usage-update was asked for devin");
  cleanup(ctx);
  console.log("ok: missing devin.json");
}

// ------------------------------------------------------------ malformed record
{
  const ctx = setup();
  const r = run(ctx, "{ this is not json");
  assert.equal(r.status, 0, `collect failed:\n${r.stderr}`);
  const d = devinOf(data(ctx));
  assert.equal(d.status, "No usage recorded yet.", "unreadable JSON is treated like a missing record");
  assert.match(readIf(path.join(ctx.outDir, "collector.log")), /readable JSON/, "the parse failure is logged");
  cleanup(ctx);
  console.log("ok: malformed devin.json");
}

// ------------------------------------------------- valid JSON, wrong shapes
for (const [label, raw, wantStatus] of [
  ["null", "null", "No usage recorded yet."],
  ["empty array", "[]", ""],
  ["string", '"hello"', ""],
  ["number", "5", ""],
  ["boolean", "true", ""],
]) {
  const ctx = setup();
  const r = run(ctx, raw);
  assert.equal(r.status, 0, `${label}: collect failed:\n${r.stderr}`);
  const d = devinOf(data(ctx));
  assert.ok(d, `${label}: devin tab present`);
  assert.equal(d.status, wantStatus, `${label}: status`);
  assert.equal(d.signedIn, label === "null" ? undefined : false, `${label}: signedIn`);
  assert.equal(d.plan, "", `${label}: plan`);
  assert.deepEqual(d.limits, [], `${label}: limits`);
  cleanup(ctx);
  console.log(`ok: devin.json is ${label}`);
}

// BUG: fromBuiltin trusts r.limits to be a list — it logs a diagnostic for a
// non-list and then calls .filter on it anyway, so collect.mjs dies with a
// TypeError and writes no data.json at all (one malformed record takes down
// every agent's refresh, not just Devin's).
for (const bad of [{}, "x", 5, true]) {
  const ctx = setup();
  const r = run(ctx, { ready: true, limits: bad });
  assert.notEqual(r.status, 0, `limits=${JSON.stringify(bad)} should crash the collector`);
  assert.match(r.stderr, /TypeError|filter/, "the crash is the .filter call on a non-list");
  assert.equal(data(ctx), null, "a crashed run leaves no fresh data.json");
  cleanup(ctx);
  console.log(`ok: limits=${JSON.stringify(bad)} crashes (BUG)`);
}

// BUG: same class — a null element inside limits is dereferenced
// (l.percent) before any shape check, killing the whole run.
{
  const ctx = setup();
  const r = run(ctx, { ready: true, limits: [{ title: "Session", percent: 0.5 }, null] });
  assert.notEqual(r.status, 0, "a null limit entry should crash the collector");
  assert.match(r.stderr, /TypeError/, "null.percent throws");
  cleanup(ctx);
  console.log("ok: null limit entry crashes (BUG)");
}

// BUG: recentDays is iterated with for..of after only a truthiness check —
// a non-iterable (or a null element, whose .date is read) crashes the run.
for (const [label, recentDays] of [["object", {}], ["number", 5], ["null element", [null]], ["string element", ["x"]]]) {
  const ctx = setup();
  const r = run(ctx, { ready: true, recentDays });
  const crashes = label !== "string element"; // "x".date is undefined, not a throw
  if (crashes) {
    // BUG: non-iterable recentDays / null elements crash the whole collector.
    assert.notEqual(r.status, 0, `recentDays=${label} should crash the collector`);
    assert.match(r.stderr, /TypeError|iterable/, "for..of on a non-iterable throws");
  } else {
    // A string element is silently absorbed: d.date is undefined, so it lands
    // on the "undefined" bucket that daysFrom() never reads. Harmless but odd.
    assert.equal(r.status, 0, `recentDays=${label}: collect failed:\n${r.stderr}`);
  }
  cleanup(ctx);
  console.log(`ok: recentDays ${label}${crashes ? " crashes (BUG)" : " is absorbed"}`);
}

// BUG: modelRows() does +b.inputTokens on each modelUsage value — a null
// value throws, a missing record is fine.
{
  const ctx = setup();
  const r = run(ctx, { ready: true, modelUsage: { "swe-2-flash": null } });
  assert.notEqual(r.status, 0, "a null modelUsage value should crash the collector");
  assert.match(r.stderr, /TypeError/, "null.inputTokens throws");
  cleanup(ctx);
  console.log("ok: null modelUsage value crashes (BUG)");
}

// ------------------------------------------------------- limits: the kitchen sink
{
  const ctx = setup();
  const rec = {
    tierLabel: "Pro",
    ready: true,
    limits: [
      { title: "Session", percent: 0, resetsAt: "" },
      { title: "Weekly", percent: 0.6, resetsAt: FUTURE },
      { title: "Daily", percent: 0.85, resetsAt: PAST },          // reset time passed -> expired to 0
      { title: "Monthly", percent: 1 },
      { title: "ClampHigh", percent: 1.4 },                       // clamp01 -> 1
      { title: "Sixty", percent: 60 },                            // 60 as a fraction -> clamped to 1
      { title: "Neg", percent: -0.2 },                            // negative -> dropped by fromBuiltin
      { title: "Bad", percent: "abc" },                           // NaN -> dropped
      { title: "Missing" },                                       // undefined -> NaN -> dropped
      { title: "NullPct", percent: null },                        // Number(null)===0 -> kept as a 0% meter
      { title: "StrPct", percent: "0.5" },                        // string coerced -> 0.5
      { title: "BoolPct", percent: true },                        // Number(true)===1 -> 1
      { title: "EmptyArrPct", percent: [] },                      // Number([])===0 -> kept as 0 (quirk)
      { title: "Spend cap", percent: 0.5 },                       // planLimitsOnly: spend
      { title: "On-demand usage", percent: 0.5 },                 // planLimitsOnly: on-demand
      { title: "Top-up", percent: 0.5 },                          // planLimitsOnly: top-up
      { title: "Credits purchased", percent: 0.5 },               // planLimitsOnly: credits purchased
      { title: "Fine print", percent: 0.5, detail: "includes overage" }, // detail is dropped by fromBuiltin before planLimitsOnly sees it
      { title: "Balance remaining", percent: 0.5 },               // planLimitsOnly: balance
      { label: "5h session", percent: 0.4 },                      // no title -> titleFor(label) -> "Session"
      { label: "Monthly quota", percent: 0.3 },                   // -> "Monthly"
      { title: "OldZero", percent: 0, resetsAt: PAST },           // 0% + past reset: kept verbatim (quirk)
      { title: "NumericReset", percent: 0.5, resetsAt: 123 },     // Date.parse(123) is a past date -> expired
      { title: "BadDate", percent: 0.5, resetsAt: "not-a-date" }, // unparseable -> kept, flagged in dataWarning
      { title: 5, percent: 0.5 },                                 // non-string title passes through
    ],
  };
  const r = run(ctx, rec);
  assert.equal(r.status, 0, `collect failed:\n${r.stderr}`);
  const d = devinOf(data(ctx));
  const byTitle = (t) => d.limits.filter((l) => l.title === t);
  const one = (t) => { const xs = byTitle(t); assert.equal(xs.length, 1, `expected one "${t}" limit, got ${xs.length}`); return xs[0]; };

  assert.equal(byTitle("Session").length, 2, "the label-derived limit also lands on \"Session\"");
  assert.deepEqual(byTitle("Session").map((l) => l.percent).sort(), [0, 0.4]);
  assert.equal(one("Weekly").percent, 0.6);
  assert.equal(one("Weekly").resetsAt, FUTURE, "a future reset time is untouched");
  const daily = one("Daily");
  assert.equal(daily.percent, 0);
  assert.equal(daily.resetsAt, "");
  assert.equal(daily.note, RESET_NOTE, "a passed reset expires the meter to 0");
  assert.deepEqual(byTitle("Monthly").map((l) => l.percent).sort((a, b) => a - b), [0.3, 1], "label \"Monthly quota\" falls back to titleFor -> \"Monthly\"");
  assert.equal(one("ClampHigh").percent, 1);
  assert.equal(one("Sixty").percent, 1);
  assert.equal(one("StrPct").percent, 0.5);
  assert.equal(one("BoolPct").percent, 1);
  assert.equal(one("NullPct").percent, 0, "BUG-ish: null percent becomes a real 0% meter");
  assert.equal(one("EmptyArrPct").percent, 0, "Number([])===0 keeps the meter too");
  for (const gone of ["Neg", "Bad", "Missing", "Spend cap", "On-demand usage", "Top-up", "Credits purchased", "Balance remaining"])
    assert.equal(byTitle(gone).length, 0, `"${gone}" should have been filtered out`);
  assert.equal(one("Fine print").percent, 0.5, "QUIRK: fromBuiltin keeps only title/percent/resetsAt, so planLimitsOnly's detail check never fires for Omarchy records");
  assert.equal(one("OldZero").resetsAt, PAST, "QUIRK: a 0% meter keeps its stale past resetsAt");
  const numReset = one("NumericReset");
  assert.equal(numReset.percent, 0);
  assert.equal(numReset.resetsAt, "");
  assert.equal(numReset.note, RESET_NOTE, "QUIRK: resetsAt:123 parses as a date (year 123) and expires the meter");
  const badDate = one("BadDate");
  assert.equal(badDate.resetsAt, "not-a-date", "an unparseable resetsAt is passed through");
  assert.equal(one(5).percent, 0.5, "a numeric title survives as a number");
  assert.equal(d.plan, "Pro");
  assert.equal(d.planNote, undefined, "the free note only applies to free-ish plans");
  assert.equal(d.signedIn, true);
  assert.equal(d.status, "");
  assert.ok(d.dataWarning, "negative days / bad reset times set the one-line warning");
  cleanup(ctx);
  console.log("ok: limits edge cases");
}

// ------------------------------------------------------------- recentDays/7d
{
  const ctx = setup();
  const today = localDate(Date.now());
  const yesterday = localDate(Date.now() - 86400000);
  const twoDaysAgo = localDate(Date.now() - 2 * 86400000);
  const old = localDate(Date.now() - 10 * 86400000);
  const rec = {
    ready: true,
    recentDays: [
      { date: today, messageCount: null },      // +null || 0 -> 0, then overwritten below
      { date: today, messageCount: 100 },       // last write wins for a repeated date
      { date: yesterday, messageCount: "50" },  // string coerced -> 50
      { date: twoDaysAgo, messageCount: -3 },   // negative tokens pass through
      { date: old, messageCount: 999 },         // outside the 7-day window -> ignored
      { messageCount: 7 },                      // no date -> ignored
      { date: "not-a-date", messageCount: 9 },  // ignored by daysFrom
    ],
  };
  const r = run(ctx, rec);
  assert.equal(r.status, 0, `collect failed:\n${r.stderr}`);
  const d = devinOf(data(ctx));
  assert.equal(d.days.length, 7);
  const tok = (date) => d.days.find((x) => x.date === date)?.tokens;
  assert.equal(tok(today), 100);
  assert.equal(tok(yesterday), 50);
  assert.equal(tok(twoDaysAgo), -3, "a negative messageCount becomes negative tokens");
  assert.equal(d.days.reduce((s, x) => s + x.tokens, 0), 147);
  assert.equal(d.today, 100);
  assert.ok(d.dataWarning, "the negative day count is flagged in dataWarning");
  cleanup(ctx);
  console.log("ok: recentDays mapping");
}

// ------------------------------------------------------------- modelUsage
{
  const ctx = setup();
  const rec = {
    ready: true,
    tierLabel: "Pro",
    modelUsage: {
      "swe-2-flash-medium": { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 0 },
      mystery: { inputTokens: 7 },
      partial: { outputTokens: 3 },
      empty: {},
      weird: 5, // non-object: every token field reads as undefined -> all zeros
    },
  };
  const r = run(ctx, rec);
  assert.equal(r.status, 0, `collect failed:\n${r.stderr}`);
  const d = devinOf(data(ctx));
  assert.equal(d.modelScope, "all time");
  const swe = d.models.find((m) => m.name === "SWE-2 Flash");
  assert.ok(swe, "live model row exists");
  assert.equal(swe.total, 125, "modelUsage tokens land on the matching live model");
  assert.equal(swe.state, "used");
  const mystery = d.models.find((m) => m.name === "mystery");
  assert.equal(mystery.total, 7, "an unmatched used model is appended as its own row");
  assert.equal(mystery.state, "used");
  assert.equal(d.models.find((m) => m.name === "partial").total, 3, "missing token fields count as 0");
  assert.equal(d.models.find((m) => m.name === "empty").state, "zero");
  assert.equal(d.models.find((m) => m.name === "weird").total, 0, "a scalar modelUsage value yields an all-zero row");
  cleanup(ctx);
  console.log("ok: modelUsage mapping");
}

// ------------------------------------------------------- plan / free note
for (const [label, tierLabel, wantPlan, wantNote] of [
  ["Free", "Free", "Free", true],
  ["lowercase free", "free", "free", true],
  ["Free Trial", "Free Trial", "Free Trial", true],
  ["Pro", "Pro", "Pro", false],
  ["TEAM", "TEAM", "TEAM", false],
  ["numeric tier", 5, 5, false], // QUIRK: tierLabel passes through unstringified
  ["missing tier", undefined, "", false],
]) {
  const ctx = setup();
  const rec = { ready: true, limits: [] };
  if (tierLabel !== undefined) rec.tierLabel = tierLabel;
  const r = run(ctx, rec);
  assert.equal(r.status, 0, `${label}: collect failed:\n${r.stderr}`);
  const d = devinOf(data(ctx));
  assert.equal(d.plan, wantPlan, `${label}: plan`);
  const noteExpected = wantNote && Date.now() < DEVIN_FREE_UNTIL ? DEVIN_FREE_NOTE : undefined;
  assert.equal(d.planNote, noteExpected, `${label}: planNote (free note only before ${new Date(DEVIN_FREE_UNTIL).toISOString()})`);
  cleanup(ctx);
  console.log(`ok: tierLabel ${label}`);
}

// ------------------------------------------------------- ready / status
for (const [label, rec, wantSignedIn, wantStatus, wantNote] of [
  ["ready", { ready: true }, true, "", false],
  ["ready with status text", { ready: true, usageStatusText: "All good" }, true, "", false],
  ["not ready, both texts", { ready: false, usageStatusText: "Quota check failed", authHelpText: "Run devin login" }, false, "Quota check failed", false],
  ["not ready, help only", { ready: false, authHelpText: "Run devin login" }, false, "Run devin login", false],
  ["not ready, no texts", { ready: false }, false, "", false],
  ["no ready flag", {}, false, "", false],
  ["truthy non-bool ready", { ready: "yes" }, false, "", false], // QUIRK: === true / === false checks
]) {
  const ctx = setup();
  const r = run(ctx, { ...rec, limits: [] });
  assert.equal(r.status, 0, `${label}: collect failed:\n${r.stderr}`);
  const d = devinOf(data(ctx));
  assert.equal(d.signedIn, wantSignedIn, `${label}: signedIn`);
  assert.equal(d.status, wantStatus, `${label}: status`);
  assert.equal("note" in d, wantNote, `${label}: note is always deleted before output`);
  cleanup(ctx);
  console.log(`ok: ready=${label}`);
}

// ------------------------------------------------------------- resetCredits
{
  const ctx = setup();
  let r = run(ctx, { ready: true, limits: [], resetCredits: { available: 2, nextExpiresAt: "2027-01-01T00:00:00+00:00" } });
  assert.equal(r.status, 0, `collect failed:\n${r.stderr}`);
  assert.deepEqual(devinOf(data(ctx)).resets, { left: 2, usableNow: true, expiresAt: "2027-01-01T00:00:00.000Z" });

  r = run(ctx, { ready: true, limits: [], resetCredits: { available: 0 } });
  assert.equal(r.status, 0);
  assert.equal(devinOf(data(ctx)).resets, null, "no banked resets -> resets is null, not absent");

  r = run(ctx, { ready: true, limits: [] });
  assert.equal(r.status, 0);
  assert.equal(devinOf(data(ctx)).resets, null);
  cleanup(ctx);
  console.log("ok: resetCredits wiring");
}

// ------------------------------------------- reset celebration across runs
{
  const ctx = setup();
  const mk = (sessionPct) => ({
    tierLabel: "Pro", ready: true,
    limits: [
      { title: "Session", percent: sessionPct, resetsAt: FUTURE },
      { title: "Weekly", percent: 0.2, resetsAt: FUTURE },
    ],
  });
  let r = run(ctx, mk(0.9));
  assert.equal(r.status, 0, `run1 failed:\n${r.stderr}`);
  assert.equal(devinOf(data(ctx)).resetAt, undefined, "no reset on the first sighting");

  // Session falls 0.9 -> 0.3 (>50 points) before its resetsAt: a scheduled
  // reset for Devin — it is not in SURPRISE_AGENTS, so even though the drop
  // is "early" the celebration stays the normal cash-burst one.
  r = run(ctx, mk(0.3));
  assert.equal(r.status, 0, `run2 failed:\n${r.stderr}`);
  const d2 = devinOf(data(ctx));
  assert.equal(d2.resetKind, "scheduled");
  assert.deepEqual(d2.resetWindows, ["Session"]);
  assert.equal(d2.resetPhrase, "session");
  assert.equal(d2.resetDetails[0].title, "Session");
  assert.equal(d2.resetDetails[0].surprise, true, "the drop was early, but Devin has no surprise copy");
  const notes1 = notifyText(ctx);
  assert.equal((notes1.match(/reset, go cook/g) || []).length, 1, "one celebration notification");
  assert.match(notes1, /Devin session reset, go cook\./);
  assert.match(notes1, /cash-burst\.svg/, "the normal reset picture, not the surprise one");
  assert.doesNotMatch(notes1, /surprise-burst\.svg/);

  // Same reading again: no new drop -> no second notification; the in-progress
  // flash is carried over from the previous data.json.
  r = run(ctx, mk(0.3));
  assert.equal(r.status, 0, `run3 failed:\n${r.stderr}`);
  const d3 = devinOf(data(ctx));
  assert.equal((notifyText(ctx).match(/reset, go cook/g) || []).length, 1, "still exactly one celebration");
  assert.equal(typeof d3.resetAt, "number", "the flash survives a refresh inside its window");
  cleanup(ctx);
  console.log("ok: reset celebration");
}

console.log("devin-deep: all tests passed");
