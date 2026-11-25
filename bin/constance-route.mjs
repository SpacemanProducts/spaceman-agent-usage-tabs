// Constance's model router: which Claude model each of her own steps runs on.
// The paid plan pays for every call she makes herself, so cheap steps go to the
// cheapest model that can still do them. STEPS lists every step; routeModel()
// picks opus/sonnet/haiku plus a one-line `why`; claudeArgs() turns a pick into
// the `--model` pair for the claude CLI; logRoute/readRoutes/splitByModel keep
// a small JSON-lines tally (routes.jsonl) so the panel can show where her
// session tokens went.
//
//   plan, review-failed, conflict  always Opus — judgment calls, never cheap.
//   summary                        always Haiku — a recap, not a decision.
//   spec, review, fix              follow the Milk Opus slider (0..100):
//                                  below THRESHOLDS.sonnet (34) Haiku,
//                                  below THRESHOLDS.opus (67) Sonnet,
//                                  67+ Opus. `failedBefore` bumps any step
//                                  one tier (Haiku->Sonnet->Opus) after an
//                                  earlier try failed.
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_MILK } from "./constance-milk.mjs";

export const STEPS = ["plan", "spec", "review", "review-failed", "conflict", "summary", "fix"];
export const THRESHOLDS = { sonnet: 34, opus: 67 };   // milk value where each tier starts
const TIERS = ["haiku", "sonnet", "opus"];            // cheapest first
const MILK_STEPS = new Set(["spec", "review", "fix"]);
const OPUS_STEPS = new Set(["plan", "review-failed", "conflict"]);

// The model for one step. milk is the slider value (clamped 0..100, junk reads
// as DEFAULT_MILK); failedBefore bumps the pick one tier up — a step that was
// already Opus has nowhere higher to go and stays Opus. An unknown step routes
// to Opus: when in doubt she pays for the careful model rather than guessing.
export function routeModel(step, opts) {
  const { milk = DEFAULT_MILK, failedBefore = false } = opts || {};
  const m = Number.isFinite(milk) ? Math.min(100, Math.max(0, milk)) : DEFAULT_MILK;
  let model, why;
  if (OPUS_STEPS.has(step)) {
    model = "opus"; why = `${step} always runs on Opus`;
  } else if (step === "summary") {
    model = "haiku"; why = "summary always runs on Haiku";
  } else if (MILK_STEPS.has(step)) {
    model = m >= THRESHOLDS.opus ? "opus" : m >= THRESHOLDS.sonnet ? "sonnet" : "haiku";
    why = `milk ${Math.round(m)} picks ${model[0].toUpperCase() + model.slice(1)}`;
  } else {
    model = "opus"; why = `unknown step "${step}": Opus`;
  }
  if (failedBefore) {
    const up = TIERS[Math.min(TIERS.indexOf(model) + 1, TIERS.length - 1)];
    if (up !== model) { model = up; why += `; bumped to ${up} after an earlier failure`; }
    else why += "; already at the top tier";
  }
  return { model, why };
}

// The `--model` argv pair for the claude CLI. Short names ("opus", "sonnet",
// "haiku") are what she already passes; anything unrecognized falls back to
// Opus so a typo never silently downgrades a step.
export function claudeArgs(model) {
  return ["--model", TIERS.includes(model) ? model : "opus"];
}

// ---------------------------------------------------------------- routes file

// Append one route record ({step, model, job, at}) as a JSON line. `at`
// defaults to now; callers pass an explicit clock in tests.
export function logRoute(file, { step, model, job, at = Date.now() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ step, model, job, at }) + "\n");
}

// All route records in the file, oldest first. A missing file or broken lines
// read as nothing — the tally is advisory, never worth failing a run over.
export function readRoutes(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === "object") rows.push(r);
    } catch { /* skip broken lines */ }
  }
  return rows;
}

// Counts per model across route rows (or bare model-name strings), so the
// panel can say e.g. "this goal: 12 opus, 30 sonnet, 8 haiku". Unknown models
// are ignored — they were never hers to begin with.
export function splitByModel(rows) {
  const out = { opus: 0, sonnet: 0, haiku: 0 };
  for (const r of rows || []) {
    const m = typeof r === "string" ? r : r && r.model;
    if (m in out) out[m] += 1;
  }
  return out;
}
