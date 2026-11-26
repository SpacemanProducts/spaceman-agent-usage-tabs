// Deeper edge-case pass on bin/accounts.mjs (buildAccounts). The module is a
// pure function over the parsed JSON of `omarchy-agent-account-list --json`;
// it touches no files, so every case here is in-process with node:assert.
// Complements accounts.test.mjs (which only checks the happy path, the
// 2-signed-in rule and the no-email/org/home leak).
//
// Tests that pin down bugs live next to the behaviour they guard; a fix in
// bin/accounts.mjs turns them from crashes into passing assertions.
import assert from "node:assert/strict";
import { buildAccounts } from "./accounts.mjs";

const acc = (id, extra = {}) => ({ id, label: String(id).toUpperCase(), plan: "Pro", signedIn: true, ...extra });
const prov = (provider, accounts, extra = {}) => ({ provider, accounts, ...extra });
const two = (a, b, extra = {}) => prov("p", [a, b], extra);
const lim = (label, percent, extra = {}) => ({ label, percent, ...extra });

// ============================================================ input shapes
// Anything that is not an array of provider objects yields {} and never throws.
for (const list of [null, undefined, 0, "", "x", 42, true, {}, { length: 2 }, [[]]])
  assert.deepEqual(buildAccounts(list), {}, `list=${JSON.stringify(list)} -> {}`);
assert.deepEqual(buildAccounts([]), {});

// Provider entries that are not usable objects are skipped safely.
for (const p of [null, undefined, 0, "", "x", 42, true, [], [{}], prov("p"), prov("p", "not-array"), prov("p", null), prov("p", 5)])
  assert.deepEqual(buildAccounts([p]), {}, `provider entry ${JSON.stringify(p)} -> skipped`);
// ... but a truthy non-string provider is used as an object key anyway.
{
  const r = buildAccounts([prov(123, [acc("a"), acc("b")])]);
  assert.deepEqual(Object.keys(r), ["123"], "QUIRK: numeric provider 123 becomes key \"123\"");
}
{
  const r = buildAccounts([prov("", [acc("a"), acc("b")]), prov(null, [acc("a"), acc("b")])]);
  assert.deepEqual(r, {}, "falsy providers are skipped");
}

// ============================================================ the 2+ signed-in rule
// Exactly two signed-in accounts is enough; one signed-in + any number of
// signed-out/absent ones is not. `signedIn` is a truthiness check, not === true.
assert.deepEqual(buildAccounts([two(acc("a"), { ...acc("b"), signedIn: false })]), {}, "1 signed-in is not enough");
{
  const r = buildAccounts([prov("p", [acc("a"), acc("b", { signedIn: "yes" }), acc("c", { signedIn: 1 }), acc("d", { signedIn: 0 })])]);
  assert.equal(r.p.length, 3, "QUIRK: signedIn is truthy - \"yes\" and 1 count, 0 does not");
  assert.deepEqual(r.p.map((x) => x.id), ["a", "b", "c"], "signed-out accounts are dropped, order kept");
}
{
  // accounts entries that are falsy or have no truthy signedIn never count.
  const r = buildAccounts([prov("p", [null, undefined, 0, "", "x", 5, {}, acc("a"), acc("b")])]);
  assert.equal(r.p.length, 2, "junk account entries are filtered before the count");
}
{
  // providers are emitted in first-seen order; a repeated provider overwrites.
  const r = buildAccounts([
    prov("claude", [acc("a"), acc("b")]),
    prov("codex", [acc("x"), acc("y")]),
    prov("claude", [acc("c"), acc("d")]),
  ]);
  assert.deepEqual(Object.keys(r), ["claude", "codex"], "key order is first-seen");
  assert.deepEqual(r.claude.map((x) => x.id), ["c", "d"], "QUIRK: a duplicate provider's LAST entry wins");
}

// ============================================================ account field quirks
{
  const r = buildAccounts([two(
    { signedIn: true },                                        // no id at all
    acc("b", { label: 0, plan: null }),                        // falsy label falls back to id; falsy plan -> ""
  )]);
  assert.deepEqual(r.p[0], { id: "undefined", label: "undefined", plan: "", active: false, limits: [] },
    "QUIRK: a missing id stringifies to \"undefined\", used for both id and label");
  assert.deepEqual(r.p[1], { id: "b", label: "b", plan: "", active: false, limits: [] },
    "label 0 falls back to id; plan null -> empty string");
}
{
  const r = buildAccounts([two(
    acc("a", { id: 7, label: "", plan: 9, active: "yes" }),
    acc("b", { active: 0 }),
  )]);
  // id is replaced AFTER acc() spread? No - acc sets id first, extra overrides.
  assert.equal(r.p[0].id, "7", "numeric id is stringified");
  assert.equal(r.p[0].label, "7", "empty label falls back to the stringified id");
  assert.equal(r.p[0].plan, "9", "numeric plan is stringified");
  assert.equal(r.p[0].active, true, "QUIRK: active is !!-coerced - \"yes\" is active");
  assert.equal(r.p[1].active, false);
}
{
  // Nothing outside {id,label,plan,active,limits} survives - nested junk too.
  const r = buildAccounts([two(acc("a", { email: "x@y.z", home: "/h", org: "o", nested: { secret: 1 } }), acc("b"))]);
  assert.ok(!JSON.stringify(r).match(/x@y|"home"|"org"|secret/), "no extra fields leak, even nested");
}

