// Deeper edge-case pass on Constance's model router (bin/constance-route.mjs):
// fractional and non-numeric milk values, truthy/falsy failedBefore, unknown
// and non-string steps, case-sensitive claudeArgs, and the routes.jsonl file
// edges the shallow test misses — BOM/CRLF/binary input, a directory or
// unwritable path as the file, `at`/`job` oddities, dropped extra fields,
// append-order (not time-order) reads, and a 300-line append stress.
// Complements constance-route.test.mjs. Everything lives in mktemp dirs with
// HOME and the XDG dirs pointed there; nothing touches a real home.
//
// Suspected bugs found (kept as commented-out tests, reported to the owner):
//   1. logRoute(file, null) throws TypeError while routeModel(null opts) is fine.
//   2. logRoute(file, "str") or an array writes a bare "{}" line: String/Array
//      .prototype.at shadows the `at = Date.now()` default, so the timestamp is
//      never written and the record loses its only guaranteed field.
//   3. readRoutes drops the first record of a UTF-8-BOM file (JSON.parse
//      rejects the BOM, the line is skipped as "broken").
//   4. splitByModel uses `m in out`, so a row with model "constructor",
//      "hasOwnProperty", "toString" etc. writes a string onto the counts object
//      instead of ignoring the unknown model.
//   5. splitByModel(5) (any non-iterable) throws "(rows || []) is not iterable"
//      instead of reading as an empty tally like splitByModel(null) does.
//   6. routeModel's `why` shows Math.round(milk): milk 66.5 routes Sonnet but
//      says "milk 67 picks Sonnet", and 67 actually picks Opus — the displayed
//      number contradicts the pick.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Fake home for the whole file: HOME and all three XDG dirs point into one
// mktemp tree. The module takes explicit file paths and never reads env, but
// the job rules require it anyway.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "constance-route-deep-"));
process.env.HOME = fakeHome;
process.env.XDG_STATE_HOME = path.join(fakeHome, "xdg-state");
process.env.XDG_CONFIG_HOME = path.join(fakeHome, "xdg-config");
process.env.XDG_CACHE_HOME = path.join(fakeHome, "xdg-cache");

const { routeModel, claudeArgs, logRoute, readRoutes, splitByModel } =
  await import("./constance-route.mjs");

const dirs = [fakeHome];
const tmpdir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "constance-route-deep-"));
  dirs.push(d);
  return d;
};

