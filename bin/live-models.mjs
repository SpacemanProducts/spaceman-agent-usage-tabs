// What each agent's own CLI says it can use. Parsers are pure (tested against
// real output); the runner executes the CLI headless and caches for 6 hours so
// a 5-minute refresh never spawns six CLIs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const dedupe = (list) => { const seen = new Set(); return list.filter((m) => m.id && !seen.has(m.id) && seen.add(m.id)); };

export const PARSERS = {
  // "gemini-3.8-flash-high<TAB>Gemini 3.8 Flash (High)"
  agy(out) {
    return dedupe(out.split("\n").map((l) => l.split("\t")).filter((p) => p.length >= 2 && /^[a-z0-9][\w.-]*$/i.test(p[0].trim())).map((p) => ({ id: p[0].trim(), name: p[1].trim() })));
  },
  // "Available models:\n  * grok-4.7 (default)"
  grok(out) {
    const i = out.indexOf("Available models:");
    if (i < 0) return [];
    return dedupe(out.slice(i).split("\n").slice(1).map((l) => l.match(/^\s*\*?\s*([a-z0-9][\w.-]*)/i)).filter(Boolean).map((m) => ({ id: m[1], name: m[1] })));
  },
  // "provider/model" per line
  opencode(out) {
    return dedupe(out.split("\n").map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l)).map((l) => ({ id: l, name: l.split("/").slice(1).join("/") })));
  },
  // Family headers: "Claude Fable 5.2 (claude-fable-5.2)" (unindented)
  devin(out) {
    return dedupe(out.split("\n").map((l) => l.match(/^(\S.*?) \(([\w.-]+)\)\s*$/)).filter(Boolean).map((m) => ({ id: m[2], name: m[1] })));
  },
  // "* auto   1.00x credits   Models chosen by task..."
  kiro(out) {
    return dedupe(out.split("\n").map((l) => l.match(/^\s*\*?\s*([a-z0-9][\w.-]*)\s+[\d.]+x credits\b/i)).filter(Boolean).map((m) => ({ id: m[1], name: m[1] })));
  },
  // `codex debug models`: JSON catalog; only user-selectable (visibility "list") models
  codex(out) {
    try {
      const d = JSON.parse(out); const ms = Array.isArray(d) ? d : d.models;
      return dedupe((ms || []).filter((m) => m && m.visibility === "list").map((m) => ({ id: String(m.slug), name: String(m.display_name || m.slug) })));
    } catch { return []; }
  },
};

export const COMMANDS = {
  antigravity: { cmd: ["agy", "models"], parser: "agy" },
  grok: { cmd: ["grok", "models"], parser: "grok" },
  opencode: { cmd: ["opencode", "models"], parser: "opencode" },
  devin: { cmd: ["devin", "models"], parser: "devin" },
  kiro: { cmd: ["kiro-cli", "chat", "--list-models"], parser: "kiro" },
  codex: { cmd: ["codex", "debug", "models"], parser: "codex" },
};

const TTL_MS = 6 * 3600 * 1000;
const LOGIN_HINT = /not (logged|signed) in|not authenticated|authentication required|log ?in|sign ?in/i;

// Returns [{id,name}] or null when the agent has no list command or it failed
// and nothing is cached. `env` is the collector's PATH-extended environment.
export function liveModels(agentId, { env, stateDir, now = Date.now(), run = defaultRun, onUnexpected } = {}) {
  const spec = COMMANDS[agentId];
  if (!spec) return null;
  const file = path.join(stateDir, "live-models.json");
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch {}
  const hit = cache[agentId];
  if (hit && now - hit.at < TTL_MS && Array.isArray(hit.models)) return hit.models;
  const raw = run(spec.cmd, env);
  const models = PARSERS[spec.parser](raw);
  // Output that isn't a sign-in message but also isn't the expected list means
  // the CLI's format changed (or it failed in a way we don't know).
  if (!models.length && raw.trim() && !LOGIN_HINT.test(raw) && onUnexpected)
    onUnexpected("model list output didn't match the expected format", { command: spec.cmd.join(" "), head: raw.slice(0, 200) });
  if (models.length) {
    cache[agentId] = { at: now, models };
    try { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(cache)); } catch {}
    return models;
  }
  return hit && Array.isArray(hit.models) ? hit.models : null; // keep the last good list on failure
}

function defaultRun(cmd, env) {
  const e = { ...env }; delete e.DISPLAY; delete e.WAYLAND_DISPLAY; // headless: can never open a browser
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", env: e, timeout: 45000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
  return String(r.stdout || "");
}
