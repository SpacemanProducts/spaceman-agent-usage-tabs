// What the panel's moving parts read: the goal's stage bar and the Rev Meter. Pure functions, and
// every movement comes from something that happened (or, while preparing, from how long preparing has
// really taken before).
//
//   preparing  red     the goal is in, nothing handed out or listed yet
//   checklist  yellow  items are being worked
//   review     green   every item is done or every job is back; she is checking and reporting
//   done       green
export const STAGES = ["preparing", "checklist", "review", "done"];
export const STAGE_HUE = { preparing: 0, checklist: 55, review: 120, done: 120 };
// Where each stage starts and ends on the whole bar.
const SPAN = { preparing: [0, 0.2], checklist: [0.2, 0.85], review: [0.85, 0.99], done: [1, 1] };
export const DEFAULT_PREP_MS = 4 * 60e3;

const median = (list) => { const s = [...list].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };

// `items` = the checklist (constance-checklist.mjs: [{ state: done|working|review|problem|todo }])
// when there is one; otherwise the goal's jobs are the checklist.
// `steps` = how many things she has logged for this goal (each one nudges the preparing bar).
export function stageProgress({ goal, items = [], jobs = [], steps = 0, prepHistory = [], now = Date.now() } = {}) {
  if (!goal) return null;
  const mine = jobs.filter((j) => j.goal === goal.id);
  const list = items.length ? items.map((i) => ({ done: i.state === "done", back: i.state === "review" })) : mine.map((j) => ({ done: ["accepted", "sent back", "stopped"].includes(j.status), back: j.status === "finished" }));
  const estimate = median(prepHistory.filter((n) => n > 0).slice(-10)) || DEFAULT_PREP_MS;
  const done = list.filter((i) => i.done).length;
  const allBack = list.length > 0 && list.every((i) => i.done || i.back);
  let stage, fraction, etaMs = null;
  if (goal.status === "done") { stage = "done"; fraction = 1; }
  else if (!list.length) {
    stage = "preparing";
    const spent = Math.max(0, now - goal.startedAt);
    // Time moves it toward the usual length, slowing as it goes so it never claims to be finished;
    // each real step adds a visible notch.
    const byTime = 1 - Math.exp(-1.6 * spent / estimate);
    fraction = Math.min(0.97, byTime * 0.85 + Math.min(steps, 8) * 0.015);
    etaMs = prepHistory.length ? Math.max(0, estimate - spent) : null;
  } else if (allBack) { stage = "review"; fraction = done / list.length; }
  else { stage = "checklist"; fraction = list.reduce((n, i) => n + (i.done ? 1 : i.back ? 0.7 : 0), 0) / list.length; }
  const [from, to] = SPAN[stage];
  const label = stage === "preparing" ? (etaMs ? `Preparing · about ${Math.max(1, Math.ceil(etaMs / 60e3))} min left` : "Preparing")
    : stage === "checklist" ? `Checklist · ${done} of ${list.length} done` : stage === "review" ? `In review · ${done} of ${list.length} checked` : "Done";
  return { stage, hue: STAGE_HUE[stage], fraction, overall: from + (to - from) * fraction, label, etaMs,
    // Moving only while she really is: a paused or stopped goal sits still.
    active: goal.status === "running" };
}

// The Rev Meter: how well she is cooking.
//   needle  0..1 busy lanes (workers and lead lanes running against the slots open to them)
//   score   `perPct` (free-agent tokens per 1% of the lead's session, constance-leverage.mjs)
//           against the target; null when it can't be measured
//   share   the lead's measured share of this goal's tokens (the slider's underline), or null
export const TARGET_PER_PCT = 5e6;
const known = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
export function revMeter({ running = 0, lanes = 0, slots = 0, perPct = null, workerTokens = null, leadTokens = null } = {}) {
  const busy = running + lanes;
  const needle = slots > 0 ? Math.min(1, busy / slots) : busy > 0 ? 1 : 0;
  const score = known(perPct) ? perPct / TARGET_PER_PCT : null;
  const share = known(leadTokens) && known(workerTokens) && leadTokens + workerTokens > 0 ? leadTokens / (leadTokens + workerTokens) : null;
  const grade = busy === 0 ? "idle" : needle >= 0.85 && (score === null || score >= 1) ? "redline" : needle >= 0.4 || score >= 1 ? "cooking" : "warming up";
  return { needle, busy, slots, score, share, grade };
}
