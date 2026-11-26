// Weekly pace wire: the one call the driver and `status` share for "where does the week stand
// and how hard should she work right now". Thin glue over constance-week.mjs — the curve, the
// drift, the lanes and the owner's slider all live there; nothing here re-implements them.
// Returns null when there is no readable weekly (or monthly) window: no data, no guess.
import fs from "node:fs";
import path from "node:path";
import { longWindow, curve, stepDrift, intensitySetting, laneCount, finalStretch } from "./constance-week.mjs";

// The drift state stepDrift returns, persisted between runs so the drift eases instead of jumping.
export function weekStateFile(dir) { return path.join(dir, "week-state.json"); }
export function readWeekState(dir) {
  try {
    const d = JSON.parse(fs.readFileSync(weekStateFile(dir), "utf8"));
    return d && typeof d === "object" ? d : null;
  } catch { return null; }
}
export function writeWeekState(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = weekStateFile(dir) + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state ?? null, null, 2) + "\n");
  fs.renameSync(tmp, weekStateFile(dir));
}

// One glance at the week: pace against the even spread, the drifted intensity, the extra lanes.
// `state` is the last stepDrift result (or null); the returned `state` is what to persist.
export function weekStatus(opts = {}) {
  try {
    const { limits = [], settings = {}, state = null, openItems = 0, running = 0, stopped = false, now = Date.now() } = opts || {};
    const ls = Array.isArray(limits) ? limits : [];
    const w = longWindow(ls, now);
    const c = curve(w, now);
    if (c.status === "unknown") return null;
    const manual = intensitySetting(settings);
    const next = stepDrift(state, { manual, c, now });
    const count = (v) => (v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : 0);
    const l = laneCount({ c, limits: ls, openItems: count(openItems), running: count(running), stopped, settings, now });
    const drift = Math.round(next.drift);
    const effective = Math.round(Math.min(100, Math.max(0, manual + next.drift)));
    return {
      pace: c.status,
      expected: c.expected,
      used: c.used,
      gapPts: Math.round(c.gap * 100) || 0,
      manual,
      effective,
      drift,
      driftText: drift === 0 ? `at your ${manual}` : `${drift > 0 ? "+" : ""}${drift} from your ${manual}`,
      lanes: l.lanes,
      laneWhy: l.why,
      final: finalStretch(c),
      state: next,
    };
  } catch {
    return null;
  }
}
