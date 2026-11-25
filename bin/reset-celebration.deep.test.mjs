// Deep edge-case pass for bin/reset-celebration.mjs on top of
// reset-celebration.test.mjs. The module is pure — agents, prevAgents, notify,
// now and fired are all passed in and it never touches the filesystem — so the
// scratch dir only exists to satisfy the "never touch the real home folder"
// rule, and the env vars are pointed at it for the duration of the run.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyResets, resetNotice, resetNotifyArgs, resetAssets, SURPRISE_AGENTS, FLASH_MS } from "./reset-celebration.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reset-celebration-deep-"));
const savedEnv = {};
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  savedEnv[k] = process.env[k];
  process.env[k] = path.join(tmp, k.toLowerCase());
  fs.mkdirSync(process.env[k], { recursive: true });
}

const T0 = Date.parse("2026-11-22T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
// Mirrors of the module's private constants (kept in sync by the boundary tests).
const SAME_WINDOW_MS = 5 * 60 * 1000;
const NO_TIME_GAP_MS = 60 * 60 * 1000;
const FIRED_KEEP_MS = 3 * 24 * 3600 * 1000;
const A = (id, limits, extra = {}) => ({ id, name: String(id).toUpperCase(), limits, ...extra });
const lim = (title, percent, resetsAt) => ({ title, percent, ...(resetsAt === undefined ? {} : { resetsAt }) });
const run = (after, before, now, fired = {}, seen = []) => {
  applyResets(after, before, (a, w, info) => seen.push({ a, w, info }), now, fired);
  return seen;
};

try {
  // ---- tolerated wrong shapes: nothing here may throw or celebrate ----
  for (const bad of [null, undefined, []]) {
    assert.doesNotThrow(() => applyResets(bad, [], () => {}, T0, {}), `agents=${JSON.stringify(bad)}`);
  }
  // prevAgents is only read through Array.isArray + a truthy-id filter, so any
  // JSON junk is harmless.
  for (const bad of [{}, "junk", 5, [null], [5], [{ limits: [] }], [{ id: "" }], [{ id: 0 }]]) {
    assert.doesNotThrow(() => applyResets([A("c", [lim("Session", 0.01)])], bad, () => {}, T0, {}), `prevAgents=${JSON.stringify(bad)}`);
  }
  // Agent entries that are objects but carry no usable id/limits simply never match.
  for (const a of [{}, { id: "c" }, { id: "c", limits: 5 }, { id: "c", limits: [null] }, { id: "c", limits: [{ title: "Session" }] }]) {
    assert.doesNotThrow(() => applyResets([a], [A("c", [lim("Session", 0.9)])], () => {}, T0, {}), `agent=${JSON.stringify(a)}`);
  }
  // A prev agent with junk limits/accounts is fine on the single-account path
  // (accounts is only touched when the CURRENT agent has >1).
  assert.doesNotThrow(() => applyResets(
    [A("c", [lim("Session", 0.01)])],
    [{ id: "c", limits: "junk", accounts: {} }], () => {}, T0, {}));
  // Corrupt shapes that used to crash are now tolerated: a null entry inside
  // `agents` is skipped, and a truthy non-iterable `agents` (5, {}) is treated
  // as empty.
  assert.doesNotThrow(() => applyResets([null], [], () => {}, T0, {}));
  assert.doesNotThrow(() => applyResets(5, [], () => {}, T0, {}));
  // BUG: an agent with a falsy id (0, "") can never celebrate: the prev map only
  // keeps truthy ids, so `before` is never found and classifyResets sees no
  // previous meters.
  // { const f = {}; const seen = []; const ag = [A(0, [lim("Session", 0.01)])];
  //   applyResets(ag, [A(0, [lim("Session", 0.9)])], () => seen.push(1), T0, f);
  //   assert.equal(seen.length, 1, "a falsy-id agent should still celebrate"); }
  // A non-array `accounts` on the previous agent (corrupt state JSON) no longer
  // crashes the multi-account compare.
  { const cur = { id: "c", name: "c", limits: [], accounts: [
      { id: "x", label: "X", limits: [lim("Session", 0.01)] },
      { id: "y", label: "Y", limits: [lim("Session", 0.5)] }] };
    assert.doesNotThrow(() => applyResets([cur], [{ id: "c", accounts: {} }], () => {}, T0, {})); }
  // `accounts` with length > 1 that is not iterable (e.g. { length: 2 }) no
  // longer throws in the `for...of` — it falls back to the single-account path.
  { const a = { id: "c", name: "c", limits: [], accounts: { length: 2 } };
    assert.doesNotThrow(() => applyResets([a], [], () => {}, T0, {})); }

  // ---- percent edge values ----
  {
    // Strings, null, undefined and objects are skipped by the typeof guard.
    for (const p of ["0.01", null, undefined, {}]) {
      const seen = run([A("c", [lim("Session", p)])], [A("c", [lim("Session", 0.9)])], T0, {});
      assert.equal(seen.length, 0, `percent=${JSON.stringify(p)} must not celebrate`);
    }
    // -Infinity is a number and an infinite drop: it celebrates.
    assert.equal(run([A("c", [lim("Session", -Infinity)])], [A("c", [lim("Session", 0.9)])], T0, {}).length, 1);
    // A NaN percent is not a reading: it must never celebrate.
    assert.equal(run([A("c", [lim("Session", NaN)])], [A("c", [lim("Session", 0.9)])], T0, {}).length, 0,
      "NaN percent must not celebrate");
    // The drop must be STRICTLY greater than 0.5 (classifyResets minDrop).
    assert.equal(run([A("c", [lim("Session", 0.5)])], [A("c", [lim("Session", 1)])], T0, {}).length, 0, "exactly 50 points is not a reset");
    assert.equal(run([A("c", [lim("Session", 0.499999)])], [A("c", [lim("Session", 1)])], T0, {}).length, 1, "a hair over 50 points is");
    // A meter watched through its `window` field but with an unnamed title still
    // celebrates — and the notice honestly says "limit" because windowPhrase only
    // reads titles.
    const seen = [];
    const ag = [{ id: "w", name: "W", limits: [{ title: "Usage", window: "session", percent: 0.01 }, { title: "Usage2", window: "bogus", percent: 0.01 }] }];
    applyResets(ag, [{ id: "w", name: "W", limits: [{ title: "Usage", window: "session", percent: 0.9 }, { title: "Usage2", window: "bogus", percent: 0.5 }] }],
      (a, w, i) => seen.push(i), T0, {});
    assert.equal(seen.length, 1);
    assert.deepEqual(ag[0].resetWindows, ["Usage"], "only the watched meter that dropped is listed");
    assert.equal(ag[0].resetPhrase, "limit", "an unnamed window reads as 'limit'");
    assert.equal(resetNotice(ag[0], ag[0].resetWindows, seen[0]).title, "W limit reset, go cook.");
  }

  // ---- the `fired` dedupe state: corrupt records, boundaries, pruning ----
  {
    const mk = (p, ra) => [A("g", [lim("Weekly", p, ra)])];
    const due = "2026-11-22T10:00:00Z";
    // A record with a missing/corrupt `at` or junk shape cannot suppress: the
    // comparisons come out NaN/false and the window re-celebrates, then the
    // record is overwritten with a well-formed one.
    for (const rec of [{}, { at: "garbage" }, "junk", { endMs: "x", at: T0 }]) {
      const fired = { "g|Weekly": rec };
      const seen = run(mk(0.05, "2026-11-22T15:00:00Z"), mk(0.9, due), T0 + 60000, fired);
      assert.equal(seen.length, 1, `corrupt fired record ${JSON.stringify(rec)} must not suppress`);
      assert.equal(typeof fired["g|Weekly"].at, "number", "the record is rewritten well-formed");
    }
    // A null/falsy record is pruned outright.
    const firedNull = { "g|Weekly": null, "keep|Me": { at: T0 } };
    assert.equal(run(mk(0.05, "2026-11-22T15:00:00Z"), mk(0.9, due), T0, firedNull).length, 1);
    assert.equal(firedNull["g|Weekly"].at, T0);
    assert.deepEqual(firedNull["keep|Me"], { at: T0 }, "unrelated keys are carried through untouched");
    // A record stamped in the FUTURE (clock skew) mutes the no-time window until
    // `now` passes at + NO_TIME_GAP_MS — much longer than the real gap.
    {
      const fired = {};
      const nt = (p) => [A("g", [lim("Weekly", p)])];   // no resetsAt anywhere
      assert.equal(run(nt(0.05), nt(0.9), T0, fired).length, 1);
      fired["g|Weekly"].at = T0 + 86400000;              // stamp it a day ahead
      assert.equal(run(nt(0.05), nt(0.9), T0 + 60000, fired).length, 0,
        "a future `at` suppresses far past the real one-hour gap");
    }
    // The no-time gap is strict: 1 ms before the hour is still muted, exactly at
    // it re-celebrates.
    {
      const fired = {};
      const nt = (p) => [A("g", [lim("Weekly", p)])];
      assert.equal(run(nt(0.05), nt(0.9), T0, fired).length, 1);
      assert.equal(run(nt(0.05), nt(0.9), T0 + NO_TIME_GAP_MS - 1, fired).length, 0);
      assert.equal(run(nt(0.05), nt(0.9), T0 + NO_TIME_GAP_MS, fired).length, 1, "exactly one hour later is a new window");
    }
    // With a known window end the same-window rule has NO hour limit: the same
    // endMs keeps muting for days (until the 3-day prune), unlike the no-time
    // path which re-arms after an hour.
    {
      const fired = {};
      const w = (p) => mk(p, "2026-11-22T15:00:00Z");
      const p = (p) => mk(p, due);
      assert.equal(run(w(0.05), p(0.9), T0, fired).length, 1);
      assert.equal(run(w(0.05), p(0.9), T0 + 2 * 3600000, fired).length, 0,
        "same endMs stays muted well past the no-time hour");
      // ...but the 3-day keep is also strict: exactly FIRED_KEEP_MS keeps it,
      // 1 ms older prunes it and the same window celebrates again.
      assert.equal(run(w(0.05), p(0.9), T0 + FIRED_KEEP_MS, fired).length, 0, "exactly 3 days is kept");
      assert.equal(run(w(0.05), p(0.9), T0 + FIRED_KEEP_MS + 1, fired).length, 1, "3 days + 1 ms is pruned and refires");
    }
    // SAME_WINDOW_MS is inclusive: a resetsAt wobble of exactly 5 minutes is the
    // same window; 1 ms more is a new one.
    {
      const fired = {};
      const w = (p, ra) => mk(p, ra);
      let n = 0;
      const fire = (prevRa, now) => applyResets(w(0.05, "2026-11-22T15:00:00Z"), w(0.9, prevRa), () => n++, now, fired);
      fire("2026-11-22T10:00:00.000Z", T0);
      fire("2026-11-22T10:05:00.000Z", T0 + 60000);            // exactly +5 min: same window
      assert.equal(n, 1);
      fire("2026-11-22T10:05:00.001Z", T0 + 120000);           // +5 min + 1 ms: new window
      assert.equal(n, 2);
    }
    // BUG: the dedupe is asymmetric. A meter that celebrated WITHOUT a reset
    // time re-celebrates within the hour as soon as its previous meter gains a
    // resetsAt (endMs present skips both guards), while the reverse order stays
    // suppressed by the one-hour rule.
    // { const fired = {}; const nt = (p, ra) => [A("g", [lim("Weekly", p, ra)])];
    //   const seen = [];
    //   applyResets(nt(0.05), nt(0.9), () => seen.push(1), T0, fired);
    //   applyResets(nt(0.05, "2026-11-22T15:00:00Z"), nt(0.9, "2026-11-22T15:00:00Z"), () => seen.push(2), T0 + 60000, fired);
    //   assert.equal(seen.length, 1, "the same flicker should not celebrate twice in an hour"); }
    // The reverse order IS suppressed: timed fire, then a no-time flicker.
    {
      const fired = {};
      const nt = (p, ra) => [A("g", [lim("Weekly", p, ra)])];
      const seen = [];
      applyResets(nt(0.05, "2026-11-22T15:00:00Z"), nt(0.9, "2026-11-22T10:00:00Z"), () => seen.push(1), T0, fired);
      applyResets(nt(0.05), nt(0.9), () => seen.push(2), T0 + 60000, fired);
      assert.equal(seen.length, 1, "timed then no-time inside the hour stays quiet");
    }
    // `fired` itself is not validated. null is treated as empty (collect.mjs
    // sanitizes before calling, so this is latent); a string is treated the
    // same way. An ARRAY still accepts the records as expando properties that
    // JSON.stringify silently drops — dedupe would be lost across a restart.
    assert.doesNotThrow(() => run(mk(0.05, "2026-11-22T15:00:00Z"), mk(0.9, due), T0, null));
    // BUG: an array `fired` keeps records as expando properties that
    // JSON.stringify silently drops — dedupe would be lost across a restart.
    // const arr = []; run(mk(0.05, "2026-11-22T15:00:00Z"), mk(0.9, due), T0, arr);
    // assert.ok(JSON.parse(JSON.stringify(arr))["g|Weekly"], "array fired must survive serialization");
  }

  // ---- multi-account edges ----
  {
    const mk = (sessionP, extra = {}) => ({
      id: "c", name: "C", limits: [],
      accounts: [
        { id: "x", label: "X", limits: [lim("Session", sessionP.x)] },
        { id: "y", label: "Y", limits: [lim("Weekly", sessionP.y)] },
      ],
      ...extra,
    });
    // An account that is new since last run has no previous meters: no celebrate.
    {
      const before = { id: "c", name: "C", limits: [], accounts: [{ id: "x", label: "X", limits: [lim("Session", 0.9)] }] };
      const seen = [];
      applyResets([mk({ x: 0.9, y: 0.01 })], [before], (a, w, i) => seen.push(i), T0, {});
      assert.equal(seen.length, 0, "a brand-new account cannot have 'reset'");
    }
    // Two accounts dropping DIFFERENT meters: one notice naming both accounts.
    {
      const before = { id: "c", name: "C", limits: [], accounts: [
        { id: "x", label: "X", limits: [lim("Session", 0.9)] },
        { id: "y", label: "Y", limits: [lim("Weekly", 0.9)] }] };
      const after = { id: "c", name: "C", limits: [], accounts: [
        { id: "x", label: "X", limits: [lim("Session", 0.01)] },
        { id: "y", label: "Y", limits: [lim("Weekly", 0.01)] }] };
      const seen = [];
      applyResets([after], [before], (a, w, i) => seen.push(i), T0, {});
      assert.equal(seen.length, 1, "one notice per agent per refresh, not per account");
      assert.deepEqual(seen[0].accounts.sort(), ["X", "Y"]);
      assert.deepEqual(after.resetWindows.sort(), ["Session", "Weekly"]);
      assert.equal(resetNotice(after, after.resetWindows, seen[0]).title, "C (X, Y) session and weekly reset, go cook.");
    }
    // Junk inside one account's limits doesn't sink the other account.
    {
      const before = { id: "c", name: "C", limits: [], accounts: [
        { id: "x", label: "X", limits: [lim("Session", 0.9)] },
        { id: "y", label: "Y", limits: [lim("Weekly", 0.9)] }] };
      const after = { id: "c", name: "C", limits: [], accounts: [
        { id: "x", label: "X", limits: "junk" },
        { id: "y", label: "Y", limits: [lim("Weekly", 0.01)] }] };
      const seen = [];
      applyResets([after], [before], (a, w, i) => seen.push(i), T0, {});
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0].accounts, ["Y"], "only the account that actually dropped is named");
    }
    // BUG: two accounts resetting the SAME meter title produce duplicate windows
    // — resetWindows ["Session","Session"] and a notice body reading
    // "Session and Session limits reset".
    // { const b = { id: "c", name: "C", limits: [], accounts: [
    //     { id: "x", label: "X", limits: [lim("Session", 0.9)] },
    //     { id: "y", label: "Y", limits: [lim("Session", 0.9)] }] };
    //   const a2 = { id: "c", name: "C", limits: [], accounts: [
    //     { id: "x", label: "X", limits: [lim("Session", 0.01)] },
    //     { id: "y", label: "Y", limits: [lim("Session", 0.01)] }] };
    //   const seen = []; applyResets([a2], [b], (x, w, i) => seen.push(i), T0, {});
    //   assert.deepEqual(a2.resetWindows, ["Session"], "duplicate titles should dedupe");
    //   assert.equal(resetNotice(a2, a2.resetWindows, seen[0]).body, "\u{1F4B8} Session limit reset"); }
    // BUG: an account without `label` puts undefined into info.accounts, which
    // renders as an empty "()" in the notice title.
    // { const b = { id: "c", name: "C", limits: [], accounts: [
    //     { id: "x", limits: [lim("Session", 0.9)] },
    //     { id: "y", label: "Y", limits: [lim("Weekly", 0.9)] }] };
    //   const a2 = { id: "c", name: "C", limits: [], accounts: [
    //     { id: "x", limits: [lim("Session", 0.01)] },
    //     { id: "y", label: "Y", limits: [lim("Weekly", 0.9)] }] };
    //   const seen = []; applyResets([a2], [b], (x, w, i) => seen.push(i), T0, {});
    //   assert.equal(resetNotice(a2, ["Session"], seen[0]).title, "C session reset, go cook."); }
    // BUG: accounts without `id` all share the fired key "c:undefined|<title>",
    // so same-title resets in different id-less accounts suppress each other.
    // { const mk2 = (p) => ({ id: "c", name: "C", limits: [], accounts: [
    //     { label: "A", limits: [lim("Session", p)] }, { label: "B", limits: [lim("Session", p)] }] });
    //   const seen = []; applyResets([mk2(0.01)], [mk2(0.9)], (x, w, i) => seen.push(i), T0, {});
    //   assert.deepEqual(seen[0].accounts.sort(), ["A", "B"], "both id-less accounts should be named"); }
    // BUG: an agent with exactly ONE account and empty top-level `limits` never
    // celebrates — the multi-account path needs accounts.length > 1, so the
    // account's meters are invisible (same shape as the alert-state bug).
    // { const one = { id: "c", name: "C", limits: [], accounts: [{ id: "w", label: "W", limits: [lim("Session", 0.01)] }] };
    //   const onePrev = { id: "c", name: "C", limits: [], accounts: [{ id: "w", label: "W", limits: [lim("Session", 0.9)] }] };
    //   const seen = []; applyResets([one], [onePrev], () => seen.push(1), T0, {});
    //   assert.equal(seen.length, 1, "a single account's meters should still be watched"); }
    // A non-iterable `accounts` with length > 1 does NOT throw for strings
    // (they iterate as chars and match nothing) — junk is silently ignored.
    {
      const a = { id: "c", name: "C", limits: [lim("Session", 0.01)], accounts: "ab" };
      assert.doesNotThrow(() => applyResets([a], [A("c", [lim("Session", 0.9)])], () => {}, T0, {}));
    }
  }

  // ---- agent identity, mutation and misc module behaviour ----
  {
    // Duplicate ids: the fired key is consumed by the first, so the second
    // agent with the same id is silently skipped. Ids are expected unique.
    {
      const fired = {};
      const seen = [];
      const dup = [A("c", [lim("Session", 0.01)]), A("c", [lim("Session", 0.01)])];
      applyResets(dup, [A("c", [lim("Session", 0.9)])], (a) => seen.push(a), T0, fired);
      assert.equal(seen.length, 1);
      assert.deepEqual(dup.map((d) => !!d.resetAt), [true, false]);
    }
    // prevAgents entries that never appear in `agents` are ignored entirely.
    {
      const seen = [];
      applyResets([A("c", [lim("Session", 0.5)])], [A("gone", [lim("Session", 0.9)]), A("c", [lim("Session", 0.5)])],
        () => seen.push(1), T0, {});
      assert.equal(seen.length, 0);
    }
    // Mutation contract: the CURRENT agent objects are flagged in place; the
    // previous snapshot is never written to.
    {
      const prev = [A("c", [lim("Session", 0.9)])];
      const cur = [A("c", [lim("Session", 0.01)])];
      const ret = applyResets(cur, prev, () => {}, T0, {});
      assert.equal(ret, undefined);
      assert.equal(cur[0].resetAt, T0);
      assert.equal(prev[0].resetAt, undefined, "prevAgents must not be mutated");
      assert.equal(cur[0].resetKind, "scheduled");
      assert.equal(cur[0].resetMagnitude, 1);
      assert.deepEqual(cur[0].resetAccounts, []);
    }
    // BUG: reset* fields are only ever SET, never cleared. An agent object that
    // arrives already carrying a stale resetAt keeps it forever when nothing
    // resets this run (collect.mjs rebuilds agents each run, so this is latent).
    // { const stale = { id: "s", name: "s", limits: [lim("Session", 0.1)], resetAt: T0 - 999999, resetWindows: ["Session"] };
    //   applyResets([stale], [], () => {}, T0, {});
    //   assert.equal(stale.resetAt, undefined, "a stale celebration flag should be cleared"); }
    // BUG: if `notify` throws, the fired record has ALREADY been written during
    // the details filter — so the reset is marked celebrated but the user is
    // never told, and no later run will retry the notification.
    // { const fired = {};
    //   assert.throws(() => applyResets([A("c", [lim("Session", 0.01)])], [A("c", [lim("Session", 0.9)])], () => { throw new Error("boom"); }, T0, fired));
    //   const seen = []; applyResets([A("c", [lim("Session", 0.02)])], [A("c", [lim("Session", 0.01)])], () => seen.push(1), T0 + 60000, fired);
    //   assert.equal(seen.length, 1, "a failed notify should not consume the celebration"); }
    // ...but the partial-mutation part IS real: the throwing agent keeps its
    // reset* flags even though the exception propagated.
    {
      const fired = {};
      const agents = [A("c", [lim("Session", 0.01)]), A("d", [lim("Session", 0.01)])];
      const prev = [A("c", [lim("Session", 0.9)]), A("d", [lim("Session", 0.9)])];
      assert.throws(() => applyResets(agents, prev, (a) => { if (a.id === "c") throw new Error("boom"); }, T0, fired));
      assert.equal(agents[0].resetAt, T0, "the flag is set before notify runs");
      assert.equal(agents[1].resetAt, undefined, "agents after the throw are never processed");
      assert.ok(fired["c|Session"] && !fired["d|Session"], "fired is written per-agent as the loop reaches it");
    }
    // A second, DIFFERENT reset inside the flash window celebrates again and
    // moves resetAt forward — dedupe is per-window, not per-flash.
    {
      const fired = {};
      const w = (p, ra) => [A("c", [lim("Session", p, ra), lim("Weekly", p, ra)])];
      let n = 0;
      applyResets(w(0.01, "2026-11-22T15:00:00Z"), w(0.9, "2026-11-22T10:00:00Z"), () => n++, T0, fired);
      const ag = [A("c", [lim("Daily", 0.01, "2026-11-22T20:00:00Z")])];
      const pv = [A("c", [lim("Daily", 0.9, "2026-11-22T10:00:00Z")])];
      applyResets(ag, pv, () => n++, T0 + 4000, fired);
      assert.equal(n, 2, "a different meter resetting inside the flash celebrates again");
      assert.equal(ag[0].resetAt, T0 + 4000);
    }
    // The keep-alive path copies every celebration field, including accounts.
    {
      const mkAcc = (sx, wy) => ({ id: "c", name: "C", limits: [], accounts: [
        { id: "x", label: "X", limits: [lim("Session", sx)] },
        { id: "y", label: "Y", limits: [lim("Weekly", wy)] }] });
      const seen = [];
      const first = mkAcc(0.05, 0.9);
      applyResets([first], [mkAcc(0.95, 0.9)], (a, w, i) => seen.push(i), T0, {});
      assert.deepEqual(first.resetAccounts, ["X"], "only the account that dropped is named");
      const second = mkAcc(0.07, 0.9);   // x ticks up, y flat: nothing new reset
      const seen2 = [];
      applyResets([second], [JSON.parse(JSON.stringify(first))], (a, w, i) => seen2.push(i), T0 + 4000, {});
      assert.equal(second.resetAt, T0, "the in-progress flash is kept alive");
      assert.deepEqual(second.resetAccounts, ["X"]);
      assert.deepEqual(second.resetWindows, ["Session"]);
      assert.equal(seen2.length, 0, "the same windows do not re-notify inside the flash");
    }
    // Boundary: keep-alive is `now - before.resetAt < FLASH_MS + 5000`, strict.
    {
      const base = { id: "k", name: "k", limits: [], resetAt: T0, resetWindows: ["Session"], resetKind: "scheduled", resetMagnitude: 1, resetPhrase: "session", resetDetails: [], resetAccounts: [] };
      const cur = () => ({ id: "k", name: "k", limits: [lim("Session", 0.1)] });
      const a1 = cur(); applyResets([a1], [base], () => {}, T0 + FLASH_MS + 4999, {});
      assert.equal(a1.resetAt, T0, "1 ms inside the window stays lit");
      const a2 = cur(); applyResets([a2], [base], () => {}, T0 + FLASH_MS + 5000, {});
      assert.equal(a2.resetAt, undefined, "exactly at the limit the flash is over");
      // ...and a resetAt that is not a finite number can never keep anything alive.
      const junk = { ...base, resetAt: "garbage" };
      const a3 = cur(); applyResets([a3], [junk], () => {}, T0 + 1000, {});
      assert.equal(a3.resetAt, undefined);
    }
    // Clock skew: `now` earlier than before.resetAt makes the difference
    // negative, which is < FLASH_MS + 5000 — the flash is kept alive "forever"
    // while the clock is behind.
    {
      const base = { id: "b", name: "b", limits: [], resetAt: T0, resetWindows: ["S"], resetKind: "scheduled", resetMagnitude: 1, resetPhrase: "", resetDetails: [], resetAccounts: [] };
      const cur = { id: "b", name: "b", limits: [lim("Session", 0.1)] };
      applyResets([cur], [base], () => {}, T0 - 3600000, {});
      assert.equal(cur.resetAt, T0, "a backwards clock keeps the flash lit");
    }
    // NaN `now`: nothing throws; the reset is classified scheduled (every
    // surprise comparison is NaN) and resetAt is stored as NaN.
    {
      const seen = [];
      const ag = [A("claude", [lim("Session", 0.01, iso(T0 + 3600e3))])];
      const pv = [A("claude", [lim("Session", 0.9, iso(T0 + 7200e3))])];
      applyResets(ag, pv, (a, w, i) => seen.push(i.kind), NaN, {});
      assert.deepEqual(seen, ["scheduled"], "NaN now cannot prove a surprise");
      assert.ok(Number.isNaN(ag[0].resetAt));
    }
    // A non-string resetsAt (e.g. a number from corrupt state) parses to NaN, so
    // endMs is null and the window falls back to the one-hour no-time rule.
    {
      const fired = {};
      const w = (p) => [A("c", [{ title: "Session", percent: p, resetsAt: 1795341600000 }])];
      let n = 0;
      applyResets(w(0.05), w(0.9), () => n++, T0, fired);
      applyResets(w(0.05), w(0.9), () => n++, T0 + 60000, fired);
      assert.equal(n, 1, "numeric resetsAt is treated as no reset time");
      assert.equal(fired["c|Session"].endMs, null);
      applyResets(w(0.05), w(0.9), () => n++, T0 + NO_TIME_GAP_MS, fired);
      assert.equal(n, 2, "and re-arms after the usual hour");
    }
    // Several watched meters dropping in one refresh = ONE notify call carrying
    // all of them, with the biggest window setting the magnitude.
    {
      const seen = [];
      const ag = [A("c", [lim("Session", 0.01), lim("Weekly", 0.02), lim("Fable", 0.9)])];
      const pv = [A("c", [lim("Session", 0.9), lim("Weekly", 0.95), lim("Fable", 0.91)])];
      applyResets(ag, pv, (a, w, i) => seen.push({ w, i }), T0, {});
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0].w, ["Session", "Weekly"], "unwatched and non-dropping meters are excluded");
      assert.equal(ag[0].resetMagnitude, 1.25);
      assert.equal(ag[0].resetPhrase, "session and weekly");
      assert.equal(seen[0].i.kind, "scheduled");
      assert.ok(!("confirmed" in seen[0].i), "the module never sets confirmed — collect.mjs does");
    }
  }

  // ---- resetNotice edges ----
  {
    const early = (title, dueAt, surprise = true) => ({ title, surprise, dueAt });
    // info = null/undefined/plain junk falls through to the normal notice.
    for (const info of [null, undefined, {}, { kind: "bogus" }]) {
      assert.equal(resetNotice({ id: "grok", name: "Grok" }, ["Weekly"], info).title, "Grok weekly reset, go cook.");
    }
    // A surprise kind for an agent with no SURPRISE_AGENTS copy is just a normal notice.
    assert.equal(
      resetNotice({ id: "grok", name: "Grok" }, ["Weekly"], { kind: "surprise", details: [early("Weekly", "")] }).title,
      "Grok weekly reset, go cook.");
    // confirmed without a usable author still takes the announcement branch.
    for (const confirmed of [{}, { source: null }, { source: {} }, { source: { author: "" } }]) {
      const n = resetNotice({ id: "antigravity", name: "Antigravity" }, ["Weekly"],
        { kind: "surprise", details: [early("Claude/GPT Weekly", iso(T0 + 86400000))], confirmed });
      assert.equal(n.title, "Google just reset everyone's weekly limit, go cook.");
      assert.ok(n.body.endsWith("(via agyresets.com)"), `no author: ${JSON.stringify(confirmed)}`);
      assert.ok(!/ by @/.test(n.body), "no empty '@' attribution");
    }
    // Several early details: titles join with " and ", the phrase covers both
    // windows, and the body quotes the EARLIEST due time.
    {
      const details = [
        early("Gemini Session", iso(T0 + 5 * 3600e3)),
        early("Claude/GPT Weekly", iso(T0 + 86400000)),
        { title: "Gemini Daily", surprise: false, dueAt: iso(T0 - 86400000) },   // scheduled: excluded
      ];
      const args = ["Gemini Session", "Claude/GPT Weekly", "Gemini Daily"];
      const n = resetNotice({ id: "antigravity", name: "Antigravity" }, args,
        { kind: "surprise", details, confirmed: { source: { author: "agy" } } });
      assert.equal(n.title, "Google just reset everyone's session and weekly limits, go cook.",
        "only the early windows count, and both windows pluralise 'limits'");
      assert.match(n.body, /Gemini Session and Claude\/GPT Weekly reset early\. Announced by @agy \(via agyresets\.com\)$/);
      assert.ok(!/Gemini Daily/.test(n.body), "scheduled details stay out of the surprise copy");
      const honest = resetNotice({ id: "antigravity", name: "Antigravity" }, args, { kind: "surprise", details });
      assert.match(honest.body, /wasn't due until .+\. No announcement found\.$/, "the earliest dueAt is quoted");
    }
    // Unparseable dueAt values are dropped; with none left the "wasn't due"
    // clause disappears entirely.
    {
      const n = resetNotice({ id: "claude", name: "Claude Code" }, ["Session"],
        { kind: "surprise", details: [early("Session", "not-a-date"), early("Session", "")] });
      assert.ok(!/wasn't due until/.test(n.body), "no readable due time, no due clause");
      assert.ok(n.body.endsWith("No announcement found."));
    }
    // BUG: kind "surprise" with NO early details produces degenerate copy —
    // "Claude limit reset came early" and a body with an empty title list.
    // { const n = resetNotice({ id: "claude", name: "Claude Code" }, ["Session"],
    //     { kind: "surprise", details: [{ title: "Session", surprise: false, dueAt: "" }] });
    //   assert.notMatch(n.title, /limit reset came early/, "no early meter, no surprise wording"); }
    // resetNotice tolerates wrong argument types: a non-array `windows`, a null
    // agent, or a non-array `info.accounts` no longer throw TypeError.
    assert.doesNotThrow(() => resetNotice({ name: "X" }, null, {}));
    assert.doesNotThrow(() => resetNotice(null, ["Session"], {}));
    assert.doesNotThrow(() => resetNotice({ name: "X" }, ["Session"], { accounts: "ab" }));
    // Normal-path edges that DO work: missing agent name renders "undefined",
    // empty windows render the "limit" fallback, accounts are joined verbatim.
    assert.equal(resetNotice({}, ["Session"], {}).title, "undefined session reset, go cook.");
    assert.equal(resetNotice({ name: "X" }, [], {}).title, "X limit reset, go cook.");
    assert.equal(resetNotice({ name: "X" }, ["Session"], { accounts: [] }).title, "X session reset, go cook.");
    assert.equal(resetNotice({ name: "X" }, ["Session"], { accounts: ["Main", "Work"] }).title, "X (Main, Work) session reset, go cook.");
  }

  // ---- resetNotifyArgs / resetAssets / SURPRISE_AGENTS surface ----
  {
    // image-path hint is skipped for ANY falsy imagePath, included verbatim otherwise.
    for (const p of ["", null, undefined, 0]) {
      assert.ok(!resetNotifyArgs({ title: "T", body: "B" }, p).some((a) => String(a).includes("image-path")), `imagePath=${JSON.stringify(p)}`);
    }
    assert.ok(resetNotifyArgs({ title: "T", body: "B" }, "a b/c.svg").includes("string:image-path:a b/c.svg"), "paths pass through verbatim");
    // title/body are appended unconditionally, even when missing.
    const tail = resetNotifyArgs({}, "/x.svg");
    assert.ok(tail.includes("string:image-path:/x.svg"));
    assert.deepEqual(tail.slice(-2), [undefined, undefined]);
    // resetAssets: only the exact string "surprise" gets the surprise pair.
    for (const k of ["Surprise", "SURPRISE", null, 0, {}, []]) {
      assert.deepEqual(resetAssets(k), { image: "cash-burst.svg", sound: "cha-ching.wav" }, `kind=${JSON.stringify(k)}`);
    }
    // Only Antigravity has an announcement source; Claude's copy is honest-only.
    assert.equal(typeof SURPRISE_AGENTS.antigravity.confirmed, "function");
    assert.equal(SURPRISE_AGENTS.claude.confirmed, undefined);
    assert.equal(typeof SURPRISE_AGENTS.claude.honest, "function");
  }

  console.log("reset-celebration deep: all tests passed");
} finally {
  for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
