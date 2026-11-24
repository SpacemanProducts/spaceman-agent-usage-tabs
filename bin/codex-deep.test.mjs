// Deep edge-case pass for the Codex collector path, on top of codex-resets.test.mjs
// and collect.test.mjs (which only smoke-tests that a codex slot exists).
//
// Codex is an Omarchy "builtin" agent: collect.mjs reads
// $XDG_STATE_HOME/omarchy/agents/usage/codex.json via fromBuiltin() and shapes it
// into the agent record (limits clamped/filtered, days from recentDays, models
// from modelUsage, resets via codexResets, accounts via omarchy-agent-account-list).
//
// Every scenario runs the real bin/collect.mjs via spawnSync inside a scratch
// HOME/XDG_STATE_HOME. PATH holds a stub dir first (fake `codex`,
// `omarchy-agent-usage-update`, `omarchy-agent-account-list`, `notify-send`),
// then /usr/bin:/bin so `node` resolves; DBUS/XDG_RUNTIME_DIR are dead so no
// real keyring, CLI login or notification can ever be reached. The only agent
// that installs besides codex is Antigravity (agy ships in /usr/bin); its
// live-models cache is pre-seeded so `agy models` never spawns.
//
// KNOWN BUGS FOUND (asserted as current behaviour, NOT fixed here):
//   1. fromBuiltin() assumes r.limits is an array: a truthy non-array
//      (`limits: {}`) crashes on `.filter`, and `limits: [null]` crashes on
//      `l.percent`. One malformed Omarchy record kills the whole collector.
//   2. Same for recentDays: a non-iterable (`{}`) or a null entry crashes the
//      `for...of` / `d.date` access. (`recentDays: "abc"` survives because
//      strings are iterable; the char entries land on days["undefined"].)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { codexResets } from "./codex-resets.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const collectPath = path.join(here, "collect.mjs");
const DAY = 86400000;
const HOUR = 3600000;
const localDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const iso = (ms) => new Date(ms).toISOString();
const TODAY = localDate(Date.now());
const YEST = localDate(Date.now() - DAY);
const DAYS_AGO_3 = localDate(Date.now() - 3 * DAY);
const DAYS_AGO_5 = localDate(Date.now() - 5 * DAY);

