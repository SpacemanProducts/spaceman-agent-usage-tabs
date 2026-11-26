// Deep edge-case pass for bin/plan-limits.mjs on top of plan-limits.test.mjs.
// The module is two pure functions over a regex (isPlanLimit / planLimitsOnly);
// it reads no files and keeps no state, so there are no timing races, stale
// state or clock edges to race. The scratch dir only exists to satisfy the
// "never touch the real home folder" rule.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPlanLimit, planLimitsOnly } from "./plan-limits.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-limits-deep-"));
const savedEnv = {};
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  savedEnv[k] = process.env[k];
  process.env[k] = path.join(tmp, k.toLowerCase());
  fs.mkdirSync(process.env[k], { recursive: true });
}

try {
  // ---- isPlanLimit: non-string / missing fields ----
  for (const v of [undefined, null, 0, 1, -1, NaN, Infinity, true, false, 10n, Symbol("s"), {}, [], ["x"], function namedFn() { return 1; }]) {
    assert.equal(isPlanLimit({ title: v }), true, `title=${String(v)} is kept (coerced, matches nothing)`);
    assert.equal(isPlanLimit({ detail: v }), true, `detail=${String(v)} is kept`);
  }
  // String(fn) exposes the source, so a function whose source mentions a
  // keyword is filtered like any other coerced value (documents behavior).
  assert.equal(isPlanLimit({ title: () => "overage" }), false, "arrow-fn source contains 'overage'");
  assert.equal(isPlanLimit({ title: () => 1 }), true, "arrow-fn source '() => 1' is clean");
  assert.equal(isPlanLimit({}), true, "empty object kept");
  assert.equal(isPlanLimit(Object.create(null)), true, "null-prototype object kept");
  assert.equal(isPlanLimit("overage"), true, "a bare string limit has no .title, so the keyword is invisible (documents current behavior)");
  assert.equal(isPlanLimit(42), true);
  assert.equal(isPlanLimit(true), true);

  // ---- isPlanLimit: keyword coercion through String() ----
  assert.equal(isPlanLimit({ title: ["Overage"] }), false, "single-element array stringifies to the keyword");
  assert.equal(isPlanLimit({ title: ["Weekly", "Spend cap"] }), false, "joined array still contains the keyword");
  assert.equal(isPlanLimit({ title: { toString: () => "top-up balance" } }), false, "custom toString is honoured");
  assert.equal(isPlanLimit({ title: 0, detail: ["on-demand"] }), false, "detail array stringifies and matches");
  assert.equal(isPlanLimit({ title: "Weekly", detail: { toString: () => "auto-reload on" } }), false);

  // ---- isPlanLimit: case and position ----
  for (const t of ["OVERAGE", "oVeRaGe UsAgE", "Spend Cap", "TOP-UP", "Auto-ReLoad", "PAY AS YOU GO"]) {
    assert.equal(isPlanLimit({ title: t }), false, `${t} filtered case-insensitively`);
  }
  // Word gaps accept any run of separators, so 'on- demand' (hyphen + space)
  // is caught too.
  assert.equal(isPlanLimit({ title: "on- demand usage" }), false, "'on- demand' matches on[-\\s]*demand");

  // ---- isPlanLimit: separator variants ----
  for (const t of ["on-demand", "on demand", "ondemand", "top-up", "top up", "topup", "auto-reload", "auto reload", "autoreload", "pay-as-you-go", "pay as you go", "pay as-you-go"]) {
    assert.equal(isPlanLimit({ title: t }), false, `${t} filtered`);
  }
  assert.equal(isPlanLimit({ title: "payasyougo" }), true, "pay[- ]as[- ]you[- ]go requires one separator per gap; run-together text kept (documents current behavior)");
  assert.equal(isPlanLimit({ title: "pay as-you go" }), false, "each gap may be a hyphen OR a space, mixed is fine");
  assert.equal(isPlanLimit({ title: "extra usage" }), false);
  assert.equal(isPlanLimit({ title: "EXTRA USAGE" }), false);
  // 'extra usage' accepts any run of separators (space or hyphen) in the gap.
  assert.equal(isPlanLimit({ title: "extra-usage" }), false, "'extra-usage' matches extra[-\\s]+usage");
  assert.equal(isPlanLimit({ title: "extrausage" }), true);
  assert.equal(isPlanLimit({ title: "extra  usage" }), false, "doubled space matches extra[-\\s]+usage");

  // ---- isPlanLimit: word-boundary and substring edges ----
  assert.equal(isPlanLimit({ title: "Credits bought" }), false, "credits bought phrase filtered");
  assert.equal(isPlanLimit({ title: "credit bought" }), false, "singular 'credit' also matches credits?");
  assert.equal(isPlanLimit({ title: "credits purchased" }), false, "also caught by the bare 'purchas' alternative");
  assert.equal(isPlanLimit({ title: "purchased plan" }), false, "'purchas' alone filters anything containing it");
  assert.equal(isPlanLimit({ title: "repurchase window" }), false, "substring 'purchas' inside 'repurchase' filters too (documents current behavior)");
  assert.equal(isPlanLimit({ title: "bought credits" }), true, "reversed word order is not the credits-bought phrase");
  assert.equal(isPlanLimit({ title: "Credits bought extra" }), false, "trailing words fine, \\b after bought/purchased holds");
  assert.equal(isPlanLimit({ title: "Credits boughtton" }), true, "\\b blocks 'boughtton'");
  // Word gaps accept any run of whitespace/separators, so doubled spaces,
  // tabs and mixed runs of money text are all filtered.
  for (const t of ["On  demand usage", "top  up", "auto  reload", "pay  as  you  go", "pay\tas you go", "extra  usage", "Credits  bought", "Credits\tbought", "on- demand usage"]) {
    assert.equal(isPlanLimit({ title: t }), false, `${JSON.stringify(t)} filtered`);
  }
  // 'spend' and 'balance' are word-boundaried so they can't match inside
  // other words and silently drop a legit plan meter.
  assert.equal(isPlanLimit({ title: "Suspended" }), true);
  assert.equal(isPlanLimit({ title: "Imbalance" }), true);
  assert.equal(isPlanLimit({ title: "unbalanced weekly" }), true);

  // ---- isPlanLimit: title AND detail both checked ----
  assert.equal(isPlanLimit({ title: "Overage", detail: "clean" }), false, "title alone decides");
  assert.equal(isPlanLimit({ title: "Weekly", detail: "spend cap" }), false, "detail alone decides");
  assert.equal(isPlanLimit({ title: "Weekly", detail: "resets Monday" }), true);
  assert.equal(isPlanLimit({ title: null, detail: null }), true);

  // ---- isPlanLimit: throwing getter propagates (inputs are JSON-derived in practice) ----
  const evil = { get title() { throw new Error("boom"); } };
  assert.throws(() => isPlanLimit(evil), /boom/, "a throwing title getter propagates (documents current behavior)");

  // ---- planLimitsOnly: non-array inputs ----
  for (const v of [null, undefined, 0, 1, "Weekly", {}, { length: 1 }, new Set([1]), new Map(), () => []]) {
    assert.deepEqual(planLimitsOnly(v), [], `${Object.prototype.toString.call(v)} -> []`);
  }

  // ---- planLimitsOnly: array edges ----
  assert.deepEqual(planLimitsOnly([]), [], "empty array");
  assert.deepEqual(planLimitsOnly([,]), [], "sparse hole is skipped by filter");
  assert.deepEqual(planLimitsOnly(new Array(3)), [], "all holes skipped");
  const mixed = [{ title: "Weekly" }, null, undefined, 5, "Overage", { title: "Spend cap" }, { title: "Session" }];
  const kept = planLimitsOnly(mixed);
  assert.deepEqual(kept.map((l) => (l && l.title) ?? l), ["Weekly", null, undefined, 5, "Overage", "Session"],
    "non-object entries pass the filter untouched; bare 'Overage' string survives because it has no .title (documents current behavior)");
  assert.notEqual(kept, mixed, "returns a new array");
  assert.deepEqual(mixed.map((l) => (l && l.title) ?? l), ["Weekly", null, undefined, 5, "Overage", "Spend cap", "Session"], "input not mutated");
  const objs = [{ title: "Weekly", extra: 1 }, { title: "Overage" }];
  const out = planLimitsOnly(objs);
  assert.equal(out[0], objs[0], "object identity preserved");
  assert.equal(out[0].extra, 1, "extra fields preserved");
  assert.equal(planLimitsOnly(Object.freeze([{ title: "Overage" }, { title: "Daily" }])).length, 1, "frozen array works");
  // Very large array: no early exit, every element visited.
  const big = Array.from({ length: 100000 }, (_, i) => ({ title: i % 2 ? "Overage" : "Weekly" }));
  assert.equal(planLimitsOnly(big).length, 50000);

  // ---- isPlanLimit/planLimitsOnly: pure and reentrant ----
  const a = { title: "Weekly" }, b = { title: "Overage" };
  assert.deepEqual(planLimitsOnly([a, b, a]), [a, a], "same object repeated kept in order");
  assert.equal(isPlanLimit(a), isPlanLimit(a), "deterministic, no state");

  console.log("plan-limits deep: all tests passed");
} finally {
  for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
