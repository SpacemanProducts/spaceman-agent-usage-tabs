// "Use it or lose it": when an agent's limit window resets soon and its pace says room will be
// left over at the reset, that room may go to worthwhile backlog work instead of evaporating.
// Room is only ever offered, never burned for nothing: an agent near a wall (any limit at 85%
// or more) has no spare windows, and Constance herself (Claude Opus) only takes the work kinds
// she is good at — reviews, tangled bugs and design — while the free agents take the rest.
import { WINDOWS } from "./constance-pace.mjs";

// How soon a reset must be for leftover room to count as "about to be lost": the session
// window is 5 h and the weekly one 7 d, so a session reset within the hour and a weekly reset
// within a day are the cases where unused room really does go to waste. Other window titles
// (a plan's own names) get DEFAULT_SOON.
export const SOON = { Session: 60 * 60e3, Weekly: 24 * 3600e3 };
export const DEFAULT_SOON = 6 * 3600e3;
export const MIN_LEFT = 0.25;

// The share of the window projected to still be unused when it resets, or null when the limit
// can't support a projection (no percent, no valid future resetsAt). With a known window length
// and some of it already gone, the burn rate so far (used / elapsed) is carried to the reset;
// without that, only the current level is known and it is projected flat.
export function leftAtReset(limit, now = Date.now()) {
  const used = Number(limit?.percent);
  const resetsAt = new Date(String(limit?.resetsAt || "")).getTime();
  if (!Number.isFinite(used) || !Number.isFinite(resetsAt) || resetsAt <= now) return null;
  const msUntilReset = resetsAt - now;
  const len = WINDOWS[limit.title];
  const elapsedMs = len ? len - msUntilReset : 0;
  const projected = len && elapsedMs > 0 ? used + (used / elapsedMs) * msUntilReset : used;
  return Math.max(0, 1 - Math.min(1, projected));
}

// The windows of one agent that reset soon and would still have MIN_LEFT or more unused at the
// reset — the room that would go to waste. An agent with any limit at 85% or more is near a
// wall and gets nothing at all.
export function spareWindows(agent, now = Date.now()) {
  const limits = agent?.limits || [];
  if (limits.some((l) => Number(l?.percent) >= 0.85)) return [];
  return limits
    .map((l) => {
      const left = leftAtReset(l, now);
      const resetsAt = new Date(String(l?.resetsAt || "")).getTime();
      return { title: l?.title, used: Number(l?.percent), resetsAt, left };
    })
    .filter((w) => w.left !== null && w.resetsAt - now <= (SOON[w.title] ?? DEFAULT_SOON) && w.left >= MIN_LEFT)
    .map((w) => ({ agent: agent.id, title: w.title, used: w.used, resetsAt: w.resetsAt, left: w.left }))
    .sort((a, b) => a.resetsAt - b.resetsAt);
}

export function useItOrLoseItOn(settings) { return settings?.constanceUseItOrLoseIt !== false; }

// The work only Constance herself takes with her leftover room: reviews, tangled bugs and
// design. Everything else goes to the free agents.
export const OPUS_KINDS = ["review", "bug", "design"];

const openItems = (backlog) => (backlog || []).filter((b) => b && b.done !== true && typeof b.text === "string" && b.text.trim() !== "");
const opusItem = (b) => OPUS_KINDS.includes(b.kind);

// Decides which backlog items go to which agent's soon-resetting spare room. Agents are served
// in order of soonest reset first; each takes at most perAgent items, each item goes to at most
// one agent, and Constance takes only OPUS_KINDS while every other agent must be in `available`
// and takes only the other kinds.
export function planSpare({ agents = [], available = [], backlog = [], now = Date.now(), settings = {}, perAgent = 2 } = {}) {
  if (!useItOrLoseItOn(settings)) return { on: false, picks: [], reason: "use it or lose it is off" };
  // One pick per agent, on its soonest-resetting spare window; agents sorted by that reset.
  const free = new Set(available);
  const candidates = (agents || [])
    .map((a) => ({ agent: a, window: spareWindows(a, now)[0] }))
    .filter((c) => c.window && (c.agent.id === "claude" || free.has(c.agent.id)))
    .sort((a, b) => a.window.resetsAt - b.window.resetsAt);
  if (candidates.length === 0) return { on: true, picks: [], reason: "no agent has room it would lose before a reset" };
  const items = openItems(backlog);
  if (items.length === 0) return { on: true, picks: [], reason: "nothing worthwhile in the backlog, so the spare room is left alone" };
  const pool = [...items];
  const picks = [];
  for (const { agent, window } of candidates) {
    const want = agent.id === "claude" ? opusItem : (b) => !opusItem(b);
    const taken = [];
    for (let i = pool.length - 1; i >= 0 && taken.length < perAgent; i--) {
      if (want(pool[i])) { taken.unshift(pool.splice(i, 1)[0]); }
    }
    if (taken.length > 0) picks.push({ agent: agent.id, window: { title: window.title, resetsAt: window.resetsAt, left: window.left }, items: taken });
  }
  // Picks can only be empty here when no open item fits any candidate's kind rule.
  if (picks.length === 0) return { on: true, picks: [], reason: "nothing worthwhile in the backlog, so the spare room is left alone" };
  const named = picks.map((p) => `${p.agent} (${p.window.title})`).join(", ");
  const count = picks.reduce((n, p) => n + p.items.length, 0);
  return { on: true, picks, reason: `${count} backlog ${count === 1 ? "item goes" : "items go"} to spare room that would be lost: ${named}.` };
}
