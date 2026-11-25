// Constance's resume plan and her "asked the owner" ledger. resumePlan() answers
// the one question the driver asks every tick while a goal sits paused by Claude's
// own limit wall (wall.json, constance-wall.mjs): wait, resume, or leave it alone.
// She resumes only after the stated reset time plus a 60 s grace (the endpoint's
// reset can land a moment late) and only when the goal is paused BY THE WALL — a
// pause for any other reason is the readings' or the owner's business, never hers.
// logAsk()/askReport() keep the asks: every time she stops to ask the owner goes
// on one JSONL line so the morning report can count them.
import fs from "node:fs";
import path from "node:path";

export const RESUME_GRACE_MS = 60e3;

// The pace() reason a wall pause carries (constance-pace.mjs). Matching it is how
// we know the pause is the wall's and not a readings stop or a Keep going hold.
// Her brain is Claude Code or Antigravity (constance-brain.mjs); either name starts the reason.
const WALL_REASON = /^(Claude|Antigravity) said it hit its limit/;

// { wall, now, goalStatus } -> { action: "wait"|"resume"|"none", until, why }.
// wall is the parsed wall.json ({ until, stated, text, at }) or null; goalStatus
// is the goal object ({ status, pauseReason }) — a bare status string works too.
export function resumePlan(options) {
  const { wall, now = Date.now(), goalStatus } = options || {};
  const g = typeof goalStatus === "string" ? { status: goalStatus } : goalStatus || {};
  if (g.status !== "paused" || !WALL_REASON.test(String(g.pauseReason || "")))
    return { action: "none", until: null, why: "the goal isn't paused by the wall" };
  const until = wall && Number(wall.until);
  if (!Number.isFinite(until))
    return { action: "none", until: null, why: "the wall has no readable reset time" };
  const clock = Number(now);
  if (!Number.isFinite(clock))
    return { action: "none", until: null, why: "the clock is unreadable" };
  const ready = until + RESUME_GRACE_MS;
  if (clock < ready)
    return { action: "wait", until: ready, why: `the wall stands until ${new Date(until).toISOString()}, plus ${RESUME_GRACE_MS / 1000} s` };
  return { action: "resume", until: ready, why: "the reset time plus the grace has passed" };
}

// One line per ask, appended to `file` (JSONL): { reason, at }. `at` defaults to
// now; callers pass their own clock in tests.
export function logAsk(file, { reason, at } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ reason: String(reason || ""), at: Number.isFinite(at) ? at : Date.now() }) + "\n");
}

// Everything asked since `sinceMs` (epoch ms, default: all of it):
// { asked: n, reasons: [reason, ...] } in the order they were logged.
export function askReport(file, sinceMs = 0) {
  const out = { asked: 0, reasons: [] };
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let a;
    try { a = JSON.parse(line); } catch { continue; }
    if (!a || typeof a !== "object") continue;
    const at = Number(a.at);
    if (!Number.isFinite(at) || at < sinceMs) continue;
    out.asked += 1;
    out.reasons.push(String(a.reason || ""));
  }
  return out;
}
