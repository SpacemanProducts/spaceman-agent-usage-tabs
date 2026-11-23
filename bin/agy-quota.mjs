// Antigravity's quota reply -> one bar per pool and window. Google groups quota into POOLS (Gemini models; Claude and GPT
// models), each with its own buckets (a 5-hour session window, a weekly window). Every bucket Google reports becomes its
// own bar, titled "<pool> Session" or "<pool> Weekly"; nothing is merged and nothing is invented. A plan that has no
// bucket for a pool simply has no bar for it (a Free plan today reports only the Claude/GPT weekly bucket).
const clamp01 = (n) => Math.max(0, Math.min(1, n));

export const used = (b) => {
  if (!b || b.disabled === true) return null;
  const r = b.remainingFraction ?? b.remaining_fraction;
  if (r === undefined || r === null) return (b.resetTime || b.reset_time) ? 1 : null;
  const n = Number(r);
  return Number.isFinite(n) ? clamp01(1 - n) : null;
};
export const resetOf = (b) => { const d = new Date(b.resetTime || b.reset_time || ""); return isNaN(d.getTime()) ? "" : d.toISOString(); };
const isWeekly = (b) => /week/i.test(`${b.window || ""} ${b.bucketId || ""} ${b.displayName || ""}`);
export const poolLabel = (name) => { const n = String(name || "").trim(); return /gemini/i.test(n) ? "Gemini" : (/claude|gpt/i.test(n) ? "Claude/GPT" : n || "Other"); };

export function quotaGroups(q) {
  let groups = Array.isArray(q?.groups) ? q.groups.filter((g) => g && typeof g === "object") : [];
  if (!groups.length && Array.isArray(q?.buckets)) groups = [{ displayName: "Gemini", buckets: q.buckets }];
  return groups;
}

// What real accounts report (checked 2026-11-22):
//  - Free: only the Claude/GPT weekly bucket ("3p-weekly"); no Gemini limit.
//  - Ultra (a real paid account): the Claude/GPT weekly pool and no Gemini limit, both read correctly (verified).
//  - A 5-hour bucket on Pro or Ultra: NOT confirmed. None has been seen yet. If Google sends one, it is shown as
//    its own "<pool> Session" bar right before that pool's weekly bar; nothing here assumes it exists.
export function parseQuota(q) {
  const limits = [];
  for (const g of quotaGroups(q)) {
    const label = poolLabel(g.displayName);
    const rows = [];
    for (const b of Array.isArray(g.buckets) ? g.buckets : []) {
      const u = used(b); if (u === null) continue;
      rows.push({ title: `${label} ${isWeekly(b) ? "Weekly" : "Session"}`, percent: u, resetsAt: resetOf(b) });
    }
    // Non-Gemini pools are scoped allowances: shown once any of their windows is touched, then all of them
    // (a fresh 5-hour window still shows beside a used weekly one).
    if (label !== "Gemini" && !rows.some((r) => r.percent > 0)) continue;
    rows.sort((a, b) => a.title.endsWith("Weekly") - b.title.endsWith("Weekly"));   // Session, then Weekly
    limits.push(...rows);
  }
  return limits;
}
