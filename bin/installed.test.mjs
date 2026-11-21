import assert from "node:assert/strict";
import { makeInstalledCheck } from "./installed.mjs";

const files = new Set(["/usr/bin/claude", "/home/u/.local/share/mise/shims/crush", "/home/u/.local/share/mise/shims/amp", "/real/amp", "/home/u/.local/bin/hermes"]);
const executable = (f) => files.has(f);
let whichCalls = 0;
const which = (bin) => { whichCalls++; return bin === "amp" ? "/real/amp" : ""; };
const dirs = ["/usr/bin", "/home/u/.local/bin", "/home/u/.local/share/mise/shims"];
const isInstalled = makeInstalledCheck({ dirs, executable, which });

assert.equal(isInstalled(["claude"]), true, "plain binary on PATH");
assert.equal(isInstalled(["hermes"]), true, "~/.local/bin");
assert.equal(isInstalled(["crush"]), false, "lazy shim that mise cannot resolve is NOT installed");
assert.equal(isInstalled(["amp"]), true, "shim that resolves to a real file is installed");
assert.equal(isInstalled(["nothing"]), false, "not found anywhere");
assert.equal(isInstalled(["agy", "antigravity", "claude"]), true, "any alias counts");
isInstalled(["crush"]); isInstalled(["crush"]); assert.equal(whichCalls, 2, "mise asked once per shim (crush, amp), then memoized");
assert.equal(makeInstalledCheck({ dirs, executable: (f) => f === "/home/u/.local/share/mise/shims/amp", which: () => "/gone" })(["amp"]), false, "shim resolving to a missing file is not installed");
assert.equal(makeInstalledCheck({ dirs: [], executable })(["claude"]), false, "no dirs");
console.log("installed: all tests passed");
