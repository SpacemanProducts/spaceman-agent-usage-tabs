#!/usr/bin/env node
// Cook Meter preflight: tells a new user, before they install, whether their
// machine has what the plugin needs. Required checks gate the install; the rest
// only unlock features (notifications, sound, per-agent logins) and are reported
// as optional. Read-only: it creates nothing and changes nothing.
//   node bin/install-check.mjs     exit 0 = ready, 1 = something required is missing
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = process.env.HOME || os.homedir();
const PLUGINS_DIR = path.join(HOME, ".config", "omarchy", "plugins");
const STATE_DIR = path.join(process.env.XDG_STATE_HOME || path.join(HOME, ".local", "state"), "omarchy", "agent-usage-tabs");

const results = [];
const ok = (name, detail = "") => results.push({ level: "ok", name, detail });
const missing = (name, detail = "") => results.push({ level: "missing", name, detail });
const info = (name, detail = "") => results.push({ level: "info", name, detail });

function which(cmd) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* keep looking */ }
  }
  return null;
}

// Deepest existing ancestor of `dir` must be writable, so install can create the rest.
function writableDeep(dir) {
  let d = dir;
  while (!fs.existsSync(d)) {
    const parent = path.dirname(d);
    if (parent === d) return false;
    d = parent;
  }
  try { fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; }
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 18) ok(`node ${process.versions.node}`, "required, 18 or newer");
else missing(`node ${process.versions.node}`, "required, 18 or newer — install it with your package manager");

if (which("git")) ok("git", "used to install and update the plugin");
else missing("git", "required — install it with your package manager");

if (which("omarchy")) ok("omarchy CLI", "used to install, enable and update plugins");
else missing("omarchy", "required — this check is meant to run on an Omarchy machine");

if (writableDeep(PLUGINS_DIR)) ok(`plugin folder ${PLUGINS_DIR}`, "the plugin installs here");
else missing(`plugin folder ${PLUGINS_DIR}`, "not writable — check permissions on ~/.config/omarchy");

if (writableDeep(STATE_DIR)) ok(`state folder ${STATE_DIR}`, "usage data and settings are kept here");
else missing(`state folder ${STATE_DIR}`, "not writable — check permissions on ~/.local/state");

// Optional pieces, each with what it unlocks.
const optional = [
  ["notify-send", "desktop notifications (alerts and celebrations)"],
  ["bwrap", "Constance's sandbox: without bubblewrap she launches no agents"],
  ["xdg-dbus-proxy", "Constance's sandbox: keyring-login agents (Copilot, Cursor, Antigravity) when you allow them"],
  ["pw-play", "reset sound via PipeWire"],
  ["paplay", "reset sound via PulseAudio"],
  ["ffplay", "reset sound via ffmpeg"],
  ["secret-tool", "Antigravity login kept in the keyring"],
  ["gh", "Copilot usage numbers (gh auth login)"],
  ["python3", "Claude Squad window driving"],
  ["tmux", "Claude Squad sessions"],
  ["cs", "Claude Squad itself (the CS button offers to install it)"],
];
const found = new Map();
for (const [cmd, what] of optional) if (which(cmd)) found.set(cmd, what);
if (found.has("notify-send")) ok("notify-send", found.get("notify-send"));
else info("notify-send", "missing — alerts and celebrations stay silent");
const sound = ["pw-play", "paplay", "ffplay"].find((c) => found.has(c));
if (sound) ok(sound, "reset sound");
else info("pw-play / paplay / ffplay", "none found — the reset celebration plays no sound");
if (found.has("secret-tool")) ok("secret-tool", found.get("secret-tool"));
else info("secret-tool", "missing — only matters if Antigravity keeps its login in the keyring");
if (found.has("gh")) ok("gh", found.get("gh"));
else info("gh", "missing — the Copilot tab shows no usage numbers (gh auth login also needed)");
const squadBits = ["python3", "tmux", "cs"].filter((c) => found.has(c));
if (squadBits.length === 3) ok("python3 + tmux + cs", "Claude Squad");
else info("python3 / tmux / cs", `found: ${squadBits.join(", ") || "none"} — the CS button can install cs; python3 and tmux come with Omarchy`);

// Which agent tabs will show data: the CLIs the collectors look for.
const AGENTS = [
  ["claude", "Claude Code"], ["agy", "Antigravity"], ["antigravity", "Antigravity"], ["grok", "Grok"],
  ["codex", "Codex"], ["copilot", "Copilot"], ["agent", "Cursor Agent"], ["opencode", "OpenCode"],
  ["kimi", "Kimi"], ["kiro-cli", "Kiro"], ["devin", "Devin"], ["amp", "Amp"],
  ["qwen", "Qwen Code"], ["vibe", "Mistral Vibe"], ["dsh", "DeepSeek Harness"], ["mcode", "MiniMax Code"],
];
const seen = new Set(), agentsFound = [];
for (const [bin, name] of AGENTS) {
  if (seen.has(name) || !which(bin)) continue;
  seen.add(name); agentsFound.push(name);
}
if (agentsFound.length) info("agents found", agentsFound.join(", "));
else info("agents found", "none — install an agent CLI and its tab appears on the next refresh");

const failed = results.filter((r) => r.level === "missing");
console.log("Cook Meter — install check\n");
for (const r of results) {
  const tag = r.level === "ok" ? " ok " : r.level === "missing" ? "MISS" : "info";
  console.log(` [${tag}] ${r.name}${r.detail ? " — " + r.detail : ""}`);
}
console.log("");
if (failed.length) {
  console.log(`${failed.length} required check${failed.length > 1 ? "s" : ""} failed. Fix the MISS lines, then run this again.`);
  process.exit(1);
}
console.log("Ready. Install with:  omarchy plugin add https://github.com/SpacemanProducts/spaceman-agent-usage-tabs.git --enable");
