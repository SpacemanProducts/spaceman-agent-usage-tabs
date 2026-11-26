import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Deep test for bin/collect.mjs. collect.test.mjs already proves the happy
// path (clean scratch HOME, every tab emitted, exit 0) and
// collect-freebuff-kilo.test.mjs covers localUsageFields; this file goes after
// the edges those leave open, each scenario in its own fresh
// HOME/XDG_STATE_HOME/XDG_CONFIG_HOME/XDG_DATA_HOME/XDG_CACHE_HOME:
//
//   1. corrupt-state   every persisted state file present but unparseable or a
//                      JSON primitive of the wrong shape; a builtin usage record
//                      that parses but carries wrong-typed fields; a builtin
//                      record that isn't JSON at all. The run must still exit 0,
//                      collect, and rewrite the state files it owns.
//   2. builtin-fields  fromBuiltin's field mapping end to end: percent
//                      clamping, past-reset expiry, plan-limit filtering,
//                      wrong-typed entries dropped, recentDays -> days,
//                      modelUsage -> models, and the handoff note written into
//                      a scratch git repo once a Session meter passes 90%.
//   3. reset-celebration  a >50-point drop celebrates once (resetAt /
//                      reset-fired.json / history resets count), and an
//                      immediate second refresh keeps the in-progress flash
//                      instead of celebrating again.
//   4. claude-cache    the 5-minute limits cache around clock edges: a
//                      limitsFetchedAt in the FUTURE still counts as fresh, a
//                      10-minute-old one is stale, and expired credentials
//                      keep last-known limits with an honest status.
//   5. concurrent      two collect.mjs processes on the same state dir at once
//                      (atomic data.json rename, per-pid history tmp) plus
//                      argv edge cases (--notify with no value, non-numeric
//                      --volume/--notify).
//   6. reset-fired     a reset-fired.json holding a JSON primitive is treated
//                      as empty state instead of crashing applyResets.
//   7. resets-at       fromBuiltin keeps only a valid ISO resetsAt; numbers and
//                      junk strings count as missing.
//
// Every file a run touches lives under one mkdtemp dir per scenario; nothing
// here reads or writes the real home folder.

const here = path.dirname(fileURLToPath(import.meta.url));
const COLLECT = path.join(here, "collect.mjs");
const tmpdirs = [];
const mkTmp = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `collect-deep-${tag}-`)); tmpdirs.push(d); return d; };

const localDateStr = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const iso = (ms) => new Date(ms).toISOString();
const FUTURE = iso(Date.now() + 6 * 3600 * 1000);
const PAST = iso(Date.now() - 3600 * 1000);

// A scratch environment. `fakes` are executable shell scripts dropped on PATH
// so isInstalled() sees them; only `agy`/`antigravity` exist in /usr/bin on
// Omarchy, so Antigravity is always the one "real" installed tab. The
// live-models cache is pre-seeded fresh for it so `agy models` never spawns.
// `omarchy-agent-usage-update` and `omarchy-agent-account-list` are shadowed
// on PATH: the real update would overwrite any crafted agents/usage/*.json
// record before collect.mjs reads it back, and the real account list would
// make runs depend on this machine's logins. A no-op update + empty account
// list keeps every builtin record exactly as the test wrote it.
function makeEnv(tag, { fakes = [] } = {}) {
  const dir = mkTmp(tag);
  const home = path.join(dir, "home");
  const xdg = path.join(dir, "xdg");
  const fakeBin = path.join(dir, "bin");
  const outDir = path.join(xdg, "omarchy", "agent-usage-tabs");
  const builtinDir = path.join(xdg, "omarchy", "agents", "usage");
  for (const d of [
    path.join(home, ".claude"), outDir, builtinDir, fakeBin,
    path.join(dir, "xdg-runtime"), path.join(dir, "agy-home"),
    path.join(dir, "xdg-config"), path.join(dir, "xdg-data"), path.join(dir, "xdg-cache"),
  ]) fs.mkdirSync(d, { recursive: true });
  const scripts = {
    "omarchy-agent-usage-update": "#!/bin/sh\nexit 0\n",
    "omarchy-agent-account-list": "#!/bin/sh\necho '[]'\n",
    ...Object.fromEntries(fakes.map((b) => [b, "#!/bin/sh\nexit 0\n"])),
  };
  for (const [b, src] of Object.entries(scripts)) fs.writeFileSync(path.join(fakeBin, b), src, { mode: 0o755 });
  fs.writeFileSync(path.join(outDir, "live-models.json"),
    JSON.stringify({ antigravity: { at: Date.now(), models: [{ id: "m", name: "M" }] } }));
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: xdg,
    XDG_CONFIG_HOME: path.join(dir, "xdg-config"),
    XDG_DATA_HOME: path.join(dir, "xdg-data"),
    XDG_CACHE_HOME: path.join(dir, "xdg-cache"),
    XDG_RUNTIME_DIR: path.join(dir, "xdg-runtime"),
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
    DISPLAY: "", WAYLAND_DISPLAY: "",
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    GROK_HOME: path.join(home, ".grok"),
    AGY_DIR: path.join(dir, "agy-home"),
    PATH: `${fakeBin}:/usr/bin:/bin`,
  };
  return { dir, home, xdg, fakeBin, outDir, builtinDir, env };
}

