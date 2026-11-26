// Deeper edge-case tests for constance-scorecard.mjs: malformed scorecard.json
// shapes, boundary verdicts/times/tokens, dedup quirks and pure-function edges
// the main test doesn't reach. Anything that looks like a real bug is left as
// a commented-out test with a note instead of being fixed here.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-home-"));
process.env.HOME = tmpRoot;
process.env.XDG_STATE_HOME = path.join(tmpRoot, "state");
process.env.XDG_CONFIG_HOME = path.join(tmpRoot, "config");
process.env.XDG_CACHE_HOME = path.join(tmpRoot, "cache");

const { scorecardFile, readScorecard, recordReview, scoreRows, sizeHint, rankAgents, scoreLine } =
  await import("./constance-scorecard.mjs");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
const job = (id, agent, extra = {}) => ({ id, goal: "g1", agent, startedAt: 1000, finishedAt: 61000, files: ["a"], ...extra });

// ---- readScorecard: every malformed stored shape degrades to a usable card ----
const shapes = [
  ["null json", "null"],
  ["array json", "[]"],
  ["number json", "42"],
  ["string json", '"hello"'],
  ["agents not object", '{"agents": 7, "seen": "nope"}'],
  ["agents array", '{"agents": [], "seen": {}}'],
  ["agent entry null", '{"agents": {"a": null}}'],
  ["agent entry number", '{"agents": {"a": 42}}'],
  ["agent entry string", '{"agents": {"a": "abc"}}'],
  ["agent entry array", '{"agents": {"a": [1, 2]}}'],
  ["recent not array", '{"agents": {"a": {"jobs": 3, "recent": "x"}}}'],
  ["seen not array", '{"agents": {}, "seen": "x"}'],
];
for (const [label, text] of shapes) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-shape-"));
  fs.writeFileSync(scorecardFile(d), text, "utf8");
  const card = readScorecard(d);
  assert.ok(card && typeof card.agents === "object" && Array.isArray(card.seen), label);
  // scoreRows must not throw on whatever came back.
  assert.doesNotThrow(() => scoreRows(card), label);
}
// Agent entry null/number/string still yields a row with zeroed counters.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-shape-"));
  fs.writeFileSync(scorecardFile(d), '{"agents": {"n": null, "s": "abc", "num": 42}}', "utf8");
  const rows = scoreRows(readScorecard(d));
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.jobs, 0, `${r.agent} jobs`);
    assert.equal(r.acceptRate, null);
    assert.equal(r.avgTokens, null);
    assert.equal(r.avgMs, null);
  }
}
// scorecard.json being a directory (not a file) -> empty card, no throw.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-shape-"));
  fs.mkdirSync(scorecardFile(d));
  assert.deepEqual(readScorecard(d), { agents: {}, seen: [] });
}
// Stored recent longer than MAX_RECENT is kept as-is until the next write
// (readScorecard does not trim; recordReview trims on write). Documented.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-shape-"));
  const recent = Array.from({ length: 30 }, (_, i) => ({ job: i, verdict: "accept" }));
  fs.writeFileSync(scorecardFile(d), JSON.stringify({ agents: { a: { jobs: 30, accepted: 30, sentBack: 0, tokensSum: 0, tokensN: 0, msSum: 0, msN: 0, recent } }, seen: [] }), "utf8");
  assert.equal(readScorecard(d).agents.a.recent.length, 30, "read keeps stored recent verbatim");
}

