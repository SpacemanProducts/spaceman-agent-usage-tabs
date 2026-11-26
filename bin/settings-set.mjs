#!/usr/bin/env node
// Writes one panel setting to the plugin's own settings.json (in its state
// folder), never to shell.json.
// Usage: settings-set.mjs <key> <true|false>   |   settings-set.mjs hidden <agentId> <true|false>
//        |   settings-set.mjs volume <0-100>   |   settings-set.mjs order <id,id,...|reset>
//        |   settings-set.mjs maxCopies <1-10>   |   settings-set.mjs constanceMilk <0-100>
//        |   settings-set.mjs constanceBrain <claude|antigravity|grok|codex|copilot>   (alias: brain)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { catalogIds } from "./catalog.mjs";
import { BRAINS } from "./constance-brain.mjs";

export const ALLOWED = ["hideUninstalledAgents", "showUnusedModels", "resetAnimation", "resetSound", "autoOpenOnReset", "handoffNote", "angryRobot", "skipPermissions", "constancePractice", "constanceUseItOrLoseIt", "welcomeDismissed"];
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

// Constance's Milk Opus slider (bin/constance-milk.mjs): an integer 0-100, clamped into
// range. The panel's slider only ever sends step-5 values; anything else integer is kept.
export function applyMilk(current, value) {
  const n = Number(value);
  if (!/^-?\d{1,3}$/.test(String(value)) || !Number.isInteger(n)) throw new Error(`constanceMilk must be an integer 0-100: ${value}`);
  const base = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  return { ...base, constanceMilk: Math.min(100, Math.max(0, n)) };
}

// Constance's brain backend: one of constance-brain.mjs's BRAINS ids, trimmed and lower-cased.
export function applyBrain(base, value) {
  const chosen = String(value).trim().toLowerCase();
  if (!Object.hasOwn(BRAINS, chosen)) throw new Error(`constanceBrain must be one of ${Object.keys(BRAINS).join(", ")}: ${value}`);
  const current = base && typeof base === "object" && !Array.isArray(base) ? base : {};
  return { ...current, constanceBrain: chosen };
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

// Serialize the read-modify-write below: two invocations at once (the panel's
// slider and a switch, say) must not both read the same settings.json and have
// the second rename silently drop the first one's key. The lock is a small
// O_EXCL file next to settings.json holding this process's pid; it is stale
// only when that pid is dead (same rule as bin/constance-mergelock.mjs: a lock
// that is merely old is still held). A lock whose pid can't be read yet is
// given a grace period — the holder creates the file a moment before writing
// its pid.
const LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 10;
const LOCK_NO_PID_MS = 2000;

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pidAlive = (pid) => {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

// True while the lock at `path` is really held: a live pid, or a file too
// fresh to have recorded its pid yet. False when it is stale or already gone.
function lockHeld(path) {
  let holder = 0;
  try { holder = Number(fs.readFileSync(path, "utf8").trim()) || 0; } catch { return false; }
  if (holder > 0) return pidAlive(holder);
  try { return Date.now() - fs.statSync(path).mtimeMs <= LOCK_NO_PID_MS; } catch { return false; }
}

function acquireLock(lock) {
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      try { fs.writeFileSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (lockHeld(lock)) {
        if (Date.now() > until) throw new Error("settings.json is locked by another settings-set");
        sleepSync(LOCK_POLL_MS);
        continue;
      }
      // Stale: take it over by renaming the corpse aside first — rename(2)
      // moves exactly one path, so two waiters can never both believe they
      // broke the same lock (same trick as constance-mergelock.mjs).
      const aside = `${lock}.stale-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      try {
        fs.renameSync(lock, aside);
      } catch (e2) {
        if (e2.code === "ENOENT") continue;   // another contender moved it first
        throw e2;
      }
      // The path may have changed hands between the stale check and the
      // rename: what we moved could be a fresh, live lock. Put it back if
      // `lock` is still free; otherwise it stays at `aside` as litter —
      // never deleted, and its owner's release check reads `lock`, so it
      // won't remove the new holder's lock either way.
      if (lockHeld(aside)) {
        if (!fs.existsSync(lock)) { try { fs.renameSync(aside, lock); } catch {} }
      } else {
        try { fs.unlinkSync(aside); } catch {}
      }
      continue;
    }
  }
}

function releaseLock(lock) {
  // Only remove our own lock: a stale break could have replaced it already.
  let holder = 0;
  try { holder = Number(fs.readFileSync(lock, "utf8").trim()) || 0; } catch { return; }
  if (holder === process.pid) { try { fs.unlinkSync(lock); } catch {} }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const dir = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "omarchy", "agent-usage-tabs");
  const file = path.join(dir, "settings.json");
  const lock = `${file}.lock`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    acquireLock(lock);
  } catch (e) { console.error(e.message); process.exit(1); }
  let failed = false;
  try {
    let current = {}; try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    const next = process.argv[2] === "hidden" ? applyHidden(current, process.argv[3], process.argv[4])
      : process.argv[2] === "order" ? applyOrder(current, process.argv[3])
      : process.argv[2] === "volume" ? applyVolume(current, process.argv[3])
      : process.argv[2] === "maxCopies" ? applyMaxCopies(current, process.argv[3])
      : process.argv[2] === "constanceMilk" || process.argv[2] === "milk" ? applyMilk(current, process.argv[3])
      : process.argv[2] === "constanceBrain" || process.argv[2] === "brain" ? applyBrain(current, process.argv[3])
      : applySetting(current, process.argv[2], process.argv[3]);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) { console.error(e.message); failed = true; }
  finally { releaseLock(lock); }
  if (failed) process.exit(1);
}
