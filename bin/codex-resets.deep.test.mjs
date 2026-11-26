// Deep edge-case pass for bin/codex-resets.mjs, on top of codex-resets.test.mjs
// and the unit section of codex-deep.test.mjs (which covers the collector
// pipeline end to end).
//
// codexResets(record) is a pure function: it reads record.resetCredits and
// returns {left, usableNow, expiresAt} or null. It does no I/O, reads no
// clock and keeps no state, so there are no timing races or stale-state
// cases to race — the "concurrency" section instead pins determinism and
// proves each call returns a fresh object.
//
// In production `record` is always JSON.parse output (collect.mjs fromBuiltin),
// so exotic values (BigInt, Symbol, getters, prototypes) cannot occur there.
// They are still pinned here as unit-level documentation of what the coercion
// rules do if a caller ever hands it a non-JSON object. The file section at
// the bottom simulates the real boundary: candidate codex.json contents are
// written to a scratch dir and JSON.parse'd before reaching codexResets.
//
// Every file this test touches lives under one fresh fs.mkdtempSync dir, and
// HOME/XDG_STATE_HOME/XDG_CONFIG_HOME/XDG_CACHE_HOME are pointed inside it
// for the duration (restored afterwards). Nothing outside is read or written.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { codexResets } = await import("./codex-resets.mjs");