// ---- recordReview: verdict and job validation ----
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  // Unknown verdicts are ignored and never create the file.
  for (const v of ["reject", "", null, undefined, 0, "ACCEPT"]) {
    const card = recordReview(d, job(1, "devin"), v, 1);
    assert.deepEqual(card, { agents: {}, seen: [] }, `verdict ${JSON.stringify(v)}`);
    assert.ok(!fs.existsSync(scorecardFile(d)), `verdict ${JSON.stringify(v)} wrote nothing`);
  }
  // Null/undefined/non-object jobs are ignored too.
  for (const j of [null, undefined, 0, "job", []]) {
    assert.deepEqual(recordReview(d, j, "accept", 1), { agents: {}, seen: [] }, `job ${JSON.stringify(j)}`);
  }
  assert.ok(!fs.existsSync(scorecardFile(d)));
}
// startedAt = 0 is finite and counts (falsy but valid).
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  const card = recordReview(d, job(1, "devin", { startedAt: 0, finishedAt: 5000 }), "accept", 10);
  assert.equal(card.agents.devin.jobs, 1);
  assert.equal(card.agents.devin.msSum, 5000);
  assert.equal(card.agents.devin.recent[0].ms, 5000);
}
// finishedAt missing/non-finite -> ms skipped honestly, tokens still count.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  recordReview(d, job(1, "devin", { finishedAt: undefined, tokens: { n: 10 } }), "accept", 1);
  recordReview(d, job(2, "devin", { finishedAt: "later", tokens: { n: 20 } }), "accept", 2);
  const a = readScorecard(d).agents.devin;
  assert.equal(a.msN, 0, "no finite finishedAt -> no ms samples");
  assert.equal(a.msSum, 0);
  assert.equal(a.tokensN, 2);
  assert.equal(a.recent[0].ms, null);
  assert.equal(a.recent[1].ms, null);
}
// tokens edge values: 0 counts, negatives and floats are accepted as-is.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  recordReview(d, job(1, "devin", { tokens: { n: 0 } }), "accept", 1);
  recordReview(d, job(2, "devin", { tokens: { n: -50 } }), "accept", 2);
  recordReview(d, job(3, "devin", { tokens: { n: 10.5 } }), "accept", 3);
  const a = readScorecard(d).agents.devin;
  assert.equal(a.tokensSum, -39.5);
  assert.equal(a.tokensN, 3);
  assert.equal(scoreRows(readScorecard(d))[0].avgTokens, Math.round(-39.5 / 3));
}
// tokens present but not an object / n missing -> skipped.
for (const t of [5, "lots", {}, { n: null }, { n: NaN }, { n: Infinity }, null, undefined]) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  const card = recordReview(d, job(1, "devin", { tokens: t }), "accept", 1);
  assert.equal(card.agents.devin.tokensN, 0, `tokens ${JSON.stringify(t)}`);
}
// Falsy-but-valid ids: id 0 and "" still get their own seen keys.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  recordReview(d, job(0, "devin"), "accept", 1);
  recordReview(d, job("", "devin"), "accept", 2);
  const card = readScorecard(d);
  assert.equal(card.agents.devin.jobs, 2);
  assert.deepEqual(card.seen, ["g1:0", "g1:"]);
}
// Missing agent id records under "" rather than crashing.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  const card = recordReview(d, { id: 1, goal: "g", startedAt: 1, finishedAt: 2 }, "accept", 1);
  assert.equal(card.agents[""].jobs, 1);
  assert.equal(scoreRows(card)[0].agent, "");
}
// files not an array: length of whatever is there, or undefined for objects.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  recordReview(d, job(1, "devin", { files: "abcd" }), "accept", 1);
  recordReview(d, job(2, "devin", { files: { a: 1 } }), "accept", 2);
  recordReview(d, job(3, "devin", { files: null }), "accept", 3);
  const recent = readScorecard(d).agents.devin.recent;
  assert.equal(recent[0].files, 4, "string length used");
  assert.equal(recent[1].files, undefined, "object has no length");
  assert.equal(recent[2].files, 0, "null -> empty");
}
// recordReview creates the state dir itself when missing.
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  const nested = path.join(base, "no", "such", "dir");
  const card = recordReview(nested, job(1, "devin"), "accept", 1);
  assert.equal(card.agents.devin.jobs, 1);
  assert.ok(fs.existsSync(scorecardFile(nested)));
}
// Dedup: the same goal:job id counts once ever, even for a different agent
// and even across goals? No - different goal is a different key (covered in
// the main test). Here: same id+goal, different agent -> second ignored.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  recordReview(d, job(1, "devin"), "accept", 1);
  recordReview(d, job(1, "grok"), "accept", 2);
  const card = readScorecard(d);
  assert.equal(card.agents.devin.jobs, 1);
  assert.ok(!card.agents.grok, "first agent wins the goal:job key");
}
// Practice detection is a raw prefix match on summary.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  recordReview(d, job(1, "devin", { summary: "(practice run g1)" }), "accept", 1);
  recordReview(d, job(2, "devin", { summary: "(practice" }), "accept", 2);
  recordReview(d, job(3, "devin", { summary: "practice run)" }), "accept", 3);
  const card = readScorecard(d);
  assert.equal(card.agents.devin.jobs, 2, "only the '(practice run' prefix is skipped");
  assert.ok(card.seen.includes("g1:3"));
}

