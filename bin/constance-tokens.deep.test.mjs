// Deeper edge-case tests for bin/constance-tokens.mjs: window boundaries, the
// shared-folder ambiguity rules, kept-count fallbacks, malformed records on disk,
// and the refresh throttle. State lives in a mkdtemp dir with a fake HOME; clocks
// are injected, nothing real is touched.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { matchJobs, jobTokens, snapshots, tokenMeter, fmtTokens, readRecords, usageFile, refreshInBackground, refreshNow, CANT_TELL } from "./constance-tokens.mjs";

const now = new Date(2026, 10, 24, 15, 0, 0).getTime();
const min = 60e3;
const SLACK = 2000;
const rec = (agent, folder, session, start, amount, unit = "tokens") => ({ agent, folder, session, start, time: start + min, amount, unit });
const wt = (n) => `/var/tmp/constance-worktrees/job-${n}`;
const repo = "/home/u/Projects/app";
const job = (over) => ({ id: 1, agent: "grok", dir: repo, status: "running", startedAt: now - 30 * min, ...over });

// ---------------------------------------------------------------- match windows

// A session's start is inside the job's run when startedAt - 2 s <= start <= end.
{
  const j = job({ status: "finished", startedAt: now - 30 * min, finishedAt: now - 10 * min });
  const at = (start) => matchJobs([j], [rec("grok", repo, "s", start, 100)], now)[1];
  assert.equal(at(j.startedAt - SLACK).tokens, 100, "exactly 2 s before launch counts");
  assert.equal(at(j.startedAt - SLACK - 1).tokens, null, "2 s + 1 ms before launch does not");
  assert.equal(at(j.startedAt).tokens, 100, "at launch counts");
  assert.equal(at(j.finishedAt).tokens, 100, "exactly at finishedAt counts (inclusive end)");
  assert.equal(at(j.finishedAt + 1).tokens, null, "1 ms after finishedAt does not");
  assert.equal(at(j.finishedAt + min).why, "no session of its agent found in its folder yet");
}

// A running job's window ends at `now`, not at some stored time.
{
  const j = job({ status: "running", startedAt: now - 5 * min });
  const two = matchJobs([j], [rec("grok", repo, "s", now - 60e3, 50), rec("grok", repo, "t", now, 50)], now);
  // The shared folder needs exactly ONE session: two starts inside the window is ambiguous.
  assert.equal(two[1].tokens, null);
  assert.match(two[1].why, /several sessions/);
  const single = matchJobs([j], [rec("grok", repo, "s", now, 50)], now);
  assert.equal(single[1].tokens, 50, "a session starting exactly now is inside a running job's window");
  const late = matchJobs([j], [rec("grok", repo, "s", now + 1, 50)], now);
  assert.equal(late[1].tokens, null, "a session after now is not");
}

// endOf: a stopped job ends at stoppedAt, a failed job with no times ends at now.
{
  const stopped = job({ status: "stopped", startedAt: now - 30 * min, stoppedAt: now - 20 * min });
  assert.equal(matchJobs([stopped], [rec("grok", repo, "s", now - 25 * min, 10)], now)[1].tokens, 10);
  assert.equal(matchJobs([stopped], [rec("grok", repo, "s", now - 15 * min, 10)], now)[1].tokens, null);
  const failed = job({ status: "failed", startedAt: now - 30 * min });
  assert.equal(matchJobs([failed], [rec("grok", repo, "s", now - 1, 10)], now)[1].tokens, 10, "no finish time: window runs to now");
}

// ---------------------------------------------------------------- launched()

// Only jobs that really launched an agent are matched; the rest have no live entry.
{
  const never = [
    job({ id: 1, status: "held", startedAt: now - min, worktree: wt(1) }),
    job({ id: 2, status: "waiting", startedAt: now - min }),
    job({ id: 3, status: "running", startedAt: now - min, summary: "(practice run: nothing launched)" }),
    job({ id: 4, status: "running", startedAt: 0 }),
    job({ id: 5, status: "running", startedAt: null }),       // no startedAt at all
  ];
  const m = matchJobs(never, [rec("grok", repo, "s", now - 30e3, 1), rec("grok", wt(1), "s", now - 30e3, 1)], now);
  assert.deepEqual(m, {}, "held/waiting/practice/unstarted jobs never match");
  // stopped/failed/accepted/finished with a startedAt do count as launched.
  for (const status of ["stopped", "failed", "accepted", "finished", "conflict"]) {
    const m2 = matchJobs([job({ id: 9, status, startedAt: now - 30 * min, finishedAt: now - 20 * min, worktree: wt(9) })],
      [rec("grok", wt(9), "s", now - 25 * min, 7)], now);
    assert.equal(m2[9].tokens, 7, `${status} with a startedAt is a launched job`);
  }
}

// ---------------------------------------------------------------- folders

// A copy whose worktree was dropped has no live folder, even though dir is known.
{
  const dropped = job({ id: 1, agent: "devin", copy: 2, dir: repo, worktree: "", status: "accepted", startedAt: now - 60 * min, finishedAt: now - 50 * min });
  const m = matchJobs([dropped], [rec("devin", repo, "s", now - 55 * min, 999)], now);
  assert.equal(m[1].tokens, null);
  assert.match(m[1].why, /worktree is gone/);
}

