#!/usr/bin/env node
// Cook Meter collector (plugin id spaceman.agent-usage-tabs). Writes ONE file, data.json, in this plugin's own
// state directory. Nothing here reads or writes another plugin's files.
//   claude        -> Anthropic OAuth usage endpoint + ~/.claude transcripts
//   grok          -> bin/grok.mjs, from the Grok CLI login (~/.grok/auth.json)
//   antigravity   -> bin/agy.mjs, from the local agy login (keyring/token file)
//   everything else -> Omarchy's own `omarchy-agent-usage-<id>` collectors,
//                    refreshed via `omarchy-agent-usage-update`, then read back.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseClaudeLimits, parseClaudeResets } from "./claude-limits.mjs";
import { applyResets, resetNotice, resetNotifyArgs, resetAssets } from "./reset-celebration.mjs";
import { fetchResets, corroborate } from "./agy-resets.mjs";
import { playSound } from "./play-sound.mjs";
import { planLimitsOnly } from "./plan-limits.mjs";
import { codexResets } from "./codex-resets.mjs";
import { planAlerts, markFired, alertText, planHandoffTriggers, markHandoffFired } from "./alert-state.mjs";
import { buildModels } from "./models.mjs";
import { liveModels } from "./live-models.mjs";
import { planInfo } from "./plan-info.mjs";
import { makeInstalledCheck, agentCli } from "./installed.mjs";
import { planLoginNotices, planInstallNotices } from "./login-watch.mjs";
import { buildAccounts } from "./accounts.mjs";
import { loadCatalog, tabNote } from "./catalog.mjs";
import { readOpenclawUsage } from "./openclaw-usage.mjs";
import { readAmpUsage } from "./amp-usage.mjs";
import { maybeWriteHandoff } from "./handoff.mjs";
import { createDiagnostics, checkAgentData } from "./diagnostics.mjs";

const HOME = os.homedir();
const STATE = path.join(process.env.XDG_STATE_HOME || path.join(HOME, ".local/state"), "omarchy");
const OUT_DIR = path.join(STATE, "agent-usage-tabs");
const OUT = path.join(OUT_DIR, "data.json");
const diag = createDiagnostics({ logFile: path.join(OUT_DIR, "collector.log"), stateFile: path.join(OUT_DIR, "diag-state.json") });
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "manifest.json"), "utf8")).version || ""; } catch { return ""; } })();
const BUILTIN_DIR = path.join(STATE, "agents/usage");
const PATH_DIRS = [
  ...(process.env.PATH || "").split(":"), `${HOME}/.local/bin`, `${HOME}/.local/share/mise/shims`,
  "/usr/local/bin", "/usr/bin",
].filter(Boolean);
const ENV = { ...process.env, PATH: PATH_DIRS.join(":") };

// Display order is the order you asked for.
const AGENTS = [
  { id: "claude", name: "Claude Code", bins: ["claude"] },
  { id: "antigravity", name: "Antigravity", bins: ["agy", "antigravity"], builtin: "agy" },
  { id: "grok", name: "Grok", bins: ["grok"], builtin: "grok" },
  { id: "codex", name: "Codex", bins: ["codex"], builtin: "codex" },
  { id: "copilot", name: "Copilot", bins: ["copilot"], builtin: "copilot" },
  { id: "cursor", name: "Cursor Agent", bins: ["cursor-agent"], builtin: "cursor" },
  { id: "opencode", name: "OpenCode", bins: ["opencode"], builtin: "opencode" },
  { id: "kimi", name: "Kimi", bins: ["kimi"], builtin: "kimi" },
  { id: "kiro", name: "Kiro", bins: ["kiro-cli"] },
  { id: "devin", name: "Devin", bins: ["devin"], builtin: "devin" },
  { id: "amp", name: "Amp", bins: ["amp"] },
  { id: "hermes", name: "Hermes", bins: ["hermes"], builtin: "hermes" },
];

// The catalog agents (agents-catalog.json) get a tab too, found by their binaries, with a note for how they report usage.
const CATALOG = loadCatalog();
for (const c of CATALOG.agents) AGENTS.push({ id: c.id, name: c.name, bins: c.bins, builtin: c.builtin, catalog: c });

