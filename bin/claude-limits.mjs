// Turns Anthropic's /api/oauth/usage payload into limit meters.
// Session and Weekly come from five_hour / seven_day. A Fable window is added
// ONLY when the payload's `limits` array carries a model-scoped entry for
// Fable (scope.model.display_name or id contains "fable"). Nothing is inferred:
// no entry, no Fable meter.
const clamp01 = (n) => Math.max(0, Math.min(1, n));
// null, "", booleans and non-numbers are "no value", never 0%.
const pct = (v) => {
  if (typeof v !== "number" && !(typeof v === "string" && v.trim() !== "")) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? clamp01(n / 100) : null;
};

function windowTitle(kind) {
  const t = String(kind || "").toLowerCase();
  if (t.includes("month")) return "Monthly";
  if (t.includes("week") || t.includes("day")) return "Weekly";
  if (t.includes("hour") || t.includes("session")) return "Session";
  return "";
}

export function parseClaudeLimits(payload) {
  const limits = [];
  for (const [key, title] of [["five_hour", "Session"], ["seven_day", "Weekly"]]) {
    const w = payload?.[key];
    const p = w ? pct(w.utilization) : null;
    if (p !== null) limits.push({ title, percent: p, resetsAt: w.resets_at || "" });
  }
  const seen = new Set();
  for (const e of Array.isArray(payload?.limits) ? payload.limits : []) {
    const model = e && e.scope && typeof e.scope === "object" ? e.scope.model : null;
    if (!model || typeof model !== "object") continue;
    const name = String(model.display_name || model.id || "").trim();
    if (!/fable/i.test(name)) continue;
    const p = pct(e.percent);
    if (p === null) continue;
    const window = windowTitle(e.kind);
    const title = `Fable${window ? " " + window : ""}`;
    if (seen.has(title)) continue;
    seen.add(title);
    limits.push({ title, percent: p, resetsAt: e.resets_at || "" });
  }
  return limits;
}

// Banked "limit resets", as Claude Code reads them from the `cedar_ember`
// block of the same usage payload. Returns null unless the account has the
// block, is eligible, and holds at least one unpaused grant with resets left.
export function parseClaudeResets(payload) {
  const b = payload?.cedar_ember;
  if (!b || typeof b !== "object" || b.eligible === false) return null;
  let left = 0, usableNow = false, expiresAt = "", expiresMs = Infinity;
  for (const g of Array.isArray(b.grants) ? b.grants : []) {
    const n = Number(g?.resets_left);
    if (!Number.isInteger(n) || n <= 0 || g.paused === true) continue;
    left += n;
    if (g.usable_now === true) usableNow = true;
    const ms = Date.parse(g.ends_at || "");
    if (Number.isFinite(ms) && ms < expiresMs) { expiresMs = ms; expiresAt = new Date(ms).toISOString(); }
  }
  return left > 0 ? { left, usableNow, expiresAt } : null;
}
