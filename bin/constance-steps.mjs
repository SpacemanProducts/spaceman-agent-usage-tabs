// Constance's brain in steps: what the driver does next, and the prompt a step gets.
//
// Before 1.55.0 a goal was one long Claude Code session (`--session-id`, then
// `--resume` after every restart, pause and nudge) that delegated, sat in
// `C wait`, reviewed and planned again, so every job report and diff she read
// stayed in her context until the goal ended. Now the driver does the waiting
// (no brain runs while workers work) and starts a FRESH session for each
// planning step and each review batch. A step reads only .constance/handoff.md,
// her lessons and what the step needs (a review batch's reports), does the step,
// records what the next session must know (`C handoff ...`) and exits.
//
// nextStep() is pure: the driver hands it the goal's open work and gets one of
//   { action: "done", why }                nothing open (or practice/owner ends it)
//   { action: "review", jobs: [ids] }      a review batch is due
//   { action: "wait", why }                jobs are in flight; no brain session
//   { action: "plan" }                     open items and nothing in flight
// A step started when the last clean step moved nothing (same progress mark)
// carries `nudge: true`; past MAX_NUDGES of those the goal ends, as before.

export const MAX_NUDGES = 3;
export const REVIEW_BATCH = 3;              // this many waiting reviews start a batch at once
export const REVIEW_WAIT_MS = 10 * 60e3;    // else the oldest waits at most this long while others run

// A fingerprint of progress: anything that moves the goal between two steps
// (a new job, a job finishing, a review, a ticked item).
export function progressMark({ jobs = [], items = [] }) {
  const finished = jobs.filter((j) => j.finishedAt).length;
  const reviewed = jobs.filter((j) => j.reviewedAt).length;
  const done = items.filter((i) => i.state === "done").length;
  return `${jobs.length}/${finished}/${reviewed}/${done}`;
}

// openItems: checklist items not done. inFlight: jobs running/held/waiting or a
// finished one still being checked (settling/self-merging). reviewable: finished
// or self-merged jobs ready for her review, each with finishedAt. lastMark is
// the mark when the last cleanly ended step started (null when there is none).
// lastUnclean: the last step was cut off (a crash, restart, limit pause or failed run).
export function nextStep({ openItems = [], inFlight = [], reviewable = [], practice = false, needsOwner = false, stepsDone = 0,
  nudges = 0, lastMark = null, mark = null, lastUnclean = false, now = Date.now(), batch = REVIEW_BATCH, waitMs = REVIEW_WAIT_MS } = {}) {
  // Practice is one dry-run planning step, and an owner flag ends the goal after the step that raised it.
  if (stepsDone > 0 && (practice || needsOwner)) return { action: "done", why: practice ? "practice run" : "needs the owner" };
  if (!openItems.length && !inFlight.length && !reviewable.length) return stepsDone > 0 ? { action: "done", why: "nothing open" } : { action: "plan" };
  const stalled = stepsDone > 0 && lastMark !== null && mark !== null && lastMark === mark;
  const nudge = stalled ? { nudge: true } : {};
  if (reviewable.length) {
    const oldest = Math.min(...reviewable.map((j) => Number(j.finishedAt) || now));
    if (!inFlight.length || reviewable.length >= batch || now - oldest >= waitMs) {
      if (stalled && nudges >= MAX_NUDGES) return { action: "done", why: "no progress after the nudges" };
      const ids = reviewable.slice().sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0) || a.id - b.id).slice(0, Math.max(batch * 2, 6)).map((j) => j.id);
      return { action: "review", jobs: ids, ...nudge };
    }
  }
  // A cut-off step never finished handing work out: items with no job at all get
  // a planning step now, not after the running jobs come back. (A clean planning
  // step may hold an item back on purpose, so that waits.)
  if (lastUnclean && openItems.some((i) => i.state === "todo" && !(i.jobs || []).length)) return { action: "plan" };
  if (inFlight.length) return { action: "wait", why: `${inFlight.length} job${inFlight.length === 1 ? "" : "s"} in flight` };
  // An item held up by a merge conflict is the owner's to untangle: another
  // planning session can't fix it, so when only those are left the goal ends
  // (afterGoal() reports the conflict to the owner).
  if (stepsDone > 0 && openItems.every((i) => i.state === "problem")) return { action: "done", why: "only merge-conflict items are left" };
  if (stalled && nudges >= MAX_NUDGES) return { action: "done", why: "no progress after the nudges" };
  return { action: "plan", ...nudge };
}

// How the last step ended, as the next session is told it ("" = cleanly).
export function resumedFrom(step) {
  if (!step) return "";
  if (!step.endedAt) return `an interrupted session (step ${step.n}, ${step.kind}: a restart or a crash)`;
  if (!step.outcome || step.outcome === "ok") return "";
  return `step ${step.n} (${step.kind}), which ended: ${step.outcome}`;
}

// The step's first (and only) message. `handoff` is the rendered file's text.
export function stepPrompt({ kind, dir = "", handoff, handoffPath = "", lessons = "", milk = "", rules = "", batch = [], resumed = "", nudge = "", ownerGoal = "" }) {
  const P = [];
  if (kind === "review") P.push(`Step: review. Review these ${batch.length} finished job${batch.length === 1 ? "" : "s"}, then end your turn.`);
  else P.push("Step: plan. Plan the next moves for the goal from the handoff below, delegate everything that can start now, then end your turn.");
  if (dir) P.push(`Project folder: ${dir}`);
  P.push("You are a fresh session: the handoff file is everything you know about this goal. Don't run `C wait`: the controller waits for the jobs and starts a fresh session to review them.");
  if (resumed) P.push(`Picking up after ${resumed}. Everything done before is already in the handoff and the board; carry on from there.`);
  if (nudge) P.push(nudge);
  // The goal's first planning step gets the owner's words verbatim (the handoff
  // shows them as a clipped checklist); later steps work from the handoff.
  if (ownerGoal) P.push("", "Goal from the owner, verbatim:", String(ownerGoal).trimEnd(), "=== end of goal ===");
  P.push("", `=== ${handoffPath || ".constance/handoff.md"} ===`, String(handoff || "").trimEnd(), "=== end of handoff ===");
  if (kind === "review") {
    P.push("", "Jobs to review (oldest finish first). For each: check its report against the goal; read the full diff yourself only when the change is risky or the report doesn't add up; compare with any job listed under checkAgainst. Fix small problems yourself or send it back with a new delegate (`--again ID`). Then `C review ID accept|send-back --note \"...\"`.");
    for (const j of batch) P.push("", JSON.stringify(j));
  }
  P.push("", "Before you end: record what the next session must know — `C handoff decide \"...\"` for each decision you made, `C handoff problem \"...\"` for anything unresolved (`C handoff solved N` when one is fixed), and `C handoff next \"...\"` for notes to the next session. One line each. If the goal is finished (every item ticked, no open jobs), end with the short plain report for the owner.");
  return P.join("\n") + lessons + (milk ? "\n" + milk : "") + rules;
}
