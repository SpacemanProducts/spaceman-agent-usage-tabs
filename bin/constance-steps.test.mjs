// constance-steps.mjs: when the driver plans, reviews, waits or ends the goal,
// the nudge rule, how an unclean step is described, and the step prompt.
import assert from "node:assert/strict";
import { nextStep, progressMark, resumedFrom, stepPrompt, MAX_NUDGES, REVIEW_BATCH, REVIEW_WAIT_MS } from "./constance-steps.mjs";

const item = (n, state = "todo") => ({ n, text: `item ${n}`, state, jobs: [] });
const now = 1_000_000_000;

// The first step is always planning, whatever is open.
assert.deepEqual(nextStep({ openItems: [item(1)], stepsDone: 0 }), { action: "plan" });
assert.deepEqual(nextStep({ stepsDone: 0 }), { action: "plan" }, "even an empty goal gets one planning step");
// Nothing open after a step: done.
assert.equal(nextStep({ stepsDone: 1 }).action, "done");
// Practice is one dry-run planning step; an owner flag ends the goal after its step.
assert.deepEqual(nextStep({ openItems: [item(1)], stepsDone: 1, practice: true }), { action: "done", why: "practice run" });
assert.equal(nextStep({ openItems: [item(1)], stepsDone: 0, practice: true }).action, "plan");
assert.deepEqual(nextStep({ openItems: [item(1)], stepsDone: 1, needsOwner: true }), { action: "done", why: "needs the owner" });

// Jobs in flight and nothing to review: wait, with no brain session at all.
assert.deepEqual(nextStep({ openItems: [item(1)], inFlight: [{ id: 1 }, { id: 2 }], stepsDone: 1, now }), { action: "wait", why: "2 jobs in flight" });
// One finished job while others run: it waits for a batch...
const fin = (id, ago = 0) => ({ id, finishedAt: now - ago });
assert.equal(nextStep({ openItems: [item(1)], inFlight: [{ id: 2 }], reviewable: [fin(1, 1000)], stepsDone: 1, now }).action, "wait");
// ...until REVIEW_BATCH are waiting,
assert.deepEqual(nextStep({ openItems: [item(1)], inFlight: [{ id: 9 }], reviewable: [fin(3, 10), fin(1, 30), fin(2, 20)], stepsDone: 1, now }),
  { action: "review", jobs: [1, 2, 3] }, "a full batch goes at once, oldest finish first");
assert.equal(REVIEW_BATCH, 3);
// ...or the oldest has waited REVIEW_WAIT_MS (a free slot shouldn't idle for long),
assert.deepEqual(nextStep({ openItems: [item(1)], inFlight: [{ id: 2 }], reviewable: [fin(1, REVIEW_WAIT_MS)], stepsDone: 1, now }), { action: "review", jobs: [1] });
assert.equal(nextStep({ openItems: [item(1)], inFlight: [{ id: 2 }], reviewable: [fin(1, 5000)], stepsDone: 1, now, waitMs: 4000 }).action, "review", "the wait is tunable");
// ...or nothing else is running.
assert.deepEqual(nextStep({ openItems: [], reviewable: [fin(5)], stepsDone: 1, now }), { action: "review", jobs: [5] });
// A batch is capped so one session never gets a pile.
assert.equal(nextStep({ reviewable: Array.from({ length: 20 }, (_, i) => fin(i + 1, 100 - i)), stepsDone: 1, now }).jobs.length, 6);

// Open items, nothing running or waiting for review: plan again.
assert.deepEqual(nextStep({ openItems: [item(2)], stepsDone: 2, lastMark: "1/1/1/1", mark: "2/2/2/1" }), { action: "plan" });
// Only merge-conflict items left: the owner's to untangle, so the goal ends.
assert.deepEqual(nextStep({ openItems: [item(1, "problem")], stepsDone: 2, lastMark: "a", mark: "b" }), { action: "done", why: "only merge-conflict items are left" });
assert.equal(nextStep({ openItems: [item(1, "problem"), item(2)], stepsDone: 2, lastMark: "a", mark: "b" }).action, "plan", "other open work still gets planned");