// ---- recordReview return value on ignored input is a fresh read, not a write ----
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  recordReview(d, job(1, "devin"), "accept", 1);
  const ignored = recordReview(d, job(2, "devin"), "bogus", 2);
  assert.equal(ignored.agents.devin.jobs, 1);
  assert.ok(!ignored.seen.includes("g1:2"));
}

// ---- sizeHint boundaries the main test doesn't pin down ----
assert.deepEqual(sizeHint({ jobs: 5, acceptRate: 1, avgMs: 20 * 60e3 + 1 }),
  { maxFiles: 3, note: "reliable; slow jobs" }, "1ms over 20min is slow");
assert.deepEqual(sizeHint({ jobs: 5, acceptRate: 0.799, avgMs: null }),
  { maxFiles: 2, note: "sometimes sent back: keep it small" }, "just under 0.8 stays small");
assert.deepEqual(sizeHint({ jobs: 5, acceptRate: 0.8, avgMs: null }),
  { maxFiles: 4, note: "reliable" }, "exactly 0.8 is reliable");
assert.deepEqual(sizeHint({ jobs: 5, acceptRate: null, avgMs: 30 * 60e3 }),
  { maxFiles: 3, note: "reliable; slow jobs" }, "no reviews + slow -> reliable; slow jobs");
assert.deepEqual(sizeHint({ jobs: 2, acceptRate: 0.6, avgMs: 25 * 60e3 }),
  { maxFiles: 1, note: "sometimes sent back: keep it small; slow jobs" }, "slow shaves the middle hint to the floor");
assert.deepEqual(sizeHint({ jobs: 1, acceptRate: 0.4, avgMs: 25 * 60e3 }),
  { maxFiles: 1, note: "sometimes sent back: keep it small; slow jobs" }, "1 job never hits 'often sent back' but slow still shaves");
assert.deepEqual(sizeHint({ jobs: 2, acceptRate: 0.5, avgMs: null }),
  { maxFiles: 2, note: "sometimes sent back: keep it small" }, "exactly 0.5 is not 'often'");
assert.deepEqual(sizeHint({ jobs: Number.MAX_SAFE_INTEGER, acceptRate: 1, avgMs: null }),
  { maxFiles: 4, note: "reliable" }, "huge job count stays reliable");

// ---- rankAgents edges ----
assert.deepEqual(rankAgents(["a", "a"], { agents: {} }), ["a", "a"], "duplicate ids pass through");
assert.deepEqual(rankAgents(["a"], null), ["a"], "null card -> default rate, stable");
assert.deepEqual(rankAgents(["a"], undefined), ["a"]);
// No decided reviews (rate 0.7 for both) still breaks the tie on avg tokens.
{
  const c = { agents: {
    pricey: { jobs: 3, accepted: 0, sentBack: 0, tokensSum: 9000, tokensN: 3, msSum: 0, msN: 0, recent: [] },
    cheapo: { jobs: 3, accepted: 0, sentBack: 0, tokensSum: 300, tokensN: 3, msSum: 0, msN: 0, recent: [] },
  } };
  assert.deepEqual(rankAgents(["pricey", "cheapo"], c), ["cheapo", "pricey"],
    "undecided agents rank by avg tokens too");
}
// A decided agent with rate > 0.7 beats an undecided one even with worse tokens.
{
  const c = { agents: {
    hot: { jobs: 4, accepted: 3, sentBack: 1, tokensSum: 99999, tokensN: 4, msSum: 0, msN: 0, recent: [] },
    cold: { jobs: 4, accepted: 0, sentBack: 0, tokensSum: 1, tokensN: 4, msSum: 0, msN: 0, recent: [] },
  } };
  assert.deepEqual(rankAgents(["cold", "hot"], c), ["hot", "cold"]);
}
// Malformed stored agent entries don't crash ranking.
assert.doesNotThrow(() => rankAgents(["x", "y"], { agents: { x: "junk", y: 42 } }));

