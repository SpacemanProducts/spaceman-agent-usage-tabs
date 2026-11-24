import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// collect.mjs is the orchestrator: it runs every collector, merges Omarchy's
// builtin records, detects resets and writes data.json. It is exercised once,
// end to end, inside a scratch HOME/XDG_STATE_HOME with credentials cut off:
//   - PATH holds only system dirs, so agent CLIs in ~/.local resolve to nothing
//     (Antigravity's `agy` does live in /usr/bin, so it is the one installed tab).
//   - DBUS_SESSION_BUS_ADDRESS and XDG_RUNTIME_DIR are dead, so `secret-tool`
//     can never return the real agy keyring entry.
//   - GROK_HOME/AGY_DIR/CLAUDE_CONFIG_DIR point at empty dirs.
//   - live-models.json is pre-seeded fresh so `agy models` is never spawned.
// The run must exit 0 and still emit every agent slot with the documented shape.
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "collect-test-"));
const home = path.join(tmp, "home");
const xdg = path.join(tmp, "xdg");
const outDir = path.join(xdg, "omarchy", "agent-usage-tabs");
fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.join(tmp, "xdg-runtime"), { recursive: true });
fs.writeFileSync(path.join(outDir, "live-models.json"),
  JSON.stringify({ antigravity: { at: Date.now(), models: [{ id: "m", name: "M" }] } }));

const env = {
  ...process.env,
  HOME: home,
  XDG_STATE_HOME: xdg,
  XDG_RUNTIME_DIR: path.join(tmp, "xdg-runtime"),
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
  CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
  GROK_HOME: path.join(home, ".grok"),
  AGY_DIR: path.join(tmp, "agy-home"),
  PATH: "/usr/bin:/bin",
};
const r = spawnSync(process.execPath, [path.join(here, "collect.mjs")], { encoding: "utf8", env, timeout: 240000 });
assert.equal(r.status, 0, `collect.mjs failed:\n${r.stderr}\n${r.stdout}`);

const data = JSON.parse(fs.readFileSync(path.join(outDir, "data.json"), "utf8"));
assert.equal(data.schemaVersion, 1);
assert.ok(Number.isFinite(data.generatedAt));
assert.ok(Array.isArray(data.agents) && data.agents.length > 0, "agents array emitted");

const ids = data.agents.map((a) => a.id);
for (const id of ["claude", "antigravity", "grok", "codex", "copilot", "cursor"])
  assert.ok(ids.includes(id), `${id} keeps its tab slot even with nothing installed`);

for (const a of data.agents) {
  assert.equal(typeof a.id, "string"); assert.equal(typeof a.name, "string");
  assert.equal(typeof a.installed, "boolean");
  assert.ok(Array.isArray(a.limits), `${a.id}: limits is a list`);
  assert.ok(Array.isArray(a.models), `${a.id}: models is a list`);
  assert.ok(Array.isArray(a.days), `${a.id}: days is a list`);
}

const agy = data.agents.find((a) => a.id === "antigravity");
assert.equal(agy.installed, true, "agy ships in /usr/bin on Omarchy, so it counts as installed");
assert.ok(agy.status.length > 0, "a signed-out collector still reports a status line, not silence");

const others = data.agents.filter((a) => a.id !== "antigravity");
assert.ok(others.every((a) => a.installed === false), "no other agent's CLI resolves inside the scratch HOME");
assert.ok(data.agents.every((a) => a.limits.length === 0), "no credentials means no fabricated meters");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("collect: smoke test passed");
