// Constance's per-agent scorecard: reviewed jobs per agent, deduped by
// goal:job id, practice runs ignored, recent capped at 20, seen at 500.
// scoreRows sorts by jobs, sizeHint picks a task size, rankAgents orders
// candidates, scoreLine is the one-line summary.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scorecardFile, readScorecard, recordReview, scoreRows, sizeHint, rankAgents, scoreLine } from "./constance-scorecard.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-"));

// Missing and broken files give an empty card.
assert.deepEqual(readScorecard(dir), { agents: {}, seen: [] });
fs.writeFileSync(scorecardFile(dir), "{not json", "utf8");
assert.deepEqual(readScorecard(dir), { agents: {}, seen: [] }, "broken file -> empty card");

const job = (id, agent, extra = {}) => ({ id, goal: "g1", agent, startedAt: 1000, finishedAt: 61000, files: ["a", "b"], ...extra });

// First review counts: jobs/accepted/sentBack, tokens and ms averages feed.
let card = recordReview(dir, job(1, "devin", { tokens: { n: 1000 } }), "accept", 5000);
assert.equal(card.agents.devin.jobs, 1);
assert.equal(card.agents.devin.accepted, 1);
assert.equal(card.agents.devin.sentBack, 0);
assert.equal(card.agents.devin.tokensSum, 1000);
assert.equal(card.agents.devin.tokensN, 1);
assert.equal(card.agents.devin.msSum, 60000);
assert.equal(card.agents.devin.msN, 1);
assert.deepEqual(card.agents.devin.recent[0], { job: 1, verdict: "accept", tokens: 1000, ms: 60000, files: 2, at: 5000 });
assert.deepEqual(card.seen, ["g1:1"]);

// send-back counts the other way; tokens without finite n and non-numeric
// times are skipped honestly.
recordReview(dir, job(2, "devin", { tokens: { n: "x" }, startedAt: undefined }), "send-back", 6000);
assert.equal(card.agents.devin.jobs, 1, "unstarted job ignored");
card = recordReview(dir, job(2, "devin", { tokens: { n: "x" }, startedAt: "soon" }), "send-back", 6000);
assert.equal(card.agents.devin.jobs, 1, "non-numeric startedAt ignored");
card = recordReview(dir, job(2, "devin", { tokens: { n: 2000 } }), "send-back", 6000);
assert.equal(card.agents.devin.sentBack, 1);
assert.equal(card.agents.devin.tokensN, 2, "finite token counts kept");

// Double-record protection: same goal:job id never counts twice, even a
// different verdict.
const before = card.agents.devin.jobs;
card = recordReview(dir, job(1, "devin"), "send-back", 7000);
assert.equal(card.agents.devin.jobs, before, "seen key blocks recount");
assert.equal(card.agents.devin.sentBack, 1, "verdict unchanged");
assert.equal(card.seen.length, 2, "no duplicate seen entry");

// Practice runs and missing startedAt are ignored entirely (no seen entry).
card = recordReview(dir, job(3, "grok", { summary: "(practice run g1)" }), "accept", 8000);
card = recordReview(dir, { id: 4, goal: "g1", agent: "grok", finishedAt: 5 }, "accept", 8000);
assert.ok(!card.agents.grok, "practice and unstarted jobs leave no agent record");
assert.ok(!card.seen.includes("g1:3") && !card.seen.includes("g1:4"));

// Same job id under a different goal is a different key.
card = recordReview(dir, job(1, "devin", { goal: "g2" }), "accept", 9000);
assert.equal(card.agents.devin.jobs, before + 1);
assert.ok(card.seen.includes("g2:1"));

// State survives a fresh read from disk.
const reread = readScorecard(dir);
assert.equal(reread.agents.devin.jobs, card.agents.devin.jobs);
assert.deepEqual(reread.seen, card.seen);

// scoreRows: sorted by jobs desc, then agent id; rates and averages.
const rows = scoreRows(card, (id) => ({ devin: "Devin", grok: "Grok" }[id] || id));
assert.equal(rows[0].agent, "devin");
assert.equal(rows[0].name, "Devin");
assert.equal(rows[0].jobs, 3);
assert.equal(rows[0].acceptRate, 2 / 3);
assert.equal(rows[0].avgTokens, Math.round((1000 + 2000) / 2));
assert.equal(rows[0].avgMs, 60000);

// An agent with jobs but no finished job still reports decided counts.
const empty = scoreRows({ agents: { zeta: { jobs: 0, accepted: 0, sentBack: 0, tokensSum: 0, tokensN: 0, msSum: 0, msN: 0, recent: [] },
  alpha: { jobs: 2, accepted: 2, sentBack: 0, tokensSum: 0, tokensN: 0, msSum: 0, msN: 0, recent: [] } } });
assert.deepEqual(empty.map((r) => r.agent), ["alpha", "zeta"], "jobs desc, id tiebreak");
assert.equal(empty[1].acceptRate, null, "nothing decided -> null rate");
assert.equal(empty[1].avgTokens, null);
assert.equal(empty[1].avgMs, null);

