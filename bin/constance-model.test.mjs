import assert from "node:assert/strict";
import { MODELS, modelRejected, nextModel, modelName } from "./constance-model.mjs";

// The real Claude Code wording for a model the plan doesn't allow (CLI 2.1.331, 2026-11-23).
const REJECT = "There's an issue with the selected model (opus). It may not exist or you may not have access to it. Run --model to pick a different model.";
assert.ok(modelRejected(REJECT));
assert.ok(modelRejected("[claude-code:unrecognized_model] {\"model\":\"x\"}\nError: Invalid model"));
assert.ok(!modelRejected("Claude exited with code 1: ECONNRESET"), "a crash is not a model rejection");
assert.ok(!modelRejected(""), "empty report is not a rejection");

assert.deepEqual(MODELS, ["opus", "sonnet", "haiku"], "best first, cheapest fallback last");
assert.equal(nextModel("opus", REJECT), "sonnet");
assert.equal(nextModel("sonnet", REJECT), "haiku");
assert.equal(nextModel("haiku", REJECT), null, "nothing below haiku: she fails honestly");
assert.equal(nextModel("opus", "rate limit exceeded"), null, "only a model rejection downgrades her");
assert.equal(nextModel("bogus", REJECT), null, "an unknown current model doesn't guess");

assert.equal(modelName("sonnet"), "Sonnet"); assert.equal(modelName("haiku"), "Haiku"); assert.equal(modelName(""), "Opus");
console.log("constance-model: tests passed");
