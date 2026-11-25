// Deeper edge-case pass on the morning report (bin/constance-morning.mjs),
// complementing constance-morning.test.mjs. Covers what the first test leaves
// out: stamp-file shapes lastReportAt accepts or rejects, `since` boundary and
// coercion, per-field wrong types, needs-you dedup/ordering quirks, degenerate
// goal lines, the day() header at calendar edges, and writeReport's tmp+rename
// failure modes. The module is synchronous with no timers or shared state, so
// there are no real races to test; the fake HOME/XDG dirs are a guard so
// nothing can ever touch the real one. Suspected bugs are commented out with a
// note, not fixed (this job is test-only).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { morningFile, stampFile, lastReportAt, buildReport, writeReport } from "./constance-morning.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constance-morning-deep-"));
process.env.HOME = path.join(tmp, "home");
process.env.XDG_STATE_HOME = path.join(tmp, "xdg-state");
process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg-config");
process.env.XDG_CACHE_HOME = path.join(tmp, "xdg-cache");
fs.mkdirSync(process.env.HOME, { recursive: true });

const NOW = new Date(2026, 10, 24, 8, 30).getTime();
const rec = (over = {}) => ({ id: "g", text: "Goal text", finishedAt: 1000, status: "done",
  outcome: "done", needsOwner: "", jobs: 1, merged: 1, sentBack: 0, practice: false,
  tokens: 0, tokensCantTell: 0, itemsDone: 0, itemsTotal: 0, ...over });
const dir = () => fs.mkdtempSync(path.join(tmp, "d-"));

// ---------- lastReportAt: stamp shapes ----------

// Missing dir, missing file, and a stamp path that is itself a directory all read as 0.
let d = dir();
assert.equal(lastReportAt(d), 0);
assert.equal(lastReportAt(path.join(d, "nope")), 0);
fs.mkdirSync(stampFile(d), { recursive: true });
assert.equal(lastReportAt(d), 0, "a directory where the stamp should be");

// `at` is coerced with Number(): strings, booleans and single-element arrays count.
d = dir();
for (const [raw, want] of [
  ['{"at": "123"}', 123],
  ['{"at": "  42  "}', 42],
  ['{"at": "0x1F"}', 31],
  ['{"at": true}', 1],
  ['{"at": [9]}', 9],
  ['{"at": -5}', -5],
  ['{"at": 1e21}', 1e21],
]) {
  fs.writeFileSync(stampFile(d), raw);
  assert.equal(lastReportAt(d), want, raw);
}
// ...while null, objects, empty arrays, NaN-ish strings and non-objects all give 0.
for (const raw of ['{"at": null}', '{"at": {}}', '{"at": []}', '{"at": "abc"}',
  '{"at": false}', "null", "5", '"x"', "[5]", "", "not json", '{"at":']) {
  fs.writeFileSync(stampFile(d), raw);
  assert.equal(lastReportAt(d), 0, raw);
}
// A BOM makes JSON.parse fail -> 0, even though the JSON itself is fine.
fs.writeFileSync(stampFile(d), "﻿{\"at\": 7}");
assert.equal(lastReportAt(d), 0, "BOM'd stamp is unreadable");
// Extra keys are ignored; a missing `at` is 0.
fs.writeFileSync(stampFile(d), '{"at": 55, "goals": 3}');
assert.equal(lastReportAt(d), 55);
fs.writeFileSync(stampFile(d), '{"goals": 3}');
assert.equal(lastReportAt(d), 0);
// lastReportAt(dir) where dir is a plain file can never read a stamp.
d = dir();
const asFile = path.join(d, "afile");
fs.writeFileSync(asFile, "x");
assert.equal(lastReportAt(asFile), 0);

// ---------- buildReport: `since` filtering edges ----------

const NOW2 = NOW;
// The comparison is strict `>`: a goal finished exactly at `since` is excluded.
let r = buildReport({ records: [rec({ finishedAt: 1000 })], since: 1000, now: NOW2 });
assert.equal(r.goals, 0, "finishedAt == since does not count");
// Coercions: numeric-string finishedAt counts, non-numeric doesn't; `since` coerces too.
r = buildReport({ records: [rec({ finishedAt: "2000" }), rec({ id: "b", finishedAt: "abc" }),
  rec({ id: "c", finishedAt: null })], since: "1000", now: NOW2 });
