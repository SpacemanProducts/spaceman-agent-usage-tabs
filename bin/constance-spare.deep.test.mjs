// Deeper edge-case pass for bin/constance-spare.mjs, on top of
// constance-spare.test.mjs (which covers the headline left-at-reset math,
// the soon/min-left/wall filters and the basic planSpare hand-outs).
//
// Everything here is pure: leftAtReset(), spareWindows(), planSpare() and
// useItOrLoseItOn() do no I/O, `now` is fixed, and no agent, bus or network
// is touched. Sections: leftAtReset coercion/boundaries -> spareWindows
// boundaries and malformed limits -> useItOrLoseItOn truthiness ->
// planSpare ordering, caps, kinds and malformed inputs.
//
// Two real bugs were found and are pinned as commented-out tests at the
// bottom (non-array agent.limits crashes; a negative percent reports more
// than 100% left). A third inconsistency (truthy non-true `done` still
// counts as open here while constance-backlog.mjs treats any truthy done
// as done) is noted there too.
import assert from "node:assert/strict";
import { leftAtReset, spareWindows, useItOrLoseItOn, planSpare, SOON, DEFAULT_SOON, MIN_LEFT, OPUS_KINDS } from "./constance-spare.mjs";

const now = Date.UTC(2026, 10, 25, 12);
const H = 3600e3, D = 86400e3;
const iso = (ms) => new Date(ms).toISOString();
const lim = (title, used, resetsIn) => ({ title, percent: used, resetsAt: iso(now + resetsIn) });
const agent = (id, limits) => ({ id, limits });
const item = (id, kind, text = `do ${id}`) => ({ id, kind, text, files: [], done: false });

// ------------------------------------------------- leftAtReset: coercion and edges
// A numeric-string percent is still a number (same coercion the pace tests pin).
assert.equal(leftAtReset(lim("Session", "0.5", H), now), 0.375);
assert.equal(leftAtReset({ title: "Other", percent: "junk", resetsAt: iso(now + H) }, now), null, "non-numeric percent");
assert.equal(leftAtReset({ title: "Other", percent: NaN, resetsAt: iso(now + H) }, now), null);
// resetsAt accepts anything Date can parse from its string form: ISO strings
// and Date objects work; a bare epoch-ms number does NOT (String(123) is not
// a date string), and neither do junk strings.
assert.equal(leftAtReset({ title: "Other", percent: 0.2, resetsAt: new Date(now + H) }, now), 0.8);
assert.equal(leftAtReset({ title: "Other", percent: 0.2, resetsAt: now + H }, now), null, "ms-number resetsAt is unparseable");
assert.equal(leftAtReset({ title: "Other", percent: 0.2, resetsAt: "next tuesday-ish" }, now), null);
// Exactly at the reset is already over: resetsAt <= now -> null, not 1.
assert.equal(leftAtReset(lim("Other", 0.2, 0), now), null, "reset exactly now");
// Over-full readings clamp to zero left rather than going negative.
assert.equal(leftAtReset(lim("Other", 1.4, H), now), 0, "percent over 1 still projects past full");
assert.equal(leftAtReset(lim("Session", 1, H), now), 0);
// A brand-new window (reset a full window-length away) has elapsed 0, so the
// flat projection applies — the same as an unknown title.
assert.equal(leftAtReset(lim("Session", 0.5, 5 * H), now), 0.5, "exactly one window length left: no elapsed share");
// One ms inside that, the elapsed share is 1 ms and the carried burn rate
// projects the window to full: the discontinuity is the formula, pinned here.
assert.equal(leftAtReset(lim("Session", 0.5, 5 * H - 1), now), 0);
// Weekly burn-rate check: 7 d window, 6 d elapsed, 1 d left, 50% used ->
// projected 0.5 + 0.5/6 = 0.5833 used -> ~0.4167 left.
const wl = leftAtReset(lim("Weekly", 0.5, D), now);
assert.ok(Math.abs(wl - (1 - (0.5 + 0.5 / 6))) < 1e-12, `weekly projection, got ${wl}`);
// left is always within [0, 1] for sane percents in [0, 1].
for (const p of [0, 0.001, 0.5, 0.999, 1]) {
  const l = leftAtReset(lim("Other", p, H), now);
  assert.ok(l >= 0 && l <= 1, `percent ${p} -> left ${l}`);
}
// BUG (pinned, not fixed): a finite negative percent projects negative use,
// so `left` comes back above 1 — an impossible "more than everything left" —
// and spareWindows then offers the agent spare room with left = 1.5.
// leftAtReset should clamp the projection to [0, 1] like it clamps the top.
// assert.equal(leftAtReset({ title: "Other", percent: -0.5, resetsAt: iso(now + H) }, now), 0.5);
// assert.deepEqual(spareWindows(agent("x", [{ title: "Other", percent: -0.5, resetsAt: iso(now + H) }]), now), []);

