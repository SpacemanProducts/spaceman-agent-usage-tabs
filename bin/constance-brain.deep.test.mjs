// Deep edge-case tests for constance-brain.mjs — the cases constance-brain.test.mjs
// does not already cover: wrong-typed arguments, boundary values, case
// sensitivity, fallback ordering in brainWall, and argv shape corners.
// The module is pure (no fs, no clock reads beyond the `now` parameter, no
// shared mutable state), so there are no files to isolate and no races to
// exercise; a scratch HOME/XDG tree is still set up per the job rules and
// removed at the end.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pickBrain, BRAINS, topModel, poolOf, brainLimits, brainCommand, brainWall, milkLabel } from "./constance-brain.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "constance-brain-deep-"));
process.env.HOME = home;
process.env.XDG_STATE_HOME = path.join(home, "state");
process.env.XDG_CONFIG_HOME = path.join(home, "config");
process.env.XDG_CACHE_HOME = path.join(home, "cache");

// pickBrain: wrong-typed and oddly-cased settings.
assert.deepEqual(pickBrain(null), { id: "claude", name: "Claude Code", cli: "claude", wanted: "claude", ok: true, why: "" });
assert.deepEqual(pickBrain("antigravity"), { id: "claude", name: "Claude Code", cli: "claude", wanted: "claude", ok: true, why: "" },
  "a bare string is not a settings object");
assert.deepEqual(pickBrain(42).wanted, "claude");
assert.deepEqual(pickBrain([]).wanted, "claude");
assert.equal(pickBrain({ constanceBrain: "Antigravity" }).wanted, "claude", "the wanted value is case-sensitive");
assert.equal(pickBrain({ constanceBrain: "ANTIGRAVITY" }).wanted, "claude");
assert.equal(pickBrain({ constanceBrain: " antigravity" }).wanted, "claude", "no trimming of the setting");
assert.equal(pickBrain({ constanceBrain: "antigravity", constanceKeyringAgents: ["Antigravity"] }).ok, false,
  "keyring membership is case-sensitive too");
assert.equal(pickBrain({ constanceBrain: "antigravity", constanceKeyringAgents: ["copilot", "antigravity", "antigravity"] }).ok, true,
  "antigravity among other entries, duplicates fine");
assert.equal(pickBrain({ constanceBrain: "antigravity", constanceKeyringAgents: new Set(["antigravity"]) }).ok, false,
  "a Set is not an Array");
// Returned objects are copies: mutating one pick cannot corrupt BRAINS or later picks.
const p1 = pickBrain();
p1.id = "hacked"; p1.name = "hacked";
assert.equal(BRAINS.claude.id, "claude");
assert.equal(pickBrain().id, "claude");
assert.equal(BRAINS.claude.wanted, undefined, "pickBrain never writes wanted onto BRAINS");

// topModel: entries with missing fields, unusual states, and setting coercion.
const sparse = { models: [{ id: "only-id", state: "zero" }, { name: "Only Name", state: "used" }] };
assert.deepEqual(topModel(sparse, { constanceBrainModel: "only-id" }), { id: "only-id", name: undefined },
  "override by id works on a model with no name");
assert.deepEqual(topModel(sparse, { constanceBrainModel: "only name" }), { id: undefined, name: "Only Name" },
  "override by name works on a model with no id");
assert.deepEqual(topModel({ models: [{ name: "Mystery 9", id: "m9", state: "zero" }] }, { constanceBrainModel: "" }),
  { id: "m9", name: "Mystery 9" }, "empty-string override falls through to rank/fallback");
assert.deepEqual(topModel({ models: [{ name: "GPT-5", id: "gpt-5", state: "zero" }] }, { constanceBrainModel: 5 }),
  { id: "gpt-5", name: "GPT-5" }, "a numeric override is stringified by same()");
// Only the exact string "unavailable" is excluded; every other state is usable.
const oddStates = { models: [
  { name: "Unavailable", id: "u1", state: "Unavailable" },
  { name: " unavailable", id: "u2", state: " unavailable" },
  { name: "UNAVAILABLE", id: "u3", state: "UNAVAILABLE" },
  { name: "Real", id: "real", state: "used" },
] };
assert.deepEqual(topModel(oddStates), { id: "u1", name: "Unavailable" },
  "case/whitespace variants of 'unavailable' still count as usable (states are lowercase by producer)");
