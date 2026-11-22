// Usage alerts that fire ONCE per usage window per agent, whatever the meter does while the condition stays true.
//
// Two levels per window:
//   warn   usage first goes past the notify threshold (95% by default; the gear/shell setting can lower it)
//   limit  the meter hits its limit (about 100%)
// A window remembers what already fired, in the file collect.mjs keeps (so it survives restarts). It is forgotten only
// when that window ends: the reset time moves on to a later window, or the meter falls far enough under the threshold
// that it must have reset. A small dip, a blip, a failed fetch or a missing meter changes nothing, so nothing repeats.
//
// A window is identified by agent + meter title, NOT by its reset-time string: Claude reports `resetsAt` with
// microseconds that change on every fetch, which used to make each refresh look like a brand-new window and re-fire.
export const WATCHED = /session|weekly/i;
export const TOLERANCE_MS = 5 * 60 * 1000;   // reset times of one window can wobble by seconds; a new window is hours away
const REARM_DROP = 0.3;                      // a meter this far under the threshold has reset
const STALE_AFTER_MS = 30 * 60 * 1000;       // a window that ended this long ago can never fire again
const LIMIT_AT = 0.995;                      // shows as 100%

const resetMsOf = (iso) => { const t = Date.parse(iso || ""); return Number.isFinite(t) ? t : null; };

// Memory written by older versions: "agent|title|resetsAt" -> timestamp. Keep it as a warning that already fired.
function migrate(before) {
  const out = {};
  for (const [k, v] of Object.entries(before || {})) {
    if (v && typeof v === "object") { out[k] = v; continue; }
    const parts = k.split("|");
    if (parts.length < 3) continue;
    out[`${parts[0]}|${parts[1]}`] = { resetMs: resetMsOf(parts.slice(2).join("|")), levels: { warn: Number(v) || 1 } };
  }
  return out;
}

// -> { toSend: [{ agent, limit, key, level: "warn"|"limit", resetMs }], memory }
export function planAlerts(agents, before, threshold, now = Date.now()) {
  const memory = migrate(before);
  const toSend = [];
  // A multi-account agent also alerts per account, named by its label.
  const watched = [];
  for (const a of agents || []) {
    watched.push(a);
    if ((a.accounts || []).length > 1)
      for (const acc of a.accounts) watched.push({ ...a, id: `${a.id}:${acc.id}`, name: `${a.name} (${acc.label})`, limits: acc.limits, accounts: undefined });
  }
  for (const a of watched) {
    for (const l of a.limits || []) {
      if (!WATCHED.test(String(l.title)) || typeof l.percent !== "number") continue;
      const key = `${a.id}|${l.title}`;
      const resetMs = resetMsOf(l.resetsAt);
      let rec = memory[key];
      // This window ended: the reset time moved on, or the meter fell so far it must have reset.
      if (rec && ((resetMs && rec.resetMs && resetMs - rec.resetMs > TOLERANCE_MS) || l.percent <= threshold - REARM_DROP)) {
        delete memory[key]; rec = undefined;
      }
      const fired = rec?.levels || {};
      if (l.percent >= LIMIT_AT) { if (!fired.limit) toSend.push({ agent: a, limit: l, key, level: "limit", resetMs }); }
      else if (l.percent > threshold) { if (!fired.warn) toSend.push({ agent: a, limit: l, key, level: "warn", resetMs }); }
    }
  }
  // A window that ended long ago can never fire again.
  for (const k of Object.keys(memory)) {
    const rec = memory[k];
    if (rec && rec.resetMs && now - rec.resetMs > STALE_AFTER_MS) delete memory[k];
  }
  return { toSend, memory };
}

// Call once a notification was really sent (a failed send is not remembered, so it retries).
// Hitting the limit also covers the warning for that window, so the two never fire back to back.
export function markFired(memory, item, now = Date.now()) {
  const rec = memory[item.key] || { resetMs: item.resetMs, levels: {} };
  if (item.resetMs) rec.resetMs = item.resetMs;
  rec.levels[item.level] = now;
  if (item.level === "limit" && !rec.levels.warn) rec.levels.warn = now;
  memory[item.key] = rec;
  return memory;
}

// The notification text for an alert.
export function alertText(item, untilReset = "") {
  const pct = Math.round(item.limit.percent * 100);
  if (item.level === "limit")
    return { title: `${item.agent.name}: limit reached`, body: [`${item.limit.title} limit hit (${pct}%)`, untilReset].filter(Boolean).join(" — ") };
  return { title: `${item.agent.name}: ${pct}% used`, body: [`${item.limit.title} limit at ${pct}%`, untilReset].filter(Boolean).join(" — ") };
}
