// Builds each agent's Models section: live data first, then the editable
// models.json entries, so nothing known is missing.
//   used        recent tokens > 0
//   zero        usable but unused (dimmed, 0)
//   unavailable the plan can't use it (dimmed, "unavailable") - never shown as 0
// `removing` flags a model with an announced removal (YYYY-MM-DD or YYYY-MM).
// Names compare loosely: case, dots and dashes are equivalent, and a known id
// matches a longer live id that continues with "-" (gemini-3.8-flash matches
// gemini-3.8-flash-high). A used record belongs to the single row whose key
// matches most specifically, so one model can never be counted twice.
export const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const matches = (id, key) => { const a = norm(id), b = norm(key); return !!a && !!b && (a === b || a.startsWith(b + "-")); };

const entryKeys = (e) => [e.name, ...(Array.isArray(e.match) ? e.match : [])].filter(Boolean);
const entryMatches = (e, idOrName) => entryKeys(e).some((k) => matches(idOrName, k));
const SUM = ["input", "output", "cacheRead", "cacheWrite", "total"];

export function buildModels({ plan = "", used = [], live = null, config = [] }) {
  const cfg = (Array.isArray(config) ? config : []).filter((e) => e && e.name);
  const lv = Array.isArray(live) ? live : [];
  const planKey = norm(plan);

  const claimedLive = new Set();
  cfg.forEach((e) => lv.forEach((l, i) => {
    if (entryMatches(e, l.id) || entryMatches(e, l.name)) claimedLive.add(i);
  }));

  // Every row that can own usage, in display order: config entries, then the
  // live models no entry claimed. slotLive maps a slot back to its live index.
  const slotKeys = [], slotLive = [];
  cfg.forEach((e) => { slotKeys.push(entryKeys(e)); slotLive.push(-1); });
  lv.forEach((l, i) => { if (!claimedLive.has(i)) { slotKeys.push([l.id, l.name].filter(Boolean)); slotLive.push(i); } });

  // A used record goes to the row with the longest matching key (swe-2-flash-
  // medium owns to swe-2-flash, not swe-2); ties go to the earlier row.
  const owner = (Array.isArray(used) ? used : []).map((u) => {
    let best = -1, bestLen = -1;
    slotKeys.forEach((keys, s) => keys.forEach((k) => {
      if (matches(u.name, k) && norm(k).length > bestLen) { bestLen = norm(k).length; best = s; }
    }));
    return best;
  });
  const addTo = (row, u) => { for (const k of SUM) row[k] += Number(u[k]) || 0; };

  const rows = [];
  cfg.forEach((e, s) => {
    const row = { name: String(e.name), id: norm(e.name), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, state: "zero", removing: e.removing || "" };
    (Array.isArray(used) ? used : []).forEach((u, j) => { if (owner[j] === s) addTo(row, u); });
    const inLive = lv.some((l) => entryMatches(e, l.id) || entryMatches(e, l.name));
    const planBlocked = (e.unavailableOn || []).some((p) => norm(p) === planKey);
    if (row.total > 0) row.state = "used";
    else if (planBlocked || (lv.length && !inLive)) row.state = "unavailable";
    rows.push(row);
  });
  // Live models no entry names: still shown (live data is the source of truth).
  slotKeys.forEach((keys, s) => {
    if (slotLive[s] < 0) return;
    const l = lv[slotLive[s]];
    const row = { name: String(l.name || l.id), id: norm(l.id), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, state: "zero", removing: "" };
    (Array.isArray(used) ? used : []).forEach((u, j) => { if (owner[j] === s) addTo(row, u); });
    if (row.total > 0) row.state = "used";
    rows.push(row);
  });
  // Used models nothing else names.
  (Array.isArray(used) ? used : []).forEach((u, j) => { if (owner[j] === -1) rows.push({ ...u, id: norm(u.name), state: Number(u.total) > 0 ? "used" : "zero", removing: "" }); });

  const rank = { used: 0, zero: 1, unavailable: 2 };
  return rows.map((r, i) => ({ r, i })).sort((a, b) => rank[a.r.state] - rank[b.r.state] || (a.r.state === "used" ? b.r.total - a.r.total : a.i - b.i)).map((x) => x.r);
}