assert.deepEqual(topModel({ models: [{ name: "No State", id: "ns" }, { name: "Null State", id: "nls", state: null }] }),
  { id: "ns", name: "No State" }, "missing/null state is usable; first usable wins when nothing ranks");
// Two models matching the same rank: array order decides.
const dupRank = { models: [
  { name: "Gemini 3.8 Flash", id: "flash-b", state: "zero" },
  { name: "Gemini 3.8 Flash", id: "flash-a", state: "used" },
] };
assert.deepEqual(topModel(dupRank), { id: "flash-b", name: "Gemini 3.8 Flash" }, "first in models order wins a rank tie");
// Rank beats array order: a later-listed higher rank still wins.
const orderMatters = { models: [
  { name: "Gemini 3.8 Flash", id: "low", state: "zero" },
  { name: "Claude Sonnet 5.5", id: "high", state: "zero" },
] };
assert.deepEqual(topModel(orderMatters), { id: "high", name: "Claude Sonnet 5.5" });
// BUG: an object entry with no usable fields (e.g. {}) is "usable" (typeof object,
// state !== "unavailable"), so topModel returns { id: undefined, name: undefined }
// instead of null. Callers then see a truthy model with no name/id.
// assert.equal(topModel({ models: [{}] }), null);
// assert.equal(topModel({ models: [[]] }), null);
// BUG: same() lowercases but does not trim, so a settings.constanceBrainModel with
// stray whitespace (" claude opus 5.5 ") silently matches nothing and falls through
// to rank order instead of the owner's pick.
// const ws = { models: [{ name: "Mystery 9", id: "m9", state: "zero" }] };
// assert.deepEqual(topModel(ws, { constanceBrainModel: "  Mystery 9  " }), { id: "m9", name: "Mystery 9" });

// poolOf: anchoring, trimming, and non-string input.
assert.equal(poolOf("  Claude Opus 5.5"), "Claude/GPT", "leading whitespace is trimmed");
assert.equal(poolOf("GPT"), "Claude/GPT");
assert.equal(poolOf("gpt-oss-120b"), "Claude/GPT");
assert.equal(poolOf("MyClaude Model"), "Gemini", "the match is anchored at the start");
assert.equal(poolOf("-claude"), "Gemini", "a leading dash defeats the anchor");
assert.equal(poolOf(5), "Gemini");
assert.equal(poolOf({}), "Gemini");
assert.equal(poolOf(""), "Gemini");
assert.equal(poolOf("claude-gpt hybrid"), "Claude/GPT");

// brainLimits: brain argument variants — anything but "antigravity" reads Claude.
const d = {
  agents: [
    { id: "claude", limits: [{ title: "Session", percent: 0.1 }], unsure: false },
    { id: "antigravity", unsure: true, limits: [
      { title: "Gemini Session", percent: 0.2, resetsAt: "2030-01-01T00:00:00Z", extra: "kept" },
      { title: "Claude/GPT Session", percent: 0.3, resetsAt: "2030-01-01T01:00:00Z" },
      null, 5, "junk", {},
    ] },
  ],
};
assert.equal(brainLimits(d, null).id, "claude", "null brain -> claude");
assert.equal(brainLimits(d, {}).id, "claude", "brain without id -> claude");
assert.equal(brainLimits(d, { id: "bogus" }).id, "claude", "unknown brain id -> claude");
assert.equal(brainLimits(d, "Antigravity").id, "claude", "brain id is case-sensitive");
// agents field with wrong types is treated as empty.
assert.deepEqual(brainLimits({ agents: "junk" }, "claude"), { id: "claude", limits: [], unsure: true });
assert.deepEqual(brainLimits({ agents: 42 }, "antigravity", { name: "Gemini 4 Carbon" }), { id: "antigravity", limits: [], unsure: true });
assert.deepEqual(brainLimits({ agents: { 0: { id: "claude" } } }, "claude"), { id: "claude", limits: [], unsure: true });
// antigravity entry with a non-array limits field.
const noLimits = { agents: [{ id: "antigravity", limits: "junk", unsure: false }] };
assert.deepEqual(brainLimits(noLimits, "antigravity", { name: "Gemini 4 Carbon" }), { id: "antigravity", limits: [], unsure: false },
  "non-array limits -> empty list, unsure still passes through");
