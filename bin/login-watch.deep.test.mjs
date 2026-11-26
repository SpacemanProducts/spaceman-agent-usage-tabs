import assert from "node:assert/strict";
import { isHidden, planLoginNotices, planInstallNotices } from "./login-watch.mjs";

// login-watch.mjs is pure: it reads no files, no env, keeps no module state and
// has no timers, so there is nothing to isolate in a temp dir (HOME/XDG_* are
// never consulted) and no timing race to exercise — every call is independent
// and returns fresh objects, so concurrent callers cannot interfere. These
// tests cover what login-watch.test.mjs does not: wrong-type inputs, edge
// values for installed/signedIn/hideUninstalled, falsy `seen` memory values,
// duplicate ids, prototype-property ids, and the corrupt-JSON shapes that
// readJson() in collect.mjs can actually hand this module (arrays, scalars).

const A = (id, signedIn, installed = true) => ({ id, name: String(id).toUpperCase(), signedIn, installed });
const ag = (id, installed) => ({ id, name: String(id).toUpperCase(), installed });
const ids = (list) => list.map((a) => a.id);

// ---- isHidden: only literal `installed === false` means uninstalled ----
for (const inst of [undefined, null, 0, "", "false", NaN]) {
  assert.equal(isHidden({ id: "x", installed: inst }, { hiddenAgents: ["x"] }), true,
    `installed=${JSON.stringify(inst)} still counts as installed`);
}
// Missing/garbage settings fall back to defaults: hiddenAgents [] and
// hideUninstalled on.
assert.equal(isHidden({ id: "x", installed: false }), true, "no settings arg");
assert.equal(isHidden({ id: "x", installed: false }, undefined), true, "undefined settings");
assert.throws(() => isHidden({ id: "x", installed: false }, null), TypeError, "null settings: destructure of null throws");
assert.equal(isHidden({ id: "x", installed: false }, "junk"), true, "string settings");
assert.equal(isHidden({ id: "x", installed: false }, {}), true, "{} -> hideUninstalled defaults on");
assert.equal(isHidden({ id: "x", installed: false }, { hideUninstalled: false }), false);
// QUIRK: the destructured default only fills in `undefined`, so isHidden
// returns the raw hideUninstalled value (not a boolean) for uninstalled
// agents. Callers use it in boolean context so it still works, but the
// return type is a lie for non-boolean settings.
assert.equal(isHidden({ id: "x", installed: false }, { hideUninstalled: 0 }), 0);
assert.equal(isHidden({ id: "x", installed: false }, { hideUninstalled: "no" }), "no");
// hiddenAgents quirks: a string works via String.includes (substring match!),
// and a non-array without .includes throws only when the installed branch
// actually runs (the uninstalled branch returns hideUninstalled untouched).
assert.equal(isHidden({ id: "am" }, { hiddenAgents: "amp" }), true, "string hiddenAgents substring-matches");
assert.throws(() => isHidden({ id: "x", installed: true }, { hiddenAgents: 5 }), TypeError);
assert.throws(() => isHidden({ id: "x", installed: true }, { hiddenAgents: {} }), TypeError);
// An uninstalled agent never consults hiddenAgents (installed branch wins).
assert.equal(isHidden({ id: "x", installed: false }, { hiddenAgents: 5, hideUninstalled: false }), false);

// ---- planLoginNotices: container input ----
for (const bad of [null, undefined, 0, "", NaN]) {
  assert.deepEqual(planLoginNotices(bad, {}, {}), { notify: [], seen: {} }, `agents=${JSON.stringify(bad)}`);
}
// Truthy non-iterables throw; a string iterates chars which have no signedIn.
for (const bad of [{}, 5, true]) {
  assert.throws(() => planLoginNotices(bad, {}, {}), TypeError, `agents=${JSON.stringify(bad)}`);
}
assert.deepEqual(planLoginNotices("ab", {}, {}), { notify: [], seen: {} });