// ------------------------------------------------- spareWindows: boundaries
// SOON is inclusive on both ends of each title's allowance.
assert.equal(spareWindows(agent("x", [lim("Session", 0.2, H)]), now).length, 1, "session reset exactly SOON.Session out still counts");
assert.equal(spareWindows(agent("x", [lim("Session", 0.2, H + 1)]), now).length, 0, "1 ms past it does not");
assert.equal(spareWindows(agent("x", [lim("Weekly", 0.2, 24 * H)]), now).length, 1, "weekly reset exactly SOON.Weekly out counts");
assert.equal(spareWindows(agent("x", [lim("Weekly", 0.2, 24 * H + 1)]), now).length, 0);
assert.equal(spareWindows(agent("x", [lim("Other", 0.2, 6 * H)]), now).length, 1, "unlisted title exactly DEFAULT_SOON out counts");
assert.equal(spareWindows(agent("x", [lim("Other", 0.2, 6 * H + 1)]), now).length, 0);
// MIN_LEFT is inclusive: flat-projected 'Other' windows sit exactly on it.
assert.equal(spareWindows(agent("x", [lim("Other", 0.75, H)]), now).length, 1, "exactly MIN_LEFT left still counts");
assert.equal(spareWindows(agent("x", [lim("Other", 0.750001, H)]), now).length, 0, "a hair under does not");
// The 85% wall line is inclusive; a hair under it is not a wall.
assert.equal(spareWindows(agent("x", [lim("Session", 0.2, 0.5 * H), lim("Other", 0.85, 2 * D)]), now).length, 0,
  "a limit at exactly 85% poisons the agent even far from its own reset");
assert.equal(spareWindows(agent("x", [lim("Session", 0.2, 0.5 * H), lim("Other", 0.849, 2 * D)]), now).length, 1);
// The wall check coerces like the rest: a numeric-string percent still walls.
assert.equal(spareWindows(agent("x", [lim("Session", 0.2, 0.5 * H), { title: "Other", percent: "0.9", resetsAt: iso(now + D) }]), now).length, 0,
  "percent '0.9' as a string still counts as near the wall");
// Non-finite percents fail safe: +Infinity reads as a wall (>= 0.85), and
// -Infinity/NaN produce no projection, so neither can offer spare room.
assert.equal(spareWindows(agent("x", [lim("Session", 0.2, 0.5 * H), { title: "Other", percent: Infinity, resetsAt: iso(now + D) }]), now).length, 0);
assert.equal(spareWindows(agent("x", [{ title: "Other", percent: -Infinity, resetsAt: iso(now + H) }]), now).length, 0);
assert.equal(spareWindows(agent("x", [{ title: "Other", percent: NaN, resetsAt: iso(now + H) }]), now).length, 0);
// Malformed limit entries are skipped, not fatal: nulls and junk percent
// strings just never produce a window.
assert.deepEqual(spareWindows(agent("x", [null, lim("Session", 0.2, 0.5 * H)]), now).map((w) => w.title), ["Session"]);
assert.equal(spareWindows(agent("x", [null]), now).length, 0);
assert.equal(spareWindows(agent("x", []), now).length, 0);
assert.equal(spareWindows({}, now).length, 0, "no limits key");
assert.equal(spareWindows(null, now).length, 0);
assert.equal(spareWindows(agent("x"), now).length, 0, "undefined limits");
// The window keeps the agent id verbatim, even a missing one.
assert.equal(spareWindows({ limits: [lim("Session", 0.2, 0.5 * H)] }, now)[0].agent, undefined);
// Several spare windows on one agent come back soonest-reset first.
const multi = spareWindows(agent("x", [lim("Weekly", 0.2, 20 * H), lim("Other", 0.2, H), lim("Session", 0.2, 0.5 * H)]), now);
assert.deepEqual(multi.map((w) => w.title), ["Session", "Other", "Weekly"]);
// BUG (pinned, not fixed): a truthy non-array `limits` throws
// "limits.some is not a function". constance-pace.mjs was hardened against
// exactly this ("a non-array limits value reads as no windows"); sparePlan's
// limitsOf() can hand a string through when a.limits is one, and `C spare`
// calls sparePlan unguarded, so one malformed agent record kills the command.
// assert.deepEqual(spareWindows({ id: "x", limits: "junk" }, now), []);
// assert.deepEqual(planSpare({ agents: [{ id: "x", limits: "junk" }], available: ["x"], backlog: [item("a", "chore")], now }).picks, []);

