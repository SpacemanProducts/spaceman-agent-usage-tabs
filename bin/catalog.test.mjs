import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadCatalog, tabNote, USAGE_TYPES, catalogIds } from "./catalog.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const { types, agents, dropped } = loadCatalog();
const ids = agents.map((a) => a.id);

// ---- the rules for being in the catalog: still maintained AND a working way to read usage or plan limits
assert.deepEqual(ids, ["qwen", "vibe", "dsh", "mcode", "openclaw"]);
for (const gone of ["gemini", "aider", "roo", "cline", "goose", "crush", "kilo", "openhands", "plandex", "codewhale", "reasonix", "pi", "omp", "commandcode", "droid", "auggie"])
  assert.ok(!ids.includes(gone), `${gone} is not in the catalog`);
assert.ok(dropped.gemini && dropped.aider, "removed agents are listed with their reason");
for (const [id, why] of Object.entries(dropped)) assert.ok(String(why).length > 10, `${id}: dropped for a stated reason`);
for (const a of agents) {
  assert.ok(String(a.maintained || "").length > 20, `${a.id}: says why it counts as maintained`);
  assert.ok(String(a.reads || "").length > 30, `${a.id}: says how its usage or limits can be read`);
}

// ---- entry shape
const CORE = ["claude", "antigravity", "grok", "codex", "copilot", "cursor", "opencode", "kimi", "kiro", "devin", "amp", "hermes"];
const CORE_BINS = ["claude", "agy", "antigravity", "grok", "codex", "copilot", "cursor-agent", "opencode", "kimi", "kiro-cli", "devin", "amp", "hermes"];
assert.equal(new Set(ids).size, ids.length, "unique ids");
for (const a of agents) {
  assert.ok(!CORE.includes(a.id), `${a.id} must not clash with a core agent`);
  assert.ok(!a.bins.some((b) => CORE_BINS.includes(b)), `${a.id}: a binary already belongs to a core agent`);
  assert.ok(USAGE_TYPES.includes(a.usageType), `${a.id}: usage type`);
  assert.ok(types[a.usageType]?.label && types[a.usageType]?.tabNote, `${a.id}: the type has a label and a note`);
  assert.ok(a.bins.length > 0 && a.bins.every((b) => /^[\w.-]+$/.test(b)), `${a.id}: binaries are plain names`);
  assert.ok(a.note && a.note.length > 30, `${a.id}: has a real note`);
  assert.ok(Array.isArray(a.sources) && a.sources.length > 0 && a.sources.every((s) => /^https:\/\//.test(s)), `${a.id}: cites https sources`);
  if ("unsure" in a) assert.ok(String(a.unsure).length > 20, `${a.id}: an unsure flag says why`);
  if (a.builtin && !process.env.SKIP_OMARCHY && fs.existsSync("/usr/share/omarchy/bin")) assert.ok(fs.existsSync(`/usr/share/omarchy/bin/omarchy-agent-usage-${a.builtin}`), `${a.id}: builtin names a real Omarchy usage collector`);
}
for (const t of ["session_weekly", "monthly_credits", "request_count", "byok_no_limits", "free_no_limits", "no_usage_data"]) assert.ok(types[t], `type ${t} defined`);
// An unsure entry says so on its tab; a sure one doesn't.
const openclaw = agents.find((a) => a.id === "openclaw"), mcode = agents.find((a) => a.id === "mcode");
assert.equal(tabNote(openclaw, types), "Bring your own key, no limits of its own.\nUsage depends on your model provider.", "OpenClaw: two plain lines");
assert.doesNotMatch(tabNote(openclaw, types), /verified|doctor/i, "no verification note or repair hint on its tab");
assert.match(tabNote(agents.find((a) => a.id === "dsh"), types), /Not fully verified/, "other unsure entries still say so");
assert.doesNotMatch(tabNote(mcode, types), /Not fully verified/);
assert.deepEqual(catalogIds(), ids);
assert.deepEqual(loadCatalog("/nonexistent.json"), { types: {}, agents: [], dropped: {} }, "a missing catalog is empty, not a crash");

// ---- catalog agents you don't have stay off the bar, through the same "hide uninstalled" switch as the rest.
// Run the real collector with nothing installed: every catalog agent must come out `installed: false`, and the panel
// only shows an uninstalled tab when that switch is turned off.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-hide-"));
const emptyBin = path.join(tmp, "bin"); fs.mkdirSync(emptyBin);
const r = spawnSync(process.execPath, [path.join(here, "collect.mjs"), "--volume", "0", "--notify", "100"], {
  encoding: "utf8", timeout: 60000,
  env: { PATH: emptyBin, HOME: tmp, XDG_STATE_HOME: path.join(tmp, "state"), XDG_CONFIG_HOME: path.join(tmp, "config") },
});
const dataFile = path.join(tmp, "state/omarchy/agent-usage-tabs/data.json");
assert.ok(fs.existsSync(dataFile), "the collector wrote data.json: " + String(r.stderr || r.error).slice(0, 300));
const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
for (const id of ids) {
  const a = data.agents.find((x) => x.id === id);
  assert.ok(a, `${id} has a record`);
  assert.equal(a.installed, false, `${id} is reported as not installed`);
  assert.equal(a.planNote ?? "", "", `${id}: no note or data for an agent you don't have`);
}
const qml = fs.readFileSync(path.join(here, "..", "Panel.qml"), "utf8");
assert.match(qml, /return a\.installed !== false \? hiddenAgents\.indexOf\(a\.id\) < 0 : !hideUninstalled/, "an uninstalled tab shows only when hide-uninstalled is off");
assert.match(qml, /hideUninstalledAgents !== false/, "hide-uninstalled defaults to on");
fs.rmSync(tmp, { recursive: true, force: true });
console.log("catalog: all tests passed");