// ---- planLoginNotices: entry input ----
// null/undefined entries crash on `a.signedIn`; primitives are skipped silently.
assert.throws(() => planLoginNotices([null], {}, {}), TypeError);
assert.throws(() => planLoginNotices([undefined], {}, {}), TypeError);
assert.deepEqual(planLoginNotices([5, "x", true], {}, {}), { notify: [], seen: {} });
// signedIn must be exactly true: truthy impostors are neither notified nor recorded.
let r = planLoginNotices([A("a", 1), A("b", "yes"), A("c", {})], { hiddenAgents: ["a", "b", "c"] }, {});
assert.deepEqual(r.notify, []);
assert.deepEqual(r.seen, {}, "truthy non-true signedIn is not recorded");
// An agent with no id is recorded under the "undefined" key — two id-less
// agents would share one memory slot.
r = planLoginNotices([{ signedIn: true, installed: true }], {}, {});
assert.deepEqual(r.seen, { undefined: true });
// Duplicate ids: the first signed-in entry notifies, the rest are suppressed.
r = planLoginNotices([A("dup", true), A("dup", true)], { hiddenAgents: ["dup"] }, {});
assert.deepEqual(ids(r.notify), ["dup"]);
assert.equal(r.seen.dup, true);
// ...and a signed-out first copy does not block a later signed-in one.
r = planLoginNotices([A("dup", false), A("dup", true)], { hiddenAgents: ["dup"] }, {});
assert.deepEqual(ids(r.notify), ["dup"]);

// ---- planLoginNotices: seen memory shapes ----
// Every non-object seen is a silent baseline, whatever the corrupt file held.
for (const seen of [null, undefined, "junk", 5, true, NaN]) {
  const out = planLoginNotices([A("amp", true)], { hiddenAgents: ["amp"] }, seen);
  assert.deepEqual(out.notify, [], `seen=${JSON.stringify(seen)} should baseline`);
  assert.deepEqual(out.seen, { amp: true });
}
// {} is a real (empty) memory, not a baseline: a hidden signed-in agent notifies.
r = planLoginNotices([A("amp", true)], { hiddenAgents: ["amp"] }, {});
assert.deepEqual(ids(r.notify), ["amp"]);
// Falsy stored values count as unseen; any truthy value counts as seen.
r = planLoginNotices([A("amp", true)], { hiddenAgents: ["amp"] }, { amp: false });
assert.deepEqual(ids(r.notify), ["amp"], "seen.amp === false is treated as never seen");
r = planLoginNotices([A("amp", true)], { hiddenAgents: ["amp"] }, { amp: "yes" });
assert.deepEqual(r.notify, [], "any truthy seen value suppresses, not just true");
// The input seen object is never mutated; the returned seen is a fresh copy.
const frozenSeen = Object.freeze({ claude: true });
r = planLoginNotices([A("amp", true)], { hiddenAgents: ["amp"] }, frozenSeen);
assert.deepEqual(r.seen, { claude: true, amp: true });
assert.notEqual(r.seen, frozenSeen);
assert.deepEqual(frozenSeen, { claude: true });
// notify holds the caller's own agent objects, not copies.
const agent = A("amp", true);
assert.strictEqual(planLoginNotices([agent], { hiddenAgents: ["amp"] }, {}).notify[0], agent);
// settings: primitives box fine and behave like {}, but null throws inside
// isHidden's destructuring — planLoginNotices does not guard it the way
// planInstallNotices guards `!settings`.
assert.throws(() => planLoginNotices([A("amp", true)], null, {}), TypeError, "null settings propagates to isHidden");
r = planLoginNotices([A("amp", true)], "junk", {});
assert.deepEqual(r.notify, [], "string settings: agent not hidden -> no notify, still recorded");
assert.equal(r.seen.amp, true);
assert.throws(() => planLoginNotices([A("amp", true)], { hiddenAgents: 5 }, {}), TypeError);
// Baseline runs never call isHidden, so a bad hiddenAgents is harmless there.
assert.deepEqual(planLoginNotices([A("amp", true)], { hiddenAgents: 5 }, null).notify, []);

