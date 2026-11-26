// Deeper edge-case pass on the job board helpers (bin/constance-board.mjs),
// complementing constance-board.test.mjs. The module is pure, so the fake HOME
// under mktemp is only a guard so nothing can ever touch the real one. Covers
// what the first test leaves out: unknown/falsy statuses, clip boundaries,
// precedence between conflict/practice/held, goal-less and foreign-goal jobs,
// corrupt log shapes, history coverage edges and wrong-type inputs. Suspected
// bugs are commented out with a note, not fixed (this job is test-only).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jobStatus, jobTitle, jobResult, cards, nowLine, goalRecord, goalsFromLog, history, took } from "./constance-board.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constance-board-deep-"));
process.env.HOME = path.join(tmp, "home");
process.env.XDG_STATE_HOME = path.join(tmp, "xdg-state");
process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg-config");
process.env.XDG_CACHE_HOME = path.join(tmp, "xdg-cache");
fs.mkdirSync(process.env.HOME, { recursive: true });

const PRACTICE = "(practice run: the prompt is in the log, nothing was launched)";

// ---------- jobStatus: fallthrough and falsy values ----------

// An unmapped status is passed through as a string, never hidden.
assert.equal(jobStatus({ status: "mystery" }), "mystery");
assert.equal(jobStatus({ status: 123 }), "123", "a numeric status stringifies");
assert.equal(jobStatus({ status: " running " }), " running ", "no trimming");
// Every falsy status falls back to "queued" — including ones that aren't strings.
for (const st of [undefined, null, "", 0, false]) assert.equal(jobStatus({ status: st }), "queued", `status ${String(st)}`);
assert.equal(jobStatus({}), "queued", "a job with no status field at all");
// Practice wins over every mapped status, not just "finished": an accepted
// practice job shows "practice", never "merged".
assert.equal(jobStatus({ status: "accepted", summary: PRACTICE }), "practice");
assert.equal(jobStatus({ status: "running", summary: PRACTICE }), "practice");
// The practice prefix is a raw string prefix: "(practice running…" also matches.
assert.equal(jobStatus({ status: "finished", summary: "(practice running: x)" }), "practice", "prefix match is not word-boundaried");
assert.equal(jobStatus({ status: "finished", summary: "  (practice run: x)" }), "in review", "leading spaces break the prefix");
assert.throws(() => jobStatus(null), TypeError, "a null job crashes (callers never pass one)");

// ---------- jobTitle: clip boundary and degenerate text ----------

// clip() only fires past 60 chars; the ellipsis is part of the 60.
assert.equal(jobTitle({ title: "x".repeat(60) }), "x".repeat(60), "exactly 60 is not clipped");
const clipped = jobTitle({ title: "x".repeat(61) });
assert.equal(clipped.length, 60);
assert.ok(clipped.endsWith("…"), "the clip marker is an ellipsis, not three dots");
assert.equal(clipped.slice(0, -1), "x".repeat(59), "one char is dropped to make room for the ellipsis");
// An empty-string title falls back to the task; a whitespace-only one does not.
assert.equal(jobTitle({ title: "", task: "Do the real thing." }), "Do the real thing");
assert.equal(jobTitle({ title: "   ", task: "Do the real thing." }), "", "whitespace title is truthy and clips to empty");
// Non-string titles stringify.
assert.equal(jobTitle({ title: 42 }), "42");
assert.equal(jobTitle({ title: {} }), "[object Object]");
// Task fallback edges: blank lines skipped, " (" splits, lone punctuation empties out.
assert.equal(jobTitle({ task: "\n\n  Real task here.\nignored" }), "Real task here");
assert.equal(jobTitle({ task: "Fix bug (urgent) now" }), "Fix bug", "a space before ( splits the title");
assert.equal(jobTitle({ task: "..." }), "..", "the trailing-punctuation strip removes only one char");
assert.equal(jobTitle({}), "", "no title and no task: empty, not a crash");
assert.throws(() => jobTitle(null), TypeError);

// ---------- jobResult: precedence ----------