assert.equal(r.goals, 1, "only the numeric-string finishedAt survives");
r = buildReport({ records: [rec({ finishedAt: null })], since: -1, now: NOW2 });
assert.equal(r.goals, 1, "Number(null) is 0, which beats since -1");
r = buildReport({ records: [rec({ finishedAt: NaN }), rec({ id: "b" , finishedAt: undefined })], since: -Infinity, now: NOW2 });
assert.equal(r.goals, 0, "NaN/undefined finishedAt never beats any since");
// Default since is 0: a goal stamped at exactly 0 is excluded.
r = buildReport({ records: [rec({ finishedAt: 0 }), rec({ id: "b", finishedAt: -3 })] });
assert.equal(r.goals, 0);
// buildReport() with no arguments at all is a valid empty report.
r = buildReport();
assert.equal(r.goals, 0);
assert.match(r.text, /No goals finished since the last report\./);
// Wrong container types crash; callers always pass arrays of record objects.
assert.throws(() => buildReport({ records: null }), TypeError);
assert.throws(() => buildReport({ records: "x" }), TypeError);
assert.throws(() => buildReport({ records: [null] }), TypeError, "a null record crashes");
assert.throws(() => buildReport({ records: [undefined] }), TypeError);

// ---------- buildReport: field coercion and wrong types ----------

// tokens only sums real numbers; a numeric string is ignored but can't-tell still counts.
r = buildReport({ records: [rec({ tokens: "5000", tokensCantTell: 1 }),
  rec({ id: "b", tokens: 500 }), rec({ id: "c", tokens: null })], now: NOW2 });