// A scratch environment: fake HOME/XDG, stub PATH dir, seeded live-models cache.
function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-deep-"));
  const home = path.join(tmp, "home");
  const xdg = path.join(tmp, "xdg");
  const state = path.join(xdg, "omarchy");
  const outDir = path.join(state, "agent-usage-tabs");
  const builtinDir = path.join(state, "agents", "usage");
  const bin = path.join(tmp, "bin");
  const notifyLog = path.join(tmp, "notify.log");
  const updateLog = path.join(tmp, "update.log");
  const accountsFile = path.join(tmp, "accounts.json");
  for (const d of [home, outDir, builtinDir, bin, path.join(tmp, "xdr"), path.join(tmp, "agy")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(outDir, "live-models.json"),
    JSON.stringify({ antigravity: { at: Date.now(), models: [{ id: "m", name: "M" }] } }));
  fs.writeFileSync(accountsFile, "null\n");

  const stub = (name, body) => { const f = path.join(bin, name); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`); fs.chmodSync(f, 0o755); };
  // `codex` must exist for the installed check; `codex debug models` feeds liveModels.
  stub("codex", `if [ "$1" = "debug" ] && [ "$2" = "models" ]; then
  printf '%s\\n' '{"models":[{"slug":"gpt-5.2-codex","display_name":"GPT-5.2 Codex","visibility":"list"},{"slug":"gpt-5.2-codex-mini","display_name":"GPT-5.2 Codex Mini","visibility":"list"},{"slug":"internal-only","display_name":"Internal","visibility":"hide"}]}'
fi
exit 0`);
  stub("omarchy-agent-usage-update", `printf '%s\\n' "$*" >> "${updateLog}"\nexit 0`);
  stub("omarchy-agent-account-list", `cat "${accountsFile}" 2>/dev/null || echo null`);
  stub("notify-send", `printf '%s\\n' "$*" >> "${notifyLog}"\nexit 0`);

  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: xdg,
    XDG_RUNTIME_DIR: path.join(tmp, "xdr"),
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    GROK_HOME: path.join(home, ".grok"),
    AGY_DIR: path.join(tmp, "agy"),
    PATH: `${bin}:/usr/bin:/bin`,
  };
  const recordFile = path.join(builtinDir, "codex.json");
  return {
    tmp, outDir, builtinDir, recordFile, accountsFile, notifyLog, updateLog, env,
    writeRecord: (obj) => fs.writeFileSync(recordFile, JSON.stringify(obj)),
    writeRaw: (text) => fs.writeFileSync(recordFile, text),
    run() {
      const r = spawnSync(process.execPath, [collectPath], { encoding: "utf8", env, timeout: 240000 });
      let data = null;
      try { data = JSON.parse(fs.readFileSync(path.join(outDir, "data.json"), "utf8")); } catch {}
      const codex = data?.agents?.find((a) => a.id === "codex") || null;
      const notifyLines = fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, "utf8").split("\n").filter(Boolean) : [];
      return { status: r.status, stderr: String(r.stderr || ""), stdout: String(r.stdout || ""), data, codex, notifyLines };
    },
    collectorLog() { try { return fs.readFileSync(path.join(outDir, "collector.log"), "utf8"); } catch { return ""; } },
    cleanup() { fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

const future = (ms = 2 * DAY) => iso(Date.now() + ms);
const past = () => iso(Date.now() - DAY);

// --------------------------------------------------------------- unit edges
// codexResets cases not covered by codex-resets.test.mjs (current behaviour).
assert.equal(codexResets({ resetCredits: { available: true } })?.left, 1, "BUG?: boolean true coerces to 1 credit");
assert.equal(codexResets({ resetCredits: { available: "2" } })?.left, 2, "numeric string accepted as a count");
assert.equal(codexResets({ resetCredits: { available: Infinity } }), null, "Infinity is not an integer count");
assert.equal(codexResets({ resetCredits: { available: NaN } }), null);
assert.equal(codexResets({ resetCredits: { available: null } }), null, "null -> 0 -> no reset");
assert.equal(codexResets({ resetCredits: null }), null);
assert.equal(codexResets("codex"), null, "non-object record: no resetCredits");
assert.equal(codexResets(42), null);
assert.equal(codexResets({ resetCredits: { available: 1, nextExpiresAt: 1735689600000 } })?.expiresAt, "", "epoch-number expiry is not parsed");
// An already-expired credit is still reported (no expiry check here).
assert.deepEqual(codexResets({ resetCredits: { available: 1, nextExpiresAt: "2020-01-01T00:00:00Z" } }),
  { left: 1, usableNow: true, expiresAt: "2020-01-01T00:00:00.000Z" }, "past expiry still returned");

// ------------------------------------------------------- 1. full record, end to end
{
  const ctx = setup();
  ctx.writeRecord({
    ready: true,
    tierLabel: "ChatGPT Plus",
    limits: [
      { title: "Session", label: "5-hour", percent: 0.42, resetsAt: future(2 * HOUR) },
      { title: "Weekly", percent: 0.9, resetsAt: future(3 * DAY) },
      { label: "Monthly usage", percent: 0.1 }, // no title -> titleFor(label) -> "Monthly"
    ],
    recentDays: [
      { date: TODAY, messageCount: 1234 },
      { date: YEST, messageCount: null },   // null -> 0, not dropped
      { date: DAYS_AGO_3, messageCount: "77" }, // numeric string coerced
    ],
    modelUsage: { "gpt-5.2-codex": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10, cacheCreationInputTokens: 5 } },
    resetCredits: { available: 2, nextExpiresAt: "2027-01-01T00:00:00Z" },
  });
  const r = ctx.run();
  assert.equal(r.status, 0, `collect failed:\n${r.stderr}`);
  const c = r.codex;
  assert.ok(c, "codex agent emitted");
  assert.equal(c.installed, true);
  assert.equal(c.plan, "ChatGPT Plus");
  assert.equal(c.signedIn, true);
  assert.equal(c.status, "");
  assert.equal(c.modelScope, "all time");
  assert.equal(c.unsure, undefined, "codex has no stale-reading flag (that is Claude-only)");
  assert.equal(c.limitsFetchedAt, undefined, "no fetchedAt tracking for builtin records");

  assert.equal(c.limits.length, 3);
  const byTitle = Object.fromEntries(c.limits.map((l) => [l.title, l]));
  assert.equal(byTitle.Session.percent, 0.42);
  assert.equal(byTitle.Session.resetsAt, c.limits.find((l) => l.title === "Session").resetsAt);
  assert.ok(Date.parse(byTitle.Session.resetsAt) > Date.now(), "future resetsAt preserved");
  assert.equal(byTitle.Weekly.percent, 0.9);
  assert.equal(byTitle.Monthly.percent, 0.1, "label-only limit gets a titleFor() title");
  assert.equal(byTitle.Monthly.resetsAt, "");

  assert.deepEqual(c.resets, { left: 2, usableNow: true, expiresAt: "2027-01-01T00:00:00.000Z" });

  assert.equal(c.days.length, 7);
  const dayTok = (d) => c.days.find((x) => x.date === d)?.tokens;
  assert.equal(dayTok(TODAY), 1234);
  assert.equal(dayTok(YEST), 0, "null messageCount becomes 0");
  assert.equal(dayTok(DAYS_AGO_3), 77, "numeric string coerced");
  assert.equal(c.today, 1234);
  assert.equal(c.hasTokens, true);

  const used = c.models.find((m) => m.name === "GPT-5.2 Codex");
  assert.ok(used, "used model row present");
  assert.equal(used.total, 165);
  assert.equal(used.state, "used");
  assert.ok(!c.models.some((m) => m.id === "internal-only"), "visibility!=list models stay out");
  assert.ok(c.models.some((m) => m.id === "gpt-5-2-codex-mini"), "live-only models still listed");

  const upd = fs.existsSync(ctx.updateLog) ? fs.readFileSync(ctx.updateLog, "utf8") : "";
  assert.match(upd, /\bcodex\b/, "codex is a builtin refresh target");
  ctx.cleanup();
}

// ------------------------------------------- 2. malformed / missing record file
{
  const ctx = setup();
  ctx.writeRaw("{ this is not json");
  let r = ctx.run();
  assert.equal(r.status, 0, `malformed JSON must not kill the collector:\n${r.stderr}`);
  assert.equal(r.codex.status, "No usage recorded yet.");
  assert.equal(r.codex.signedIn, undefined, "no record -> signedIn field never set");
  assert.deepEqual(r.codex.limits, []);
  assert.equal(r.codex.plan, "");
  assert.equal(r.codex.resets ?? null, null);
  assert.match(ctx.collectorLog(), /isn't readable JSON/, "malformed record is diagnosed");

  fs.rmSync(ctx.recordFile);
  r = ctx.run();
  assert.equal(r.status, 0);
  assert.equal(r.codex.status, "No usage recorded yet.", "absent record: same calm status");
  ctx.cleanup();
}

// --------------------------- 3. KNOWN BUG: malformed shapes crash collect.mjs
// fromBuiltin() never validates r.limits / r.recentDays before iterating them.
// Each case below exits non-zero today; asserted so a future fix flips them.
for (const [label, record] of [
  ["limits is an object", { ready: true, limits: { session: { percent: 0.5 } } }],
  ["limits contains null", { ready: true, limits: [null, { title: "Weekly", percent: 0.5 }] }],
  ["recentDays is an object", { ready: true, recentDays: {} }],
  ["recentDays contains null", { ready: true, recentDays: [{ date: TODAY, messageCount: 1 }, null] }],
]) {
  const ctx = setup();
  ctx.writeRecord(record);
  const r = ctx.run();
  // BUG (not fixed per task): a malformed Omarchy record crashes the whole run.
  assert.notEqual(r.status, 0, `${label}: collector should survive, currently crashes`);
  assert.match(r.stderr, /TypeError/, `${label}: crash is a TypeError in fromBuiltin`);
  ctx.cleanup();
}

// ------------------------------------- 4. record shapes that parse but are odd
{
  const ctx = setup();
  ctx.writeRaw('"just a string"'); // valid JSON, not an object
  let r = ctx.run();
  assert.equal(r.status, 0, `string record must not crash:\n${r.stderr}`);
  assert.equal(r.codex.status, "", "a truthy non-object record is treated as present-but-empty");
  assert.equal(r.codex.signedIn, false);
  assert.deepEqual(r.codex.limits, []);
  assert.equal(r.codex.plan, "");

  ctx.writeRaw("null"); // valid JSON null -> same as missing file
  r = ctx.run();
  assert.equal(r.status, 0);
  assert.equal(r.codex.status, "No usage recorded yet.", "JSON null record = no record");
  ctx.cleanup();
}

// ------------------------------------------------------- 5. ready/status text
{
  const ctx = setup();
  ctx.writeRecord({ ready: false, usageStatusText: "Sign in with ChatGPT to see usage", authHelpText: "fallback text" });
  let r = ctx.run();
  assert.equal(r.status, 0);
  assert.equal(r.codex.status, "Sign in with ChatGPT to see usage", "usageStatusText wins over authHelpText");
  assert.equal(r.codex.signedIn, false);

  ctx.writeRecord({ ready: false, authHelpText: "Run `codex login` first" });
  r = ctx.run();
  assert.equal(r.codex.status, "Run `codex login` first", "authHelpText is the fallback");

  ctx.writeRecord({ ready: "yes", limits: [{ title: "Weekly", percent: 0.5 }] });
  r = ctx.run();
  assert.equal(r.status, 0);
  assert.equal(r.codex.signedIn, false, "signedIn requires ready === true strictly");
  assert.equal(r.codex.status, "", "ready:false-only status path; truthy non-boolean ready gives none");
  assert.equal(r.codex.limits.length, 1, "limits still read when ready is not a boolean");
  ctx.cleanup();
}

// ------------------------------------------------- 6. percent boundaries/filters
{
  const ctx = setup();
  ctx.writeRecord({
    ready: true,
    tierLabel: "Pro",
    limits: [
      { title: "Session", percent: 0, resetsAt: future() },
      { title: "Weekly", percent: 0.6, resetsAt: future() },
      { title: "Daily", percent: 0.85, resetsAt: future() },
      { title: "Monthly", percent: 1, resetsAt: future() },
      { title: "Bonus Weekly", percent: 1, resetsAt: future() }, // watched title at 100%
      { title: "Spare", percent: 1.4, resetsAt: future() },   // clamped to 1
      { title: "Over", percent: -0.2 },                        // dropped (< 0)
      { title: "Text", percent: "0.5" },                       // numeric string kept
      { title: "Flag", percent: true },                        // boolean -> 1
      { title: "Absent" },                                     // missing -> dropped
      { title: "Junk", percent: "high" },                      // NaN -> dropped
    ],
  });
  const r = ctx.run();
  assert.equal(r.status, 0, `percent edge cases crashed:\n${r.stderr}`);
  const got = Object.fromEntries(r.codex.limits.map((l) => [l.title, l.percent]));
  assert.deepEqual(got, {
    Session: 0, Weekly: 0.6, Daily: 0.85, Monthly: 1, "Bonus Weekly": 1, Spare: 1, Text: 0.5, Flag: 1,
  }, "0 kept, >1 clamped, negatives/missing/NaN dropped, strings and booleans coerced");
  assert.ok(r.notifyLines.some((l) => l.includes("limit reached") && l.includes("Codex")),
    "a watched meter at 100% fires the once-per-window limit notification");
  ctx.cleanup();
}

// ------------------------------------------------------- 7. resetsAt handling
{
  const ctx = setup();
  const pastIso = past();
  ctx.writeRecord({
    ready: true,
    limits: [
      { title: "OldHigh", percent: 0.5, resetsAt: pastIso },   // expired window -> zeroed
      { title: "OldZero", percent: 0, resetsAt: pastIso },     // already 0 -> untouched
      { title: "Future", percent: 0.5, resetsAt: future() },
      { title: "NoDate", percent: 0.5 },
      { title: "BadDate", percent: 0.5, resetsAt: "soon" },    // unparseable -> kept + diagnosed
    ],
  });
  const r = ctx.run();
  assert.equal(r.status, 0, `resetsAt cases crashed:\n${r.stderr}`);
  const byTitle = Object.fromEntries(r.codex.limits.map((l) => [l.title, l]));
  assert.equal(byTitle.OldHigh.percent, 0, "past resetsAt + usage > 0 shows as reset");
  assert.equal(byTitle.OldHigh.resetsAt, "");
  assert.equal(byTitle.OldHigh.note, "Reset, waiting for fresh data.");
  assert.equal(byTitle.OldZero.percent, 0);
  assert.equal(byTitle.OldZero.resetsAt, pastIso, "a 0% meter keeps its stale resetsAt (current behaviour)");
  assert.equal(byTitle.Future.percent, 0.5);
  assert.equal(byTitle.NoDate.resetsAt, "");
  assert.equal(byTitle.BadDate.resetsAt, "soon", "unparseable resetsAt passes through raw");
  assert.equal(byTitle.BadDate.percent, 0.5);
  assert.match(r.codex.dataWarning || "", /Data looks wrong/, "bad resetsAt is diagnosed");
  ctx.cleanup();
}

// ------------------------------------------- 8. recentDays / modelUsage edges
{
  const ctx = setup();
  ctx.writeRecord({
    ready: true,
    recentDays: [
      { date: TODAY, messageCount: 50 },
      { date: YEST, messageCount: 0 },
      { date: DAYS_AGO_5, messageCount: -5 },        // negative passes through -> diagnosed
      { date: DAYS_AGO_3, messageCount: "88" },
      { date: "not-a-date", messageCount: 999 },     // outside last-7 -> ignored in output
      { messageCount: 7 },                           // no date -> days["undefined"], ignored
      {},                                            // neither -> 0 under "undefined"
    ],
    modelUsage: {
      good: { inputTokens: 10, outputTokens: 5 },
      neg: { inputTokens: -3, outputTokens: 1 },     // negative total -> diagnosed
      partial: { inputTokens: 4 },                   // missing counts -> 0
    },
  });
  const r = ctx.run();
  assert.equal(r.status, 0, `token edge cases crashed:\n${r.stderr}`);
  const tok = (d) => r.codex.days.find((x) => x.date === d)?.tokens;
  assert.equal(tok(TODAY), 50);
  assert.equal(tok(YEST), 0);
  assert.equal(tok(DAYS_AGO_5), -5, "negative messageCount is shown as-is (current behaviour)");
  assert.equal(tok(DAYS_AGO_3), 88);
  assert.equal(r.codex.today, 50);
  assert.match(r.codex.dataWarning || "", /Data looks wrong/, "negative day tokens and model total are diagnosed");
  const models = Object.fromEntries(r.codex.models.map((m) => [m.name, m]));
  assert.equal(models.good?.total, 15);
  assert.equal(models.good?.state, "used");
  assert.equal(models.partial?.total, 4, "missing token fields count as 0");
  assert.equal(models.neg?.total, -2, "negative model total kept (current behaviour)");
  ctx.cleanup();
}

// modelUsage that isn't an object must not crash either.
{
  const ctx = setup();
  ctx.writeRecord({ ready: true, modelUsage: "junk" });
  const r = ctx.run();
  assert.equal(r.status, 0, `string modelUsage crashed:\n${r.stderr}`);
  assert.ok(Array.isArray(r.codex.models));
  ctx.cleanup();
}

// ------------------------------------------- 9. resetCredits through the pipeline
{
  const ctx = setup();
  ctx.writeRecord({ ready: true, tierLabel: "Pro", resetCredits: { available: "2", nextExpiresAt: "2027-06-01T00:00:00Z" } });
  const r = ctx.run();
  assert.equal(r.status, 0);
  assert.equal(r.codex.resets?.left, 2, "numeric-string available accepted end to end");
  ctx.cleanup();
}

// ------------------------------------------------------------- 10. accounts
{
  const ctx = setup();
  ctx.writeRecord({ ready: true, tierLabel: "Pro", limits: [{ title: "Weekly", percent: 0.3, resetsAt: future() }] });
  fs.writeFileSync(ctx.accountsFile, JSON.stringify([{
    provider: "codex",
    accounts: [
      { id: "main", label: "Main", plan: "Pro", active: true, signedIn: true,
        limits: [{ label: "Weekly", percent: 0.4, resetsAt: future() }] },
      { id: "work", label: "Work", plan: "Pro", active: false, signedIn: true,
        limits: [
          { label: "Session", percent: 0.5, resetsAt: future() },
          { label: "On-demand spend", percent: 0.9 },   // money meter: filtered out
          { label: "Weekly", percent: 1.4, resetsAt: future() }, // clamped to 1
        ] },
      { id: "old", label: "Old", signedIn: false, limits: [] }, // signed out: dropped
    ],
  }]));
  const r = ctx.run();
  assert.equal(r.status, 0, `accounts run failed:\n${r.stderr}`);
  const accs = r.codex.accounts;
  assert.equal(accs.length, 2, "only signed-in accounts with 2+ total are emitted");
  assert.deepEqual(accs.map((a) => a.id), ["main", "work"]);
  assert.equal(accs[0].active, true);
  assert.equal(accs[1].active, false);
  const work = Object.fromEntries(accs[1].limits.map((l) => [l.title, l.percent]));
  assert.deepEqual(work, { Session: 0.5, Weekly: 1 }, "account limits clamped; spend meter filtered");
  assert.equal(accs[1].limits.find((l) => l.title === "Weekly").resetsAt !== "", true);
  ctx.cleanup();
}

// --------------------------- 11. reset celebration + alert, once per window
{
  const ctx = setup();
  // Seed the previous data.json so the next run sees a >50-point drop.
  fs.mkdirSync(ctx.outDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.outDir, "data.json"), JSON.stringify({
    schemaVersion: 1, generatedAt: Date.now(),
    agents: [{ id: "codex", name: "Codex", limits: [
      { title: "Session", percent: 0.9, resetsAt: future() },
      { title: "Weekly", percent: 0.2, resetsAt: future() },
    ] }],
  }));
  ctx.writeRecord({ ready: true, tierLabel: "Pro", limits: [
    { title: "Session", percent: 0.2, resetsAt: future() },
    { title: "Weekly", percent: 0.2, resetsAt: future() },
  ] });
  let r = ctx.run();
  assert.equal(r.status, 0, `celebration run failed:\n${r.stderr}`);
  assert.ok(r.codex.resetAt, "a >50-point drop flags the agent for the panel flash");
  assert.deepEqual(r.codex.resetWindows, ["Session"]);
  // Codex is not a SURPRISE_AGENTS member: even though the previous resetsAt is
  // still in the future, the kind is honestly "scheduled".
  assert.equal(r.codex.resetKind, "scheduled", "codex early drops are never claimed as surprise resets");
  assert.ok(r.notifyLines.some((l) => l.includes("go cook") && l.includes("Codex")), "reset notification sent");

  r = ctx.run(); // same env: prev is now the post-reset record
  assert.equal(r.status, 0);
  assert.equal(r.notifyLines.filter((l) => l.includes("go cook")).length, 1,
    "the same window never celebrates twice");
  ctx.cleanup();
}

// Alert once per window: Weekly at 100% notifies once, not on every refresh.
{
  const ctx = setup();
  ctx.writeRecord({ ready: true, limits: [{ title: "Weekly", percent: 1, resetsAt: future(3 * DAY) }] });
  let r = ctx.run();
  assert.equal(r.status, 0);
  const limitMsgs = () => r.notifyLines.filter((l) => l.includes("limit reached")).length;
  assert.equal(limitMsgs(), 1, "limit-level alert fired once");
  r = ctx.run();
  assert.equal(r.status, 0);
  assert.equal(limitMsgs(), 1, "same window does not re-alert on refresh");
  ctx.cleanup();
}

console.log("codex-deep: all tests passed");
