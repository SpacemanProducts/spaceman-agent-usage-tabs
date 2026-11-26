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

// ---- grok, codex, copilot brains ----

// BRAINS entries
assert.deepEqual(BRAINS.grok, { id: "grok", name: "Grok", cli: "grok" });
assert.deepEqual(BRAINS.codex, { id: "codex", name: "Codex", cli: "codex" });
assert.deepEqual(BRAINS.copilot, { id: "copilot", name: "Copilot", cli: "copilot" });

// pickBrain: the new ids are honored only with their opt-ins; failure falls back to claude.
assert.deepEqual(pickBrain({ constanceBrain: "grok" }), {
  id: "claude", name: "Claude Code", cli: "claude", wanted: "grok", ok: false,
  why: 'Grok would run her brain steps outside the sandbox; add "grok" to constanceBrainUnsandboxed in settings to let her brain use it. She stays on Claude Code until then.',
});
assert.deepEqual(pickBrain({ constanceBrain: "codex", constanceBrainUnsandboxed: "codex" }).ok, false,
  "a string setting is not a list");
assert.deepEqual(pickBrain({ constanceBrain: "codex", constanceBrainUnsandboxed: ["grok"] }).ok, false,
  "another agent's opt-in does not count");
assert.deepEqual(pickBrain({ constanceBrain: "codex", constanceBrainUnsandboxed: ["codex"] }), {
  id: "codex", name: "Codex", cli: "codex", wanted: "codex", ok: true, why: "",
});
assert.deepEqual(pickBrain({ constanceBrain: "grok", constanceBrainUnsandboxed: ["grok", "codex"] }), {
  id: "grok", name: "Grok", cli: "grok", wanted: "grok", ok: true, why: "",
});
// copilot needs both the keyring opt-in and the unsandboxed opt-in, keyring first.
assert.deepEqual(pickBrain({ constanceBrain: "copilot" }).why,
  'Copilot keeps its login in the desktop keyring; add "copilot" to constanceKeyringAgents in settings to let her brain use it. She stays on Claude Code until then.');
assert.equal(pickBrain({ constanceBrain: "copilot", constanceKeyringAgents: ["copilot"] }).ok, false,
  "keyring alone is not enough: the run would still be outside the sandbox");
assert.equal(pickBrain({ constanceBrain: "copilot", constanceKeyringAgents: ["copilot"], constanceBrainUnsandboxed: ["copilot"] }).ok, true);
assert.equal(pickBrain({ constanceBrain: "copilot", constanceBrainUnsandboxed: ["copilot"] }).ok, false,
  "unsandboxed alone is not enough either");
assert.equal(pickBrain({ constanceBrain: "copilot", constanceKeyringAgents: ["antigravity"], constanceBrainUnsandboxed: ["copilot"] }).ok, false,
  "antigravity's keyring opt-in does not cover copilot");
// antigravity still needs only the keyring opt-in — the unsandboxed list is not required of it.
assert.equal(pickBrain({ constanceBrain: "antigravity", constanceKeyringAgents: ["antigravity"] }).ok, true);

// topModel for the live-list brains: override first, then a flagged default/
// recommended/top model, else the first usable; unavailable never wins and no
// model name is hard-coded.
const grokAgent = {
  id: "grok",
  models: [
    { name: "grok-4.7", id: "grok-4.7", state: "zero" },
    { name: "grok-4.6", id: "grok-4.6", state: "unavailable" },
    { name: "grok-4.5", id: "grok-4.5", state: "used", recommended: true },
  ],
};
assert.deepEqual(topModel(grokAgent), { id: "grok-4.5", name: "grok-4.5" }, "flagged recommended wins over list order");
const codexAgent = {
  id: "codex",
  models: [
    { name: "gpt-5.3-codex", id: "gpt-5.3-codex", state: "used" },
    { name: "codex-mini", id: "codex-mini", state: "zero", default: true },
  ],
};
assert.deepEqual(topModel(codexAgent), { id: "codex-mini", name: "codex-mini" }, "flagged default wins");
const copilotAgent = {
  id: "copilot",
  models: [
    { name: "claude-sonnet-4.5", id: "claude-sonnet-4.5", state: "zero" },
    { name: "gpt-5", id: "gpt-5", state: "zero", top: true },
  ],
};
assert.deepEqual(topModel(copilotAgent), { id: "gpt-5", name: "gpt-5" }, "flagged top wins");
const plainList = { id: "grok", models: [
  { name: "first-model", id: "first-model", state: "zero" },
  { name: "second-model", id: "second-model", state: "used" },
] };
assert.deepEqual(topModel(plainList), { id: "first-model", name: "first-model" }, "no flags -> first listed usable");
assert.deepEqual(topModel(plainList, { constanceBrainModel: "second-model" }), { id: "second-model", name: "second-model" },
  "owner override beats the flag and the order");
assert.deepEqual(topModel({ id: "grok", models: [{ name: "Gone", id: "gone", state: "unavailable", recommended: true }] }), null,
  "a flagged but unavailable model is still unusable");
