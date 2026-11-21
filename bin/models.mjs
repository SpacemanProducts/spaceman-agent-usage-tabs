// Builds each agent's Models section: live data first, then the editable
// models.json entries, so nothing known is missing.
//   used        recent tokens > 0
//   zero        usable but unused (dimmed, 0)
//   unavailable the plan can't use it (dimmed, "unavailable") - never shown as 0
// `removing` flags a model with an announced removal (YYYY-MM-DD or YYYY-MM).
// Names compare loosely: case, dots and dashes are equivalent, and a known id
// matches a longer live id that continues with "-" (gemini-3.8-flash matches
// gemini-3.8-flash-high).
export const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const matches = (id, key) => { const a = norm(id), b = norm(key); return !!a && !!b && (a === b || a.startsWith(b + "-")); };

const entryKeys = (e) => [e.name, ...(Array.isArray(e.match) ? e.match : [])].filter(Boolean);
const entryMatches = (e, idOrName) => entryKeys(e).some((k) => matches(idOrName, k));
const SUM = ["input", "output", "cacheRead", "cacheWrite", "total"];

export function buildModels({ plan = "", used = [], live = null, config = [] }) {
  const rows = [];
  const claimedUsed = new Set(), claimedLive = new Set();
  const planKey = norm(plan);

  for (const e of Array.isArray(config) ? config : []) {
    if (!e || !e.name) continue;
    const row = { name: String(e.name), id: norm(e.name), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, state: "zero", removing: e.removing || "" };
    used.forEach((u, i) => { if (entryMatches(e, u.name)) { claimedUsed.add(i); for (const k of SUM) row[k] += Number(u[k]) || 0; } });
    let inLive = false;
    (live || []).forEach((l, i) => { if (entryMatches(e, l.id) || entryMatches(e, l.name)) { claimedLive.add(i); inLive = true; } });
    const planBlocked = (e.unavailableOn || []).some((p) => norm(p) === planKey);
    if (row.total > 0) row.state = "used";
    else if (planBlocked || (live && !inLive)) row.state = "unavailable";
    rows.push(row);
  }
  // Live models no entry names: still shown (live data is the source of truth).
  (live || []).forEach((l, i) => {
    if (claimedLive.has(i)) return;
    const row = { name: String(l.name || l.id), id: norm(l.id), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, state: "zero", removing: "" };
    used.forEach((u, j) => { if (matches(u.name, l.id) || matches(u.name, l.name)) { claimedUsed.add(j); for (const k of SUM) row[k] += Number(u[k]) || 0; } });
    if (row.total > 0) row.state = "used";
    rows.push(row);
  });
  // Used models nothing else names.
  used.forEach((u, i) => { if (!claimedUsed.has(i)) rows.push({ ...u, id: norm(u.name), state: Number(u.total) > 0 ? "used" : "zero", removing: "" }); });

  const rank = { used: 0, zero: 1, unavailable: 2 };
  return rows.map((r, i) => ({ r, i })).sort((a, b) => rank[a.r.state] - rank[b.r.state] || (a.r.state === "used" ? b.r.total - a.r.total : a.i - b.i)).map((x) => x.r);
}
