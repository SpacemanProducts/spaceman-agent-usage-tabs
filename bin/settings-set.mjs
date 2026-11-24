#!/usr/bin/env node
// Writes one panel setting to the plugin's own settings.json (in its state
// folder), never to shell.json.
// Usage: settings-set.mjs <key> <true|false>   |   settings-set.mjs hidden <agentId> <true|false>
//        |   settings-set.mjs volume <0-100>   |   settings-set.mjs order <id,id,...|reset>
//        |   settings-set.mjs maxCopies <1-10>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { catalogIds } from "./catalog.mjs";

export const ALLOWED = ["hideUninstalledAgents", "showUnusedModels", "resetAnimation", "resetSound", "autoOpenOnReset", "handoffNote", "angryRobot", "skipPermissions", "constancePractice", "welcomeDismissed"];
export const CORE_IDS = ["claude", "antigravity", "grok", "codex", "copilot", "cursor", "opencode", "kimi", "kiro", "devin", "amp"];
// The catalog agents (agents-catalog.json) are real tabs too: they can be hidden and reordered like the rest.
export const AGENT_IDS = [...CORE_IDS, ...catalogIds()];

// The reset sound volume: an integer 0-100.
export function applyVolume(current, value) {
  const n = Number(value);
  if (!/^\d{1,3}$/.test(String(value)) || !Number.isInteger(n) || n < 0 || n > 100) throw new Error(`volume must be an integer 0-100: ${value}`);
  const base = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  return { ...base, resetVolume: n };
}

// Constance's most copies of one agent at once: an integer 1-10 (10 is Devin's
// published concurrent session limit; constance-ramp.mjs applies it).
export function applyMaxCopies(current, value) {
  const n = Number(value);
  if (!/^\d{1,2}$/.test(String(value)) || !Number.isInteger(n) || n < 1 || n > 10) throw new Error(`maxCopies must be an integer 1-10: ${value}`);
  const base = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  return { ...base, constanceMaxCopies: n };
}

// A tab the user hides stays hidden (by agent id) until they unhide it, even
// across uninstall/reinstall. Hiding an id twice, or unhiding one never hidden,
// is harmless.
export function applyHidden(current, id, hidden) {
  if (!AGENT_IDS.includes(id)) throw new Error(`unknown agent: ${id}`);
  if (hidden !== "true" && hidden !== "false") throw new Error(`value must be true or false: ${hidden}`);
  const base = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  const list = Array.isArray(base.hiddenAgents) ? base.hiddenAgents.filter((x) => AGENT_IDS.includes(x)) : [];
  const next = hidden === "true" ? [...new Set([...list, id])] : list.filter((x) => x !== id);
  return { ...base, hiddenAgents: next };
}

// The tab order: a comma-separated list of known agent ids, saved so it survives restarts.
// "reset" restores the default order (explicitly, so it also overrides a tabOrder set in shell.json).
export const DEFAULT_ORDER = AGENT_IDS;   // the eleven core agents first, then the catalog agents, "and the rest" at the end
export function applyOrder(current, csv) {
  const ids = csv === "reset" ? DEFAULT_ORDER : String(csv || "").split(",").map((x) => x.trim()).filter(Boolean);
  const bad = ids.find((x) => !AGENT_IDS.includes(x));
  if (bad || ids.length === 0 || new Set(ids).size !== ids.length) throw new Error(`order must be distinct known agent ids: ${csv}`);
  const base = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  return { ...base, tabOrder: ids };
}

export function applySetting(current, key, value) {
  if (!ALLOWED.includes(key)) throw new Error(`unknown setting: ${key}`);
  if (value !== "true" && value !== "false") throw new Error(`value must be true or false: ${value}`);
  const base = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  return { ...base, [key]: value === "true" };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const dir = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "omarchy", "agent-usage-tabs");
  const file = path.join(dir, "settings.json");
  let current = {}; try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  try {
    const next = process.argv[2] === "hidden" ? applyHidden(current, process.argv[3], process.argv[4])
      : process.argv[2] === "order" ? applyOrder(current, process.argv[3])
      : process.argv[2] === "volume" ? applyVolume(current, process.argv[3])
      : process.argv[2] === "maxCopies" ? applyMaxCopies(current, process.argv[3])
      : applySetting(current, process.argv[2], process.argv[3]);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) { console.error(e.message); process.exit(1); }
}
