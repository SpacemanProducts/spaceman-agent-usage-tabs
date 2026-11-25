// Constance's model router: the fixed steps (plan, review-failed, conflict)
// always Opus, summary always Haiku, and spec/review/fix follow the Milk Opus
// slider at THRESHOLDS (34/67) with failedBefore bumping one tier. claudeArgs
// maps a pick to `--model` argv, logRoute/readRoutes round-trip a JSON-lines
// file (broken lines skipped), splitByModel counts rows per model.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-route-"));

const { STEPS, THRESHOLDS, routeModel, claudeArgs, logRoute, readRoutes, splitByModel } =
  await import("./constance-route.mjs");

assert.deepEqual(STEPS, ["plan", "spec", "review", "review-failed", "conflict", "summary", "fix"]);
assert.deepEqual(THRESHOLDS, { sonnet: 34, opus: 67 });

// Fixed-Opus steps: milk and failedBefore never move them.
for (const step of ["plan", "review-failed", "conflict"]) {
  for (const milk of [0, 25, 50, 100]) {
    for (const failedBefore of [false, true]) {
      const r = routeModel(step, { milk, failedBefore });
      assert.equal(r.model, "opus", `${step} milk=${milk} failed=${failedBefore}`);
      assert.ok(r.why.length > 0);
    }
  }
}

// Summary is always Haiku — unless it failed before, which bumps it to Sonnet.
assert.equal(routeModel("summary").model, "haiku");
assert.equal(routeModel("summary", { milk: 100 }).model, "haiku");
assert.equal(routeModel("summary", { failedBefore: true }).model, "sonnet");
assert.match(routeModel("summary", { failedBefore: true }).why, /bumped to sonnet/);

// Milk-tiered steps: spec, review and fix share the same thresholds.
for (const step of ["spec", "review", "fix"]) {
  for (const milk of [0, 33, -5]) {
    const r = routeModel(step, { milk });
    assert.equal(r.model, "haiku", `${step} milk=${milk}`);
    assert.match(r.why, /picks Haiku/, `${step} why names the pick`);
  }
  for (const milk of [34, 50, 66]) {
    assert.equal(routeModel(step, { milk }).model, "sonnet", `${step} milk=${milk}`);
  }
  for (const milk of [67, 80, 100, 250]) {
    assert.equal(routeModel(step, { milk }).model, "opus", `${step} milk=${milk}`);
  }
}

// Junk milk reads as the default (25 -> Haiku on milk steps).
for (const milk of [NaN, "x", null, undefined, {}]) {
  assert.equal(routeModel("spec", { milk }).model, "haiku", `milk=${JSON.stringify(milk)}`);
}

// failedBefore bumps exactly one tier on milk steps.
assert.equal(routeModel("spec", { milk: 0, failedBefore: true }).model, "sonnet");
assert.equal(routeModel("review", { milk: 40, failedBefore: true }).model, "opus");
assert.equal(routeModel("fix", { milk: 80, failedBefore: true }).model, "opus");
assert.match(routeModel("fix", { milk: 80, failedBefore: true }).why, /already at the top tier/);
assert.match(routeModel("spec", { milk: 0, failedBefore: true }).why, /bumped to sonnet/);

// Unknown steps and bad options never crash; unknown routes to Opus.
assert.equal(routeModel("bogus").model, "opus");
assert.equal(routeModel().model, "opus", "no args -> unknown step -> Opus");
assert.equal(routeModel("spec", null).model, "haiku", "null options -> defaults");

// claudeArgs: the argv pair for the claude CLI; junk falls back to Opus.
assert.deepEqual(claudeArgs("opus"), ["--model", "opus"]);
assert.deepEqual(claudeArgs("sonnet"), ["--model", "sonnet"]);
assert.deepEqual(claudeArgs("haiku"), ["--model", "haiku"]);
assert.deepEqual(claudeArgs("bogus"), ["--model", "opus"]);
assert.deepEqual(claudeArgs(undefined), ["--model", "opus"]);

// logRoute/readRoutes: nested dirs are created, records round-trip, junk lines skip.
const file = path.join(dir, "nested", "routes.jsonl");
assert.deepEqual(readRoutes(file), [], "missing file -> []");
logRoute(file, { step: "plan", model: "opus", job: 1, at: 100 });
logRoute(file, { step: "spec", model: "haiku", job: 2, at: 200 });
logRoute(file, { step: "summary", model: "haiku", job: null });   // at defaults to now
fs.appendFileSync(file, "{broken\n");
fs.appendFileSync(file, "5\n");                                   // valid JSON, not an object
fs.appendFileSync(file, "\n");
const rows = readRoutes(file);
assert.equal(rows.length, 3);
assert.deepEqual(rows[0], { step: "plan", model: "opus", job: 1, at: 100 });
assert.deepEqual(rows[1], { step: "spec", model: "haiku", job: 2, at: 200 });
assert.equal(rows[2].step, "summary");
assert.ok(Number.isFinite(rows[2].at), "at defaults to a timestamp");

// splitByModel: objects and bare strings count; unknowns and junk don't.
assert.deepEqual(splitByModel(rows), { opus: 1, sonnet: 0, haiku: 2 });
assert.deepEqual(splitByModel(["opus", "haiku", "haiku", "bogus", null, {}]),
  { opus: 1, sonnet: 0, haiku: 2 });
assert.deepEqual(splitByModel([]), { opus: 0, sonnet: 0, haiku: 0 });
assert.deepEqual(splitByModel(null), { opus: 0, sonnet: 0, haiku: 0 });

fs.rmSync(dir, { recursive: true, force: true });
console.log("constance-route: tests passed");
