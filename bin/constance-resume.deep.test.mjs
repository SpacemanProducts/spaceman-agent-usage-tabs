// Deeper edge-case tests for bin/constance-resume.mjs: wrong-type arguments,
// coercion boundaries, corrupt/missing JSONL input and clock edges the shallow
// constance-resume.test.mjs doesn't reach. Same style: plain asserts, a fresh
// mkdtemp dir with HOME/XDG pointed at it, no real state, no network.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resumePlan, logAsk, askReport, RESUME_GRACE_MS } from "./constance-resume.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-resume-deep-"));
const savedEnv = {};
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  savedEnv[k] = process.env[k];
  process.env[k] = path.join(root, k.toLowerCase());
}

const NOW = Date.UTC(2026, 10, 25, 12);
const UNTIL = NOW + 3600e3;
const wallOk = { until: UNTIL, stated: true, text: "x", at: NOW };
const pausedWall = { status: "paused", pauseReason: "Claude said it hit its limit; paused until noon." };
const P = (over = {}) => resumePlan({ wall: wallOk, now: NOW, goalStatus: pausedWall, ...over });

try {
  // ---- resumePlan: argument shape. Missing/undefined is fine; primitives coerce.
  assert.equal(resumePlan().action, "none", "no args at all");
  assert.equal(resumePlan(undefined).action, "none");
  assert.equal(resumePlan(42).action, "none", "a number destructures to all-undefined");
  assert.equal(resumePlan("paused").action, "none", "a string argument isn't a goalStatus");
  assert.equal(resumePlan(true).action, "none");
  assert.equal(resumePlan([]).action, "none", "an array has no .status");
  assert.equal(resumePlan({}).action, "none");
  // Regression: resumePlan(null) must answer "none", not throw — the old
  // destructuring default only covered undefined and crashed the tick.
  assert.equal(resumePlan(null).action, "none", "null options answer none, not a crash");

  // ---- goalStatus wrong types: only {status:"paused"} + a wall pauseReason counts.
  for (const bad of [0, false, [], {}, { status: "Paused" }, { status: "paused " }, { status: 1 }, { status: ["paused"] }])
    assert.equal(P({ goalStatus: bad }).action, "none", `goalStatus ${JSON.stringify(bad)}`);

  // pauseReason is String()-coerced before the regex. Falsy and plain-object
  // values can't match; anything whose toString yields the phrase CAN — including
  // an array holding the phrase and an object with a custom toString.
  for (const r of [0, 1, false, null, undefined, "", {}, []])
    assert.equal(P({ goalStatus: { status: "paused", pauseReason: r } }).action, "none", `pauseReason ${JSON.stringify(r)}`);
  assert.equal(P({ goalStatus: { status: "paused", pauseReason: ["Claude said it hit its limit"] } }).action, "wait",
    "String(['phrase']) === 'phrase': an array pauseReason can fake the wall");
  assert.equal(P({ goalStatus: { status: "paused", pauseReason: { toString: () => "Claude said it hit its limit" } } }).action, "wait",
    "a custom toString pauseReason can fake the wall");

  // ---- WALL_REASON regex edges: anchored at start, "limit" needn't end the string.
  const reason = (s) => ({ status: "paused", pauseReason: s });
  for (const s of [
    "claude said it hit its limit",          // case-sensitive
    " Claude said it hit its limit",         // leading space breaks the ^ anchor
    "x Claude said it hit its limit",        // not at the start
    "ClaudeCode said it hit its limit",      // "Claude " needs the space
    "Claude said it hit it's limit",         // 'its' must be literal
    "Claude hit its limit",                  // 'said it' is required
    "Devin said it hit its limit",           // only Claude/Antigravity brains
  ]) assert.equal(P({ goalStatus: reason(s) }).action, "none", `reason: ${s}`);
  for (const s of [
    "Claude said it hit its limit",          // bare phrase
    "Claude said it hit its limit; paused until noon.", // trailing text ok
    "Claude said it hit its limits",         // 'limits' still contains 'limit'
    "Antigravity said it hit its limit and more",
  ]) assert.equal(P({ goalStatus: reason(s) }).action, "wait", `reason: ${s}`);

  // ---- wall wrong types. Number(wall.until) is the only gate; anything that
  // doesn't coerce to a finite number is "no readable reset time".
  for (const w of ["soon", 42, true, [], null, undefined, { until: {} }, { until: "abc" }, { until: NaN }, { until: Infinity }, { until: -Infinity }])
    assert.equal(P({ wall: w }).action, "none", `wall ${JSON.stringify(w)}`);
  // Wrong-type untils that DO coerce to a finite number are accepted as reset
  // times — Number([]) === 0 and Number("") === 0 are finite, so they plan a
  // wait/resume off epoch 1970 rather than answering "none".
  assert.equal(P({ wall: { until: "123" }, now: 123 + RESUME_GRACE_MS }).action, "resume", "numeric-string until coerces");
  assert.equal(P({ wall: { until: true }, now: 61e3 }).action, "resume", "until:true -> 1, past grace");
  assert.equal(P({ wall: { until: false }, now: 61e3 }).action, "resume", "until:false -> 0, past grace");
  assert.equal(P({ wall: { until: [] }, now: 61e3 }).action, "resume", "until:[] -> 0, past grace");
  assert.equal(P({ wall: { until: "" }, now: 0 }).action, "wait", "until:'' -> 0, still inside grace");
  assert.equal(P({ wall: { until: "1e3" }, now: 1000 + RESUME_GRACE_MS }).action, "resume", "exponent-string until coerces");

  // ---- now coercion edges. The < compare coerces; a NaN clock never waits.
  assert.equal(P({ now: 0 }).action, "wait", "now=0 is far before the wall");
  assert.equal(P({ now: -1e15 }).action, "wait", "negative now still waits");
  assert.equal(P({ now: UNTIL + RESUME_GRACE_MS + 5 }).action, "resume");
  assert.equal(P({ now: Infinity }).action, "none", "non-finite now is an unreadable clock, never a resume");
  assert.equal(P({ now: -Infinity }).action, "none", "-Infinity now is unreadable too");
  assert.equal(P({ now: "5000" }).action, "wait", "numeric-string now coerces in the < compare");
  assert.equal(P({ now: "not a number" }).action, "none", "NaN now: an unreadable clock never resumes");
  assert.equal(P({ now: {} }).action, "none", "object now stringifies to NaN -> none");
  // Regression: a NaN/garbage clock must never answer "resume" — she would
  // restart straight into the wall the plan exists to avoid.
  assert.equal(P({ now: NaN }).action, "none");

  // ---- until at/below epoch: the grace arithmetic still applies.
  assert.equal(P({ wall: { until: 0 }, now: 0 }).action, "wait", "until=0, now=0: grace not yet served");
  assert.equal(P({ wall: { until: 0 }, now: RESUME_GRACE_MS }).action, "resume", "exactly at grace for until=0");
  assert.equal(P({ wall: { until: -5000 }, now: -5000 }).action, "wait");
  assert.equal(P({ wall: { until: -5000 }, now: -5000 + RESUME_GRACE_MS }).action, "resume");
  // Default `now` is the real clock: a wall an hour out waits, a stale one resumes.
  assert.equal(resumePlan({ wall: { until: Date.now() + 3600e3 }, goalStatus: pausedWall }).action, "wait");
  assert.equal(resumePlan({ wall: { until: Date.now() - 3600e3 }, goalStatus: pausedWall }).action, "resume");

  // ---- result shape: exactly {action, until, why}, why names the reset instant.
  assert.deepEqual(P({ goalStatus: { status: "running" } }), { action: "none", until: null, why: "the goal isn't paused by the wall" });
  assert.deepEqual(P({ wall: null }), { action: "none", until: null, why: "the wall has no readable reset time" });
  const w = P({ now: UNTIL });
  assert.deepEqual(Object.keys(w).sort(), ["action", "until", "why"], "result carries only the three fields");
  assert.equal(w.until, UNTIL + RESUME_GRACE_MS);
  assert.ok(w.why.includes(new Date(UNTIL).toISOString()), "wait why names the stated reset time");
  assert.equal(P({ now: UNTIL + RESUME_GRACE_MS }).why, "the reset time plus the grace has passed");

  // ---- logAsk: reason/at coercion, then read back through askReport.
  const asks = path.join(root, "asks.jsonl");
  logAsk(asks); // everything missing
  logAsk(asks, {});
  logAsk(asks, { reason: 0, at: 1 });
  logAsk(asks, { reason: false, at: 2 });
  logAsk(asks, { reason: null, at: 3 });
  logAsk(asks, { reason: {}, at: 4 });
  logAsk(asks, { reason: [], at: 5 });
  logAsk(asks, { reason: 42, at: 6 });
  logAsk(asks, { reason: ["a", "b"], at: 7 });
  let rep = askReport(asks);
  assert.equal(rep.asked, 9);
  assert.deepEqual(rep.reasons, ["", "", "", "", "", "[object Object]", "", "42", "a,b"],
    "falsy reasons log as '', objects as [object Object], arrays join with commas");
  // at coercion: only real finite numbers are kept; everything else is Date.now().
  const f2 = path.join(root, "ats.jsonl");
  const before = Date.now();
  for (const at of ["123", NaN, Infinity, -Infinity, null, {}, [], "soon"]) logAsk(f2, { reason: "x", at });
  for (const at of [-5, 0, 1.5]) logAsk(f2, { reason: "x", at });
  const lines = fs.readFileSync(f2, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  for (let i = 0; i < 8; i++)
    assert.ok(lines[i].at >= before && lines[i].at <= Date.now(), `bad at ${JSON.stringify(lines[i].at)} fell back to the clock`);
  assert.deepEqual(lines.slice(8).map((l) => l.at), [-5, 0, 1.5], "negative, zero and fractional ats are kept verbatim");
  // at exactly at a sinceMs boundary counts (the filter is strict <).
  const f3 = path.join(root, "edge.jsonl");
  logAsk(f3, { reason: "edge", at: 100 });
  assert.equal(askReport(f3, 100).asked, 1, "at == sinceMs still counts");
  assert.equal(askReport(f3, 101).asked, 0);

  // ---- logAsk error paths: unwritable targets throw, nothing is swallowed.
  const asDir = path.join(root, "a-dir");
  fs.mkdirSync(asDir);
  assert.throws(() => logAsk(asDir, { reason: "x", at: 1 }), /EISDIR|illegal operation/i, "file that is a directory throws");
  const blocker = path.join(root, "blocker");
  fs.writeFileSync(blocker, "x");
  assert.throws(() => logAsk(path.join(blocker, "asks.jsonl"), { reason: "x", at: 1 }), "a file in the path throws");
  assert.throws(() => logAsk("", { reason: "x", at: 1 }), "empty path throws");
  // Deeply nested nonexistent parents are created (shallow test covers one level).
  const deep = path.join(root, "a", "b", "c", "d", "asks.jsonl");
  logAsk(deep, { reason: "deep", at: 1 });
  assert.equal(askReport(deep).asked, 1);
  // Interleaved log/report sees every line: no buffering, no batching.
  const f4 = path.join(root, "interleave.jsonl");
  for (let i = 0; i < 50; i++) {
    logAsk(f4, { reason: `r${i}`, at: i });
    assert.equal(askReport(f4).asked, i + 1, `after ${i + 1} writes`);
  }
  assert.equal(askReport(f4, 25).asked, 25, "sinceMs halves it exactly");

  // ---- askReport: unreadable/missing/garbage files all answer {0, []}.
  assert.deepEqual(askReport(path.join(root, "missing.jsonl")), { asked: 0, reasons: [] });
  assert.deepEqual(askReport(asDir), { asked: 0, reasons: [] }, "a directory reads as no asks");
  assert.deepEqual(askReport(null), { asked: 0, reasons: [] }, "null path is caught");
  assert.deepEqual(askReport(42), { asked: 0, reasons: [] }, "numeric path is caught");
  assert.deepEqual(askReport(""), { asked: 0, reasons: [] }, "empty path is caught");
  const empty = path.join(root, "empty.jsonl");
  fs.writeFileSync(empty, "");
  assert.deepEqual(askReport(empty), { asked: 0, reasons: [] }, "empty file");
  fs.writeFileSync(empty, "\n\n   \n\t\n");
  assert.deepEqual(askReport(empty), { asked: 0, reasons: [] }, "whitespace-only file");

  // ---- askReport: per-line garbage. Only {at: finite number >= sinceMs} counts.
  const messy = path.join(root, "messy.jsonl");
  fs.writeFileSync(messy, [
    "null", "123", "true", "\"str\"", "[]", "[1,2]", "{", "}{",
    '{"at":null}', '{"at":{}}', '{"at":NaN}', '{"at":1e400}', // Infinity after parse
    '{"at":"soon"}', '{"at":[]}', '{"at":true}', '{"at":false}', '{"at":"50"}', '{"at":"-1"}',
    '{"reason":"ok","at":10}',
    '   {"reason":"indented","at":20}   ',
    '{"reason":"crlf","at":30}\r',
    '﻿{"reason":"bom","at":40}',       // BOM: JSON.parse rejects the line
    '{"reason":"no-at"}',
    '{"at":10,"reason":"dup"}',
    "",
  ].join("\n"));
  const mr = askReport(messy);
  // Number() coercion on `at`: null/[]/false -> 0 and true -> 1 and "50" -> 50 all
  // count; {} / "soon" / 1e400 (Infinity) / missing at are cut. "-1" is below 0.
  assert.deepEqual(mr.reasons, ["", "", "", "", "", "ok", "indented", "crlf", "dup"],
    "only finite-number ats count; null/[]/false/true/string ats coerce through Number()");
  assert.equal(mr.asked, 9);

  // ---- askReport: reason field coercion on otherwise-valid lines.
  const reasons = path.join(root, "reasons.jsonl");
  fs.writeFileSync(reasons, [
    '{"at":1}', '{"at":2,"reason":null}', '{"at":3,"reason":0}', '{"at":4,"reason":false}',
    '{"at":5,"reason":7}', '{"at":6,"reason":{}}', '{"at":7,"reason":["x","y"]}', '{"at":8,"reason":" spaced "}',
  ].join("\n"));
  assert.deepEqual(askReport(reasons).reasons, ["", "", "", "", "7", "[object Object]", "x,y", " spaced "],
    "missing/falsy reasons -> '', numbers/objects/arrays stringify");

  // ---- askReport: sinceMs coercion edges.
  const f5 = path.join(root, "since.jsonl");
  logAsk(f5, { reason: "neg", at: -10 });
  logAsk(f5, { reason: "zero", at: 0 });
  logAsk(f5, { reason: "mid", at: 50 });
  logAsk(f5, { reason: "high", at: 100 });
  assert.equal(askReport(f5).asked, 3, "at=-10 is below the default sinceMs=0; at=0 counts");
  assert.equal(askReport(f5, NaN).asked, 4, "NaN sinceMs: 'at < NaN' is false, nothing is cut");
  assert.equal(askReport(f5, Infinity).asked, 0, "infinite sinceMs cuts everything");
  assert.equal(askReport(f5, -Infinity).asked, 4);
  assert.equal(askReport(f5, "50").asked, 2, "numeric-string sinceMs coerces: keeps at>=50");
  assert.equal(askReport(f5, {}).asked, 4, "object sinceMs -> NaN compare -> nothing cut");
  assert.equal(askReport(f5, null).asked, 3, "null sinceMs -> 0: only the negative at is cut");
  // The returned reasons array is a fresh copy; mutating it can't corrupt the file.
  const rep2 = askReport(f5);
  rep2.reasons.length = 0;
  assert.equal(askReport(f5).asked, 3, "report results are independent snapshots");

  // ---- clock edges / no async surface: the module is fully synchronous, so the
  // only "race" is interleaved writers, exercised above. A burst of 500 appends
  // still parses line-perfect.
  const burst = path.join(root, "burst.jsonl");
  for (let i = 0; i < 500; i++) logAsk(burst, { reason: "b", at: i });
  const br = askReport(burst);
  assert.equal(br.asked, 500);
  assert.equal(br.reasons.at(-1), "b");
} finally {
  for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("constance-resume.deep: tests passed");
