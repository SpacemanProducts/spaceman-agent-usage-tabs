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

export function parseQuota(q) {
  const limits = [];
  for (const g of quotaGroups(q)) {
    const label = poolLabel(g.displayName);
    for (const b of Array.isArray(g.buckets) ? g.buckets : []) {
      const u = used(b); if (u === null) continue;
      // Non-Gemini pools are scoped allowances: shown once touched.
      if (label !== "Gemini" && u === 0) continue;
      limits.push({ title: `${label} ${isWeekly(b) ? "Weekly" : "Session"}`, percent: u, resetsAt: resetOf(b) });
    }
  }
  return limits;
}
