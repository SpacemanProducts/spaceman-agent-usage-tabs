// Constance reset-wake: what to do the moment the lead's Session window resets, and how hard
// to push in the last 24 hours of the week. Pure decisions plus two thin wrappers over
// constance-week.mjs's daily history, so the driver can ask "should the queue start now?"
// without re-deriving pacing rules.
//
// sessionReset: the Session window (5 h, WINDOWS.Session) has reset when its resetsAt has
// passed, or when the reading shows a fresh window — high to low with a resetsAt beyond the
// few-minutes jitter the endpoint adds between fetches (SAME_RESET_MS).
// wakeDecision: start the next queued goal right after that reset, day or night, without
// asking — but never over the owner's pause, a stop for the owner, a running goal, a limit
// at 100%, or a wall still pending.
// finalLanes / logDay / behindLessons: the last-24-hours lane count, the once-a-day curve
// record, and the short lesson lines a behind week earns.
import { curve, longWindow, laneCount, recordDay, CAUSES, windowLength } from "./constance-week.mjs";
import { WINDOWS, HARD_AT, SAME_RESET_MS } from "./constance-pace.mjs";
import { readWall } from "./constance-wall.mjs";

const ms = (v) => { const t = new Date(String(v || "")).getTime(); return Number.isFinite(t) ? t : NaN; };
const sessions = (limits) => (Array.isArray(limits) ? limits : []).filter((l) => windowLength(l) === WINDOWS.Session);

// "Dropped from high to low": at least this much used before, and at least DROP cleared.
const WAS_HIGH = 0.7;
const DROP = 0.5;

// Did the lead's Session window reset between two readings of her limits?
export function sessionReset(prevLimits = [], limits = [], now = Date.now()) {
  const cur = sessions(limits), prev = sessions(prevLimits);
  if (!cur.length) return false;
  for (const c of cur) {
    const cAt = ms(c.resetsAt), cUsed = Number(c.percent);
    // Match the previous reading of the same window: same title, else same reset time.
    const p = prev.find((x) => x.title === c.title)
      || prev.find((x) => Number.isFinite(ms(x.resetsAt)) && Number.isFinite(cAt) && Math.abs(ms(x.resetsAt) - cAt) <= SAME_RESET_MS)
      || null;
    const pAt = p ? ms(p.resetsAt) : NaN, pUsed = p ? Number(p.percent) : NaN;
    // The window's own reset time has passed (a stale reading still showing it counts too).
    const endedAt = Number.isFinite(pAt) ? pAt : cAt;
    if (Number.isFinite(endedAt) && endedAt <= now) return true;
    // Or the reading already shows the next window: high to low, resetsAt moved past jitter.
    if (p && Number.isFinite(pAt) && Number.isFinite(cAt) && Math.abs(cAt - pAt) > SAME_RESET_MS
        && Number.isFinite(pUsed) && Number.isFinite(cUsed) && pUsed >= WAS_HIGH && cUsed <= pUsed - DROP) return true;
  }
  return false;
}

const wallUntil = (w) => (Number.isFinite(w) ? w : Number(w?.until));

// Should the next queued goal start now? `queue` is readGoalQueue()'s shape ({ goals, paused,
// ownerPaused }); `wall` is a pending wall ({ until } or epoch ms) and `dir` her state dir to
// read wall.json from — either may be omitted when the caller already knows there's no wall.
export function wakeDecision({ queue = {}, goalRunning = false, prevLimits = [], limits = [], now = Date.now(), wall, dir } = {}) {
  const no = (why) => ({ start: false, why });
  if (!sessionReset(prevLimits, limits, now)) return no("no session reset");
  if (queue.ownerPaused) return no("you paused the queue");
  if (queue.paused) return no(`the queue is paused: ${queue.paused}`);
  if (goalRunning) return no("a goal is already running");
  if (!(Array.isArray(queue.goals) && queue.goals.length)) return no("the queue is empty");
  const list = Array.isArray(limits) ? limits : (Array.isArray(limits?.limits) ? limits.limits : []);
  if (list.some((l) => Number(l?.percent) >= HARD_AT)) return no("a limit is at 100%");
  const pending = wallUntil(wall) ?? (dir ? wallUntil(readWall(dir, now)) : NaN);
  if (Number.isFinite(pending) && pending > now) return no("a wall is still pending");
  return { start: true, why: "the session window reset" };
}

// Parallel lead lanes for the last 24 hours before the weekly reset, when substantial room
// remains. laneCount() already refuses without room, an empty backlog or a hot session, and
// caps by the session limit — this just builds the week's curve from the raw limits. Returns
// laneCount()'s { lanes, why }.
export function finalLanes({ limits = [], openItems = 0, running = 0, settings = {}, now = Date.now() } = {}) {
  const c = curve(longWindow(limits, now), now);
  return laneCount({ c, limits, openItems, running, settings, now });
}

// One history record for this calendar day (recordDay keeps a single record per day and
// merges the day's causes into it). `limits` are the lead's raw limit bars.
export function logDay(dir, { limits = [], causes = [], lead = "claude", now = Date.now() } = {}) {
  const c = curve(longWindow(limits, now), now);
  return recordDay(dir, { c, lead, causes, now });
}

// 1-3 lesson lines naming what kept her behind, newest day first, from the day's recorded
// causes (constance-week.mjs CAUSES). Empty when no recorded day closed behind.
export function behindLessons(history = []) {
  const seen = new Set(), out = [];
  for (let i = history.length - 1; i >= 0 && out.length < 3; i--) {
    const d = history[i];
    if (!d || d.status !== "behind") continue;
    for (const k of d.causes || []) {
      if (!CAUSES[k] || seen.has(k)) continue;
      seen.add(k); out.push(CAUSES[k]);
      if (out.length >= 3) break;
    }
  }
  return out;
}