// ---- scoreRows / scoreLine edges ----
{
  const rows = scoreRows({ agents: { "": { jobs: 1, accepted: 0, sentBack: 1, tokensSum: 0, tokensN: 0, msSum: 0, msN: 0, recent: [] } } });
  assert.equal(rows[0].agent, "");
  assert.equal(scoreLine(rows[0]), ": 1 jobs, 0 accepted, 1 sent back", "empty agent id still prints");
}
// avgTokens = 0 is a real value and is printed (not treated as missing).
assert.equal(
  scoreLine({ agent: "z", name: null, jobs: 1, accepted: 1, sentBack: 0, acceptRate: 1, avgTokens: 0, avgMs: null }),
  "z: 1 jobs, 1 accepted, 0 sent back, avg 0 tokens",
  "name null falls back to agent; avgTokens 0 is shown");
// avgMs = 0 prints "0s"; missing name falls back to agent id.
assert.equal(
  scoreLine({ agent: "q", jobs: 2, accepted: 2, sentBack: 0, acceptRate: 1, avgTokens: null, avgMs: 0 }),
  "q: 2 jobs, 2 accepted, 0 sent back, avg 0s");
// scoreRows tolerates a null/undefined card and missing agent fields.
assert.deepEqual(scoreRows(null), []);
assert.deepEqual(scoreRows({}), []);
assert.doesNotThrow(() => scoreRows({ agents: { a: {} } }));

// ---- Edge cases that used to be real bugs, now fixed ----

// Two reviewed jobs with no `id` in the same goal have no dedup key, so
// both count (previously they shared "goal:undefined" and the second was
// silently dropped).
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  const noId = (extra = {}) => ({ goal: "g1", agent: "devin", startedAt: 1, finishedAt: 2, ...extra });
  recordReview(d, noId(), "accept", 1);
  recordReview(d, noId(), "accept", 2);
  assert.equal(readScorecard(d).agents.devin.jobs, 2, "two id-less jobs should both count");
}

// Practice detection is a strict match on the real "(practice run ..." shape,
// so a real job whose summary starts "(practice runbook)" still counts.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  recordReview(d, job(1, "devin", { summary: "(practice runbook) update docs" }), "accept", 1);
  assert.equal(readScorecard(d).agents.devin.jobs, 1, "real summary starting with the prefix should count");
}

// A job with finishedAt < startedAt records no ms sample, so avgMs can't go
// negative and scoreLine can't end with a dangling ", avg ".
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  recordReview(d, job(1, "devin", { startedAt: 10000, finishedAt: 5000 }), "accept", 1);
  const a = readScorecard(d).agents.devin;
  assert.ok(a.msSum >= 0, "negative durations should not be recorded");
  const line = scoreLine(scoreRows(readScorecard(d))[0]);
  assert.ok(!line.endsWith(", avg "), "scoreLine should not end with a dangling avg");
}

