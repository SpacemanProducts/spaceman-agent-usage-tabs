import assert from "node:assert/strict";
import { refreshTargets } from "./refresh-targets.mjs";

const dir = "/state/omarchy/agents/accounts";
const none = () => false;
const claudeOnly = (p) => p === `${dir}/claude.json`;

assert.deepEqual(refreshTargets(["codex", "grok"], dir, none), ["codex", "grok"], "no registry: builtins only");
assert.deepEqual(refreshTargets(["codex", "grok"], dir, claudeOnly), ["codex", "grok", "claude"], "a Claude registry adds the claude collector");
assert.deepEqual(refreshTargets(["codex", "claude", "grok"], dir, claudeOnly), ["codex", "claude", "grok"], "never twice");
assert.deepEqual(refreshTargets([], dir, claudeOnly), ["claude"], "works with no builtins at all");
assert.deepEqual(refreshTargets(["codex"], dir, (p) => p.endsWith("codex.json")), ["codex"], "codex/grok registries need nothing extra: they are builtins already");
console.log("refresh-targets: all tests passed");