assert.match(r.text, /Tokens: 500 \(1 job can't tell\)/);
// merged/sentBack coerce differently in the goal line (raw `|| 0`) vs the body (Number()).
r = buildReport({ records: [rec({ merged: "2", sentBack: "1" })], now: NOW2 });
assert.match(r.text, /2 merged, 1 sent back/);
assert.match(r.body, /2 jobs merged/, "body uses Number('2')");
r = buildReport({ records: [rec({ merged: "x", sentBack: {} })], now: NOW2 });
assert.match(r.text, /x merged, \[object Object\] sent back/, "raw values are stringified into the line");
assert.match(r.body, /0 jobs merged/, "body coerces junk to 0");
// itemsTotal/itemsDone coerce with Number; non-positive totals hide the part.
r = buildReport({ records: [rec({ itemsDone: "2", itemsTotal: "3" })], now: NOW2 });
assert.match(r.text, /· 2\/3 ·/);
r = buildReport({ records: [rec({ itemsDone: 5, itemsTotal: -1 })], now: NOW2 });
assert.ok(!r.text.includes("5/-1"), "a negative itemsTotal shows no items part");
r = buildReport({ records: [rec({ itemsDone: 5, itemsTotal: 0 })], now: NOW2 });
assert.ok(!r.text.includes("/"), "zero itemsTotal shows no items part");
// outcome falls back to status, then to "finished"; neither -> "finished".
r = buildReport({ records: [rec({ outcome: "", status: "partial" })], now: NOW2 });
assert.match(r.text, /— partial ·/);
r = buildReport({ records: [rec({ outcome: null, status: null })], now: NOW2 });
assert.match(r.text, /— finished ·/);
// Non-string needsOwner values are String()'d; falsy ones are skipped.
r = buildReport({ records: [rec({ needsOwner: 42 }), rec({ id: "b", needsOwner: {} }),
  rec({ id: "c", needsOwner: 0 }), rec({ id: "d", needsOwner: null })], now: NOW2 });
const needsSec = r.text.split("## Needs you\n")[1];
assert.ok(needsSec.includes("- 42"), "numeric needsOwner stringifies");
assert.ok(needsSec.includes("- [object Object]"), "object needsOwner stringifies");
assert.ok(!needsSec.includes("- 0") && !needsSec.includes("null"), "falsy needsOwner skipped");
// needsOwner is trimmed before dedup, so " X " and "X" collapse.
r = buildReport({ records: [rec({ needsOwner: "  Same.  " }), rec({ id: "b", needsOwner: "Same." })], now: NOW2 });
assert.equal(r.text.split("## Needs you\n")[1].trim().split("\n").length, 1);
// Practice goals still report needsOwner (only token/job counts are practice-gated).
r = buildReport({ records: [rec({ practice: true, needsOwner: "Practice flag" })], now: NOW2 });
assert.match(r.text, /- Practice flag/);
// A practice-only report still counts the goal in `goals`/body.
r = buildReport({ records: [rec({ practice: true })], now: NOW2 });
assert.equal(r.goals, 1);
assert.match(r.body, /^1 goal done, 0 jobs merged, 0 tokens\./);
// can't-tell singular vs plural.
r = buildReport({ records: [rec({ tokensCantTell: 1 })], now: NOW2 });
assert.match(r.text, /\(1 job can't tell\)/);
r = buildReport({ records: [rec({ tokensCantTell: 2 })], now: NOW2 });
assert.match(r.text, /\(2 jobs can't tell\)/);

// BUG: a whitespace-only needsOwner adds an empty string to the needs-you set —
// the markdown gets a bare "- " bullet and the notification body ends with
// "Needs you: ." (the `needs` array path trims-and-skips empties; the record
// path does not).
// const ws = buildReport({ records: [rec({ needsOwner: "   " })], now: NOW2 });
// assert.ok(!ws.text.includes("\n- \n"), "no empty needs bullet");
// assert.ok(!ws.body.includes("Needs you: ."), "no empty needs clause");

// BUG: with no finished goals the notification body names only the FIRST
// need-you ("Needs you: A."), silently dropping the rest, while the markdown
// lists them all. The goals>0 path joins every need.
// const nb = buildReport({ records: [], needs: ["First need", "Second need"], now: NOW2 });
// assert.ok(nb.body.includes("Second need"), "body should mention every need");

// BUG: `needs` is iterated with for..of, so a bare string splinters into one
// single-character "need" per letter instead of being rejected or treated as one.
// const ns = buildReport({ records: [], needs: "oops", now: NOW2 });
// assert.deepEqual(ns.text.split("## Needs you\n")[1].trim().split("\n"), ["- o", "- o", "- p", "- s"].slice(0, 3));
// (dedup leaves o,o,p,s -> four bullets of single chars; assert the splinter)
// assert.equal(ns.text.split("## Needs you\n")[1].trim().split("\n").length, 4);

// BUG: tokens: NaN passes the typeof check, poisons the sum, and crashes inside
// fmtTokens (units[-1] destructure) — same constance-tokens.mjs bug the board
// deep test documents. Can't arrive via JSON history, only via in-memory records.
// assert.throws(() => buildReport({ records: [rec({ tokens: NaN })], now: NOW2 }), TypeError);

// BUG: a goal with an empty/whitespace text renders "-  — done · …" (double
// space, no title at all). There is no fallback label.
// const et = buildReport({ records: [rec({ text: "   " })], now: NOW2 });
// assert.ok(!et.text.includes("-  —"), "empty goal text should not leave a blank title");

// ---------- buildReport: needs array coercion ----------

// `needs` entries go through String(n || "").trim(): numbers, objects, booleans.
r = buildReport({ records: [], needs: [7, {}, true, null, undefined, 0, ""], now: NOW2 });
const sec = r.text.split("## Needs you\n")[1].trim().split("\n");
assert.deepEqual(sec, ["- 7", "- [object Object]", "- true"], "falsy needs are skipped, rest stringified");
// Trailing periods are stripped in the body but kept in the markdown.
r = buildReport({ records: [rec()], needs: ["Check the logs..."], now: NOW2 });
assert.match(r.text, /- Check the logs\.\.\./);
assert.match(r.body, /Needs you: Check the logs\./);
// `needs` as a Set works (any iterable); a non-iterable crashes.
r = buildReport({ records: [], needs: new Set(["One", "Two"]), now: NOW2 });
assert.equal(r.text.split("## Needs you\n")[1].trim().split("\n").length, 2);
assert.throws(() => buildReport({ records: [], needs: 5 }), TypeError);
assert.throws(() => buildReport({ records: [], needs: {} }), TypeError);
// needsYou order is insertion order: record needs first, then `needs`.
r = buildReport({ records: [rec({ needsOwner: "From record" })], needs: ["From arg"], now: NOW2 });
assert.deepEqual(r.text.split("## Needs you\n")[1].trim().split("\n"),
  ["- From record", "- From arg"]);

// ---------- buildReport: day() header edges ----------

// Local-timezone date, zero-padded month and day.
r = buildReport({ records: [], now: new Date(2026, 0, 5, 23, 59).getTime() });
assert.match(r.text, /^# Morning report — 2026-01-05/m);
r = buildReport({ records: [], now: new Date(2026, 11, 31, 0, 1).getTime() });
assert.match(r.text, /^# Morning report — 2026-12-31/m);
// A year boundary: Dec 31 23:59 vs Jan 1 00:01 are different report days.
const yEnd = buildReport({ records: [], now: new Date(2026, 11, 31, 23, 59).getTime() });
const yStart = buildReport({ records: [], now: new Date(2027, 0, 1, 0, 1).getTime() });
assert.match(yEnd.text, /2026-12-31/);
assert.match(yStart.text, /2027-01-01/);
// BUG?: an invalid `now` renders "# Morning report — NaN-NaN-NaN" instead of
// falling back to the real clock or throwing.
// const bad = buildReport({ records: [], now: NaN });
// assert.ok(!bad.text.includes("NaN-NaN-NaN"), "invalid now should not leak NaN into the header");

// ---------- writeReport: happy-path details ----------

d = dir();
// Nested dirs are created recursively.
const nested = path.join(d, "a", "b", "c");
const p = writeReport(nested, buildReport({ records: [rec()], now: NOW }), NOW);
assert.equal(p, morningFile(nested));
assert.equal(fs.readFileSync(morningFile(nested), "utf8"), buildReport({ records: [rec()], now: NOW }).text);
assert.equal(lastReportAt(nested), NOW);
// Exactly two files land in the dir — tmp+rename leaves no .tmp litter.
assert.deepEqual(fs.readdirSync(nested).sort(), ["morning-report.md", "morning.json"]);
// The stamp keeps the caller's `now`, not the wall clock, and the goals count.
assert.deepEqual(JSON.parse(fs.readFileSync(stampFile(nested), "utf8")), { at: NOW, goals: 1 });
// A second write overwrites both files atomically; lastReportAt follows.
const later = NOW + 60_000;
writeReport(nested, buildReport({ records: [], now: later }), later);
assert.equal(lastReportAt(nested), later);
assert.match(fs.readFileSync(morningFile(nested), "utf8"), /No goals finished/);
assert.deepEqual(fs.readdirSync(nested).sort(), ["morning-report.md", "morning.json"]);
// writeReport on a path that is an existing plain file throws (mkdir EEXIST).
d = dir();
const filePath = path.join(d, "afile");
fs.writeFileSync(filePath, "x");
assert.throws(() => writeReport(filePath, { text: "t", goals: 0 }), /EEXIST|ENOTDIR|EISDIR/);
// A report without `goals` still writes; the stamp just drops the key.
d = dir();
writeReport(d, { text: "# hi\n", goals: undefined }, NOW);
assert.deepEqual(JSON.parse(fs.readFileSync(stampFile(d), "utf8")), { at: NOW });
// Missing `text` throws before anything is renamed; nothing is left behind.
d = dir();
assert.throws(() => writeReport(d, { goals: 1 }, NOW), TypeError);
assert.equal(fs.readdirSync(d).filter((f) => !f.endsWith(".tmp")).length, 0);
assert.equal(lastReportAt(d), 0, "no stamp without a successful write");

// ---------- writeReport: tmp+rename failure modes ----------

// If the stamp's tmp path is occupied by a directory, the markdown lands but the
// stamp doesn't — lastReportAt reads 0 and the report is effectively uncounted.
d = dir();
const stampTmp = `${stampFile(d)}.${process.pid}.tmp`;
fs.mkdirSync(stampTmp, { recursive: true });
assert.throws(() => writeReport(d, { text: "# hi\n", goals: 2 }, NOW), /EISDIR|EPERM|EACCES/);
assert.equal(fs.readFileSync(morningFile(d), "utf8"), "# hi\n", "report file was still written");
assert.equal(fs.existsSync(stampFile(d)), false, "stamp write failed");
assert.equal(lastReportAt(d), 0);
// If the report's tmp path is blocked, the stamp is never attempted either.
d = dir();
const reportTmp = `${morningFile(d)}.${process.pid}.tmp`;
fs.mkdirSync(reportTmp, { recursive: true });
assert.throws(() => writeReport(d, { text: "# hi\n", goals: 2 }, NOW));
assert.equal(fs.existsSync(morningFile(d)), false);
assert.equal(fs.existsSync(stampFile(d)), false, "stamp write comes second");

// ---------- round trip: report -> stamp -> since ----------

// A report written at NOW becomes the `since` for the next one: goals finished
// at or before the stamp are excluded, later ones included.
d = dir();
writeReport(d, buildReport({ records: [rec({ id: "old", finishedAt: NOW - 1 })], now: NOW }), NOW);
const since = lastReportAt(d);
assert.equal(since, NOW);
const next = buildReport({ records: [
  rec({ id: "at-stamp", finishedAt: NOW }),
  rec({ id: "after", finishedAt: NOW + 1 }),
], since, now: NOW + 1000 });
assert.equal(next.goals, 1, "only the goal finished after the stamp counts");
assert.match(next.text, /after|Goal text/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("constance-morning.deep: ok");
