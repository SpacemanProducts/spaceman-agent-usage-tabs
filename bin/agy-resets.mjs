// Corroborates a "surprise" Antigravity reset against agyresets.com, a free
// public tracker (not affiliated with Google) of reset announcements made by the
// Antigravity team on X. Used ONLY to decide the wording: with a matching
// announcement the message may say everyone was reset; otherwise it only says
// this meter reset early. The lookup runs only when a surprise was detected, sends
// nothing about the user, and any failure just means "not confirmed".
// Data from https://agyresets.com/ (please keep this credit).
export const API = "https://agyresets.com/api/v1/resets";
export const WINDOW_BEFORE_MS = 12 * 3600 * 1000;   // an announcement up to 12 h before we noticed
export const WINDOW_AFTER_MS = 30 * 60 * 1000;      // or just after (announced as the reset lands)

export async function fetchResets({ now = Date.now(), fetchFn = fetch, url = process.env.AGY_RESETS_URL || API, timeoutMs = 6000 } = {}) {
  try {
    const from = new Date(now - WINDOW_BEFORE_MS - 3600e3).toISOString();
    const res = await fetchFn(`${url}?limit=10&from=${encodeURIComponent(from)}`, {
      headers: { Accept: "application/json", "User-Agent": "agent-usage-tabs" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body?.data) ? body.data : [];
  } catch { return []; }
}

// The tokens a meter title speaks to: "Gemini Session" -> gemini; "Claude/GPT Weekly" -> claude, gpt.
const familyTokens = (title) => String(title || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !["session", "weekly", "monthly", "limit"].includes(t));

// Returns the announcement that backs up this surprise, or null. `details` is the
// classifier's list; `plan` is the agent's plan label (e.g. "Free").
export function corroborate(resets, details, detectedAt, plan = "") {
  const planKey = String(plan || "").toLowerCase();
  const early = (details || []).filter((d) => d && d.surprise);
  if (!early.length) return null;
  const tokens = new Set(early.flatMap((d) => familyTokens(d.title)));
  for (const r of Array.isArray(resets) ? resets : []) {
    const at = Date.parse(r?.announced_at || "");
    if (!Number.isFinite(at) || at < detectedAt - WINDOW_BEFORE_MS || at > detectedAt + WINDOW_AFTER_MS) continue;
    const plans = (r.plans || []).map((p) => String(p).toLowerCase());
    if (plans.length && !plans.includes("all") && !(planKey && plans.includes(planKey))) continue;
    const models = (r.models || []).map((m) => String(m).toLowerCase());
    if (!models.length || models.includes("all") || models.some((m) => tokens.has(m))) return r;
  }
  return null;
}