// ---- readScorecard: more corrupt/missing input ----
{
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-")), "nope");
  assert.deepEqual(readScorecard(missing), { agents: {}, seen: [] }, "state dir does not exist -> empty card");
}
for (const [label, buf] of [
  ["invalid utf-8", Buffer.from([0xff, 0xfe, 0x7b, 0x22, 0x61, 0x22])],
  ["utf-8 BOM", Buffer.from("﻿{\"agents\":{}}", "utf8")],
  ["trailing garbage", Buffer.from("{\"agents\":{}} trailing", "utf8")],
  ["empty file", Buffer.from("", "utf8")],
]) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  fs.writeFileSync(scorecardFile(d), buf);
  assert.deepEqual(readScorecard(d), { agents: {}, seen: [] }, label);
}
// A stray tmp file from a crashed write is ignored; the real file still reads.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  recordReview(d, job(1, "devin"), "accept", 1);
  fs.writeFileSync(scorecardFile(d) + ".12345.tmp", "{garbage", "utf8");
  fs.writeFileSync(scorecardFile(d) + ".99999.tmp", JSON.stringify({ agents: { ghost: { jobs: 9 } }, seen: ["x"] }), "utf8");
  const card = readScorecard(d);
  assert.equal(card.agents.devin.jobs, 1);
  assert.ok(!card.agents.ghost, "tmp files are not read");
  // And a new review still writes cleanly over them.
  recordReview(d, job(2, "devin"), "accept", 2);
  assert.equal(readScorecard(d).agents.devin.jobs, 2);
}
// Unknown fields stored on an agent entry survive a recordReview round-trip
// (readScorecard spreads the stored object over the zeroed template).
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  fs.writeFileSync(scorecardFile(d), JSON.stringify({
    agents: { devin: { jobs: 5, accepted: 4, sentBack: 1, note: "keep me", recent: [] } },
    seen: ["g0:old"],
  }), "utf8");
  const card = recordReview(d, job(9, "devin"), "accept", 1);
  assert.equal(card.agents.devin.note, "keep me", "custom field preserved");
  assert.equal(readScorecard(d).agents.devin.note, "keep me", "custom field persisted");
}
// Stored counters of the wrong type flow into scoreRows without throwing;
// the derived rate is NaN rather than a crash.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  fs.writeFileSync(scorecardFile(d), JSON.stringify({
    agents: { weird: { jobs: "lots", accepted: "yes", sentBack: 1, tokensSum: "x", tokensN: "y", msSum: "z", msN: "w", recent: "not-array" } },
    seen: ["g:1"],
  }), "utf8");
  const rows = scoreRows(readScorecard(d));
  assert.equal(rows.length, 3, "weird agent plus the two seeded zero rows");
  const weird = rows.find((r) => r.agent === "weird");
  assert.ok(Number.isNaN(weird.acceptRate), "string counters -> NaN rate, no throw");
}

