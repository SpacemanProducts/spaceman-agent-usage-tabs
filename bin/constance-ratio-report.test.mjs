// Constance's ratio report: ratioReport sums job tokens into devinTokens and
// perPct against the session window spent, measures each step in tokens or
// step counts, averages copies, turns sample gaps into idle slot-minutes and
// ranks up to three fixes (idle, Opus reviews, sent-backs, low perPct).
// saveReport appends {kind:'ratio'} to history.jsonl and returns lessons.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "constance-ratio-home-"));
process.env.HOME = home;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-ratio-"));

const { ratioReport, idleMinutes, saveReport } = await import("./constance-ratio-report.mjs");

// idleMinutes: gaps times free slots, floored at zero, tenth-minute rounding.
assert.equal(idleMinutes([], 10), 0);
assert.equal(idleMinutes([{ at: 0, copiesRunning: 10 }], 10), 0, "one sample -> no gaps");
assert.equal(idleMinutes([{ at: 0, copiesRunning: 4 }, { at: 30 * 60e3, copiesRunning: 9 }], 10), 180,
  "(10-4) slots idle for 30 min");
assert.equal(idleMinutes([{ at: 0, copiesRunning: 12 }, { at: 60e3, copiesRunning: 0 }], 10), 0,
  "over-subscribed slots never go negative");
assert.equal(idleMinutes([{ at: 60e3, copiesRunning: 0 }, { at: 0, copiesRunning: 0 }], 10), 10,
  "unsorted samples are sorted first: one 1-min gap at 0 copies");

// Fixed fake goal: two Devin copies plus one Grok job, some sent back.
const jobs = [
  { id: 1, agent: "devin", tokens: 4_000_000, verdict: "accept" },
  { id: 2, agent: "devin", tokens: { n: 2_000_000 }, verdict: "send-back" },
  { id: 3, agent: "grok", tokens: 1_000_000, verdict: "accept" },
  { id: 4, agent: "codex", tokens: 500_000 },                       // undecided, tokens still count
  { id: 5, agent: "devin" },                                          // no tokens: never estimated
];
const routes = [
  { step: "planning", model: "claude-opus-4-6", tokens: 800_000 },
  { step: "specs", model: "claude-sonnet-4-6", tokens: 300_000 },
  { step: "reviews", model: "claude-opus-4-6", tokens: 600_000 },
  { step: "reviews", model: "devin", tokens: 200_000 },
  { step: "fixes", model: "claude-haiku-4-5" },                        // no tokens -> count mode
  { step: "fixes", model: "devin" },
  { step: "other", model: "claude-opus-4-6", tokens: 9_999 },          // unknown step ignored
];
const samples = [
  { at: 0, copiesRunning: 2 },
  { at: 10 * 60e3, copiesRunning: 8 },
  { at: 40 * 60e3, copiesRunning: 8 },
  { at: 70 * 60e3, copiesRunning: 3 },
];
// idle: gap1 (10min, 2 running): (10-2)*10 = 80; gap2 (30min, 8): (10-8)*30 = 60;
// gap3 (30min, 8): (10-8)*30 = 60  -> 200 slot-minutes
const r = ratioReport({
  goal: { id: 7, title: "ratio test" },
  jobs, routes, samples, slots: 10,
  sessionStartPct: 10, sessionEndPct: 30,   // 20 points spent
});

assert.equal(r.goal, 7);
assert.equal(r.devinTokens, 7_500_000, "bare and {n} tokens sum; missing tokens skipped");
assert.equal(r.perPct, 7_500_000 / 20);
assert.equal(r.sessionPct.spent, 20);
assert.equal(r.idleSlotMinutes, 200);
assert.equal(r.copiesAvg, 5.3, "(2+8+8+3)/4 rounded to a tenth");
assert.equal(r.samples, 4);
assert.equal(r.sentBack, 1);
assert.equal(r.decided, 3);
assert.equal(r.sentBackRate, 1 / 3);