// A non-copy job with an empty worktree still matches on dir; one with a worktree set
// uses the worktree and skips the shared-folder ambiguity rules entirely.
{
  const shared = job({ id: 1, worktree: "", status: "finished", startedAt: now - 30 * min, finishedAt: now - 20 * min });
  assert.equal(matchJobs([shared], [rec("grok", repo, "s", now - 25 * min, 10)], now)[1].tokens, 10);
  const odd = job({ id: 2, copy: undefined, worktree: wt(2), status: "running", startedAt: now - 10 * min });
  const two = matchJobs([odd], [rec("grok", wt(2), "a", now - 9 * min, 10), rec("grok", wt(2), "b", now - 5 * min, 20)], now);
  assert.equal(two[2].tokens, 30, "a worktree job sums every session its agent started there");
}

// ---------------------------------------------------------------- shared-folder ambiguity

// A session that started before a rival job's run began belongs to the earlier job alone.
{
  const a = job({ id: 1, status: "finished", startedAt: now - 60 * min, finishedAt: now - 30 * min });
  const b = job({ id: 2, status: "finished", startedAt: now - 40 * min, finishedAt: now - 10 * min });
  // Session at -50 min: inside A only (B started at -40).
  const early = matchJobs([a, b], [rec("grok", repo, "s", now - 50 * min, 100)], now);
  assert.equal(early[1].tokens, 100, "before the rival started: no ambiguity");
  assert.equal(early[2].tokens, null);
  assert.match(early[2].why, /no session/);
  // Session at -35 min: inside both runs -> both can't tell.
  const overlap = matchJobs([a, b], [rec("grok", repo, "s", now - 35 * min, 100)], now);
  assert.equal(overlap[1].tokens, null);
  assert.equal(overlap[2].tokens, null);
  assert.match(overlap[1].why, /another job/);
}

// The 2 s slack applies to the rival's window too: a session 1 s before the rival's
// launch still counts as the rival's, so the earlier job can't claim it either? No —
// it is inside the earlier job but the rival check uses the same slack, so it IS rival's.
{
  const a = job({ id: 1, status: "finished", startedAt: now - 60 * min, finishedAt: now - 30 * min });
  const b = job({ id: 2, status: "finished", startedAt: now - 40 * min, finishedAt: now - 10 * min });
  const s = now - 40 * min - SLACK + 1; // 1 ms inside B's slack window
  const m = matchJobs([a, b], [rec("grok", repo, "s", s, 100)], now);
  assert.equal(m[1].tokens, null, "within the rival's 2 s slack the session can't be told apart");
  assert.match(m[1].why, /another job/);
}

// A rival that never launched (held/waiting) or runs in its own worktree doesn't conflict.
{
  const a = job({ id: 1, status: "finished", startedAt: now - 60 * min, finishedAt: now - 30 * min });
  const held = job({ id: 2, status: "held", startedAt: now - 40 * min });
  const copy = job({ id: 3, agent: "grok", copy: 1, dir: repo, worktree: wt(3), status: "running", startedAt: now - 40 * min });
  const m = matchJobs([a, held, copy], [rec("grok", repo, "s", now - 35 * min, 100)], now);
  assert.equal(m[1].tokens, 100, "held and worktree jobs are not rivals");
}

// Unit check runs before the session-count check: one credits record poisons the whole job.
{
  const j = job({ status: "finished", startedAt: now - 30 * min, finishedAt: now - 10 * min });
  const mixed = matchJobs([j], [rec("grok", repo, "a", now - 25 * min, 100), rec("grok", repo, "b", now - 20 * min, 1.5, "AIC")], now);
  assert.equal(mixed[1].tokens, null);
  assert.match(mixed[1].why, /credits/);
  // A record with NO unit field is treated the same as credits.
  const noUnit = matchJobs([job({ id: 2, status: "finished", startedAt: now - 30 * min, finishedAt: now - 10 * min })],
    [{ agent: "grok", folder: repo, session: "s", start: now - 25 * min, amount: 10 }], now);
  assert.equal(noUnit[2].tokens, null);
  assert.match(noUnit[2].why, /credits/);
}

// ---------------------------------------------------------------- amounts & malformed records

// Amounts are coerced with Number(): strings work, junk becomes 0, the session still counts.
{
  const j = job({ status: "finished", startedAt: now - 30 * min, finishedAt: now - 10 * min });
  const m = matchJobs([j], [rec("grok", repo, "a", now - 25 * min, "2500"), rec("grok", repo, "b", now - 20 * min, "junk")], now);
  // Two sessions in a shared folder -> ambiguous; use a worktree job to see the sum.
  const w = job({ id: 2, worktree: wt(2), status: "finished", startedAt: now - 30 * min, finishedAt: now - 10 * min });
  const mw = matchJobs([w], [rec("grok", wt(2), "a", now - 25 * min, "2500"), rec("grok", wt(2), "b", now - 20 * min, "junk")], now);
  assert.equal(mw[2].tokens, 2500, "string amount coerced, junk amount counts as 0");
  assert.equal(m[1].tokens, null);
}