// ---- recordReview: more validation edges ----
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  // Non-finite startedAt values are all ignored.
  for (const s of [Infinity, -Infinity, NaN]) {
    assert.deepEqual(recordReview(d, job(1, "devin", { startedAt: s }), "accept", 1), { agents: {}, seen: [] }, `startedAt ${s}`);
  }
  assert.ok(!fs.existsSync(scorecardFile(d)));
  // finishedAt === startedAt is a real 0ms sample, not skipped.
  const card = recordReview(d, job(1, "devin", { startedAt: 5000, finishedAt: 5000, tokens: { n: 7 } }), "accept", 1);
  assert.equal(card.agents.devin.msSum, 0);
  assert.equal(card.agents.devin.msN, 1, "zero-length job still counts as a timing sample");
  assert.equal(card.agents.devin.recent[0].ms, 0);
}
// summary of any non-string type is stringified, never crashes; only the
// "(practice run" prefix skips.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  recordReview(d, job(1, "devin", { summary: 42 }), "accept", 1);
  recordReview(d, job(2, "devin", { summary: { text: "x" } }), "accept", 2);
  recordReview(d, job(3, "devin", { summary: null }), "accept", 3);
  assert.equal(readScorecard(d).agents.devin.jobs, 3, "non-string summaries all count");
}
// `now` is stored verbatim in recent[].at — the module does no clock
// validation; callers are trusted to pass a timestamp.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  recordReview(d, job(1, "devin"), "accept", "not-a-time");
  assert.equal(readScorecard(d).agents.devin.recent[0].at, "not-a-time");
}
// Falsy-but-present ids still get dedup keys.
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  recordReview(d, job(false, "devin"), "accept", 1);
  recordReview(d, job(false, "devin"), "send-back", 2);
  const card = readScorecard(d);
  assert.equal(card.agents.devin.jobs, 1, "id false dedups like any other key");
  assert.deepEqual(card.seen, ["g1:false"]);
}
// recordReview re-reads the file every call: mutating a returned card does
// not leak into the next review, and edits made by "another writer" between
// calls are honoured (seen keys dedup, agent rows merge).
{
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
  const c1 = recordReview(d, job(1, "devin"), "accept", 1);
  c1.agents.devin.jobs = 999;
  c1.seen.push("g1:fake");
  const c2 = recordReview(d, job(2, "devin"), "accept", 2);
  assert.equal(c2.agents.devin.jobs, 2, "mutated return value did not corrupt state");
  assert.ok(!c2.seen.includes("g1:fake"));
  // Simulate a concurrent writer landing a review + a seen key first.
  fs.writeFileSync(scorecardFile(d), JSON.stringify({
    agents: { grok: { jobs: 4, accepted: 4, sentBack: 0, tokensSum: 0, tokensN: 0, msSum: 0, msN: 0, recent: [] } },
    seen: ["g9:77"],
  }), "utf8");
  const c3 = recordReview(d, job(3, "devin"), "accept", 3);
  assert.equal(c3.agents.grok.jobs, 4, "other writer's agent row survives the merge");
  assert.ok(c3.seen.includes("g9:77"), "other writer's seen keys survive");
  const c4 = recordReview(d, job(77, "devin", { goal: "g9" }), "accept", 4);
  assert.equal(c4.seen.filter((k) => k === "g9:77").length, 1, "seen key from another writer still dedups");
  assert.equal(c4.agents.devin.jobs, 1, "deduped job not counted (devin's row restarted with the overwrite)");
}

// ---- sizeHint / rankAgents / scoreRows / scoreLine: remaining pure edges ----
assert.deepEqual(sizeHint({ jobs: NaN, acceptRate: 1, avgMs: null }),
  { maxFiles: 2, note: "no record yet: start small" }, "NaN jobs is falsy -> no record");
assert.deepEqual(sizeHint({ jobs: 5, acceptRate: NaN, avgMs: null }),
  { maxFiles: 4, note: "reliable" }, "NaN acceptRate falls through to reliable");
assert.deepEqual(sizeHint({}), { maxFiles: 2, note: "no record yet: start small" }, "empty row -> no record");
assert.deepEqual(sizeHint({ jobs: 5, acceptRate: 1, avgMs: -5 }),
  { maxFiles: 4, note: "reliable" }, "negative avgMs is not slow");
// rankAgents tolerates every malformed stored entry shape.
assert.doesNotThrow(() => rankAgents(["a", "b", "c", "d"], { agents: { a: null, b: 42, c: "x", d: { accepted: "y", sentBack: "z" } } }));
assert.deepEqual(rankAgents(["a"], { agents: { a: null } }), ["a"], "null entry -> default rate");
// scoreRows: a hand-built card whose `seen` is not an array seeds no rows.
assert.deepEqual(scoreRows({ agents: { devin: { jobs: 1, accepted: 1, sentBack: 0, tokensSum: 0, tokensN: 0, msSum: 0, msN: 0, recent: [] } }, seen: "not-array" }).map((r) => r.agent),
  ["devin"], "non-array seen -> no ALWAYS_ROWED seed");
// scoreRows calls the name mapper once per row with the agent id.
{
  const seenIds = [];
  scoreRows({ agents: { b: { jobs: 1 }, a: { jobs: 2 } } }, (id) => { seenIds.push(id); return id.toUpperCase(); });
  assert.deepEqual(new Set(seenIds), new Set(["a", "b"]));
}
// scoreLine: empty-string name is not nullish, so it wins over the agent id.
assert.equal(
  scoreLine({ agent: "z", name: "", jobs: 1, accepted: 1, sentBack: 0, acceptRate: 1, avgTokens: null, avgMs: null }),
  ": 1 jobs, 1 accepted, 0 sent back");