const isInstalled = makeInstalledCheck({ dirs: PATH_DIRS, env: ENV });

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const localDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const lastDays = (n) => Array.from({ length: n }, (_, i) => localDate(Date.now() - (n - 1 - i) * 86400000));
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };

function titleFor(text, seconds) {
  const t = String(text || "").toLowerCase();
  if (seconds) {
    if (seconds >= 25 * 86400) return "Monthly";
    if (seconds >= 6 * 86400) return "Weekly";
    return "Session";
  }
  const h = t.match(/(\d+)\s*-?\s*h(?:our)?\b/);
  if (h) { const hrs = +h[1]; return hrs >= 600 ? "Monthly" : hrs >= 140 ? "Weekly" : "Session"; }
  if (/month|30-day/.test(t)) return "Monthly";
  if (/week|7-day|seven/.test(t)) return "Weekly";
  if (/session|5-hour|5h|hour|\d+\s*m\b/.test(t)) return "Session";
  return String(text || "Limit");
}

function modelRows(usageByModel) {
  return Object.entries(usageByModel || {}).map(([name, b]) => {
    const input = +b.inputTokens || 0, output = +b.outputTokens || 0;
    const cacheRead = +b.cacheReadInputTokens || 0, cacheWrite = +b.cacheCreationInputTokens || 0;
    return { name, input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
  }).sort((a, b) => b.total - a.total);
}

function daysFrom(map) { return lastDays(7).map((date) => ({ date, tokens: map[date] || 0 })); }

// ------------------------------------------------------------------ Claude
function claudeTranscripts() {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude"), "projects");
  const byModel = {}, byDay = {}, seen = new Set();
  const cutoff = Date.now() - 8 * 86400000;
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) {
        try { if (fs.statSync(p).mtimeMs < cutoff) continue; } catch { continue; }
        for (const line of fs.readFileSync(p, "utf8").split("\n")) {
          if (!line.includes('"usage"')) continue;
          let d; try { d = JSON.parse(line); } catch { continue; }
          const m = d.message, u = m?.usage;
          if (!u || !d.timestamp) continue;
          const key = `${m.id}:${d.requestId}`;
          if (seen.has(key)) continue; seen.add(key);
          const ms = Date.parse(d.timestamp);
          if (!(ms >= cutoff)) continue;
          const model = m.model || "unknown";
          if (model === "<synthetic>") continue;
          const b = (byModel[model] ||= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
          b.inputTokens += u.input_tokens || 0; b.outputTokens += u.output_tokens || 0;
          b.cacheReadInputTokens += u.cache_read_input_tokens || 0; b.cacheCreationInputTokens += u.cache_creation_input_tokens || 0;
          const total = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          const day = localDate(ms); byDay[day] = (byDay[day] || 0) + total;
        }
      }
    }
  };
  walk(root);
  return { byModel, byDay };
}

const CLAUDE_MIN_INTERVAL_MS = 5 * 60 * 1000;
async function claudeLimits(previous) {
  // Anthropic rate-limits this endpoint; panel opens must not each hit it.
  if (previous?.limitsFetchedAt && Date.now() - previous.limitsFetchedAt < CLAUDE_MIN_INTERVAL_MS && (previous.limits || []).length)
    return { limits: previous.limits, plan: previous.plan || "", resets: previous.resets || null, status: "", fetchedAt: previous.limitsFetchedAt };
  const creds = readJson(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude"), ".credentials.json"))?.claudeAiOauth;
  if (!creds?.accessToken) return { status: "Not signed in — run `claude` to log in." };
  if (creds.expiresAt && creds.expiresAt < Date.now()) return { ...stale(previous), status: "Sign-in expired — open Claude Code once to refresh." };
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${creds.accessToken}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "agent-usage-tabs" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      if (res.status !== 429) diag.add("claude", `usage endpoint returned HTTP ${res.status}`, { status: res.status });
      return { ...stale(previous), status: res.status === 429 ? "Rate limited — showing last known limits." : `Limits unavailable (HTTP ${res.status}).` };
    }
    let j;
    try { j = await res.json(); } catch (e) { diag.add("claude", "usage response was not valid JSON", { error: String(e.message || e) }); return { ...stale(previous), status: "Limits unavailable." }; }
    const limits = parseClaudeLimits(j);
    if (!limits.length) diag.add("claude", "usage response had no session or weekly window", { keys: Object.keys(j || {}).slice(0, 20) });
    const plan = creds.subscriptionType ? creds.subscriptionType[0].toUpperCase() + creds.subscriptionType.slice(1) : "";
    return { limits, plan, resets: parseClaudeResets(j), status: limits.length ? "" : "Limits unavailable.", fetchedAt: limits.length ? Date.now() : 0 };
  } catch (e) { return { ...stale(previous), status: "Limits unavailable (network)." }; }
}
const stale = (prev) => (prev ? { limits: prev.limits || [], plan: prev.plan || "", resets: prev.resets || null, fetchedAt: prev.limitsFetchedAt || 0 } : {});

