// Constance's token meter: jobs are matched to their agent's sessions by folder and start time,
// anything unmatchable is "can't tell" (never a guess), finished jobs keep their last count once
// their worktree records are gone, and the goal/today totals add up by agent.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { matchJobs, jobTokens, snapshots, tokenMeter, fmtTokens, readRecords, usageFile, refreshInBackground, CANT_TELL } from "./constance-tokens.mjs";

const now = new Date(2026, 10, 24, 15, 0, 0).getTime();
const min = 60e3;
const rec = (agent, folder, session, start, amount, unit = "tokens") => ({ agent, folder, session, start, time: start + min, amount, unit });
const wt = (n) => `/var/tmp/constance-worktrees/job-${n}`;
const repo = "/home/u/Projects/app";

const jobs = [
  // Devin 1 and 2: copies in their own worktrees, running.
  { id: 1, goal: "g1", agent: "devin", copy: 1, worker: "Devin 1", dir: repo, worktree: wt(1), status: "running", startedAt: now - 30 * min },
  { id: 2, goal: "g1", agent: "devin", copy: 2, worker: "Devin 2", dir: repo, worktree: wt(2), status: "running", startedAt: now - 10 * min },
  // Grok in the shared project folder, finished.
  { id: 3, goal: "g1", agent: "grok", dir: repo, status: "finished", startedAt: now - 60 * min, finishedAt: now - 40 * min },
  // Codex running in the project folder: two sessions started during it -> can't tell.
  { id: 4, goal: "g1", agent: "codex", dir: repo, status: "running", startedAt: now - 20 * min },
  // Devin 3 running, nothing recorded yet -> can't tell.
  { id: 5, goal: "g1", agent: "devin", copy: 3, worker: "Devin 3", dir: repo, worktree: wt(5), status: "running", startedAt: now - 1 * min },
  // Copilot reports credits, not tokens -> can't tell.
  { id: 6, goal: "g1", agent: "copilot", dir: repo, status: "finished", startedAt: now - 90 * min, finishedAt: now - 80 * min },
  // An accepted copy whose worktree was dropped: only its kept count is left.
  { id: 7, goal: "g1", agent: "devin", copy: 4, worker: "Devin 4", dir: repo, worktree: "", status: "accepted", startedAt: now - 120 * min, finishedAt: now - 100 * min, tokens: { n: 5000, sessions: ["d7"], at: now - 99 * min } },
  // Never launched: practice, held, waiting — never counted.
  { id: 8, goal: "g1", agent: "grok", dir: repo, status: "finished", createdAt: now, finishedAt: now, summary: "(practice run: the prompt is in the log, nothing was launched)" },
  { id: 9, goal: "g1", agent: "devin", copy: 5, worker: "Devin 5", dir: repo, worktree: wt(9), status: "held", heldReason: "machine busy" },
  // Yesterday's job from an older goal: counts for neither this goal nor today.
  { id: 10, goal: "g0", agent: "grok", dir: repo, status: "accepted", startedAt: now - 24 * 60 * min, finishedAt: now - 23 * 60 * min, tokens: { n: 777, sessions: ["old"] } },
];
const records = [
  rec("devin", wt(1), "d1a", now - 29 * min, 120000),
  rec("devin", wt(1), "d1b", now - 15 * min, 4000),          // a second session in its own worktree is still its own
  rec("devin", wt(1), "before", now - 50 * min, 999999),     // started before the job: someone else's
  rec("devin", wt(2), "d2", now - 9 * min, 1500000),
  rec("grok", repo, "g3", now - 59 * min, 300000),
  rec("grok", repo, "later", now - 10 * min, 888),           // after grok's job ended: not its
  rec("codex", repo, "c1", now - 19 * min, 1000),
  rec("codex", repo, "c2", now - 5 * min, 2000),             // owner also ran codex there: ambiguous
  rec("copilot", repo, "cp", now - 89 * min, 1.25, "AIC"),
  rec("claude", repo, "mine", now - 25 * min, 5e6),          // the owner's own Claude session: never a worker's
];

const live = matchJobs(jobs, records, now);
assert.equal(live[1].tokens, 124000, "Devin 1: both sessions in its own worktree");
assert.deepEqual(live[1].sessions.sort(), ["d1a", "d1b"]);
assert.equal(live[2].tokens, 1500000);
assert.equal(live[3].tokens, 300000, "Grok: the one session that started during its run");
assert.equal(live[4].tokens, null); assert.match(live[4].why, /several sessions/);
assert.equal(live[5].tokens, null); assert.match(live[5].why, /no session/);
assert.equal(live[6].tokens, null); assert.match(live[6].why, /credits/);
assert.equal(live[7].tokens, null, "a dropped worktree has no live match");
for (const id of [8, 9]) assert.equal(live[id], undefined, `job ${id} never launched`);