// conflict is checked before practice, practice before held.
assert.match(jobResult({ status: "conflict", summary: PRACTICE }), /Merge conflict/, "conflict beats practice");
assert.equal(jobResult({ status: "held", summary: PRACTICE }), "Practice: prompt logged, nothing launched", "practice beats held");
assert.equal(jobResult({ status: "held", heldReason: "" }), "Held until the machine has room", "empty reason falls back");
assert.equal(jobResult({ status: "held", heldReason: 42 }), "Held: 42", "a numeric reason stringifies");
// A whitespace-only reviewNote falls through to the summary.
assert.equal(jobResult({ status: "finished", reviewNote: "  \n  ", summary: "agent summary" }), "agent summary");
// reviewNote wins even on non-finished statuses.
assert.equal(jobResult({ status: "accepted", reviewNote: "lgtm", summary: "did it" }), "lgtm");
// Clip boundary: a 200-char first line becomes 120 chars ending in "…".
const long = jobResult({ status: "finished", summary: "y".repeat(200) });
assert.equal(long.length, 120);
assert.ok(long.endsWith("…"));
assert.throws(() => jobResult(null), TypeError);

// ---------- cards ----------

assert.deepEqual(cards(), [], "no arguments at all");
assert.throws(() => cards({ jobs: null }), TypeError, "jobs:null crashes (default only covers undefined)");

// goal:null shows EVERY job, including ones tagged to other goals, with no items.
const mixed = [
  { id: 1, goal: "g", agent: "grok", status: "accepted", task: "a", startedAt: 1, finishedAt: 2 },
  { id: 2, goal: "old", agent: "devin", status: "running", task: "b", startedAt: 3 },
];
const allCards = cards({ jobs: mixed });
assert.deepEqual(allCards.map((c) => c.id), [1, 2], "no goal filter: foreign jobs included");
assert.ok(allCards.every((c) => c.items.length === 0), "no goal: no item tags even for tagged jobs");
// With a goal set, goal-less jobs count as this goal's (same rule as nowLine).
const goalG = { id: "g", text: "1. a\n2. b", status: "running" };
const withNullGoalJob = cards({ jobs: [{ id: 5, agent: "grok", status: "accepted", task: "x", items: [2] }, ...mixed], goal: goalG });
assert.deepEqual(withNullGoalJob.map((c) => c.id), [1, 5], "goal-less job joins this goal's board");
assert.deepEqual(withNullGoalJob.find((c) => c.id === 5).items, [2], "its item tag lands on the card");

// Item count comes from stored goal.items when present — even when it disagrees with the text.
const storedItems = { id: "g", text: "1. a\n2. b\n3. c", items: ["only-one"] };
const cStored = cards({ jobs: [{ id: 1, goal: "g", agent: "grok", status: "accepted", task: "x", items: [1] }], goal: storedItems });
assert.deepEqual(cStored[0].items, [1], "stored items list (length 1) sets the count, not the parsed text");

// endedAt precedence: running is always null; otherwise finishedAt || stoppedAt.
const endCases = cards({ jobs: [
  { id: 1, status: "running", finishedAt: 5, stoppedAt: 6 },
  { id: 2, status: "stopped", stoppedAt: 9 },
  { id: 3, status: "accepted", finishedAt: 0, stoppedAt: 8 },
  { id: 4, status: "finished", finishedAt: 0, stoppedAt: null },
], goal: null });
assert.equal(endCases[0].endedAt, null, "running ignores both timestamps");
assert.equal(endCases[1].endedAt, 9);
assert.equal(endCases[2].endedAt, 8, "finishedAt 0 is falsy: stoppedAt is used instead");
assert.equal(endCases[3].endedAt, null, "finishedAt 0 with no stoppedAt: null, not 0");

// worker falls back through names(); a missing agent yields undefined, not a crash.
const noAgent = cards({ jobs: [{ id: 1, status: "running", task: "x" }] })[0];
assert.equal(noAgent.worker, undefined, "default names() is identity: names(undefined) is undefined");
assert.equal(cards({ jobs: [{ id: 1, agent: "mystery", status: "running", task: "x" }], names: (id) => `N:${id}` })[0].worker, "N:mystery");
assert.equal(cards({ jobs: [{ id: 1, agent: "grok", worker: "", status: "running", task: "x" }], names: (id) => "G" })[0].worker, "G", "empty worker string falls back too");

