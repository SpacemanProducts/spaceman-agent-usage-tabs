// The free per-model cap wall lives in each Grok home's own log
// (~/.grok/logs/unified.jsonl, or <GROK_HOME>/logs for a registered account).
// Omarchy's account registry knows where every Grok login waits; for each
// non-seated account we run the same collector with GROK_HOME pointed there
// and keep only the cap rows — the billing meters come from Omarchy's record.
import path from "node:path";

const expandHome = (p, homeDir) => String(p || "").replace(/^~/, homeDir || "");

// registry: parsed .../agents/accounts/grok.json (or null).
// primaryHome: the seated Grok home — its wall already comes from the normal
// collector run, so it is skipped here.
// run(home): the collector's {limits} for that home.
// Returns { accountId: [cap limit rows] } for accounts whose log shows a wall.
export function grokWalls(registry, { primaryHome = "", homeDir = "", run } = {}) {
  const out = {};
  const primary = primaryHome ? path.resolve(String(primaryHome)) : "";
  for (const acc of registry?.accounts || []) {
    if (!acc || !acc.id) continue;
    const home = expandHome(acc.login || acc.home, homeDir);
    if (!home || (primary && path.resolve(home) === primary)) continue;
    const walls = ((run ? run(home) : null)?.limits || []).filter((l) => l && l.cap === true);
    if (walls.length) out[acc.id] = walls;
  }
  return out;
}