// An agent id outside the live-list set keeps the rank-then-first behavior.
assert.deepEqual(topModel({ id: "antigravity", models: [{ name: "Mystery 9", id: "m9", state: "zero", default: true }] }),
  { id: "m9", name: "Mystery 9" }, "antigravity ignores flag fields, falls to first usable");

// brainLimits: the new brains pass their own agent entry through like claude.
const liveData = { agents: [
  { id: "grok", limits: [{ title: "Session", percent: 0.3 }], unsure: false },
  { id: "codex", limits: [{ title: "Weekly", percent: 0.6 }], unsure: false },
] };
assert.equal(brainLimits(liveData, "grok"), liveData.agents[0]);
assert.equal(brainLimits(liveData, BRAINS.codex), liveData.agents[1]);
assert.deepEqual(brainLimits(liveData, "copilot"), { id: "copilot", limits: [], unsure: true });
assert.deepEqual(brainLimits({}, "grok"), { id: "grok", limits: [], unsure: true });

// brainCommand: one shape per brain, role folded into the prompt.
const gx = brainCommand({ brain: "grok", model: "grok-4.7", role: "ROLE", prompt: "do it", session: "s1", resume: true });
assert.deepEqual(gx, {
  cmd: "grok",
  args: ["--permission-mode", "bypassPermissions", "--output-format", "json", "-m", "grok-4.7", "-r", "s1", "-p", "ROLE\n\ndo it"],
});
const gxFresh = brainCommand({ brain: BRAINS.grok, role: "R", prompt: "P" });
assert.deepEqual(gxFresh.args, ["--permission-mode", "bypassPermissions", "--output-format", "json", "-p", "R\n\nP"],
  "grok omits -m and -r on a fresh model-less run");
const cx = brainCommand({ brain: "codex", model: "gpt-5.3-codex", role: "ROLE", prompt: "do it", session: "s2" });
assert.deepEqual(cx, {
  cmd: "codex",
  args: ["exec", "--dangerously-bypass-approvals-and-sandbox", "--json", "-m", "gpt-5.3-codex", "ROLE\n\ndo it"],
});
const cxResume = brainCommand({ brain: "codex", role: "R", prompt: "P", session: "s2", resume: true });
assert.deepEqual(cxResume.args, ["exec", "resume", "s2", "R\n\nP"]);
const cp = brainCommand({ brain: "copilot", model: "gpt-5", role: "ROLE", prompt: "do it", session: "s3", resume: true });
assert.deepEqual(cp, {
  cmd: "copilot",
  args: ["--allow-all", "--no-ask-user", "-s", "--model", "gpt-5", "-r", "s3", "-p", "ROLE\n\ndo it"],
});
const cpFresh = brainCommand({ brain: BRAINS.copilot, role: "R", prompt: "P" });
assert.deepEqual(cpFresh.args, ["--allow-all", "--no-ask-user", "-s", "-p", "R\n\nP"]);

// brainWall for the new brains: copilot's own limit lines, and a generic
// limit/quota line for grok and codex — same hot-reset wait logic as agy.
assert.equal(brainWall("grok", "all done, tests pass", now, []), null);
assert.equal(brainWall("copilot", "Refactored the parser.", now, []), null);
const gw = brainWall("grok", "Error: you have reached your usage limit", now, [
  { title: "Session", percent: 0.9, resetsAt: "2030-06-01T13:00:00Z" },
]);
assert.equal(gw.until, Date.parse("2030-06-01T13:00:00Z"), "grok wall takes the hot reset");
assert.equal(gw.stated, true);
assert.equal(gw.text, "Error: you have reached your usage limit");
for (const line of [
  "You've hit the rate limit for this model.",
  "You've hit your session rate limit.",
  "You've reached your weekly rate limit.",
]) {
  const w = brainWall("copilot", `some output\n${line}\nmore`, now, []);
  assert.ok(w && w.until === now + 60 * 60e3, `copilot wall on: ${line}`);
  assert.equal(w.text, line);
}
const cw2 = brainWall("codex", "stream error: quota exceeded", now, [
  { title: "Weekly", percent: 0.5, resetsAt: "2030-06-02T00:00:00Z" },
]);
assert.equal(cw2.until, Date.parse("2030-06-02T00:00:00Z"), "codex wall, no hot window -> earliest future reset");
assert.equal(cw2.stated, true);
assert.equal(brainWall("grok", "the limit is a good thing", now, []).text, "the limit is a good thing",
  "the generic matcher is line-level, like agy's");
assert.equal(brainWall(BRAINS.grok, "429 too many requests", now, []).until, now + 60 * 60e3);

// milkLabel covers every brain id.
assert.equal(milkLabel("grok"), "Milk Grok");
assert.equal(milkLabel("codex"), "Milk Codex");
assert.equal(milkLabel("copilot"), "Milk Copilot");
assert.equal(milkLabel("claude"), "Milk Opus");

console.log("constance-brain.test.mjs: all assertions passed");
