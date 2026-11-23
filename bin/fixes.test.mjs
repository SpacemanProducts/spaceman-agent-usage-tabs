import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "fixes.js"), "utf8").replace(/^\.pragma library\s*$/m, "");
const ctx = {}; vm.createContext(ctx); vm.runInContext(src, ctx);
const fix = (a, gray = true) => JSON.parse(JSON.stringify(ctx.fixFor(a, gray)));
const FIXES = JSON.parse(JSON.stringify(ctx.FIXES));

// Which fix a gray tab gets.
assert.equal(fix({ id: "claude", name: "Claude Code", installed: true, signedIn: true }, false), null, "a tab with meters gets no button");
assert.deepEqual(fix({ id: "claude", name: "Claude Code", installed: false }),
  { kind: "install", label: "Install", cmd: "curl -fsSL https://claude.ai/install.sh | bash", tip: "Opens a terminal and runs curl -fsSL https://claude.ai/install.sh | bash" });
assert.deepEqual(fix({ id: "kiro", name: "Kiro", installed: true, signedIn: false }),
  { kind: "signin", label: "Sign in", cmd: "kiro-cli login", tip: "Opens a terminal and runs kiro-cli login" });
assert.equal(fix({ id: "kimi", name: "Kimi", installed: true, signedIn: false }).tip, "Opens a terminal and runs kimi, then type /login", "in-session sign-in says what to type");
assert.deepEqual(fix({ id: "kiro", name: "Kiro", installed: false }),
  { kind: "install", label: "Install", url: "https://kiro.dev/docs/getting-started/installation/", tip: "Opens Kiro's official install page" }, "no Linux command in the docs -> link");
assert.deepEqual(fix({ id: "dsh", name: "DeepSeek Harness", installed: true, signedIn: null, usageType: "byok_no_limits" }),
  { kind: "key", label: "Add key", url: "https://platform.deepseek.com/api_keys", tip: "Opens DeepSeek Harness's official page for setting up API keys" });
assert.equal(fix({ id: "openclaw", name: "OpenClaw", installed: true, signedIn: null, usageType: "byok_no_limits" }), null, "OpenClaw is no longer a tab: no button");
assert.equal(fix({ id: "opencode", name: "OpenCode", installed: true, signedIn: null }), null, "installed, no sign-in state, not BYOK: nothing to fix");
assert.equal(fix({ id: "vibe", name: "Mistral Vibe", installed: true, signedIn: null, usageType: "no_usage_data" }), null, "no data published is not fixable");
assert.equal(fix({ id: "nope", installed: false }), null, "unknown agent: no button");
assert.equal(ctx.fixFor(null, true), null);
assert.equal(fix({ id: "claude", installed: false, signedIn: false }).kind, "install", "install comes before sign in");

// Every agent the panel knows has an Install fix; every entry is safe to put in single quotes and points at https.
const catalog = JSON.parse(fs.readFileSync(path.join(root, "agents-catalog.json"), "utf8")).agents.map((a) => a.id);
const builtins = ["claude", "antigravity", "grok", "codex", "copilot", "cursor", "opencode", "kimi", "kiro", "devin", "amp"];
for (const id of [...builtins, ...catalog]) assert.ok(FIXES[id]?.install, `${id} has an install fix`);
for (const [id, f] of Object.entries(FIXES)) for (const [k, e] of Object.entries(f)) {
  assert.ok(/^https:\/\//.test(e.src), `${id}.${k} cites an https source`);
  assert.ok(!!e.cmd !== !!e.url, `${id}.${k} is exactly one of cmd or url`);
  if (e.cmd) assert.ok(!e.cmd.includes("'"), `${id}.${k} has no single quote`);
  if (e.url) assert.ok(/^https:\/\//.test(e.url), `${id}.${k} url is https`);
  if (k === "key") assert.ok(e.url, `${id}.key opens a page`);
}
assert.equal(ctx.terminalCommand("amp login"), "omarchy-launch-floating-terminal-with-presentation 'amp login'");
console.log("fixes ok");
