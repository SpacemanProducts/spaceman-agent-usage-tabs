// Grok's free per-model cap (e.g. 600K tokens per rolling 24 h for grok-4.7) is not in either
// billing endpoint. Grok's own log (~/.grok/logs/unified.jsonl) has two things we can use:
//  - the 429 a turn gets when it hits the cap, with the real count ("tokens (actual/limit): N/M");
//  - every model call's tokens (shell.turn.inference_done), from which we estimate the 24 h total.
// Estimate = uncached input + 1/4 of cached input + output. On 2026-11-23 that gave 647K for the
// 24 h before a hit Grok counted as 674K; the latest hit's ratio corrects the estimate.
// Read-only. Returns a limit row (cap: true), or null when there is nothing to show.
const DAY = 24 * 60 * 60 * 1000;
const WALL = /subscription:[a-z-]*usage-exhausted: (.*?) for model ([\w.-]+)[\s\S]*?tokens \(actual\/limit\): (\d+)\/(\d+)/;
const DEFAULT = { model: "grok-4.7", limit: 600000 };   // what Grok's error reported on 2026-11-23

const weight = (c) => Math.max(0, (+c.prompt_tokens || 0) - 0.75 * (+c.cached_prompt_tokens || 0)) + (+c.completion_tokens || 0);
const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : Math.round(n / 1e3) + "K");
const NOTE = "Grok doesn't report how much is left.";

export function grokWall(logText, nowMs = Date.now(), { free = true } = {}) {
  let wall = null, lastWall = null;
  const calls = [];
  for (const line of String(logText || "").split("\n")) {
    if (!line.includes("inference_")) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts)) continue;
    if (e.msg === "shell.turn.inference_failed") {
      const m = WALL.exec(String(e.ctx?.message || ""));
      if (m) wall = lastWall = { ts, model: m[2], actual: +m[3], limit: +m[4] };
    } else if (e.msg === "shell.turn.inference_done") {
      calls.push({ ts, w: weight(e.ctx || {}) });
      if (wall && ts > wall.ts) wall = null;   // a later call went through: the wall has lifted
    }
  }
  const sum = (from, to) => calls.reduce((a, c) => (c.ts > from && c.ts <= to ? a + c.w : a), 0);
  const model = lastWall?.model || DEFAULT.model, limit = lastWall?.limit > 0 ? lastWall.limit : DEFAULT.limit;
  const title = `Free ${model} (24 h)`;

  // Hit and not lifted: red, with Grok's own count. Every token it counted was spent before the
  // hit, so the rolling window is fully clear 24 h later at the latest.
  if (wall && nowMs < wall.ts + DAY && wall.limit > 0)
    return { title, cap: true, percent: 1, resetsAt: new Date(wall.ts + DAY).toISOString(), hitAt: new Date(wall.ts).toISOString(),
      note: `Grok hit this limit: ${k(wall.actual)} of ${k(wall.limit)} tokens. ${NOTE} Rolling window, so it may free up sooner.` };

  if (!free && !lastWall) return null;   // the cap is a free-plan limit; nothing seen, nothing shown
  let ratio = 1;
  if (lastWall) { const raw = sum(lastWall.ts - DAY, lastWall.ts); if (raw > 0) ratio = Math.max(0.5, Math.min(2, lastWall.actual / raw)); }
  const used = sum(nowMs - DAY, nowMs) * ratio;
  // Not hit, so never shown as full: a hit is what Grok reports, not our estimate.
  return { title, cap: true, percent: Math.min(0.99, used / limit), resetsAt: "",
    note: `About ${k(used)} of ${k(limit)} tokens in the last 24 h, estimated from Grok's log. ${NOTE}` };
}
