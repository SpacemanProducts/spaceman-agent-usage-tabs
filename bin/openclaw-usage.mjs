// OpenClaw's provider usage/quota windows, read from `openclaw status --usage --json` (a documented, read-only command:
// it asks the providers OpenClaw is signed in to). The reply has usage.providers[]: { provider, displayName, windows[], error? }.
// The field names INSIDE a window are not documented and no populated sample was available when this was written (the
// provider reported an error), so the parser accepts the plausible spellings and shows a bar only when a percent is
// really there. It never guesses.
import { spawnSync } from "node:child_process";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const firstNum = (o, keys) => { for (const k of keys) { const n = num(o?.[k]); if (n !== null) return n; } return null; };

export function usedFraction(w) {
  const usedPct = firstNum(w, ["usedPercent", "percentUsed", "used_percent", "usagePercent"]);
  if (usedPct !== null) return Math.max(0, Math.min(1, usedPct / 100));
  const leftPct = firstNum(w, ["remainingPercent", "percentLeft", "leftPercent", "remaining_percent", "percentRemaining"]);
  if (leftPct !== null) return Math.max(0, Math.min(1, 1 - leftPct / 100));
  const usedFrac = firstNum(w, ["usedFraction", "fractionUsed"]);
  if (usedFrac !== null) return Math.max(0, Math.min(1, usedFrac));
  const leftFrac = firstNum(w, ["remainingFraction", "fractionLeft"]);
  if (leftFrac !== null) return Math.max(0, Math.min(1, 1 - leftFrac));
  return null;
}
const resetOf = (w) => {
  for (const k of ["resetsAt", "resetAt", "resetTime", "reset", "resets_at"]) {
    const v = w?.[k]; if (v === undefined || v === null) continue;
    const t = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(String(v));
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return "";
};
const labelOf = (w) => {
  const raw = String(w?.label ?? w?.name ?? w?.window ?? w?.title ?? "").trim();
  if (/5\s*-?\s*h|session|hour/i.test(raw)) return "Session";
  if (/week|7\s*-?\s*d/i.test(raw)) return "Weekly";
  if (/month|30\s*-?\s*d/i.test(raw)) return "Monthly";
  if (/day|daily|24\s*-?\s*h/i.test(raw)) return "Daily";
  return raw || "Usage";
};

// -> { limits: [{ title, percent, resetsAt }], status }
export function parseUsage(json) {
  const providers = json?.usage?.providers;
  if (!Array.isArray(providers)) return { limits: [], status: "", failed: [] };
  const limits = [], failed = [];
  for (const p of providers) {
    const name = String(p?.displayName || p?.provider || "").trim() || "Provider";
    if (p?.error) failed.push(name);
    for (const w of Array.isArray(p?.windows) ? p.windows : []) {
      const percent = usedFraction(w);
      if (percent === null) continue;
      limits.push({ title: `${name} ${labelOf(w)}`, percent, resetsAt: resetOf(w) });
    }
  }
  // Nothing to say when there are no windows and nothing failed. A provider that really failed is named in `failed`.
  return { limits, status: "", failed };
}

export function readOpenclawUsage({ env = process.env, timeoutMs = 30000 } = {}) {
  const r = spawnSync("openclaw", ["status", "--usage", "--json"], { encoding: "utf8", env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  if (r.error || r.status !== 0) return { limits: [], status: "OpenClaw's usage command didn't answer.", failed: [] };
  const out = String(r.stdout || ""), i = out.indexOf("{");
  try { return parseUsage(JSON.parse(i >= 0 ? out.slice(i) : out)); } catch { return { limits: [], status: "OpenClaw's usage command gave unreadable output.", failed: [] }; }
}
