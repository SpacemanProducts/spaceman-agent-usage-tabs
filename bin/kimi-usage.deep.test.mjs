// Deep edge-case pass for bin/kimi-usage.mjs on top of kimi-usage.test.mjs.
// parseWireJsonl is pure; readKimiUsage only reads files, so every store it
// sees lives under one mkdtemp scratch with HOME/XDG_* pointed there. The
// module never spawns, never touches the network and keeps no state between
// calls, so "races" here mean sequential calls sharing nothing. Nothing here
// touches the real home folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseWireJsonl, readKimiUsage } from "./kimi-usage.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kimi-usage-deep-"));
const savedEnv = {};
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "KIMI_CODE_HOME"]) {
  savedEnv[k] = process.env[k];
  if (k === "KIMI_CODE_HOME") delete process.env[k];
  else {
    process.env[k] = path.join(tmp, k.toLowerCase());
    fs.mkdirSync(process.env[k], { recursive: true });
  }
}

const NOW = new Date(2026, 10, 24, 15, 30).getTime(); // 2026-11-24 local, mid-afternoon
const DAY = 86400000;
const p2 = (n) => String(n).padStart(2, "0");
const dateOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};
const at = (daysAgo, hour = 12) => NOW - daysAgo * DAY - (15 - hour) * 3600000;

// usage: pass a full usage object to control fields exactly (including
// omitting the "optional" cache fields); omit it for an all-zero record.
function rec({ agentId = "main", model = "kimi-for-coding", time, usage, scope } = {}) {
  const u = usage === undefined
    ? { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 }
    : usage;
  const o = { type: "usage.record", model, usage: u, usageScope: scope ?? "turn", time };
  if (agentId !== undefined) o.agentId = agentId;
  // agentId: null is kept (JSON null), only undefined drops the key.
  if (agentId === null) o.agentId = null;
  return JSON.stringify(o);
}
const ZERO_USAGE = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };

// A fake Kimi home: <root>/.kimi-code/sessions/... plus helpers to add files.
let homeN = 0;
function kimiHome() {
  const root = fs.mkdtempSync(path.join(tmp, `home-${homeN++}-`));
  return { root, sessions: path.join(root, ".kimi-code", "sessions") };
}
function wirePath(home, ws, sess, agent) {
  return path.join(home.sessions, ws, sess, "agents", agent, "wire.jsonl");
}
function addWire(home, ws, sess, agent, content) {
  const f = wirePath(home, ws, sess, agent);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return f;
}

