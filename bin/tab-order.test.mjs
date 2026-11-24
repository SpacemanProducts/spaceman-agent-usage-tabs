import assert from "node:assert/strict";
import fs from "node:fs"; import vm from "node:vm"; import path from "node:path";
import { fileURLToPath } from "node:url";
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tab-order.js"), "utf8").replace(/^\.pragma library\s*$/m, "");
const ctx = {}; vm.createContext(ctx); vm.runInContext(src, ctx);
const j = (v) => JSON.parse(JSON.stringify(v));
const DEF = ["claude", "antigravity", "grok", "codex", "copilot"];
assert.deepEqual(j(ctx.ordered(DEF, [], DEF)), DEF, "no saved order -> default order");
assert.deepEqual(j(ctx.ordered(DEF, ["grok", "claude"], DEF)), ["grok", "claude", "antigravity", "codex", "copilot"], "saved first, rest in default order");
assert.deepEqual(j(ctx.ordered([...DEF, "newagent"], ["codex"], DEF)), ["codex", "claude", "antigravity", "grok", "copilot", "newagent"], "a new agent goes at the end");
assert.deepEqual(j(ctx.ordered(["claude", "grok"], ["gone", "grok", "claude"], DEF)), ["grok", "claude"], "stale ids dropped");
assert.deepEqual(j(ctx.moveBy(DEF, "grok", -1)), ["claude", "grok", "antigravity", "codex", "copilot"]);
assert.deepEqual(j(ctx.moveBy(DEF, "claude", -1)), DEF, "can't move past the start");
assert.deepEqual(j(ctx.moveBy(DEF, "copilot", 1)), DEF, "can't move past the end");
assert.deepEqual(j(ctx.moveTo(DEF, "copilot", 0)), ["copilot", "claude", "antigravity", "grok", "codex"], "drag to the front");
assert.deepEqual(j(ctx.moveTo(DEF, "claude", 2)), ["antigravity", "grok", "claude", "codex", "copilot"]);
// hidden tabs keep their slots when the visible ones are reordered
assert.deepEqual(j(ctx.mergeVisible(["claude", "antigravity", "grok", "codex"], ["grok", "claude", "codex"])), ["grok", "antigravity", "claude", "codex"]);
// A drop that changes the first tab selects the new default; other drops keep the selection.
assert.equal(ctx.selectAfterDrop("claude", ["antigravity", "claude", "grok"]), "antigravity", "dragged into first spot -> select it");
assert.equal(ctx.selectAfterDrop("claude", ["grok", "claude", "antigravity"]), "grok", "first tab dragged away -> select the new first");
assert.equal(ctx.selectAfterDrop("antigravity", ["antigravity", "grok", "claude"]), "", "first unchanged -> keep selection");
assert.equal(ctx.selectAfterDrop("claude", []), "", "no tabs -> nothing to select");
console.log("tab-order: all tests passed");
