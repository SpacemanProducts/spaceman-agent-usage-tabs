#!/usr/bin/env node
// The App button: start one agent's own CLI, in a terminal, on building a new Omarchy app.
// Same idea as Omarchy's `omarchy-agent --prompt`, but for the agent whose tab is selected, and
// started plainly: no permission-skipping flags. Usage: launch-agent.mjs <cli>
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_PROMPT = "Build me a new desktop app for my Omarchy setup. Ask what it should do first, then make it following the omarchy-app skill and install it so it appears in the app launcher.";

// How each CLI takes a starting prompt that keeps the session interactive.
// `clipboard: true` means the CLI has no way to take one, so it opens plain and the prompt is copied.
export function launchArgv(cli, prompt = APP_PROMPT) {
  switch (cli) {
    case "claude": case "grok": case "codex": case "devin": return { argv: [cli, "--", prompt] };
    case "agy": return { argv: [cli, "--prompt-interactive", prompt] };
    case "copilot": return { argv: [cli, "--interactive", prompt] };
    case "cursor-agent": return { argv: [cli, "agent", "--", prompt] };
    case "opencode": return { argv: [cli, "--prompt", prompt] };
    case "kiro-cli": return { argv: [cli, "chat", "--", prompt] };
    case "hermes": return { argv: ["env", "-u", "HERMES_SESSION_SOURCE", cli, "chat", "--tui", `--query=${prompt}`] };
    case "amp": return { argv: ["bash", "-c", 'printf "%s\\n" "$1" | exec "$0"', cli, prompt] };
    default: return { argv: [cli], clipboard: true };   // kimi's --prompt is one-shot print mode
  }
}

// Claude, Codex and Grok follow the active account (the same pin Omarchy's launcher sets).
const HOME_ENV = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", grok: "GROK_HOME" };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cli = process.argv[2];
  if (!cli || !/^[\w.-]+$/.test(cli)) process.exit(1);
  const { argv, clipboard } = launchArgv(cli);
  const env = { ...process.env };
  const he = HOME_ENV[cli];
  if (he && !env[he]) {
    const r = spawnSync("omarchy-agent-account-home", [cli], { encoding: "utf8", timeout: 5000 });
    const home = String(r.stdout || "").trim();
    if (r.status === 0 && home) env[he] = home;
  }
  if (clipboard) {
    spawnSync("wl-copy", [], { input: APP_PROMPT, timeout: 5000 });
    spawnSync("notify-send", ["-a", "Cook Meter", `${cli} can't take a starting prompt`, "The new-app prompt is on your clipboard: paste it as your first message."]);
  }
  const work = path.join(os.homedir(), "Work");
  const cwd = fs.existsSync(work) ? work : os.homedir();
  spawn("omarchy-launch-tui", argv, { cwd, env, detached: true, stdio: "ignore" }).unref();
}