// Negative avgTokens still prints (fmtTokens rounds it like any number).
assert.equal(
  scoreLine({ agent: "z", name: "Z", jobs: 1, accepted: 1, sentBack: 0, acceptRate: 1, avgTokens: -50.4, avgMs: null }),
  "Z: 1 jobs, 1 accepted, 0 sent back, avg -50 tokens");
// Huge avgTokens rolls up to the next unit without crashing.
assert.equal(
  scoreLine({ agent: "z", name: "Z", jobs: 1, accepted: 1, sentBack: 0, acceptRate: 1, avgTokens: 2.5e12, avgMs: null }),
  "Z: 1 jobs, 1 accepted, 0 sent back, avg 2.5T tokens");

// ---- Real bugs found while probing (left commented; do not "fix" the tests) ----
//
// BUG 1 — agent ids "__proto__" and "constructor" crash recordReview AND
// pollute globals. card.agents is a plain object, so
// `card.agents[agent] ||= EMPTY_AGENT()` resolves "__proto__" to
// Object.prototype (truthy) and "constructor" to the Object function; the
// code then does `a.jobs += 1` (NaN) and `a.recent.push(...)` -> TypeError.
// Verified: recordReview(dir, {id:1, goal:"g", agent:"__proto__", startedAt:1,
// finishedAt:2}, "accept") throws "Cannot read properties of undefined
// (reading 'push')" and leaves Object.prototype.jobs === NaN (and
// Object.jobs === NaN for "constructor") — prototype pollution in the
// caller's process. readScorecard has the mirror bug: `agents["__proto__"]
// = {...}` reassigns the prototype instead of storing an own property, so a
// stored "__proto__" agent row silently vanishes from scoreRows.
//   const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
//   assert.throws(() => recordReview(d, job(1, "__proto__"), "accept", 1)); // BUG: should record, not throw/pollute
//
// BUG 2 — non-primitive/NaN job ids collide in the dedup key. The key is
// `job.goal + ":" + job.id`, so id NaN -> "g:NaN" and id {} -> "g:[object
// Object]": two different jobs with the same goal silently dedup into one.
// Verified: two recordReview calls with id: NaN leave agents.a.jobs === 1
// and seen === ["g:NaN"]. Same for goal coercion: goal undefined and goal
// "undefined" both produce "undefined:<id>".
//   const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-deep-"));
//   recordReview(d, { id: NaN, goal: "g", agent: "a", startedAt: 1, finishedAt: 2 }, "accept", 1);
//   recordReview(d, { id: NaN, goal: "g", agent: "a", startedAt: 1, finishedAt: 2 }, "accept", 2);
//   assert.equal(readScorecard(d).agents.a.jobs, 2); // BUG: currently 1
//
// BUG 3 — scoreLine can emit a dangling ", avg " for a negative avgMs:
// `took()` returns "" for ms < 0 but scoreLine still appends ", avg ".
// Unreachable via recordReview (negative spans are never stored), but
// scoreLine is exported and takes any row.
//   assert.ok(!scoreLine({ agent: "z", name: "Z", jobs: 1, accepted: 1, sentBack: 0, acceptRate: 1, avgTokens: null, avgMs: -5 }).endsWith(", avg ")); // BUG: currently does
//
// BUG 4 — recordReview is an unlocked read-modify-write; concurrent writers
// lose updates. Spawning 4 processes x 80 reviews against one scorecard dir
// left only 177 of 320 jobs recorded (atomic rename prevents corruption but
// not lost updates). Probably fine while a single Constance driver is the
// only writer, but nothing enforces that.
//   // (verified manually with child processes; too heavy/flaky for this file)

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(process.env.HOME, { recursive: true, force: true });
fs.rmSync(process.env.XDG_STATE_HOME, { recursive: true, force: true });
fs.rmSync(process.env.XDG_CONFIG_HOME, { recursive: true, force: true });
fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true, force: true });
console.log("constance-scorecard.deep: tests passed");