// Two jobs of the same agent in the same shared folder at once: the session can't be told apart.
{
  const both = [
    { id: 1, agent: "grok", dir: repo, status: "running", startedAt: now - 10 * min },
    { id: 2, agent: "grok", dir: repo, status: "running", startedAt: now - 9 * min },
  ];
  const m = matchJobs(both, [rec("grok", repo, "s", now - 8 * min, 100)], now);
  assert.equal(m[1].tokens, null); assert.equal(m[2].tokens, null);
  assert.match(m[1].why, /another job/);
}

// Kept counts: used only once the job is over; a running job never shows a stale number.
assert.equal(jobTokens(jobs[6], live), 5000);
assert.equal(jobTokens({ id: 99, status: "running", tokens: { n: 1 } }, {}), null);
const keep = snapshots(jobs, live, now);
assert.deepEqual(Object.keys(keep).map(Number).sort((a, b) => a - b), [1, 2, 3]);
assert.equal(keep[1].n, 124000);
assert.equal(snapshots([{ ...jobs[0], tokens: { n: 124000 } }], live, now)[1], undefined, "an unchanged count isn't rewritten");

assert.equal(fmtTokens(812), "812");
assert.equal(fmtTokens(1500), "1.5K");
assert.equal(fmtTokens(124000), "124K");
assert.equal(fmtTokens(1500000), "1.5M");
assert.equal(fmtTokens(null), CANT_TELL);

const names = { devin: "Devin", grok: "Grok", codex: "Codex", copilot: "Copilot" };
const m = tokenMeter({ jobs, goal: { id: "g1" }, records, now, name: (id) => names[id] || id });
// One line per running worker, in job order.
assert.deepEqual(m.workers.map((w) => w.text), ["Devin 1  124K tokens", "Devin 2  1.5M tokens", "Codex  can't tell", "Devin 3  can't tell"]);
assert.match(m.workers[2].why, /several sessions/);
assert.deepEqual(m.workers.map((w) => w.count), ["124K tokens", "1.5M tokens", CANT_TELL, CANT_TELL], "the panel's right-hand column");
// Goal: Devin 124K + 1.5M + 5K kept, Grok 300K; Codex, Devin 3 and Copilot can't tell.
assert.equal(m.goal.total, 124000 + 1500000 + 5000 + 300000);
assert.deepEqual(m.goal.byAgent.map((a) => [a.name, a.tokens]), [["Devin", 1629000], ["Grok", 300000]]);
assert.equal(m.goal.cantTell, 3);
// Today: the same jobs (all started today); yesterday's job is out.
assert.equal(m.today.total, m.goal.total);
assert.equal(m.line, "This goal 1.9M (Devin 1.6M · Grok 300K) + 3 jobs can't tell · Today 1.9M + 3 jobs can't tell");

// No goal: only the today part; nothing launched today: plain zero, no "can't tell".
const quiet = tokenMeter({ jobs: [jobs[9]], goal: null, records: [], now, name: (id) => names[id] });
assert.equal(quiet.goal, null);
assert.equal(quiet.line, "Today 0");
assert.deepEqual(quiet.workers, []);

// Records on disk and the background refresh's throttle.
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "constance-tokens-"));
const env = { XDG_STATE_HOME: tmp, HOME: tmp };
const file = usageFile(env);
assert.equal(file, path.join(tmp, "omarchy", "agent-usage-tabs", "folder-usage.json"));
assert.deepEqual(readRecords(file), { records: [], refreshedAt: 0 }, "a missing file is no records");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({ version: 1, refreshedAt: now - 5e3, records: [records[0]] }));
assert.equal(readRecords(file).records.length, 1);
let runs = 0;
const run = () => runs++;
assert.equal(refreshInBackground({ env, now, run }), false, "fresh records: no rescan");
assert.equal(refreshInBackground({ env, now: now + 60e3, run }), true, "stale records: one rescan");
assert.equal(refreshInBackground({ env, now: now + 61e3, run }), false, "a rescan was just started: not another");
assert.equal(runs, 1);
fs.rmSync(tmp, { recursive: true, force: true });

console.log("constance-tokens: ok");
