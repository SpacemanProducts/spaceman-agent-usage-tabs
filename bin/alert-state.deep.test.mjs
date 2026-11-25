// Deep edge-case pass for bin/alert-state.mjs on top of alert-state.test.mjs.
// The module is pure (agents/before/threshold/now all passed in; the state file
// is just JSON), so nothing here touches the real HOME or any state dir — the
// scratch dir only exists to satisfy the "never touch the real home folder"
// rule, and env vars are pointed at it for the duration of the run.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planAlerts, markFired, alertText, planHandoffTriggers, markHandoffFired, HANDOFF_AT, TOLERANCE_MS, WATCHED } from "./alert-state.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alert-state-deep-"));
const savedEnv = {};
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  savedEnv[k] = process.env[k];
  process.env[k] = path.join(tmp, k.toLowerCase());
  fs.mkdirSync(process.env[k], { recursive: true });
}

const T = 0.95;
const MIN = 60000, HOUR = 3600000;
const STALE_AFTER_MS = 30 * MIN; // mirrors the module's private constant
const T0 = Date.parse("2026-11-22T10:00:00Z");
const R1 = Date.parse("2026-11-22T15:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const A = (id, title, percent, resetsAt) => ({ id, name: id, limits: [{ title, percent, resetsAt }] });
const warnKey = (id, title) => `${id}|${title}`;

try {
  // ---- `before` (the parsed notified.json / handoff-fired.json) with wrong shapes ----
  // collect.mjs does `readJson(...) || {}`, so anything that is valid JSON but not
  // an object of window records reaches planAlerts as-is.
  for (const bad of [null, undefined, [], "junk", 5, true, [1, 2], { nested: { deep: 1 } }, { "c|Session": undefined }]) {
    const { toSend } = planAlerts([A("c", "Session", 0.99, iso(R1))], bad, T, T0);
    assert.equal(toSend.length, 1, `before=${JSON.stringify(bad)} must behave like empty memory`);
    assert.equal(toSend[0].level, "warn");
  }
  // A non-iterable `agents` argument throws inside watchedAgents.
  // BUG: planAlerts/planHandoffTriggers throw on non-iterable `agents` (5, {}, true)
  // and on null/undefined entries inside `agents`, `limits` or `accounts`
  // ("Cannot read properties of null (reading 'accounts')" etc.), and on a
  // non-iterable `limits` (limits: 5 or {}). notifyHighUsage() calls planAlerts at
  // top level in collect.mjs with no try/catch, so one malformed collector record
  // kills the whole run before data.json is written.
  // assert.doesNotThrow(() => planAlerts(5, {}, T, T0));
  // assert.doesNotThrow(() => planAlerts([null], {}, T, T0));
  // assert.doesNotThrow(() => planAlerts([{ id: "c", name: "c", limits: [null] }], {}, T, T0));
  // assert.doesNotThrow(() => planAlerts([{ id: "c", name: "c", limits: 5 }], {}, T, T0));
  // assert.doesNotThrow(() => planAlerts([{ id: "c", name: "c", limits: [], accounts: [null, {}] }], {}, T, T0));
  // A one-element `accounts` array is NOT expanded (only >1 is), so a meter that
  // lives only inside accounts[0].limits is never watched.
  // BUG: an agent with exactly one account and empty top-level `limits` loses its
  // alerts entirely — the single account's Session/Weekly meters are invisible.
  // assert.equal(planAlerts([{ id: "c", name: "c", limits: [], accounts: [{ id: "w", label: "W", limits: [{ title: "Session", percent: 0.99, resetsAt: iso(R1) }] }] }], {}, T, T0).toSend.length, 1);

  // ---- corrupt entries inside `before` ----
  // Junk NON-object values under a 2-part key are dropped by migrate() (needs
  // >=3 "|" parts), so the window counts as never-firing and no record survives.
  for (const v of [null, 5, "x"]) {
    const { toSend, memory } = planAlerts([A("c", "Session", 0.99, iso(R1))], { [warnKey("c", "Session")]: v }, T, T0);
    assert.equal(toSend.length, 1, `corrupt record ${JSON.stringify(v)} must not suppress the alert`);
    assert.equal(memory[warnKey("c", "Session")], undefined, "non-object records are dropped, not kept");
  }
  // Object records (arrays included: typeof [] === "object") are kept verbatim,
  // and still let the alert through.
  for (const v of [{}, [], { resetMs: "garbage" }, { levels: {} }]) {
    const { toSend, memory } = planAlerts([A("c", "Session", 0.99, iso(R1))], { [warnKey("c", "Session")]: v }, T, T0);
    assert.equal(toSend.length, 1, `object record ${JSON.stringify(v)} has nothing fired`);
    assert.equal(typeof memory[warnKey("c", "Session")], "object");
  }
  // A well-formed record with levels already fired suppresses, whatever the value types.
  for (const levels of [{ warn: T0 }, { warn: "yes" }, { warn: -1 }, { warn: {} }]) {
    const { toSend } = planAlerts([A("c", "Session", 0.99, iso(R1))], { [warnKey("c", "Session")]: { resetMs: R1, levels } }, T, T0);
    assert.equal(toSend.length, 0, `levels=${JSON.stringify(levels)} already counts as fired`);
  }
  // ...but a falsy level timestamp (NaN can't survive JSON, but the module takes
  // any object) does NOT count as fired.
  assert.equal(planAlerts([A("c", "Session", 0.99, iso(R1))], { [warnKey("c", "Session")]: { resetMs: R1, levels: { warn: NaN } } }, T, T0).toSend.length, 1);
  // levels: null / missing is tolerated by planAlerts (treated as nothing fired)...
  assert.equal(planAlerts([A("c", "Session", 0.99, iso(R1))], { [warnKey("c", "Session")]: { resetMs: R1, levels: null } }, T, T0).toSend.length, 1);
  // ...but markFired then writes into it and throws.
  // BUG: markFired crashes on a stored record whose `levels` is null or a
  // primitive ({resetMs, levels: null} / levels: "x" / levels: 5 -> TypeError).
  // planAlerts accepts such a record from a hand-edited notified.json, the warn
  // alert is sent, then markFired throws inside the unguarded notifyHighUsage
  // loop: the run dies, memory is never saved, and the same notification repeats
  // on every collect until the file is fixed by hand.
  // const badMem = { [warnKey("c", "Session")]: { resetMs: R1, levels: null } };
  // const planned = planAlerts([A("c", "Session", 0.99, iso(R1))], badMem, T, T0);
  // assert.doesNotThrow(() => markFired(planned.memory, planned.toSend[0], T0));
  // A record whose resetMs is not a number can never be detected as a new window
  // (resetMs - rec.resetMs is NaN) and never stale-pruned (now - rec.resetMs is NaN),
  // so once `warn` fired it stays suppressed until usage drops 30 points — even if
  // the agent's real reset time moves on. `limit` still fires.
  // BUG: a non-numeric stored resetMs ("garbage", or null from an old-format key
  // whose resetsAt didn't parse) permanently mutes that meter's warn alert.
  // const stuck = {};
  // let s = planAlerts([A("c", "Session", 0.99, iso(R1))], stuck, T, T0);
  // s.memory[warnKey("c", "Session")].resetMs = "garbage";
  // assert.equal(planAlerts([A("c", "Session", 0.99, iso(R1 + 5 * HOUR))], s.memory, T, T0 + HOUR).toSend.length, 1, "a moved-on reset should re-arm the window");

  // ---- old-format memory migration ("agent|title|resetsAt" -> timestamp) ----
  {
    const oldKey = `c|Session|${iso(R1)}`;
    const { toSend, memory } = planAlerts([A("c", "Session", 0.99, iso(R1))], { [oldKey]: 123 }, T, T0);
    assert.equal(toSend.length, 0, "old-format timestamp counts as already warned");
    const rec = memory[warnKey("c", "Session")];
    assert.equal(rec.resetMs, R1, "the resetsAt part becomes resetMs");
    assert.equal(rec.levels.warn, 123, "the timestamp becomes the warn level time");
  }
  // Falsy/NaN timestamps still count as fired (Number(v) || 1).
  for (const [v, want] of [[0, 1], ["abc", 1], [-5, -5], [null, undefined]]) {
    if (v === null) continue; // null is falsy -> migrate treats the key as old-format anyway; covered below
    const { memory } = planAlerts([], { [`c|Session|${iso(R1)}`]: v }, T, T0);
    assert.equal(memory[warnKey("c", "Session")].levels.warn, want, `old value ${JSON.stringify(v)}`);
  }
  // Old-format key with an unparseable resetsAt: rec.resetMs is null, so the
  // window-end checks can never fire — warn stays muted until a 30-point drop.
  {
    const { memory } = planAlerts([], { "c|Session|not-a-date": 1 }, T, T0);
    assert.equal(memory[warnKey("c", "Session")].resetMs, null);
    const again = planAlerts([A("c", "Session", 0.99, iso(R1 + 5 * HOUR))], memory, T, T0 + HOUR);
    assert.equal(again.toSend.length, 0, "no resetMs means the moved-on reset is invisible");
  }
  // Old-format key with extra "|" segments: everything after part 2 is rejoined
  // and re-parsed, so a resetsAt containing "|" (or trailing junk) yields null.
  {
    const { memory } = planAlerts([], { [`c|Session|${iso(R1)}|extra`]: 1 }, T, T0);
    assert.equal(memory[warnKey("c", "Session")].resetMs, null);
  }
  // Keys with fewer than 3 parts are dropped entirely.
  assert.deepEqual(planAlerts([], { "c|Session": 1, "solo": 2 }, T, T0).memory, {});

  // ---- window-end boundary: TOLERANCE_MS is strict ----
  {
    let mem = {};
    let r = planAlerts([A("c", "Session", 0.99, iso(R1))], mem, T, T0);
    markFired(r.memory, r.toSend[0], T0);
    mem = r.memory;
    // Exactly TOLERANCE_MS later: still the same window.
    let same = planAlerts([A("c", "Session", 0.99, iso(R1 + TOLERANCE_MS))], mem, T, T0 + MIN);
    assert.equal(same.toSend.length, 0, "exactly at the tolerance is the same window");
    // 1 ms past it: a new window, warns again even though usage never dipped.
    let next = planAlerts([A("c", "Session", 0.99, iso(R1 + TOLERANCE_MS + 1))], same.memory, T, T0 + 2 * MIN);
    assert.equal(next.toSend.length, 1);
    assert.equal(next.toSend[0].level, "warn");
  }
  // A reset time moving BACKWARD never opens a new window (the check is one-sided).
  {
    let r = planAlerts([A("c", "Session", 0.99, iso(R1))], {}, T, T0);
    markFired(r.memory, r.toSend[0], T0);
    const back = planAlerts([A("c", "Session", 0.99, iso(R1 - 2 * HOUR))], r.memory, T, T0 + MIN);
    assert.equal(back.toSend.length, 0, "earlier resetsAt is treated as the same window");
  }
  // The rearm drop is inclusive and sits at threshold - 0.3 (floating point: 0.6499999999999999).
  {
    const REARM = T - 0.3;
    let r = planAlerts([A("c", "Session", 0.97, iso(R1))], {}, T, T0);
    markFired(r.memory, r.toSend[0], T0);
    let mem = r.memory;
    // Exactly at the boundary: the record is cleared, so the next crossing warns again.
    let dip = planAlerts([A("c", "Session", REARM, iso(R1))], mem, T, T0 + MIN);
    assert.equal(dip.toSend.length, 0);
    assert.equal(dip.memory[warnKey("c", "Session")], undefined, "exactly at the rearm level clears the window");
    let again = planAlerts([A("c", "Session", 0.97, iso(R1))], dip.memory, T, T0 + 2 * MIN);
    assert.equal(again.toSend.length, 1, "crossing again after a boundary dip warns once more");
    // A hair above the boundary keeps the window muted.
    r = planAlerts([A("c", "Session", 0.97, iso(R1))], {}, T, T0);
    markFired(r.memory, r.toSend[0], T0);
    let hold = planAlerts([A("c", "Session", REARM + 1e-9, iso(R1))], r.memory, T, T0 + MIN);
    assert.ok(hold.memory[warnKey("c", "Session")], "just above the rearm level keeps the record");
    assert.equal(planAlerts([A("c", "Session", 0.97, iso(R1))], hold.memory, T, T0 + 2 * MIN).toSend.length, 0);
  }
  // The stale sweep is strict: a window whose resetMs is exactly 30 min old is
  // kept; 1 ms older is dropped — and dropping it re-arms the alert even if the
  // agent still reports the same (long past) reset time.
  {
    const rec = (resetMs) => ({ [warnKey("c", "Session")]: { resetMs, levels: { warn: 1 } } });
    assert.equal(Object.keys(planAlerts([], rec(T0 - STALE_AFTER_MS), T, T0).memory).length, 1, "exactly 30 min old is kept");
    assert.equal(Object.keys(planAlerts([], rec(T0 - STALE_AFTER_MS - 1), T, T0).memory).length, 0, "30 min + 1 ms is pruned");
    // The sweep runs after the alert check, so the pass that prunes is still
    // muted; the NEXT pass on the pruned memory alerts again — even though the
    // agent still reports the same long-past reset time (clock-vs-reset skew).
    const pastIso = iso(T0 - STALE_AFTER_MS - 1);
    const sweep = planAlerts([A("c", "Session", 0.99, pastIso)], rec(T0 - STALE_AFTER_MS - 1), T, T0);
    assert.equal(sweep.toSend.length, 0, "the pruning pass itself is still muted");
    assert.equal(sweep.memory[warnKey("c", "Session")], undefined);
    assert.equal(planAlerts([A("c", "Session", 0.99, pastIso)], sweep.memory, T, T0 + MIN).toSend.length, 1,
      "the next pass re-alerts for what is really the same window");
  }

  // ---- percent / threshold edge values ----
  {
    // LIMIT_AT (0.995) is absolute: it fires "limit" even when the warn threshold
    // is set at or above it.
    assert.equal(planAlerts([A("c", "Session", 0.995, iso(R1))], {}, T, T0).toSend[0].level, "limit", "exactly 0.995 is the limit");
    assert.equal(planAlerts([A("c", "Session", 0.994, iso(R1))], {}, T, T0).toSend[0].level, "warn");
    assert.equal(planAlerts([A("c", "Session", 0.996, iso(R1))], {}, 1.0, T0).toSend[0].level, "limit", "threshold 1.0 cannot suppress the limit level");
    assert.equal(planAlerts([A("c", "Session", 0.994, iso(R1))], {}, 1.0, T0).toSend.length, 0, "threshold 1.0 mutes warns entirely");
    // NaN threshold: every `> threshold` comparison is false, but the limit level
    // (which ignores the threshold) still fires.
    assert.deepEqual(planAlerts([A("c", "Session", 0.99, iso(R1))], {}, NaN, T0).toSend, []);
    assert.equal(planAlerts([A("c", "Session", 1.0, iso(R1))], {}, NaN, T0).toSend[0].level, "limit");
    // percent edge values: typeof NaN is "number" so it passes the guard, but no
    // comparison is true. Strings are skipped outright.
    for (const [p, want] of [[0, 0], [-1, 0], [NaN, 0], [-Infinity, 0], [Infinity, 1], ["0.99", 0], [null, 0], [undefined, 0]]) {
      assert.equal(planAlerts([A("c", "Session", p, iso(R1))], {}, T, T0).toSend.length, want, `percent=${String(p)}`);
    }
  }
  // WATCHED is a substring regex: "Biweekly" contains "weekly" and is watched.
  assert.equal(WATCHED.test("Biweekly"), true);
  assert.equal(planAlerts([A("c", "Biweekly", 0.99, iso(R1))], {}, T, T0).toSend.length, 1);
  // Non-string titles are stringified before the test.
  assert.equal(planAlerts([A("c", 12345, 0.99, iso(R1))], {}, T, T0).toSend.length, 0);
  assert.equal(planAlerts([A("c", null, 0.99, iso(R1))], {}, T, T0).toSend.length, 0);
  // Missing/invalid resetsAt -> resetMs null: the window can still alert once,
  // but neither the moved-on-reset check nor the stale sweep can ever see it.
  {
    const noReset = { id: "c", name: "c", limits: [{ title: "Session", percent: 0.99 }] };
    let r = planAlerts([noReset], {}, T, T0);
    assert.equal(r.toSend.length, 1);
    assert.equal(r.toSend[0].resetMs, null);
    markFired(r.memory, r.toSend[0], T0);
    const later = planAlerts([noReset], r.memory, T, T0 + 10 * HOUR);
    assert.equal(later.toSend.length, 0, "same window stays muted");
    assert.ok(later.memory[warnKey("c", "Session")], "and is never stale-pruned without a resetMs");
    // An unparseable resetsAt string behaves the same.
    const badIso = { id: "c", name: "c", limits: [{ title: "Session", percent: 0.99, resetsAt: "soon-ish" }] };
    assert.equal(planAlerts([badIso], {}, T, T0).toSend[0].resetMs, null);
  }
  // Two agents sharing id+title share one memory key: both fire on the same pass
  // (the fired check runs before any markFired), then the window is quiet.
  {
    const dup = [
      { id: "c", name: "one", limits: [{ title: "Session", percent: 0.99, resetsAt: iso(R1) }] },
      { id: "c", name: "two", limits: [{ title: "Session", percent: 0.98, resetsAt: iso(R1) }] },
    ];
    const r = planAlerts(dup, {}, T, T0);
    assert.equal(r.toSend.length, 2, "two agents, one key: both notify on the first pass");
    for (const item of r.toSend) markFired(r.memory, item, T0);
    assert.equal(planAlerts(dup, r.memory, T, T0 + MIN).toSend.length, 0, "quiet afterwards");
  }
  // An agent with exactly one account is not expanded: only the top-level limits
  // are watched (multi-account expansion needs accounts.length > 1).
  {
    const one = { id: "c", name: "c", limits: [{ title: "Session", percent: 0.5, resetsAt: iso(R1) }], accounts: [{ id: "w", label: "W", limits: [{ title: "Weekly", percent: 0.99, resetsAt: iso(R1) }] }] };
    const { toSend } = planAlerts([one], {}, T, T0);
    assert.equal(toSend.length, 0, "the single account's Weekly meter is invisible to alerts");
  }

  // ---- markFired edges ----
  {
    const mem = {};
    // resetMs null/undefined/0 is stored but never overwrites a real one later?
    // Actually `if (item.resetMs)` guards the write: a falsy item.resetMs keeps
    // whatever the record already had.
    markFired(mem, { key: "k", level: "warn", resetMs: R1 }, T0);
    markFired(mem, { key: "k", level: "warn", resetMs: null }, T0 + MIN);
    assert.equal(mem.k.resetMs, R1, "a falsy item.resetMs does not clobber the stored one");
    // limit after warn keeps the original warn timestamp.
    const mem2 = {};
    markFired(mem2, { key: "k", level: "warn", resetMs: R1 }, T0);
    markFired(mem2, { key: "k", level: "limit", resetMs: R1 }, T0 + 5 * MIN);
    assert.equal(mem2.k.levels.warn, T0, "the earlier warn time is preserved");
    assert.equal(mem2.k.levels.limit, T0 + 5 * MIN);
    // warn after limit DOES set levels.warn (it was never fired as warn).
    const mem3 = {};
    markFired(mem3, { key: "k", level: "limit", resetMs: R1 }, T0);
    assert.equal(mem3.k.levels.warn, T0, "a limit mark also covers warn");
    markFired(mem3, { key: "k", level: "warn", resetMs: R1 }, T0 + MIN);
    assert.equal(mem3.k.levels.warn, T0 + MIN, "an explicit warn mark overwrites the covered timestamp");
    // A record created with no usable resetMs stays resetMs-less through JSON.
    const mem4 = {};
    markFired(mem4, { key: "k", level: "warn", resetMs: undefined }, T0);
    assert.equal(JSON.parse(JSON.stringify(mem4)).k.resetMs, undefined, "undefined resetMs is dropped by JSON");
    assert.equal(JSON.parse(JSON.stringify(mem4)).k.resetMs ?? null, null);
  }
  // Aliasing: migrate() reuses the `before` record objects, so markFired mutates
  // the caller's `before`. planAlerts itself never mutates `before`, but a second
  // plan on the same object sees marks made through the first plan's memory —
  // which is what keeps two interleaved plan/mark passes consistent.
  {
    const before = { [warnKey("c", "Session")]: { resetMs: R1, levels: {} } };
    const p1 = planAlerts([A("c", "Session", 0.99, iso(R1))], before, T, T0);
    const p2 = planAlerts([A("c", "Session", 0.99, iso(R1))], before, T, T0);
    assert.equal(p1.toSend.length, 1);
    assert.equal(p2.toSend.length, 1, "two plans on one object both see it unfired");
    markFired(p1.memory, p1.toSend[0], T0);
    assert.equal(before[warnKey("c", "Session")].levels.warn, T0, "markFired writes through the shared record");
    assert.equal(planAlerts([A("c", "Session", 0.99, iso(R1))], before, T, T0 + MIN).toSend.length, 0,
      "a later plan on the same object sees the mark via aliasing");
  }

  // ---- alertText edges ----
  {
    // Rounding is Math.round(percent * 100): 0.955 -> 96 (half rounds up).
    assert.equal(alertText({ level: "warn", agent: { name: "A" }, limit: { title: "S", percent: 0.955 } }).title, "A: 96% used");
    // Over-100% and sub-0% percents are rendered verbatim.
    assert.equal(alertText({ level: "warn", agent: { name: "A" }, limit: { title: "S", percent: 1.4 } }).title, "A: 140% used");
    assert.equal(alertText({ level: "warn", agent: { name: "A" }, limit: { title: "S", percent: -0.2 } }).title, "A: -20% used");
    // Any level other than "limit" takes the warn wording.
    assert.equal(alertText({ level: "bogus", agent: { name: "A" }, limit: { title: "S", percent: 0.5 } }).title, "A: 50% used");
    // untilReset is optional; falsy is filtered, truthy strings are joined with " — ".
    assert.equal(alertText({ level: "warn", agent: { name: "A" }, limit: { title: "S", percent: 0.96 } }, "").body, "S limit at 96%");
    assert.equal(alertText({ level: "warn", agent: { name: "A" }, limit: { title: "S", percent: 0.96 } }, "resets soon").body, "S limit at 96% — resets soon");
    // A missing agent name renders as "undefined".
    assert.equal(alertText({ level: "warn", agent: {}, limit: { title: "S", percent: 0.96 } }).title, "undefined: 96% used");
  }

  // ---- planHandoffTriggers edges ----
  {
    // `before` is shallow-copied, NOT migrated: junk JSON shapes leave garbage
    // keys behind, and old-format "agent|title|resetsAt" keys are kept verbatim.
    // Neither kind has a numeric resetMs, so the stale sweep can never prune them —
    // handoff-fired.json accumulates them forever.
    const junk = planHandoffTriggers([A("c", "Session", 0.95, iso(R1))], "junk", T0);
    assert.equal(junk.toFire.length, 1);
    assert.deepEqual(Object.keys(junk.memory).sort(), ["0", "1", "2", "3"], "string `before` spreads into char keys");
    const oldKey = `c|Session|${iso(R1)}`;
    const old = planHandoffTriggers([], { [oldKey]: 123 }, T0 + 40 * MIN);
    assert.ok(old.memory[oldKey], "old-format keys are carried verbatim, never matched, never pruned");
    assert.equal(old.memory[oldKey], 123);
    // Wrong shapes that do work: null/undefined/array/object entries without
    // resetMs are simply along for the ride.
    assert.equal(planHandoffTriggers([A("c", "Session", 0.95, iso(R1))], null, T0).toFire.length, 1);
    assert.equal(planHandoffTriggers([A("c", "Session", 0.95, iso(R1))], [], T0).toFire.length, 1);
    // HANDOFF_AT boundary and level naming.
    assert.equal(planHandoffTriggers([A("c", "Session", HANDOFF_AT, iso(R1))], {}, T0).toFire[0].level, "warn", "exactly 90% fires as warn");
    assert.equal(planHandoffTriggers([A("c", "Session", 0.995, iso(R1))], {}, T0).toFire[0].level, "limit");
    assert.equal(planHandoffTriggers([A("c", "Session", 1.0, iso(R1))], {}, T0).toFire[0].level, "limit");
    // The rearm level is HANDOFF_AT - 0.3 = 0.6000000000000001 (inclusive).
    const HRE = HANDOFF_AT - 0.3;
    let f = planHandoffTriggers([A("c", "Session", 0.95, iso(R1))], {}, T0);
    markHandoffFired(f.memory, f.toFire[0], T0);
    let dip = planHandoffTriggers([A("c", "Session", HRE, iso(R1))], f.memory, T0 + MIN);
    assert.equal(dip.memory["handoff|c|Session"], undefined, "exactly at the rearm level clears the record");
    assert.equal(planHandoffTriggers([A("c", "Session", 0.95, iso(R1))], dip.memory, T0 + 2 * MIN).toFire.length, 1, "refires after the boundary dip");
    f = planHandoffTriggers([A("c", "Session", 0.95, iso(R1))], {}, T0);
    markHandoffFired(f.memory, f.toFire[0], T0);
    const hold = planHandoffTriggers([A("c", "Session", HRE + 1e-9, iso(R1))], f.memory, T0 + MIN);
    assert.ok(hold.memory["handoff|c|Session"], "a hair above the rearm level keeps the record");
    assert.equal(planHandoffTriggers([A("c", "Session", 0.95, iso(R1))], hold.memory, T0 + 2 * MIN).toFire.length, 0);
    // Stale sweep boundary mirrors planAlerts.
    const rec = (resetMs) => ({ "handoff|c|Session": { resetMs, at: T0 } });
    assert.equal(Object.keys(planHandoffTriggers([], rec(T0 - STALE_AFTER_MS), T0).memory).length, 1);
    assert.equal(Object.keys(planHandoffTriggers([], rec(T0 - STALE_AFTER_MS - 1), T0).memory).length, 0);
    // markHandoffFired stores resetMs verbatim: null survives in memory (JSON keeps
    // null) and then neither the window-end check nor the stale sweep can see it.
    const hm = {};
    markHandoffFired(hm, { key: "handoff|c|Session", resetMs: null }, T0);
    assert.equal(hm["handoff|c|Session"].resetMs, null);
    const hLater = planHandoffTriggers([A("c", "Session", 0.95, iso(R1))], hm, T0 + 40 * MIN);
    assert.equal(hLater.toFire.length, 0, "a null resetMs handoff record mutes the window indefinitely");
    assert.ok(hLater.memory["handoff|c|Session"], "and is never stale-pruned");
    // The handoff namespace is separate from the alert namespace: the same meter
    // can hold both memories independently.
    const both = planAlerts([A("c", "Session", 0.96, iso(R1))], {}, 0.5, T0);
    const hBoth = planHandoffTriggers([A("c", "Session", 0.96, iso(R1))], {}, T0);
    assert.equal(both.toSend.length, 1);
    assert.equal(hBoth.toFire.length, 1);
    assert.notEqual(both.toSend[0].key, hBoth.toFire[0].key);
  }

  console.log("alert-state deep: all tests passed");
} finally {
  for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
