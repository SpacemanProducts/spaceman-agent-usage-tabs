// Deeper edge-case pass on bin/agy-days.mjs (Antigravity last-7-days usage from
// agy's transcript.jsonl files). Complements agy-days.test.mjs, which covers the
// happy path: model carry-over, Model Selection steps, 7-day cutoff and the
// null-vs-map disk contract. This file covers what it doesn't:
//
//   - modelKey / stepTokens wrong-type and malformed-value handling
//   - addTranscript: corrupt/scalar/empty lines, timestamp edges, selection
//     regex boundaries, token-source precedence, accumulation
//   - agyLastDays: brain/transcript filesystem edge cases (missing, files where
//     dirs belong, stale mtimes, unreadable/corrupt transcripts, `days` param)
//   - reentrancy: the module is fully synchronous with no cache, so the only
//     "race" surface is state leaking between calls
//
// Everything lives under one fs.mkdtempSync dir; HOME and the XDG vars are
// pointed there too even though this module takes its root as an argument.
// Tests that pin down SUSPECTED BUGS assert the current behaviour and say so;
// the one clear data-loss bug is kept commented out under a // BUG line.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addTranscript, agyLastDays, modelKey, stepTokens } from "./agy-days.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-days-deep-"));
for (const d of ["home", "state", "config", "cache"])
  fs.mkdirSync(path.join(tmp, d), { recursive: true });
process.env.HOME = path.join(tmp, "home");
process.env.XDG_STATE_HOME = path.join(tmp, "state");
process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
process.env.XDG_CACHE_HOME = path.join(tmp, "cache");

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
const step = (o) => JSON.stringify({ type: "PLANNER_RESPONSE", ...o });
const SINCE = Date.parse("2026-11-16T00:00:00"); // local-time parse, like the module's own math
const NOW = Date.parse("2026-11-22T12:00:00");
const bucket = (inputTokens, outputTokens, cacheReadInputTokens = 0, cacheCreationInputTokens = 0) =>
  ({ inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens });

// ------------------------------------------------------------- modelKey
assert.equal(modelKey(null), "");
assert.equal(modelKey(undefined), "");
assert.equal(modelKey(""), "");
assert.equal(modelKey("   "), "");
assert.equal(modelKey("()"), "", "parentheses-only name keys to empty");
assert.equal(modelKey(42), "42", "numbers stringify");
assert.equal(modelKey({}), "[object-object]", "objects stringify then get key-normalized (quirk, pinned)");
assert.equal(modelKey("  GPT-OSS__120b  "), "gpt-oss-120b", "underscores and spaces collapse to one dash");
assert.equal(modelKey("-Lead--Trail-"), "lead-trail", "edge and doubled dashes stripped");
assert.equal(modelKey("Claude (Opus) (4.5)"), "claude-opus-4.5", "multiple paren groups each become a dash");
assert.equal(modelKey("already-kebab_case Name"), "already-kebab-case-name");

// ------------------------------------------------------------- stepTokens
assert.equal(stepTokens(null), null);
assert.equal(stepTokens(undefined), null);
assert.equal(stepTokens({}), null, "no token keys -> null, not a zero bucket");
assert.equal(stepTokens([]), null, "arrays have no token keys");
// Wrong-type truthy primitives throw inside the `in` operator. addTranscript
// guards with typeof === "object" so it never reaches this, but the export
// itself is not safe on its own. Pinned, reported, not fixed.
assert.throws(() => stepTokens(5), TypeError);
assert.throws(() => stepTokens("x"), TypeError);
assert.throws(() => stepTokens(true), TypeError);