// Malformed starts never match (NaN comparisons are false) -> honest "no session".
{
  const j = job({ status: "finished", startedAt: now - 30 * min, finishedAt: now - 10 * min });
  for (const bad of ["abc", null, {}, NaN]) {
    const m = matchJobs([j], [{ agent: "grok", folder: repo, session: "s", start: bad, amount: 5, unit: "tokens" }], now);
    assert.equal(m[1].tokens, null, `start=${JSON.stringify(bad)} cannot match`);
  }
  // A non-record (string) is skipped safely.
  const m2 = matchJobs([j], ["junk", 42], now);
  assert.equal(m2[1].tokens, null);
}

// Records for other agents/folders are ignored entirely.
{
  const j = job({ status: "finished", startedAt: now - 30 * min, finishedAt: now - 10 * min });
  const m = matchJobs([j], [
    rec("devin", repo, "s", now - 25 * min, 100),          // wrong agent
    rec("grok", "/other/folder", "s", now - 25 * min, 100), // wrong folder
    rec("grok", repo + "/", "s", now - 25 * min, 100),      // trailing slash is a different folder
  ], now);
  assert.equal(m[1].tokens, null);
  assert.match(m[1].why, /no session/);
}

// A null/undefined/non-record entry in the records array is skipped, never a crash:
// folder-usage.json is read from disk, so one corrupt record must not take down `constance status`.
{
  const j = job({ id: 1, worktree: wt(1), status: "running", startedAt: now - min });
  const m = matchJobs([j], [null, undefined, "junk", 42, rec("grok", wt(1), "s", now - 30e3, 10)], now);
  assert.equal(m[1].tokens, 10, "non-record entries are ignored");
  const empty = matchJobs([j], [null, undefined], now);
  assert.equal(empty[1].tokens, null);
  assert.match(empty[1].why, /no session/);
}

// Honest data: a session with NO amount field can't be summed into a real 0, and a
// negative amount can't produce a negative total — both are "can't tell".
{
  const w = (id) => job({ id, worktree: wt(id), status: "finished", startedAt: now - 30 * min, finishedAt: now - 10 * min });
  for (const [id, amount] of [[1, undefined], [2, null], [3, -500], [4, "-50"]]) {
    const m = matchJobs([w(id)], [{ agent: "grok", folder: wt(id), session: "s", start: now - 25 * min, amount, unit: "tokens" }], now);
    assert.equal(m[id].tokens, null, `amount=${JSON.stringify(amount)} is not a usable total`);
    assert.match(m[id].why, /token total/);
  }
  // A reported 0 is a real count, and junk that coerces to NaN still counts as 0 (see above).
  const zero = matchJobs([w(5)], [rec("grok", wt(5), "s", now - 25 * min, 0)], now);
  assert.equal(zero[5].tokens, 0);
}

// ---------------------------------------------------------------- jobTokens / snapshots

{
  const live = { 1: { tokens: 0, sessions: ["s"] } };
  assert.equal(jobTokens({ id: 1, status: "running" }, live), 0, "a real 0 is a count, not can't-tell");
  assert.equal(jobTokens({ id: 1, status: "finished", tokens: { n: 0, sessions: ["s"], at: now } }, {}), 0,
    "a kept 0 survives once live records are gone");
  // Kept count is only used for jobs that are over.
  assert.equal(jobTokens({ id: 1, status: "running", tokens: { n: 42 } }, {}), null);
  // Non-finite or non-number kept counts are ignored.
  for (const bad of [{ n: NaN }, { n: "5000" }, { n: Infinity }, {}, { n: -5 }]) {
    const j = { id: 1, status: "finished", tokens: bad };
    const expected = bad && bad.n === -5 ? -5 : null; // -5 is finite: it IS returned (see note below)
    assert.equal(jobTokens(j, {}), expected, `tokens=${JSON.stringify(bad)}`);
  }
}

// snapshots keeps only changed live counts, stamped with `now`; null matches and
// non-launched jobs are skipped.
{
  const jobs = [
    { id: 1, agent: "grok", dir: repo, worktree: wt(1), status: "running", startedAt: now - min },
    { id: 2, agent: "grok", dir: repo, worktree: wt(2), status: "finished", startedAt: now - 60 * min, finishedAt: now - 50 * min, tokens: { n: 300, sessions: [], at: now - 49 * min } },
    { id: 3, agent: "grok", dir: repo, status: "held", startedAt: now - min },
  ];
  const live = {
    1: { tokens: 100, sessions: ["a"] },
    2: { tokens: 300, sessions: ["b"] },   // same as kept: not rewritten
    // 3: never launched -> no entry
  };
  const keep = snapshots(jobs, live, now);
  assert.deepEqual(Object.keys(keep), ["1"]);
  assert.deepEqual(keep[1], { n: 100, sessions: ["a"], at: now });
  // A job whose live match went back to can't-tell keeps whatever was stored before.
  const gone = snapshots(jobs, { 1: { tokens: null, why: "x" } }, now);
  assert.deepEqual(gone, {});
}

// ---------------------------------------------------------------- fmtTokens boundaries

