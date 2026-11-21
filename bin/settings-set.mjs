#!/usr/bin/env node
// Writes one panel setting to the plugin's own settings.json (in its state
// folder), never to shell.json.
// Usage: settings-set.mjs <key> <true|false>   |   settings-set.mjs hidden <agentId> <true|false>
//        |   settings-set.mjs volume <0-100>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ALLOWED = ["hideUninstalledAgents", "showUnusedModels", "resetAnimation", "resetSound", "autoOpenOnReset"];
export const AGENT_IDS = ["claude", "antigravity", "grok", "codex", "copilot", "cursor", "opencode", "kimi", "kiro", "devin", "amp", "hermes"];

// The reset sound volume: an integer 0-100.
export function applyVolume(current, value) {
  const n = Number(value);
  if (!/^\d{1,3}$/.test(String(value)) || !Number.isInteger(n) || n < 0 || n > 100) throw new Error(`volume must be an integer 0-100: ${value}`);
  const base = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  return { ...base, resetVolume: n };
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
      : process.argv[2] === "volume" ? applyVolume(current, process.argv[3])
      : applySetting(current, process.argv[2], process.argv[3]);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) { console.error(e.message); process.exit(1); }
}
