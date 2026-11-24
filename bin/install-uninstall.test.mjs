// Clean-install lifecycle in a throwaway HOME: the plugin folder lands where
// `omarchy plugin add` puts it, one collector run writes only inside the state
// folder, and uninstalling (plugin remove + state folder delete, per the README)
// leaves the HOME with no plugin traces at all.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "install-life-"));
const home = path.join(tmp, "home");
const xdg = path.join(tmp, "xdg");
const ID = "spaceman.agent-usage-tabs";
const pluginDir = path.join(home, ".config", "omarchy", "plugins", ID);
const stateDir = path.join(xdg, "omarchy", "agent-usage-tabs");

// ---- install: copy the plugin where `omarchy plugin add` clones it (no .git).
fs.mkdirSync(path.dirname(pluginDir), { recursive: true });
const copy = (src, dst) => {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copy(s, d); else fs.copyFileSync(s, d);
  }
};
copy(repo, pluginDir);
assert.ok(fs.existsSync(path.join(pluginDir, "manifest.json")), "installed copy has its manifest");

// ---- first run: the collector writes its state, nothing else.
const env = {
  ...process.env,
  HOME: home,
  XDG_STATE_HOME: xdg,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_RUNTIME_DIR: path.join(tmp, "xdg-runtime"),
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
  CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
  GROK_HOME: path.join(home, ".grok"),
  AGY_DIR: path.join(tmp, "agy-home"),
  PATH: "/usr/bin:/bin",
};
fs.mkdirSync(path.join(tmp, "xdg-runtime"), { recursive: true });
const r = spawnSync(process.execPath, [path.join(pluginDir, "bin", "collect.mjs")], { encoding: "utf8", env, timeout: 240000 });
assert.equal(r.status, 0, `collect.mjs failed:\n${r.stderr}`);
assert.ok(fs.existsSync(path.join(stateDir, "data.json")), "data.json written inside the state folder");

// No *plugin* file lands outside the plugin folder and the state folder. (The
// agent CLIs and Omarchy's own collectors keep their own state — ~/.gemini,
// omarchy/agents/usage — which belongs to those tools, not to this plugin.)
const traces = (root) => {
  const hits = [];
  const scan = (d, rel = "") => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), r = rel ? rel + "/" + e.name : e.name;
      if (/agent-usage-tabs|cook.?meter/i.test(r)) hits.push(r);
      if (e.isDirectory()) scan(p, r);
    }
  };
  if (fs.existsSync(root)) scan(root);
  return hits;
};
for (const root of [home, xdg]) {
  const stray = traces(root).filter((r) => !r.includes("plugins/" + ID) && r !== "omarchy/agent-usage-tabs" && !r.startsWith("omarchy/agent-usage-tabs/"));
  assert.deepEqual(stray, [], `plugin files outside plugin/state folders under ${root}: ${stray.join(", ")}`);
}

// ---- uninstall: `omarchy plugin remove` deletes the folder; the README's rm
// clears the state folder. Afterwards the HOME holds no plugin traces.
fs.rmSync(pluginDir, { recursive: true, force: true });
fs.rmSync(stateDir, { recursive: true, force: true });
const left = [];
const findPlugin = (d, rel = "") => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name), r = rel ? rel + "/" + e.name : e.name;
    if (/agent-usage-tabs|cook.?meter/i.test(r)) left.push(r);
    if (e.isDirectory()) findPlugin(p, r);
  }
};
for (const root of [home, xdg, path.join(tmp, "xdg-runtime")]) if (fs.existsSync(root)) findPlugin(root);
assert.deepEqual(left, [], `plugin traces left after uninstall: ${left.join(", ")}`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("install-uninstall: clean lifecycle passed");
