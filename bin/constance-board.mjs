// What Constance's panel shows at a glance: one card per job, a plain-English "Now" line, and the
// history of past goals. Pure functions over jobs.json / log.jsonl / history.jsonl; the panel only
// formats elapsed time live.
import { jobItems, checklist } from "./constance-checklist.mjs";
import { jobTokens, fmtTokens } from "./constance-tokens.mjs";

const isPractice = (j) => String(j.summary || "").startsWith("(practice run");

// The owner's words for a job's state.
export function jobStatus(j) {
  if (isPractice(j)) return "practice";
  return ({ waiting: "queued", held: "held", running: "running", finished: "in review", accepted: "merged",
    "sent back": "sent back", conflict: "conflict", stopped: "stopped" })[j.status] || String(j.status || "queued");
}

const firstLine = (t) => String(t || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) || "";
const clip = (t, n) => (t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t);

// A short title: her --title, else the task's first sentence.
export function jobTitle(j) {
  if (j.title) return clip(String(j.title).trim(), 60);
  const s = firstLine(j.task).split(/(?<=[.!?:])\s|\s\(/)[0].replace(/[.:]$/, "");
  return clip(s, 60);
}

// One-line result: her review note, else the agent's own summary, else nothing.
export function jobResult(j) {
  if (j.status === "conflict") return clip("Merge conflict: left for you, nothing forced", 120);
  if (isPractice(j)) return "Practice: prompt logged, nothing launched";
  if (j.status === "held") return clip(j.heldReason ? `Held: ${j.heldReason}` : "Held until the machine has room", 120);
  return clip(firstLine(j.reviewNote) || firstLine(j.summary), 120);
}

// Cards for the job board, newest goal's jobs first by id, then ready-queue tasks as "queued".
export function cards({ jobs = [], goal = null, queue = [], live = {}, names = (id) => id } = {}) {
  const count = goal ? (Array.isArray(goal.items) && goal.items.length ? goal.items.length : checklist(goal, []).total) : 0;
  const mine = jobs.filter((j) => !goal || !j.goal || j.goal === goal.id).sort((a, b) => a.id - b.id);
  const out = mine.map((j) => {
    const tokens = jobTokens(j, live);
    const end = j.status === "running" ? null : (j.finishedAt || j.stoppedAt || null);
    return {
      id: j.id, key: `job-${j.id}`, worker: j.worker || names(j.agent), agent: j.agent, status: jobStatus(j),
      title: jobTitle(j), files: j.files || [], tokens, tokensText: tokens === null ? "" : fmtTokens(tokens) + " tokens",
      startedAt: j.startedAt || null, endedAt: end, createdAt: j.createdAt || null,
      result: jobResult(j), items: count ? jobItems(j, count) : [],
    };
  });
  for (const q of queue) out.push({ id: null, key: `queue-${q.id}`, worker: q.agent ? names(q.agent) : "next free agent", agent: q.agent || "", status: "queued",
    title: clip(firstLine(q.task), 60), files: q.files || [], tokens: null, tokensText: "", startedAt: null, endedAt: null, createdAt: q.at || null, result: "", items: [] });
  return out;
}

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const lower = (t) => t.charAt(0).toLowerCase() + t.slice(1);

// "Devin 2 is fixing the guard; 2 jobs waiting for review."
export function nowLine({ goal = null, jobs = [], names = (id) => id, goalQueue = [], queuePaused = "" } = {}) {
  const next = goalQueue.length ? ` ${plural(goalQueue.length, "goal")} queued.` : "";
  if (!goal || !["running", "paused"].includes(goal.status)) {
    if (goal && goal.needsOwner) return `She stopped: ${goal.needsOwner}${goalQueue.length ? " The queue waits for you." : ""}`;
    if (queuePaused && goalQueue.length) return `The goal queue is paused: ${queuePaused}`;
    return goal ? `Free. Last goal ${({ done: "finished", stopped: "was stopped", failed: "couldn't finish" })[goal.status] || goal.status}.${next}` : `Free. Give her a goal.${next}`;
  }
  if (goal.status === "paused") return `Paused for her limits: ${goal.pauseReason || "waiting for a reset"}.`;
  const mine = jobs.filter((j) => !j.goal || j.goal === goal.id);
  const running = mine.filter((j) => j.status === "running").sort((a, b) => a.id - b.id);
  const review = mine.filter((j) => j.status === "finished" && !isPractice(j)).length;
  const waiting = mine.filter((j) => j.status === "held" || j.status === "waiting").length;
  const parts = [];
  if (running.length) {
    const who = running.slice(0, 2).map((j) => `${j.worker || names(j.agent)} is on ${j.title ? lower(String(j.title)) : `job ${j.id} (${lower(jobTitle(j))})`}`);
    if (running.length > 2) who.push(`${running.length - 2} more running`);
    parts.push(who.join(", "));
  } else parts.push(review ? "Constance is reviewing" : "Constance is planning");
  if (review) parts.push(`${plural(review, "job")} waiting for review`);
  if (waiting) parts.push(`${plural(waiting, "job")} waiting to start`);
  return parts.join("; ") + "." + next;
}

// ---------------------------------------------------------------- history

const OUTCOME = { done: "done", failed: "couldn't finish", stopped: "stopped" };

// The record kept for a finished goal (history.jsonl).
export function goalRecord(goal, jobs = [], live = {}) {
  const mine = jobs.filter((j) => j.goal === goal.id);
  let tokens = 0, cantTell = 0;
  for (const j of mine.filter((j) => j.startedAt && !isPractice(j))) { const n = jobTokens(j, live); if (n === null) cantTell++; else tokens += n; }
  const list = checklist(goal, jobs);
  return {
    id: goal.id, text: goal.text, dir: goal.dir, startedAt: goal.startedAt, finishedAt: goal.finishedAt || Date.now(),
    status: goal.status, outcome: goal.needsOwner ? "needs you" : (OUTCOME[goal.status] || goal.status), needsOwner: goal.needsOwner || "",
    jobs: mine.length, merged: mine.filter((j) => j.status === "accepted" && !isPractice(j)).length,
    sentBack: mine.filter((j) => j.status === "sent back").length, practice: mine.length > 0 && mine.every(isPractice),
    tokens: tokens || cantTell === 0 ? tokens : null, tokensCantTell: cantTell, itemsDone: list.done, itemsTotal: list.total,
    leverage: goal.leverage || null,
  };
}

// Goals older than history.jsonl, rebuilt from the log: each "goal" entry up to its report/stop/failure.
// Jobs and merges are counted from handoff and review lines; tokens weren't kept then, so they're unknown.
export function goalsFromLog(log = []) {
  const out = [];
  let cur = null;
  const close = (e, status) => { if (!cur) return; cur.finishedAt = e.at; cur.status = status; cur.outcome = OUTCOME[status]; out.push(cur); cur = null; };
  for (const e of log) {
    if (e.kind === "goal") {
      if (cur) { cur.outcome = "unknown"; cur.status = "unknown"; cur.finishedAt = null; out.push(cur); }
      const m = String(e.text || "").match(/^([\s\S]*) \(in (.*)\)$/);
      cur = { id: `log-${e.at}`, text: m ? m[1] : String(e.text || ""), dir: m ? m[2] : "", startedAt: e.at, finishedAt: null, status: "", outcome: "",
        jobs: 0, merged: 0, sentBack: 0, tokens: null, tokensCantTell: 0, fromLog: true, practice: false, seen: new Set(), practiceSeen: new Set() };
    } else if (!cur) continue;
    else if (e.kind === "handoff" || e.kind === "held") cur.seen.add(e.job);
    else if (e.kind === "practice") { cur.seen.add(e.job); cur.practiceSeen.add(e.job); }
    else if (e.kind === "review") { if (e.verdict === "accept") cur.merged++; else cur.sentBack++; }
    else if (e.kind === "report") close(e, "done");
    else if (e.kind === "stopped") close(e, "stopped");
    else if (e.kind === "failed") close(e, "failed");
  }
  for (const g of out) {
    g.jobs = g.seen.size; g.practice = g.jobs > 0 && g.practiceSeen.size === g.jobs; if (g.practice) g.merged = 0;
    delete g.seen; delete g.practiceSeen;
  }
  return out;
}

// One short line for a history row: "2/3 items · 4 jobs · 1h 0m", with her leverage
// label tacked on when the meter had enough spent to measure (perPct not null).
// Log-rebuilt goals have no item counts, so that part is simply left out.
const rowSummary = (r) => {
  const bits = [];
  if (Number.isFinite(r.itemsTotal)) bits.push(`${r.itemsDone || 0}/${r.itemsTotal} items`);
  bits.push(plural(r.jobs || 0, "job"));
  const t = took(r.took);
  if (t) bits.push(t);
  if (r.leverage && r.leverage.perPct != null) bits.push(r.leverage.label);
  return bits.join(" · ");
};

// Newest first: kept records, plus log-rebuilt goals that no record covers (same start within a minute),
// plus the current goal once it has ended and isn't recorded yet.
export function history({ records = [], log = [], goal = null, jobs = [], live = {}, limit = 30 } = {}) {
  const all = [...records];
  const covered = (at) => all.some((r) => Math.abs(Number(r.startedAt) - Number(at)) < 60e3);
  if (goal && !["running", "paused"].includes(goal.status) && !all.some((r) => r.id === goal.id)) all.push(goalRecord(goal, jobs, live));
  for (const g of goalsFromLog(log)) if (!covered(g.startedAt)) all.push(g);
  return all.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit).map((r) => {
    const row = { ...r, took: r.finishedAt && r.startedAt ? r.finishedAt - r.startedAt : null, leverage: r.leverage || null };
    row.tokensText = r.tokens === null || r.tokens === undefined ? "" : fmtTokens(r.tokens) + (r.tokensCantTell ? "+" : "");
    row.summary = rowSummary(row);
    return row;
  });
}

// "2h 5m" / "12m" / "40s".
export function took(ms) {
  if (typeof ms !== "number" || !(ms >= 0)) return "";
  const s = Math.round(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d) return `${d}d ${h % 24}h`;
  if (h) return `${h}h ${m % 60}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}
