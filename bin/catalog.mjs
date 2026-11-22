// The built-in catalog of CLI coding agents beyond the twelve this plugin reads directly (agents-catalog.json).
// Each entry says how the agent reports usage, which drives the note on its tab; `bins` drives install detection.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const USAGE_TYPES = ["session_weekly", "monthly_credits", "request_count", "byok_no_limits", "free_no_limits", "no_usage_data"];
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agents-catalog.json");

export function loadCatalog(file = FILE) {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    const agents = (Array.isArray(c.agents) ? c.agents : []).filter((a) => a && a.id && a.name && Array.isArray(a.bins) && USAGE_TYPES.includes(a.usageType));
    return { types: c.types || {}, agents, dropped: c.dropped || {} };
  } catch { return { types: {}, agents: [], dropped: {} }; }
}

// The note shown on an agent's tab: what kind of usage it has, then the specifics. An entry flagged `unsure` says so.
export function tabNote(entry, types) {
  if (entry.tabText) return entry.tabText;   // a fixed text for the tab (no type heading, no "not verified" suffix)
  const t = types[entry.usageType] || {};
  const head = t.label ? `${t.label}.` : "";
  const tail = entry.unsure ? " (Not fully verified: see agents-catalog.json.)" : "";
  return [head, entry.note].filter(Boolean).join(" ") + tail;
}

// Ids of every catalog agent, in catalog order (they go after the twelve core agents in the default tab order).
export const catalogIds = () => loadCatalog().agents.map((a) => a.id);