// ------------------------------------------- own scripts: grok.mjs, agy.mjs
const HERE = path.dirname(new URL(import.meta.url).pathname);
function ownScript(name, agentId = name) {
  const r = spawnSync("node", [path.join(HERE, `${name}.mjs`)], { encoding: "utf8", env: ENV, timeout: 45000 });
  const bad = (msg) => { diag.add(agentId, `${name} collector: ${msg}`, { stdout: String(r.stdout || "").slice(0, 200), stderr: String(r.stderr || "").slice(0, 200), exit: r.status }); return { status: `${name} collector ${msg}.` }; };
  try { return JSON.parse(r.stdout || "null") || bad("gave no output"); }
  catch { return bad("gave invalid output"); }
}

// -------------------------------------------------- Omarchy built-in records
function refreshBuiltins(ids) {
  if (ids.length) spawnSync("omarchy-agent-usage-update", ids, { env: ENV, timeout: 90000, stdio: "ignore" });
}
function fromBuiltin(id, agentId = id) {
  const file = path.join(BUILTIN_DIR, `${id}.json`);
  const r = readJson(file);
  if (!r) { if (fs.existsSync(file)) diag.add(agentId, "Omarchy's usage record exists but isn't readable JSON", { file }); return null; }
  if (!Array.isArray(r.limits ?? [])) diag.add(agentId, "Omarchy's usage record has limits that aren't a list", { type: typeof r.limits });
  const days = {}; for (const d of r.recentDays || []) days[d.date] = +d.messageCount || 0;
  return {
    plan: r.tierLabel || "",
    limits: (r.limits || []).filter((l) => Number(l.percent) >= 0)
      .map((l) => ({ title: l.title || titleFor(l.label), percent: clamp01(Number(l.percent)), resetsAt: l.resetsAt || "" })),
    models: modelRows(r.modelUsage), modelScope: "all time",
    days: daysFrom(days),
    resets: codexResets(r),
    signedIn: r.ready === true,
    status: r.ready === false ? String(r.usageStatusText || r.authHelpText || "") : "",
    note: String(r.usageStatusText || ""),
  };
}

// models.json sits beside the plugin and is meant to be edited by hand.
let _modelsConfig;
function modelsConfig() {
  if (_modelsConfig === undefined) _modelsConfig = readJson(path.join(HERE, "..", "models.json"));
  return _modelsConfig;
}

// -------------------------------------------------------------------- main
const prev = readJson(OUT);
const prevAgent = (id) => prev?.agents?.find((a) => a.id === id);
const installedIds = new Set(AGENTS.filter((a) => isInstalled(a.bins)).map((a) => a.id));
const installed = AGENTS.filter((a) => installedIds.has(a.id));
refreshBuiltins([...new Set(installed.map((a) => a.builtin).filter(Boolean))]);