// --notify 101 keeps every percent under the warn threshold and --volume 0
// keeps the cha-ching off; notify-send itself can never reach a session bus.
function runCollect(env, args = ["--notify", "101", "--volume", "0"], timeout = 240000) {
  return spawnSync(process.execPath, [COLLECT, ...args], { encoding: "utf8", env, timeout });
}
const readJsonFile = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const readData = (outDir) => readJsonFile(path.join(outDir, "data.json"));
const agentOf = (data, id) => data.agents.find((a) => a.id === id);
const noTmpLeft = (outDir) =>
  fs.readdirSync(outDir).filter((n) => n.includes(".tmp")).length === 0;

try {
  // ---------------------------------------------------------- 1. corrupt state
  {
    const e = makeEnv("corrupt", { fakes: ["codex", "cursor-agent"] });
    // Every file collect.mjs reads back is present but wrong: unparseable JSON,
    // or valid JSON of a shape it can't use (a primitive where an object/map
    // belongs). live-models.json stays valid so `agy models` is never spawned.
    const junk = {
      "data.json": "{not json",
      "settings.json": "[1,2,",
      "agent-logins.json": "}",
      "agent-installs.json": "nullx",
      "notified.json": "5",
      "handoff-fired.json": "\"str\"",
      "reset-fired.json": "true",
      "history.json": "corrupt{",
      "diag-state.json": "[",
      "squad-dir": "42",
    };
    for (const [name, content] of Object.entries(junk)) fs.writeFileSync(path.join(e.outDir, name), content);
    // codex.json parses but every field is the wrong type; cursor.json isn't JSON.
    fs.writeFileSync(path.join(e.builtinDir, "codex.json"), JSON.stringify({
      limits: "nope", recentDays: { a: 1 }, modelUsage: [1, 2],
      usageStatusText: 42, authHelpText: null, ready: "yes", tierLabel: "Pro",
    }));
    fs.writeFileSync(path.join(e.builtinDir, "cursor.json"), "garbage{{{");

    const r = runCollect(e.env);
    assert.equal(r.status, 0, `collect.mjs died on corrupt state:\n${r.stderr}\n${r.stdout}`);
    const data = readData(e.outDir);
    assert.equal(data.schemaVersion, 1);
    const codex = agentOf(data, "codex");
    assert.equal(codex.installed, true);
    assert.deepEqual(codex.limits, [], "wrong-typed limits count as missing, never fabricated");
    assert.ok(codex.dataWarning, "diagnostics surface the bad record on the tab");
    const cursor = agentOf(data, "cursor");
    assert.equal(cursor.installed, true);
    assert.equal(cursor.status, "No usage recorded yet.", "unreadable builtin record -> calm status, no meters");
    const log = fs.readFileSync(path.join(e.outDir, "collector.log"), "utf8");
    assert.match(log, /aren't a list/, "collector.log records the wrong-typed fields");
    assert.match(log, /isn't readable JSON/, "collector.log records the unparseable record");
    // The state files collect.mjs owns were rewritten as valid JSON.
    for (const name of ["agent-logins.json", "agent-installs.json", "notified.json", "handoff-fired.json", "history.json", "diag-state.json"]) {
      const v = readJsonFile(path.join(e.outDir, name));
      assert.ok(v !== null && typeof v === "object" && !Array.isArray(v), `${name} rewritten as a JSON object`);
    }
    assert.equal(readJsonFile(path.join(e.outDir, "history.json")).schemaVersion, 1);
    assert.ok(noTmpLeft(e.outDir), "no *.tmp leftovers after the atomic writes");
  }

  // ------------------------------------------- 2. builtin record field mapping
  {
    const e = makeEnv("fields", { fakes: ["codex"] });
    const repo = path.join(e.dir, "repo");
    fs.mkdirSync(repo);
    spawnSync("git", ["init", "-q", repo]);
    // handoffNote on + a squad-dir pointer make maybeWriteHandoff write for real.
    fs.writeFileSync(path.join(e.outDir, "settings.json"), JSON.stringify({ handoffNote: true }));
    fs.writeFileSync(path.join(e.outDir, "squad-dir"), `${repo}\n`);
    const today = localDateStr(Date.now());
    const yesterday = localDateStr(Date.now() - 86400000);
    fs.writeFileSync(path.join(e.builtinDir, "codex.json"), JSON.stringify({
      tierLabel: "Pro", ready: true, usageStatusText: "a note that must not leak",
      limits: [
        { title: "Session", percent: 0.95, resetsAt: FUTURE },
        { title: "Weekly", percent: 1.7, resetsAt: FUTURE },   // clamps to 1
        { title: "Old window", percent: 0.8, resetsAt: PAST }, // expired -> 0 + note
        { title: "Spend cap", percent: 0.9, resetsAt: FUTURE }, // not a plan limit -> dropped
        { title: "Bad pct", percent: "abc", resetsAt: FUTURE }, // NaN -> dropped
        "junk", null, 7,                                       // non-objects -> dropped
        { percent: 0.5 },                                      // no title -> "Limit"
      ],
      recentDays: [
        { date: yesterday, messageCount: 10 },
        { date: today, messageCount: "5" },   // numeric strings coerce
        { date: 123, messageCount: 9 },       // non-string date -> skipped
        "junk",
        { messageCount: 3 },                  // no date -> skipped
      ],
      modelUsage: {
        "b-model": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 15 },
        "a-model": { inputTokens: 1, outputTokens: 1 },
      },
    }));

    const r = runCollect(e.env);
    assert.equal(r.status, 0, `collect.mjs failed:\n${r.stderr}\n${r.stdout}`);
    const codex = agentOf(readData(e.outDir), "codex");
    assert.equal(codex.installed, true);
    assert.equal(codex.plan, "Pro");
    assert.equal(codex.signedIn, true);
    assert.equal(codex.status, "");
    assert.ok(!("note" in codex), "the internal note field never reaches data.json");

    const byTitle = Object.fromEntries(codex.limits.map((l) => [l.title, l]));
    assert.equal(codex.limits.length, 4, JSON.stringify(codex.limits));
    assert.equal(byTitle.Session.percent, 0.95);
    assert.equal(byTitle.Session.resetsAt, FUTURE);
    assert.equal(byTitle.Weekly.percent, 1, "percent above 1 clamps to 1");
    assert.equal(byTitle["Old window"].percent, 0, "a past reset time expires the meter");
    assert.equal(byTitle["Old window"].resetsAt, "");
    assert.match(byTitle["Old window"].note, /Reset, waiting for fresh data/);
    assert.equal(byTitle["Spend cap"], undefined, "money meters are filtered out");
    assert.equal(byTitle["Bad pct"], undefined);
    assert.equal(byTitle.Limit.percent, 0.5, "a title-less limit falls back to 'Limit'");

    assert.equal(codex.days.length, 7);
    assert.equal(codex.days.find((d) => d.date === today).tokens, 5);
    assert.equal(codex.days.find((d) => d.date === yesterday).tokens, 10);
    assert.equal(codex.today, 5);
    assert.equal(codex.hasTokens, true);
    assert.equal(codex.modelScope, "all time");
    const bm = codex.models.find((m) => /b-model/i.test(m.rawId || m.name || ""));
    assert.ok(bm, "modelUsage row survives the models pipeline");
    assert.equal(bm.total, 165);
    assert.equal(bm.state, "used");

    // Session at 95% crossed the fixed 90% handoff trigger: the note was
    // written into the scratch repo and remembered for this window.
    const note = path.join(repo, "handoff", "HANDOFF.md");
    assert.ok(fs.existsSync(note), "handoff/HANDOFF.md written");
    const noteText = fs.readFileSync(note, "utf8");
    assert.match(noteText, /Handoff/);
    assert.match(noteText, /Codex/);
    assert.match(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8"), /cook-meter-handoff/);
    assert.match(fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8"), /handoff\//);
    const fired = readJsonFile(path.join(e.outDir, "handoff-fired.json"));
    assert.ok(Object.keys(fired).some((k) => k.startsWith("handoff|codex|Session")), "handoff window remembered");
  }

  // ------------------------------------------- 3. reset celebration, once
  {
    const e = makeEnv("reset", { fakes: ["codex"] });
    const prev = {
      schemaVersion: 1, version: "test", generatedAt: Date.now(), weekly: null,
      agents: [{
        id: "codex", name: "Codex", installed: true, plan: "Pro", status: "",
        limits: [{ title: "Session", percent: 0.97, resetsAt: FUTURE }],
        models: [], modelScope: "", days: [], today: 0, hasTokens: false,
        signedIn: true, resets: null,
      }],
    };
    fs.writeFileSync(path.join(e.outDir, "data.json"), JSON.stringify(prev));
    fs.writeFileSync(path.join(e.builtinDir, "codex.json"), JSON.stringify({
      tierLabel: "Pro", ready: true, usageStatusText: "",
      limits: [{ title: "Session", percent: 0.2, resetsAt: FUTURE }],
      recentDays: [], modelUsage: {},
    }));

    const r1 = runCollect(e.env);
    assert.equal(r1.status, 0, `collect.mjs failed:\n${r1.stderr}\n${r1.stdout}`);
    const codex = agentOf(readData(e.outDir), "codex");
    assert.ok(Number.isFinite(codex.resetAt), "a >50-point drop flags the agent for the panel");
    assert.equal(codex.resetKind, "scheduled", "codex has no surprise-reset wording");
    assert.deepEqual(codex.resetWindows, ["Session"]);
    const fired1 = readJsonFile(path.join(e.outDir, "reset-fired.json"));
    assert.deepEqual(Object.keys(fired1), ["codex|Session"]);
    const hist = readJsonFile(path.join(e.outDir, "history.json"));
    assert.equal(hist.days[localDateStr(Date.now())]?.codex?.resets, 1, "the celebration counts in usage history");

    // An immediate second refresh: no new drop, but the in-progress flash is
    // kept alive rather than dropped — the panel relies on resetAt surviving.
    const r2 = runCollect(e.env);
    assert.equal(r2.status, 0, `second collect.mjs failed:\n${r2.stderr}\n${r2.stdout}`);
    const codex2 = agentOf(readData(e.outDir), "codex");
    assert.ok(Number.isFinite(codex2.resetAt), "an in-progress flash survives the next refresh");
    assert.equal(codex2.resetKind, "scheduled");
    assert.deepEqual(Object.keys(readJsonFile(path.join(e.outDir, "reset-fired.json"))), ["codex|Session"], "no double celebration");
  }

  // ------------------------------------------------------- 4. claude cache
  {
    const e = makeEnv("claude", { fakes: ["claude"] });
    const creds = path.join(e.home, ".claude", ".credentials.json");
    const prevWith = (limitsFetchedAt) => ({
      schemaVersion: 1, version: "test", generatedAt: Date.now(), weekly: null,
      agents: [{
        id: "claude", name: "Claude Code", installed: true, plan: "Pro", status: "",
        limits: [{ title: "Session", percent: 0.5, resetsAt: FUTURE }],
        limitsFetchedAt, models: [], modelScope: "", days: [], today: 0,
        hasTokens: false, signedIn: false, resets: null,
      }],
    });

    // A limitsFetchedAt in the FUTURE (clock skew) still counts as fresh: the
    // cached limits are used and no sign-in is demanded.
    fs.writeFileSync(path.join(e.outDir, "data.json"), JSON.stringify(prevWith(Date.now() + 3600 * 1000)));
    let r = runCollect(e.env);
    assert.equal(r.status, 0, `collect.mjs failed:\n${r.stderr}\n${r.stdout}`);
    let claude = agentOf(readData(e.outDir), "claude");
    assert.equal(claude.limits.length, 1, "fresh cache serves limits without a fetch");
    assert.equal(claude.limits[0].percent, 0.5);
    assert.equal(claude.plan, "Pro");
    assert.equal(claude.status, "");
    assert.ok(!claude.unsure, "a fresh reading is not flagged unsure");
    assert.ok(claude.limitsFetchedAt > Date.now(), "the future timestamp is carried through");
    assert.equal(claude.signedIn, false, "no credentials file -> signedIn false");

    // Ten minutes old is past the 5-minute cache window: with no credentials
    // the agent honestly reports it isn't signed in and shows no meters.
    fs.writeFileSync(path.join(e.outDir, "data.json"), JSON.stringify(prevWith(Date.now() - 10 * 60 * 1000)));
    r = runCollect(e.env);
    assert.equal(r.status, 0, `collect.mjs failed:\n${r.stderr}\n${r.stdout}`);
    claude = agentOf(readData(e.outDir), "claude");
    assert.deepEqual(claude.limits, [], "a stale cache is not served");
    assert.match(claude.status, /^Not signed in/, "missing credentials -> honest status");

    // Expired credentials keep the last-known limits (stale()) instead of
    // blanking the tab, with a status that says the sign-in expired. Run B
    // overwrote data.json with empty limits, so seed the previous reading again.
    fs.writeFileSync(path.join(e.outDir, "data.json"), JSON.stringify(prevWith(Date.now() - 10 * 60 * 1000)));
    fs.writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: "fake", expiresAt: 1, subscriptionType: "pro" } }));
    r = runCollect(e.env);
    assert.equal(r.status, 0, `collect.mjs failed:\n${r.stderr}\n${r.stdout}`);
    claude = agentOf(readData(e.outDir), "claude");
    assert.equal(claude.limits.length, 1, "expired sign-in falls back to last-known limits");
    assert.match(claude.status, /^Sign-in expired/, claude.status);
  }

  // ------------------------------------------------------- 5. concurrent runs
  {
    const e = makeEnv("concurrent");
    const run = (args) => new Promise((resolve) => {
      const c = spawn(process.execPath, [COLLECT, ...args], { env: e.env });
      let err = "";
      c.stderr.on("data", (d) => { err += d; });
      c.on("close", (code) => resolve({ code, err }));
    });
    // argv edges: "--notify" with no following value -> default 95; a
    // non-numeric --volume -> default; --notify 150 -> threshold above 100%.
    const [a, b] = await Promise.all([
      run(["--notify"]),
      run(["--volume", "abc", "--notify", "150"]),
    ]);
    assert.equal(a.code, 0, `run A failed:\n${a.err}`);
    assert.equal(b.code, 0, `run B failed:\n${b.err}`);
    const data = readData(e.outDir);
    assert.ok(Array.isArray(data.agents) && data.agents.length > 0);
    assert.ok(noTmpLeft(e.outDir), "concurrent atomic writes leave no tmp files");
  }

  // ------------------------------------------- 6. primitive reset-fired.json
  // (was BUG: readJson(RESET_FIRED) || {} handed a primitive to applyResets,
  // which then crashed assigning fired[key] — a TypeError in strict mode.)
  {
    const e = makeEnv("resetfired", { fakes: ["codex"] });
    const future = iso(Date.now() + 6 * 3600 * 1000);
    fs.writeFileSync(path.join(e.outDir, "reset-fired.json"), "5");
    fs.writeFileSync(path.join(e.outDir, "data.json"), JSON.stringify({
      schemaVersion: 1, agents: [{ id: "codex", limits: [{ title: "Session", percent: 0.97, resetsAt: future }] }],
    }));
    fs.writeFileSync(path.join(e.builtinDir, "codex.json"), JSON.stringify({
      limits: [{ title: "Session", percent: 0.2, resetsAt: future }],
    }));
    const r = runCollect(e.env);
    assert.equal(r.status, 0, `collect.mjs crashed on primitive reset-fired.json:\n${r.stderr}`);
    const fired = readJsonFile(path.join(e.outDir, "reset-fired.json"));
    assert.ok(fired && typeof fired === "object" && !Array.isArray(fired), "reset-fired.json rewritten as a plain object");
  }

  // ------------------------------------------- 7. non-string resetsAt
  // (was BUG: fromBuiltin passed l.resetsAt through raw, so a number like
  // 1893456000000 leaked into data.json — and a small one like 123 parsed as
  // year 123 and silently expired the meter.)
  {
    const e = makeEnv("resetsat", { fakes: ["codex"] });
    fs.writeFileSync(path.join(e.builtinDir, "codex.json"), JSON.stringify({
      ready: true, tierLabel: "Pro",
      limits: [
        { title: "Session", percent: 0.5, resetsAt: 1893456000000 },
        { title: "Weekly", percent: 0.5, resetsAt: "not a date" },
        { title: "Monthly", percent: 0.5, resetsAt: FUTURE },
      ],
    }));
    const r = runCollect(e.env);
    assert.equal(r.status, 0, `collect.mjs failed:\n${r.stderr}`);
    const codex = agentOf(readData(e.outDir), "codex");
    const byTitle = Object.fromEntries(codex.limits.map((l) => [l.title, l]));
    assert.equal(byTitle.Session.resetsAt, "", "a numeric resetsAt counts as missing");
    assert.equal(byTitle.Weekly.resetsAt, "", "a non-ISO resetsAt counts as missing");
    assert.equal(byTitle.Monthly.resetsAt, FUTURE, "a real ISO resetsAt survives");
    for (const l of codex.limits) assert.equal(typeof l.resetsAt, "string");
  }
} finally {
  for (const d of tmpdirs) fs.rmSync(d, { recursive: true, force: true });
}