// The nudge: a step that moved nothing (same mark) makes the next step a nudge, up to MAX_NUDGES.
assert.equal(MAX_NUDGES, 3);
for (let n = 0; n < MAX_NUDGES; n++) assert.deepEqual(nextStep({ openItems: [item(1)], stepsDone: n + 1, nudges: n, lastMark: "0/0/0/0", mark: "0/0/0/0" }), { action: "plan", nudge: true });
assert.deepEqual(nextStep({ openItems: [item(1)], stepsDone: 4, nudges: 3, lastMark: "0/0/0/0", mark: "0/0/0/0" }), { action: "done", why: "no progress after the nudges" });
// A review step that reviewed nothing can't loop forever either.
assert.deepEqual(nextStep({ reviewable: [fin(1)], stepsDone: 2, nudges: 1, lastMark: "1/1/0/0", mark: "1/1/0/0", now }), { action: "review", jobs: [1], nudge: true });
assert.equal(nextStep({ reviewable: [fin(1)], stepsDone: 5, nudges: 3, lastMark: "1/1/0/0", mark: "1/1/0/0", now }).action, "done");
// No mark for the last step (it ended unclean): never a stall.
assert.deepEqual(nextStep({ openItems: [item(1)], stepsDone: 1, nudges: 3, lastMark: null, mark: "0/0/0/0" }), { action: "plan" });
// A cut-off step: items with no job get planned now, even while others run;
// after a clean step they wait (she may have held them back on purpose).
const ij = (n, jobs) => ({ ...item(n), jobs });
assert.deepEqual(nextStep({ openItems: [{ ...ij(1, [7]), state: "working" }, ij(2, [])], inFlight: [{ id: 7 }], stepsDone: 0, lastUnclean: true }), { action: "plan" });
assert.equal(nextStep({ openItems: [{ ...ij(1, [7]), state: "working" }, ij(2, [])], inFlight: [{ id: 7 }], stepsDone: 1, lastUnclean: false }).action, "wait");
assert.equal(nextStep({ openItems: [{ ...ij(1, [7]), state: "working" }], inFlight: [{ id: 7 }], stepsDone: 0, lastUnclean: true }).action, "wait", "nothing unassigned: wait");
// Waiting on jobs is never a nudge.
assert.equal(nextStep({ openItems: [item(1)], inFlight: [{ id: 1 }], stepsDone: 1, nudges: 3, lastMark: "x", mark: "x" }).action, "wait");

// progressMark moves on a new job, a finish, a review and a tick.
const base = progressMark({ jobs: [{ id: 1 }], items: [item(1)] });
assert.notEqual(progressMark({ jobs: [{ id: 1 }, { id: 2 }], items: [item(1)] }), base);
assert.notEqual(progressMark({ jobs: [{ id: 1, finishedAt: 5 }], items: [item(1)] }), base);
assert.notEqual(progressMark({ jobs: [{ id: 1, finishedAt: 5, reviewedAt: 6 }], items: [item(1)] }), progressMark({ jobs: [{ id: 1, finishedAt: 5 }], items: [item(1)] }));
assert.notEqual(progressMark({ jobs: [{ id: 1 }], items: [item(1, "done")] }), base);

// How the last step ended, as the fresh session is told it.
assert.equal(resumedFrom(null), "");
assert.equal(resumedFrom({ n: 2, kind: "plan", endedAt: 5, outcome: "ok" }), "");
assert.match(resumedFrom({ n: 2, kind: "review" }), /interrupted session \(step 2, review: a restart or a crash\)/);
assert.equal(resumedFrom({ n: 3, kind: "plan", endedAt: 5, outcome: "her limit wall" }), "step 3 (plan), which ended: her limit wall");

// The prompt: the handoff in full, the step's own task, no `C wait`, the lessons, nothing else.
const ho = "# Handoff: ship it\n## Checklist\n- [ ] 1. ship it — todo\n";
const plan = stepPrompt({ kind: "plan", dir: "/p", handoff: ho, handoffPath: "/p/.constance/handoff.md", lessons: "\nLessons from your earlier goals:\n- one", milk: "Milk Opus: 25", rules: "\nRules for this project:\nx" });
assert.match(plan, /^Step: plan\./);
assert.match(plan, /Project folder: \/p/);
assert.match(plan, /=== \/p\/\.constance\/handoff\.md ===\n# Handoff: ship it\n## Checklist\n- \[ \] 1\. ship it — todo\n=== end of handoff ===/);
assert.match(plan, /Don't run `C wait`/);
assert.match(plan, /C handoff decide/); assert.match(plan, /C handoff next/);
assert.match(plan, /Lessons from your earlier goals:\n- one\nMilk Opus: 25\nRules for this project:\nx$/);
assert.ok(!/Picking up after/.test(plan));
const rev = stepPrompt({ kind: "review", handoff: ho, batch: [{ id: 4, summary: "added b" }, { id: 5, summary: "added c" }], resumed: "step 2 (review), which ended: her limit wall", nudge: "The goal is not finished: x." });
assert.match(rev, /^Step: review\. Review these 2 finished jobs/);
assert.match(rev, /Picking up after step 2 \(review\), which ended: her limit wall\./);
assert.match(rev, /The goal is not finished: x\./);
assert.match(rev, /\{"id":4,"summary":"added b"\}\n\n\{"id":5,"summary":"added c"\}/, "each job's packet rides along");
assert.match(rev, /C review ID accept\|send-back/);
assert.match(stepPrompt({ kind: "review", handoff: ho, batch: [{ id: 1 }] }), /Review these 1 finished job,/);
// The goal's first planning step carries the owner's words verbatim; other steps don't.
const g1 = stepPrompt({ kind: "plan", handoff: ho, ownerGoal: "1. a \"q\" $x\n2. b\n" });
assert.ok(g1.includes("Goal from the owner, verbatim:\n1. a \"q\" $x\n2. b\n=== end of goal ==="), g1);
assert.ok(g1.indexOf("end of goal") < g1.indexOf("=== end of handoff"), "the goal comes before the handoff");
assert.ok(!plan.includes("Goal from the owner"), "no verbatim goal unless asked");
console.log("constance-steps: tests passed");
