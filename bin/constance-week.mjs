// Weekly-aware pacing: never waste the lead's weekly limit, and never run out of it.
//
// The week's limit spread evenly over the week gives the expected use at any moment (day 3 of 7 is
// 3/7 = 43%). The lead's real reading against it says "behind", "on pace" or "ahead". The owner's
// intensity setting (0 = delegate everything, 100 = the lead does the substantial work) is the
// starting point; she drifts from it a little at a time and always says how far:
//   behind          drift up (more lead work) and open extra read-only lanes from the backlog;
//   ahead           drift down, toward max delegation;
//   on pace         drift back to the owner's setting;
//   last 24 hours   with real room left: full drift, as many lanes as the session limit allows.
// None of this moves the stop lines in constance-pace.mjs: those still win.
// Pure functions, except the small history reader/writer at the bottom.
import fs from "node:fs";
import path from "node:path";
import { WINDOWS, STOP_AT, NEAR_END_AT, NEAR_RESET_SHARE, LEAN_AT } from "./constance-pace.mjs";
import { readMilk, DEFAULT_MILK } from "./constance-milk.mjs";

export const HOUR = 3600e3;
export const DAY = 24 * HOUR;
export const TOLERANCE = 0.05;          // within 5 points of the even-spread curve is "on pace"
export const DRIFT_GAIN = 3;            // intensity points of drift per point of gap
export const DRIFT_PER_HOUR = 20;       // how fast she drifts
export const FIRST_STEP = 10;           // the first move after a fresh start or a changed setting
export const FINAL_MS = DAY;            // "the last 24 hours before the weekly reset"
export const SUBSTANTIAL = 0.10;        // weekly room worth spending in that stretch
export const LANE_COST = 0.08;          // session share one deep-review lane is assumed to use (a setting)
export const MAX_LANES = 4;             // extra lanes while merely behind (a setting)
export const HARD_LANES = 10;           // never more than this, whatever the session allows
export const DEFAULT_INTENSITY = DEFAULT_MILK;

// A meter's window length from its title ("Weekly", "Gemini Session", "Monthly") or its `window`
// field; 0 when it isn't a time window we know.
export function windowLength(limit) {
  const t = String(limit?.title || "").toLowerCase(), w = String(limit?.window || "").toLowerCase();
  if (t.endsWith("session")) return WINDOWS.Session;
  if (t.endsWith("weekly")) return WINDOWS.Weekly;
  if (t.endsWith("monthly") || w === "monthly") return 30 * 86400e3;
  if (t.endsWith("daily")) return 86400e3;
  return 0;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (v, fallback) => (v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : fallback);

// The owner's slider (constanceMilk, constance-milk.mjs) is the starting point.
export const intensitySetting = (settings = {}) => readMilk(settings);

// The lead's long window: Weekly when it has one (the fullest, if several pools), else Monthly.
export const sameWeek = (a, b) => a === b || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < HOUR);
export function longWindow(limits = [], now = Date.now()) {
  const usable = limits.map((l) => {
    const len = windowLength(l), resetsAt = new Date(String(l.resetsAt || "")).getTime(), used = Number(l.percent);
    return len >= 7 * DAY && Number.isFinite(resetsAt) && resetsAt > now && Number.isFinite(used) ? { title: l.title, used, resetsAt, len } : null;
  }).filter(Boolean);
  const pick = (list) => list.sort((a, b) => b.used - a.used)[0] || null;
  return pick(usable.filter((w) => w.len === 7 * DAY)) || pick(usable);
}

// Where the lead stands against the even spread.
export function curve(window, now = Date.now()) {
  if (!window) return { status: "unknown", expected: null, used: null, gap: null, elapsed: null, day: null, days: null, leftMs: null, resetsAt: null, title: "" };
  const leftMs = clamp(window.resetsAt - now, 0, window.len);
  const elapsed = 1 - leftMs / window.len;
  const gap = window.used - elapsed;
  // A hair of slack so exactly 5 points either way counts as on pace.
  const status = gap < -TOLERANCE - 1e-9 ? "behind" : gap > TOLERANCE + 1e-9 ? "ahead" : "on pace";
  return { status, expected: elapsed, used: window.used, gap, elapsed, leftMs, resetsAt: window.resetsAt, title: window.title,
    // "Day 3 of 7" runs up to the end of the third day, where the even spread reaches 3/7.
    day: Math.min(Math.round(window.len / DAY), Math.max(1, Math.ceil(elapsed * window.len / DAY - 1e-6))), days: Math.round(window.len / DAY) };
}

