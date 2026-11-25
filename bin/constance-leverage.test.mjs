// Constance's leverage meter: sessionSpent sums rises and counts a dropped
// reading from 0 after a reset; junk samples are ignored. leverage() nulls
// perPct below 0.5% spent and builds the label. addSample/readSamples round-
// trip a JSON-lines file capped at 2000 lines. handoffReturns groups jobs by
// agent and size (accepted only toward tokens), bestReturnLesson needs 3+
// accepted jobs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "constance-leverage-home-"));
process.env.HOME = home;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-leverage-"));

const { TARGET_PER_PCT, TARGET_PER_SESSION, sessionSpent, leverage, addSample, readSamples, handoffReturns, bestReturnLesson } =
  await import("./constance-leverage.mjs");

assert.equal(TARGET_PER_PCT, 5e6);
assert.equal(TARGET_PER_SESSION, 1e9);

// sessionSpent: empty and single samples spend nothing.
assert.equal(sessionSpent([]), 0);
assert.equal(sessionSpent([{ at: 1, used: 0.4 }]), 0);
assert.equal(sessionSpent(null), 0);

// Rises add up in percentage points; flat readings add nothing.
assert.equal(sessionSpent([{ used: 0.1 }, { used: 0.3 }, { used: 0.3 }, { used: 0.5 }]), 40);
assert.equal(sessionSpent([{ used: 0 }, { used: 1 }]), 100);

// A drop is a window reset: the new reading counts from 0, then rises again.
assert.equal(sessionSpent([{ used: 0.8 }, { used: 0.9 }, { used: 0.1 }, { used: 0.2 }]), 30);
assert.equal(sessionSpent([{ used: 0.5 }, { used: 0.1 }, { used: 0.1 }, { used: 0.4 }]), 40);

// Junk used values are ignored and don't move the baseline.
assert.equal(sessionSpent([{ used: 0.1 }, { used: "x" }, { used: NaN }, { used: null }, { used: 0.4 }]), 30);
assert.equal(sessionSpent([{ used: "junk" }]), 0);

// leverage: per-1% math, session extrapolation and target ratio.
const m = leverage({ tokens: 31e6, spentPct: 12.5 });
assert.equal(m.perPct, 31e6 / 12.5);
assert.equal(m.perSession, m.perPct * 100);
assert.equal(m.vsTarget, m.perPct / TARGET_PER_PCT);
assert.equal(m.label, "2.5M per 1% (target 5M)");

// Tiny spends give nulls and the honest not-enough label.
for (const spentPct of [0, 0.4, 0.49]) {
  const l = leverage({ tokens: 31e6, spentPct });
  assert.equal(l.perPct, null);
  assert.equal(l.perSession, null);
  assert.equal(l.vsTarget, null);
  assert.equal(l.label, "not enough Opus spent to measure yet");
}
assert.equal(leverage({ tokens: 31e6, spentPct: 12.5, name: "Sonnet" }).label, "2.5M per 1% (target 5M)");
assert.equal(leverage({ tokens: "x", spentPct: 12.5 }).label, "no worker tokens to measure yet");
assert.equal(leverage({}).label, "not enough Opus spent to measure yet");

// Samples file: append, read back, filter by sinceAt, skip broken lines.
const file = path.join(dir, "samples.jsonl");
assert.deepEqual(readSamples(file), [], "missing file -> []");
addSample(file, { at: 100, used: 0.1 });
addSample(file, { at: 200, used: 0.3 });
addSample(file, { at: 300, used: 0.2 });
fs.appendFileSync(file, "{broken\n");
assert.deepEqual(readSamples(file), [{ at: 100, used: 0.1 }, { at: 200, used: 0.3 }, { at: 300, used: 0.2 }]);
assert.deepEqual(readSamples(file, 200).map((s) => s.at), [200, 300]);
assert.equal(readSamples(file).length, 3, "sinceAt omitted reads all");

// The file keeps at most 2000 lines, newest kept.
const many = path.join(dir, "many.jsonl");
for (let i = 0; i < 2005; i++) addSample(many, { at: i, used: 0 });
const kept = readSamples(many);
assert.equal(kept.length, 2000);
assert.equal(kept[0].at, 5, "oldest five evicted");
assert.equal(kept[1999].at, 2004);

// handoffReturns: buckets, accepted-only tokens, best-first order.
const jobs = [
  { id: 1, agent: "devin", files: ["a"], tokens: 100000, verdict: "accept" },
  { id: 2, agent: "devin", files: ["a", "b"], tokens: 50000, verdict: "send-back" },
  { id: 3, agent: "devin", files: ["a"], tokens: { n: 30000 }, verdict: "accept" },
  { id: 4, agent: "grok", files: [], tokens: 20000, verdict: "accept" },
  { id: 5, agent: "grok", files: ["a", "b", "c", "d"], tokens: 80000, verdict: "accept" },
  { id: 6, agent: "grok", files: ["a", "b", "c"], tokens: 999999, verdict: "review" },
  { id: 7, agent: "codex", files: ["a"], verdict: "accept" },
];
const groups = handoffReturns(jobs);
assert.deepEqual(groups.map((g) => g.key), ["grok, read-only", "devin, 1 file", "grok, 4+ files", "codex, 1 file", "devin, 2-3 files", "grok, 2-3 files"],
  "sorted by tokens per accepted job, unknown-token groups last");
const devin = groups.find((g) => g.key === "devin, 1 file");
assert.deepEqual({ jobs: devin.jobs, tokens: devin.tokens, accepted: devin.accepted, perJob: devin.perJob },
  { jobs: 2, tokens: 130000, accepted: 2, perJob: 65000 }, "{n} tokens count; send-back lands in its own bucket");
const grokSmall = groups.find((g) => g.key === "grok, 2-3 files");
assert.equal(grokSmall.accepted, 0);
assert.equal(grokSmall.tokens, 0, "non-accepted jobs never count toward tokens");
assert.equal(grokSmall.perJob, null);
const codex = groups.find((g) => g.key === "codex, 1 file");
assert.equal(codex.accepted, 1);
assert.equal(codex.tokens, 0);
assert.equal(codex.perJob, null, "accepted jobs that never reported tokens are not 'free'");

// bestReturnLesson: needs 3+ accepted jobs overall, names the best group.
assert.equal(bestReturnLesson(jobs.slice(0, 3)), "", "2 accepted -> no lesson");
const lesson = bestReturnLesson(jobs);
assert.ok(lesson.includes("grok, read-only"), lesson);
assert.ok(lesson.includes("20K"), lesson);
assert.ok(lesson.includes("per accepted job"), lesson);
assert.equal(typeof lesson, "string");
assert.equal(bestReturnLesson([]), "");

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
console.log("constance-leverage: tests passed");
