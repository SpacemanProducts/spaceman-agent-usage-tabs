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
// Three real bugs were found here, pinned as commented-out tests and now
// fixed and enabled below (negative percent reads as no projection;
// non-array agent.limits reads as no windows; openItems matches
// constance-backlog.mjs's done/job rules).
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
// A finite negative percent is impossible data, same as NaN or -Infinity:
// it can't support a projection, so leftAtReset reads it as no reading
// (null) and the agent is never offered spare room on it. (The originally
// pinned expectations — left 0.5 AND no window — couldn't both hold: with
// left 0.5 the window passes the MIN_LEFT/SOON filters. Null is the honest
// answer and matches how the other impossible percents behave.)
assert.equal(leftAtReset({ title: "Other", percent: -0.5, resetsAt: iso(now + H) }, now), null);
assert.deepEqual(spareWindows(agent("x", [{ title: "Other", percent: -0.5, resetsAt: iso(now + H) }]), now), []);

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
// A truthy non-array `limits` reads as no windows, like constance-pace.mjs's
// hardened `Array.isArray` check: sparePlan's limitsOf() can hand a string
// through when a.limits is one, and `C spare` calls planSpare unguarded, so
// one malformed agent record must not kill the command.
assert.deepEqual(spareWindows({ id: "x", limits: "junk" }, now), []);
assert.deepEqual(planSpare({ agents: [{ id: "x", limits: "junk" }], available: ["x"], backlog: [item("a", "chore")], now }).picks, []);

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

// openItems now matches constance-backlog.mjs's own openItems: any truthy
// `done` marker counts as done (so done: "yes" or a timestamp can't be
// handed out again), and only a missing job tag means untaken (job: 0 or
// any other value counts as taken).
assert.deepEqual(planSpare({ agents: [grok()], available: ["grok"], backlog: [{ ...item("a", "chore"), done: "yes" }], now }).picks, []);
assert.deepEqual(planSpare({ agents: [grok()], available: ["grok"], backlog: [{ ...item("a", "chore"), job: 0 }], now }).picks, []);

// ------------------------------------------------- leftAtReset: more coercion
// A primitive limit argument has no readable fields: null, like every other
// unreadable input, rather than a throw.
assert.equal(leftAtReset("junk", now), null);
assert.equal(leftAtReset(5, now), null);
assert.equal(leftAtReset(true, now), null);
// An Invalid Date object stringifies to "Invalid Date": unparseable, so null.
assert.equal(leftAtReset({ title: "Other", percent: 0.2, resetsAt: new Date(NaN) }, now), null);
// percent 0 is a real reading: nothing used, so (flat-projected) everything is
// left — a fully-unused window with a soon reset IS spare room.
assert.equal(leftAtReset(lim("Other", 0, H), now), 1);
assert.equal(spareWindows(agent("x", [lim("Other", 0, H)]), now).length, 1, "0% used, reset soon: the whole window is spare");
// -0 is not < 0, so it reads as a real 0% reading like +0.
assert.equal(leftAtReset(lim("Other", -0, H), now), 1);
// Coercion quirks pinned: booleans and numeric strings both go through Number().
assert.equal(leftAtReset({ title: "Other", percent: true, resetsAt: iso(now + H) }, now), 0, "percent true coerces to 1: fully used, nothing left");
assert.equal(leftAtReset({ title: "Other", percent: "0.5", resetsAt: iso(now + H) }, now), 0.5);
// A Weekly window whose reset is farther out than the 7 d window itself gets
// the flat projection (elapsed share is negative, so the burn rate can't be
// carried) — same rule as Session at exactly 5 h, tested above.
assert.equal(leftAtReset(lim("Weekly", 0.4, 8 * D), now), 0.6, "weekly reset beyond the window length: flat");
// Infinity percent is not finite: no projection, same as NaN.
assert.equal(leftAtReset(lim("Other", Infinity, H), now), null);

// ------------------------------------------------- spareWindows: more edges
// Title matching is case-sensitive: "session" is not "Session", so it falls
// back to DEFAULT_SOON (6 h) — a 2 h reset counts where "Session" would not.
assert.equal(spareWindows(agent("x", [lim("session", 0.2, 2 * H)]), now).length, 1,
  "lowercase 'session' gets DEFAULT_SOON, not SOON.Session");
assert.equal(spareWindows(agent("x", [lim("SESSION", 0.2, 2 * H)]), now).length, 1);
assert.equal(spareWindows(agent("x", [lim("session", 0.2, 7 * H)]), now).length, 0, "...but still bounded by DEFAULT_SOON");
// Junk entries inside the limits array are skipped like nulls.
assert.deepEqual(spareWindows(agent("x", ["junk", 42, lim("Session", 0.2, 0.5 * H)]), now).map((w) => w.title), ["Session"]);
// A non-array `limits` that is an object (not just a string) also reads empty.
assert.deepEqual(spareWindows({ id: "x", limits: { 0: lim("Session", 0.2, 0.5 * H) } }, now), []);
// Windows with identical resetsAt keep their input order (stable sort).
const tie = spareWindows(agent("x", [
  lim("Other", 0.2, H), lim("Session", 0.2, H),
]), now);
assert.deepEqual(tie.map((w) => w.title), ["Other", "Session"], "equal resetsAt: input order preserved");
// The wall check looks at EVERY limit, including ones that could never be
// spare themselves (reset far out, no percent, unparseable resetsAt).
assert.equal(spareWindows(agent("x", [
  lim("Session", 0.2, 0.5 * H),
  { title: "Weekly", percent: 0.9 }, // no resetsAt: can't project, still walls
]), now).length, 0, "a near-wall limit with no resetsAt still poisons the agent");
assert.equal(spareWindows(agent("x", [
  lim("Session", 0.2, 0.5 * H),
  { title: "Weekly", percent: "0.9", resetsAt: "garbage" },
]), now).length, 0, "...and so does one with an unparseable resetsAt");
// A window exactly at MIN_LEFT via the flat projection is offered; the same
// window one ms closer to its reset still is (flat doesn't depend on `now`),
// pinning that MIN_LEFT is the only level gate for unknown titles.
assert.equal(spareWindows(agent("x", [lim("Other", 0.75, H - 1)]), now).length, 1);

