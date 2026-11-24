// Claude's own "you've hit your limit" exit. When the real limit is hit, `claude -p` exits with a
// line like "You've hit your 5-hour limit · resets 5:50pm (America/New_York)". That is not a failure:
// the driver writes wall.json in her state dir and pace() treats it as a stop until the time Claude
// stated, whatever the usage reading says (a stale or overridden reading must never resume her
// into a wall). No time she can read means a short wait, then the readings decide again.
import fs from "node:fs";
import path from "node:path";

export const FALLBACK_WAIT_MS = 30 * 60e3;
const MAX_WAIT_MS = 8 * 86400e3;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export const isLimitHit = (text) => /\bhit your\b[^\n]*\blimit\b/i.test(String(text || ""));

// Wall-clock parts of `ms` in time zone `tz` (undefined = this machine's zone).
function partsIn(ms, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month - 1, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
// The UTC instant of a wall-clock time in `tz` (two passes, so a DST change in between is right).
function zoned(y, mo, d, h, mi, tz) {
  const want = Date.UTC(y, mo, d, h, mi);
  let t = want;
  for (let i = 0; i < 2; i++) {
    const p = partsIn(t, tz);
    t += want - Date.UTC(p.y, p.mo, p.d, p.h, p.mi, p.s);
  }
  return t;
}
const validZone = (tz) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } };

// The reset time Claude stated, as epoch ms, or null when the text has none she can read.
// Handles "resets 5:50pm", "resets 5pm (Europe/Berlin)", "resets Nov 30, 5pm (UTC)" and
// "resets Nov 30 at 5:50pm".
export function statedReset(text, now = Date.now()) {
  const m = /\bresets\s+(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,|\s+at)?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(String(text || ""));
  if (!m) return null;
  let h = +m[3]; const mi = m[4] ? +m[4] : 0; const ap = (m[5] || "").toLowerCase();
  if (ap && (h < 1 || h > 12)) return null;
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  const tz = m[6] && validZone(m[6].trim()) ? m[6].trim() : undefined;
  const today = partsIn(now, tz);
  let t;
  if (m[1]) {
    const mo = MONTHS.indexOf(m[1].toLowerCase());
    if (mo < 0) return null;
    t = zoned(today.y, mo, +m[2], h, mi, tz);
    if (t < now - 86400e3) t = zoned(today.y + 1, mo, +m[2], h, mi, tz);
  } else {
    t = zoned(today.y, today.mo, today.d, h, mi, tz);
    if (t <= now - 60e3) t = zoned(today.y, today.mo, today.d + 1, h, mi, tz);
  }
  return t > now - 60e3 && t - now <= MAX_WAIT_MS ? t : null;
}

// For an exit's output: null when it isn't a limit hit, else { until, stated, text }.
export function limitWall(text, now = Date.now()) {
  if (!isLimitHit(text)) return null;
  const line = String(text).split("\n").find((l) => isLimitHit(l)) || "";
  const at = statedReset(line, now) ?? statedReset(text, now);
  return { until: at ?? now + FALLBACK_WAIT_MS, stated: at !== null, text: line.trim().slice(0, 200) };
}

export function wallFile(dir) { return path.join(dir, "wall.json"); }
export function writeWall(dir, wall, now = Date.now()) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(wallFile(dir), JSON.stringify({ until: wall.until, stated: !!wall.stated, text: wall.text || "", at: now }) + "\n");
}
// The wall still standing at `now`, or null.
export function readWall(dir, now = Date.now()) {
  try {
    const w = JSON.parse(fs.readFileSync(wallFile(dir), "utf8"));
    return w && Number.isFinite(w.until) && now < w.until ? w : null;
  } catch { return null; }
}

export const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
