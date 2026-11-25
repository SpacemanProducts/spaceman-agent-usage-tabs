// The job board, the "Now" line and goal history: each job's status in the owner's words, a compact
// card, a plain sentence of what is happening, and past goals (recorded, or rebuilt from the log).
import assert from "node:assert/strict";
import { jobStatus, jobTitle, jobResult, cards, nowLine, goalRecord, goalsFromLog, history, took } from "./constance-board.mjs";

const PRACTICE = "(practice run: the prompt is in the log, nothing was launched)";
assert.equal(jobStatus({ status: "waiting" }), "queued");
assert.equal(jobStatus({ status: "held" }), "held");
assert.equal(jobStatus({ status: "running" }), "running");
assert.equal(jobStatus({ status: "finished" }), "in review");
assert.equal(jobStatus({ status: "accepted" }), "merged");
assert.equal(jobStatus({ status: "sent back" }), "sent back");
assert.equal(jobStatus({ status: "conflict" }), "conflict");
assert.equal(jobStatus({ status: "stopped" }), "stopped");
assert.equal(jobStatus({ status: "finished", summary: PRACTICE }), "practice");

assert.equal(jobTitle({ title: "fixing the guard", task: "long" }), "fixing the guard");
assert.equal(jobTitle({ task: "Trip mode savings: a usual item like coffee. More." }), "Trip mode savings");
assert.equal(jobTitle({ task: "x".repeat(100) }).length, 60);
assert.equal(jobResult({ status: "accepted", reviewNote: "verified\nmore", summary: "did it" }), "verified");
assert.equal(jobResult({ status: "finished", summary: "\n added tests \n" }), "added tests");
assert.match(jobResult({ status: "conflict" }), /Merge conflict/);
assert.match(jobResult({ status: "held", heldReason: "machine busy" }), /Held: machine busy/);

const goal = { id: "g", text: "1. a\n2. b", status: "running" };
const jobs = [
  { id: 2, goal: "g", agent: "devin", worker: "Devin 2", status: "running", title: "Fixing the guard", files: ["a.js"], items: [1], startedAt: 1000 },
  { id: 1, goal: "g", agent: "grok", status: "accepted", task: "Add tests. Then more.", files: [], startedAt: 100, finishedAt: 700, reviewNote: "good", tokens: { n: 12400 } },
  { id: 3, goal: "g", agent: "devin", worker: "Devin 3", status: "finished", task: "c", startedAt: 200, finishedAt: 900 },
  { id: 4, goal: "g", agent: "devin", worker: "Devin 4", status: "finished", task: "d", startedAt: 200, finishedAt: 950 },
  { id: 9, goal: "old", agent: "grok", status: "accepted", task: "old" },
];
const names = (id) => ({ grok: "Grok", devin: "Devin" })[id] || id;
const cs = cards({ jobs, goal, queue: [{ id: 7, task: "Next task\nmore", files: ["b.js"], agent: "" }], names });
assert.deepEqual(cs.map((c) => c.key), ["job-1", "job-2", "job-3", "job-4", "queue-7"], "this goal's jobs by id, then the ready queue");
assert.equal(cs[0].worker, "Grok"); assert.equal(cs[0].status, "merged"); assert.equal(cs[0].tokensText, "12K tokens");
assert.equal(cs[0].endedAt, 700); assert.equal(cs[0].result, "good");
assert.equal(cs[1].endedAt, null, "a running card has no end: the panel shows elapsed time");
assert.deepEqual(cs[1].items, [1]);
assert.equal(cs[1].tokensText, "", "no count, no number shown");
assert.equal(cs[4].status, "queued"); assert.equal(cs[4].title, "Next task"); assert.equal(cs[4].worker, "next free agent");

assert.equal(nowLine({ goal, jobs, names }), "Devin 2 is on fixing the guard; 2 jobs waiting for review.");
assert.equal(nowLine({ goal, jobs: [{ id: 5, goal: "g", agent: "grok", status: "running", task: "Update the README." }], names }), "Grok is on job 5 (update the README).");
assert.equal(nowLine({ goal, jobs: [], names, goalQueue: [{}, {}] }), "Constance is planning. 2 goals queued.");
assert.equal(nowLine({ goal, jobs: [{ id: 6, goal: "g", status: "finished", summary: "x" }, { id: 8, goal: "g", status: "held" }] }), "Constance is reviewing; 1 job waiting for review; 1 job waiting to start.");
assert.equal(nowLine({ goal: { ...goal, status: "paused", pauseReason: "Session at 91%" } }), "Paused for her limits: Session at 91%.");
assert.equal(nowLine({}), "Free. Give her a goal.");
assert.equal(nowLine({ goal: { ...goal, status: "done" } }), "Free. Last goal finished.");
assert.equal(nowLine({ goal: { ...goal, status: "done", needsOwner: "Job 3 hit a merge conflict." }, goalQueue: [{}] }), "She stopped: Job 3 hit a merge conflict. The queue waits for you.");
const many = [1, 2, 3, 4].map((id) => ({ id, goal: "g", agent: "devin", worker: `Devin ${id}`, status: "running", title: `doing ${id}` }));
assert.equal(nowLine({ goal, jobs: many }), "Devin 1 is on doing 1, Devin 2 is on doing 2, 2 more running.");

