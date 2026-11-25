// Deep edge-case pass for bin/grok-wall.mjs on top of grok-wall.test.mjs and the
// grokWall section of grok-deep.test.mjs. The module is pure: it takes the log
// text, a timestamp and { free }, and returns a row or null — it never touches
// the filesystem. The scratch HOME/XDG dirs exist only to satisfy the "never
// touch the real home folder" rule.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { grokWall } from "./grok-wall.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-wall-deep-"));
const savedEnv = {};
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  savedEnv[k] = process.env[k];
  process.env[k] = path.join(tmp, k.toLowerCase());
  fs.mkdirSync(process.env[k], { recursive: true });
}

const now = Date.parse("2026-11-24T13:00:00Z");
const DAY = 24 * 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const wall = (ts, actual = 674276, limit = 600000, model = "grok-4.7") => JSON.stringify({
  ts, src: "shell", msg: "shell.turn.inference_failed",
  ctx: { kind: "rate_limited", status_code: 429,
    message: `API error (status 429 Too Many Requests): subscription:free-usage-exhausted: used all the included free usage for model ${model} for now. Usage resets over a rolling 24-hour window — tokens (actual/limit): ${actual}/${limit}.` },
});
const wallMsg = (message, msg = "shell.turn.inference_failed", extra = {}) =>
  JSON.stringify({ ts: "2026-11-24T11:00:00Z", msg, ctx: { message, ...extra } });
const done = (ts, prompt = 0, cached = 0, completion = 0) => JSON.stringify({
  ts, src: "shell", msg: "shell.turn.inference_done",
  ctx: { prompt_tokens: prompt, cached_prompt_tokens: cached, completion_tokens: completion },
});
const doneCtx = (ts, ctx) => JSON.stringify({ ts, msg: "shell.turn.inference_done", ctx });