// Token display through jobTokens: non-finite stored counts are ignored, live wins even for running jobs.
const tokCards = cards({ jobs: [
  { id: 1, status: "accepted", tokens: { n: 500 } },
  { id: 2, status: "accepted", tokens: { n: "500" } },
  { id: 3, status: "running", tokens: { n: 999 } },
  { id: 4, status: "accepted", tokens: { n: Infinity } },
], live: { 3: { tokens: 42 }, 4: { tokens: null } } });
assert.equal(tokCards[0].tokensText, "500 tokens");
assert.equal(tokCards[1].tokensText, "", "a string n is not finite: ignored");
assert.equal(tokCards[2].tokensText, "42 tokens", "a live match beats the running-job stored-count rule");
assert.equal(tokCards[3].tokensText, "", "Infinity n ignored, and a null live match doesn't resurrect it");

// Queue cards: missing fields degrade quietly; duplicate queue ids produce duplicate keys.
const qCards = cards({ queue: [{ id: 7 }, { id: 7, task: "Real task", agent: "grok", at: 55 }] });
assert.equal(qCards[0].title, "");
assert.equal(qCards[0].worker, "next free agent");
assert.equal(qCards[0].createdAt, null);
assert.equal(qCards[1].key, qCards[0].key, "two queue entries with the same id share a key (quirk)");
assert.equal(qCards[1].worker, "grok", "default names() is identity: the agent id itself");
assert.equal(qCards[1].createdAt, 55);

// ---------- nowLine ----------

// A running goal with no jobs at all is "planning", with or without a queue.
assert.equal(nowLine({ goal: { id: "g", status: "running" }, jobs: [] }), "Constance is planning.");
assert.equal(nowLine({ goal: { id: "g", status: "running" }, jobs: [], goalQueue: [{}] }), "Constance is planning. 1 goal queued.");
// Paused without a recorded reason uses the default wording; queued goals are NOT appended while paused.
assert.equal(nowLine({ goal: { id: "g", status: "paused" } }), "Paused for her limits: waiting for a reset.");
assert.equal(nowLine({ goal: { id: "g", status: "paused", pauseReason: "Session at 91%" }, goalQueue: [{}] }), "Paused for her limits: Session at 91%.", "the queue count is dropped on the paused line");
// A paused queue with NO goal still reports the pause.
assert.equal(nowLine({ queuePaused: "owner asked", goalQueue: [{}] }), "The goal queue is paused: owner asked");
assert.equal(nowLine({ queuePaused: "owner asked", goalQueue: [] }), "Free. Give her a goal.", "pause only shows when goals are actually queued");
// Unknown goal statuses pass through raw in the "last goal" line.
assert.equal(nowLine({ goal: { id: "g", status: "weird" } }), "Free. Last goal weird.");
assert.equal(nowLine({ goal: { id: "g", status: "failed" } }), "Free. Last goal couldn't finish.");
assert.equal(nowLine({ goal: { id: "g", status: "stopped" } }), "Free. Last goal was stopped.");
// needsOwner is only consulted on ended goals; a running goal ignores it.
assert.equal(nowLine({ goal: { id: "g", status: "running", needsOwner: "something broke" }, jobs: [] }), "Constance is planning.", "needsOwner on a running goal is ignored");
// Jobs of OTHER goals never leak into this goal's counts — even running ones.
assert.equal(nowLine({ goal: { id: "g", status: "running" }, jobs: [{ id: 1, goal: "other", agent: "grok", status: "running", task: "x" }] }), "Constance is planning.");
// Goal-less jobs DO count as this goal's here (unlike goalRecord — see below).
assert.equal(nowLine({ goal: { id: "g", status: "running" }, jobs: [{ id: 1, agent: "grok", worker: "Grok", status: "running", task: "x" }] }), "Grok is on job 1 (x).");
// Practice finished jobs are invisible to the review count.
assert.equal(nowLine({ goal: { id: "g", status: "running" }, jobs: [
  { id: 1, goal: "g", status: "finished", summary: PRACTICE },
  { id: 2, goal: "g", status: "finished", summary: "real" },
] }), "Constance is reviewing; 1 job waiting for review.");
// A running job with no title and an empty task degrades to "job N ()" — and a
// missing worker/agent prints the literal string "undefined".
const ugly = nowLine({ goal: { id: "g", status: "running" }, jobs: [{ id: 9, status: "running", task: "" }] });
assert.equal(ugly, "undefined is on job 9 ().", "no worker, no agent, no title: ugly but honest");
// j.title is used raw and lowercased in the Now line — NOT clipped like jobTitle.
const longTitle = nowLine({ goal: { id: "g", status: "running" }, jobs: [{ id: 1, goal: "g", worker: "W", status: "running", title: "A".repeat(200) }] });
assert.ok(longTitle.length > 200, "the Now line does not clip a long title (cards do)");

