// Constance's progress ping: one line for her Now row — what the free
// workers have burned, what that buys per 1% of her own session window, how
// many copies are running and where the session stands — plus a throttled
// notify-send so the owner sees the pace without watching the panel.
// progressLine() is pure; due() keeps the once-per-interval stamp in a small
// JSON file; notify() runs notify-send through an injected exec; tick()
// combines them and always returns the line.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CANT_TELL, fmtTokens } from "./constance-tokens.mjs";

const pct = (n) => (Number.isFinite(n) ? String(+n.toFixed(1)) : "?");

// "Workers 42M · 4.2M per 1% of session (target 5M) · 9 copies running · session 62%".
// perPct = workerTokens / max(0.1, sessionUsedPct - sessionStartPct): the 0.1
// floor keeps a barely-moved window from producing a silly number, and a
// non-positive delta (nothing spent yet, or the window just reset) says so
// instead of dividing. Unknown tokens are "can't tell", never a guess.
// workerTokens is the total across all free workers; devinTokens is the old
// name, still accepted when workerTokens is absent.
export function progressLine({ workerTokens, devinTokens, sessionUsedPct, sessionStartPct, copiesRunning = 0, target = 5e6 } = {}) {
  const rawTokens = workerTokens ?? devinTokens;
  const tokens = Number.isFinite(rawTokens) ? rawTokens : null;
  const goal = Number.isFinite(target) ? target : null;
  const used = Number(sessionUsedPct);
  const delta = used - Number(sessionStartPct);
  const spent = delta > 0;
  const perPct = spent && tokens !== null ? tokens / Math.max(0.1, delta) : null;
  const pace = !spent ? "no session spent yet"
    : perPct === null ? `${CANT_TELL} per 1% of session (target ${fmtTokens(goal)})`
    : `${fmtTokens(perPct)} per 1% of session (target ${fmtTokens(goal)})`;
  const copies = Number.isFinite(copiesRunning) ? copiesRunning : 0;
  return `Workers ${fmtTokens(tokens)} · ${pace} · ${copies} ${copies === 1 ? "copy" : "copies"} running · session ${pct(used)}%`;
}

// True at most once per `every` ms: the stamp { at } lives in stateFile, so a
// restart doesn't re-notify inside the interval. A missing or broken file
// counts as never notified. The write is best-effort — a failed write still
// reports due; the next call simply tries again.
export function due(stateFile, now = Date.now(), every = 15 * 60e3) {
  let last = 0;
  try { last = Number(JSON.parse(fs.readFileSync(stateFile, "utf8")).at) || 0; } catch {}
  if (last > 0 && now - last < every) return false;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ at: now }) + "\n");
  } catch {}
  return true;
}

// One silent desktop notification: app "Constance", title "Constance", the
// progress line as body, sound suppressed. `exec` is injectable for tests —
// it takes (cmd, args, opts) like spawnSync and returns its result.
export function notify(line, { exec = spawnSync } = {}) {
  try {
    const r = exec("notify-send", ["-a", "Constance", "-h", "boolean:suppress-sound:true", "Constance", String(line)], { timeout: 5000, stdio: "ignore" });
    return !r || r.status === 0;
  } catch { return false; }
}

// The whole ping: build the line, notify only when due, and hand back both —
// the line is for her Now row whether or not a notification went out. Without
// a stateFile there is nowhere to throttle, so it never notifies.
export function tick({ stateFile, now = Date.now(), every = 15 * 60e3, exec, ...rest } = {}) {
  const line = progressLine(rest);
  if (!stateFile || !due(stateFile, now, every)) return { line, notified: false };
  return { line, notified: notify(line, { exec }) };
}