assert.equal(fmtTokens(0), "0");
assert.equal(fmtTokens(999), "999");
assert.equal(fmtTokens(999.4), "999");
assert.equal(fmtTokens(999.5), "1000", "rounds up at the top of the plain range");
assert.equal(fmtTokens(1000), "1K");
assert.equal(fmtTokens(999499), "999K");
assert.equal(fmtTokens(1000000), "1M");
assert.equal(fmtTokens(2500000), "2.5M");
assert.equal(fmtTokens(10000000), "10M");
assert.equal(fmtTokens(1000000000), "1B");
assert.equal(fmtTokens(2500000000), "2.5B");
assert.equal(fmtTokens(10000000000), "10B");
assert.equal(fmtTokens(undefined), CANT_TELL);
assert.equal(fmtTokens(-5), "-5");

// Rounding at a unit boundary rolls into the next unit (never "1000K"), and T exists.
assert.equal(fmtTokens(999500), "1M");
assert.equal(fmtTokens(999999), "1M");
assert.equal(fmtTokens(999999999), "1B");
assert.equal(fmtTokens(999999999999), "1T");
assert.equal(fmtTokens(1e12), "1T");
assert.equal(fmtTokens(2.5e12), "2.5T");
assert.equal(fmtTokens(1.5e13), "15T");

// ---------------------------------------------------------------- tokenMeter

// No arguments at all: empty meter, calm "Today 0" line.
{
  const m = tokenMeter();
  assert.deepEqual(m.workers, []);
  assert.equal(m.goal, null);
  assert.deepEqual(m.today, { total: 0, cantTell: 0 });
  assert.equal(m.line, "Today 0");
}

// "Today" is by startedAt: exactly midnight counts, 1 ms before does not. A job that
// started yesterday but is still running counts toward the goal, never toward today.
{
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const sod = midnight.getTime();
  const jobs = [
    { id: 1, goal: "g", agent: "grok", dir: repo, worktree: wt(1), status: "accepted", startedAt: sod, finishedAt: sod + min, tokens: { n: 100 } },
    { id: 2, goal: "g", agent: "grok", dir: repo, worktree: wt(2), status: "accepted", startedAt: sod - 1, finishedAt: sod + min, tokens: { n: 200 } },
    // Started 26 h ago and still running: a kept count is never used while running,
    // so it needs a live record in its worktree to have tokens at all.
    { id: 3, goal: "g", agent: "grok", dir: repo, worktree: wt(3), status: "running", startedAt: now - 26 * 60 * min },
  ];
  const records = [rec("grok", wt(3), "s3", now - 60 * min, 400)];
  const m = tokenMeter({ jobs, goal: { id: "g" }, records, now });
  assert.equal(m.today.total, 100, "midnight itself is today; 1 ms before is not; the 26 h runner is not");
  assert.equal(m.today.cantTell, 0);
  assert.equal(m.goal.total, 700, "the goal still counts every launched job of it");
}

// A goal with no jobs of it still prints "This goal 0"; cantTell pluralizes.
{
  const jobs = [
    { id: 1, goal: "other", agent: "grok", dir: repo, worktree: wt(1), status: "finished", startedAt: now - 30 * min, finishedAt: now - 20 * min, tokens: { n: 50 } },
  ];
  const m = tokenMeter({ jobs, goal: { id: "g" }, records: [], now });
  assert.equal(m.goal.total, 0);
  assert.deepEqual(m.goal.byAgent, []);
  assert.equal(m.line, "This goal 0 · Today 50");
}

// One can't-tell job uses the singular; two use the plural. Workers keep job-id order.
{
  const mk = (id, agent, status = "running") => ({ id, goal: "g", agent, dir: repo, worktree: wt(id), status, startedAt: now - id * min });
  const jobs = [mk(3, "grok"), mk(1, "devin"), mk(2, "grok", "finished")];
  jobs[2].finishedAt = now - min;
  jobs[2].tokens = { n: 50, sessions: ["s"], at: now - min };   // finished: its kept count counts
  const m = tokenMeter({ jobs, goal: { id: "g" }, records: [], now, name: (id) => id.toUpperCase() });
  assert.deepEqual(m.workers.map((w) => w.job), [1, 3], "only running jobs, sorted by id");
  assert.equal(m.workers[0].name, "DEVIN", "name() is the fallback when worker is unset");
  assert.equal(m.goal.cantTell, 2);
  assert.match(m.line, /\+ 2 jobs can't tell/);
  const one = tokenMeter({ jobs: [jobs[0]], goal: { id: "g" }, records: [], now });
  assert.match(one.line, /\+ 1 job can't tell/);
}

// byAgent is sorted by tokens descending and carries the display name.
{
  const jobs = [
    { id: 1, goal: "g", agent: "grok", dir: repo, worktree: wt(1), status: "finished", startedAt: now - 60 * min, finishedAt: now - 50 * min, tokens: { n: 100 } },
    { id: 2, goal: "g", agent: "devin", dir: repo, worktree: wt(2), status: "finished", startedAt: now - 40 * min, finishedAt: now - 30 * min, tokens: { n: 900 } },
    { id: 3, goal: "g", agent: "devin", dir: repo, worktree: wt(3), status: "finished", startedAt: now - 20 * min, finishedAt: now - 10 * min, tokens: { n: 100 } },
  ];
  const m = tokenMeter({ jobs, goal: { id: "g" }, records: [], now, name: (id) => id });
  assert.deepEqual(m.goal.byAgent, [{ agent: "devin", name: "devin", tokens: 1000 }, { agent: "grok", name: "grok", tokens: 100 }]);
  assert.equal(m.line, "This goal 1.1K (devin 1K · grok 100) · Today 1.1K");
}

// ---------------------------------------------------------------- records on disk

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "constance-tokens-deep-"));
const fakeHome = { HOME: tmp, XDG_STATE_HOME: "", FOLDER_USAGE_STATE_DIR: "" };

