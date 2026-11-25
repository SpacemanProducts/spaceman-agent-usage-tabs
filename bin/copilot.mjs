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

// The plan name. GitHub's `copilot_plan` says "individual" even for a FREE account; `access_type_sku` ("free_limited_copilot")
// is what tells them apart, so it decides.
const planOf = (payload) => {
  if (/free/i.test(String(payload?.access_type_sku || "")) || /free/i.test(String(payload?.copilot_plan || ""))) return "Free";
  return PLANS[String(payload?.copilot_plan || "").toLowerCase()] || "";
};

// A monthly meter for the chat or completions allowance (what the Free plan limits). Skipped when the plan has no limit on
// it (unlimited, no quota, zero entitlement). Uses the most precise figure the snapshot has.
// On token-based billing the entitlement is in AI credits (AIC, what Copilot's own status bar counts: 1 AIC = 1e9 nano-AIU
// in the session logs), so the note says how many of them are gone. GitHub's counters trail a finished session by a short while.
const credits = (n) => (Math.round(n * 10) / 10).toString();
function allowanceMeter(snap, title, note, resetsAt) {
  if (!snap || typeof snap !== "object" || snap.unlimited === true || snap.has_quota === false) return null;
  const ent = num(snap.entitlement);
  if (ent === null || ent <= 0) return null;
  const pctLeft = num(snap.percent_remaining), left = num(snap.quota_remaining) ?? num(snap.remaining), spent = num(snap.credits_used);
  const used = pctLeft !== null ? 1 - pctLeft / 100 : left !== null ? (ent - left) / ent : spent !== null ? spent / ent : null;
  if (used === null) return null;
  if (snap.token_based_billing === true && title === "Chat and agent requests") note = `${credits(left !== null ? ent - left : used * ent)} of ${credits(ent)} AI credits used. Shared plan quota`;
  return { title, note, window: "monthly", percent: clamp01(used), resetsAt };
}

export function parseCopilotQuota(payload) {
  const plan = planOf(payload);
  const free = plan === "Free";
  const resetsAt = (() => { const d = new Date(payload?.quota_reset_date_utc || ""); return isNaN(d.getTime()) ? "" : d.toISOString(); })();
  const snaps = payload?.quota_snapshots;
  // Only the chat/agent allowance: the completions meter is editor autocomplete, which the CLI never uses.
  const allowances = [allowanceMeter(snaps?.chat, "Chat and agent requests", "Shared plan quota", resetsAt)].filter(Boolean);
  const snap = snaps?.premium_interactions;
  if (!snap || typeof snap !== "object") return { limits: allowances, plan, free, status: "" };
  if (snap.unlimited === true) return { limits: allowances, plan, free, status: "Unlimited premium requests on this plan." };
  const entitlement = num(snap.entitlement);
  if (entitlement === null) return { limits: allowances, plan, free, status: "" };
  if (entitlement <= 0) {
    // No premium requests on this plan: nothing to meter there (anything past it would be paid, which this panel doesn't show).
    // The chat and completions allowances, when the plan limits them, are the meters; otherwise just the reset date.
    if (allowances.length) return { limits: allowances, plan, free, status: "" };
    const d = new Date(resetsAt);
    const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    const when = isNaN(d.getTime()) ? "" : ` · resets ${fmtDate(resetsAt)}, ${hhmm} UTC`;
    return { limits: [], plan, free, status: `No included allowance on this plan${when}` };
  }
  let used = num(snap.credits_used);
  if (used === null) {
    const remaining = num(snap.remaining) ?? num(snap.quota_remaining);
    const pctLeft = num(snap.percent_remaining);
    used = remaining !== null ? Math.max(0, entitlement - remaining) : pctLeft !== null ? entitlement * Math.max(0, 100 - pctLeft) / 100 : null;
  }
  if (used === null) return { limits: allowances, plan, free, status: "" };
  return { limits: [{ title: "Monthly", percent: clamp01(used / entitlement), resetsAt }, ...allowances], plan, free, status: "" };
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
