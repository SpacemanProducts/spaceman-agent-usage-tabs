// bin/backup.sh: archives the plugin folder plus shell.json into
// ${XDG_DATA_HOME:-~/.local/share}/agent-usage-tabs-backups/, excluding .git and
// node_modules, and prunes to the newest BACKUP_KEEP archives.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "backup.sh");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "backup-test-"));
const home = path.join(tmp, "home");
const xdgData = path.join(tmp, "xdg-data");
const pluginParent = path.join(tmp, "plugins");
const pluginDir = path.join(pluginParent, "spaceman.agent-usage-tabs");
const backupDir = path.join(xdgData, "agent-usage-tabs-backups");

fs.mkdirSync(path.join(pluginDir, "bin"), { recursive: true });
fs.mkdirSync(path.join(pluginDir, ".git"), { recursive: true });
fs.mkdirSync(path.join(pluginDir, "node_modules", "x"), { recursive: true });
fs.writeFileSync(path.join(pluginDir, "manifest.json"), "{}");
fs.writeFileSync(path.join(pluginDir, "bin", "collect.mjs"), "// x");
fs.writeFileSync(path.join(pluginDir, ".git", "HEAD"), "ref");
fs.writeFileSync(path.join(pluginDir, "node_modules", "x", "i.js"), "x");
const shellJson = path.join(home, ".config", "omarchy", "shell.json");
fs.mkdirSync(path.dirname(shellJson), { recursive: true });
fs.writeFileSync(shellJson, '{"plugins":{}}');

const env = { ...process.env, HOME: home, XDG_DATA_HOME: xdgData, XDG_CONFIG_HOME: path.join(home, ".config"), PLUGIN_DIR: pluginDir };
const run = (extra = {}) => spawnSync("bash", [script], { encoding: "utf8", env: { ...env, ...extra } });

// ---- a backup lands in the data dir with plugin files and shell.json, no .git/node_modules.
let r = run();
assert.equal(r.status, 0, `backup.sh failed: ${r.stderr}`);
const out = r.stdout.trim();
assert.ok(out.startsWith(backupDir + "/"), `backup written outside the backups dir: ${out}`);
assert.match(path.basename(out), /^spaceman\.agent-usage-tabs-\d{8}-\d{6}\.tar\.gz$/, "timestamped name");
const list = spawnSync("tar", ["-tzf", out], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
assert.ok(list.includes("spaceman.agent-usage-tabs/manifest.json"), "plugin manifest archived");
assert.ok(list.includes("spaceman.agent-usage-tabs/bin/collect.mjs"), "plugin bin archived");
assert.ok(list.includes("shell.json"), "shell.json archived at top level");
assert.ok(!list.some((m) => m.includes(".git/") || m.includes("node_modules/")), `excluded paths leaked: ${list}`);

// ---- missing shell.json still backs up the plugin alone.
fs.rmSync(shellJson);
r = run();
assert.equal(r.status, 0, `backup without shell.json failed: ${r.stderr}`);
const out2 = r.stdout.trim();
const list2 = spawnSync("tar", ["-tzf", out2], { encoding: "utf8" }).stdout;
assert.ok(!list2.includes("shell.json"), "no shell.json member when the file is absent");

// ---- pruning keeps only the newest KEEP archives.
for (let i = 0; i < 12; i++) {
  const fake = path.join(backupDir, `spaceman.agent-usage-tabs-2020010${i}-000000.tar.gz`);
  fs.writeFileSync(fake, "x");
  const t = new Date(2020, 0, i + 1);
  fs.utimesSync(fake, t, t);
}
r = run({ BACKUP_KEEP: "3" });
assert.equal(r.status, 0, r.stderr);
const remaining = fs.readdirSync(backupDir).filter((f) => f.endsWith(".tar.gz"));
assert.ok(remaining.length <= 3, `expected <=3 backups after pruning, got ${remaining.length}: ${remaining}`);
assert.ok(remaining.every((f) => f >= "spaceman.agent-usage-tabs-202001"), "oldest pruned first");
assert.ok(fs.existsSync(out) === false || remaining.includes(path.basename(out)), "the fresh backup survived pruning");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("backup: all tests passed");
