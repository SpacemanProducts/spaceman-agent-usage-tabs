// A "reset" is a session or weekly meter that fell by more than 50 points
// between two refreshes. Returns the titles of the meters that reset.
export const WATCHED = /session|weekly/i;
export function detectResets(prevLimits, nextLimits, minDrop = 0.5) {
  const prev = new Map((Array.isArray(prevLimits) ? prevLimits : []).map((l) => [l?.title, l?.percent]));
  const out = [];
  for (const l of Array.isArray(nextLimits) ? nextLimits : []) {
    if (!WATCHED.test(String(l?.title))) continue;
    const before = prev.get(l.title);
    if (typeof before !== "number" || typeof l.percent !== "number") continue;
    if (before - l.percent > minDrop) out.push(l.title);
  }
  return out;
}

// Like detectResets, but says whether each reset was SCHEDULED or a SURPRISE.
// A meter that fell by more than 50 points whose recorded reset time had not
// arrived yet (by more than `toleranceMs`, to forgive clock skew and rounding)
// was reset early. Without a readable previous reset time we can't tell, so it
// counts as scheduled: a surprise is only claimed with evidence.
export function classifyResets(prevLimits, nextLimits, now = Date.now(), { minDrop = 0.5, toleranceMs = 5 * 60 * 1000 } = {}) {
  const prev = new Map((Array.isArray(prevLimits) ? prevLimits : []).map((l) => [l?.title, l]));
  const out = [];
  for (const l of Array.isArray(nextLimits) ? nextLimits : []) {
    if (!WATCHED.test(String(l?.title))) continue;
    const before = prev.get(l.title);
    if (typeof before?.percent !== "number" || typeof l.percent !== "number") continue;
    if (before.percent - l.percent <= minDrop) continue;
    const due = Date.parse(before.resetsAt || "");
    const surprise = Number.isFinite(due) && due - now > toleranceMs;
    out.push({ title: l.title, surprise, dueAt: surprise ? new Date(due).toISOString() : "" });
  }
  return out;
}