// ============================================================ limits filtering
{
  const r = buildAccounts([two(
    acc("a", { limits: [
      lim("Session", 0),          // 0% is a real reading, kept
      lim("Weekly", -0.5),        // negative dropped
      lim("Monthly", 1.7),        // over 100 clamps to 1
      lim("x", "abc"),            // NaN dropped
      lim("y", null),             // QUIRK: Number(null) === 0 -> kept as a 0% meter!
      lim("z", ""),               // QUIRK: Number("") === 0 -> kept as 0%
      lim("w", true),             // QUIRK: Number(true) === 1 -> 100%
      lim("v", false),            // Number(false) === 0 -> kept as 0%
      lim("u", {}),               // NaN dropped
      lim("t", [0.25]),           // Number([0.25]) === 0.25 -> kept
      lim("s", Infinity),         // clamped to 1
      lim("r", "Infinity"),       // string Infinity parses -> clamped to 1
      "junk",                     // no .percent -> NaN -> dropped
      5,                          // same
    ] }),
    acc("b"),
  )]);
  const got = r.p[0].limits.map((l) => [l.title, l.percent]);
  assert.deepEqual(got, [
    ["Session", 0], ["Monthly", 1], ["y", 0], ["z", 0], ["w", 1], ["v", 0], ["t", 0.25], ["s", 1], ["r", 1],
  ], "filter+clamp quirks: null/\"\"/false become 0%, true/Infinity become 100%");
}
{
  // `limits` that are falsy or a real array are fine; truthy non-arrays crash.
  for (const limits of [undefined, null, 0, "", false])
    assert.deepEqual(buildAccounts([two(acc("a", { limits }), acc("b"))]).p[0].limits, [],
      `limits=${JSON.stringify(limits)} -> []`);
  assert.deepEqual(buildAccounts([two(acc("a", { limits: [] }), acc("b"))]).p[0].limits, []);
}
// A truthy non-array `limits` (string, number, plain object) is treated as no
// limits: no meter is shown that the source did not report.
for (const limits of ["abc", 5, {}])
  assert.deepEqual(buildAccounts([two(acc("a", { limits }), acc("b"))]).p[0].limits, [],
    `limits=${JSON.stringify(limits)} -> []`);
// Null/undefined entries inside `limits` are skipped like any other junk entry.
assert.deepEqual(buildAccounts([two(acc("a", { limits: [null] }), acc("b"))]).p[0].limits, []);
assert.deepEqual(buildAccounts([two(acc("a", { limits: [undefined] }), acc("b"))]).p[0].limits, []);
assert.deepEqual(buildAccounts([two(acc("a", { limits: [null, lim("Session", 0.5), undefined] }), acc("b"))]).p[0].limits.map((l) => l.title), ["Session"],
  "null entries are skipped, real meters survive");

// ============================================================ titleFor via label/title
{
  const titles = (label, title) => buildAccounts([two(acc("a", { limits: [lim(label, 0.5, title ? { title } : {})] }), acc("b"))]).p[0].limits.map((l) => l.title);
  // Priority: month > week > session/hour, first match wins.
  assert.deepEqual(titles("Monthly and weekly", undefined), ["Monthly"], "month wins over week");
  assert.deepEqual(titles("7-day session", undefined), ["Weekly"], "week wins over session");
  assert.deepEqual(titles("5-hour", undefined), ["Session"]);
  assert.deepEqual(titles("30-day", undefined), ["Monthly"], "/30-day/ matches month");
  assert.deepEqual(titles("720h", undefined), ["Monthly"]);
  assert.deepEqual(titles("24-hour", undefined), ["Session"], "QUIRK: bare 'hour' matches any hour-ish label");
  assert.deepEqual(titles("Hourly", undefined), ["Session"]);
  // Case-insensitive.
  assert.deepEqual(titles("WEEKLY (7-DAY)", undefined), ["Weekly"]);
  // No pattern match: the raw label is returned, not "Limit".
  assert.deepEqual(titles("Compute units", undefined), ["Compute units"]);
  // Fallback chain: falsy label -> title -> "Limit".
  assert.deepEqual(titles("", "Weekly quota"), ["Weekly"], "empty label falls back to title, then pattern-matches it");
  assert.deepEqual(titles(0, "Custom"), ["Custom"]);
  assert.deepEqual(titles(null, null), ["Limit"]);
  assert.deepEqual(titles(undefined, undefined), ["Limit"]);
  // Non-string labels are stringified before matching.
  assert.deepEqual(titles(42, undefined), ["42"]);
}

// ============================================================ resetsAt passthrough
{
  const r = buildAccounts([two(
    acc("a", { limits: [
      lim("Session", 0.5, { resetsAt: "2026-12-01T00:00:00Z" }),
      lim("Weekly", 0.2, { resetsAt: 1767225600000 }),   // QUIRK: non-string passes through raw
      lim("Monthly", 0.1, { resetsAt: 0 }),              // falsy -> ""
      lim("x", 0.3),                                     // missing -> ""
    ] }),
    acc("b"),
  )]);
  assert.deepEqual(r.p[0].limits.map((l) => l.resetsAt),
    ["2026-12-01T00:00:00Z", 1767225600000, "", ""],
    "resetsAt: string kept, number kept RAW (not stringified), falsy/missing -> \"\"");
}

// ============================================================ purity / no shared state
{
  // Two calls on the same input produce independent objects.
  const input = [two(acc("a"), acc("b"))];
  const r1 = buildAccounts(input);
  const r2 = buildAccounts(input);
  r1.p[0].limits.push({ title: "Injected", percent: 1, resetsAt: "" });
  r1.p[0].id = "mutated";
  assert.equal(r2.p[0].id, "a");
  assert.deepEqual(r2.p[0].limits, []);
  // Mutating the input afterwards does not change an already-built result.
  input[0].accounts[0].id = "changed";
  assert.equal(r1.p[0].id, "mutated", "result is a snapshot, not a view");
}

console.log("accounts deep: all tests passed");