// usageFile precedence: FOLDER_USAGE_STATE_DIR > XDG_STATE_HOME > HOME > os.homedir().
assert.equal(usageFile({ FOLDER_USAGE_STATE_DIR: "/sd", XDG_STATE_HOME: "/xdg", HOME: "/h" }), "/sd/folder-usage.json");
assert.equal(usageFile({ XDG_STATE_HOME: "/xdg", HOME: "/h" }), "/xdg/omarchy/agent-usage-tabs/folder-usage.json");
assert.equal(usageFile({ HOME: "/h" }), "/h/.local/state/omarchy/agent-usage-tabs/folder-usage.json");
assert.equal(usageFile({}), path.join(os.homedir(), ".local/state", "omarchy", "agent-usage-tabs", "folder-usage.json"));
assert.equal(usageFile(fakeHome), path.join(tmp, ".local/state", "omarchy", "agent-usage-tabs", "folder-usage.json"),
  "empty strings are falsy: HOME wins over nothing");

// readRecords failure paths: every malformed file is "no records", never a throw.
{
  const dir = path.join(tmp, "records"); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "folder-usage.json");
  const expect = (content, label) => {
    fs.writeFileSync(f, content);
    assert.deepEqual(readRecords(f), { records: [], refreshedAt: 0 }, label);
  };
  expect("{not json", "unparseable JSON");
  expect("null", "JSON null");
  expect("[1,2]", "top-level array");
  expect('"str"', "top-level string");
  expect('{"records": null}', "records not an array");
  fs.writeFileSync(f, '{"records": [], "refreshedAt": "abc"}');
  assert.equal(readRecords(f).refreshedAt, 0, "garbage refreshedAt -> 0");
  fs.writeFileSync(f, '{"records": [1], "refreshedAt": -50}');
  assert.equal(readRecords(f).refreshedAt, -50, "negative refreshedAt passes through"); // always stale
  fs.mkdirSync(path.join(dir, "is-a-dir"), { recursive: true });
  assert.deepEqual(readRecords(path.join(dir, "is-a-dir")), { records: [], refreshedAt: 0 }, "a directory reads as empty");
  assert.deepEqual(readRecords(path.join(dir, "missing.json")), { records: [], refreshedAt: 0 }, "missing file");
  // Records pass through unvalidated — matchJobs must cope (see the null-record note above).
  fs.writeFileSync(f, '{"records": "nope", "refreshedAt": 5}');
  assert.deepEqual(readRecords(f), { records: [], refreshedAt: 5 }, "non-array records -> [], refreshedAt still read");
}

// ---------------------------------------------------------------- refreshInBackground

{
  const dir = path.join(tmp, "refresh");
  const env = { FOLDER_USAGE_STATE_DIR: dir };
  const file = usageFile(env);
  const marker = file + ".constance-refresh";
  const write = (obj) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj)); };
  const gap = 1000;
  let runs = 0;
  const run = () => runs++;

  // Missing file -> stale -> refresh; marker then throttles.
  assert.equal(refreshInBackground({ env, now, gap, run }), true);
  assert.equal(runs, 1);
  assert.equal(refreshInBackground({ env, now: now + gap - 1, gap, run }), false, "inside the gap: no second rescan");
  assert.equal(refreshInBackground({ env, now: now + gap, gap, run }), true, "exactly at the gap boundary refreshes again");
  assert.equal(runs, 2);

  // refreshedAt boundaries (marker cleared so only the file decides): age < gap is
  // fresh, age >= gap is stale. A refreshedAt in the future counts as fresh.
  const at = (refreshedAt, t) => {
    fs.rmSync(marker, { force: true });
    write({ refreshedAt });
    return refreshInBackground({ env, now: t, gap, run });
  };
  assert.equal(at(now + 5000, now + gap), false, "a future refreshedAt counts as fresh");
  assert.equal(at(now + 1, now + gap), false, "age gap-1: still fresh");
  assert.equal(at(now, now + gap), true, "age exactly gap: stale");
  assert.equal(at(now - 1, now + gap), true, "age gap+1: stale");

  // Marker boundaries, including a marker from the future (clock moved backwards).
  write({ refreshedAt: 0 });
  fs.writeFileSync(marker, String(now - gap + 1));
  assert.equal(refreshInBackground({ env, now, gap, run }), false, "marker gap-1 old still throttles");
  fs.writeFileSync(marker, String(now - gap));
  assert.equal(refreshInBackground({ env, now, gap, run }), true, "marker exactly gap old lets one through");
  fs.writeFileSync(marker, String(now + gap / 2));
  assert.equal(refreshInBackground({ env, now: now + gap / 4, gap, run }), false, "a marker from the future within gap throttles");
  fs.writeFileSync(marker, "not-a-number");
  assert.equal(refreshInBackground({ env, now: now + 2 * gap, gap, run }), true, "garbage marker is ignored");
  fs.writeFileSync(marker, "0");
  assert.equal(refreshInBackground({ env, now: now + 3 * gap, gap, run }), true, "a 0 marker is ignored too (refreshedAt is still 0)");

  // The marker is written before run() is invoked, so even a throwing run leaves a throttle.
  fs.rmSync(marker, { force: true }); write({ refreshedAt: 0 });
  assert.throws(() => refreshInBackground({ env, now, gap, run: () => { throw new Error("boom"); } }), /boom/);
  assert.equal(fs.existsSync(marker), true, "marker written even when run throws");
  assert.equal(refreshInBackground({ env, now: now + 1, gap, run }), false, "and it throttles the retry");

  // Failure path: state dir under a regular file -> mkdir fails -> false, no throw.
  const blocker = path.join(tmp, "blocker"); fs.writeFileSync(blocker, "x");
  const badEnv = { FOLDER_USAGE_STATE_DIR: path.join(blocker, "sub") };
  assert.equal(refreshInBackground({ env: badEnv, now, gap, run }), false);
}

