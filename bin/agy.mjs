#!/usr/bin/env node
// Antigravity limits from the local agy session (Secret Service keyring entry
// service=gemini username=antigravity, or ~/.gemini/antigravity-cli/
// antigravity-oauth-token). Read-only: never refreshes or writes the token.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveLogin } from "./agy-login.mjs";

const URL_BASE = "https://daily-cloudcode-pa.googleapis.com";
const root = process.env.AGY_DIR || path.join(os.homedir(), ".gemini", "antigravity-cli");
const out = (o) => { process.stdout.write(JSON.stringify({ limits: [], plan: "", status: "", ...o }) + "\n"); process.exit(0); };
const clamp01 = (n) => Math.max(0, Math.min(1, n));

// The login is agy's. We only read it; when it has lapsed (or is about to) we
// let agy refresh it by running `agy models` briefly in the background.
const STATE_DIR = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "omarchy", "agent-usage-tabs");
const KICK_FILE = path.join(STATE_DIR, "agy-kick.json");
const PATH_ENV = [process.env.PATH, `${os.homedir()}/.local/bin`, "/usr/bin"].filter(Boolean).join(":");

function readLogin() {
  let data = null;
  try {
    const r = spawnSync("secret-tool", ["lookup", "service", "gemini", "username", "antigravity"], { encoding: "utf8", timeout: 4000 });
    if (r.stdout?.trim()) data = JSON.parse(r.stdout);
  } catch {}
  if (!data) { try { data = JSON.parse(fs.readFileSync(path.join(root, "antigravity-oauth-token"), "utf8")); } catch {} }
  if (!data) return null;
  const t = data.token && typeof data.token === "object" ? data.token : data;
  return { access: String(t.access_token || ""), expiresMs: Date.parse(t.expiry || data.expiry || "") };
}
function kickAgy() {
  // No display variables: agy can refresh headlessly but can never open a
  // browser sign-in window from here.
  const env = { ...process.env, PATH: PATH_ENV };
  delete env.DISPLAY; delete env.WAYLAND_DISPLAY;
  spawnSync("agy", ["models"], { env, stdio: "ignore", timeout: 30000 });
}
const kickState = {
  get() { try { return Number(JSON.parse(fs.readFileSync(KICK_FILE, "utf8")).at) || 0; } catch { return 0; } },
  set(ms) { try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(KICK_FILE, JSON.stringify({ at: ms })); } catch {} },
};

const resolved = resolveLogin({ read: readLogin, kick: kickAgy, state: kickState });
if (!resolved.login || !resolved.login.access) out({ status: "Not signed in — run `agy` to log in." });
if (resolved.lapsed) out({ status: resolved.kicked || resolved.cooledDown ? "Sign-in expired and agy couldn't refresh it — run `agy` and sign in again." : "Sign-in lapsed — start agy once to refresh it." });
const access = resolved.login.access;

const post = async (endpoint, body) => {
  const res = await fetch(`${URL_BASE}/v1internal:${endpoint}`, {
    method: "POST", body: JSON.stringify(body || {}), signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json", "User-Agent": "antigravity" },
  });
  if (res.status === 401 || res.status === 403) { const e = new Error("auth"); e.auth = true; throw e; }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

const used = (b) => {
  if (!b || b.disabled === true) return null;
  const r = b.remainingFraction ?? b.remaining_fraction;
  if (r === undefined || r === null) return (b.resetTime || b.reset_time) ? 1 : null;
  const n = Number(r);
  return Number.isFinite(n) ? clamp01(1 - n) : null;
};
const resetOf = (b) => { const d = new Date(b.resetTime || b.reset_time || ""); return isNaN(d.getTime()) ? "" : d.toISOString(); };
const tierOf = (a) => {
  for (const k of ["paidTier", "currentTier"]) {
    const x = a?.[k]; if (!x || typeof x !== "object") continue;
    const name = String(x.name || ""), id = String(x.id || "");
    for (const w of ["ultra", "pro", "free"]) if (id.toLowerCase().includes(w) || name.toLowerCase().includes(w)) return w[0].toUpperCase() + w.slice(1);
    if (name || id) return name || id;
  }
  return "";
};

try {
  const assist = await post("loadCodeAssist");
  let project = assist?.cloudaicompanionProject; project = project && typeof project === "object" ? project.id : project;
  const q = await post("retrieveUserQuotaSummary", typeof project === "string" && project.trim() ? { project: project.trim() } : {});
  let groups = Array.isArray(q.groups) ? q.groups.filter((g) => g && typeof g === "object") : [];
  if (!groups.length && Array.isArray(q.buckets)) groups = [{ displayName: "Gemini", buckets: q.buckets }];
  const limits = [];
  const isWeekly = (b) => /week/i.test(`${b.window || ""} ${b.bucketId || ""} ${b.displayName || ""}`);
  for (const g of groups) {
    const gname = String(g.displayName || "").trim();
    const label = /gemini/i.test(gname) ? "Gemini" : (/claude/i.test(gname) ? "Claude/GPT" : gname || "Other");
    for (const b of Array.isArray(g.buckets) ? g.buckets : []) {
      const u = used(b); if (u === null) continue;
      // Non-Gemini groups are scoped allowances: show them once touched.
      if (label !== "Gemini" && u === 0) continue;
      limits.push({ title: `${label} ${isWeekly(b) ? "Weekly" : "Session"}`, percent: u, resetsAt: resetOf(b) });
    }
  }
  const hasGemini = limits.some((l) => l.title.startsWith("Gemini"));
  out({ limits, plan: tierOf(assist), status: !limits.length ? "Antigravity reported no quota windows." : hasGemini ? "" : "Google reports no Gemini limit for this plan." });
} catch (e) {
  out({ status: e.auth ? "Google refused the agy sign-in — run `agy`." : "Antigravity limits unavailable right now." });
}
