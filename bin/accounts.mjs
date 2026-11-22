// Multiple accounts per agent, from Omarchy's own account list
// (`omarchy-agent-account-list --json`). Credentials are never read here, and
// emails/orgs/home paths are dropped: only label, plan, active flag and meters.
const clamp01 = (n) => Math.max(0, Math.min(1, n));

function titleFor(label) {
  const t = String(label || "").toLowerCase();
  if (/month|30-day|720h/.test(t)) return "Monthly";
  if (/week|7-day/.test(t)) return "Weekly";
  if (/session|5-hour|5h|hour/.test(t)) return "Session";
  return String(label || "Limit");
}

// list: parsed JSON, [{provider, accounts:[{id,label,plan,active,signedIn,limits}]}].
// Returns { provider: [account] } only for providers with 2+ signed-in accounts.
export function buildAccounts(list) {
  const out = {};
  for (const p of Array.isArray(list) ? list : []) {
    const signed = (Array.isArray(p?.accounts) ? p.accounts : []).filter((a) => a && a.signedIn);
    if (!p?.provider || signed.length < 2) continue;
    out[p.provider] = signed.map((a) => ({
      id: String(a.id),
      label: String(a.label || a.id),
      plan: String(a.plan || ""),
      active: !!a.active,
      limits: (a.limits || []).filter((l) => Number(l.percent) >= 0)
        .map((l) => ({ title: titleFor(l.label || l.title), percent: clamp01(Number(l.percent)), resetsAt: l.resetsAt || "" })),
    }));
  }
  return out;
}
