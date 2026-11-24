// Constance's own model fallback. She runs on the owner's Claude plan as Opus; when the plan doesn't
// allow the picked model, Claude Code exits non-zero with "There's an issue with the selected model …
// you may not have access to it" (checked 2026-11-23 on CLI 2.1.331). On that error she drops to the
// best model the plan does allow and says so in the log, instead of failing the goal. Other failures
// (network, limits, crashes) never match, so they can't downgrade her by accident.
export const MODELS = ["opus", "sonnet", "haiku"];

const REJECTED = /issue with the selected model|may not exist|not have access to it|invalid model|unrecognized_model|model\b[^\n]{0,60}\bnot (allowed|available|supported|enabled)/i;

export function modelRejected(report) {
  return REJECTED.test(String(report || ""));
}

// The next-best model after `used`, or null at the bottom of the list — and null whenever the report
// isn't a model rejection, so only a real "not on this plan" answer moves her down.
export function nextModel(used, report) {
  if (!modelRejected(report)) return null;
  const i = MODELS.indexOf(used);
  return i >= 0 ? MODELS[i + 1] || null : null;
}

export function modelName(m) {
  return m ? m[0].toUpperCase() + m.slice(1) : "Opus";
}
