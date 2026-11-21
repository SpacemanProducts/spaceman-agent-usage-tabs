import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { PARSERS, liveModels } from "./live-models.mjs";

const agy = "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n";
assert.deepEqual(PARSERS.agy(agy).map((m) => m.id), ["gemini-3.8-flash-high", "claude-sonnet-4-6", "gpt-oss-120b-medium"]);
assert.equal(PARSERS.agy(agy)[1].name, "Claude Sonnet 4.6 (Thinking)");

assert.deepEqual(PARSERS.grok("You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n").map((m) => m.id), ["grok-4.7"]);
assert.deepEqual(PARSERS.grok("You are not authenticated.\n"), []);

assert.deepEqual(PARSERS.opencode("ollama/qwen3:latest\nopencode/big-pickle\nnoise line\nopencode/big-pickle\n").map((m) => m.name), ["qwen3:latest", "big-pickle"]);

const devin = "Available models (56 families)\n\nAdaptive (adaptive)\n  adaptive   Adaptive  [$0.5]\n\nClaude Fable 5.2 (claude-fable-5.2)\n  claude-fable-5-2-medium   Claude Fable 5.2 Medium\n\nSWE-2 Flash (swe-2-flash)\n  swe-2-flash-high  SWE-2 Flash High\n";
assert.deepEqual(PARSERS.devin(devin).map((m) => m.id), ["adaptive", "claude-fable-5.2", "swe-2-flash"]);

assert.deepEqual(PARSERS.kiro("Available models (* = default):\n\n* auto                 1.00x credits      Models chosen by task\n  claude-sonnet-4.5    1.30x credits      Claude Sonnet 4.5 model\n  qwen3-coder-next     0.05x credits      Experimental\n").map((m) => m.id), ["auto", "claude-sonnet-4.5", "qwen3-coder-next"]);

const codex = JSON.stringify({ models: [{ slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide" }, { slug: "gpt-6-luna", display_name: "GPT-6-Luna", visibility: "list" }, { slug: "codex-auto-review", visibility: "hide" }] });
assert.deepEqual(PARSERS.codex(codex), [{ id: "gpt-6-luna", name: "GPT-6-Luna" }], "hidden models are not user-selectable");
assert.deepEqual(PARSERS.codex("not json"), []);

// Runner: cache for 6h, keep last good list on failure, null for agents with no list command.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm-")); let calls = 0;
const run = () => { calls++; return agy; };
assert.equal(liveModels("hermes", { stateDir: dir, env: {}, run }), null);
assert.equal(liveModels("antigravity", { stateDir: dir, env: {}, now: 1000, run }).length, 3); assert.equal(calls, 1);
liveModels("antigravity", { stateDir: dir, env: {}, now: 1000 + 3600e3, run }); assert.equal(calls, 1, "cached within 6h");
const failing = () => { calls++; return "garbage"; };
assert.equal(liveModels("antigravity", { stateDir: dir, env: {}, now: 1000 + 7 * 3600e3, run: failing }).length, 3, "failure keeps last good list"); assert.equal(calls, 2);
assert.equal(liveModels("grok", { stateDir: dir, env: {}, run: failing }), null, "failure with no cache -> no live list");
fs.rmSync(dir, { recursive: true });
console.log("live-models: all tests passed");