// ---------- goalRecord ----------

// goalRecord matches jobs STRICTLY by j.goal === goal.id: goal-less and
// empty-goal jobs are NOT counted here, even though nowLine/cards/checklist
// treat them as this goal's. Documented inconsistency.
const strictGoal = { id: "g", text: "1. a\n2. b", status: "done", startedAt: 0, finishedAt: 100 };
const recStrict = goalRecord(strictGoal, [
  { id: 1, status: "accepted", startedAt: 1 },          // no goal field
  { id: 2, goal: "", status: "accepted", startedAt: 1 }, // empty goal id
  { id: 3, goal: "g", status: "accepted", startedAt: 1 },
]);
assert.equal(recStrict.jobs, 1, "only the explicitly-tagged job counts toward jobs/merged");
assert.equal(recStrict.merged, 1);
// ...but the checklist inside the same record DOES count goal-less jobs for items.
const recItems = goalRecord({ id: "g", text: "1. a\n2. b", status: "done", startedAt: 0, finishedAt: 100 }, [
  { id: 1, status: "accepted", items: [1], startedAt: 1 },
]);
assert.equal(recItems.jobs, 0);
assert.equal(recItems.itemsDone, 1, "checklist counts the goal-less job the job tally missed");

// finishedAt: 0 is falsy, so Date.now() is used instead.
const before = Date.now();
const recEpoch = goalRecord({ ...strictGoal, finishedAt: 0 }, []);
assert.ok(recEpoch.finishedAt >= before, "finishedAt 0 falls through to now");
// Unknown statuses pass through as the outcome; needsOwner still wins.
assert.equal(goalRecord({ ...strictGoal, status: "mystery" }, []).outcome, "mystery");
assert.equal(goalRecord({ ...strictGoal, status: "mystery", needsOwner: "stuck" }, []).outcome, "needs you");
// practice flag needs at least one job and ALL of them practice; sentBack has no practice exclusion.
assert.equal(goalRecord(strictGoal, []).practice, false, "no jobs: not a practice goal");
assert.equal(goalRecord(strictGoal, [{ id: 1, goal: "g", status: "accepted", summary: PRACTICE, startedAt: 1 }]).practice, true);
assert.equal(goalRecord(strictGoal, [
  { id: 1, goal: "g", status: "accepted", summary: PRACTICE, startedAt: 1 },
  { id: 2, goal: "g", status: "accepted", startedAt: 1 },
]).practice, false, "one real job breaks the practice flag");
assert.equal(goalRecord(strictGoal, [{ id: 1, goal: "g", status: "sent back", summary: PRACTICE, startedAt: 1 }]).sentBack, 1, "sentBack counts practice jobs too (quirk)");
// Token stats: startedAt 0 is falsy and drops the job from the count entirely;
// a running job with no live match counts as can't-tell, not zero.
const recTok = goalRecord(strictGoal, [
  { id: 1, goal: "g", status: "accepted", startedAt: 0, tokens: { n: 500 } },   // excluded: falsy startedAt
  { id: 2, goal: "g", status: "running", startedAt: 1 },                      // no live match -> cantTell
  { id: 3, goal: "g", status: "accepted", startedAt: 1, tokens: { n: 300 } },
], { 3: { tokens: 999 } });
assert.equal(recTok.tokens, 999, "the live match for job 3 wins over its stored 300");
assert.equal(recTok.tokensCantTell, 1, "job 2 can't tell; job 1 was skipped before matching");

