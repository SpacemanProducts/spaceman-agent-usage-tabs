// The "Milk Opus" slider (settings.json `constanceMilk`, 0..100): how much of the work
// Constance keeps for herself on the owner's paid plan versus hands to the free agents.
//   0   milk:    the free agents do almost everything; she only plans and checks the report.
//   25  balanced: she also skims the diffs of risky files and plans once up front.
//   100 quality: she does the hard parts herself, reads every diff and re-plans each wave.
// Sandbox and guardrails are on at every setting — the slider never weakens them.
export const DEFAULT_MILK = 25;
export const MILK_LAST_LINE = "Sandbox and guardrails stay on at every setting.";

// The slider value from settings: an integer 0..100, DEFAULT_MILK when missing or not a
// number, clamped when out of range.
export function readMilk(settings) {
  const n = Number(settings?.constanceMilk);
  if (!Number.isFinite(n)) return DEFAULT_MILK;
  return Math.min(100, Math.max(0, Math.round(n)));
}

const band = (v) => (v <= 33 ? "milk" : v <= 66 ? "balanced" : "quality");

// The policy one slider value buys. `reviewDepth` is how deep she reads a finished job:
// "report" = the agent's report and the diff stat only, open the diff only on a guard
// notice or a report that doesn't add up; "skim" = also read the diff of risky files;
// "full" = read every diff. `maxFilesPerTask` caps how many files one job may touch.
export function milkPolicy(v) {
  const value = Math.min(100, Math.max(0, Math.round(Number(v) || 0)));
  const b = band(value);
  return {
    value,
    band: b,
    reviewDepth: b === "milk" ? "report" : b === "balanced" ? "skim" : "full",
    maxFilesPerTask: b === "milk" ? 6 : b === "balanced" ? 4 : 2,
    planning: b === "milk" ? "one short plan, queue everything at once"
      : b === "balanced" ? "plan up front, check the plan once"
      : "plan carefully and re-plan after each wave",
    selfEdit: b === "quality",
    sandbox: true,
    guardrails: true,
  };
}

// A few short plain lines for her prompt describing that policy. Always ends with the
// sandbox/guardrails line so no setting can read as permission to drop them.
export function milkPrompt(v) {
  const p = milkPolicy(v);
  const lines = [
    `Milk Opus is at ${p.value} (${p.band}): ${p.reviewDepth === "report" ? "trust the free agents' reports and only open a diff when something doesn't add up" : p.reviewDepth === "skim" ? "skim the diffs of risky files" : "read every diff yourself"}.`,
    `Planning: ${p.planning}. Keep each job to at most ${p.maxFilesPerTask} files.`,
    p.selfEdit ? "You may do the hard parts yourself." : "Leave the editing to the free agents.",
    MILK_LAST_LINE,
  ];
  return lines.join("\n");
}
