// Shared per-day usage history, kept in <stateDir>/history.json (schemaVersion 1).
//
// Shape:
//   { "schemaVersion": 1,
//     "days": { "YYYY-MM-DD": { "<agentId>": {
//         "tokens": <number or null>,          // null = the source reported nothing that day
//         "peaks": { "<limit title>": <0..1> }, // highest percent each limit reached that day
//         "resets": <integer> } } } }           // reset celebrations that fired that day
//
// Dates are LOCAL calendar dates. This module is pure: recordDay returns a new
// history object and never mutates its input.
import fs from "node:fs";
import path from "node:path";

export const KEEP_DAYS = 30;

const pad = (n) => String(n).padStart(2, "0");

// "YYYY-MM-DD" for a timestamp, in local time.
export function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The calendar date `daysAgo` days before `dateStr` (negative = future).
function shiftDate(dateStr, daysAgo) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d - daysAgo);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const emptyDay = () => ({ schemaVersion: 1, days: {} });

// Reads history.json; a missing or corrupt file is simply an empty history.
export function loadHistory(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return emptyDay(); }
  try {
    const h = JSON.parse(raw);
    if (!h || typeof h !== "object" || h.schemaVersion !== 1 || !h.days || typeof h.days !== "object" || Array.isArray(h.days))
      return emptyDay();
    return { schemaVersion: 1, days: h.days };
  } catch { return emptyDay(); }
}

// Atomic write (tmp + rename), owner-only permissions.
export function saveHistory(file, h) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(h), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function dayRecord(days, date, agentId) {
  const day = (days[date] ||= {});
  return (day[agentId] ||= { tokens: null, peaks: {}, resets: 0 });
}

// Folds one collector snapshot (the data.json agents array) into the history.
// `agents`: [{ id, installed, hasTokens, today, days: [{date, tokens}], limits: [{title, percent}] }]
// `resetsByAgent`: { agentId: count } of reset celebrations that fired.
// Returns a NEW history object; the input is not mutated.
export function recordDay(history, agents, now = Date.now(), resetsByAgent = {}) {
  const out = { schemaVersion: 1, days: {} };
  for (const [date, byAgent] of Object.entries(history?.days || {})) {
    out.days[date] = {};
    for (const [id, rec] of Object.entries(byAgent || {}))
      out.days[date][id] = { tokens: num(rec?.tokens), peaks: { ...(rec?.peaks || {}) }, resets: rec?.resets | 0 };
  }

  const today = localDate(now);
  for (const a of agents || []) {
    if (!a || a.installed === false || typeof a.id !== "string") continue;
    // The source's own per-day token numbers (only when it reports tokens at all).
    if (a.hasTokens) {
      for (const d of a.days || []) {
        if (!d || typeof d.date !== "string") continue;
        dayRecord(out.days, d.date, a.id).tokens = num(d.tokens);
      }
    }
    // Today: current total, the highest percent each limit reached, and resets.
    const rec = dayRecord(out.days, today, a.id);
    if (a.hasTokens) rec.tokens = num(a.today);
    for (const l of a.limits || []) {
      if (l && typeof l.title === "string" && typeof l.percent === "number" && Number.isFinite(l.percent)) {
        const p = rec.peaks[l.title];
        if (p === undefined || l.percent > p) rec.peaks[l.title] = l.percent;
      }
    }
    rec.resets += resetsByAgent[a.id] | 0;
  }

  // Keep only the KEEP_DAYS most recent calendar days up to and including today;
  // older history and any future-dated entries are dropped.
  const keep = new Set();
  for (let i = 0; i < KEEP_DAYS; i++) keep.add(shiftDate(today, i));
  for (const date of Object.keys(out.days)) if (!keep.has(date)) delete out.days[date];
  return out;
}

// n daily entries for one agent, oldest first, ending today. Missing days get
// tokens: null, peaks: {}, resets: 0.
export function agentSeries(history, agentId, now = Date.now(), n = KEEP_DAYS) {
  const today = localDate(now);
  const series = [];
  for (let i = n - 1; i >= 0; i--) {
    const date = shiftDate(today, i);
    const rec = history?.days?.[date]?.[agentId];
    series.push({
      date,
      tokens: num(rec?.tokens),
      peaks: { ...(rec?.peaks || {}) },
      resets: rec?.resets | 0,
    });
  }
  return series;
}