// ---------- goalsFromLog ----------

assert.deepEqual(goalsFromLog([]), []);
assert.deepEqual(goalsFromLog([{ at: 1, kind: "note", text: "x" }]), [], "entries before any goal are ignored");
// A goal in the middle of the log with no closing event is kept, marked unknown.
const midOpen = goalsFromLog([
  { at: 1, kind: "goal", text: "First (in /p/1)" },
  { at: 2, kind: "handoff", job: 1 },
  { at: 3, kind: "goal", text: "Second (in /p/2)" },
  { at: 4, kind: "report" },
]);
assert.equal(midOpen.length, 2);
assert.deepEqual([midOpen[0].text, midOpen[0].status, midOpen[0].outcome, midOpen[0].finishedAt], ["First", "unknown", "unknown", null]);
// But a TRAILING unclosed goal is dropped entirely — it never reaches `out`.
const tailOpen = goalsFromLog([
  { at: 1, kind: "goal", text: "Closed (in /p)" }, { at: 2, kind: "report" },
  { at: 3, kind: "goal", text: "Never closed (in /q)" }, { at: 4, kind: "handoff", job: 1 },
]);
assert.equal(tailOpen.length, 1, "the last goal without report/stopped/failed vanishes from rebuilt history");
assert.equal(tailOpen[0].text, "Closed");
// Only report/stopped/failed close a goal; any other kind leaves it open.
assert.equal(goalsFromLog([{ at: 1, kind: "goal", text: "g" }, { at: 2, kind: "needs-you", text: "x" }]).length, 0);
// "(in dir)" parsing: greedy match takes the LAST " (in ", requires the close paren at end of text.
const dirCases = goalsFromLog([
  { at: 1, kind: "goal", text: "a (in b) (in c)" }, { at: 2, kind: "report" },
  { at: 3, kind: "goal", text: "no parens here" }, { at: 4, kind: "report" },
  { at: 5, kind: "goal", text: "trailing (in /x) extra" }, { at: 6, kind: "report" },
  { at: 7, kind: "goal", text: "empty (in )" }, { at: 8, kind: "report" },
]);
assert.deepEqual(dirCases.map((g) => [g.text, g.dir]), [
  ["a (in b)", "c"],
  ["no parens here", ""],
  ["trailing (in /x) extra", ""],
  ["empty", ""],
]);
// review verdicts: anything but the exact string "accept" counts as sent back.
const verdicts = goalsFromLog([
  { at: 1, kind: "goal", text: "g" },
  { at: 2, kind: "handoff", job: 1 }, { at: 3, kind: "handoff", job: 2 }, { at: 4, kind: "handoff", job: 3 },
  { at: 5, kind: "review", job: 1, verdict: "accept" },
  { at: 6, kind: "review", job: 2 },                    // missing verdict -> sent back
  { at: 7, kind: "review", job: 3, verdict: "Accept" }, // case-sensitive -> sent back
  { at: 8, kind: "report" },
])[0];
assert.deepEqual([verdicts.merged, verdicts.sentBack], [1, 2]);
// A job id of undefined still occupies a slot in the seen set.
const undefJob = goalsFromLog([
  { at: 1, kind: "goal", text: "g" }, { at: 2, kind: "handoff" }, { at: 3, kind: "report" },
])[0];
assert.equal(undefJob.jobs, 1, "handoff with no job field still counts as one job");
// Practice detection needs EVERY counted job to be practice.
const mixedPractice = goalsFromLog([
  { at: 1, kind: "goal", text: "g" },
  { at: 2, kind: "handoff", job: 1 }, { at: 3, kind: "practice", job: 2 }, { at: 4, kind: "stopped" },
])[0];
assert.equal(mixedPractice.practice, false, "one real handoff among practice jobs: not a practice goal");
assert.equal(mixedPractice.merged, 0, "practice goals have their merge count zeroed");
// Missing `at` on a goal entry: id "log-undefined", startedAt undefined.
const noAt = goalsFromLog([{ kind: "goal", text: "g" }, { kind: "report" }])[0];
assert.equal(noAt.id, "log-undefined");
assert.equal(noAt.startedAt, undefined);
// Two goals with no `at` both get the same id — ids are not unique here.
const dupIds = goalsFromLog([
  { kind: "goal", text: "g1" }, { kind: "report" },
  { kind: "goal", text: "g2" }, { kind: "report" },
]);
assert.deepEqual(dupIds.map((g) => g.id), ["log-undefined", "log-undefined"]);
// Wrong-type entries: strings are silently ignored, null/undefined crash.
assert.deepEqual(goalsFromLog(["junk", 42, { at: 1, kind: "goal", text: "g" }, { at: 2, kind: "report" }]).length, 1);
assert.throws(() => goalsFromLog([null]), TypeError, "a null log line crashes");
assert.throws(() => goalsFromLog(null), TypeError, "log:null crashes (default only covers undefined)");