// ------------------------------------------------- useItOrLoseItOn truthiness
// Only the literal `false` turns it off; every other falsy value stays on.
assert.equal(useItOrLoseItOn({ constanceUseItOrLoseIt: false }), false);
for (const v of [undefined, null, 0, "", "false", 1]) {
  assert.equal(useItOrLoseItOn({ constanceUseItOrLoseIt: v }), true, `value ${JSON.stringify(v)} stays on`);
}
assert.equal(useItOrLoseItOn(null), true);
assert.equal(useItOrLoseItOn("nope"), true, "a non-object settings value can't turn it off");

// ------------------------------------------------------------- planSpare: deeper
const grok = () => agent("grok", [lim("Session", 0.2, 0.5 * H)]);
const claude = () => agent("claude", [lim("Session", 0.3, 0.4 * H)]);
const otherSpare = () => agent("other", [lim("Other", 0.2, 0.5 * H)]); // DEFAULT_SOON window

// Reason strings: singular vs plural item count, agent (window) naming.
let r = planSpare({ agents: [grok()], available: ["grok"], backlog: [item("a", "chore")], now });
assert.equal(r.reason, "1 backlog item goes to spare room that would be lost: grok (Session).");
r = planSpare({
  agents: [claude(), grok()], available: ["grok"], perAgent: 10, now,
  backlog: [item("r1", "review"), item("r2", "review"), item("c1", "chore"), item("c2", "chore"), item("c3", "chore")] });
assert.equal(r.reason, "5 backlog items go to spare room that would be lost: claude (Session), grok (Session).");
// A pick's window carries only title/resetsAt/left — the agent and used
// level stay on the pick itself.
assert.deepEqual(Object.keys(r.picks[0].window).sort(), ["left", "resetsAt", "title"]);
assert.equal(r.picks[0].window.left, spareWindows(claude(), now)[0].left);

// Claude is always eligible (she is Constance, not a judged worker): an
// empty `available` list doesn't exclude her, and a differently-cased id
// gets no such pass.
r = planSpare({ agents: [claude()], available: [], backlog: [item("rev", "review")], now });
assert.equal(r.picks[0]?.agent, "claude", "claude needs no available slot");
r = planSpare({ agents: [agent("Claude", [lim("Session", 0.3, 0.4 * H)])], available: [], backlog: [item("rev", "review")], now });
assert.equal(r.picks.length, 0, "'Claude' is not the special id: without available it isn't served");
r = planSpare({ agents: [agent("Claude", [lim("Session", 0.3, 0.4 * H)])], available: ["Claude"], backlog: [item("rev", "review"), item("ch", "chore")], perAgent: 10, now });
assert.equal(r.picks[0]?.agent, "Claude", "...but listed as available it is served like any worker");
assert.deepEqual(r.picks[0].items.map((i) => i.id), ["ch"], "and like any worker it can't take opus-kind work");

// An item with no `kind` (or an unknown one) is not opus work: workers take it.
r = planSpare({ agents: [claude(), grok()], available: ["grok"], perAgent: 10, now,
  backlog: [item("k", undefined, "kindless"), { id: "u", text: "unknown kind", kind: "mystery" }] });
assert.deepEqual(r.picks.find((p) => p.agent === "grok")?.items.map((i) => i.id), ["k", "u"]);
assert.equal(r.picks.find((p) => p.agent === "claude"), undefined, "claude got nothing: no opus-kind items");

// Agents are served soonest-reset first regardless of kind: make the worker's
// reset the earlier one and it is picked first, taking only non-opus items.
r = planSpare({
  agents: [agent("grok", [lim("Session", 0.2, 0.2 * H)]), claude()], available: ["grok"], perAgent: 10, now,
  backlog: [item("c", "chore"), item("v", "review")] });
