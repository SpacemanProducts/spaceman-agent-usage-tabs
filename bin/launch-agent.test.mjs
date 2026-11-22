import assert from "node:assert/strict";
import { launchArgv, APP_PROMPT } from "./launch-agent.mjs";
const a = (c) => launchArgv(c).argv;
assert.deepEqual(a("claude"), ["claude", "--", APP_PROMPT]);
assert.deepEqual(a("agy"), ["agy", "--prompt-interactive", APP_PROMPT]);
assert.deepEqual(a("cursor-agent").slice(0, 3), ["cursor-agent", "agent", "--"]);
assert.ok(a("amp").includes("bash"), "amp reads its first message from a pipe");
assert.deepEqual(launchArgv("kimi"), { argv: ["kimi"], clipboard: true }, "no prompt option -> clipboard");
for (const c of ["claude","agy","grok","codex","copilot","cursor-agent","opencode","kiro-cli","devin","hermes","amp","kimi"]) {
  const s = JSON.stringify(launchArgv(c).argv);
  assert.ok(!/dangerously|yolo|permission|bypass|trust-all|--auto|approve/i.test(s), `${c}: no permission-skipping flags`);
}
assert.ok(/Omarchy app|omarchy-app/.test(APP_PROMPT));
console.log("launch-agent: all tests passed");