// refreshNow failure path: no python3 on PATH -> false, fast, no throw. (The success
// path runs the real folder-usage.py and is covered by the live plugin, not here.)
{
  const empty = path.join(tmp, "empty-bin"); fs.mkdirSync(empty);
  assert.equal(refreshNow({ PATH: empty, HOME: tmp }), false);
}

// ================================================================ round 2: more edges

// ---------------------------------------------------------------- matchJobs, cont.

assert.deepEqual(matchJobs([], [rec("grok", repo, "s", now, 1)], now), {}, "no jobs -> empty map");

// A job with no folder at all (no dir, no worktree, not a copy) can't be matched;
// the "worktree is gone" wording is a little off but the can't-tell is honest.
{
  const j = { id: 1, agent: "grok", status: "finished", startedAt: now - 30 * min, finishedAt: now - 10 * min };
  const m = matchJobs([j], [rec("grok", repo, "s", now - 25 * min, 10)], now);
  assert.equal(m[1].tokens, null);
  assert.match(m[1].why, /worktree is gone/);
}

// endOf() trusts the stored finish time even when it lies in the future: a finished
// job's window can reach past `now`, so a "future" session still matches it.
{
  const j = job({ status: "finished", startedAt: now - 30 * min, finishedAt: now + 30 * min });
  assert.equal(matchJobs([j], [rec("grok", repo, "s", now + 10 * min, 10)], now)[1].tokens, 10,
    "finishedAt in the future extends the window past now");
}

// The mirror image: a job launched in the future has an empty window.
{
  const j = job({ status: "running", startedAt: now + 10 * min });
  const m = matchJobs([j], [rec("grok", repo, "s", now + 20 * min, 10)], now);
  assert.equal(m[1].tokens, null);
  assert.match(m[1].why, /no session/);
}

// status "running" always ends the window at now, ignoring any stale finishedAt.
{
  const j = job({ status: "running", startedAt: now - 30 * min, finishedAt: now - 10 * min });
  assert.equal(matchJobs([j], [rec("grok", repo, "s", now - 5 * min, 10)], now)[1].tokens, 10,
    "a running job's window reaches now even with a stale finishedAt");
}

// Number() coercion cuts both ways: a numeric-string start matches, and the unit
// check is case-sensitive ("Tokens" is not "tokens" -> treated as credits).
{
  const w = job({ id: 2, worktree: wt(2), status: "finished", startedAt: now - 30 * min, finishedAt: now - 10 * min });
  const str = matchJobs([w], [{ agent: "grok", folder: wt(2), session: "s", start: String(now - 25 * min), amount: 10, unit: "tokens" }], now);
  assert.equal(str[2].tokens, 10, "a numeric-string start coerces and matches");
  const j = job({ id: 1, status: "finished", startedAt: now - 30 * min, finishedAt: now - 10 * min });
  const cap = matchJobs([j], [rec("grok", repo, "s", now - 25 * min, 10, "Tokens")], now);
  assert.equal(cap[1].tokens, null);
  assert.match(cap[1].why, /credits/, "unit is case-sensitive");
}

// Only a rival of the SAME agent in the SAME folder blocks a match: an overlapping
// job of another agent, or of the same agent in another folder, is no rival.
{
  const a = job({ id: 1, status: "finished", startedAt: now - 60 * min, finishedAt: now - 30 * min });
  const devin = job({ id: 2, agent: "devin", status: "running", startedAt: now - 40 * min });
  const elsewhere = job({ id: 3, agent: "grok", dir: "/other/folder", status: "running", startedAt: now - 40 * min });
  const m = matchJobs([a, devin, elsewhere], [rec("grok", repo, "s", now - 35 * min, 100)], now);
  assert.equal(m[1].tokens, 100, "different agent / different folder rivals don't conflict");
}

