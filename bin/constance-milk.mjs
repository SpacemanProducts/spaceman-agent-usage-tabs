// The "Milk Opus" slider (settings.json `constanceMilk`, 0..100): how much of the work
// Constance keeps for herself on the owner's paid plan versus hands to the free agents.
// Five labeled steps; values between steps snap to the nearest one.
//   0   Max delegation: the free agents do nearly everything; she only plans and checks.
//   25  Lean:           she also reads the reports closely and plans once up front.
//   50  Balanced:       she skims the diffs of risky files and re-checks the plan.
//   75  Thorough:       she reads every diff and re-plans each wave; may edit hard parts.
//   100 Max Opus:       she plans carefully, re-plans after each wave, reads every diff.
// Sandbox and guardrails are on at every setting — the slider never weakens them.
export const DEFAULT_MILK = 25;
export const MILK_LAST_LINE = "Sandbox and guardrails stay on at every setting.";

// The five slider steps, low to high. `description` is the one plain line the panel
// shows for the step; the policy fields (review depth, job size, planning, selfEdit)
// live in milkPolicy below, one distinct setting per step.
export const MILK_STEPS = [
  { name: "Max delegation", value: 0, description: "free agents do nearly everything; she only plans and checks reports" },
  { name: "Lean", value: 25, description: "she reads the reports closely and plans once up front" },
  { name: "Balanced", value: 50, description: "she skims the diffs of risky files and re-checks the plan between waves" },
  { name: "Thorough", value: 75, description: "she reads every diff, re-plans each wave and may edit the hard parts herself" },
  { name: "Max Opus", value: 100, description: "she plans carefully, re-plans after each wave and reads every diff" },
];

// The slider value from settings: an integer 0..100, DEFAULT_MILK when missing or not a
// number, clamped when out of range.
export function readMilk(settings) {
  const v = settings?.constanceMilk;
  // null, "", false and blank strings must fall back, not coerce to 0
  // (Max delegation) through Number().
  if (v === null || v === undefined || v === false || (typeof v === "string" && v.trim() === "")) return DEFAULT_MILK;
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_MILK;
  return Math.min(100, Math.max(0, Math.round(n)));
}

// The step a slider value belongs to: rounded, clamped, snapped to the nearest step
// (a tie goes to the lower step).
export function milkStep(v) {
  const n = Math.min(100, Math.max(0, Math.round(Number(v) || 0)));
  let best = MILK_STEPS[0];
  for (const s of MILK_STEPS) {
    if (Math.abs(s.value - n) < Math.abs(best.value - n)) best = s;
  }
  return best;
}

// Kept for the panel/status payload: the coarse three-band word the UI already shows.
const band = (v) => (v <= 33 ? "milk" : v <= 66 ? "balanced" : "quality");

// Per-step policy fields, same order as MILK_STEPS.
const REVIEW_DEPTHS = ["report", "report", "skim", "full", "full"];
const MAX_FILES = [6, 5, 4, 3, 2];
const PLANNING = [
  "one short plan, queue everything at once",
  "one plan up front, then let the queue run",
  "plan up front and re-check the plan once between waves",
  "plan each wave carefully and adjust the plan as results come in",
  "plan carefully and re-plan after each wave",
];

// The policy one slider value buys, snapped to its step. `step` is the step name;
// `band` stays the coarse milk/balanced/quality word for the existing panel. `reviewDepth`
// is how deep she reads a finished job: "report" = the agent's report and the diff stat
// only, open the diff only on a guard notice or a report that doesn't add up; "skim" =
// also read the diff of risky files; "full" = read every diff. `maxFilesPerTask` caps how
// many files one job may touch. `selfEdit` (Thorough and Max Opus only) lets her do the
// hard parts herself.
export function milkPolicy(v) {
  const step = milkStep(v);
  const i = MILK_STEPS.indexOf(step);
  return {
    value: step.value,
    step: step.name,
    band: band(step.value),
    reviewDepth: REVIEW_DEPTHS[i],
    maxFilesPerTask: MAX_FILES[i],
    planning: PLANNING[i],
    selfEdit: i >= 3,
    sandbox: true,
    guardrails: true,
  };
}

// A few short plain lines for her prompt describing that policy. Always ends with the
// sandbox/guardrails line so no setting can read as permission to drop them.
export function milkPrompt(v) {
  const p = milkPolicy(v);
  const lines = [
    `Milk Opus is at ${p.value} (${p.band}) · ${p.step}: ${p.reviewDepth === "report" ? "trust the free agents' reports and only open a diff when something doesn't add up" : p.reviewDepth === "skim" ? "skim the diffs of risky files" : "read every diff yourself"}.`,
    `Planning: ${p.planning}. Keep each job to at most ${p.maxFilesPerTask} files.`,
    p.selfEdit ? "You may do the hard parts yourself." : "Leave the editing to the free agents.",
    MILK_LAST_LINE,
  ];
  return lines.join("\n");
}