// The last 24 hours with substantial room: spend it.
export function finalStretch(c, substantial = SUBSTANTIAL) {
  return c.status !== "unknown" && c.leftMs > 0 && c.leftMs <= FINAL_MS && 1 - c.used >= substantial - 1e-9;
}

export function targetDrift(c, manual) {
  if (c.status === "unknown") return 0;
  if (finalStretch(c)) return 100 - manual;
  if (c.status === "behind") return clamp(Math.round(-c.gap * 100 * DRIFT_GAIN), 0, 100 - manual);
  if (c.status === "ahead") return -clamp(Math.round(c.gap * 100 * DRIFT_GAIN), 0, manual);
  return 0;
}

// One step of the drift. `state` is what the last step returned (or null). Moving the slider or a
// weekly reset starts over from the owner's setting.
export function stepDrift(state, { manual, c, now = Date.now() }) {
  const target = targetDrift(c, manual);
  const same = state && state.manual === manual && sameWeek(state.resetsAt, c.resetsAt);
  const from = same ? state.drift : 0;
  let drift;
  if (finalStretch(c)) drift = target;               // no time left to ease into it
  else {
    const step = same ? DRIFT_PER_HOUR * Math.max(0, now - state.at) / HOUR : FIRST_STEP;
    drift = from + clamp(target - from, -step, step);
  }
  drift = clamp(drift, -manual, 100 - manual);
  return { manual, drift, target, at: now, resetsAt: c.resetsAt };
}

export function intensityView(state, c) {
  const manual = state.manual, drift = Math.round(state.drift), effective = clamp(manual + drift, 0, 100);
  const why = finalStretch(c) ? "last 24 hours, spending what's left" : c.status === "behind" ? "behind pace" : c.status === "ahead" ? "ahead of pace" : "easing back";
  const text = drift === 0 ? `At your setting (${manual}%)`
    : `Your setting ${manual}% · running at ${effective}% (${drift > 0 ? "+" : ""}${drift} toward ${drift > 0 ? "more lead work" : "delegation"}, ${why})`;
  return { manual, drift, effective, text };
}

// Room under the stop line for one window, 0 when it is at or past it.
export function headroom(limit, now = Date.now()) {
  const len = windowLength(limit), used = Number(limit?.percent);
  if (!len || !Number.isFinite(used)) return null;
  const at = new Date(String(limit.resetsAt || "")).getTime();
  const near = Number.isFinite(at) && at - now <= len * NEAR_RESET_SHARE;
  return Math.max(0, (near ? NEAR_END_AT : STOP_AT) - used);
}

// How many extra lanes should be running now, and why not more. Lanes only ever take real backlog
// items (`openItems`), so an empty backlog means no lanes, never filler.
export function laneCount({ c, limits = [], openItems = 0, stopped = false, running = 0, settings = {}, now = Date.now() }) {
  const none = (why) => ({ lanes: 0, why });
  if (stopped) return none("paused at a limit");
  if (c.status === "unknown") return none("weekly usage can't be read");
  const burn = finalStretch(c);
  if (!burn && c.status !== "behind") return none(c.status === "ahead" ? "ahead of pace" : "on pace");
  if (openItems <= 0) return none("the backlog is empty");
  const cost = clamp(num(settings.constanceLaneCost, LANE_COST), 0.01, 0.5);
  const sessions = limits.filter((l) => windowLength(l) < DAY).map((l) => headroom(l, now)).filter((h) => h !== null);
  const longs = limits.filter((l) => windowLength(l) >= 7 * DAY && !/fable/i.test(l.title || "")).map((l) => headroom(l, now)).filter((h) => h !== null);
  if (longs.some((h) => h < 0.01)) return none("the weekly limit is at its stop line");
  // Without a session window the long window's own room is what caps the lanes.
  const room = sessions.length ? Math.min(...sessions) : longs.length ? Math.min(...longs) : 0;
  // Running lanes are already spending that room, so they count inside it.
  const fits = Math.floor(room / cost + 1e-9);
  if (fits <= 0) return { lanes: 0, why: "no room left in the session limit" };
  const most = burn ? HARD_LANES : Math.min(clamp(Math.floor(num(settings.constanceMaxLanes, MAX_LANES)), 0, HARD_LANES), 1 + Math.floor(-c.gap / 0.05 + 1e-9));
  const lanes = Math.max(0, Math.min(most, fits, openItems + running));
  const why = lanes === fits && fits < most ? "capped by the session limit" : lanes === openItems + running && lanes < most ? "capped by the backlog" : burn ? "last 24 hours" : "behind pace";
  return { lanes, why };
}