// ------------------------------------------------------------- planSpare: more
// No arguments at all: defaults make it a well-formed "nothing to do" answer.
r = planSpare();
assert.deepEqual(r, { on: true, picks: [], reason: "no agent has room it would lose before a reset" });
// The off switch is checked before anything else: malformed agents/backlog
// can't make the disabled path throw.
r = planSpare({ agents: "junk", available: 5, backlog: {}, settings: { constanceUseItOrLoseIt: false }, now });
assert.deepEqual(r, { on: false, picks: [], reason: "use it or lose it is off" });
// `available` only needs to be iterable for `new Set`: a Set works.
r = planSpare({ agents: [grok()], available: new Set(["grok"]), backlog: [item("a", "chore")], now });
assert.equal(r.picks[0]?.agent, "grok", "a Set of ids works as available");
// A bare string is iterable too, but iterates characters: "grok" becomes a
// set of letters and the agent is silently not served. Pinned as-is.
r = planSpare({ agents: [grok()], available: "grok", backlog: [item("a", "chore")], now });
assert.equal(r.reason, "no agent has room it would lose before a reset", "available: 'grok' (string) matches nothing");
// Null/undefined agent entries are skipped without throwing.
r = planSpare({ agents: [null, undefined, grok()], available: ["grok"], backlog: [item("a", "chore")], now });
assert.deepEqual(r.picks.map((p) => p.agent), ["grok"]);
// Backlog entries that aren't objects, and items whose text isn't a non-blank
// string, are not open items.
r = planSpare({ agents: [grok()], available: ["grok"], now, backlog: [
  null, "junk", 42,
  { id: "n", kind: "chore", text: 42 },
  { id: "u", kind: "chore" }, // no text key at all
  item("ok", "chore"),
] });
assert.deepEqual(r.picks[0].items.map((i) => i.id), ["ok"]);
// Kind matching is exact-case: "Review"/"Design" are not opus kinds, so a
// worker takes them and Claude gets nothing.
r = planSpare({ agents: [claude(), grok()], available: ["grok"], perAgent: 10, now,
  backlog: [item("R", "Review"), item("D", "Design")] });
assert.deepEqual(r.picks.find((p) => p.agent === "grok")?.items.map((i) => i.id), ["R", "D"],
  "a worker takes both: capitalized kinds aren't opus work for anyone");
// perAgent NaN blocks everything (taken.length < NaN is never true);
// Infinity hands over the agent's whole matching share.
r = planSpare({ agents: [grok()], available: ["grok"], backlog: threeChores, perAgent: NaN, now });
assert.deepEqual(r.picks, []);
r = planSpare({ agents: [grok()], available: ["grok"], backlog: threeChores, perAgent: Infinity, now });
assert.equal(r.picks[0].items.length, 3);
// Claude's scan continues past non-opus items until she fills her cap: with
// perAgent 2 and chores interleaved she still finds both opus items.
r = planSpare({ agents: [claude()], available: [], perAgent: 2, now,
  backlog: [item("c1", "chore"), item("v1", "review"), item("c2", "chore"), item("b1", "bug"), item("v2", "review")] });
assert.deepEqual(r.picks[0].items.map((i) => i.id), ["v1", "b1"], "cap counts taken items, not scanned ones");
// Distinct backlog entries are never deduplicated by content: two items with
// the same kind/text/id still both get handed out.
r = planSpare({ agents: [grok()], available: ["grok"], perAgent: 10, now,
  backlog: [item("dup", "chore", "same text"), item("dup", "chore", "same text")] });
assert.equal(r.picks[0].items.length, 2, "no content-based dedup");
// `job` uses loose == null: undefined counts as untaken (open), while any
// other falsy-but-present tag ("", false, 0) counts as taken. Pinned to match
// the comment's "null or absent means untaken" rule.
r = planSpare({ agents: [grok()], available: ["grok"], now, backlog: [
  { ...item("u", "chore"), job: undefined },
  { ...item("e", "chore"), job: "" },
  { ...item("f", "chore"), job: false },
] });
assert.deepEqual(r.picks[0].items.map((i) => i.id), ["u"], "job: undefined is open; '' and false are taken");
// Omitting `now` uses Date.now(): an 'Other' window flattens its projection so
// the result doesn't depend on the exact clock reading.
r = planSpare({
  agents: [agent("grok", [{ title: "Other", percent: 0.2, resetsAt: iso(Date.now() + 30 * 60e3) }])],
  available: ["grok"], backlog: [item("a", "chore")] });
assert.equal(r.picks[0]?.agent, "grok", "default now = Date.now()");
// Claude at the wall gets nothing even though she never needs `available`.
r = planSpare({ agents: [agent("claude", [lim("Session", 0.9, 0.5 * H)])], available: [], backlog: [item("rev", "review")], now });
assert.equal(r.reason, "no agent has room it would lose before a reset", "a walled claude is skipped like anyone");

console.log("constance-spare.deep: tests passed");
