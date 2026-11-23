#!/usr/bin/env node
// The first tab is Omarchy's default agent. Usage: default-agent.mjs <tab-id> [installed]
//
// `omarchy default agent <name>` also starts the agent in a terminal (and installs a missing one), which
// would pop a window open every time the first tab changes. So this writes what it persists: the name in
// ~/.config/omarchy/defaults/agent, which the shortcut and right-click read through omarchy-default-agent.
// Only agents that command supports are used; any other first tab is skipped. The last tab applied is
// remembered, so the default is set when the first position CHANGES (and once on first run), and a default
// you pick yourself elsewhere stays until the first tab changes again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// tab id -> the name `omarchy default agent` accepts (from omarchy-default-agent's own case list).
export const DEFAULT_NAMES = {
  claude: "claude", antigravity: "agy", grok: "grok", codex: "codex", copilot: "copilot", cursor: "cursor-agent",
  opencode: "opencode", kimi: "kimi", kiro: "kiro-cli", devin: "devin", amp: "amp",
  // catalog agents that `omarchy default agent` also supports
  qwen: "qwen", dsh: "dsh", mcode: "mcode",
};

// What to do for a first tab: { name } to set, { skip: reason } to leave the default alone.
export function planDefault(tabId, installed, applied) {
  const name = DEFAULT_NAMES[tabId];
  if (!name) return { skip: "not supported as a default" };
  if (!installed) return { skip: "not installed" };   // setting it would start an install
  if (applied === tabId) return { skip: "already applied" };
  return { name };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const home = os.homedir();
  const stateDir = path.join(process.env.XDG_STATE_HOME || path.join(home, ".local/state"), "omarchy/agent-usage-tabs");
  const stateFile = path.join(stateDir, "default-agent.json");
  let applied = ""; try { applied = JSON.parse(fs.readFileSync(stateFile, "utf8")).applied || ""; } catch {}
  const [tabId, installed] = [process.argv[2] || "", process.argv[3] === "installed"];
  const plan = planDefault(tabId, installed, applied);
  if (plan.name) {
    const file = path.join(home, ".config/omarchy/defaults/agent");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, plan.name + "\n");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ applied: tabId }) + "\n", { mode: 0o600 });
  }
}
