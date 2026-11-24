import assert from "node:assert/strict";
import { MODELS, modelRejected, nextModel, modelName } from "./constance-model.mjs";

// The real Claude Code wording for a model the plan doesn't allow (CLI 2.1.331, 2026-11-23).
const REJECT = "There's an issue with the selected model (opus). It may not exist or you may not have access to it. Run --model to pick a different model.";
assert.ok(modelRejected(REJECT));
assert.ok(modelRejected("There's an issue with the selected model. It may not exist or you may not have access to it."), "no model name still matches");
assert.ok(modelRejected("There’s an issue with the selected model (sonnet). It may not exist."), "curly apostrophe matches");
assert.ok(modelRejected("THERE'S AN ISSUE WITH THE SELECTED MODEL (HAIKU): IT MAY NOT HAVE ACCESS TO IT."), "any case matches");
assert.ok(modelRejected("There's an issue with the selected model (opus). You may not have access to it."), "the access ending alone matches");

// Look-alike phrases that are NOT Claude Code's rejection must never downgrade her.
const NOT_REJECTS = [
  "File may not exist",
  "Error: invalid model config",
  "You may not have access to it",
  "model not available",
  "startup\n" + "x".repeat(500) + "\nmay not exist", // 'may not exist' alone in long output
  "[claude-code:unrecognized_model] {\"model\":\"x\"}\nError: Invalid model",
  "Claude exited with code 1: ECONNRESET",
  "",
];
for (const text of NOT_REJECTS) {
  assert.ok(!modelRejected(text), `must not match: ${JSON.stringify(text.slice(0, 60))}`);
  assert.equal(nextModel("opus", text), null, `nextModel must be null for: ${JSON.stringify(text.slice(0, 60))}`);
}

assert.deepEqual(MODELS, ["opus", "sonnet", "haiku"], "best first, cheapest fallback last");
assert.equal(nextModel("opus", REJECT), "sonnet");
assert.equal(nextModel("sonnet", REJECT), "haiku");
assert.equal(nextModel("haiku", REJECT), null, "nothing below haiku: she fails honestly");
assert.equal(nextModel("opus", "rate limit exceeded"), null, "only a model rejection downgrades her");
assert.equal(nextModel("bogus", REJECT), null, "an unknown current model doesn't guess");

assert.equal(modelName("sonnet"), "Sonnet"); assert.equal(modelName("haiku"), "Haiku"); assert.equal(modelName(""), "Opus");
console.log("constance-model: tests passed");