// ---------- history ----------

assert.deepEqual(history(), []);
assert.throws(() => history({ records: null }), TypeError);
assert.throws(() => history({ log: null }), TypeError);
// records must be an array; a string spreads into characters and yields garbage rows, not a crash.
const strRecords = history({ records: "abc" });
assert.equal(strRecords.length, 3, "a string 'records' spreads into one row per character");
assert.equal(strRecords[0].summary, "0 jobs");

// Coverage window is strict: < 60s covered, exactly 60s not.
const covLog = [{ at: 1000, kind: "goal", text: "rebuilt (in /p)" }, { at: 2000, kind: "report" }];
const coveredIn = history({ records: [{ id: "r", text: "record", startedAt: 1000 + 59999, finishedAt: 70000 }], log: covLog });
assert.equal(coveredIn.length, 1, "a record 59.999s after the log goal covers it");
const notCovered = history({ records: [{ id: "r", text: "record", startedAt: 1000 + 60000, finishedAt: 130000 }], log: covLog });
assert.equal(notCovered.length, 2, "exactly 60s apart is NOT covered — both rows appear");
// A record with a non-numeric startedAt can never cover a log goal.
const badStart = history({ records: [{ id: "r", text: "record", startedAt: "soon", finishedAt: 5 }], log: covLog });
assert.equal(badStart.length, 2);
// An ended goal is appended unless a record already carries its id; paused is not "ended".
const endedGoal = { id: "g", text: "goal", status: "done", startedAt: 10, finishedAt: 20 };
assert.equal(history({ records: [{ id: "g", text: "record", startedAt: 1, finishedAt: 2 }], goal: endedGoal }).length, 1, "same id: the record wins, goal not duplicated");
assert.equal(history({ goal: { ...endedGoal, status: "paused" } }).length, 0, "paused goals are not history yet");
assert.equal(history({ goal: { ...endedGoal, status: "failed" } })[0].outcome, "couldn't finish");
// limit edges: 0 gives nothing; a NEGATIVE limit drops the last row via slice(0, -1).
const threeRecords = [3, 1, 2].map((s) => ({ id: `r${s}`, text: `t${s}`, startedAt: s, finishedAt: s + 1 }));
assert.equal(history({ records: threeRecords, limit: 2 }).length, 2);
assert.equal(history({ records: threeRecords, limit: 0 }).length, 0);
assert.equal(history({ records: threeRecords, limit: -1 }).length, 2, "slice(0,-1): a negative limit silently drops the oldest row");
// Input arrays are not mutated; rows are sorted newest-first by startedAt.
const input = [{ id: "a", startedAt: 1 }, { id: "b", startedAt: 3 }, { id: "c", startedAt: 2 }];
const sorted = history({ records: input });
assert.deepEqual(input.map((r) => r.id), ["a", "b", "c"], "the records array keeps its order");
assert.deepEqual(sorted.map((r) => r.id), ["b", "c", "a"]);
// took is null when either timestamp is missing OR falsy (startedAt 0 is the epoch edge).
const epochRow = history({ records: [{ id: "e", text: "epoch", startedAt: 0, finishedAt: 100 }] })[0];
assert.equal(epochRow.took, null, "startedAt 0 is falsy: no duration shown");
const noFinish = history({ records: [{ id: "n", text: "open", startedAt: 5 }] })[0];
assert.equal(noFinish.took, null);
// tokensText: 0 formats as "0", undefined/null as "", strings coerce through fmtTokens.
const tokRows = history({ records: [
  { id: "z", text: "zero", startedAt: 4, tokens: 0 },
  { id: "u", text: "undef", startedAt: 3, tokens: undefined },
  { id: "s", text: "str", startedAt: 2, tokens: "5e6" },
  { id: "neg", text: "neg", startedAt: 1, tokens: -5 },
] });
assert.equal(tokRows.find((r) => r.id === "z").tokensText, "0");
assert.equal(tokRows.find((r) => r.id === "u").tokensText, "");
assert.equal(tokRows.find((r) => r.id === "s").tokensText, "5M", "a numeric string coerces through fmtTokens");
assert.equal(tokRows.find((r) => r.id === "neg").tokensText, "-5");
// itemsTotal must be a real number to appear; 0 still shows "0/0 items".
const itemRows = history({ records: [
  { id: "i1", text: "str", startedAt: 2, itemsTotal: "3", itemsDone: 1 },
  { id: "i2", text: "zero", startedAt: 1, itemsTotal: 0, itemsDone: 0 },
] });
assert.equal(itemRows.find((r) => r.id === "i1").summary, "0 jobs", "a string itemsTotal is not finite: the items bit is dropped");
assert.ok(itemRows.find((r) => r.id === "i2").summary.includes("0/0 items"));
// perPct 0 is != null, so a zero leverage label still shows.
const zeroLev = history({ records: [{ id: "l", text: "l", startedAt: 1, finishedAt: 2, leverage: { perPct: 0, label: "0 per 1%" } }] })[0];
assert.ok(zeroLev.summary.includes("0 per 1%"), "perPct 0 counts as measured");