try {
  // ============================================================ routeModel
  // Fractional milk just under each threshold still reads as the lower tier.
  assert.equal(routeModel("spec", { milk: 33.9 }).model, "haiku");
  assert.equal(routeModel("spec", { milk: 66.9 }).model, "sonnet");
  assert.equal(routeModel("review", { milk: 33.999 }).model, "haiku");
  assert.equal(routeModel("fix", { milk: 66.999 }).model, "sonnet");
  // And just over the clamps: negative and >100 still clamp, not default.
  assert.equal(routeModel("spec", { milk: -0.4 }).model, "haiku");
  assert.equal(routeModel("spec", { milk: 100.4 }).model, "opus");
  assert.equal(routeModel("spec", { milk: 1e308 }).model, "opus");

  // Numeric-looking strings and booleans are NOT numbers: they fall back to
  // DEFAULT_MILK (25 -> Haiku), even "67" which as a number would pick Opus.
  for (const milk of ["67", "34", "", " 50 ", true, false, Infinity, -Infinity, new Number(80)]) {
    assert.equal(routeModel("spec", { milk }).model, "haiku", `milk=${String(milk)}`);
  }

  // opts itself can be any junk: primitives destructure to all-defaults.
  for (const opts of [5, "x", true, [], [80]]) {
    assert.equal(routeModel("spec", opts).model, "haiku", `opts=${JSON.stringify(opts)}`);
  }

  // failedBefore: any truthy value bumps; falsy values (0, "", null) don't.
  assert.equal(routeModel("spec", { milk: 0, failedBefore: 1 }).model, "sonnet");
  assert.equal(routeModel("spec", { milk: 0, failedBefore: "yes" }).model, "sonnet");
  assert.equal(routeModel("spec", { milk: 0, failedBefore: {} }).model, "sonnet");
  assert.equal(routeModel("spec", { milk: 0, failedBefore: 0 }).model, "haiku");
  assert.equal(routeModel("spec", { milk: 0, failedBefore: "" }).model, "haiku");
  // One bump only: summary can reach Sonnet but never Opus via failedBefore.
  assert.equal(routeModel("summary", { failedBefore: true }).model, "sonnet");
  assert.equal(routeModel("spec", { milk: 40, failedBefore: true }).model, "opus");
  assert.equal(routeModel("fix", { milk: 50, failedBefore: true }).model, "opus");

  // Steps are case- and whitespace-sensitive: near-misses are unknown -> Opus.
  for (const step of ["Plan", "SPEC", " spec", "fix ", "Summary", "review-failed "]) {
    assert.equal(routeModel(step).model, "opus", `step=${JSON.stringify(step)}`);
  }
  // Non-string steps interpolate into the why but still route Opus, no throw.
  for (const step of [42, null, {}, [], true]) {
    const r = routeModel(step);
    assert.equal(r.model, "opus", `step=${JSON.stringify(step)}`);
    assert.match(r.why, /unknown step/);
  }

  // failedBefore on an already-Opus pick appends the top-tier note, whatever
  // the reason it was Opus (fixed step or unknown step).
  assert.match(routeModel("plan", { failedBefore: true }).why, /always runs on Opus; already at the top tier/);
  assert.match(routeModel("bogus", { failedBefore: true }).why, /unknown step "bogus": Opus; already at the top tier/);

  // Each call returns a fresh object; mutating one result can't leak.
  const r1 = routeModel("spec", { milk: 80 });
  r1.model = "haiku";
  assert.equal(routeModel("spec", { milk: 80 }).model, "opus");

  // BUG: routeModel's `why` rounds milk for display (Math.round), so a value
  // just under a threshold shows a number that would route higher: milk 66.5
  // picks Sonnet but says "milk 67 picks Sonnet", and 67 picks Opus. The
  // rounded figure contradicts the pick — either floor it or show the raw
  // value. Commented out until the owner decides the wording.
  // {
  //   const r = routeModel("spec", { milk: 66.5 });
  //   assert.equal(r.model, "sonnet");
  //   assert.doesNotMatch(r.why, /milk 67/, "why must not display a milk value that routes differently");
  //   const r2 = routeModel("spec", { milk: 33.5 });
  //   assert.equal(r2.model, "haiku");
  //   assert.doesNotMatch(r2.why, /milk 34/);
  // }

  // ============================================================ claudeArgs
  // Model names are case-sensitive: near-misses fall back to Opus (an upgrade,
  // never a silent downgrade).
  for (const model of ["Sonnet", "HAIKU", " haiku", "haiku ", "Opus", "opus "]) {
    assert.deepEqual(claudeArgs(model), ["--model", "opus"], `model=${JSON.stringify(model)}`);
  }
  for (const model of [null, 5, {}, [], true]) {
    assert.deepEqual(claudeArgs(model), ["--model", "opus"], `model=${JSON.stringify(model)}`);
  }
  // Fresh array every call: mutating a result can't corrupt later calls.
  const args = claudeArgs("sonnet");
  args.push("--dangerously-skip-permissions");
  assert.deepEqual(claudeArgs("sonnet"), ["--model", "sonnet"]);

  // ============================================================ routes file
  const dir = tmpdir();

  // readRoutes on non-file inputs reads as empty, never throws.
  assert.deepEqual(readRoutes(dir), [], "a directory path -> []");
  const emptyFile = path.join(dir, "empty.jsonl");
  fs.writeFileSync(emptyFile, "");
  assert.deepEqual(readRoutes(emptyFile), [], "empty file -> []");
  const blankFile = path.join(dir, "blank.jsonl");
  fs.writeFileSync(blankFile, "\n   \n\t\n\n");
  assert.deepEqual(readRoutes(blankFile), [], "whitespace-only file -> []");
  const noPerm = path.join(dir, "noperm.jsonl");
  fs.writeFileSync(noPerm, JSON.stringify({ model: "opus" }) + "\n");
  fs.chmodSync(noPerm, 0o000);
  assert.deepEqual(readRoutes(noPerm), [], "unreadable file -> []");
  fs.chmodSync(noPerm, 0o600);

  // Line-level junk the shallow test didn't cover: null/true/string scalars,
  // a JSON array (typeof object -> kept as a row!), deep nesting, duplicates.
  const mixed = path.join(dir, "mixed.jsonl");
  fs.writeFileSync(mixed, [
    "null",
    "true",
    '"just a string"',
    "[{\"model\":\"opus\"}]",
    "{\"a\":{\"b\":[1,2,{\"c\":null}]}}",
    JSON.stringify({ model: "haiku" }),
    JSON.stringify({ model: "haiku" }),   // duplicate kept verbatim
    "  {\"model\":\"sonnet\"}  ",          // surrounding whitespace ok
    "{trailing junk",
    "",
  ].join("\n") + "\n");
  const mixedRows = readRoutes(mixed);
  assert.equal(mixedRows.length, 5, "null/true/string/broken lines skipped, array+object rows kept");
  assert.ok(Array.isArray(mixedRows[0]), "a JSON array line comes back as an array row");
  assert.deepEqual(mixedRows[1], { a: { b: [1, 2, { c: null }] } }, "deep objects pass through untouched");
  assert.deepEqual(mixedRows[2], { model: "haiku" });
  assert.deepEqual(mixedRows[3], { model: "haiku" }, "duplicate lines are not deduped");
  assert.deepEqual(mixedRows[4], { model: "sonnet" }, "leading/trailing spaces around a line are fine");

  // File order is append order, NOT `at` order: readRoutes never sorts.
  const unsorted = path.join(dir, "unsorted.jsonl");
  logRoute(unsorted, { step: "a", model: "opus", at: 300 });
  logRoute(unsorted, { step: "b", model: "haiku", at: 100 });
  logRoute(unsorted, { step: "c", model: "sonnet", at: 200 });
  assert.deepEqual(readRoutes(unsorted).map((r) => r.at), [300, 100, 200],
    "rows come back in file order even when `at` goes backwards");

  // CRLF line endings parse fine (\r is JSON whitespace).
  const crlf = path.join(dir, "crlf.jsonl");
  fs.writeFileSync(crlf, JSON.stringify({ model: "opus" }) + "\r\n" + JSON.stringify({ model: "haiku" }) + "\r\n");
  assert.equal(readRoutes(crlf).length, 2, "CRLF file parses both records");

  // A final line without a trailing newline is still read.
  const noNewline = path.join(dir, "nonewline.jsonl");
  fs.writeFileSync(noNewline, JSON.stringify({ model: "opus" }) + "\n" + JSON.stringify({ model: "haiku" }));
  assert.equal(readRoutes(noNewline).length, 2, "missing trailing newline still yields the last record");

  // Non-UTF8 bytes can't form JSON -> every line skips -> [].
  const binary = path.join(dir, "binary.jsonl");
  fs.writeFileSync(binary, Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0x22, 0x7d, 0x0a, 0xff]));
  assert.deepEqual(readRoutes(binary), [], "binary garbage -> []");

  // BUG: a UTF-8 BOM makes JSON.parse reject the first line, so readRoutes
  // silently drops the first route record of a BOM'd file. Strip a leading
  // \uFEFF before splitting, or parse per-line with BOM tolerance.
  // {
  //   const bom = path.join(dir, "bom.jsonl");
  //   fs.writeFileSync(bom, "\uFEFF" + JSON.stringify({ model: "opus" }) + "\n" + JSON.stringify({ model: "haiku" }) + "\n");
  //   assert.equal(readRoutes(bom).length, 2, "BOM'd file keeps both records");
  // }

  // `at` and `job` are stored verbatim — no coercion, no validation.
  const odd = path.join(dir, "odd.jsonl");
  logRoute(odd, { step: "s", model: "opus", at: NaN });        // NaN -> JSON null
  logRoute(odd, { step: "s", model: "opus", at: "123" });      // string kept as string
  logRoute(odd, { step: "s", model: "opus", at: null });       // explicit null kept
  logRoute(odd, { step: "s", model: "opus", at: -5 });         // negative kept
  logRoute(odd, { step: "s", model: "opus", job: 0 });         // falsy job kept
  logRoute(odd, { step: "s", model: "opus", job: {}, extra: "dropped" });
  const oddRows = readRoutes(odd);
  assert.equal(oddRows[0].at, null, "NaN serializes to null");
  assert.equal(oddRows[1].at, "123", "string `at` is not coerced");
  assert.equal(oddRows[2].at, null);
  assert.equal(oddRows[3].at, -5);
  assert.equal(oddRows[4].job, 0, "job: 0 is kept, not dropped as falsy");
  assert.deepEqual(oddRows[5].job, {}, "object job round-trips");
  assert.ok(!("extra" in oddRows[5]), "fields outside {step,model,job,at} are dropped");

  // logRoute with no record (or an empty/non-object one) still writes a line:
  // only `at` survives, since undefined keys are dropped by JSON.stringify.
  const bare = path.join(dir, "bare.jsonl");
  logRoute(bare);
  logRoute(bare, {});
  logRoute(bare, 42);
  logRoute(bare, true);
  const bareRows = readRoutes(bare);
  assert.equal(bareRows.length, 4);
  for (const row of bareRows) {
    assert.deepEqual(Object.keys(row), ["at"], "only `at` is written for a record-less call");
    assert.ok(Number.isFinite(row.at), "at defaults to a timestamp");
  }

  // BUG: logRoute(file, null) crashes — the destructuring default `= {}` only
  // covers undefined, and routeModel's `opts || {}` shows the module's own
  // convention is to tolerate null. Callers passing a maybe-null record get a
  // TypeError instead of a skipped/empty write.
  // {
  //   const f = path.join(dir, "nullrec.jsonl");
  //   assert.doesNotThrow(() => logRoute(f, null));
  // }

  // BUG: logRoute(file, "str") or an array writes a bare "{}" — String.prototype
  // .at and Array.prototype.at exist (ES2022), so the destructured `at` resolves
  // to a function instead of undefined, the Date.now() default never fires, and
  // JSON.stringify drops the function. The line loses its only guaranteed field.
  // 42/true have no .at, so they DO get the timestamp — the behavior is a trap
  // for anyone passing a string id or row array as the record.
  // {
  //   const f = path.join(dir, "stringrec.jsonl");
  //   logRoute(f, "plan");
  //   const rows = readRoutes(f);
  //   assert.equal(rows.length, 1);
  //   assert.ok(Number.isFinite(rows[0].at), "a string record should still get a timestamp");
  // }

  // Filesystem error paths: a blocked mkdir and a directory-as-file both throw
  // (the module doesn't catch — callers own the path). Assert the throw, don't
  // paper over it.
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "x");
  assert.throws(() => logRoute(path.join(blocker, "sub", "r.jsonl"), { step: "s" }),
    /ENOTDIR|EEXIST/, "mkdir under a regular file throws");
  assert.throws(() => logRoute(dir, { step: "s" }), /EISDIR/, "appending to a directory throws");

  // Append stress: 300 synchronous appends all land as parseable lines — the
  // tally stays honest under a busy goal. (No async surface exists to race.)
  const stress = path.join(dir, "deep", "nested", "stress.jsonl");
  for (let i = 0; i < 300; i++) {
    logRoute(stress, { step: "spec", model: "haiku", job: i, at: i });
  }
  const stressRows = readRoutes(stress);
  assert.equal(stressRows.length, 300);
  assert.equal(stressRows[0].job, 0);
  assert.equal(stressRows[299].job, 299);
  assert.equal(stressRows[299].at, 299);

  // ============================================================ splitByModel
  // Rows without a usable `model` are ignored; the count shape is fixed.
  // Quirk: {model: ["haiku"]} DOES count — `m in out` stringifies the array
  // key to "haiku". Same `in`-operator looseness as the BUG block below.
  assert.deepEqual(splitByModel([
    { model: "opus" }, { model: 5 }, { model: null }, { model: ["haiku"] },
    { model: "Opus" }, { model: " opus" }, { model: "" }, {}, "sonnet", "bogus",
  ]), { opus: 1, sonnet: 1, haiku: 1 }, "exact lowercase names count; an array model stringifies into one");

  // A bare string arg iterates its CHARACTERS, not the string: "opus" splits
  // into o/p/u/s and counts nothing. Arrays-as-rows and bare strings are only
  // supported as ELEMENTS, so this reads as zeros — documented, not fixed.
  assert.deepEqual(splitByModel("opus"), { opus: 0, sonnet: 0, haiku: 0 },
    "a bare string arg is iterated char-by-char -> all zeros");
  assert.deepEqual(splitByModel(["opus", "opus"]), { opus: 2, sonnet: 0, haiku: 0 });

  // The counts object is fresh each call; mutating it can't leak.
  const counts = splitByModel([{ model: "haiku" }]);
  counts.haiku = 99;
  assert.deepEqual(splitByModel([{ model: "haiku" }]), { opus: 0, sonnet: 0, haiku: 1 });

  // BUG: splitByModel uses `m in out`, which sees Object.prototype. A row with
  // model "constructor"/"hasOwnProperty"/"toString" writes a STRING onto the
  // counts object (function + 1) instead of being ignored as an unknown model —
  // the returned tally is corrupted. Use Object.hasOwn(out, m) or a
  // null-prototype map.
  // {
  //   const out = splitByModel([{ model: "constructor" }, { model: "opus" }]);
  //   assert.equal(typeof out.constructor, "function", "inherited props must not be counted");
  //   assert.deepEqual({ opus: out.opus, sonnet: out.sonnet, haiku: out.haiku },
  //     { opus: 1, sonnet: 0, haiku: 0 });
  // }

  // BUG: splitByModel(5) — or any non-iterable — throws "(rows || []) is not
  // iterable" while splitByModel(null) correctly reads as an empty tally. The
  // tally is advisory; junk input should read as nothing, not crash.
  // {
  //   assert.doesNotThrow(() => splitByModel(5));
  //   assert.deepEqual(splitByModel(5), { opus: 0, sonnet: 0, haiku: 0 });
  // }
} finally {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
console.log("constance-route.deep: tests passed");
