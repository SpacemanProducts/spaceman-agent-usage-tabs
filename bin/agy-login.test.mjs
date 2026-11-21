import assert from "node:assert/strict";
import { resolveLogin, isFresh, MARGIN_MS, KICK_COOLDOWN_MS } from "./agy-login.mjs";
const NOW = 1_000_000_000_000;
const mkState = (v = 0) => ({ v, get() { return this.v; }, set(x) { this.v = x; } });
const tok = (expiresMs) => ({ access: "t", expiresMs });

// 1. Fresh token: agy is never run.
let kicks = 0;
let r = resolveLogin({ read: () => tok(NOW + 3600e3), kick: () => kicks++, now: NOW, state: mkState() });
assert.equal(r.kicked, false); assert.equal(kicks, 0); assert.equal(r.lapsed, false);

// 2. Lapsed token, agy refreshes it: kicked once, then fresh.
let current = tok(NOW - 1000); kicks = 0;
r = resolveLogin({ read: () => current, kick: () => { kicks++; current = tok(Date.now() + 3600e3); }, now: NOW, state: mkState() });
assert.equal(kicks, 1); assert.equal(r.kicked, true); assert.equal(r.lapsed, false); assert.ok(isFresh(r.login, Date.now()));

// 3. About to expire (inside the margin) counts as lapsing.
current = tok(NOW + MARGIN_MS - 1); kicks = 0;
resolveLogin({ read: () => current, kick: () => { kicks++; current = tok(Date.now() + 3600e3); }, now: NOW, state: mkState() });
assert.equal(kicks, 1);

// 4. agy cannot refresh (refresh token dead): reported lapsed, not an error.
kicks = 0;
r = resolveLogin({ read: () => tok(NOW - 1000), kick: () => kicks++, now: NOW, state: mkState() });
assert.equal(r.lapsed, true); assert.equal(r.kicked, true); assert.equal(kicks, 1);

// 5. Cooldown: a second attempt within 10 minutes does not run agy again.
const st = mkState(); kicks = 0;
resolveLogin({ read: () => tok(NOW - 1000), kick: () => kicks++, now: NOW, state: st });
r = resolveLogin({ read: () => tok(NOW - 1000), kick: () => kicks++, now: NOW + KICK_COOLDOWN_MS - 1, state: st });
assert.equal(kicks, 1); assert.equal(r.cooledDown, true); assert.equal(r.lapsed, true);
resolveLogin({ read: () => tok(NOW - 1000), kick: () => kicks++, now: NOW + KICK_COOLDOWN_MS + 1, state: st });
assert.equal(kicks, 2, "retries after the cooldown");

// 6. No login at all: agy is not run (nothing to refresh).
kicks = 0;
r = resolveLogin({ read: () => null, kick: () => kicks++, now: NOW, state: mkState() });
assert.equal(kicks, 0); assert.equal(r.missing, true);

// 7. A kick that throws is survived.
r = resolveLogin({ read: () => tok(NOW - 1000), kick: () => { throw new Error("boom"); }, now: NOW, state: mkState() });
assert.equal(r.lapsed, true);
console.log("agy-login: all tests passed");
