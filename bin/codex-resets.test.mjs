import assert from "node:assert/strict";
import { codexResets } from "./codex-resets.mjs";
assert.equal(codexResets({ tierLabel: "Free" }), null, "your free account: no key, no line");
assert.equal(codexResets(null), null);
assert.equal(codexResets({ resetCredits: { available: 0 } }), null);
assert.equal(codexResets({ resetCredits: { available: "x" } }), null);
assert.deepEqual(codexResets({ resetCredits: { available: 2, nextExpiresAt: "2026-12-10T00:00:00+00:00" } }), { left: 2, usableNow: true, expiresAt: "2026-12-10T00:00:00.000Z" });
assert.deepEqual(codexResets({ resetCredits: { available: 1 } }), { left: 1, usableNow: true, expiresAt: "" });
console.log("codex-resets: all tests passed");