// ---------------------------------------------------------------- BUGS FOUND
// Each was reproduced by hand against this worktree on 2026-11-25; the tests
// that would show them are kept here, commented out, per the job rules.
//
// BUG: a collector.log that is a directory (or otherwise unwritable) kills the
// whole run. diagnostics.mjs flush() calls fs.writeFileSync(logFile)
// unguarded, so once any agent produced a diagnostic the collector exits 1
// with EISDIR *after* doing all the collection work — data.json is never
// written. Verified: exit 1, "EISDIR: illegal operation on a directory".
//
//   // BUG: unwritable collector.log must not crash the collector
//   {
//     const e = makeEnv("bug-logdir", { fakes: ["codex"] });
//     fs.mkdirSync(path.join(e.outDir, "collector.log"), { recursive: true }); // a directory where the log file goes
//     fs.writeFileSync(path.join(e.builtinDir, "codex.json"), JSON.stringify({ limits: "nope" })); // forces a diagnostic
//     const r = runCollect(e.env);
//     assert.equal(r.status, 0, `collect.mjs crashed on an unwritable collector.log:\n${r.stderr}`);
//     assert.ok(fs.existsSync(path.join(e.outDir, "data.json")), "data.json still written");
//   }
//
// Fixed 2026-11-25 (now scenarios 6 and 7 above): a primitive reset-fired.json
// is treated as empty state, and fromBuiltin keeps only a valid ISO resetsAt.

console.log("collect.deep: all assertions passed");
