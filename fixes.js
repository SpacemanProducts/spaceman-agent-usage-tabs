.pragma library
// The one-click fix under a gray tab's reason line: Install, Sign in or Add key.
// Every command is copied from the agent's own official docs (checked 2026-11-22, page in `src`).
// Where the docs give no terminal command, the entry is a `url` to the official setup page instead.
// `then` is what the docs say to type once the agent is running (sign-in that only happens inside a session).
var FIXES = {
  claude: {
    install: { cmd: "curl -fsSL https://claude.ai/install.sh | bash", src: "https://code.claude.com/docs/en/setup" },
    login: { cmd: "claude auth login", src: "https://code.claude.com/docs/en/authentication" }
  },
  antigravity: {
    install: { cmd: "curl -fsSL https://antigravity.google/cli/install.sh | bash", src: "https://antigravity.google/docs/getting-started" },
    login: { cmd: "agy", then: "it opens the browser to sign in", src: "https://antigravity.google/docs/install?tab=cli" }
  },
  grok: {
    install: { cmd: "curl -fsSL https://x.ai/cli/install.sh | bash", src: "https://docs.x.ai/build/overview" },
    login: { cmd: "grok", then: "it opens the browser to sign in", src: "https://docs.x.ai/build/overview" }
  },
  codex: {
    install: { cmd: "curl -fsSL https://chatgpt.com/codex/install.sh | sh", src: "https://github.com/openai/codex" },
    login: { cmd: "codex", then: "choose Sign in with ChatGPT", src: "https://github.com/openai/codex" }
  },
  copilot: {
    install: { cmd: "curl -fsSL https://gh.io/copilot-install | bash", src: "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli" },
    login: { cmd: "copilot", then: "type /login", src: "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli" }
  },
  cursor: {
    install: { cmd: "curl https://cursor.com/install -fsS | bash", src: "https://cursor.com/docs/cli/installation" },
    login: { cmd: "agent login", src: "https://cursor.com/docs/cli/reference/authentication" }
  },
  opencode: {
    install: { cmd: "curl -fsSL https://opencode.ai/v2/install | bash", src: "https://opencode.ai/docs/" },
    login: { cmd: "opencode", then: "type /connect and pick a provider", src: "https://opencode.ai/docs/providers" }
  },
  kimi: {
    // The `kimi` CLI is archived ("should no longer be installed"); the docs point to Kimi Code instead.
    install: { url: "https://moonshotai.github.io/kimi-code/en/guides/migration", src: "https://moonshotai.github.io/kimi-cli/en/guides/getting-started.html" },
    login: { cmd: "kimi", then: "type /login", src: "https://moonshotai.github.io/kimi-cli/en/guides/getting-started.html" }
  },
  kiro: {
    // The install page gives a script only for macOS, no Linux command: link the page.
    install: { url: "https://kiro.dev/docs/getting-started/installation/", src: "https://kiro.dev/docs/getting-started/installation/" },
    login: { cmd: "kiro-cli login", src: "https://kiro.dev/docs/getting-started/authentication/" }
  },
  devin: {
    install: { cmd: "curl -fsSL https://cli.devin.ai/install.sh | bash", src: "https://docs.devin.ai/cli" },
    login: { cmd: "devin", then: "type /login", src: "https://docs.devin.ai/cli/essential-commands.md" }
  },
  amp: {
    install: { cmd: "curl -fsSL https://ampcode.com/install.sh | bash", src: "https://ampcode.com/docs/cli" },
    login: { cmd: "amp login", src: "https://ampcode.com/docs/cli" }
  },
  qwen: {
    install: { cmd: "curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash", src: "https://github.com/QwenLM/qwen-code" },
    key: { url: "https://docs.qwencloud.com/developer-guides/administration/api-keys", src: "https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/" }
  },
  vibe: {
    install: { cmd: "curl -LsSf https://mistral.ai/vibe/install.sh | bash", src: "https://docs.mistral.ai/getting-started/quickstarts/vibe-code/install-cli" },
    login: { cmd: "vibe --setup", src: "https://docs.mistral.ai/getting-started/quickstarts/vibe-code/install-cli" }
  },
  dsh: {
    // DeepSeek's own quickstart gives no install command (only Ollama's page does): link the quickstart.
    install: { url: "https://deepseek-harness.github.io/deepseek-harness/en/guide/quickstart", src: "https://deepseek-harness.github.io/deepseek-harness/en/guide/quickstart" },
    key: { url: "https://platform.deepseek.com/api_keys", src: "https://api-docs.deepseek.com/" }
  },
  mcode: {
    install: { cmd: "curl -fsSL https://filecdn.minimax.chat/public/install.sh | bash", src: "https://platform.minimax.io/docs/m-plan/minimax-code" },
    login: { cmd: "mcode login --region global", src: "https://platform.minimax.io/docs/m-plan/minimax-code" }
  }
}

// The fix for a gray tab, or null. `gray` = the tab has no meter (the panel passes chipMeters(a).session < 0).
// Not installed -> Install; installed but signed out -> Sign in; a bring-your-own-key agent -> Add key.
// Returns { kind, label, cmd | url, tip }.
function fixFor(a, gray) {
  if (!a || !gray) return null
  var f = FIXES[a.id]
  if (!f) return null
  var name = a.name || a.id
  var pick = null, kind = "", label = ""
  if (a.installed === false) { pick = f.install; kind = "install"; label = "Install" }
  else if (a.signedIn === false) { pick = f.login; kind = "signin"; label = "Sign in" }
  else if (a.usageType === "byok_no_limits") { pick = f.key; kind = "key"; label = "Add key" }
  if (!pick) return null
  var tip
  if (pick.url) tip = kind === "key" ? "Opens " + name + "'s official page for setting up API keys" : "Opens " + name + "'s official " + (kind === "install" ? "install" : "sign-in") + " page"
  else tip = "Opens a terminal and runs " + pick.cmd + (pick.then ? ", then " + pick.then : "")
  return pick.url ? { kind: kind, label: label, url: pick.url, tip: tip } : { kind: kind, label: label, cmd: pick.cmd, tip: tip }
}

// The shell line that opens the fix in Omarchy's floating terminal (it keeps the window open with Done/Failed).
// Commands are fixed strings from the table above and never contain a single quote.
function terminalCommand(cmd) {
  return "omarchy-launch-floating-terminal-with-presentation '" + String(cmd) + "'"
}
