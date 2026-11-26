import assert from "node:assert/strict";
import { isFreeModel, pickFreeModel, kiloArgs, costCheck } from "./kilo-free.mjs";

// --- isFreeModel ---
assert.equal(isFreeModel("kilo-auto/free"), true);
assert.equal(isFreeModel("Kilo-Auto/Free"), true);
assert.equal(isFreeModel("openrouter/some-model:free"), true);
assert.equal(isFreeModel("anthropic/claude-sonnet-4/free"), true);
assert.equal(isFreeModel("anthropic/claude-sonnet-4.6"), false, "paid model id");
assert.equal(isFreeModel("gpt-5"), false, "unknown id is NOT free");
assert.equal(isFreeModel(""), false);
assert.equal(isFreeModel(null), false);
assert.equal(isFreeModel(42), false);

// models-cache entry: zero input/output cost AND an explicit free tag.
const cached = { cost: { input: 0, output: 0 }, tag: "free" };
assert.equal(isFreeModel("provider/whatever", cached), true);
assert.equal(isFreeModel("provider/whatever", { cost: { input: 0, output: 0 }, tags: ["beta", "Free"] }), true);
assert.equal(isFreeModel("provider/whatever", { cost: { input: 0, output: 0 }, free: true }), true);
assert.equal(isFreeModel("provider/whatever", { cost: { input: 0, output: 0 } }), false, "zero cost without a free tag");
assert.equal(isFreeModel("provider/whatever", { cost: { input: 0.5, output: 0 }, tag: "free" }), false, "paid input cost");
assert.equal(isFreeModel("provider/whatever", { cost: { input: 0, output: 0.1 }, tag: "free" }), false, "paid output cost");
assert.equal(isFreeModel("provider/whatever", { tag: "free" }), false, "tag without cost data");
assert.equal(isFreeModel("provider/whatever", null), false);
assert.equal(isFreeModel("provider/whatever", { cost: { input: "0", output: "0" }, tag: "free" }), true, "string zeros");

// --- pickFreeModel ---
assert.equal(pickFreeModel(["anthropic/claude-sonnet-4.6", "kilo-auto/free", "openrouter/x:free"]), "kilo-auto/free",
  "kilo-auto/free always wins");
assert.equal(pickFreeModel(["anthropic/claude-sonnet-4.6", "openrouter/x:free"]), "openrouter/x:free");
assert.equal(pickFreeModel(["anthropic/claude-sonnet-4.6", { id: "prov/m", entry: { cost: { input: 0, output: 0 }, tag: "free" } }]), "prov/m");
assert.equal(pickFreeModel([{ providerID: "prov", modelID: "m:free" }]), "prov/m:free");
assert.equal(pickFreeModel(["a/paid", "b/paid2"]), null);
assert.equal(pickFreeModel([]), null);
assert.equal(pickFreeModel(null), null);
assert.equal(pickFreeModel(["kilo-auto/free", { id: "openrouter/x:free" }]), "kilo-auto/free");
assert.equal(pickFreeModel(["paid/one", "openrouter/x:free"]), "openrouter/x:free", "first free in order");

// --- kiloArgs ---
assert.deepEqual(kiloArgs("do the thing", "kilo-auto/free"),
  ["run", "--format", "json", "--auto", "-m", "kilo-auto/free", "do the thing"]);
assert.deepEqual(kiloArgs("hi", { id: "openrouter/x:free" }),
  ["run", "--format", "json", "--auto", "-m", "openrouter/x:free", "hi"]);
assert.throws(() => kiloArgs("do the thing", "anthropic/claude-sonnet-4.6"), /not a known free model/);
assert.throws(() => kiloArgs("do the thing", "unknown/model"), /not a known free model/);
assert.throws(() => kiloArgs("do the thing", { id: "prov/m", entry: { cost: { input: 1, output: 0 }, tag: "free" } }),
  /not a known free model/, "cached entry with cost refuses");

// --- costCheck ---
// Clean free run: events naming the free model, zero costs.
const clean = [
  JSON.stringify({ type: "step_start", part: { modelID: "free", providerID: "kilo-auto" } }),
  JSON.stringify({ type: "message.part.updated", part: { type: "text", text: "hi" } }),
  JSON.stringify({ type: "step_finish", part: { modelID: "free", providerID: "kilo-auto", cost: 0, tokens: { input: 10, output: 5 } } }),
].join("\n");
assert.equal(costCheck(clean), null);

// Paid model reported mid-run -> job fails.
const paidModel = JSON.stringify({ type: "step_finish", part: { modelID: "claude-sonnet-4.6", providerID: "anthropic", cost: 0, tokens: {} } });
assert.deepEqual(costCheck(paidModel), { paid: true, reason: "non-free model anthropic/claude-sonnet-4.6" });

// Unknown model id -> not free -> paid.
const unknown = JSON.stringify({ type: "step_finish", part: { modelID: "mystery", cost: 0 } });
assert.equal(costCheck(unknown).paid, true);

// Cost > 0 on an otherwise-free-looking model -> paid.
const cost = JSON.stringify({ type: "step_finish", part: { modelID: "free", providerID: "kilo-auto", cost: 0.0123, tokens: {} } });
assert.deepEqual(costCheck(cost), { paid: true, reason: "cost 0.0123 reported" });

// Nested message.data shape (as stored in kilo.db) inside an event.
const nested = JSON.stringify({ type: "message.updated", message: { data: { role: "assistant", modelID: "gpt-5", providerID: "openai", cost: 0.4, tokens: {} } } });
assert.equal(costCheck(nested).paid, true);

// Junk lines and empty output are ignored.
assert.equal(costCheck(""), null);
assert.equal(costCheck("not json\n{broken\n  \n"), null);

// Pretty-printed multi-line JSON docs are scanned too (comment contract).
const prettyPaid = '{\n  "type": "step_finish",\n  "part": {\n    "modelID": "free",\n    "providerID": "kilo-auto",\n    "cost": 0.5\n  }\n}\n';
assert.deepEqual(costCheck(prettyPaid), { paid: true, reason: "cost 0.5 reported" },
  "pretty-printed doc with cost > 0 is caught");
const prettyModel = '{\n  "part": {\n    "providerID": "anthropic",\n    "modelID": "claude-sonnet-4.6",\n    "cost": 0\n  }\n}\n';
assert.equal(costCheck(prettyModel).paid, true, "pretty-printed doc with non-free model is caught");
const prettyClean = '{\n  "part": {\n    "providerID": "kilo-auto",\n    "modelID": "free",\n    "cost": 0\n  }\n}\n';
assert.equal(costCheck(prettyClean), null, "pretty-printed clean doc passes");
// A pretty doc mixed with one-event-per-line output.
assert.equal(costCheck(JSON.stringify({ type: "x", cost: 0 }) + "\n" + prettyPaid).paid, true,
  "mixed line and pretty docs are both scanned");
// A malformed open doc doesn't swallow the next well-formed event.
assert.equal(costCheck('{broken\n{"cost":0.5}\n').paid, true,
  "malformed fragment followed by a real event still flags the event");
assert.equal(costCheck(JSON.stringify({ type: "step_finish", part: { cost: 0, tokens: {} } })), null,
  "cost 0 without a model is fine");

console.log("kilo-free ok");