// BUG: a NaN amount slips past the usable-total check — `NaN == null` is false and
// `NaN < 0` is false — then coerces to 0 in the sum, so the job reports a real
// token count built on a missing value. The same input is "can't tell" when the
// field is absent; NaN should be rejected the same way.
// const nanJob = job({ id: 7, worktree: wt(7), status: "running", startedAt: now - min });
// const nan = matchJobs([nanJob], [{ agent: "grok", folder: wt(7), session: "s", start: now - 30e3, amount: NaN, unit: "tokens" }], now);
// assert.equal(nan[7].tokens, null);

// BUG: a +Infinity amount also passes the check (not null, not < 0) and sums to
// tokens: Infinity. jobTokens then returns Infinity and fmtTokens(Infinity)
// renders "InfinityT", which the panel would print as "InfinityT tokens". Non-finite
// amounts should be "can't tell" like missing ones.
// const infJob = job({ id: 8, worktree: wt(8), status: "running", startedAt: now - min });
// const inf = matchJobs([infJob], [{ agent: "grok", folder: wt(8), session: "s", start: now - 30e3, amount: Infinity, unit: "tokens" }], now);
// assert.equal(inf[8].tokens, null);

// ---------------------------------------------------------------- jobTokens / snapshots, cont.

// A kept count must be an object with a finite n; primitives and non-finite n are ignored.
for (const bad of [42, "5000", { n: Infinity }, { n: -Infinity }, null]) {
  assert.equal(jobTokens({ id: 1, status: "finished", tokens: bad }, {}), null, `tokens=${JSON.stringify(bad)}`);
}

// snapshots only compares n: the same total with a different session list is NOT
// rewritten, so the stored sessions can go stale. (Documented behavior, kept as is.)
{
  const j = { id: 1, agent: "grok", dir: repo, worktree: wt(1), status: "running", startedAt: now - min,
    tokens: { n: 100, sessions: ["old"], at: now - min } };
  const keep = snapshots([j], { 1: { tokens: 100, sessions: ["new", "list"] } }, now);
  assert.deepEqual(keep, {}, "unchanged n skips the rewrite even when sessions differ");
}

// A live count of 0 is still a change worth keeping once.
{
  const j = { id: 1, agent: "grok", dir: repo, worktree: wt(1), status: "running", startedAt: now - min };
  assert.deepEqual(snapshots([j], { 1: { tokens: 0, sessions: ["s"] } }, now),
    { 1: { n: 0, sessions: ["s"], at: now } });
}

// snapshots trusts the live map it is handed: matchJobs never emits entries for
// never-launched jobs, but a hand-built map's entry is kept regardless.
{
  const held = { id: 9, agent: "grok", dir: repo, status: "held", startedAt: now - min };
  assert.deepEqual(snapshots([held], { 9: { tokens: 5, sessions: ["x"] } }, now),
    { 9: { n: 5, sessions: ["x"], at: now } }, "snapshots does not re-check launched()");
}

// ---------------------------------------------------------------- fmtTokens, cont.

// Negatives never reach the unit table: they always print as plain rounded integers.
assert.equal(fmtTokens(-1500), "-1500");
assert.equal(fmtTokens(-999500), "-999500");
// Numeric strings format like numbers.
assert.equal(fmtTokens("2500"), "2.5K");
assert.equal(fmtTokens("999"), "999");

// BUG: fmtTokens(NaN) throws — no unit is >= NaN, so units[-1] is undefined and the
// destructure `let [size, suffix] = units[i]` raises TypeError. The function already
// maps null/undefined to CANT_TELL; non-finite numbers should get the same honest
// treatment instead of crashing `constance status`.
// assert.equal(fmtTokens(NaN), CANT_TELL);

// BUG: fmtTokens(Infinity) returns "InfinityT" — it picks the largest unit and the
// division stays Infinity. Reachable via the Infinity-amount path above; should be
// CANT_TELL like other non-finite input.
// assert.equal(fmtTokens(Infinity), CANT_TELL); // currently "InfinityT"

// ---------------------------------------------------------------- tokenMeter, cont.

// Goal matching is strict: job.goal "1" (string) does not match goal.id 1 (number).
{
  const jobs = [{ id: 1, goal: "1", agent: "grok", dir: repo, worktree: wt(1), status: "finished",
    startedAt: now - 30 * min, finishedAt: now - 20 * min, tokens: { n: 10 } }];
  const m = tokenMeter({ jobs, goal: { id: 1 }, records: [], now });
  assert.equal(m.goal.total, 0, "string goal id vs number goal.id: no match");
  assert.equal(m.today.total, 10, "...but it still counts for today");
}

// A running job without startedAt never launched: no worker row and it doesn't
// inflate the goal's can't-tell count.
{
  const j = { id: 1, goal: "g", agent: "grok", dir: repo, status: "running" };
  const m = tokenMeter({ jobs: [j], goal: { id: "g" },
    records: [rec("grok", repo, "s", now - min, 10)], now });
  assert.deepEqual(m.workers, []);
  assert.equal(m.goal.total, 0);
  assert.equal(m.goal.cantTell, 0, "never-launched jobs don't inflate can't-tell");
}