// opusByStep: token steps sum tokens; fixes has no tokens so it counts rows.
assert.deepEqual(
  { total: r.opusByStep.planning.total, opus: r.opusByStep.planning.opus, share: r.opusByStep.planning.share, unit: r.opusByStep.planning.unit },
  { total: 800_000, opus: 800_000, share: 1, unit: "tokens" });
assert.equal(r.opusByStep.reviews.total, 800_000);
assert.equal(r.opusByStep.reviews.opus, 600_000);
assert.equal(r.opusByStep.reviews.share, 0.75);
assert.deepEqual(
  { total: r.opusByStep.fixes.total, opus: r.opusByStep.fixes.opus, unit: r.opusByStep.fixes.unit },
  { total: 2, opus: 0, unit: "steps" }, "count mode: haiku + devin rows, neither Opus");
assert.equal(r.opusByStep.fixes.share, 0);
assert.equal(r.opusByStep.specs.share, 0);
assert.ok(!("other" in r.opusByStep), "unknown steps ignored");

// topFixes: all four rules trigger; the first three in rule order win
// (idle, Opus reviews, sent-backs) and low perPct is the one left off.
assert.equal(r.topFixes.length, 3);
assert.ok(r.topFixes[0].includes("200 slot-minutes"), r.topFixes[0]);
assert.ok(r.topFixes[1].includes("75% of review work"), r.topFixes.join(" | "));
assert.ok(r.topFixes[2].includes("33% of decided jobs"), r.topFixes.join(" | "));
assert.ok(!r.topFixes.some((t) => t.includes("per 1% of her session (target")), "perPct fix ranks last");
assert.ok(r.text.includes("7.5M free-worker tokens"), r.text);
assert.ok(r.text.includes("Fixes:"), r.text);
assert.ok(Array.isArray(r.lessons) && r.lessons.length >= 1 && r.lessons.length <= 3);

// Quiet goal: no idle, Opus-free routing, all accepted, tiny spend -> nulls.
const quiet = ratioReport({
  goal: "g2", jobs: [{ tokens: 1000, verdict: "accept" }],
  routes: [{ step: "reviews", model: "devin", tokens: 10 }],
  samples: [{ at: 0, copiesRunning: 10 }, { at: 60e3, copiesRunning: 10 }],
  sessionStartPct: 50, sessionEndPct: 50.2,   // 0.2 pts < 0.5 floor
});
assert.equal(quiet.devinTokens, 1000);
assert.equal(quiet.perPct, null, "below MIN_SPENT_PCT -> null");
assert.equal(quiet.idleSlotMinutes, 0);
assert.equal(quiet.sentBackRate, 0);
assert.equal(quiet.topFixes.length, 0);
assert.ok(quiet.text.includes("not enough of her session spent"), quiet.text);
assert.deepEqual(quiet.lessons, []);

// No tokens at all -> devinTokens and perPct stay honest nulls.
const bare = ratioReport({ goal: "g3", jobs: [{ verdict: "accept" }], sessionStartPct: 0, sessionEndPct: 10 });
assert.equal(bare.devinTokens, null);
assert.equal(bare.perPct, null);
assert.ok(bare.text.includes("no worker tokens reported"), bare.text);

// saveReport appends {kind:'ratio'} and returns the lesson lines.
const lessons = saveReport(dir, r, 1234);
assert.deepEqual(lessons, r.lessons);
const lines = fs.readFileSync(path.join(dir, "history.jsonl"), "utf8").trim().split("\n");
assert.equal(lines.length, 1);
const rec = JSON.parse(lines[0]);
assert.equal(rec.kind, "ratio");
assert.equal(rec.at, 1234);
assert.equal(rec.goal, 7);
assert.equal(rec.devinTokens, 7_500_000);
assert.equal(rec.idleSlotMinutes, 200);
saveReport(dir, quiet, 2000);
assert.equal(fs.readFileSync(path.join(dir, "history.jsonl"), "utf8").trim().split("\n").length, 2,
  "appends, never overwrites");

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
console.log("constance-ratio-report: tests passed");
