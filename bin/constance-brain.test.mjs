// constance-brain: which CLI runs her planning brain, which agy model, the pool-filtered
// limits pace() reads, both command shapes, both wall paths, and the milk label.
import assert from "node:assert/strict";
import { BRAINS, pickBrain, AGY_RANK, topModel, poolOf, brainLimits, brainCommand, brainWall, milkLabel } from "./constance-brain.mjs";

// BRAINS
assert.deepEqual(BRAINS.claude, { id: "claude", name: "Claude Code", cli: "claude" });
assert.deepEqual(BRAINS.antigravity, { id: "antigravity", name: "Antigravity", cli: "agy" });

// pickBrain: default and unknown stay on Claude; antigravity needs the keyring opt-in.
const claudePick = { id: "claude", name: "Claude Code", cli: "claude", wanted: "claude", ok: true, why: "" };
assert.deepEqual(pickBrain(), claudePick);
assert.deepEqual(pickBrain({}), claudePick);
assert.deepEqual(pickBrain({ constanceBrain: "claude" }), claudePick);
assert.deepEqual(pickBrain({ constanceBrain: "bogus" }), claudePick);
assert.deepEqual(pickBrain({ constanceBrain: "antigravity" }), {
  id: "claude", name: "Claude Code", cli: "claude", wanted: "antigravity", ok: false,
  why: 'Antigravity keeps its login in the desktop keyring; add "antigravity" to constanceKeyringAgents in settings to let her brain use it. She stays on Claude Code until then.',
});
assert.deepEqual(pickBrain({ constanceBrain: "antigravity", constanceKeyringAgents: ["copilot"] }).ok, false);
assert.deepEqual(pickBrain({ constanceBrain: "antigravity", constanceKeyringAgents: "antigravity" }).ok, false);
assert.deepEqual(pickBrain({ constanceBrain: "antigravity", constanceKeyringAgents: ["antigravity"] }), {
  id: "antigravity", name: "Antigravity", cli: "agy", wanted: "antigravity", ok: true, why: "",
});

// topModel: override by id and by name (case-insensitive), ignored when unavailable;
// rank order; fallback to first usable; null on garbage.
const agent = {
  id: "antigravity",
  models: [
    { name: "Gemini 4 Carbon", id: "gemini-4-carbon", state: "zero" },
    { name: "Claude Opus 5.5", id: "claude-opus-5-5", state: "unavailable" },
    { name: "Claude Sonnet 5.5", id: "claude-sonnet-5-5", state: "used" },
    { name: "Orchestrator Carbon", id: "orchestrator-carbon", state: "zero" },
  ],
};
assert.deepEqual(topModel(agent), { id: "gemini-4-carbon", name: "Gemini 4 Carbon" },
  "rank skips the unavailable Opus 5.5 and lands on Gemini 4 Carbon");
