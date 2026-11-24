// Constance's own pacing on the owner's Claude plan. Adaptive, not a fixed budget: for the session
// (5 h) and weekly (7 d) windows it compares how much is used with how much of the window has gone.
//   burn = used / elapsed share. Above 1 she is spending faster than the time allows.
// Modes, from the worse of the two windows:
//   "stop"     a window is at or above STOP_AT: she does nothing more until it resets, so she
//              never runs out (the driver pauses her and picks the goal back up after the reset);
//   "delegate" burning too fast (or above LEAN_AT): she keeps only planning and review, and hands
//              editing and testing to the free agents;
//   "normal"   she keeps hard, risky or architectural work and delegates the routine.
export const WINDOWS = { Session: 5 * 3600e3, Weekly: 7 * 86400e3 };
export const STOP_AT = 0.9;
export const LEAN_AT = 0.7;

export function windowPace(limit, now = Date.now()) {
  const len = WINDOWS[limit.title];
  const used = Number(limit.percent);
  const resetsAt = new Date(String(limit.resetsAt || "")).getTime();
  if (!len || !Number.isFinite(used)) return null;
  // Without a reset time the elapsed share is unknown; judge on the level alone.
  const left = Number.isFinite(resetsAt) ? Math.min(len, Math.max(0, resetsAt - now)) : null;
  const elapsed = left === null ? null : 1 - left / len;
  const burn = elapsed === null ? null : used / Math.max(elapsed, 0.05);
  return { title: limit.title, used, elapsed, burn, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null };
}

export function pace(claude, now = Date.now()) {
  const ws = (claude?.limits || []).map((l) => windowPace(l, now)).filter(Boolean);
  if (ws.length === 0) return { mode: "delegate", windows: [], reason: "Claude's own limits can't be read, so she plays it safe and delegates." };
  const stop = ws.find((w) => w.used >= STOP_AT);
  if (stop) return { mode: "stop", windows: ws, until: stop.resetsAt, reason: `${stop.title} at ${Math.round(stop.used * 100)}%: paused until it resets.` };
  const fast = ws.find((w) => w.used >= LEAN_AT || (w.burn !== null && w.burn > 1 && w.used >= 0.2));
  if (fast) {
    const why = fast.used >= LEAN_AT ? `at ${Math.round(fast.used * 100)}%` : `${Math.round(fast.used * 100)}% used with ${Math.round(fast.elapsed * 100)}% of the window gone`;
    return { mode: "delegate", windows: ws, reason: `${fast.title} ${why}: delegate editing and testing, keep only planning and review.` };
  }
  return { mode: "normal", windows: ws, reason: "On pace: keep hard or risky work, delegate the routine." };
}