try {
  // ---- parseWireJsonl: non-string input is String()-coerced ----
  for (const bad of [undefined, null, "", 0, false, NaN, {}, [], 10n]) {
    assert.deepEqual(parseWireJsonl(bad), [], `falsy/plain ${String(bad)} yields no records`);
  }
  // Truthy non-strings stringify into parseable text.
  const oneLine = rec({ time: 1000, usage: { ...ZERO_USAGE, output: 3 } });
  assert.equal(parseWireJsonl([oneLine]).length, 1, "a one-element array stringifies to its line");
  assert.equal(parseWireJsonl(Buffer.from(oneLine)).length, 1, "a Buffer stringifies to its text");
  assert.equal(parseWireJsonl({ toString: () => oneLine }).length, 1);
  assert.deepEqual(parseWireJsonl(Symbol("x")), [], "String(symbol) does not throw");
  assert.throws(() => parseWireJsonl({ toString() { throw new Error("nope"); } }), /nope/,
    "a throwing toString propagates");

  // ---- parseWireJsonl: the '"usage.record"' substring gate vs the type check ----
  assert.deepEqual(parseWireJsonl(JSON.stringify({ type: "note", text: 'say "usage.record" loudly' })), [],
    "the substring can appear inside another field; the type check still rejects it");
  assert.deepEqual(parseWireJsonl('{"type":"usage.record"} trailing'), [],
    "a line with the marker but trailing garbage is not valid JSON");
  assert.deepEqual(parseWireJsonl('{"outer":{"type":"usage.record","usage":{},"time":1}}'), [],
    "a nested usage.record is not a top-level record");
  assert.deepEqual(parseWireJsonl('"usage.record"'), [], "a bare JSON string is not a record");
  assert.deepEqual(parseWireJsonl('{"type":"usage.record","usage":[],"time":5}'), [],
    "usage as an array has no numeric fields");
  for (const usage of [null, "str", 5, true]) {
    assert.deepEqual(parseWireJsonl(JSON.stringify({ type: "usage.record", usage, time: 5 })), [],
      `usage=${JSON.stringify(usage)} is rejected`);
  }

  // ---- parseWireJsonl: field validation ----
  // Every one of the four fields must be a finite number >= 0, or the whole
  // record is dropped.
  for (const bad of [-1, "5", true, null, NaN, Infinity, -Infinity]) {
    const line = rec({ time: 1, usage: { ...ZERO_USAGE, output: 5, inputOther: bad } });
    assert.deepEqual(parseWireJsonl(line), [], `inputOther=${String(bad)} drops the record`);
  }
  // Floats and -0 are accepted.
  assert.equal(parseWireJsonl(rec({ time: 1, usage: { ...ZERO_USAGE, output: 2.5, inputOther: -0 } }))[0].tokens, 2.5,
    "fractional and negative-zero counts are finite numbers >= 0");
  // An all-zero record carries no usage and is skipped.
  assert.deepEqual(parseWireJsonl(rec({ time: 1, usage: ZERO_USAGE })), [], "zero tokens is not a record");
  // BUG: the module header documents inputCacheRead?/inputCacheCreation? as
  // optional, but parseWireJsonl requires ALL four fields to be finite
  // numbers — a record missing a cache field is dropped entirely, undercounting
  // real usage on turns that never touched the cache.
  // const noCache = JSON.stringify({ type: "usage.record", agentId: "a", model: "m",
  //   usage: { inputOther: 10, output: 5 }, time: 1 });
  // assert.equal(parseWireJsonl(noCache).length, 1, "missing optional cache fields should still count");
  assert.deepEqual(parseWireJsonl(JSON.stringify({ type: "usage.record", agentId: "a", model: "m",
    usage: { inputOther: 10, output: 5 }, time: 1 })), [],
    "currently: a record without the cache fields is rejected outright");
  // Extra usage fields are ignored; only the four known fields count.
  assert.equal(parseWireJsonl(rec({ time: 1, usage: { ...ZERO_USAGE, output: 4, costUsd: 999 } }))[0].tokens, 4);
  // time must be a finite number; 0 and negatives are fine (they just fall
  // outside the 30-day window later).
  assert.equal(parseWireJsonl(rec({ time: 0, usage: { ...ZERO_USAGE, output: 1 } }))[0].time, 0,
    "epoch time 0 is a valid finite number");
  assert.equal(parseWireJsonl(rec({ time: -5, usage: { ...ZERO_USAGE, output: 1 } }))[0].time, -5);
  for (const bad of ["1000", null, NaN, Infinity, true]) {
    const line = JSON.stringify({ type: "usage.record", usage: { ...ZERO_USAGE, output: 1 }, time: bad });
    assert.deepEqual(parseWireJsonl(line), [], `time=${String(bad)} drops the record`);
  }
  // model falls back to "unknown" for missing/empty/non-string.
  for (const [model, want] of [[undefined, "unknown"], [null, "unknown"], ["", "unknown"], [42, "unknown"], [" ", " "]]) {
    const line = JSON.stringify({ type: "usage.record", model, usage: { ...ZERO_USAGE, output: 2 }, time: 1 });
    assert.equal(parseWireJsonl(line)[0].model, want, `model=${JSON.stringify(model)}`);
  }
  // Model names are case-sensitive in the dedupe key.
  const mk = (model) => JSON.stringify({ type: "usage.record", agentId: "a", model, usage: { ...ZERO_USAGE, output: 1 }, time: 1 });
  assert.notEqual(parseWireJsonl(mk("Kimi"))[0].key, parseWireJsonl(mk("kimi"))[0].key,
    "'Kimi' and 'kimi' are different models");
  // usageScope is not part of the dedupe key: same agent/time/model/counts
  // with a different scope still produces the same key (parse keeps both rows;
  // readKimiUsage counts once — asserted below).
  const scoped = (scope) => rec({ time: 7, usage: { ...ZERO_USAGE, output: 9 }, scope });
  assert.equal(parseWireJsonl(scoped("turn"))[0].key, parseWireJsonl(scoped("session"))[0].key,
    "usageScope does not distinguish records");

  // ---- parseWireJsonl: line-level noise ----
  assert.equal(parseWireJsonl(`${oneLine}\r\n${oneLine}\r\n`).length, 2, "CRLF endings parse");
  assert.equal(parseWireJsonl(`   ${oneLine}   `).length, 1, "surrounding whitespace is fine");
  assert.deepEqual(parseWireJsonl(`﻿${oneLine}`), [],
    "a UTF-8 BOM makes JSON.parse reject the first line");
  // BUG: a wire.jsonl saved with a UTF-8 BOM silently loses its first
  // usage.record — JSON.parse does not strip BOM. If Kimi ever writes one,
  // the earliest record of that file is dropped with no signal.
  // const bomRows = parseWireJsonl(`﻿${oneLine}`);
  // assert.equal(bomRows.length, 1, "a leading BOM should not eat the first record");
  // Two JSON values on one line is not JSON.
  assert.deepEqual(parseWireJsonl(`${oneLine} ${oneLine}`), []);
  // A missing agentId still yields a record; join() renders it as an empty
  // string, so the key starts with "|" — and does NOT collide with an agent
  // literally named "undefined" (asserted at readKimiUsage level below).
  const noAgent = parseWireJsonl(JSON.stringify({ type: "usage.record", model: "m", usage: { ...ZERO_USAGE, output: 1 }, time: 3 }));
  assert.equal(noAgent.length, 1);
  assert.ok(noAgent[0].key.startsWith("|"), "missing agentId joins as an empty field");
  const strAgent = parseWireJsonl(JSON.stringify({ type: "usage.record", agentId: "undefined", model: "m", usage: { ...ZERO_USAGE, output: 1 }, time: 3 }));
  assert.notEqual(noAgent[0].key, strAgent[0].key, "agentId 'undefined' and a missing agentId have different keys");

  // ---- readKimiUsage: options of the wrong type ----
  const { root, sessions } = kimiHome();
  addWire({ sessions }, "w", "s", "main", rec({ time: at(0), usage: { ...ZERO_USAGE, output: 5 } }));
  assert.throws(() => readKimiUsage({ home: null, env: {} }), TypeError, "home:null cannot join a path");
  assert.throws(() => readKimiUsage({ home: 42, env: {} }), TypeError, "home:42 cannot join a path");
  assert.throws(() => readKimiUsage({ home: root, env: null }), TypeError, "env:null has no KIMI_CODE_HOME");
  // env as a non-object does not throw; the property lookup just misses.
  assert.equal(readKimiUsage({ home: root, env: "nope", now: NOW })?.days.at(-1).tokens, 5,
    "env string falls back to ~/.kimi-code under home");
  assert.equal(readKimiUsage({ home: root, env: 42, now: NOW })?.days.at(-1).tokens, 5);
  // env without KIMI_CODE_HOME (or blank/whitespace) uses ~/.kimi-code.
  for (const env of [{}, { KIMI_CODE_HOME: "" }, { KIMI_CODE_HOME: "   " }]) {
    const h = kimiHome();
    addWire(h, "w", "s", "main", rec({ time: at(0), usage: { ...ZERO_USAGE, output: 2 } }));
    assert.equal(readKimiUsage({ home: h.root, env, now: NOW }).days.at(-1).tokens, 2,
      `env ${JSON.stringify(env)} uses the default home`);
  }
  // KIMI_CODE_HOME pointing at a regular file is "nothing readable".
  const fileKch = path.join(tmp, "kch-is-a-file");
  fs.writeFileSync(fileKch, "x");
  assert.equal(readKimiUsage({ home: root, env: { KIMI_CODE_HOME: fileKch }, now: NOW }), null);
  // A relative KIMI_CODE_HOME resolves against the process cwd; nothing
  // writes there, it just reads (and finds nothing).
  assert.equal(readKimiUsage({ home: root, env: { KIMI_CODE_HOME: ".kimi-deep-nonexistent-260" }, now: NOW }), null);

  // ---- readKimiUsage: now of the wrong type ----
  const hNaN = kimiHome();
  addWire(hNaN, "w", "s", "main", rec({ time: at(0), usage: { ...ZERO_USAGE, output: 7 } }));
  const rNaN = readKimiUsage({ home: hNaN.root, env: {}, now: NaN });
  assert.ok(rNaN, "now:NaN does not throw and still returns a result");
  assert.equal(rNaN.days.length, 30);
  assert.ok(rNaN.days.every((d) => d.date === "NaN-NaN-NaN" && d.tokens === 0),
    "Invalid-Date now produces NaN-NaN-NaN day labels and zeroed tokens");
  assert.deepEqual(rNaN.models, {}, "daysAgo(NaN) is never >= 0, so no models");
  // now:0 (epoch) works; a record at epoch lands on the last day and in models.
  const hEpoch = kimiHome();
  addWire(hEpoch, "w", "s", "main", rec({ time: 0, usage: { ...ZERO_USAGE, output: 3 } }));
  const rEpoch = readKimiUsage({ home: hEpoch.root, env: {}, now: 0 });
  assert.equal(rEpoch.days.at(-1).date, dateOf(0));
  assert.equal(rEpoch.days.at(-1).tokens, 3);
  assert.deepEqual(rEpoch.models, { "kimi-for-coding": 3 });
  // now as a date string is coerced by new Date().
  const rStr = readKimiUsage({ home: hEpoch.root, env: {}, now: "1970-01-01T12:00:00" });
  assert.equal(rStr.days.length, 30);

  // ---- readKimiUsage: the directory shape is not what it seems ----
  // sessions path exists but is a regular file -> readdirSync throws -> null.
  const hFile = kimiHome();
  fs.mkdirSync(path.dirname(hFile.sessions), { recursive: true });
  fs.writeFileSync(hFile.sessions, "not a dir");
  assert.equal(readKimiUsage({ home: hFile.root, env: {}, now: NOW }), null);

  // Workspace entry that is a file, not a directory -> skipped.
  const hWsFile = kimiHome();
  fs.mkdirSync(hWsFile.sessions, { recursive: true });
  fs.writeFileSync(path.join(hWsFile.sessions, "a-file"), "x");
  assert.equal(readKimiUsage({ home: hWsFile.root, env: {}, now: NOW }), null);
  // Session entry that is a file -> skipped.
  const hSessFile = kimiHome();
  fs.mkdirSync(path.join(hSessFile.sessions, "w"), { recursive: true });
  fs.writeFileSync(path.join(hSessFile.sessions, "w", "a-file"), "x");
  assert.equal(readKimiUsage({ home: hSessFile.root, env: {}, now: NOW }), null);
  // "agents" exists but is a regular file -> readdirSync(agents) throws -> skip.
  const hAgentsFile = kimiHome();
  fs.mkdirSync(path.join(hAgentsFile.sessions, "w", "s"), { recursive: true });
  fs.writeFileSync(path.join(hAgentsFile.sessions, "w", "s", "agents"), "x");
  assert.equal(readKimiUsage({ home: hAgentsFile.root, env: {}, now: NOW }), null);
  // Agent entry that is a file -> skipped.
  const hAgentFile = kimiHome();
  fs.mkdirSync(path.join(hAgentFile.sessions, "w", "s", "agents"), { recursive: true });
  fs.writeFileSync(path.join(hAgentFile.sessions, "w", "s", "agents", "afile"), "x");
  assert.equal(readKimiUsage({ home: hAgentFile.root, env: {}, now: NOW }), null);
  // wire.jsonl that is a directory -> statSync says not a file -> skipped.
  const hWireDir = kimiHome();
  fs.mkdirSync(path.join(hWireDir.sessions, "w", "s", "agents", "main", "wire.jsonl"), { recursive: true });
  assert.equal(readKimiUsage({ home: hWireDir.root, env: {}, now: NOW }), null);
  // A file named wire.jsonl sitting directly under agents/ (not inside an
  // agent dir) is just another non-directory entry -> skipped.
  const hLoose = kimiHome();
  fs.mkdirSync(path.join(hLoose.sessions, "w", "s", "agents"), { recursive: true });
  fs.writeFileSync(path.join(hLoose.sessions, "w", "s", "agents", "wire.jsonl"), rec({ time: at(0) }));
  assert.equal(readKimiUsage({ home: hLoose.root, env: {}, now: NOW }), null);
  // Extra nesting inside an agent dir is ignored; only <agent>/wire.jsonl counts.
  const hNested = kimiHome();
  fs.mkdirSync(path.join(hNested.sessions, "w", "s", "agents", "main", "deep", "deeper"), { recursive: true });
  fs.writeFileSync(path.join(hNested.sessions, "w", "s", "agents", "main", "deep", "wire.jsonl"),
    rec({ time: at(0), usage: { ...ZERO_USAGE, output: 5 } }));
  fs.writeFileSync(path.join(hNested.sessions, "w", "s", "agents", "main", "notes.txt"), "hi");
  assert.equal(readKimiUsage({ home: hNested.root, env: {}, now: NOW }), null,
    "wire.jsonl must sit exactly at agents/<agent>/wire.jsonl");

  // sessions dir itself unreadable -> null (chmod back before cleanup).
  const hNoPerm = kimiHome();
  addWire(hNoPerm, "w", "s", "main", rec({ time: at(0), usage: { ...ZERO_USAGE, output: 4 } }));
  fs.chmodSync(hNoPerm.sessions, 0o000);
  assert.equal(readKimiUsage({ home: hNoPerm.root, env: {}, now: NOW }), null);
  fs.chmodSync(hNoPerm.sessions, 0o755);
  // A wire.jsonl that exists but cannot be read is skipped, not counted:
  // with it as the only file the result is null.
  const hBadFile = kimiHome();
  const badWire = addWire(hBadFile, "w", "s", "main", rec({ time: at(0), usage: { ...ZERO_USAGE, output: 4 } }));
  fs.chmodSync(badWire, 0o000);
  assert.equal(readKimiUsage({ home: hBadFile.root, env: {}, now: NOW }), null);
  fs.chmodSync(badWire, 0o644);
  // ...but a second readable file still yields a result (first one unreadable again).
  fs.chmodSync(badWire, 0o000);
  addWire(hBadFile, "w", "s2", "main", rec({ time: at(0), usage: { ...ZERO_USAGE, output: 6 } }));
  assert.equal(readKimiUsage({ home: hBadFile.root, env: {}, now: NOW }).days.at(-1).tokens, 6);
  fs.chmodSync(badWire, 0o644);

  // Symlinks: wire.jsonl is followed (statSync/readFileSync follow links),
  // but directory entries that are symlinks fail isDirectory() and are skipped.
  const hSym = kimiHome();
  const realFile = path.join(tmp, "real-wire.jsonl");
  fs.writeFileSync(realFile, rec({ time: at(0), usage: { ...ZERO_USAGE, output: 8 } }));
  const linkWire = wirePath(hSym, "w", "s", "main");
  fs.mkdirSync(path.dirname(linkWire), { recursive: true });
  fs.symlinkSync(realFile, linkWire);
  assert.equal(readKimiUsage({ home: hSym.root, env: {}, now: NOW }).days.at(-1).tokens, 8,
    "a symlinked wire.jsonl is read through");
  // A symlinked workspace dir is NOT descended into.
  const hSymWs = kimiHome();
  const realWs = path.join(hSymWs.sessions, "real-ws");
  fs.mkdirSync(path.join(realWs, "s", "agents", "main"), { recursive: true });
  fs.writeFileSync(path.join(realWs, "s", "agents", "main", "wire.jsonl"),
    rec({ time: at(0), usage: { ...ZERO_USAGE, output: 9 } }));
  // Move it aside so only the symlink remains visible under sessions/.
  fs.renameSync(realWs, path.join(tmp, "hidden-ws"));
  fs.symlinkSync(path.join(tmp, "hidden-ws"), path.join(hSymWs.sessions, "ws-link"), "dir");
  assert.equal(readKimiUsage({ home: hSymWs.root, env: {}, now: NOW }), null,
    "a symlinked workspace dirent is not a directory to readdirSync-withFileTypes");
  // Same for a symlinked agent dir.
  const hSymAgent = kimiHome();
  const realAgentParent = path.join(hSymAgent.sessions, "w", "s", "agents");
  fs.mkdirSync(realAgentParent, { recursive: true });
  const realAgent = path.join(tmp, "real-agent");
  fs.mkdirSync(realAgent, { recursive: true });
  fs.writeFileSync(path.join(realAgent, "wire.jsonl"), rec({ time: at(0), usage: { ...ZERO_USAGE, output: 10 } }));
  fs.symlinkSync(realAgent, path.join(realAgentParent, "agent-link"), "dir");
  assert.equal(readKimiUsage({ home: hSymAgent.root, env: {}, now: NOW }), null,
    "a symlinked agent dirent is skipped too");
  // A broken symlink as wire.jsonl -> statSync throws -> skipped -> null.
  const hBroken = kimiHome();
  const brokenWire = wirePath(hBroken, "w", "s", "main");
  fs.mkdirSync(path.dirname(brokenWire), { recursive: true });
  fs.symlinkSync(path.join(tmp, "does-not-exist"), brokenWire);
  assert.equal(readKimiUsage({ home: hBroken.root, env: {}, now: NOW }), null);

  // ---- readKimiUsage: degenerate file contents ----
  // A present-but-empty wire.jsonl still counts as a file: result is a
  // zeroed 30-day report, not null.
  const hEmpty = kimiHome();
  addWire(hEmpty, "w", "s", "main", "");
  const rEmpty = readKimiUsage({ home: hEmpty.root, env: {}, now: NOW });
  assert.ok(rEmpty, "an empty wire.jsonl is a readable file");
  assert.ok(rEmpty.days.every((d) => d.tokens === 0));
  // A file of only non-usage lines (valid JSON, wrong types) -> zeroed result.
  const hNoise = kimiHome();
  addWire(hNoise, "w", "s", "main", [
    JSON.stringify({ type: "turn.prompt", time: at(0) }),
    JSON.stringify({ type: "usage.record", time: "not-a-number", usage: { output: 1 } }),
    "",
    "   ",
  ].join("\n"));
  const rNoise = readKimiUsage({ home: hNoise.root, env: {}, now: NOW });
  assert.ok(rNoise.days.every((d) => d.tokens === 0) && Object.keys(rNoise.models).length === 0);
  // Binary garbage decodes to replacement chars; nothing matches, still a file.
  const hBin = kimiHome();
  addWire(hBin, "w", "s", "main", Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x22]));
  assert.ok(readKimiUsage({ home: hBin.root, env: {}, now: NOW }).days.every((d) => d.tokens === 0));

  // ---- readKimiUsage: window boundaries ----
  const hWin = kimiHome();
  const lines = [
    rec({ agentId: "a", time: at(0), usage: { ...ZERO_USAGE, output: 1 } }),          // today
    rec({ agentId: "a", time: at(6), usage: { ...ZERO_USAGE, output: 10 } }),         // 6d ago: in models
    rec({ agentId: "a", time: at(7), usage: { ...ZERO_USAGE, output: 100 } }),        // 7d ago: out of models
    rec({ agentId: "a", time: at(29), usage: { ...ZERO_USAGE, output: 1000 } }),      // day 29: last in window
    rec({ agentId: "a", time: at(30), usage: { ...ZERO_USAGE, output: 10000 } }),     // day 30: out of window
    rec({ agentId: "a", time: NOW + DAY, usage: { ...ZERO_USAGE, output: 100000 } }), // future: invisible
  ].join("\n");
  addWire(hWin, "w", "s", "main", lines);
  const rWin = readKimiUsage({ home: hWin.root, env: {}, now: NOW });
  const byDate = Object.fromEntries(rWin.days.map((d) => [d.date, d.tokens]));
  assert.equal(byDate[dateOf(at(0))], 1);
  assert.equal(byDate[dateOf(at(6))], 10);
  assert.equal(byDate[dateOf(at(7))], 100, "7-day-old usage still shows in the 30-day strip");
  assert.equal(byDate[dateOf(at(29))], 1000, "today-29 is the oldest day shown");
  assert.equal(byDate[dateOf(at(30))], undefined, "today-30 is outside the 30-day strip");
  assert.equal(byDate[dateOf(NOW + DAY)], undefined, "future usage is not shown");
  // models covers back < 7 only: today + 6d, not 7d or future.
  assert.deepEqual(rWin.models, { "kimi-for-coding": 11 });
  // `now` exactly at local midnight: a record at 00:30 that day is "today".
  const midnight = new Date(2026, 10, 24).getTime();
  const hMid = kimiHome();
  addWire(hMid, "w", "s", "main", rec({ time: midnight + 1800000, usage: { ...ZERO_USAGE, output: 12 } }));
  const rMid = readKimiUsage({ home: hMid.root, env: {}, now: midnight });
  assert.equal(rMid.days.at(-1).date, dateOf(midnight));
  assert.equal(rMid.days.at(-1).tokens, 12);
  assert.deepEqual(rMid.models, { "kimi-for-coding": 12 });

  // ---- readKimiUsage: dedupe is global across every file ----
  const hDup = kimiHome();
  const dupLine = rec({ agentId: "main", time: at(0), usage: { ...ZERO_USAGE, output: 20, inputOther: 5 } });
  // Same record three times: twice in one file, once in another agent dir.
  addWire(hDup, "w", "s", "main", `${dupLine}\n${dupLine}`);
  addWire(hDup, "w", "s", "sub", dupLine);
  addWire(hDup, "w2", "s2", "other", dupLine);
  const rDup = readKimiUsage({ home: hDup.root, env: {}, now: NOW });
  assert.equal(rDup.days.at(-1).tokens, 25, "identical records count once across all files");
  // Same agentId/time/model but different counts -> different keys -> both count.
  const hDiff = kimiHome();
  addWire(hDiff, "w", "s", "main", [
    rec({ agentId: "a", time: at(0), usage: { ...ZERO_USAGE, output: 1 } }),
    rec({ agentId: "a", time: at(0), usage: { ...ZERO_USAGE, output: 2 } }),
  ].join("\n"));
  assert.equal(readKimiUsage({ home: hDiff.root, env: {}, now: NOW }).days.at(-1).tokens, 3);
  // agentId "undefined" (string) does NOT collide with a missing agentId:
  // join() renders the missing one as "" — both records count.
  const hUndef = kimiHome();
  addWire(hUndef, "w", "s", "main", [
    JSON.stringify({ type: "usage.record", model: "m", usage: { ...ZERO_USAGE, output: 4 }, time: at(0) }),
    JSON.stringify({ type: "usage.record", agentId: "undefined", model: "m", usage: { ...ZERO_USAGE, output: 4 }, time: at(0) }),
  ].join("\n"));
  assert.equal(readKimiUsage({ home: hUndef.root, env: {}, now: NOW }).days.at(-1).tokens, 8,
    "missing agentId and agentId 'undefined' are distinct records");
  // usageScope does not distinguish: same key, counted once.
  const hScope = kimiHome();
  addWire(hScope, "w", "s", "main", [rec({ time: at(0), usage: { ...ZERO_USAGE, output: 6 }, scope: "turn" }),
    rec({ time: at(0), usage: { ...ZERO_USAGE, output: 6 }, scope: "session" })].join("\n"));
  assert.equal(readKimiUsage({ home: hScope.root, env: {}, now: NOW }).days.at(-1).tokens, 6,
    "records differing only in usageScope share a dedupe key");

  // ---- readKimiUsage: unicode and odd directory names ----
  const hUni = kimiHome();
  addWire(hUni, "my workspace ✓", "sess 1 (fork)", "agent ", rec({ time: at(0), usage: { ...ZERO_USAGE, output: 15 } }));
  assert.equal(readKimiUsage({ home: hUni.root, env: {}, now: NOW }).days.at(-1).tokens, 15);

  // ---- readKimiUsage: calls share no state ----
  // The module is fully synchronous with no module-level state; interleave
  // calls on different homes and a pure parse in between.
  const rA1 = readKimiUsage({ home: hDup.root, env: {}, now: NOW });
  parseWireJsonl("garbage");
  const rB = readKimiUsage({ home: hWin.root, env: {}, now: NOW });
  const rA2 = readKimiUsage({ home: hDup.root, env: {}, now: NOW });
  assert.deepEqual(rA1, rA2, "repeat calls return identical results");
  assert.notEqual(rA1.days, rA2.days, "...as fresh objects, not shared arrays");
  assert.equal(rB.days.length, 30);
  rA1.days[0].tokens = 999999;
  assert.notEqual(readKimiUsage({ home: hDup.root, env: {}, now: NOW }).days[0].tokens, 999999,
    "mutating a returned result cannot poison later calls");
  // Two homes with the same layout but different KIMI_CODE_HOME vs default.
  const hKch = kimiHome();
  const customKch = path.join(tmp, "custom-kimi-home");
  fs.mkdirSync(path.join(customKch, "sessions", "w", "s", "agents", "main"), { recursive: true });
  fs.writeFileSync(path.join(customKch, "sessions", "w", "s", "agents", "main", "wire.jsonl"),
    rec({ time: at(0), usage: { ...ZERO_USAGE, output: 21 } }));
  assert.equal(readKimiUsage({ home: hKch.root, env: { KIMI_CODE_HOME: customKch }, now: NOW }).days.at(-1).tokens, 21);
  assert.equal(readKimiUsage({ home: hKch.root, env: {}, now: NOW }), null,
    "the custom KIMI_CODE_HOME store is invisible without the env var");

  console.log("kimi-usage deep: all tests passed");
} finally {
  for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "KIMI_CODE_HOME"]) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
