// Constance's token meter: how many tokens each worker she launched has used on its
// job, the current goal's total split by agent, and today's total.
//
// The numbers come from the same per-session usage records the agent tabs read
// (bin/folder-usage.py -> folder-usage.json: one record per agent session with its
// folder, start time and token total). A job is matched to its agent's session by
// the folder it ran in and the session's start time falling inside the job's run:
//   - a copy's own worktree belongs to that job alone, so every session that agent
//     started there during the job is the job's;
//   - a job in the shared project folder needs exactly ONE session of its agent that
//     started during it, and no other job of the same agent in that folder whose run
//     also covers it. Anything else (none yet, several, an overlap) is "can't tell".
// Agents whose records aren't tokens (Copilot reports AI credits) or that have no
// per-folder records at all are "can't tell" too. Nothing is ever estimated.
//
// Worktrees are dropped after review, and folder-usage only keeps folders that
// exist, so a finished job's last matched count is kept on the job (`tokens`) and
// used once its live records are gone.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CANT_TELL = "can't tell";
const SLACK_MS = 2000;            // a session's first record can't come before the launch; 2 s of clock slack
export const REFRESH_GAP_MS = 30e3;

// Jobs that actually launched an agent (practice, held and waiting jobs never did).
export const launched = (j) => !!j.startedAt && !["held", "waiting"].includes(j.status) && !String(j.summary || "").startsWith("(practice run");
const endOf = (j, now) => (j.status === "running" ? now : j.finishedAt || j.stoppedAt || now);
const folderOf = (j) => j.worktree || (j.copy ? "" : j.dir);   // a copy whose worktree was dropped has no live folder

// { [jobId]: { tokens, sessions } | { tokens: null, why } } from the live records.
export function matchJobs(jobs, records, now = Date.now()) {
  const out = {};
  const runs = jobs.filter(launched);
  for (const j of runs) {
    const folder = folderOf(j);
    if (!folder) { out[j.id] = { tokens: null, why: "its worktree is gone" }; continue; }
    const start = j.startedAt - SLACK_MS, end = endOf(j, now);
    const mine = records.filter((r) => r.agent === j.agent && r.folder === folder && Number(r.start) >= start && Number(r.start) <= end);
    if (mine.some((r) => r.unit !== "tokens")) { out[j.id] = { tokens: null, why: "its agent reports credits, not tokens" }; continue; }
    if (!mine.length) { out[j.id] = { tokens: null, why: "no session of its agent found in its folder yet" }; continue; }
    if (!j.worktree) {
      if (mine.length > 1) { out[j.id] = { tokens: null, why: "several sessions of its agent started in that folder during it" }; continue; }
      const r = mine[0];
      const rival = runs.some((k) => k.id !== j.id && k.agent === j.agent && !k.worktree && folderOf(k) === folder &&
        Number(r.start) >= k.startedAt - SLACK_MS && Number(r.start) <= endOf(k, now));
      if (rival) { out[j.id] = { tokens: null, why: "another job of the same agent ran in that folder at the same time" }; continue; }
    }
    out[j.id] = { tokens: mine.reduce((n, r) => n + (Number(r.amount) || 0), 0), sessions: mine.map((r) => r.session) };
  }
  return out;
}

// The count to show for a job: the live match; or, once the job is over and its
// records are gone, the last count kept on the job; otherwise null ("can't tell").
export function jobTokens(j, live) {
  const m = live[j.id];
  if (m && m.tokens !== null) return m.tokens;
  if (j.status !== "running" && j.tokens && Number.isFinite(j.tokens.n)) return j.tokens.n;
  return null;
}

// What to keep on jobs: { [jobId]: { n, sessions, at } } for live matches that changed.
export function snapshots(jobs, live, now = Date.now()) {
  const keep = {};
  for (const j of jobs) {
    const m = live[j.id];
    if (!m || m.tokens === null) continue;
    if (j.tokens && j.tokens.n === m.tokens) continue;
    keep[j.id] = { n: m.tokens, sessions: m.sessions, at: now };
  }
  return keep;
}