// The job's own `worker` label beats name(): shown verbatim in workers[].name/text.
{
  const j = { id: 1, agent: "devin", worker: "Devin 7", dir: repo, worktree: wt(1), status: "running", startedAt: now - min };
  const m = tokenMeter({ jobs: [j], records: [rec("devin", wt(1), "s", now - 30e3, 500)], now, name: () => "WRONG" });
  assert.equal(m.workers[0].name, "Devin 7");
  assert.equal(m.workers[0].text, "Devin 7  500 tokens");
}

// "Today" trusts startedAt: a job stamped in the future is still >= startOfDay(now).
{
  const j = { id: 1, agent: "grok", dir: repo, worktree: wt(1), status: "finished",
    startedAt: now + 60 * min, finishedAt: now + 70 * min, tokens: { n: 10 } };
  const m = tokenMeter({ jobs: [j], records: [], now });
  assert.equal(m.today.total, 10, "a future startedAt counts as today");
}

// The meter returns the live match map it computed, for callers that want the `why`s.
{
  const j = { id: 1, agent: "grok", dir: repo, worktree: wt(1), status: "running", startedAt: now - min };
  const m = tokenMeter({ jobs: [j], records: [], now });
  assert.equal(m.live[1].tokens, null);
  assert.match(m.live[1].why, /no session/);
}

// BUG: tokenMeter({ goal: {} }) — a goal object with no `id` — counts EVERY job
// whose own goal field is unset, because `j.goal === goal.id` is `undefined ===
// undefined`. Those jobs were never part of any goal, yet they land under
// "This goal". A goal without an id should match nothing.
// const stray = tokenMeter({ jobs: [{ id: 1, agent: "grok", dir: repo, worktree: wt(1),
//   status: "finished", startedAt: now - min, finishedAt: now, tokens: { n: 5 } }],
//   goal: {}, records: [], now });
// assert.equal(stray.goal, null); // currently { total: 5, ... }

// ---------------------------------------------------------------- records on disk, cont.

// A UTF-8 BOM makes JSON.parse fail -> empty records, same as any corrupt file.
{
  const dir = path.join(tmp, "bom"); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "folder-usage.json");
  fs.writeFileSync(f, "\uFEFF" + JSON.stringify({ records: [1], refreshedAt: 5 }));
  assert.deepEqual(readRecords(f), { records: [], refreshedAt: 0 }, "BOM'd JSON is unparseable -> empty");
}

// refreshedAt coerces like the rest: numeric strings work, junk falls back to 0 (stale).
{
  const dir = path.join(tmp, "refreshed"); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "folder-usage.json");
  fs.writeFileSync(f, '{"records": [], "refreshedAt": "12345"}');
  assert.equal(readRecords(f).refreshedAt, 12345);
  fs.writeFileSync(f, '{"records": [], "refreshedAt": "abc"}');
  assert.equal(readRecords(f).refreshedAt, 0, "garbage string -> 0 -> always stale");
}

// ---------------------------------------------------------------- refreshInBackground, cont.

// gap = 0 disables both shortcuts: every call refreshes, and the marker can't
// throttle either (Math.abs(now - at) < 0 is never true).
{
  const dir = path.join(tmp, "zero-gap"); const env = { FOLDER_USAGE_STATE_DIR: dir };
  const file = usageFile(env);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ refreshedAt: now }));
  let runs = 0; const run = () => runs++;
  assert.equal(refreshInBackground({ env, now, gap: 0, run }), true);
  assert.equal(refreshInBackground({ env, now, gap: 0, run }), true, "gap 0: the marker can't throttle");
  assert.equal(runs, 2);
}

// Two calls in the same tick: the second sees the marker the first one wrote.
{
  const dir = path.join(tmp, "same-tick"); const env = { FOLDER_USAGE_STATE_DIR: dir };
  fs.mkdirSync(dir, { recursive: true }); // no usage file: stale
  let runs = 0; const run = () => runs++;
  assert.equal(refreshInBackground({ env, now, gap: 60e3, run }), true);
  assert.equal(refreshInBackground({ env, now, gap: 60e3, run }), false);
  assert.equal(runs, 1);
}

// A marker path that is a directory can't be written -> refresh reports false, no throw.
{
  const dir = path.join(tmp, "marker-dir"); const env = { FOLDER_USAGE_STATE_DIR: dir };
  const file = usageFile(env);
  fs.mkdirSync(file + ".constance-refresh", { recursive: true });
  assert.equal(refreshInBackground({ env, now, gap: 1000, run: () => {} }), false);
}

// A marker stamped more than `gap` in the future is ignored (the clock jumped back
// far): the refresh goes through and rewrites the marker with the current time.
{
  const dir = path.join(tmp, "future-marker"); const env = { FOLDER_USAGE_STATE_DIR: dir };
  const file = usageFile(env); const marker = file + ".constance-refresh";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ refreshedAt: 0 }));
  fs.writeFileSync(marker, String(now + 10 * 60e3));
  let ran = false;
  assert.equal(refreshInBackground({ env, now, gap: 1000, run: () => { ran = true; } }), true);
  assert.equal(ran, true);
  assert.equal(fs.readFileSync(marker, "utf8"), String(now), "marker rewritten to now");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("constance-tokens.deep: ok");