const noCarbon = { models: agent.models.filter((m) => !/carbon/i.test(m.name)) };
assert.deepEqual(topModel(noCarbon), { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  "with both Carbons gone the next ranked usable model wins");
assert.equal(AGY_RANK[0], "Claude Opus 5.5");
assert.deepEqual(topModel(agent, { constanceBrainModel: "claude-sonnet-5-5" }), { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }, "override by id");
assert.deepEqual(topModel(agent, { constanceBrainModel: "gemini 4 carbon" }), { id: "gemini-4-carbon", name: "Gemini 4 Carbon" }, "override by name, case-insensitive");
assert.deepEqual(topModel(agent, { constanceBrainModel: "Claude Opus 5.5" }), { id: "gemini-4-carbon", name: "Gemini 4 Carbon" },
  "override naming an unavailable model is ignored, rank decides");
assert.deepEqual(topModel(agent, { constanceBrainModel: "no-such-model" }), { id: "gemini-4-carbon", name: "Gemini 4 Carbon" },
  "unknown override falls through to rank");
const unranked = { models: [{ name: "Mystery 9", id: "mystery-9", state: "zero" }, { name: "Gone", id: "gone", state: "unavailable" }] };
assert.deepEqual(topModel(unranked), { id: "mystery-9", name: "Mystery 9" }, "fallback: first usable when nothing ranks");
assert.equal(topModel({ models: [{ name: "Gone", id: "gone", state: "unavailable" }] }), null, "all unavailable -> null");
assert.equal(topModel(null), null);
assert.equal(topModel({}), null);
assert.equal(topModel({ models: "junk" }), null);
assert.equal(topModel({ models: [null, 3, "x"] }), null, "garbage entries never throw");

// poolOf
assert.equal(poolOf("Claude Opus 5.5"), "Claude/GPT");
assert.equal(poolOf("claude sonnet 4.6"), "Claude/GPT");
assert.equal(poolOf("GPT-5"), "Claude/GPT");
assert.equal(poolOf("gpt-oss-120b"), "Claude/GPT");
assert.equal(poolOf("Gemini 4 Carbon"), "Gemini");
assert.equal(poolOf("Orchestrator Carbon"), "Gemini");
assert.equal(poolOf(null), "Gemini");

// brainLimits: claude passes its entry through; missing -> unsure empty.
const data = {
  agents: [
    { id: "claude", limits: [{ title: "Session", percent: 0.5, resetsAt: "2030-01-01T00:00:00Z" }], unsure: false },
    {
      id: "antigravity", unsure: false,
      limits: [
        { title: "Gemini Session", percent: 0.2, resetsAt: "2030-01-01T05:00:00Z" },
        { title: "Gemini Weekly", percent: 0.4, resetsAt: "2030-01-08T00:00:00Z" },
        { title: "Claude/GPT Session", percent: 0.9, resetsAt: "2030-01-01T06:00:00Z" },
        { title: "Claude/GPT Weekly", percent: 0.3, resetsAt: "2030-01-08T01:00:00Z" },
        { title: "Other Thing", percent: 0.1, resetsAt: "2030-01-01T07:00:00Z" },
      ],
    },
  ],
};
const claudeLimits = brainLimits(data, "claude");
assert.equal(claudeLimits, data.agents[0], "claude entry returned unchanged");
assert.deepEqual(brainLimits({}, "claude"), { id: "claude", limits: [], unsure: true });
assert.deepEqual(brainLimits(null, BRAINS.claude), { id: "claude", limits: [], unsure: true });

const geminiModel = { id: "gemini-4-carbon", name: "Gemini 4 Carbon" };
const g = brainLimits(data, "antigravity", geminiModel);
assert.equal(g.id, "antigravity");
assert.equal(g.unsure, false);
assert.deepEqual(g.limits.map((l) => l.title), ["Session", "Weekly"], "Gemini pool only, renamed");
assert.equal(g.limits[0].percent, 0.2);
assert.equal(g.limits[0].resetsAt, "2030-01-01T05:00:00Z");

const claudeModel = { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" };
const c = brainLimits(data, BRAINS.antigravity, claudeModel);
assert.deepEqual(c.limits.map((l) => [l.title, l.percent]), [["Session", 0.9], ["Weekly", 0.3]], "Claude/GPT pool only");

const noModel = brainLimits(data, "antigravity", null);
assert.deepEqual(noModel.limits.map((l) => l.title), ["Session", "Weekly"], "null model -> Gemini pool");
assert.deepEqual(brainLimits({}, "antigravity", claudeModel), { id: "antigravity", limits: [], unsure: true });
assert.deepEqual(brainLimits({ agents: [] }, "antigravity"), { id: "antigravity", limits: [], unsure: true });
// No mutation: the source limits keep their pool titles.
assert.equal(data.agents[1].limits[0].title, "Gemini Session");
assert.equal(data.agents[1].limits[2].title, "Claude/GPT Session");

// brainCommand: both shapes.
const cc = brainCommand({ brain: "claude", model: "sonnet", role: "ROLE", prompt: "do it", session: "sess-1" });
assert.deepEqual(cc, {
  cmd: "claude",
  args: ["-p", "--model", "sonnet", "--dangerously-skip-permissions", "--output-format", "text",
    "--append-system-prompt", "ROLE", "--session-id", "sess-1", "do it"],
});
const ccResume = brainCommand({ brain: BRAINS.claude, model: null, role: "R", prompt: "P", session: "s9", resume: true });
assert.deepEqual(ccResume.args.slice(0, 4), ["-p", "--model", "opus", "--dangerously-skip-permissions"]);
assert.deepEqual(ccResume.args.slice(-3), ["--resume", "s9", "P"]);
const agy = brainCommand({ brain: "antigravity", model: "claude-sonnet-5-5", role: "ROLE", prompt: "do it", session: "ignored", resume: true });
assert.deepEqual(agy, {
  cmd: "agy",
  args: ["--dangerously-skip-permissions", "--output-format", "text", "--model", "claude-sonnet-5-5", "-p", "ROLE\n\ndo it"],
});
const agyNoModel = brainCommand({ brain: BRAINS.antigravity, role: "R", prompt: "P" });
assert.deepEqual(agyNoModel.args, ["--dangerously-skip-permissions", "--output-format", "text", "-p", "R\n\nP"]);

// brainWall claude: delegates to limitWall.
const now = Date.parse("2030-06-01T12:00:00Z");
assert.equal(brainWall("claude", "all fine", now), null);
const cw = brainWall("claude", "You've hit your 5-hour limit · resets 1pm (UTC)", now);
assert.ok(cw && cw.stated === true && cw.until > now);
assert.match(cw.text, /hit your 5-hour limit/);

// brainWall antigravity: non-match -> null; match with a hot reset -> stated, latest future wins.
assert.equal(brainWall("antigravity", "done, tests pass", now, []), null);
const agyLimits = [
  { title: "Session", percent: 0.9, resetsAt: "2030-06-01T13:00:00Z" },
  { title: "Weekly", percent: 0.5, resetsAt: "2030-06-05T00:00:00Z" },
];
const w1 = brainWall("antigravity", "Error: quota exceeded for this model", now, agyLimits);
assert.equal(w1.until, Date.parse("2030-06-01T13:00:00Z"), "hot (>=0.85) reset is stated");
assert.equal(w1.stated, true);
assert.equal(w1.text, "Error: quota exceeded for this model");
const w2 = brainWall("antigravity", "rate limit reached, try later", now, [
  { title: "Session", percent: 0.4, resetsAt: "2030-06-01T14:00:00Z" },
  { title: "Weekly", percent: 0.5, resetsAt: "2030-06-02T00:00:00Z" },
]);
assert.equal(w2.until, Date.parse("2030-06-01T14:00:00Z"), "no hot window -> earliest future reset");
assert.equal(w2.stated, true);
const w3 = brainWall("antigravity", "HTTP 429 too many requests", now, [
  { title: "Session", percent: 0.4, resetsAt: "2029-01-01T00:00:00Z" },
  { title: "Weekly", percent: 0.5 },
]);
assert.equal(w3.until, now + 60 * 60e3, "no future reset -> one hour, unstated");
assert.equal(w3.stated, false);
const w4 = brainWall("antigravity", "usage limit\nsecond line", now, []);
assert.equal(w4.text, "usage limit");
const long = brainWall("antigravity", `limit reached ${"x".repeat(300)}`, now, []);
assert.equal(long.text.length, 200, "text capped at 200 chars");
const w5 = brainWall(BRAINS.antigravity, "resource exhausted", now, []);
assert.equal(w5.until, now + 60 * 60e3, "object brain arg works, unstated fallback");

// milkLabel
assert.equal(milkLabel("claude"), "Milk Opus");
assert.equal(milkLabel("antigravity"), "Milk Antigravity");
assert.equal(milkLabel("bogus"), "Milk Opus");

console.log("constance-brain.test.mjs: all assertions passed");