// ---- planLoginNotices: BUG — a JSON-array seen file bypasses the baseline ----
// readJson() hands this module whatever JSON.parse produced. A corrupt
// agent-logins.json containing `[]` is an object, so `baseline` is false and
// the empty array spreads to an empty memory: the "first run is a silent
// baseline" guarantee (and the existing test's "corrupt seen behaves like a
// first run") does not hold for array-shaped corruption — every hidden
// signed-in agent gets a spurious notice. Not fixed here (module is out of
// scope for this job).
//
// assert.deepEqual(planLoginNotices([A("amp", true)], { hiddenAgents: ["amp"] }, []).notify, [],
//   "a corrupt [] seen file should baseline silently like other corrupt shapes");

// ---- planLoginNotices: BUG — prototype-property agent ids are never seen ----
// `next` is a plain object and the check `next[a.id]` reads inherited
// properties, so an agent whose id collides with an Object.prototype member
// ("constructor", "toString", "hasOwnProperty", "__proto__", ...) is treated
// as already-seen forever: it is never recorded in `seen` and never notified,
// on every run. Real ids come from the agent catalog so this is latent, but
// the memory should be a Map or a null-prototype object. Not fixed here.
//
// for (const id of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
//   const out = planLoginNotices([A(id, true)], { hiddenAgents: [id] }, {});
//   assert.deepEqual(out.notify.map((a) => a.id), [id], `id "${id}" should notify once`);
//   assert.equal(out.seen[id], true, `id "${id}" should be recorded`);
// }

// ---- planInstallNotices: container input ----
// prevAgents is defensively Array.isArray-checked: anything non-array means
// "no previous data" and can never throw.
for (const bad of [null, undefined, "x", {}, 5, true]) {
  assert.deepEqual(planInstallNotices(bad, [ag("a", true)], {}, {}), { notify: [], notified: {} },
    `prevAgents=${JSON.stringify(bad)}`);
}
// prev entries that are falsy or lack a truthy id are filtered out safely.
assert.deepEqual(planInstallNotices([null, 5, "x", {}, { id: "" }, { id: 0 }], [ag("a", true)], {}, {}).notify, []);
// agents container: nullish -> empty; truthy non-iterable -> TypeError; a
// string iterates chars which have no id and are skipped.
assert.deepEqual(planInstallNotices(null, null, {}, null), { notify: [], notified: {} });
assert.throws(() => planInstallNotices(null, {}, {}, {}), TypeError);
assert.throws(() => planInstallNotices(null, 5, {}, {}), TypeError);
assert.deepEqual(planInstallNotices(null, "ab", {}, {}).notify, []);
// null/undefined entries crash on `a.id`; other primitives are skipped.
assert.throws(() => planInstallNotices(null, [null], {}, {}), TypeError);
assert.throws(() => planInstallNotices(null, [undefined], {}, {}), TypeError);
assert.deepEqual(planInstallNotices(null, [5, "x", true], {}, {}).notify, []);

// ---- planInstallNotices: flip semantics ----
// The flip needs prev.installed === false exactly and current installed !==
// false: undefined/null/0/""/"false" all count as installed now.
for (const inst of [undefined, null, 0, "", "false"]) {
  const out = planInstallNotices([ag("a", false)], [{ id: "a", installed: inst }], {}, {});
  assert.deepEqual(ids(out.notify), ["a"], `current installed=${JSON.stringify(inst)} counts as installed`);
}
// Symmetrically, prev.installed must be literal false: 0/null/undefined mean
// "was installed" (or unknown) and never flip.
for (const inst of [undefined, null, 0, "", "false", true]) {
  assert.deepEqual(planInstallNotices([{ id: "a", installed: inst }], [ag("a", true)], {}, {}).notify, [],
    `prev installed=${JSON.stringify(inst)} is not an uninstalled->installed flip`);
}
// An agent absent from prev (brand new mid-run, or first run) never notifies,
// even when prev itself is non-empty.
assert.deepEqual(planInstallNotices([ag("b", true)], [ag("a", true), ag("b", true)], {}, {}).notify, []);
// Duplicate ids in prev: the Map keeps the LAST entry, so order decides.
assert.deepEqual(ids(planInstallNotices([ag("a", true), ag("a", false)], [ag("a", true)], {}, {}).notify), ["a"],
  "last prev entry wins: ...false -> flip");
