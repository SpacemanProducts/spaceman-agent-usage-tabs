// Grok's free per-model cap (e.g. "600000 tokens per rolling 24 h for grok-4.7") is not in
// either billing endpoint; Grok only reports it as a 429 when a turn hits it. Its own log
// (~/.grok/logs/unified.jsonl) records that error, so we read the latest one from there.
// Read-only. Returns a limit row, or null when there is no current wall.
const DAY = 24 * 60 * 60 * 1000;
const WALL = /subscription:[a-z-]*usage-exhausted: (.*?) for model ([\w.-]+)[\s\S]*?tokens \(actual\/limit\): (\d+)\/(\d+)/;

export function grokWall(logText, nowMs = Date.now()) {
  let wall = null;
  for (const line of String(logText || "").split("\n")) {
    if (!line.includes("inference_")) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts)) continue;
    if (e.msg === "shell.turn.inference_failed") {
      const m = WALL.exec(String(e.ctx?.message || ""));
      if (m) wall = { ts, model: m[2], actual: +m[3], limit: +m[4] };
    } else if (e.msg === "shell.turn.inference_done" && wall && ts > wall.ts) {
      wall = null;   // a later turn went through: the wall has lifted
    }
  }
  // Every token counted at the wall was spent before it, so a rolling 24 h window is
  // fully clear 24 h later at the latest (it can free up sooner, bit by bit).
  if (!wall || !(wall.limit > 0) || nowMs >= wall.ts + DAY) return null;
  const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : Math.round(n / 1e3) + "K");
  return {
    title: `Free ${wall.model} (24 h)`,
    percent: Math.max(0, Math.min(1, wall.actual / wall.limit)),
    resetsAt: new Date(wall.ts + DAY).toISOString(),
    note: `Grok hit this limit: ${k(wall.actual)} of ${k(wall.limit)} tokens. Rolling window, so it may free up sooner.`,
    hitAt: new Date(wall.ts).toISOString(),
  };
}
