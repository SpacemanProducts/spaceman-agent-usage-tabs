import assert from "node:assert/strict";
import { loadCatalog, tabNote, USAGE_TYPES, catalogIds } from "./catalog.mjs";
const { types, agents } = loadCatalog();
assert.equal(agents.length, 20, "twenty agents");
const CORE = ["claude", "antigravity", "grok", "codex", "copilot", "cursor", "opencode", "kimi", "kiro", "devin", "amp", "hermes"];
const CORE_BINS = ["claude", "agy", "antigravity", "grok", "codex", "copilot", "cursor-agent", "opencode", "kimi", "kiro-cli", "devin", "amp", "hermes"];
const ids = agents.map((a) => a.id);
assert.equal(new Set(ids).size, ids.length, "unique ids");
for (const want of ["cline", "goose", "qwen", "crush", "kilo", "openhands", "plandex", "codewhale", "reasonix", "aider"]) assert.ok(ids.includes(want), `${want} is in the catalog`);
for (const a of agents) {
  assert.ok(!CORE.includes(a.id), `${a.id} must not clash with a core agent`);
  assert.ok(!a.bins.some((b) => CORE_BINS.includes(b)), `${a.id}: a binary already belongs to a core agent`);
  assert.ok(USAGE_TYPES.includes(a.usageType), `${a.id}: usage type`);
  assert.ok(types[a.usageType]?.label && types[a.usageType]?.tabNote, `${a.id}: the type has a label and a note`);
  assert.ok(a.bins.length > 0 && a.bins.every((b) => /^[\w.-]+$/.test(b)), `${a.id}: binaries are plain names`);
  assert.ok(a.note && a.note.length > 30, `${a.id}: has a real note`);
  assert.ok(Array.isArray(a.sources) && a.sources.length > 0 && a.sources.every((s) => /^https:\/\//.test(s)), `${a.id}: cites https sources`);
  if ("unsure" in a) assert.ok(String(a.unsure).length > 20, `${a.id}: an unsure flag says why`);
}
// Every usage type the request names exists, so a tab can always get its note.
for (const t of ["session_weekly", "monthly_credits", "request_count", "byok_no_limits", "free_no_limits", "no_usage_data"]) assert.ok(types[t], `type ${t} defined`);
// The tab note carries the type, the specifics, and an honest flag when unsure.
const aider = agents.find((a) => a.id === "aider");
assert.match(tabNote(aider, types), /^Bring your own key\. Free and open source/);
assert.match(tabNote(aider, types), /Not fully verified/);
assert.doesNotMatch(tabNote(agents.find((a) => a.id === "goose"), types), /Not fully verified/);
assert.deepEqual(catalogIds(), ids);
assert.deepEqual(loadCatalog("/nonexistent.json"), { types: {}, agents: [] }, "a missing catalog is empty, not a crash");
console.log("catalog: all tests passed");
