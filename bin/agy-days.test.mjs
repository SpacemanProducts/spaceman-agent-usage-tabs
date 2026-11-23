import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addTranscript, agyLastDays, modelKey } from "./agy-days.mjs";
// Steps shaped like agy's transcript.jsonl (fields trimmed).
const step = (o) => JSON.stringify({ type: "PLANNER_RESPONSE", ...o });
const now = Date.parse("2026-11-22T12:00:00");
const since = Date.parse("2026-11-16T00:00:00");
const text = [
  step({ created_at: "2026-11-20T10:00:00Z", input_tokens: 5, output_tokens: 5 }),                                     // no model yet: unknown
  step({ created_at: "2026-11-10T10:00:00Z", model: "gemini-3.8-flash-high", input_tokens: 999, output_tokens: 1 }),   // older than 7 days
  step({ created_at: "2026-11-20T10:01:00Z", content: "Changed `Model Selection` to Gemini 3.8 Flash (High). ok" }),
  step({ created_at: "2026-11-20T10:02:00Z", input_tokens: 100, cache_read_tokens: 50, output_tokens: 10 }),            // carries the selection
  step({ created_at: "2026-11-21T10:00:00Z", model: "gemini-flash-worker-agy", usage: { prompt_token_count: 40, cached_content_token_count: 10, candidates_token_count: 3, thoughts_token_count: 2 } }),
  step({ input_tokens: 7 }),                                                                                            // no date: skipped
  "not json",
].join("\n");
const m = addTranscript(text, since, {});
assert.equal(modelKey("Gemini 3.8 Flash (High)"), "gemini-3.8-flash-high");
assert.deepEqual(m["unknown"], { inputTokens: 5, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
assert.deepEqual(m["gemini-3.8-flash-high"], { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 50, cacheCreationInputTokens: 0 });
assert.deepEqual(m["gemini-flash-worker-agy"], { inputTokens: 30, outputTokens: 5, cacheReadInputTokens: 10, cacheCreationInputTokens: 0 });
// From disk: no brain folder -> null (keep Omarchy's numbers); with one -> the 7-day map.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-days-"));
assert.equal(agyLastDays(dir, now), null);
const logs = path.join(dir, "brain", "c1", ".system_generated", "logs"); fs.mkdirSync(logs, { recursive: true });
fs.writeFileSync(path.join(logs, "transcript.jsonl"), text);
assert.equal(agyLastDays(dir, now)["gemini-3.8-flash-high"].inputTokens, 100);
fs.rmSync(dir, { recursive: true, force: true });
console.log("agy-days ok");