// Explicit zero counts still produce a (zeroed) result because the KEY is what
// matters; addTranscript is what drops all-zero steps.
assert.deepEqual(stepTokens({ prompt_token_count: 0, candidates_token_count: 0 }),
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
assert.deepEqual(stepTokens({ input_tokens: 0 }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

// Gemini-style usage object: cached is clamped to prompt, thoughts add to output.
assert.deepEqual(
  stepTokens({ usage: { prompt_token_count: 10, cached_content_token_count: 50, candidates_token_count: 3, thoughts_token_count: 2 } }),
  { input: 0, output: 5, cacheRead: 10, cacheWrite: 0 }, "cached > prompt clamps; thoughts count as output");
// Anthropic-style keys on the step itself.
assert.deepEqual(stepTokens({ input_tokens: 7, output_tokens: 2, cache_read_tokens: 4, cache_write_tokens: 1 }),
  { input: 7, output: 2, cacheRead: 4, cacheWrite: 1 });
// Anthropic-style keys INSIDE usage.
assert.deepEqual(stepTokens({ usage: { input_tokens: 9, output_tokens: 1 } }),
  { input: 9, output: 1, cacheRead: 0, cacheWrite: 0 });
// usage wins over top-level keys when both are present.
assert.deepEqual(stepTokens({ usage: { prompt_token_count: 10 }, input_tokens: 99, output_tokens: 1 }),
  { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, "usage.prompt_token_count takes precedence");
// A usage object with neither recognised shape falls through to the step's own keys.
assert.deepEqual(stepTokens({ usage: { something_else: 1 }, input_tokens: 3 }),
  { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 });
assert.deepEqual(stepTokens({ usage: "not-an-object", input_tokens: 3 }),
  { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 }, "non-object usage is ignored");
assert.deepEqual(stepTokens({ usage: null, input_tokens: 3 }),
  { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 });
// n() coercion quirks: non-finite and non-positive become 0, but booleans
// count (Number(true) === 1). Pinned.
assert.deepEqual(stepTokens({ input_tokens: -5, output_tokens: 2 }),
  { input: 0, output: 2, cacheRead: 0, cacheWrite: 0 }, "negatives clamp to 0");
assert.deepEqual(stepTokens({ input_tokens: "12", output_tokens: "abc" }),
  { input: 12, output: 0, cacheRead: 0, cacheWrite: 0 }, "numeric strings parse; junk is 0");
assert.deepEqual(stepTokens({ input_tokens: Infinity, output_tokens: NaN }),
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
assert.deepEqual(stepTokens({ input_tokens: true }),
  { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, "quirk: boolean true counts as 1 token");
// A present-but-null prompt_token_count yields an all-zero result and does NOT
// fall through to the step's own input_tokens — the 50 tokens below are lost.
// Malformed-payload behaviour pinned; reported as a possible bug.
assert.deepEqual(stepTokens({ usage: { prompt_token_count: null }, input_tokens: 50 }),
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "present-but-null usage.prompt_token_count shadows top-level input_tokens");

// ------------------------------------------------------------- addTranscript input shapes
const keep = {};
assert.equal(addTranscript("", SINCE, keep), keep, "empty text returns the same map object");
assert.equal(addTranscript(null, SINCE, keep), keep);
assert.equal(addTranscript(undefined, SINCE, keep), keep);
assert.equal(addTranscript(42, SINCE, keep), keep, "non-string input stringifies to nothing parseable");
assert.deepEqual(keep, {});
assert.deepEqual(addTranscript("   \n\n  \n", SINCE, {}), {});
// JSON scalars and arrays parse fine but are skipped (arrays are typeof object
// yet carry no token/model keys).
assert.deepEqual(addTranscript(["5", '"str"', "null", "true", "[1,2]", "{\"a\":1}"].join("\n"), SINCE, {}), {});
// A wrong-type byModel throws (contract is a plain object). Pinned.
assert.throws(() => addTranscript(step({ created_at: "2026-11-20T00:00:00", input_tokens: 1 }), SINCE, null), TypeError);

// ------------------------------------------------------------- addTranscript timestamps
const at = (iso, extra = {}) => step({ created_at: iso, model: "m", input_tokens: 1, output_tokens: 0, ...extra });
// Boundary: ts == since is INCLUDED (the check is ts < since).
assert.deepEqual(addTranscript(at("2026-11-16T00:00:00"), SINCE, {}), { m: bucket(1, 0) },
  "step exactly at `since` counts");
assert.deepEqual(addTranscript(at("2026-11-15T23:59:59"), SINCE, {}), {},
  "one second before `since` is excluded");
// `timestamp` is the fallback when created_at is absent/empty.
assert.deepEqual(addTranscript(step({ timestamp: "2026-11-20T00:00:00", model: "m", input_tokens: 2 }), SINCE, {}),
  { m: bucket(2, 0) });
assert.deepEqual(addTranscript(step({ created_at: "", timestamp: "2026-11-20T00:00:00", model: "m", input_tokens: 2 }), SINCE, {}),
  { m: bucket(2, 0) }, "empty created_at falls back to timestamp");
// BUG (asserted nowhere — commented out, not fixed): a truthy but UNPARSEABLE
// created_at wins the `s.created_at || s.timestamp` pick, so a perfectly good
// `timestamp` is never consulted and the step's tokens are silently dropped.
// Real agy lines carry ISO strings, but a corrupt/hand-edited created_at loses data.
//
// assert.deepEqual(
//   addTranscript(step({ created_at: "not-a-date", timestamp: "2026-11-20T00:00:00", model: "m", input_tokens: 2 }), SINCE, {}),
//   { m: bucket(2, 0) },
//   "BUG: unparseable created_at should fall back to timestamp, not drop the step");
// Numeric epoch-ms timestamps are not parsed by Date.parse(number-or-numeric-string)
// and the step is skipped. Pinned (agy writes ISO strings today).
assert.deepEqual(addTranscript(step({ created_at: 1764000000000, model: "m", input_tokens: 2 }), SINCE, {}), {},
  "numeric created_at is skipped");
assert.deepEqual(addTranscript(step({ created_at: "1764000000000", model: "m", input_tokens: 2 }), SINCE, {}), {},
  "epoch-ms-as-string created_at is also skipped");
// No upper bound: future-dated steps count.
assert.deepEqual(addTranscript(at("2099-01-01T00:00:00"), SINCE, {}), { m: bucket(1, 0) },
  "future timestamps are counted (no upper bound)");
// All-zero token steps never create a bucket.
assert.deepEqual(addTranscript(step({ created_at: "2026-11-20T00:00:00", model: "m", input_tokens: 0, output_tokens: 0 }), SINCE, {}), {});
// ...but a nonzero cache-only step does.
assert.deepEqual(addTranscript(step({ created_at: "2026-11-20T00:00:00", model: "m", cache_write_tokens: 5 }), SINCE, {}),
  { m: bucket(0, 0, 0, 5) });

// ------------------------------------------------------------- addTranscript model handling
// A model-only step (no tokens) still switches `current` for later steps.
assert.deepEqual(addTranscript([
  step({ created_at: "2026-11-20T00:00:00", model: "first-model" }),
  step({ created_at: "2026-11-20T00:01:00", input_tokens: 1 }),
  step({ created_at: "2026-11-20T00:02:00", model: "second-model" }),
  step({ created_at: "2026-11-20T00:03:00", input_tokens: 2 }),
].join("\n"), SINCE, {}),
  { "first-model": bucket(1, 0), "second-model": bucket(2, 0) });
// Field precedence: model > model_name > model_id; non-string or empty-key
// values are skipped without resetting `current`.
assert.deepEqual(addTranscript([
  step({ created_at: "2026-11-20T00:00:00", model: "a", model_name: "b", model_id: "c", input_tokens: 1 }),
  step({ created_at: "2026-11-20T00:01:00", model: 123, model_name: "named", input_tokens: 1 }),
  step({ created_at: "2026-11-20T00:02:00", model: "()", input_tokens: 1 }), // keys to "" -> keeps previous
].join("\n"), SINCE, {}),
  { a: bucket(1, 0), named: bucket(2, 0) });
// Steps before any model name land in "unknown"; it only appears when tokens exist.
assert.deepEqual(addTranscript(step({ created_at: "2026-11-20T00:00:00", model: "()" }), SINCE, {}), {});
// Corrupt lines do NOT reset the carried model (parse failure skips the line entirely).
assert.deepEqual(addTranscript([
  step({ created_at: "2026-11-20T00:00:00", model: "sticky" }),
  "{corrupt",
  step({ created_at: "2026-11-20T00:01:00", input_tokens: 3 }),
].join("\n"), SINCE, {}),
  { sticky: bucket(3, 0) });
// CRLF line endings parse fine.
assert.deepEqual(addTranscript(step({ created_at: "2026-11-20T00:00:00", model: "m", input_tokens: 4 }) + "\r\n", SINCE, {}),
  { m: bucket(4, 0) });
// A UTF-8 BOM kills only the first line's parse; later lines still count.
assert.deepEqual(addTranscript(
  "﻿" + [
    step({ created_at: "2026-11-20T00:00:00", model: "lost", input_tokens: 9 }),
    step({ created_at: "2026-11-20T00:01:00", model: "kept", input_tokens: 1 }),
  ].join("\n"), SINCE, {}),
  { kept: bucket(1, 0) }, "BOM corrupts the first line only");
// Two calls sharing one byModel accumulate (the disk path relies on this).
const shared = {};
addTranscript(step({ created_at: "2026-11-20T00:00:00", model: "m", input_tokens: 1 }), SINCE, shared);
addTranscript(step({ created_at: "2026-11-20T00:01:00", model: "m", input_tokens: 2 }), SINCE, shared);
assert.deepEqual(shared, { m: bucket(3, 0) });

// ------------------------------------------------------------- Model Selection regex edges
const sel = (content, extra = {}) => step({ created_at: "2026-11-20T00:00:00", content, input_tokens: 1, ...extra });
// The literal backtick after "Model Selection" is required.
assert.deepEqual(addTranscript(sel("no backtick Model Selection to Foo."), SINCE, {}), { unknown: bucket(1, 0) },
  "selection text without the backtick is ignored");
// `from X to Y` form names Y.
assert.deepEqual(addTranscript(sel("Changed `Model Selection` from Old to New."), SINCE, {}), { new: bucket(1, 0) });
// The name ends at the first period followed by space/end/`<`.
assert.deepEqual(addTranscript(sel("x `Model Selection` to Foo.<br>rest"), SINCE, {}), { foo: bucket(1, 0) },
  "period before '<' terminates the name");
assert.deepEqual(addTranscript(sel("x `Model Selection` to Foo. Next sentence"), SINCE, {}), { foo: bucket(1, 0) },
  "period+space terminates the name — names cannot contain '. '");
assert.deepEqual(addTranscript(sel("x `Model Selection` to Foo.Bar. end"), SINCE, {}), { "foo.bar": bucket(1, 0) },
  "periods NOT followed by space/end/'<' stay inside the name");
assert.deepEqual(addTranscript(sel("x `Model Selection` to ."), SINCE, {}), { unknown: bucket(1, 0) },
  "empty selection name does not match");
// A selection step with tokens is attributed to the NEW model (name applied first).
assert.deepEqual(addTranscript(sel("x `Model Selection` to Picked.", { input_tokens: 7 }), SINCE, {}),
  { picked: bucket(7, 0) });

// ------------------------------------------------------------- agyLastDays filesystem edges
const root = path.join(tmp, "agyroot");
const conv = (name, file = "transcript.jsonl") => {
  const d = path.join(root, "brain", name, ".system_generated", "logs");
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, file);
};
const isoLocal = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}T12:00:00`; };

// brain exists but is a regular FILE -> readdirSync throws -> null.
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, "brain"), "i am a file");
assert.equal(agyLastDays(root, NOW), null, "brain as a file -> null");
fs.rmSync(path.join(root, "brain"));
// Empty brain dir -> null (no transcripts found).
fs.mkdirSync(path.join(root, "brain"));
assert.equal(agyLastDays(root, NOW), null, "empty brain -> null");
// brain entries that are files, or dirs without the transcript path -> still null.
fs.writeFileSync(path.join(root, "brain", "a-file"), "x");
fs.mkdirSync(path.join(root, "brain", "empty-conv", ".system_generated", "logs"), { recursive: true });
assert.equal(agyLastDays(root, NOW), null, "no readable transcript anywhere -> null");

// transcript.jsonl that is a DIRECTORY: statSync succeeds so `found` is set,
// readFileSync throws and is swallowed -> empty map, NOT null. The caller then
// shows "last 7 days" with zero rows instead of Omarchy's all-time numbers.
// Pinned (arguably wrong, reported).
const dirAsTranscript = conv("d1");
fs.rmSync(dirAsTranscript, { force: true }); // not created yet; ensure parent only
fs.mkdirSync(dirAsTranscript, { recursive: true });
assert.deepEqual(agyLastDays(root, NOW), {}, "unreadable transcript still counts as 'found' -> {}");
fs.rmSync(dirAsTranscript, { recursive: true });

// Fully corrupt transcript -> found, empty map.
fs.writeFileSync(conv("d2"), "not json\n{also not\n");
assert.deepEqual(agyLastDays(root, NOW), {}, "all-corrupt transcript -> {}");
// Empty transcript file -> {}.
fs.writeFileSync(conv("d3"), "");
assert.deepEqual(agyLastDays(root, NOW), {}, "empty transcript -> {}");

// Stale mtime: file last modified before `since` is skipped WITHOUT being read,
// even if its content has in-window dates (mtime is the cheap pre-filter).
const start = new Date(NOW); start.setHours(0, 0, 0, 0);
const sinceMs = start.getTime() - 6 * 86400000;
const stale = conv("stale");
fs.writeFileSync(stale, step({ created_at: isoLocal(new Date(NOW)), model: "m", input_tokens: 50 }));
fs.utimesSync(stale, new Date(sinceMs - 1000), new Date(sinceMs - 1000));
assert.deepEqual(agyLastDays(root, NOW), {}, "mtime < since skips the file even with fresh content");
// mtime exactly at `since` is NOT skipped (check is `<`).
fs.utimesSync(stale, new Date(sinceMs), new Date(sinceMs));
assert.equal(agyLastDays(root, NOW).m?.inputTokens, 50, "mtime == since still reads the file");

// Two conversations accumulate into one map; the stale-skipped file stays out.
const c1 = conv("c1"); fs.writeFileSync(c1, step({ created_at: isoLocal(new Date(NOW)), model: "one", input_tokens: 1 }));
const c2 = conv("c2"); fs.writeFileSync(c2, step({ created_at: isoLocal(new Date(NOW)), model: "two", input_tokens: 2 }));
const merged = agyLastDays(root, NOW);
assert.equal(merged.one.inputTokens, 1);
assert.equal(merged.two.inputTokens, 2);
assert.equal(merged.m.inputTokens, 50, "stale-mtime file now readable again -> included");

// `days` parameter: 1 -> only today's local midnight onward; 0 -> nothing can qualify.
const narrow = conv("narrow");
fs.writeFileSync(narrow, [
  step({ created_at: isoLocal(new Date(NOW)), model: "today", input_tokens: 5 }),
  step({ created_at: isoLocal(new Date(start.getTime() - 86400000)), model: "yesterday", input_tokens: 6 }),
].join("\n"));
const oneDay = agyLastDays(root, NOW, 1);
assert.equal(oneDay.today.inputTokens, 5);
assert.equal(oneDay.yesterday, undefined, "days=1 excludes yesterday");
assert.equal(oneDay.one.inputTokens, 1, "days=1 keeps today's steps from other conversations");
assert.equal(oneDay.m, undefined, "days=1 also tightens the mtime pre-filter");
assert.deepEqual(agyLastDays(root, NOW, 0), {}, "days=0 puts `since` in the future -> empty map");

// Reentrancy / no shared state: results are fresh objects each call; mutating a
// returned map cannot leak into the next call (the module keeps no cache).
merged.one.inputTokens = 9999;
const again = agyLastDays(root, NOW);
assert.equal(again.one.inputTokens, 1, "second call is unaffected by mutating the first result");
assert.notEqual(again.one, merged.one);
// Interleaved roots don't cross-contaminate.
const rootB = path.join(tmp, "agyroot-b", "brain", "x", ".system_generated", "logs");
fs.mkdirSync(rootB, { recursive: true });
fs.writeFileSync(path.join(rootB, "transcript.jsonl"), step({ created_at: isoLocal(new Date(NOW)), model: "other", input_tokens: 7 }));
const ra = agyLastDays(root, NOW), rb = agyLastDays(path.join(tmp, "agyroot-b"), NOW);
assert.equal(rb.other.inputTokens, 7);
assert.equal(ra.other, undefined);
assert.equal(rb.one, undefined);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("agy-days.deep: all tests passed");