try {
  // ---- logText is String()ed, not validated: non-string inputs never throw ----
  for (const bad of [null, undefined, 0, false, NaN, 5, {}, { toString: () => "junk" }]) {
    const r = grokWall(bad, now);
    assert.equal(r.percent, 0, `logText=${String(bad)} must behave like an empty log`);
    assert.equal(r.title, "Free grok-4.7 (24 h)");
  }
  // A single-element array stringifies to its one element, so it can BE a log;
  // a multi-element array joins with "," which is not valid JSONL.
  assert.equal(grokWall([done("2026-11-24T10:00:00Z", 300000)], now).percent, 0.5);
  assert.equal(grokWall([done("2026-11-24T10:00:00Z", 300000), done("2026-11-24T10:01:00Z", 300000)], now).percent, 0,
    "array join breaks both JSON lines");
  // An empty array stringifies to "" — same as no log at all.
  assert.equal(grokWall([], now).percent, 0);

  // ---- physical line endings and encodings ----
  // CRLF is fine: JSON.parse tolerates the trailing \r as whitespace.
  assert.equal(grokWall([done("2026-11-24T10:00:00Z", 300000), done("2026-11-24T10:30:00Z", 300000)].join("\r\n") + "\r\n", now).percent, 0.99);
  // A UTF-8 BOM on the first line makes JSON.parse fail for that line only —
  // the first event in the file is silently lost.
  assert.equal(grokWall("\uFEFF" + done("2026-11-24T10:00:00Z", 300000) + "\n" + done("2026-11-24T10:30:00Z", 300000), now).percent, 0.5,
    "BOM'd first line is skipped, the second still counts");
  // A line that parses to a non-object (string/number/array/true) reaches
  // `e.ts` safely — only null would throw, and "null" can never contain the
  // required "inference_" substring, so it is filtered out before parsing.
  for (const prim of ['"inference_done"', "5", "[1,2]", "true", "null"]) {
    assert.doesNotThrow(() => grokWall(prim + "\n" + done("2026-11-24T10:00:00Z", 60000), now));
  }
  assert.equal(grokWall('"inference_done"\n' + done("2026-11-24T10:00:00Z", 60000), now).percent, 0.1,
    "primitive JSON lines are ignored, the real one counts");

  // ---- ts field edge values ----
  // A bare date parses (UTC midnight) and counts; a numeric epoch does NOT —
  // Date.parse(number) is NaN, so the line is dropped.
  const tsVariants = [
    [JSON.stringify({ ts: "2026-11-24", msg: "shell.turn.inference_done", ctx: { prompt_tokens: 300000 } }), 0.5, "date-only ts counts"],
    [JSON.stringify({ ts: 1764000000000, msg: "shell.turn.inference_done", ctx: { prompt_tokens: 999999 } }), 0, "numeric ts ignored"],
    [JSON.stringify({ ts: "2026-11-24T15:00:00+02:00", msg: "shell.turn.inference_done", ctx: { prompt_tokens: 300000 } }), 0.5, "offset ts parses to the same instant"],
    [JSON.stringify({ ts: "", msg: "shell.turn.inference_done", ctx: { prompt_tokens: 999999 } }), 0, "empty ts ignored"],
    [JSON.stringify({ ts: null, msg: "shell.turn.inference_done", ctx: { prompt_tokens: 999999 } }), 0, "null ts ignored"],
    [JSON.stringify({ ts: true, msg: "shell.turn.inference_done", ctx: { prompt_tokens: 999999 } }), 0, "boolean ts ignored"],
  ];
  for (const [line, want, name] of tsVariants) {
    const alone = grokWall(line, now);
    assert.equal(alone.percent, want, name);
    if (want === 0) assert.equal(grokWall(line + "\n" + done("2026-11-24T10:00:00Z", 60000), now).percent, 0.1, `${name} (paired)`);
  }

  // ---- nowMs parameter edges ----
  // Omitted: falls back to Date.now(); with an empty log the row is 0% either way.
  assert.equal(grokWall("").percent, 0);
  // A numeric string coerces through every comparison and arithmetic — works.
  assert.equal(grokWall(done("2026-11-24T10:00:00Z", 300000), String(now)).percent, 0.5);
  // NaN nowMs: `nowMs < wall.ts + DAY` is false so an active wall is silently
  // dropped, `sum(NaN, NaN)` is 0, and the note degrades to "0K of 0K" when a
  // wall supplied the limit. Documented current behaviour; the only caller
  // passes Date.now().
  const nanNow = grokWall(wall("2026-11-24T11:00:00Z", 5, 10), NaN);
  assert.equal(nanNow.percent, 0);
  assert.equal(nanNow.hitAt, undefined, "NaN nowMs hides a live wall");
  assert.match(nanNow.note, /About 0K of 0K tokens/, "NaN nowMs also NaNs the displayed limit");
  // The options argument is destructured: undefined gets the default, but an
  // explicit null throws a TypeError.
  assert.equal(grokWall("", now, undefined).percent, 0);
  assert.throws(() => grokWall("", now, null), TypeError);
  // A primitive options value boxes to no `free` property -> default true.
  assert.equal(grokWall("", now, 5).percent, 0);
  assert.equal(grokWall("", now, "x").percent, 0);

  // ---- what lifts a wall, and what does not ----
  const T = "2026-11-24T11:00:00Z";
  // ANY inference_done lifts it — even one carrying zero tokens or no usable
  // ctx at all (weight 0 still pushes a call).
  for (const lift of [done("2026-11-24T11:00:01Z", 0, 0, 0), doneCtx("2026-11-24T11:00:01Z", null), doneCtx("2026-11-24T11:00:01Z", "junk"), doneCtx("2026-11-24T11:00:01Z", 5)]) {
    const r = grokWall([wall(T), lift].join("\n"), now);
    assert.equal(r.percent, 0, "a zero-weight done still lifts the wall");
    assert.equal(r.hitAt, undefined);
  }
  // A non-WALL inference_failed does NOT lift; neither does an inference_done
  // whose ts cannot be parsed (it is skipped before the lift check).
  const stillWall = grokWall([
    wall(T),
    JSON.stringify({ ts: "2026-11-24T11:30:00Z", msg: "shell.turn.inference_failed", ctx: { message: "connection reset by peer" } }),
    doneCtx("not-a-date", { prompt_tokens: 999999 }),
  ].join("\n"), now);
  assert.equal(stillWall.percent, 1, "only a parseable inference_done lifts the wall");
  // Near-miss msg strings are ignored entirely: trailing space, different case,
  // and the bare event name without the shell.turn prefix.
  for (const msg of ["shell.turn.inference_done ", "Shell.turn.inference_done", "inference_done"]) {
    const r = grokWall([wall(T), JSON.stringify({ ts: "2026-11-24T11:30:00Z", msg, ctx: { prompt_tokens: 999999 } })].join("\n"), now);
    assert.equal(r.percent, 1, `msg ${JSON.stringify(msg)} does not lift`);
  }
  // BUG: the lift check runs while scanning in FILE order, so a done line that
  // sits BEFORE the fail line in the file never lifts the wall even when its
  // timestamp is later — the row reports a wall Grok already let through.
  // Chronological append-only logs make this rare (clock steps across a
  // rotation could do it), but the honest answer needs a timestamp comparison,
  // not a positional one.
  // assert.equal(grokWall([done("2026-11-24T11:30:00Z", 1000), wall(T)].join("\n"), now).percent, 1000 / 600000);

  // ---- wall -> lift -> wall again: the SECOND hit owns the row ----
  const rehit = grokWall([
    wall("2026-11-24T09:00:00Z", 999999, 600000, "grok-old"),
    done("2026-11-24T10:00:00Z", 1000),
    wall("2026-11-24T11:30:00Z", 50000, 100000, "grok-new"),
  ].join("\n"), now);
  assert.equal(rehit.percent, 1);
  assert.equal(rehit.title, "Free grok-new (24 h)");
  assert.equal(rehit.hitAt, "2026-11-24T11:30:00.000Z");
  assert.equal(rehit.resetsAt, iso(Date.parse("2026-11-24T11:30:00Z") + DAY));
  assert.match(rehit.note, /50K of 100K tokens/);

  // ---- the correction ratio, precisely ----
  // raw = calls in (wall.ts - DAY, wall.ts]: a call exactly at wall.ts - DAY is
  // excluded, one at wall.ts is included (and does not lift: ts > wall.ts is
  // strict). ratio = actual/raw clamped to [0.5, 2].
  const ratioCase = grokWall([
    done("2026-11-23T11:00:00Z", 100000),                    // == wall.ts - DAY -> out of raw
    done("2026-11-23T11:00:00.001Z", 200000),                // inside raw
    wall("2026-11-24T11:00:00Z", 600000, 600000),            // actual/raw = 600k/500k = 1.2
    done("2026-11-24T11:00:00Z", 300000),                    // == wall.ts -> in raw, no lift
    done("2026-11-24T12:00:00Z", 100000),                    // lifts; inside the used window
  ].join("\n"), now);
  // used window (now-DAY, now] holds only the last two calls: (300k+100k)*1.2 = 480k
  assert.equal(ratioCase.percent, 480000 / 600000);
  // actual = 0 clamps the ratio to the 0.5 floor: a "0/limit" hit halves every
  // later estimate forever (lastWall is never forgotten).
  const zeroActual = grokWall([
    done("2026-11-24T08:00:00Z", 100000),
    wall("2026-11-24T09:00:00Z", 0, 600000),
    done("2026-11-24T12:00:00Z", 100000),
  ].join("\n"), now);
  assert.ok(Math.abs(zeroActual.percent - (200000 * 0.5) / 600000) < 1e-12);
  // A wall older than 24 h is forgotten as a WALL but its ratio correction is
  // not: it still scales today's estimate.
  const oldWall = grokWall([
    done("2026-11-21T08:00:00Z", 300000),
    wall("2026-11-21T09:00:00Z", 600000, 600000),           // raw=300k -> ratio 2
    done("2026-11-24T10:00:00Z", 100000),
  ].join("\n"), now);
  assert.equal(oldWall.percent, (100000 * 2) / 600000);
  assert.equal(oldWall.hitAt, undefined);

  // ---- the WALL regex's exact grammar ----
  const msg = (m) => wallMsg(m);
  // [a-z-]* matches empty, so a bare "subscription:usage-exhausted:" still hits.
  assert.equal(grokWall(msg("subscription:usage-exhausted: x for model grok-4.7 tokens (actual/limit): 5/10"), now).percent, 1);
  // Uppercase tier, a missing "for model", and WALL text under a non-matching
  // msg are all ignored. (The sneaky line still contains "inference_" via an
  // unrelated field so it reaches the parser and exercises the msg check.)
  assert.equal(grokWall(msg("subscription:FREE-usage-exhausted: x for model grok-4.7 tokens (actual/limit): 5/10"), now).percent, 0);
  assert.equal(grokWall(msg("subscription:free-usage-exhausted: x on grok-4.7 tokens (actual/limit): 5/10"), now).percent, 0);
  assert.equal(grokWall(wallMsg("subscription:free-usage-exhausted: x for model grok-4.7 tokens (actual/limit): 5/10", "shell.turn.failed", { tag: "inference_x" }), now).percent, 0);
  // Model capture is [\w.-]+ (ASCII word chars, dot, dash): a space truncates
  // the name ("grok 4.7" -> "grok"), a full-width char stops it mid-token
  // ("grok-４.７" -> "grok-"), dots and dashes are kept.
  assert.equal(grokWall(msg("subscription:free-usage-exhausted: x for model grok 4.7 tokens (actual/limit): 5/10"), now).title, "Free grok (24 h)");
  assert.equal(grokWall(msg("subscription:free-usage-exhausted: x for model grok-4.7.beta-2 tokens (actual/limit): 5/10"), now).title, "Free grok-4.7.beta-2 (24 h)");
  // With two tokens clauses the regex anchors on the one AFTER "for model".
  const two = grokWall(msg("subscription:free-usage-exhausted: tokens (actual/limit): 1/2 for model grok-4.7 then tokens (actual/limit): 50000/100000"), now);
  assert.equal(two.percent, 1);
  assert.match(two.note, /50K of 100K tokens/);
  // ctx.message is String()ed: an array containing the message joins to the
  // message itself and still matches; a plain object becomes "[object Object]"
  // (JSON can't carry the toString function anyway), scalars do not match.
  assert.equal(grokWall(JSON.stringify({ ts: "2026-11-24T11:00:00Z", msg: "shell.turn.inference_failed",
    ctx: { message: ["subscription:free-usage-exhausted: x for model grok-4.7 tokens (actual/limit): 5/10"] } }), now).percent, 1);
  for (const m of [{}, 123, null, true]) {
    assert.equal(grokWall(JSON.stringify({ ts: "2026-11-24T11:00:00Z", msg: "shell.turn.inference_failed", ctx: { message: m } }), now).percent, 0);
  }
  // A hit whose limit rounds to "0K" still reports the wall — the note just
  // looks odd ("0K of 0K"). Real limits are never this small.
  const tiny = grokWall(msg("subscription:free-usage-exhausted: x for model grok-4.7 tokens (actual/limit): 5/10"), now);
  assert.equal(tiny.percent, 1);
  assert.match(tiny.note, /0K of 0K tokens/);

  // ---- estimate row details ----
  // All calls older than 24 h: an honest 0%, not a missing row.
  const stale = grokWall(JSON.stringify({ ts: "2026-11-20T10:00:00Z", msg: "shell.turn.inference_done", ctx: { prompt_tokens: 999999 } }), now);
  assert.equal(stale.percent, 0);
  assert.match(stale.note, /About 0K of 600K tokens in the last 24 h, estimated from Grok's log\. Grok doesn't report how much is left\./);
  // k() formatting: just under 1M shows as "1000K" (the M branch needs >= 1e6),
  // and >= 1M shows one decimal.
  assert.match(grokWall(done("2026-11-24T10:00:00Z", 999999), now).note, /About 1000K of 600K/);
  assert.match(grokWall(done("2026-11-24T10:00:00Z", 2500000), now).note, /About 2\.5M of 600K/);
  // Hit note is the full honest sentence; estimate note never carries hitAt.
  const hitRow = grokWall(wall(T, 674276, 1500000), now);
  assert.equal(hitRow.note, "Grok hit this limit: 674K of 1.5M tokens. Grok doesn't report how much is left. Rolling window, so it may free up sooner.");
  assert.deepEqual(Object.keys(hitRow).sort(), ["cap", "hitAt", "note", "percent", "resetsAt", "title"]);
  const estRow = grokWall(done("2026-11-24T10:00:00Z", 300000), now);
  assert.equal("hitAt" in estRow, false);
  assert.deepEqual(Object.keys(estRow).sort(), ["cap", "note", "percent", "resetsAt", "title"]);

  // ---- weight() field types beyond the covered null/string cases ----
  // Booleans and arrays coerce through Number(): true -> 1, [5] -> 5, {} -> NaN -> 0.
  const typed = grokWall([
    doneCtx("2026-11-24T10:00:00Z", { prompt_tokens: true, cached_prompt_tokens: [100], completion_tokens: "50" }),  // max(0, 1 - 75) + 50 = 50
    doneCtx("2026-11-24T10:01:00Z", { prompt_tokens: {}, completion_tokens: [] }),                                     // 0
    doneCtx("2026-11-24T10:02:00Z", { prompt_tokens: "1e5", completion_tokens: "2.5" }),                              // 100000 + 2.5
  ].join("\n"), now);
  assert.equal(typed.percent, (50 + 0 + 100002.5) / 600000);

  // ---- { free } truthiness ----
  // Only strict falsy counts as paid: 0 and null suppress the estimate when no
  // wall was ever seen; any truthy value (even "no") keeps it.
  assert.equal(grokWall("", now, { free: 0 }), null);
  assert.equal(grokWall("", now, { free: null }), null);
  assert.equal(grokWall("", now, { free: "no" }).percent, 0);
  assert.equal(grokWall("", now, { free: undefined }).percent, 0, "explicit undefined -> default true");
  // ...but a wall overrides `free` in both directions: an active hit reports on
  // a paid plan, and an old hit keeps the estimate alive on one.
  assert.equal(grokWall(wall("2026-11-24T11:30:00Z"), now, { free: false }).percent, 1);

  // ---- purity: no module state, calls cannot interfere ----
  const hitText = wall("2026-11-24T11:00:00Z");
  const estText = done("2026-11-24T10:00:00Z", 300000);
  const a1 = grokWall(hitText, now);
  const b1 = grokWall(estText, now);
  const a2 = grokWall(hitText, now);
  const b2 = grokWall(estText, now);
  assert.deepEqual(a2, a1);
  assert.deepEqual(b2, b1);
  assert.notEqual(a1.percent, b1.percent, "interleaved calls stay independent");

  console.log("grok-wall deep: all tests passed");
} finally {
  for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
