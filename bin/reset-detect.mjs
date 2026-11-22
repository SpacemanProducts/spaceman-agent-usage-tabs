// A "reset" is a session, weekly, daily or monthly meter that fell by more than 50 points
// between two refreshes. Returns the titles of the meters that reset.
// Which meters can reset: the 5-hour session and weekly windows, plus any agent's
// daily or monthly meter.
export const WATCHED = /session|weekly|daily|monthly/i;

// The window a meter title names ("Claude/GPT Weekly" -> weekly), or "" if none.
export function windowKind(title) {
  const t = String(title ?? "").toLowerCase();
  for (const k of ["session", "weekly", "monthly", "daily"]) if (t.includes(k)) return k;
  return "";
}
// The distinct windows among some meter titles, smallest first.
export function windowKinds(titles) {
  const found = new Set((Array.isArray(titles) ? titles : []).map(windowKind).filter(Boolean));
  return ["session", "daily", "weekly", "monthly"].filter((k) => found.has(k));
}
// "weekly", "session and weekly", or "limit" when no title names a window.
export function windowPhrase(titles) {
  const k = windowKinds(titles);
  return k.length > 1 ? `${k.slice(0, -1).join(", ")} and ${k[k.length - 1]}` : (k[0] || "limit");
}
// How big the celebration is: the bigger the window, the bigger the win. A session
// (or daily) reset is the baseline, a weekly one a bit bigger, a monthly one bigger still.
export function magnitudeOf(titles) {
  const k = windowKinds(titles);
  return k.includes("monthly") ? 1.5 : k.includes("weekly") ? 1.25 : 1;
}
export function detectResets(prevLimits, nextLimits, minDrop = 0.5) {
  const prev = new Map((Array.isArray(prevLimits) ? prevLimits : []).map((l) => [l?.title, l?.percent]));
  const out = [];
  for (const l of Array.isArray(nextLimits) ? nextLimits : []) {
    if (!WATCHED.test(`${l?.title ?? ""} ${l?.window ?? ""}`)) continue;
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
    if (!WATCHED.test(`${l?.title ?? ""} ${l?.window ?? ""}`)) continue;
    const before = prev.get(l.title);
    if (typeof before?.percent !== "number" || typeof l.percent !== "number") continue;
    if (before.percent - l.percent <= minDrop) continue;
    const due = Date.parse(before.resetsAt || "");
    const surprise = Number.isFinite(due) && due - now > toleranceMs;
    out.push({ title: l.title, surprise, dueAt: surprise ? new Date(due).toISOString() : "" });
  }
  return out;
}