assert.deepEqual(planInstallNotices([ag("a", false), ag("a", true)], [ag("a", true)], {}, {}).notify, [],
  "last prev entry wins: ...true -> no flip");
// Duplicate ids in agents: the first flip notifies, the rest are suppressed.
assert.equal(planInstallNotices([ag("a", false)], [ag("a", true), ag("a", true)], {}, {}).notify.length, 1);

// ---- planInstallNotices: settings ----
// hideUninstalled: only literal false disables it — 0/"no"/null all stay on.
for (const v of [0, "no", null, undefined]) {
  assert.deepEqual(ids(planInstallNotices([ag("a", false)], [ag("a", true)], { hideUninstalled: v }, {}).notify), ["a"],
    `hideUninstalled=${JSON.stringify(v)} still hides uninstalled`);
}
assert.deepEqual(planInstallNotices([ag("a", false)], [ag("a", true)], { hideUninstalled: false }, {}).notify, []);
assert.deepEqual(planInstallNotices([ag("a", false)], [ag("a", true)], null, {}).notify.map((x) => x.id), ["a"],
  "null settings -> hideUninstalled on");
assert.deepEqual(planInstallNotices([ag("a", false)], [ag("a", true)], "junk", {}).notify.map((x) => x.id), ["a"]);
// hiddenAgents quirks mirror isHidden: string substring-matches, non-array throws.
assert.deepEqual(planInstallNotices([ag("a", false)], [ag("a", true)], { hiddenAgents: "a" }, {}).notify, [],
  "string hiddenAgents suppresses the notice");
assert.throws(() => planInstallNotices([ag("a", false)], [ag("a", true)], { hiddenAgents: 5 }, {}), TypeError);
// A suppressed notice is NOT remembered: `notified` only records actual notifies.
const suppressed = planInstallNotices([ag("a", false)], [ag("a", true)], { hiddenAgents: ["a"] }, {});
assert.deepEqual(suppressed.notify, []);
assert.deepEqual(suppressed.notified, {}, "hidden-by-user flip is not written to memory");
// notified input: nullish/non-object -> fresh {}; the caller's object is not mutated.
for (const bad of [null, undefined, "junk", 5, true]) {
  assert.deepEqual(planInstallNotices(null, [ag("a", true)], {}, bad).notified, {}, `notified=${JSON.stringify(bad)}`);
}
const frozenNotified = Object.freeze({ other: true });
const outN = planInstallNotices([ag("a", false)], [ag("a", true)], {}, frozenNotified);
assert.deepEqual(outN.notified, { other: true, a: true });
assert.notEqual(outN.notified, frozenNotified);
assert.deepEqual(frozenNotified, { other: true });
// notify holds the caller's current agent objects.
const cur = ag("a", true);
assert.strictEqual(planInstallNotices([ag("a", false)], [cur], {}, {}).notify[0], cur);

// ---- planInstallNotices: BUG — prototype-property ids never notify ----
// `memory` is a plain object and `memory[a.id]` reads inherited properties,
// so an agent id colliding with an Object.prototype member is treated as
// already-announced on every run. Same latent class as the planLoginNotices
// bug above. Not fixed here.
//
// for (const id of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
//   const out = planInstallNotices([{ id, installed: false }], [ag(id, true)], {}, {});
//   assert.deepEqual(out.notify.map((a) => a.id), [id], `id "${id}" should announce once`);
//   assert.equal(out.notified[id], true);
// }

console.log("login-watch deep ok");
