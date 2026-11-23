#!/usr/bin/env node
// Grok limits from the Grok CLI's own login (~/.grok/auth.json). Read-only:
// never refreshes or writes the token. Prints {limits, plan, status} as JSON.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveLogin } from "./agy-login.mjs";
import { grokWall } from "./grok-wall.mjs";

const home = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
const BASE = "https://cli-chat-proxy.grok.com/v1/billing";
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
// The free per-model cap only shows up in Grok's log (see grok-wall.mjs); it leads the meters.
function readLogTail(p, max = 4 << 20) {
  try { const fd = fs.openSync(p, "r"), size = fs.fstatSync(fd).size, len = Math.min(size, max), b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, size - len); fs.closeSync(fd); return b.toString("utf8"); } catch { return ""; }
}
const wall = grokWall(readLogTail(path.join(home, "logs", "unified.jsonl")));
const out = (o) => {
  const r = { limits: [], plan: "", status: "", ...o };
  if (wall) { r.limits = [wall, ...r.limits]; if (r.status === "Grok reported no limit windows.") r.status = ""; }
  // Can't confirm the reading is complete -> say so, so the panel shows it unsure instead of green.
  else if (r.limits.length && /free/i.test(r.plan)) r.unsure ||= "Grok doesn't report its free per-model limits until one is hit, so this may be incomplete.";
  if (!r.unsure && r.limits.some((l) => l.unsure)) r.unsure = r.limits.find((l) => l.unsure).unsure;
  process.stdout.write(JSON.stringify(r) + "\n"); process.exit(0);
};
const num = (v) => { if (v && typeof v === "object") v = v.val || 0; v = Number(v); if (!Number.isFinite(v)) throw new Error("nan"); return v; };
const clamp01 = (n) => Math.max(0, Math.min(1, n));

let plan = "";
try { plan = JSON.parse(readJson(path.join(home, "settings_cache.json"))?.payload || "{}")?.settings?.subscription_tier_display || ""; } catch {}

// The login is Grok's. We only read it; when its token has lapsed (or is about
// to) we let Grok refresh it by running `grok models` once in the background
// (no display variables; at most once per 10 minutes), then read it again.
const STATE_DIR = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "omarchy", "agent-usage-tabs");
const KICK_FILE = path.join(STATE_DIR, "grok-kick.json");
const PATH_ENV = [process.env.PATH, `${os.homedir()}/.local/bin`, "/usr/bin"].filter(Boolean).join(":");

function readLogin() {
  const auth = readJson(path.join(home, "auth.json"));
  const entry = auth && typeof auth === "object" ? Object.values(auth).find((v) => v && typeof v === "object") : null;
  if (!entry) return null;
  return { access: String(entry.key || ""), expiresMs: Date.parse(entry.expires_at || "") };
}
function kickGrok() {
  const env = { ...process.env, PATH: PATH_ENV };
  delete env.DISPLAY; delete env.WAYLAND_DISPLAY;
  spawnSync("grok", ["models"], { env, stdio: "ignore", timeout: 40000 });
}
const kickState = {
  get() { try { return Number(JSON.parse(fs.readFileSync(KICK_FILE, "utf8")).at) || 0; } catch { return 0; } },
  set(ms) { try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(KICK_FILE, JSON.stringify({ at: ms })); } catch {} },
};

const resolved = resolveLogin({ read: readLogin, kick: kickGrok, state: kickState });
if (!resolved.login || !resolved.login.access) out({ plan, status: "Not signed in — run `grok login`." });
if (resolved.lapsed) out({ plan, status: "Sign-in expired and Grok couldn't refresh it — run `grok login`." });
const token = resolved.login.access;

const get = async (url) => {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
  if (res.status === 401 || res.status === 403) { const e = new Error("auth"); e.auth = true; throw e; }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

try {
  const limits = [];
  const c = (await get(`${BASE}?format=credits`)).config;
  const period = c.currentPeriod, ends = Date.parse(period.end);
  const unified = c.isUnifiedBillingUser === true;
  let used = c.creditUsagePercent, unsure = "";
  if (used === undefined) { if (ends <= Date.now()) throw new Error("ended period"); used = 0; unsure = "Grok sent no usage figure for this window; 0% is assumed."; }
  limits.push({ title: String(period.type || "").includes("WEEK") ? "Weekly" : "Monthly", percent: clamp01(num(used) / 100), resetsAt: new Date(ends).toISOString(), ...(unsure && { unsure }) });
  if (unified) {
    try {
      const m = (await get(BASE)).config, quota = num(m.monthlyLimit);
      if (quota > 0) limits.push({ title: "Monthly", percent: clamp01(num(m.used) / quota), resetsAt: new Date(m.billingPeriodEnd).toISOString() });
    } catch {}
  }
  out({ limits, plan, status: limits.length ? "" : "Grok reported no limit windows." });
} catch (e) {
  out({ plan, status: e.auth ? "Grok sign-in refused — run `grok login`." : "Grok limits unavailable right now." });
}
