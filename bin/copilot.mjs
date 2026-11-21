#!/usr/bin/env node
// Copilot's monthly allowance from GitHub's quota endpoint (the one the
// editor plugins use), asked with the token `gh auth token` prints. Prints
// {limits, plan, status}. A meter appears only when the account has a limited
// allowance (entitlement > 0); otherwise one status line gives the reset date.
import { spawnSync } from "node:child_process";
import os from "node:os";

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const num = (v) => { if (typeof v === "boolean" || v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const PLANS = { individual: "Pro", individual_pro: "Pro+", business: "Business", enterprise: "Enterprise", free: "Free" };
const fmtDate = (iso) => { const d = new Date(iso); return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }); };

export function parseCopilotQuota(payload) {
  const plan = PLANS[String(payload?.copilot_plan || "").toLowerCase()] || "";
  const snap = payload?.quota_snapshots?.premium_interactions;
  if (!snap || typeof snap !== "object") return { limits: [], plan, free: /free/i.test(String(payload?.copilot_plan || "")), status: "" };
  const resetsAt = (() => { const d = new Date(payload.quota_reset_date_utc || ""); return isNaN(d.getTime()) ? "" : d.toISOString(); })();
  if (snap.unlimited === true) return { limits: [], plan, status: "Unlimited premium requests on this plan." };
  const entitlement = num(snap.entitlement);
  if (entitlement === null) return { limits: [], plan, status: "" };
  const free = /free/i.test(String(payload?.copilot_plan || ""));
  const creditsUsed = num(snap.credits_used);
  if (entitlement <= 0) {
    // No included allowance means nothing to meter; usage past it would be paid,
    // which this panel doesn't show. Only the plan's reset date is shown.
    const d = new Date(resetsAt);
    const when = isNaN(d.getTime()) ? "" : ` · resets ${fmtDate(resetsAt)}, 00:00 UTC`;
    return { limits: [], plan, free, status: `No included allowance on this plan${when}` };
  }
  let used = num(snap.credits_used);
  if (used === null) {
    const remaining = num(snap.remaining) ?? num(snap.quota_remaining);
    const pctLeft = num(snap.percent_remaining);
    used = remaining !== null ? Math.max(0, entitlement - remaining) : pctLeft !== null ? entitlement * Math.max(0, 100 - pctLeft) / 100 : null;
  }
  if (used === null) return { limits: [], plan, status: "" };
  return { limits: [{ title: "Monthly", percent: clamp01(used / entitlement), resetsAt }], plan, free, status: "" };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const out = (o) => { process.stdout.write(JSON.stringify({ limits: [], plan: "", status: "", ...o }) + "\n"); process.exit(0); };
  const PATH = [process.env.PATH, `${os.homedir()}/.local/bin`, `${os.homedir()}/.local/share/mise/shims`, "/usr/bin"].filter(Boolean).join(":");
  const t = spawnSync("gh", ["auth", "token"], { encoding: "utf8", env: { ...process.env, PATH }, timeout: 8000 });
  const token = String(t.stdout || "").trim();
  if (!token) out({});
  try {
    const res = await fetch("https://api.github.com/copilot_internal/user", { headers: { Authorization: `token ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) out({});
    out(parseCopilotQuota(await res.json()));
  } catch { out({}); }
}