// ------------------------------------------------------------------ env cage
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-resets-deep-"));
const savedEnv = {};
for (const key of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  savedEnv[key] = process.env[key];
  process.env[key] = path.join(tmp, key.toLowerCase());
  fs.mkdirSync(process.env[key], { recursive: true });
}
let failed = null;
try {
  // ------------------------------------------------- 1. `available` coercions
  // Number() coercion rules the module inherits: only a positive integer
  // survives. Everything else must come back null.
  const avail = (v) => codexResets({ resetCredits: { available: v } });

  assert.equal(avail(false), null, "false -> 0 -> no reset");
  assert.equal(avail(""), null, "empty string -> 0");
  assert.equal(avail("   "), null, "whitespace-only string -> 0");
  assert.equal(avail("2.0")?.left, 2, "BUG?: \"2.0\" is integral after Number() and accepted");
  assert.equal(avail(" 2 ")?.left, 2, "padded numeric string accepted");
  assert.equal(avail("2.5"), null, "fractional numeric string rejected");
  assert.equal(avail("0x10")?.left, 16, "hex string coerces to 16");
  assert.equal(avail("1e2")?.left, 100, "exponent string coerces to 100");
  assert.equal(avail("1e-1"), null, "0.1 is not an integer");
  assert.equal(avail("-0"), null, "\"-0\" -> -0 -> not positive");
  assert.equal(avail(-0), null);
  assert.equal(avail([]), null, "empty array -> 0");
  assert.equal(avail([2])?.left, 2, "BUG?: single-element array [2] coerces to 2");
  assert.equal(avail([1, 2]), null, "multi-element array -> NaN");
  assert.equal(avail({}), null, "plain object -> NaN");
  assert.equal(avail({ valueOf: () => 3 })?.left, 3, "valueOf object coerces");
  assert.equal(avail(10n)?.left, 10, "BigInt coerces via Number()");
  assert.equal(avail(Number.MAX_SAFE_INTEGER)?.left, Number.MAX_SAFE_INTEGER, "max safe integer kept");
  assert.equal(avail(9007199254740993)?.left, 9007199254740992,
    "BUG?: unsafe integer literal silently loses precision but is still 'an integer'");
  assert.equal(avail("999999999999999999999")?.left > 0, true, "huge numeric string accepted as-is");

  // ------------------------------------------------ 2. error paths (hostile input)
  // The module has no try/catch: anything that makes Number() or Date.parse()
  // throw propagates to the caller. Unreachable from JSON, pinned anyway.
  assert.throws(() => codexResets({ resetCredits: { available: Symbol("x") } }),
    TypeError, "Symbol available -> Number() throws, uncaught");
  assert.throws(() => codexResets({ resetCredits: { available: 1, nextExpiresAt: Symbol("x") } }),
    TypeError, "Symbol nextExpiresAt -> Date.parse() throws, uncaught");
  assert.throws(() => codexResets({ get resetCredits() { throw new Error("boom"); } }),
    /boom/, "throwing resetCredits getter propagates");
  assert.throws(() => codexResets({ resetCredits: { get available() { throw new Error("bang"); } } }),
    /bang/, "throwing available getter propagates");

  // ------------------------------------- 3. shapes and prototype-chain reads
  assert.equal(codexResets(), null, "no argument at all");
  assert.equal(codexResets(undefined), null);
  assert.equal(codexResets([]), null, "array record has no resetCredits");
  assert.equal(codexResets(new Date()), null, "Date record has no resetCredits");
  assert.equal(codexResets(Object.create(null)), null, "null-prototype empty record");
  assert.equal(codexResets({ resetCredits: () => {} }), null, "function resetCredits: typeof != object");
  assert.equal(codexResets({ resetCredits: new Number(2) }), null, "boxed Number has no .available");
  assert.equal(codexResets({ resetCredits: Object.create(null) }), null, "empty null-proto resetCredits");
  assert.equal(codexResets(Object.create({ resetCredits: { available: 1 } }))?.left, 1,
    "BUG?: inherited resetCredits is honored (prototype chain is read, not own-props)");

  // ---------------------------------------------------- 4. nextExpiresAt forms
  const exp = (v) => codexResets({ resetCredits: { available: 1, nextExpiresAt: v } });
  assert.equal(exp("2027-01-01")?.expiresAt, "2027-01-01T00:00:00.000Z", "date-only string parses as UTC");
  assert.equal(exp("Wed, 01 Jan 2027 00:00:00 GMT")?.expiresAt, "2027-01-01T00:00:00.000Z", "RFC 2822 parses");
  assert.equal(exp("2027-01-01T00:00:00+05:30")?.expiresAt, "2026-12-31T18:30:00.000Z", "offset normalized to UTC");
  assert.equal(exp("2027-01-01T00:00:00.123Z")?.expiresAt, "2027-01-01T00:00:00.123Z", "millis preserved");
  assert.equal(exp("+275760-09-13T00:00:00Z")?.expiresAt, "+275760-09-13T00:00:00.000Z", "max representable date kept");
  assert.equal(exp("+275761-01-01T00:00:00Z")?.expiresAt, "", "beyond Date range -> unparseable -> empty");
  assert.equal(exp("2027-13-45")?.expiresAt, "", "impossible calendar date -> empty");
  assert.equal(exp(" ")?.expiresAt, "", "whitespace string -> empty");
  assert.equal(exp(null)?.expiresAt, "", "null -> empty");
  assert.equal(exp(false)?.expiresAt, "", "false -> empty");
  assert.equal(exp(0)?.expiresAt, "", "0 is falsy -> treated as absent");
  assert.equal(exp(1735689600000)?.expiresAt, "", "truthy epoch number is not parsed as a date");
  assert.equal(exp(new Date("2027-01-01T00:00:00Z"))?.expiresAt, "2027-01-01T00:00:00.000Z",
    "a Date instance is stringified then parsed");
  assert.equal(exp({ toString: () => "2027-06-01" })?.expiresAt, "2027-06-01T00:00:00.000Z",
    "toString-able object is coerced");
  // "0" is truthy and Date.parse("0") is a real (if absurd) date — year 2000.
  // Expected value is computed through the same Date.parse the module uses,
  // so the assertion is exact regardless of the local timezone.
  const zeroParsed = new Date(Date.parse("0")).toISOString();
  assert.equal(exp("0")?.expiresAt, zeroParsed,
    "BUG?: nextExpiresAt \"0\" yields a year-2000 expiry instead of empty");
  assert.equal(exp("January 1 2027")?.expiresAt, new Date(Date.parse("January 1 2027")).toISOString(),
    "implementation-defined date format passes through Date.parse");

  // ------------------------------------------------ 5. result shape / purity
  const input = { resetCredits: { available: 3, nextExpiresAt: "2027-05-05T00:00:00Z", ignored: "x" } };
  const r1 = codexResets(input);
  const r2 = codexResets(input);
  assert.deepEqual(r1, { left: 3, usableNow: true, expiresAt: "2027-05-05T00:00:00.000Z" });
  assert.notEqual(r1, r2, "each call returns a fresh object");
  r1.left = 99;
  assert.equal(codexResets(input).left, 3, "mutating a result cannot corrupt later calls");
  Object.freeze(input.resetCredits);
  assert.equal(codexResets(input).left, 3, "frozen inputs still work");

  // `available` is read exactly once per call.
  let reads = 0;
  codexResets({ resetCredits: { get available() { reads++; return 1; } } });
  assert.equal(reads, 1, "available is read once, not re-polled");

  // No shared state, no clock reads: 2000 repeated calls are identical.
  const expected = codexResets(input);
  for (let i = 0; i < 2000; i++) assert.deepEqual(codexResets(input), expected);

  // ------------------------------------- 6. the JSON boundary (file contents)
  // codexResets never opens files; collect.mjs feeds it JSON.parse output.
  // Write the candidate codex.json bodies a real record could contain and run
  // each through the same parse -> codexResets path.
  const file = path.join(tmp, "codex.json");
  const throughFile = (text) => {
    fs.writeFileSync(file, text);
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { parsed = undefined; } // collect.mjs diagnoses this case itself
    return parsed === undefined ? "unparseable" : codexResets(parsed);
  };

  assert.equal(throughFile(""), "unparseable", "empty file: JSON.parse throws");
  assert.equal(throughFile("   \n  "), "unparseable", "whitespace-only file");
  assert.equal(throughFile("{ this is not json"), "unparseable", "truncated JSON");
  assert.equal(throughFile("null"), null, "JSON null -> no reset");
  assert.equal(throughFile("[]"), null, "JSON array -> no reset");
  assert.equal(throughFile("42"), null, "JSON number -> no reset");
  assert.equal(throughFile('"text"'), null, "JSON string -> no reset");
  assert.equal(throughFile('{"ready":true,"resetCredits":{"available":0}}'), null, "zero credits");
  assert.equal(throughFile('{"ready":true,"resetCredits":{"available":1.5}}'), null, "fractional credits");
  assert.deepEqual(
    throughFile('{"ready":true,"resetCredits":{"available":2,"nextExpiresAt":"2027-01-01T00:00:00Z"}}'),
    { left: 2, usableNow: true, expiresAt: "2027-01-01T00:00:00.000Z" },
    "well-formed record with credits");
  // JSON can only produce these wrong types; each must degrade to null.
  for (const body of [
    '{"resetCredits":null}',
    '{"resetCredits":{}}',
    '{"resetCredits":{"available":"x"}}',
    '{"resetCredits":{"available":true}}', // NOTE: true -> 1, see BUG? below
    '{"resetCredits":[1,2]}',
    '{"resetCredits":"yes"}',
  ]) {
    const got = throughFile(body);
    if (body.includes('"available":true')) {
      assert.equal(got?.left, 1, "JSON boolean true coerces to 1 credit (already flagged in codex-deep)");
    } else {
      assert.equal(got, null, `${body} -> null`);
    }
  }
  assert.equal(fs.readdirSync(tmp).includes("codex.json"), true, "scratch file stayed inside tmp");
} catch (err) {
  failed = err;
  console.error(err);
} finally {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log("codex-resets.deep: all tests passed");
