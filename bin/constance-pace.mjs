// Constance's own pacing on the owner's Claude plan. Adaptive, not a fixed budget: for the session
// (5 h) and weekly (7 d) windows it compares how much is used with how much of the window has gone.
//   burn = used / elapsed share. Above 1 she is spending faster than the time allows.
// Modes, from the worse of the two windows:
//   "stop"     a window is at or above its stop line: she does nothing more until it resets, so she
//              never runs out (the driver pauses her and picks the goal up after the reset);
//   "delegate" burning too fast (or above LEAN_AT): she keeps only planning and review, and hands
//              editing and testing to the free agents;
//   "normal"   she keeps hard, risky or architectural work and delegates the routine.
// The stop line is STOP_AT, except in the last NEAR_RESET_SHARE of a window, where it moves to
// NEAR_END_AT: with the reset close she keeps planning, review and merges going (delegate mode)
// and only stops in the last few percent, so she never runs out before the reset.
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./constance-jobs.mjs";
import { readWall, clock } from "./constance-wall.mjs";

export const WINDOWS = { Session: 5 * 3600e3, Weekly: 7 * 86400e3 };
export const STOP_AT = 0.9;
export const NEAR_END_AT = 0.97;
export const NEAR_RESET_SHARE = 0.2;
export const LEAN_AT = 0.7;
// At 100% the real limit is hit: Claude can't answer at all, so nothing (not even Keep going)
// lets her run until that window resets.
export const HARD_AT = 1;
// The usage endpoint's resets_at moves by fractions of a second between fetches; Keep going still
// means the same window within this much.
export const SAME_RESET_MS = 5 * 60e3;

export function windowPace(limit, now = Date.now()) {
  const len = WINDOWS[limit.title];
  const used = Number(limit.percent);
  const resetsAt = new Date(String(limit.resetsAt || "")).getTime();
  if (!len || !Number.isFinite(used)) return null;
  // Without a reset time the elapsed share is unknown; judge on the level alone.
  const left = Number.isFinite(resetsAt) ? Math.min(len, Math.max(0, resetsAt - now)) : null;
  const elapsed = left === null ? null : 1 - left / len;
  const burn = elapsed === null ? null : used / Math.max(elapsed, 0.05);
  return { title: limit.title, used, elapsed, burn, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    nearReset: left !== null && left <= len * NEAR_RESET_SHARE };
}

// The owner's "Keep going" button (the panel) drops keep-going.json in her state dir:
// { title, resetsAt, at }. While it matches a window — same title and same reset time — that
// window can't pause her; the owner takes the risk. It expires by itself: a reset changes
// resetsAt so the match can't outlive the window, and a window with no reset time only honors
// it for one window length from when it was written.
export function keepGoingFile(dir = stateDir()) { return path.join(dir, "keep-going.json"); }
export function readKeepGoing(dir = stateDir(), now = Date.now()) {
  try {
    const kg = JSON.parse(fs.readFileSync(keepGoingFile(dir), "utf8"));
    if (!kg || typeof kg.title !== "string") return null;
    return { title: kg.title, resetsAt: Number.isFinite(kg.resetsAt) ? kg.resetsAt : null, at: Number(kg.at) || 0 };
  } catch { return null; }
}
const sameReset = (a, b) => (a === null || b === null ? a === b : Math.abs(a - b) <= SAME_RESET_MS);
const keepGoingFor = (w, kg, now) =>
  !!kg && w.title === kg.title && sameReset(w.resetsAt, kg.resetsAt) &&
  (kg.resetsAt !== null ? now < kg.resetsAt : now - kg.at < (WINDOWS[w.title] || 0));

export function pace(claude, now = Date.now(), dir = stateDir()) {
  const ws = (claude?.limits || []).map((l) => windowPace(l, now)).filter(Boolean);
  // Claude itself said the limit is hit (constance-wall.mjs): that beats any reading.
  const wall = readWall(dir, now);
  if (wall) return { mode: "stop", hard: true, windows: ws, until: wall.until, title: "Claude's limit",
    reason: `Claude said it hit its limit; paused until ${wall.stated ? clock(wall.until) : `${clock(wall.until)} (no reset time given), then the readings decide`}.` };
  const hard = ws.find((w) => w.used >= HARD_AT);
  if (hard) return { mode: "stop", hard: true, windows: ws, until: hard.resetsAt, title: hard.title, reason: `${hard.title} at 100%: the limit is hit, paused until it resets.` };
  if (ws.length === 0) return { mode: "delegate", windows: [], reason: "Claude's own limits can't be read, so she plays it safe and delegates." };
  const kg = readKeepGoing(dir, now);
  const stopAt = (w) => (keepGoingFor(w, kg, now) ? Infinity : w.nearReset ? NEAR_END_AT : STOP_AT);
  const stop = ws.find((w) => w.used >= stopAt(w));
  if (stop) return { mode: "stop", windows: ws, until: stop.resetsAt, title: stop.title, reason: `${stop.title} at ${Math.round(stop.used * 100)}%: paused until it resets.` };
  // Past the normal pause line but not stopping: either its reset is close (she rides it out on
  // delegate pace to NEAR_END_AT) or the owner pressed Keep going.
  const held = ws.filter((w) => w.used >= STOP_AT).sort((a, b) => b.used - a.used)[0];
  if (held) {
    const reason = keepGoingFor(held, kg, now)
      ? `${held.title} at ${Math.round(held.used * 100)}%: you chose Keep going, so she delegates the rest and keeps only planning, review and merges.`
      : `${held.title} at ${Math.round(held.used * 100)}% and its reset is close: she keeps planning, review and merges and delegates the rest, stopping only at ${Math.round(NEAR_END_AT * 100)}% so she never runs out.`;
    return { mode: "delegate", windows: ws, reason };
  }
  const fast = ws.find((w) => w.used >= LEAN_AT || (w.burn !== null && w.burn > 1 && w.used >= 0.2));
  if (fast) {
    const why = fast.used >= LEAN_AT ? `at ${Math.round(fast.used * 100)}%` : `${Math.round(fast.used * 100)}% used with ${Math.round(fast.elapsed * 100)}% of the window gone`;
    return { mode: "delegate", windows: ws, reason: `${fast.title} ${why}: delegate editing and testing, keep only planning and review.` };
  }
  return { mode: "normal", windows: ws, reason: "On pace: keep hard or risky work, delegate the routine." };
}

// A paused goal picks up again only when pace isn't "stop" AND the reading is current: limits
// present and not flagged unsure (a cached reading the collector couldn't refresh). An old or
// missing reading can't prove the limit is gone. Keep going is the owner's own call.
export const keptGoing = (p) => /Keep going/.test(p?.reason || "");
export function canResume(p, claude) {
  if (!p || p.mode === "stop") return false;
  return keptGoing(p) || !!(claude && (claude.limits || []).length && !claude.unsure);
}