// Garbage entries inside limits are dropped, not thrown on.
const g = brainLimits(d, "antigravity", { name: "Gemini 4 Carbon" });
assert.deepEqual(g.limits.map((l) => l.title), ["Session"]);
assert.equal(g.limits[0].extra, "kept", "spread preserves fields beyond title/percent/resetsAt");
assert.equal(g.unsure, true, "unsure propagates even when limits survive");
// Title matching is exact and case-sensitive.
const tricky = { agents: [{ id: "antigravity", unsure: false, limits: [
  { title: "gemini session", percent: 0.1 },
  { title: " Gemini Session", percent: 0.1 },
  { title: "Gemini Session Extra", percent: 0.1 },
  { title: "Gemini  Session", percent: 0.1 },
  { title: "Gemini Session", percent: 0.1 },
  { title: "Gemini Session", percent: 0.2 },
] }] };
const tg = brainLimits(tricky, "antigravity", { name: "Gemini 4 Carbon" });
assert.deepEqual(tg.limits.map((l) => l.percent), [0.1, 0.2],
  "only exact 'Gemini Session' titles match; duplicates are all kept");
// Pool comes from model.name via poolOf; a bare-string model has no .name -> Gemini.
const pools = { agents: [{ id: "antigravity", unsure: false, limits: [
  { title: "Claude/GPT Session", percent: 0.5 },
  { title: "Gemini Session", percent: 0.7 },
] }] };
assert.deepEqual(brainLimits(pools, "antigravity", "Claude Opus 5.5").limits.map((l) => l.percent), [0.7],
  "a string model arg has no .name, so the Gemini pool is used");
assert.deepEqual(brainLimits(pools, "antigravity", { name: "  gpt-oss-120b" }).limits.map((l) => l.percent), [0.5],
  "poolOf trims, so a padded gpt name still picks the Claude/GPT pool");
const pools2 = { agents: [{ id: "antigravity", unsure: false, limits: [
  { title: "Claude/GPT Session", percent: 0.5 },
  { title: "Gemini Session", percent: 0.5 },
] }] };
assert.deepEqual(brainLimits(pools2, "antigravity", { name: "gpt-oss-120b" }).limits.map((l) => l.title), ["Session"],
  "gpt model -> Claude/GPT pool");
assert.deepEqual(brainLimits(pools2, "antigravity", { name: "Orchestrator Carbon" }).limits.map((l) => l.title), ["Session"],
  "orchestrator -> Gemini pool");
// unsure passes through verbatim, including non-boolean values.
const weirdUnsure = { agents: [{ id: "antigravity", unsure: "maybe", limits: [] }] };
assert.equal(brainLimits(weirdUnsure, "antigravity").unsure, "maybe");
const noUnsure = { agents: [{ id: "antigravity", limits: [] }] };
assert.equal(brainLimits(noUnsure, "antigravity").unsure, undefined);

// brainCommand: brain/model/session edge shapes.
assert.equal(brainCommand({}).cmd, "claude", "empty args -> claude defaults");
assert.equal(brainCommand({ brain: null }).cmd, "claude");
assert.equal(brainCommand({ brain: { id: "bogus" } }).cmd, "claude", "unknown brain id -> claude shape");
assert.equal(brainCommand({ brain: "Antigravity" }).cmd, "claude", "brain id is case-sensitive");
assert.deepEqual(brainCommand({ brain: "claude", model: "", role: "R", prompt: "P", session: "s" }).args[2], "opus",
  "empty-string model falls back to opus");
assert.deepEqual(brainCommand({ brain: "antigravity", model: "", role: "R", prompt: "P" }).args,
  ["--dangerously-skip-permissions", "--output-format", "text", "-p", "R\n\nP"],
  "agy omits --model for an empty-string model");