// sizeHint thresholds.
assert.deepEqual(sizeHint(null), { maxFiles: 2, note: "no record yet: start small" });
assert.deepEqual(sizeHint({ jobs: 0, acceptRate: null, avgMs: null }), { maxFiles: 2, note: "no record yet: start small" });
assert.deepEqual(sizeHint({ jobs: 1, acceptRate: 0, avgMs: null }), { maxFiles: 2, note: "sometimes sent back: keep it small" }, "jobs < 2 stays at the middle hint");
assert.deepEqual(sizeHint({ jobs: 2, acceptRate: 0.5, avgMs: null }), { maxFiles: 2, note: "sometimes sent back: keep it small" });
assert.deepEqual(sizeHint({ jobs: 2, acceptRate: 0.49, avgMs: null }), { maxFiles: 1, note: "often sent back: one narrow file" });
assert.deepEqual(sizeHint({ jobs: 3, acceptRate: 0.8, avgMs: null }), { maxFiles: 4, note: "reliable" });
assert.deepEqual(sizeHint({ jobs: 5, acceptRate: null, avgMs: null }), { maxFiles: 4, note: "reliable" }, "no decided reviews -> reliable");
assert.deepEqual(sizeHint({ jobs: 5, acceptRate: 1, avgMs: 21 * 60e3 }), { maxFiles: 3, note: "reliable; slow jobs" }, "slow jobs shave one file");
assert.deepEqual(sizeHint({ jobs: 5, acceptRate: 0.4, avgMs: 25 * 60e3 }), { maxFiles: 1, note: "often sent back: one narrow file; slow jobs" }, "slow never goes below 1");
assert.deepEqual(sizeHint({ jobs: 5, acceptRate: 1, avgMs: 20 * 60e3 }), { maxFiles: 4, note: "reliable" }, "exactly 20 min is not slow");

// rankAgents: accept rate first (no reviews = 0.7), then lower avg tokens,
// then original order.
const rankCard = { agents: {
  great: { jobs: 2, accepted: 2, sentBack: 0, tokensSum: 500, tokensN: 1, msSum: 0, msN: 0, recent: [] },
  ok:    { jobs: 2, accepted: 1, sentBack: 1, tokensSum: 0, tokensN: 0, msSum: 0, msN: 0, recent: [] },
  cheap: { jobs: 1, accepted: 0, sentBack: 1, tokensSum: 100, tokensN: 1, msSum: 0, msN: 0, recent: [] },
} };
assert.deepEqual(rankAgents(["cheap", "ok", "great", "newbie"], rankCard), ["great", "newbie", "ok", "cheap"],
  "no reviews counts as 0.7, beating a decided 0.5");
assert.deepEqual(rankAgents(["cheap", "ok"], rankCard).slice(0, 2), ["ok", "cheap"], "decided 0.5 beats decided 0");
assert.deepEqual(rankAgents([], rankCard), []);
// Token tiebreak: same rate, lower avgTokens first.
const tokCard = { agents: {
  hi: { jobs: 1, accepted: 1, sentBack: 0, tokensSum: 9000, tokensN: 1, msSum: 0, msN: 0, recent: [] },
  lo: { jobs: 1, accepted: 1, sentBack: 0, tokensSum: 100, tokensN: 1, msSum: 0, msN: 0, recent: [] },
  unk: { jobs: 1, accepted: 1, sentBack: 0, tokensSum: 0, tokensN: 0, msSum: 0, msN: 0, recent: [] },
} };
assert.deepEqual(rankAgents(["unk", "hi", "lo"], tokCard), ["lo", "hi", "unk"], "avg tokens asc, unknown last");
assert.deepEqual(rankAgents(["b", "a"], { agents: {} }), ["b", "a"], "equal everything -> stable order");

// scoreLine: one plain line, missing parts left out.
assert.equal(scoreLine(rows[0]), "Devin: 3 jobs, 2 accepted, 1 sent back, avg 1.5K tokens, avg 1m");
assert.equal(scoreLine({ agent: "x", name: "X", jobs: 1, accepted: 0, sentBack: 1, acceptRate: 0, avgTokens: null, avgMs: null }),
  "X: 1 jobs, 0 accepted, 1 sent back");
assert.equal(scoreLine(null), "");

// The 20/500 caps.
const capDir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-scorecard-cap-"));
for (let i = 0; i < 25; i++) recordReview(capDir, job(100 + i, "devin"), i % 2 ? "send-back" : "accept", i);
assert.equal(readScorecard(capDir).agents.devin.recent.length, 20, "recent keeps newest 20");
assert.equal(readScorecard(capDir).agents.devin.jobs, 25);
assert.equal(readScorecard(capDir).seen.length, 25);
// Feed seen past 500 with unique keys.
for (let i = 0; i < 500; i++) recordReview(capDir, job(1000 + i, "grok", { goal: "bulk" }), "accept", i);
const capped = readScorecard(capDir);
assert.equal(capped.seen.length, 500, "seen keeps newest 500");
assert.ok(capped.seen.includes("bulk:1499"), "newest kept");
assert.ok(!capped.seen.includes("g1:100"), "oldest seen entry evicted");

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(capDir, { recursive: true, force: true });
console.log("constance-scorecard: tests passed");