// BUG: took(Infinity) returns "Infinityd NaNh" instead of "" — the guard is
// `!(ms >= 0)`, which Infinity passes, and every derived unit becomes Infinity/NaN.
// assert.equal(took(Infinity), "");

// BUG: history() crashes with a TypeError inside fmtTokens when a stored record's
// `tokens` is NaN or a non-numeric string/object (corrupt but valid-JSON
// history.jsonl takes down the whole board). fmtTokens indexes units[-1] and
// destructures undefined. This is constance-tokens.mjs's bug surfacing here.
// assert.throws(() => history({ records: [{ id: "x", text: "x", startedAt: 1, tokens: NaN }] }), /./);
// assert.throws(() => history({ records: [{ id: "x", text: "x", startedAt: 1, tokens: "abc" }] }), /./);

// ---------- took ----------

assert.equal(took(0), "0s");
assert.equal(took(499), "0s", "sub-half-second rounds to 0s");
assert.equal(took(500), "1s", "exactly half a second rounds up");
assert.equal(took(59.4e3), "59s");
assert.equal(took(59.5e3), "1m", "59.5s rounds to 60s which is 1m");
assert.equal(took(3599.5e3), "1h 0m");
assert.equal(took(24 * 3600e3), "1d 0h");
assert.equal(took(25 * 3600e3), "1d 1h");
assert.equal(took(-1), "");
assert.equal(took(NaN), "");
assert.equal(took(-Infinity), "");
assert.equal(took("100"), "", "a string is not a number");
assert.equal(took(null), "");
assert.equal(took(undefined), "");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("constance-board.deep: ok");