// History: a record for an ended goal, with tokens only where they are known.
const ended = { ...goal, status: "done", startedAt: 0, finishedAt: 3600e3 };
const rec = goalRecord(ended, jobs);
assert.equal(rec.outcome, "done"); assert.equal(rec.jobs, 4); assert.equal(rec.merged, 1);
assert.equal(rec.tokens, 12400, "the known count, with the rest marked can't tell");
assert.equal(rec.tokensCantTell, 3);
assert.equal(goalRecord(ended, [jobs[2]]).tokens, null, "nothing counted: no number at all");
assert.equal(goalRecord({ ...ended, needsOwner: "x" }, []).outcome, "needs you");

const log = [
  { at: 10e6, kind: "goal", text: "Old goal (in /p/a)" },
  { at: 11e6, kind: "held", job: 1 }, { at: 12e6, kind: "handoff", job: 1 }, { at: 13e6, kind: "handoff", job: 2 },
  { at: 14e6, kind: "review", job: 1, verdict: "accept" }, { at: 15e6, kind: "review", job: 2, verdict: "send-back" },
  { at: 20e6, kind: "report", text: "done" },
  { at: 30e6, kind: "goal", text: "Practice goal (in /p/b)" }, { at: 31e6, kind: "practice", job: 3 }, { at: 32e6, kind: "stopped" },
  { at: 40e6, kind: "goal", text: "Recorded goal (in /p/c)" }, { at: 50e6, kind: "report" },
];
const fromLog = goalsFromLog(log);
assert.equal(fromLog.length, 3);
assert.deepEqual([fromLog[0].text, fromLog[0].dir, fromLog[0].jobs, fromLog[0].merged, fromLog[0].sentBack, fromLog[0].outcome], ["Old goal", "/p/a", 2, 1, 1, "done"], "a held job that later started counts once");
assert.equal(fromLog[1].practice, true); assert.equal(fromLog[1].outcome, "stopped");
const h = history({ records: [{ id: "r", text: "Recorded goal", startedAt: 40.02e6, finishedAt: 50e6, tokens: 5e6, tokensCantTell: 1 }], log, goal: ended, jobs: [jobs[1]] });

assert.equal(h.length, 4, "the recorded goal isn't repeated from the log; the ended current goal is added");
assert.equal(h[0].text, "Recorded goal"); assert.equal(h[0].tokensText, "5M+");
assert.equal(h[h.length - 1].text, "1. a\n2. b", "the current goal started at 0, so it's the oldest");
assert.equal(h[1].took, 2e6);
assert.equal(history({ goal: { ...goal, status: "running" } }).length, 0, "a running goal isn't history yet");

assert.equal(took(40e3), "40s"); assert.equal(took(12 * 60e3), "12m"); assert.equal(took(125 * 60e3), "2h 5m"); assert.equal(took(26 * 3600e3), "1d 2h"); assert.equal(took(null), "");

// Leverage rides along on goal records and history rows; each row gets a one-line summary.
const lev = { tokens: 12.5e6, spentPct: 5, perPct: 2.5e6, perSession: 2.5e8, vsTarget: 0.5, label: "2.5M per 1% (target 5M)" };
assert.equal(goalRecord({ ...ended, leverage: lev }, jobs).leverage, lev, "a goal's leverage is kept on its record");
assert.equal(goalRecord(ended, jobs).leverage, null, "no leverage on the goal: null, not missing");
const h2 = history({ records: [
  { id: "a", text: "With leverage", startedAt: 1, finishedAt: 121e3, status: "done", jobs: 2, itemsDone: 1, itemsTotal: 3, leverage: lev },
  { id: "b", text: "No leverage", startedAt: 10, finishedAt: 130e3, status: "done", jobs: 1, itemsDone: 0, itemsTotal: 1 },
  { id: "c", text: "Unmeasured", startedAt: 20, finishedAt: 140e3, status: "done", jobs: 3, itemsDone: 2, itemsTotal: 4, leverage: { perPct: null, label: "not enough Opus spent to measure yet" } },
], log: [], goal: null });
assert.equal(h2[0].summary, "2/4 items · 3 jobs · 2m", "perPct null: no label in the summary");
assert.equal(h2[1].summary, "0/1 items · 1 job · 2m");
assert.equal(h2[1].leverage, null);
assert.equal(h2[2].summary, "1/3 items · 2 jobs · 2m · 2.5M per 1% (target 5M)", "measured leverage: label appended");
assert.equal(h2[2].leverage, lev);
const h3 = history({ records: [], log, goal: null });
assert.equal(h3.find((r) => r.text === "Old goal").summary, "2 jobs · 2h 46m", "log-rebuilt goals have no item counts to show");
assert.equal(h3.find((r) => r.text === "Practice goal").summary, "1 job · 33m");
console.log("constance-board: ok");