assert.equal(r.picks[0].agent, "grok");
assert.deepEqual(r.picks[0].items.map((i) => i.id), ["c"], "the worker can't take the review even though it's next in line");
assert.equal(r.picks[1].agent, "claude");
assert.deepEqual(r.picks[1].items.map((i) => i.id), ["v"]);

// perAgent edges: 0 or negative hands out nothing (and reports the backlog
// reason, which is misleading — there IS open work, just no allowance); a
// fractional cap rounds up because the check is `taken.length < perAgent`.
const threeChores = [item("a", "chore"), item("b", "chore"), item("c", "chore")];
r = planSpare({ agents: [grok()], available: ["grok"], backlog: threeChores, perAgent: 0, now });
assert.deepEqual(r.picks, []);
assert.equal(r.reason, "nothing worthwhile in the backlog, so the spare room is left alone");
r = planSpare({ agents: [grok()], available: ["grok"], backlog: threeChores, perAgent: -2, now });
assert.deepEqual(r.picks, []);
r = planSpare({ agents: [grok()], available: ["grok"], backlog: threeChores, perAgent: 1.5, now });
assert.equal(r.picks[0].items.length, 2, "perAgent 1.5 allows two items");
r = planSpare({ agents: [grok()], available: ["grok"], backlog: threeChores, perAgent: "2", now });
assert.equal(r.picks[0].items.length, 2, "a numeric-string perAgent coerces");

// The same agent listed twice is served twice: two pick entries with the
// same agent/window key (startSpareGoal's `used` dedup only helps across
// runs, so one plan can hand the same agent two batches). Pinned as-is.
r = planSpare({ agents: [grok(), grok()], available: ["grok"], backlog: threeChores, perAgent: 2, now });
assert.equal(r.picks.length, 2);
assert.deepEqual(r.picks.map((p) => p.items.map((i) => i.id)), [["a", "b"], ["c"]]);

// planSpare doesn't mutate its inputs: the backlog keeps its order and the
// same item objects come back inside picks.
const backlog = [item("z", "chore"), { ...item("y", "review"), done: true }, item("x", "bug")];
const snapshot = JSON.parse(JSON.stringify(backlog));
r = planSpare({ agents: [claude(), grok()], available: ["grok"], perAgent: 10, now, backlog });
assert.deepEqual(backlog, snapshot, "backlog array untouched");
assert.equal(r.picks.flatMap((p) => p.items).includes(backlog[0]), true, "pick items are the same objects");

// `available` ids that match no agent are simply unused; agents without a
// spare window are skipped even when listed.
r = planSpare({ agents: [grok(), agent("idle", [lim("Session", 0.9, 0.5 * H)])], available: ["grok", "ghost"], backlog: [item("a", "chore")], now });
assert.deepEqual(r.picks.map((p) => p.agent), ["grok"]);

// Non-array containers throw today (pinned, arguably should read as empty):
// `agents` needs .map, `available` needs to be iterable for `new Set`,
// `backlog` needs .filter — but only once a candidate exists does backlog
// get touched, so an agent-less plan never reaches it.
assert.throws(() => planSpare({ agents: "junk", available: [], backlog: [], now }), TypeError);
assert.throws(() => planSpare({ agents: [], available: 5, backlog: [], now }), TypeError);
assert.throws(() => planSpare({ agents: [grok()], available: ["grok"], backlog: "junk", now }), TypeError);
assert.throws(() => planSpare({ agents: [grok()], available: ["grok"], backlog: {}, now }), TypeError);
// Note: `available: 5` throws even with zero agents because `new Set(available)`
// runs before the candidate check, so the 'no agent' reason is unreachable on
// that path. Internal callers always pass arrays, so this is malformed-input only.

// BUG (pinned, not fixed): openItems uses `b.done !== true`, so any truthy
// done marker that isn't the literal `true` — done: 1, done: "yes", a
// timestamp — still counts as open work and can be handed out again.
// constance-backlog.mjs's own openItems uses `!x.done` (any truthy done is
// done), so the two disagree on the same record. Same story for `job`:
// `!b.job` treats job: 0 as untaken while the backlog module's `x.job ===
// null` treats only null as untaken.
// assert.deepEqual(planSpare({ agents: [grok()], available: ["grok"], backlog: [{ ...item("a", "chore"), done: "yes" }], now }).picks, []);
// assert.deepEqual(planSpare({ agents: [grok()], available: ["grok"], backlog: [{ ...item("a", "chore"), job: 0 }], now }).picks, []);

console.log("constance-spare.deep: tests passed");
