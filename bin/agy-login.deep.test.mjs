// Deep edge-case pass for bin/agy-login.mjs on top of agy-login.test.mjs.
// The module is pure (read/kick/state/now all injected), so nothing here
// touches the real keyring, a real `agy`/`grok` CLI, or the real HOME: the
// scratch dir only exists to satisfy the "never touch the real home folder"
// rule, and env vars are pointed at it for the duration of the run.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveLogin, isFresh, MARGIN_MS, KICK_COOLDOWN_MS } from "./agy-login.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-login-deep-"));
const savedEnv = {};
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  savedEnv[k] = process.env[k];
  process.env[k] = path.join(tmp, k.toLowerCase());
  fs.mkdirSync(process.env[k], { recursive: true });
}

const NOW = 1_000_000_000_000;
const tok = (expiresMs, access = "t") => ({ access, expiresMs });
// Instrumented state: records call order and counts alongside the value.
const mkState = (v = 0) => {
  const s = { v, calls: [], get() { this.calls.push("get"); return this.v; }, set(x) { this.calls.push("set"); this.v = x; } };
  return s;
};

try {
  // ---- isFresh: wrong and missing shapes ----
  assert.equal(isFresh(null, NOW), false);
  assert.equal(isFresh(undefined, NOW), false);
  assert.equal(isFresh({}, NOW), false, "no access token is not fresh");
  assert.equal(isFresh({ access: "" }, NOW + 999999999), false, "empty access is not fresh");
  assert.equal(isFresh({ access: null, expiresMs: NOW + 1e9 }, NOW), false);
  assert.equal(isFresh({ access: 0 }, NOW), false);

  // ---- isFresh: expiresMs handling ----
  assert.equal(isFresh(tok(undefined), NOW), true, "no expiresMs = no known expiry = fresh");
  assert.equal(isFresh({ access: "t" }, NOW), true);
  for (const bad of [NaN, Infinity, -Infinity, "12345", "soon", {}, []]) {
    assert.equal(isFresh(tok(bad), NOW), true, `non-finite expiresMs ${JSON.stringify(bad)} is treated as 'no expiry'`);
  }
  // A corrupt expiresMs therefore can never trigger a kick: the token looks
  // fresh forever. Both callers build expiresMs via Date.parse(...||""), so a
  // missing expiry field lands here as NaN.

  // ---- isFresh: the margin boundary is strict ----
  assert.equal(isFresh(tok(NOW + MARGIN_MS), NOW), false, "exactly at the margin is NOT fresh");
  assert.equal(isFresh(tok(NOW + MARGIN_MS + 1), NOW), true, "one ms past the margin is fresh");
  assert.equal(isFresh(tok(NOW + MARGIN_MS + 0.5), NOW), true, "fractional ms past the margin is fresh");
  assert.equal(isFresh(tok(NOW), NOW), false, "expires right now is not fresh");
  assert.equal(isFresh(tok(NOW - 1), NOW), false);
  assert.equal(isFresh(tok(-5), NOW), false, "long-past finite expiry is not fresh");
  assert.equal(isFresh(tok(NOW + MARGIN_MS + 1), NOW + MARGIN_MS + 1), false, "freshness is relative to `now`");

  // ---- resolveLogin: missing-login variants never kick and never touch state ----
  for (const bad of [null, undefined, {}, { access: "" }, { access: null }, { access: 0 }, "str", 42, true]) {
    const st = mkState();
    let kicks = 0;
    const r = resolveLogin({ read: () => bad, kick: () => kicks++, now: NOW, state: st });
    assert.equal(r.missing, true, `read() -> ${JSON.stringify(bad)} is missing`);
    assert.equal(r.kicked, false);
    assert.equal(r.lapsed, false);
    assert.equal(kicks, 0, "missing login never kicks agy");
    assert.deepEqual(st.calls, [], "missing login never touches cooldown state");
  }

  // ---- resolveLogin: fresh path reads once, never touches state ----
  {
    const st = mkState(12345); // a stale kick timestamp must not matter
    const reads = [];
    const r = resolveLogin({ read: () => { reads.push(1); return tok(NOW + 3600e3); }, kick: () => assert.fail("must not kick"), now: NOW, state: st });
    assert.equal(reads.length, 1, "fresh login is read exactly once");
    assert.deepEqual(st.calls, [], "fresh login never consults cooldown state");
    assert.equal(r.kicked, false); assert.equal(r.lapsed, false); assert.equal(r.missing, undefined);
  }

  // ---- resolveLogin: access present but expiresMs NaN -> fresh, no kick ----
  {
    let kicks = 0;
    const st = mkState();
    const r = resolveLogin({ read: () => ({ access: "t", expiresMs: NaN }), kick: () => kicks++, now: NOW, state: st });
    assert.equal(kicks, 0);
    assert.equal(r.kicked, false);
    assert.equal(r.lapsed, false);
  }

  // ---- resolveLogin: corrupt state.get() values ----
  for (const bad of [NaN, undefined, null, "junk", -Infinity]) {
    const st = { v: bad, get() { return this.v; }, set() {} };
    let kicks = 0;
    const r = resolveLogin({ read: () => tok(NOW - 1000), kick: () => kicks++, now: NOW, state: st });
    assert.equal(kicks, 1, `state.get()=${String(bad)} must not block the kick`);
    assert.equal(r.kicked, true);
    assert.equal(r.lapsed, true);
  }
  // state.get() = Infinity reads as "kicked just now" forever: cooledDown on
  // every call. Unreachable from the real callers (their get() does
  // Number(x)||0 and JSON can't carry Infinity), but the module doesn't guard it.
  {
    const st = { v: Infinity, get() { return this.v; }, set() {} };
    let kicks = 0;
    const r = resolveLogin({ read: () => tok(NOW - 1000), kick: () => kicks++, now: NOW, state: st });
    assert.equal(kicks, 0);
    assert.equal(r.cooledDown, true);
    assert.equal(r.lapsed, true);
  }

  // ---- resolveLogin: cooldown boundary is exact ----
  {
    const st = mkState(NOW - KICK_COOLDOWN_MS); // exactly one cooldown ago
    let kicks = 0;
    const r = resolveLogin({ read: () => tok(NOW - 1000), kick: () => kicks++, now: NOW, state: st });
    assert.equal(kicks, 1, "exactly KICK_COOLDOWN_MS after the last kick kicks again");
    assert.equal(r.cooledDown, undefined);
  }
  {
    const st = mkState(NOW - KICK_COOLDOWN_MS + 1); // 1 ms inside the window
    let kicks = 0;
    const r = resolveLogin({ read: () => tok(NOW - 1000), kick: () => kicks++, now: NOW, state: st });
    assert.equal(kicks, 0);
    assert.equal(r.cooledDown, true);
  }

  // ---- resolveLogin: clock skew — a kick timestamp in the future ----
  {
    // If the clock jumped backwards after a kick, last > now and the module
    // treats it as cooling down until now passes last + KICK_COOLDOWN_MS.
    const future = NOW + 60_000;
    const st = mkState(future);
    let kicks = 0;
    const r1 = resolveLogin({ read: () => tok(NOW - 1000), kick: () => kicks++, now: NOW, state: st });
    assert.equal(kicks, 0, "a future kick timestamp counts as a recent kick");
    assert.equal(r1.cooledDown, true);
    // Still cooled 1 ms before last+cooldown, kicks 1 ms after.
    const r2 = resolveLogin({ read: () => tok(NOW - 1000), kick: () => kicks++, now: future + KICK_COOLDOWN_MS - 1, state: st });
    assert.equal(kicks, 0); assert.equal(r2.cooledDown, true);
    const r3 = resolveLogin({ read: () => tok(NOW - 1000), kick: () => kicks++, now: future + KICK_COOLDOWN_MS, state: st });
    assert.equal(kicks, 1, "cooldown measured from the future timestamp, not from now");
    assert.equal(r3.kicked, true);
  }

  // ---- resolveLogin: call ordering on the kick path ----
  {
    const st = mkState();
    const events = [];
    const wrapped = {
      get() { events.push("state.get"); return st.get(); },
      set(x) { events.push("state.set"); st.set(x); },
    };
    let reads = 0;
    resolveLogin({
      read: () => { reads++; events.push(`read#${reads}`); return reads === 1 ? tok(NOW - 1000) : tok(Date.now() + 3600e3); },
      kick: () => events.push("kick"),
      now: NOW, state: wrapped,
    });
    assert.deepEqual(events, ["read#1", "state.get", "state.set", "kick", "read#2"],
      "state.set(now) happens before kick(); the login is re-read after the kick");
    assert.equal(st.v, NOW, "state stores the injected `now`, not Date.now()");
  }

  // ---- resolveLogin: a throwing kick still consumes the cooldown ----
  {
    const st = mkState();
    let kicks = 0;
    const badKick = () => { kicks++; throw new Error("agy exploded"); };
    const r1 = resolveLogin({ read: () => tok(NOW - 1000), kick: badKick, now: NOW, state: st });
    assert.equal(r1.kicked, true);
    assert.equal(r1.lapsed, true);
    assert.equal(st.v, NOW, "the failed attempt is still remembered");
    const r2 = resolveLogin({ read: () => tok(NOW - 1000), kick: badKick, now: NOW + 1000, state: st });
    assert.equal(kicks, 1, "a failed kick does not retry inside the cooldown");
    assert.equal(r2.cooledDown, true);
  }

  // ---- resolveLogin: the post-kick re-read can return anything ----
  {
    // Kick "succeeds" but the login is gone afterwards.
    let current = tok(NOW - 1000);
    const r = resolveLogin({
      read: () => current,
      kick: () => { current = null; },
      now: NOW, state: mkState(),
    });
    assert.equal(r.kicked, true);
    assert.equal(r.lapsed, true);
    assert.equal(r.login, null);
  }
  {
    // Kick wipes the access token but leaves an expiry: still lapsed, and the
    // caller's `!login.access` check catches it.
    let current = tok(NOW - 1000);
    const r = resolveLogin({
      read: () => current,
      kick: () => { current = { access: "", expiresMs: Date.now() + 3600e3 }; },
      now: NOW, state: mkState(),
    });
    assert.equal(r.kicked, true);
    assert.equal(r.lapsed, true);
    assert.equal(r.login.access, "");
  }
  {
    // Kick leaves a token fresh by wall clock but the SECOND read throws:
    // read errors are not caught (only kick errors are), so this propagates.
    let reads = 0;
    assert.throws(() => resolveLogin({
      read: () => { reads++; if (reads === 2) throw new Error("keyring gone"); return tok(NOW - 1000); },
      kick: () => {},
      now: NOW, state: mkState(),
    }), /keyring gone/, "a throwing re-read propagates out of resolveLogin");
    // Same for the first read.
    assert.throws(() => resolveLogin({
      read: () => { throw new Error("first read boom"); },
      kick: () => assert.fail("must not kick"),
      now: NOW, state: mkState(),
    }), /first read boom/);
  }
  {
    // state.set throwing propagates before kick() ever runs.
    let kicks = 0;
    const badState = { get() { return 0; }, set() { throw new Error("disk full"); } };
    assert.throws(() => resolveLogin({
      read: () => tok(NOW - 1000), kick: () => kicks++, now: NOW, state: badState,
    }), /disk full/);
    assert.equal(kicks, 0, "kick never ran because state.set threw first");
  }

  // ---- resolveLogin: the injected `now` is ignored after the kick ----
  {
    // Pre-kick freshness uses the injected `now`; the post-kick isFresh check
    // uses Date.now() instead. With `now` far in the future, a token that is
    // fresh by the real clock but lapsed by `now` is still reported fresh.
    const fakeNow = Date.now() + 10 * 365 * 86400e3;
    let current = tok(fakeNow - 1000); // lapsed relative to fakeNow
    const r = resolveLogin({
      read: () => current,
      kick: () => { current = tok(Date.now() + MARGIN_MS + 5000); }, // fresh by real clock, lapsed by fakeNow
      now: fakeNow, state: mkState(),
    });
    assert.equal(r.kicked, true);
    assert.equal(r.lapsed, false, "post-kick freshness is judged on Date.now(), not the injected `now`");
    assert.equal(isFresh(r.login, fakeNow), false, "sanity: the same token IS lapsed relative to `now`");
  }

  // ---- resolveLogin: NaN `now` defeats the cooldown ----
  {
    const st = mkState();
    let kicks = 0;
    const r1 = resolveLogin({ read: () => tok(NOW - 1000), kick: () => kicks++, now: NaN, state: st });
    assert.equal(r1.kicked, true, "NaN now makes every finite expiry look lapsed");
    // state.set(NaN) stored NaN; NaN - NaN is NaN which is not < cooldown,
    // so the next call kicks again — the 10-minute guard is gone.
    const r2 = resolveLogin({ read: () => tok(NOW - 1000), kick: () => kicks++, now: NaN, state: st });
    assert.equal(kicks, 2, "with now=NaN the cooldown never engages");
    assert.equal(r2.kicked, true);
  }

  // ---- resolveLogin: sequential callers sharing one state (the real race) ----
  {
    // agy.mjs and grok.mjs each have their own kick file, but within one
    // process two collectors could share state; simulate back-to-back calls.
    const st = mkState();
    let kicks = 0;
    const lapsed = () => tok(NOW - 1000);
    const r1 = resolveLogin({ read: lapsed, kick: () => kicks++, now: NOW, state: st });
    const r2 = resolveLogin({ read: lapsed, kick: () => kicks++, now: NOW + 1, state: st });
    assert.equal(r1.kicked, true);
    assert.equal(r2.cooledDown, true, "the second caller inside the window does not kick again");
    assert.equal(kicks, 1);
  }

  console.log("agy-login deep: all tests passed");
} finally {
  for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