const agents = [];
for (const a of AGENTS) {
  // Every agent is emitted so the panel can offer a "show uninstalled agents"
  // switch; an agent that isn't installed is never run or queried.
  if (!installedIds.has(a.id)) {
    agents.push({ id: a.id, name: a.name, installed: false, plan: "", status: "Not installed", limits: [], models: [], modelScope: "", days: [], today: 0 });
    continue;
  }
  const out = { id: a.id, name: a.name, installed: true, cli: agentCli(a.bins, isInstalled), plan: "", status: "", limits: [], models: [], modelScope: "", days: [] };
  if (a.id === "claude") {
    const { byModel, byDay } = claudeTranscripts();
    const lim = await claudeLimits(prevAgent("claude"));
    Object.assign(out, { plan: lim.plan || "", limits: lim.limits || [], status: lim.status || "", models: modelRows(byModel), modelScope: "last 7 days", days: daysFrom(byDay), limitsFetchedAt: lim.fetchedAt || 0, resets: lim.resets || null,
      signedIn: fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude"), ".credentials.json")) });
  } else if (a.catalog && !a.builtin) {
    // No Omarchy usage record: say how this agent reports usage (from the catalog) instead of showing meters.
    Object.assign(out, { usageType: a.catalog.usageType, planNote: tabNote(a.catalog, CATALOG.types), signedIn: null, catalog: true });
    if (a.id === "openclaw") {
      const u = readOpenclawUsage({ env: ENV }); out.limits = u.limits; out.status = u.status;
      // Only a provider that really failed gets a can't-read line (named, no repair hints).
      if (!u.limits.length && u.failed?.length) out.cantRead = `Can't read ${u.failed.join(", ")} usage: the provider reported an error.`;
    }   // its own documented status command
  } else {
    const local = a.builtin ? fromBuiltin(a.builtin, a.id) : null;
    if (local) Object.assign(out, local, { status: "" });
    if (a.id === "copilot") {
      const cp = ownScript("copilot", "copilot");
      if (cp.limits?.length) out.limits = cp.limits;
      if (cp.plan) out.plan = cp.plan;
      if (cp.status) out.status = cp.status;
      if (cp.free) out.copilotFree = true;
      out.signedIn = !!cp.plan;
    } else if (a.id === "grok" || a.id === "antigravity") {
      const sq = ownScript(a.id === "grok" ? "grok" : "agy", a.id);
      out.limits = sq.limits || []; if (sq.plan) out.plan = sq.plan; out.status = sq.status || "";
      out.signedIn = !String(sq.status || "").startsWith("Not signed in");
      // Quota failed but local stats exist: the one-line status still says why.
    } else if (!local) {
      out.status = a.builtin ? "No usage recorded yet." : "No usage data source for this agent yet.";
    } else if (local.status) out.status = local.status;
  }
  // Plan / free-tier notes: only what each tool reports; text comes from models.json.
  const onUnexpected = (msg, details) => diag.add(a.id, msg, details);
  const live = liveModels(a.id, { env: ENV, stateDir: OUT_DIR, onUnexpected });
  const plans = modelsConfig()?.plans || {};
  if (a.id === "copilot" && out.copilotFree && plans.copilot?.freeNote) out.planNote = plans.copilot.freeNote;
  if (a.id === "kiro") {
    const k = planInfo("kiro", { env: ENV, stateDir: OUT_DIR, onUnexpected });
    out.signedIn = !!k;
    if (k) {
      out.limits = k.limits; out.status = ""; if (k.plan) out.plan = k.plan;
      if (/free/i.test(k.plan) && plans.kiro?.freeNote) out.planNote = plans.kiro.freeNote;
    }
  }
  if (a.id === "amp") {
    const m = planInfo("amp", { env: ENV, stateDir: OUT_DIR, onUnexpected });
    out.signedIn = !!m;
    if (m) { if (m.note) out.planNote = m.note; out.status = ""; const u = readAmpUsage({ env: ENV }); if (u.status) out.status = u.status; }   // `amp usage --details`: the token total only
  }
  if (a.id === "hermes") {
    const h = planInfo("hermes", { env: ENV, stateDir: OUT_DIR, onUnexpected });
    out.signedIn = !!(h && h.loggedIn);
    if (h && !h.loggedIn) out.planNote = plans.hermes?.localNote || "";
    else if (h && h.freeTier) { out.plan = "Free"; out.planNote = plans.hermes?.freeNote || ""; }
  }
  if (a.id === "opencode") out.signedIn = null; // free models need no login
  if (a.id === "opencode" && (live || []).some((m) => /free/i.test(m.id)) && plans.opencode?.freeNote) out.planNote = plans.opencode.freeNote;
  delete out.copilotFree;
  // A plain line saying what this tab cannot read, shown only while it really has nothing to show (no meters).
  const cant = plans[a.id]?.cantRead || a.catalog?.cantRead || "";
  if (cant && !(out.limits || []).length && !(a.id === "kimi" && out.signedIn !== false)) out.cantRead = cant;
  if (a.catalog && a.builtin) Object.assign(out, { usageType: a.catalog.usageType, planNote: tabNote(a.catalog, CATALOG.types), catalog: true });

  // Plan limits, usage and resets only: never spend, overage or top-up meters.
  out.limits = planLimitsOnly(out.limits);

  // Models section: live data first, then the editable models.json entries.
  out.models = buildModels({
    plan: out.plan, used: out.models,
    live,
    config: modelsConfig()?.agents?.[a.id]?.models || [],
  });
  for (const m of checkAgentData({ ...out, installed: true })) diag.add(a.id, m);
  out.dataWarning = diag.summary(a.id);
  out.today = out.days.length ? out.days[out.days.length - 1].tokens : 0;
  delete out.note;
  agents.push(out);
}

// ------------------------------------------------------- multiple accounts
// From Omarchy's own account list (no credentials, no emails). Only agents with
// two or more signed-in accounts get an `accounts` array; chips, the bar number,
// alerts and celebrations then use every account's meters.
{
  const r = spawnSync("omarchy-agent-account-list", ["--json"], { encoding: "utf8", env: ENV, timeout: 20000 });
  let list = null; try { list = JSON.parse(r.stdout || "null"); } catch {}
  const byProvider = buildAccounts(list);
  for (const a of agents) if (byProvider[a.id]) a.accounts = byProvider[a.id].map((x) => ({ ...x, limits: planLimitsOnly(x.limits) }));
}

// ------------------------------------------------- "now available" login notice
// The first time an agent whose tab is hidden gets a login, tell the user once.
// Hidden = hidden by the user while installed, or not installed with "hide
// uninstalled" on. State lives in agent-logins.json; the first run only records.
{
  const ui = readJson(path.join(OUT_DIR, "settings.json")) || {};
  const settings = { hiddenAgents: Array.isArray(ui.hiddenAgents) ? ui.hiddenAgents : [], hideUninstalled: ui.hideUninstalledAgents !== false };
  const LOGINS = path.join(OUT_DIR, "agent-logins.json");
  // A hidden-because-uninstalled agent that is now installed: its tab reappears; tell the user once.
  const INSTALLS = path.join(OUT_DIR, "agent-installs.json");
  const inst = planInstallNotices(prev?.agents, agents, settings, readJson(INSTALLS));
  for (const a of inst.notify) {
    spawnSync("notify-send", ["-a", "Cook Meter", "-u", "normal", "-i", "emblem-ok-symbolic", "-h", "boolean:suppress-sound:true",
      `${a.name} is now available`, "It's installed - its tab has been added."], { env: ENV, timeout: 5000 });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(INSTALLS, JSON.stringify(inst.notified) + "\n", { mode: 0o600 });
  const { notify, seen } = planLoginNotices(agents, settings, readJson(LOGINS));
  for (const a of notify) {
    spawnSync("notify-send", ["-a", "Cook Meter", "-u", "normal", "-i", "emblem-ok-symbolic", "-h", "boolean:suppress-sound:true",
      `${a.name} is now available`, "You're signed in. Its tab is hidden - turn it on in the gear settings."], { env: ENV, timeout: 5000 });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(LOGINS, JSON.stringify(seen) + "\n", { mode: 0o600 });
}

// ------------------------------------------------------------ notifications
// One desktop notification per limit window that passes the threshold, for
// every agent that reports usage. State lives in notified.json so a window that
// stays high does not re-notify on each refresh; it re-arms once usage drops
// below the threshold (or the window resets, which changes its resetsAt).
const argAfter = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? Number(process.argv[i + 1]) : NaN; };
const THRESHOLD = (Number.isFinite(argAfter("--notify")) ? argAfter("--notify") : 95) / 100;
const NOTIFIED = path.join(OUT_DIR, "notified.json");
function untilReset(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!(ms > 0)) return "";
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), dd = Math.floor(h / 24);
  return dd > 0 ? `resets in ${dd}d ${h % 24}h` : h > 0 ? `resets in ${h}h ${m % 60}m` : `resets in ${Math.max(1, m)}m`;
}
// When a SESSION meter's warning (or limit alert) fires, write handoff/HANDOFF.md in the active repo and point AGENTS.md at
// it, rebuilt each time. One note per run, for the agent closest to its limit. Switch it off in the gear settings.
// The handoff note has its own trigger, not the alert threshold: a SESSION meter at 90% or more, once per usage window
// (remembered in handoff-fired.json). It asks the first time instead of writing; see maybeWriteHandoff.
const HANDOFF_FIRED = path.join(OUT_DIR, "handoff-fired.json");
function handoffCheck(list) {
  try {
    const { toFire, memory } = planHandoffTriggers(list, readJson(HANDOFF_FIRED) || {});
    if (toFire.length) {
      const r = maybeWriteHandoff({ sent: toFire, settings: readJson(path.join(OUT_DIR, "settings.json")), untilReset,
        projectsDir: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude"), "projects"), squadDirFile: path.join(OUT_DIR, "squad-dir"),
        pendingFile: path.join(OUT_DIR, "handoff-pending.json") });
      if (r) for (const item of toFire) markHandoffFired(memory, item);   // asked, waiting or written: never again this window
      if (r === "asked")   // the first time only: nothing was written; the panel asks
        spawnSync("notify-send", ["-a", "Cook Meter", "-u", "normal", "-i", "dialog-question", "-h", "boolean:suppress-sound:true",
          "Handoff note waiting for your OK", "A session is at 90% or more. Open Cook Meter to allow, skip or turn off handoff notes."], { env: ENV, timeout: 5000 });
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(HANDOFF_FIRED, JSON.stringify(memory) + "\n", { mode: 0o600 });
  } catch (e) { diag.add("handoff", `couldn't write the handoff note: ${String(e.message || e)}`); }
}
function notifyHighUsage(list) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { toSend, memory } = planAlerts(list, readJson(NOTIFIED) || {}, THRESHOLD);
  for (const item of toSend) {
    const { title, body } = alertText(item, untilReset(item.limit.resetsAt));
    const r = spawnSync("notify-send", ["-a", "Cook Meter", "-u", "critical", "-i", "dialog-warning", "-h", "boolean:suppress-sound:true", title, body], { env: ENV, timeout: 5000 });
    if (r.status === 0) {
      markFired(memory, item); // a failed send is not remembered, so it retries; a sent one never repeats this window
    }
  }
  fs.writeFileSync(NOTIFIED, JSON.stringify(memory) + "\n", { mode: 0o600 });
}
// ------------------------------------------------------- reset celebration
// A session/weekly meter that fell by more than 50 points: flag it for the
// panel (chip flash + confetti) and send one silent notification.
// Volume 0-100 comes from the panel (0 when the sound switch is off); run by
// hand it defaults to 60. One cha-ching per run, however many agents reset.
const SOUND_VOLUME = Number.isFinite(argAfter("--volume")) ? argAfter("--volume") : 60;
const pendingResets = [];
const RESET_FIRED = path.join(OUT_DIR, "reset-fired.json");   // which windows already celebrated, kept across restarts
const resetFired = readJson(RESET_FIRED) || {};
applyResets(agents, prev?.agents, (a, windows, info) => pendingResets.push({ a, windows, info }), Date.now(), resetFired);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(RESET_FIRED, JSON.stringify(resetFired) + "\n", { mode: 0o600 });
let resetHappened = false, surpriseHappened = false, announcements = null;
for (const { a, windows, info } of pendingResets) {
  resetHappened = true;
  if (info.kind === "surprise") {
    surpriseHappened = true;
    // Ask agyresets.com (once per run, only now) whether the Antigravity team announced it.
    announcements ??= await fetchResets({ now: Date.now() });
    info.confirmed = corroborate(announcements, info.details, Date.now(), a.plan);
    a.resetConfirmed = !!info.confirmed;
  }
  const assets = resetAssets(info.kind);               // surprise resets get their own picture and sound
  const n = resetNotice(a, windows, info);
  spawnSync("notify-send", resetNotifyArgs(n, path.join(HERE, "..", "notify", assets.image)), { env: ENV, timeout: 5000 });
}
if (resetHappened && SOUND_VOLUME > 0) playSound(SOUND_VOLUME, path.join(HERE, "..", "sounds", resetAssets(surpriseHappened ? "surprise" : "scheduled").sound));

notifyHighUsage(agents);
handoffCheck(agents);

fs.mkdirSync(OUT_DIR, { recursive: true });
const tmp = `${OUT}.${process.pid}.tmp`;
diag.flush();
fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, version: VERSION, generatedAt: Date.now(), agents }, null, 1) + "\n", { mode: 0o600 });
fs.renameSync(tmp, OUT);