assert.deepEqual(brainCommand({ brain: "antigravity", model: 0, role: "R", prompt: "P" }).args.includes("--model"), false,
  "agy omits --model for a falsy model");
assert.ok(brainCommand({ brain: "claude", model: "m", role: "R", prompt: "P", session: "s", resume: 1 }).args.includes("--resume"),
  "any truthy resume value resumes");
assert.ok(brainCommand({ brain: "claude", model: "m", role: "R", prompt: "P", session: "s", resume: "yes" }).args.includes("--resume"));
assert.ok(!brainCommand({ brain: "claude", model: "m", role: "R", prompt: "P", session: "s", resume: 0 }).args.includes("--resume"),
  "falsy resume -> --session-id");
// BUG: brainCommand does not validate its inputs — a missing session/role/prompt
// puts literal `undefined` values into the argv array, which makes spawn() throw
// ERR_INVALID_ARG_TYPE instead of producing a runnable command.
// const bad = brainCommand({ brain: "claude", model: "m", role: "R", prompt: "P" });
// assert.ok(bad.args.every((a) => typeof a === "string"), "argv must be all strings");

// brainWall: default clock, wrong-typed limits, boundary percents and resetsAt.
const NOW = Date.parse("2030-06-01T12:00:00Z");
// Omitting `now` uses Date.now(): a far-future reset is stated, a past one is not.
{
  const before = Date.now();
  const w = brainWall("antigravity", "quota exceeded", undefined, [{ title: "S", percent: 0.9, resetsAt: new Date(Date.now() + 7200e3).toISOString() }]);
  const after = Date.now();
  assert.ok(w.until >= before + 7200e3 - 1000 && w.until <= after + 7200e3 + 1000, "default now reads the real clock");
  assert.equal(w.stated, true);
  const wPast = brainWall("antigravity", "quota exceeded", undefined, [{ title: "S", percent: 0.9, resetsAt: "2020-01-01T00:00:00Z" }]);
  assert.ok(Math.abs(wPast.until - (Date.now() + 3600e3)) < 5000, "past reset -> one-hour fallback off the real clock");
  assert.equal(wPast.stated, false);
}
// limits argument of the wrong type is treated as empty.
assert.equal(brainWall("antigravity", "quota exceeded", NOW, null).until, NOW + 3600e3);
assert.equal(brainWall("antigravity", "quota exceeded", NOW, "junk").until, NOW + 3600e3);
assert.equal(brainWall("antigravity", "quota exceeded", NOW, {}).until, NOW + 3600e3);
// percent edges: exactly 0.85 is hot; string percents coerce; junk -> 0.
const pct = (p) => brainWall("antigravity", "quota exceeded", NOW, [
  { title: "A", percent: p, resetsAt: "2030-06-01T13:00:00Z" },
  { title: "B", percent: 0.1, resetsAt: "2030-06-01T14:00:00Z" },
]).until;
assert.equal(pct(0.85), Date.parse("2030-06-01T13:00:00Z"), "0.85 is hot (>=)");
assert.equal(pct("0.9"), Date.parse("2030-06-01T13:00:00Z"), "string percent coerces");
assert.equal(pct("junk"), Date.parse("2030-06-01T13:00:00Z"), "junk percent -> 0, cool path: earliest future reset of ANY window");
assert.equal(pct(-1), Date.parse("2030-06-01T13:00:00Z"));
assert.equal(pct(1.5), Date.parse("2030-06-01T13:00:00Z"), "percent above 1 still hot");
// resetsAt edges: invalid strings, numbers, and the exact-now boundary.
const rs = (resetsAt) => brainWall("antigravity", "quota exceeded", NOW, [
  { title: "A", percent: 0.9, resetsAt },
  { title: "B", percent: 0.1, resetsAt: "2030-06-01T15:00:00Z" },
]).until;
assert.equal(rs("garbage"), Date.parse("2030-06-01T15:00:00Z"), "unparseable resetsAt is ignored");
assert.equal(rs(""), Date.parse("2030-06-01T15:00:00Z"));
assert.equal(rs(null), Date.parse("2030-06-01T15:00:00Z"));
assert.equal(rs(12345), Date.parse("2030-06-01T15:00:00Z"), "a numeric resetsAt is a 1970 timestamp -> past -> ignored");
assert.equal(rs(new Date(NOW).toISOString()), Date.parse("2030-06-01T15:00:00Z"),
  "a reset exactly at now is not > now, so it is ignored");
