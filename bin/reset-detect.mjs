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