export function fmtTokens(n) {
  if (n === null || n === undefined) return CANT_TELL;
  if (n >= 1e9) return `${+(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}

const startOfDay = (now) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };

// The panel's meter. `name(agentId)` gives the display name.
//   workers: one per running job — { job, name, tokens, count: "124K tokens", text: "Devin 3  124K tokens" }
//   goal:    { total, byAgent: [{ agent, name, tokens }], cantTell }   (null without a goal)
//   today:   { total, cantTell }   (jobs started today, any goal)
//   line:    "This goal 1.2M (Devin 900K · Grok 300K) + 1 job can't tell · Today 2.4M + 1 job can't tell"
export function tokenMeter({ jobs = [], goal = null, records = [], now = Date.now(), name = (id) => id } = {}) {
  const live = matchJobs(jobs, records, now);
  const count = (j) => jobTokens(j, live);
  const workers = jobs.filter((j) => j.status === "running" && launched(j)).sort((a, b) => a.id - b.id).map((j) => {
    const who = j.worker || name(j.agent), tokens = count(j);
    const shown = tokens === null ? CANT_TELL : fmtTokens(tokens) + " tokens";
    return { job: j.id, name: who, tokens, count: shown, why: tokens === null ? live[j.id]?.why || "" : "", text: `${who}  ${shown}` };
  });
  const sum = (list) => {
    let total = 0, cantTell = 0;
    const by = new Map();
    for (const j of list) {
      const n = count(j);
      if (n === null) { cantTell++; continue; }
      total += n;
      by.set(j.agent, (by.get(j.agent) || 0) + n);
    }
    return { total, cantTell, byAgent: [...by].map(([agent, tokens]) => ({ agent, name: name(agent), tokens })).sort((a, b) => b.tokens - a.tokens) };
  };
  const runs = jobs.filter(launched);
  const g = goal ? sum(runs.filter((j) => j.goal === goal.id)) : null;
  const t = sum(runs.filter((j) => j.startedAt >= startOfDay(now)));
  const unknown = (n) => (n ? ` + ${n} job${n === 1 ? "" : "s"} ${CANT_TELL}` : "");
  const parts = [];
  if (g) parts.push(`This goal ${fmtTokens(g.total)}${g.byAgent.length ? ` (${g.byAgent.map((a) => `${a.name} ${fmtTokens(a.tokens)}`).join(" · ")})` : ""}${unknown(g.cantTell)}`);
  parts.push(`Today ${fmtTokens(t.total)}${unknown(t.cantTell)}`);
  return { workers, goal: g, today: { total: t.total, cantTell: t.cantTell }, line: parts.join(" · "), live };
}

// ---------------------------------------------------------------- records on disk

export function usageFile(env = process.env) {
  if (env.FOLDER_USAGE_STATE_DIR) return path.join(env.FOLDER_USAGE_STATE_DIR, "folder-usage.json");
  return path.join(env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), ".local/state"), "omarchy", "agent-usage-tabs", "folder-usage.json");
}

export function readRecords(file = usageFile()) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    return { records: Array.isArray(d.records) ? d.records : [], refreshedAt: Number(d.refreshedAt) || 0 };
  } catch { return { records: [], refreshedAt: 0 }; }
}

const SCRIPT = path.join(HERE, "folder-usage.py");

// While a worker runs, keep the records fresh without slowing `status`: start one
// background folder-usage scan when the file is older than REFRESH_GAP_MS and no
// scan was started in that time (a marker file next to it). Returns true if started.
export function refreshInBackground({ env = process.env, now = Date.now(), gap = REFRESH_GAP_MS, run = null } = {}) {
  const file = usageFile(env), marker = file + ".constance-refresh";
  const { refreshedAt } = readRecords(file);
  if (now - refreshedAt < gap) return false;
  try { const at = Number(fs.readFileSync(marker, "utf8")); if (at && Math.abs(now - at) < gap) return false; } catch {}
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(marker, String(now)); } catch { return false; }
  if (run) { run(); return true; }
  try { spawn("python3", [SCRIPT, "--force"], { env, detached: true, stdio: "ignore" }).unref(); } catch { return false; }
  return true;
}

// A fresh scan right now (before a worktree is dropped, so its count is kept).
export function refreshNow(env = process.env) {
  return spawnSync("python3", [SCRIPT, "--force"], { env, stdio: "ignore", timeout: 60e3 }).status === 0;
}