// Hot windows beat earlier cool windows entirely; hot windows whose resets all
// passed fall back to the earliest future reset of any window.
const hotLater = brainWall("antigravity", "quota exceeded", NOW, [
  { title: "Hot", percent: 0.9, resetsAt: "2030-06-03T00:00:00Z" },
  { title: "Cool", percent: 0.1, resetsAt: "2030-06-01T13:00:00Z" },
]);
assert.equal(hotLater.until, Date.parse("2030-06-03T00:00:00Z"), "a hot reset wins even when a cool one is sooner");
const hotPast = brainWall("antigravity", "quota exceeded", NOW, [
  { title: "Hot", percent: 0.9, resetsAt: "2020-01-01T00:00:00Z" },
  { title: "Cool", percent: 0.1, resetsAt: "2030-06-01T13:00:00Z" },
]);
assert.equal(hotPast.until, Date.parse("2030-06-01T13:00:00Z"), "hot with only past resets -> earliest future of all");
assert.equal(hotPast.stated, true);
const twoHot = brainWall("antigravity", "quota exceeded", NOW, [
  { title: "A", percent: 0.9, resetsAt: "2030-06-02T00:00:00Z" },
  { title: "B", percent: 0.95, resetsAt: "2030-06-01T13:00:00Z" },
]);
assert.equal(twoHot.until, Date.parse("2030-06-02T00:00:00Z"), "multiple hot windows -> the latest reset");
// Report matching: first matching line wins, regex case-insensitive, \b boundaries.
const firstHit = brainWall("antigravity", "note: rate limit-ish wording\nError: quota exceeded", NOW, []);
assert.equal(firstHit.text, "note: rate limit-ish wording", "the first matching line is the reported text");
assert.equal(brainWall("antigravity", "QUOTA EXCEEDED", NOW, []).text, "QUOTA EXCEEDED");
assert.equal(brainWall("antigravity", "ratelimit now", NOW, []).until, NOW + 3600e3, "rate.?limit matches with no separator");
assert.equal(brainWall("antigravity", "error 14290 happened", NOW, []), null, "\\b429\\b needs word boundaries");
assert.equal(brainWall("antigravity", "oops 429.", NOW, []).until, NOW + 3600e3, "429 followed by punctuation still matches");
assert.equal(brainWall("antigravity", "limits reached", NOW, []), null,
  "'limits reached' does not match 'limit reached' (documented regex boundary)");
assert.equal(brainWall("antigravity", "  quota exceeded  \nnext", NOW, []).text, "quota exceeded",
  "the hit line is trimmed");
assert.equal(brainWall("antigravity", "quota exceeded\r\nmore", NOW, []).text, "quota exceeded",
  "CRLF reports still match and trim the \\r");
assert.ok(brainWall("antigravity", 429, NOW, []), "a numeric report is stringified before matching");
assert.equal(brainWall("antigravity", null, NOW, []), null);
assert.equal(brainWall("antigravity", undefined, NOW, []), null);
assert.equal(brainWall("antigravity", {}, NOW, []), null, "an object report stringifies to [object Object]");
// brainWall brain id is case-sensitive like everywhere else.
assert.equal(brainWall("Antigravity", "quota exceeded", NOW, []), null,
  "'Antigravity' is not the antigravity brain; the claude path sees no Claude wall text");
assert.equal(brainWall({ id: "antigravity" }, "quota exceeded", NOW, []).until, NOW + 3600e3);

// milkLabel: only the exact id switches the label.
assert.equal(milkLabel("Antigravity"), "Milk Opus");
assert.equal(milkLabel(""), "Milk Opus");
assert.equal(milkLabel(null), "Milk Opus");
assert.equal(milkLabel({ id: "antigravity" }), "Milk Opus", "milkLabel takes an id string, not a brain object");

fs.rmSync(home, { recursive: true, force: true });
console.log("constance-brain.deep.test.mjs: all assertions passed");
