// A window whose reset time has passed is reset: show 0% and clear any hit/red state right away,
// instead of keeping the old reading until the source reports again. Returns a new list; the
// panel does the same between refreshes (Panel.qml expireResets).
export const RESET_NOTE = "Reset, waiting for fresh data.";
export function expireResets(limits, nowMs = Date.now()) {
  return (limits || []).map((l) => {
    const t = Date.parse(l?.resetsAt || "");
    if (!Number.isFinite(t) || t > nowMs || !(Number(l.percent) > 0)) return l;
    const { hitAt, ...rest } = l;
    return { ...rest, percent: 0, resetsAt: "", note: RESET_NOTE };
  });
}
export const anyPassed = (limits, nowMs = Date.now()) => (limits || []).some((l) => { const t = Date.parse(l?.resetsAt || ""); return Number.isFinite(t) && t <= nowMs; });
