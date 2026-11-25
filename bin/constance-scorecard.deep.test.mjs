// Deeper edge-case tests for constance-scorecard.mjs: malformed scorecard.json
// shapes, boundary verdicts/times/tokens, dedup quirks and pure-function edges
// the main test doesn't reach. Anything that looks like a real bug is left as
// a commented-out test with a note instead of being fixed here.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-home-"));

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

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(process.env.HOME, { recursive: true, force: true });
console.log("constance-scorecard.deep: tests passed");
