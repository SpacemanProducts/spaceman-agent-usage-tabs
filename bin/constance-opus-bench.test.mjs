// constance-opus-bench.mjs: the fake goal runs to the end on this checkout, every
// brain run is a fresh session (no --resume), the work is the same as in the old
// mode (one job per item, all accepted), and her context stays small.
import assert from "node:assert/strict";
import { runBench, tokens } from "./constance-opus-bench.mjs";

assert.equal(tokens(0), 0); assert.equal(tokens(1), 1); assert.equal(tokens(8), 2); assert.equal(tokens(9), 3);

const r = await runBench({ items: 4 });
assert.equal(r.jobs, 4, "one job per item: " + JSON.stringify(r));
assert.equal(r.accepted, 4, "all accepted");
assert.equal(r.resumes, 0, "no session is ever resumed");
assert.equal(r.sessions, r.brainRuns, "every brain run is its own session");
assert.equal(r.kinds[0], "plan", "a planning step first");
assert.ok(r.kinds.includes("review"), "then review steps: " + r.kinds);
assert.ok(r.kinds.every((k) => k === "plan" || k === "review"));
assert.ok(r.turns >= 4 * 2, "a delegate and a review per item at least");
assert.ok(r.inputTokens > 0 && r.peakTokens > 0 && r.peakTokens * r.brainRuns >= r.perRun[0].peakTokens);
// No step's context grows with the goal: each one starts from the short handoff.
assert.ok(r.peakTokens < 6000, "her largest context stays small: " + r.peakTokens);
console.log("constance-opus-bench: tests passed");