// Base pace (constance-pace.mjs) plus the week: "push" replaces delegate/normal while the week is
// behind or in its last stretch and the session is not already running hot. "stop" always stands.
export function weekMode(base, c, limits = []) {
  if (base.mode === "stop") return { mode: "stop", reason: base.reason };
  if (c.status !== "behind" && !finalStretch(c)) return { mode: c.status === "ahead" ? "delegate" : base.mode, reason: c.status === "ahead"
    ? `${c.title} is ahead of pace (${pct(c.used)} used, ${pct(c.expected)} expected): delegate as much as possible.` : base.reason };
  const hot = limits.find((l) => windowLength(l) < DAY && Number(l.percent) >= LEAN_AT);
  if (hot) return { mode: "delegate", reason: `${c.title} is behind pace, but ${hot.title} is at ${pct(Number(hot.percent))}: delegate until it resets.` };
  return { mode: "push", reason: finalStretch(c)
    ? `Last 24 hours of the ${c.title.toLowerCase()} window with ${pct(1 - c.used)} left: run every lane the session allows.`
    : `${c.title} is behind pace (${pct(c.used)} used, ${pct(c.expected)} expected): take on more yourself and open backlog lanes.` };
}
const pct = (f) => `${Math.round(f * 100)}%`;

// ---------------------------------------------------------------- history and lessons

// What kept her behind, in a fixed set so a lesson is written once per cause, not once per day.
export const CAUSES = {
  "backlog-empty": "Behind weekly pace with an empty backlog: during each goal add real deep reviews, audits, architecture reviews and hard bugs to .constance/backlog.md.",
  "session-full": "Behind weekly pace because the session limit filled up: start heavy lead work early in each session so more sessions fit in the week.",
  "paused": "Behind weekly pace while paused at a limit: queue goals so work restarts the moment the session resets.",
  "practice": "Behind weekly pace in practice mode: nothing real launches until the owner turns Practice off.",
  "not-running": "Behind weekly pace on days with no goal running: queue goals ahead of time so nights and idle days still get used.",
  "lane-failed": "Behind weekly pace after backlog lanes failed: read the lane report and log before opening more.",
};

export function historyFile(dir) { return path.join(dir, "week-history.json"); }
export function readHistory(dir) {
  try { const d = JSON.parse(fs.readFileSync(historyFile(dir), "utf8")); return Array.isArray(d.days) ? d.days : []; }
  catch { return []; }
}
function writeHistory(dir, days) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = historyFile(dir) + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ days: days.slice(-120) }, null, 2) + "\n");
  fs.renameSync(tmp, historyFile(dir));
}
export const dayKey = (now) => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// One record per local day: the day's latest reading against the curve, plus every cause seen that
// day. Returns the lessons that just became due: a day that closed behind teaches its causes.
export function recordDay(dir, { c, lead = "claude", causes = [], now = Date.now() }) {
  if (c.status === "unknown") return { lessons: [] };
  const days = readHistory(dir), date = dayKey(now), lessons = [];
  const last = days[days.length - 1];
  if (last && last.date < date && !last.closed) {
    last.closed = true;
    if (last.status === "behind") for (const k of last.causes || []) if (CAUSES[k]) lessons.push(CAUSES[k]);
  }
  let today = days.find((d) => d.date === date);
  if (!today) { today = { date, causes: [] }; days.push(today); }
  Object.assign(today, { lead, window: c.title, resetsAt: c.resetsAt, used: round(c.used), expected: round(c.expected), gap: round(c.gap), status: c.status, at: now });
  today.causes = [...new Set([...(today.causes || []), ...causes.filter((k) => CAUSES[k])])];
  writeHistory(dir, days);
  return { lessons };
}
const round = (n) => Math.round(n * 1000) / 1000;
