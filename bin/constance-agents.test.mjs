import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { judge, judgeAll, launchCommand, accountEnv, preferOrder, kiloPaidVerdict, reviewText, KILO_NOTE, LAUNCH, DEVIN_FREE_UNTIL, RED } from "./constance-agents.mjs";
import { isFreeModel, pickFreeModel, kiloArgs, costCheck } from "./kilo-free.mjs";
const now = Date.UTC(2026, 10, 23, 12);
const at = { now, generatedAt: now - 60e3 };
const ag = (id, extra = {}) => ({ id, name: id, installed: true, signedIn: true, limits: [{ title: "Weekly", percent: 0.2 }], ...extra });

assert.equal(judge(ag("grok"), at).available, true, "a free agent under its limits is available");
assert.equal(judge(ag("claude"), at).available, false, "Claude is Constance herself, never a worker");
assert.equal(judge(ag("grok", { installed: false }), at).available, false);
assert.equal(judge(ag("grok", { signedIn: false }), at).reason, "sign-in needed");
assert.equal(judge(ag("grok", { cantRead: "Can't read" }), at).reason, "can't read its limits");
assert.equal(judge(ag("grok", { unsure: "old" }), at).available, false);
assert.equal(judge(ag("grok", { limits: [] }), at).reason, "reports no limits", "no reading can't prove it is under its limit");
assert.equal(judge(ag("copilot", { limits: [{ percent: 0.943 }] }), at).available, false, "Copilot at 94% is near the wall");
assert.equal(judge(ag("copilot", { limits: [{ percent: RED - 0.01 }] }), at).available, true);
assert.equal(judge(ag("cursor", { limits: [{ percent: 1, hitAt: "x" }] }), at).reason, "hit its limit");
// A blocked agent carries the fullest limit's reset time and title, so the panel can say when it frees up.
{
  const v = judge(ag("grok", { limits: [{ title: "Daily", percent: 0.4, resetsAt: "d1" }, { title: "Weekly", percent: 0.99, resetsAt: "w1" }] }), at);
  assert.equal(v.available, false); assert.equal(v.resetsAt, "w1"); assert.equal(v.blockTitle, "Weekly");
  assert.equal(judge(ag("grok"), at).resetsAt, null, "an available agent has no blocker");
}
assert.equal(judge(ag("antigravity", { limits: [{ percent: 0.1 }], accounts: [{ limits: [{ percent: 0.9 }] }] }), at).available, false, "any account's limit counts");

// ---- Multiple accounts: each login is its own source of free capacity.
const acct = (id, label, percent, extra = {}) => ({ id, label, limits: [{ title: "Weekly", percent, ...extra }] });
{
  // One account hot, one cool: she uses the cool one and names it.
  const v = judge(ag("grok", { limits: [{ percent: 0.1 }], accounts: [acct("main", "Main", 0.95), acct("work", "Work", 0.3)] }), at);
  assert.equal(v.available, true); assert.equal(v.account, "Work"); assert.equal(v.accountId, "work"); assert.equal(v.worst, 0.3);
  assert.equal(v.reason, "under its limits (fullest 30%)");
  // Both blocked: unavailable, and she names the one closest to freeing up.
  const b = judge(ag("grok", { limits: [], accounts: [acct("main", "Main", 0.9, { resetsAt: "r1" }), acct("work", "Work", 0.95)] }), at);
  assert.equal(b.available, false); assert.equal(b.account, "Main"); assert.equal(b.reason, "at 90% of a limit"); assert.equal(b.resetsAt, "r1");
  // A wall on one account doesn't hide the other account's room.
  const h = judge(ag("codex", { limits: [], accounts: [acct("a", "A", 1, { hitAt: "x" }), acct("b", "B", 0.2)] }), at);
  assert.equal(h.available, true); assert.equal(h.account, "B");
  // Every account walled: still "hit its limit", blamed on the least-bad one.
  const wall = judge(ag("codex", { limits: [], accounts: [acct("a", "A", 1, { hitAt: "x" }), acct("b", "B", 1, { hitAt: "y" })] }), at);
  assert.equal(wall.available, false); assert.equal(wall.reason, "hit its limit");
  // accounts[] entries with no readable limits fall back to the agent's own limits.
  const fb = judge(ag("grok", { limits: [{ percent: 0.2 }], accounts: [{ id: "x", label: "X", limits: [] }] }), at);
  assert.equal(fb.available, true); assert.equal(fb.account, "");
  // A single-account agent reports no account at all — unchanged shape.
  const s = judge(ag("grok"), at);
  assert.equal(s.account, ""); assert.equal(s.accountId, null); assert.equal(s.reason, "under its limits (fullest 20%)");
}

// ---- accountEnv: pin a CLI to a registered account's home, never the seated one.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acct-env-"));
  const xdg = path.join(dir, "xdg");
  const regDir = path.join(xdg, "omarchy", "agents", "accounts");
  fs.mkdirSync(regDir, { recursive: true });
  fs.writeFileSync(path.join(regDir, "grok.json"), JSON.stringify({ active: "main", accounts: [
    { id: "main", home: "/h/.grok", login: "/h/.grok", active: true },
    { id: "work", home: "/state/grok/work", login: "/state/grok/work" }] }));
  const env = { HOME: "/h", XDG_STATE_HOME: xdg };
  assert.deepEqual(accountEnv("grok", "work", env), { GROK_HOME: "/state/grok/work" }, "a non-seated account pins its own home");
  assert.deepEqual(accountEnv("grok", "main", env), {}, "the seated account needs no pin");
  assert.deepEqual(accountEnv("grok", "", env), {}, "no account picked: no pin");
  assert.deepEqual(accountEnv("grok", "ghost", env), {}, "unknown id: no pin");
  assert.deepEqual(accountEnv("copilot", "work", env), {}, "single-account providers have no homes");
  assert.deepEqual(accountEnv("grok", "work", { HOME: "/h", XDG_STATE_HOME: path.join(dir, "empty") }), {}, "no registry: no pin");
  fs.rmSync(dir, { recursive: true, force: true });
}
// The panel names the account she picked and the log does too.
{
  const qml = fs.readFileSync(new URL("../Panel.qml", import.meta.url), "utf8");
  assert.match(qml, /\(modelData\.worker \|\| root\.constanceAgentName\(modelData\.id\)\)\) \+ \(modelData\.account \? " \(" \+ modelData\.account \+ "\)" : ""\)/, "agent rows show 'Name (Account)' (or the copy's worker name)");
  assert.match(qml, /\(e\.worker \|\| constanceAgentName\(e\.agent\)\) \+ \(e\.account \? " \(" \+ e\.account \+ "\)" : ""\)/, "log lines name the worker and account too");
}
assert.equal(judge(ag("grok"), { now, generatedAt: now - 20 * 60e3 }).reason, "usage reading is out of date");
assert.equal(judge(ag("kimi"), at).reason, "no headless launch known");
// freebuff has no headless mode at all, so it gets its own honest reason, not "no headless launch known".
assert.equal(judge(ag("freebuff"), at).reason, "interactive only: no headless mode (see docs/agents-freebuff-kilo.md)");
assert.equal(judge(ag("freebuff", { installed: false }), at).reason, "not installed", "not installed still wins");
assert.equal(judge(ag("kilo"), at).available, true, "kilo is a launchable free worker");
assert.equal(judge(ag("qwen", { usageType: "byok_no_limits" }), at).available, false);
assert.equal(judge(ag("devin"), at).available, true, "Devin while SWE-2 Flash is free");
assert.match(judge(ag("devin"), { now: DEVIN_FREE_UNTIL, generatedAt: DEVIN_FREE_UNTIL }).reason, /would charge/, "Devin after its free window: skipped");
assert.equal(judgeAll({ generatedAt: now, agents: [ag("grok")] }, now)[0].available, true);

// Launches: the prompt is passed whole, Devin runs its free model, and the skip flags match bin/agent-here.sh.
for (const id of Object.keys(LAUNCH)) assert.ok(launchCommand(id, "do it; rm -rf x").includes("do it; rm -rf x"), `${id} gets the prompt as one argument`);
assert.ok(launchCommand("devin", "x").includes("swe-2-flash-medium"));
const here = fs.readFileSync(new URL("./agent-here.sh", import.meta.url), "utf8");
for (const [id, l] of Object.entries(LAUNCH)) {
  // kilo is worker-only: agent-here.sh's interactive picker doesn't know it yet.
  if (id !== "kilo") {
    const m = here.match(new RegExp(`^\\s*${l.cli.replace(/[-]/g, "\\-")}(\\|[a-z]+)?\\) echo "([^"]*)"`, "m"));
    assert.ok(m, `${id}: agent-here.sh has a skip flag for ${l.cli}`);
    assert.equal(m[2], l.skip, `${id}: same skip flag as Start`);
  }
  for (const f of l.skip.split(" ")) assert.ok(launchCommand(id, "p").includes(f), `${id} launch carries ${f}`);
}
// kilo's launch is `kilo run` pinned to the free router, prompt last, no --dir
// (the worker already runs with its worktree as cwd).
assert.deepEqual(launchCommand("kilo", "do it"), ["kilo", "run", "--format", "json", "--auto", "-m", "kilo/kilo-auto/free", "do it"]);
assert.equal(launchCommand("freebuff", "x"), null, "freebuff has no launch");
// The Devin free date is the collector's.
const collect = fs.readFileSync(new URL("./collect.mjs", import.meta.url), "utf8");
const d = collect.match(/DEVIN_FLASH_FREE_UNTIL = Date\.UTC\(([^)]*)\)/)[1].split(",").map(Number);
assert.equal(Date.UTC(...d), DEVIN_FREE_UNTIL, "same Devin free date as bin/collect.mjs");

// ---- preferOrder: freest and best-proven first; free-models-only agents win ties.
{
  const rows = [{ id: "grok" }, { id: "devin" }, { id: "kilo" }, { id: "codex" }];
  assert.deepEqual(preferOrder(rows).map((r) => r.id), ["devin", "kilo", "codex", "grok"], "free-models-only agents lead ties, then id order");
  assert.equal(rows[0].id, "grok", "preferOrder doesn't mutate its input");
  // Devin out: kilo takes the lead — that is exactly what KILO_NOTE says it is for.
  const noDevin = [{ id: "devin", available: false }, { id: "grok" }, { id: "kilo" }];
  assert.deepEqual(preferOrder(noDevin).map((r) => r.id), ["kilo", "devin", "grok"]);
  // An unavailable kilo doesn't jump ahead of available agents.
  const noKilo = [{ id: "kilo", available: false }, { id: "grok" }, { id: "devin" }];
  assert.deepEqual(preferOrder(noKilo).map((r) => r.id), ["devin", "grok", "kilo"]);
  // Bare ids and non-arrays are handled.
  assert.deepEqual(preferOrder(["grok", "devin", "amp"]).map(String), ["devin", "amp", "grok"]);
  assert.deepEqual(preferOrder(null), []);
  assert.equal(KILO_NOTE, "free models only; lowest-cost fallback");
}

// ---- preferOrder: lowest fullest-limit percent beats the free-models flag.
{
  // Devin available but nearly full loses to a freer agent — "devin full"
  // must not keep the lead just because it can't charge.
  const full = preferOrder([{ id: "devin", available: true, worst: 0.9 }, { id: "grok", available: true, worst: 0.2 }]);
  assert.deepEqual(full.map((r) => r.id), ["grok", "devin"], "the freer agent is picked over a full free-only one");
  // Devin blocked outright: same result.
  const walled = preferOrder([{ id: "devin", available: false, reason: "hit its limit", worst: 1 }, { id: "grok", available: true, worst: 0.2 }]);
  assert.deepEqual(walled.map((r) => r.id), ["grok", "devin"]);
  // Real judge() rows carry `worst`, so the same rule applies to live data.
  const judgedRows = judgeAll({ generatedAt: now - 60e3, agents: [
    ag("devin", { limits: [{ percent: 0.8 }] }),
    ag("grok", { limits: [{ percent: 0.3 }] }),
  ] }, now);
  assert.deepEqual(preferOrder(judgedRows).map((r) => r.id), ["grok", "devin"], "judge() rows rank by fullest-limit percent too");
}

// ---- preferOrder: scorecard record outranks roominess; ties break by id.
{
  const card = { agents: {
    devin: { jobs: 4, accepted: 4, sentBack: 0, tokensSum: 4000, tokensN: 4, msSum: 0, msN: 0, recent: [] },
    grok: { jobs: 4, accepted: 1, sentBack: 3, tokensSum: 4000, tokensN: 4, msSum: 0, msN: 0, recent: [] },
  }, seen: ["g1"] };
  // Grok's record is worse, so devin leads even though grok has more room.
  const proven = preferOrder([{ id: "grok", worst: 0.1 }, { id: "devin", worst: 0.7 }], card);
  assert.deepEqual(proven.map((r) => r.id), ["devin", "grok"], "scorecard record outranks lowest fullest-limit percent");
  // Same record, same room: the free-models-only agent wins the tie.
  const tied = preferOrder([{ id: "grok", worst: 0.4 }, { id: "kilo", worst: 0.4 }]);
  assert.deepEqual(tied.map((r) => r.id), ["kilo", "grok"], "freeOnly breaks an exact tie");
  // Same record and room, neither free-only: id decides, deterministically.
  const byId = preferOrder([{ id: "grok", worst: 0.4 }, { id: "codex", worst: 0.4 }, { id: "amp", worst: 0.4 }]);
  assert.deepEqual(byId.map((r) => r.id), ["amp", "codex", "grok"], "id is the final tiebreak");
  // Identical rows keep input order (the last, stable tiebreak).
  const same = preferOrder([{ id: "kilo", tag: 1 }, { id: "devin" }, { id: "kilo", tag: 2 }]);
  assert.deepEqual(same.map((r) => r.tag ?? r.id), ["devin", 1, 2]);
}

// ---- preferOrder: malformed rows never crash and never look roomier than they are.
{
  assert.deepEqual(preferOrder(null), []);
  assert.deepEqual(preferOrder({}), []);
  assert.deepEqual(preferOrder("devin"), [], "a bare string isn't a row list");
  const weird = preferOrder([null, 5, { id: "grok", worst: "junk" }, { id: "devin", worst: NaN }, { id: "codex", worst: -1 }]);
  assert.deepEqual(weird.map((r) => (r && typeof r === "object" ? r.id : r)), ["codex", "devin", null, 5, "grok"],
    "non-numeric worst reads as no reading (Infinity); id-less rows tie on \"\" and keep input order");
}

// ---- kiloPaidVerdict: fail the job on a paid model or any reported cost.
{
  assert.equal(kiloPaidVerdict('{"type":"step_finish","part":{"modelID":"kilo-auto/free","providerID":"kilo","cost":0}}\n'), null, "free model, zero cost: clean");
  assert.equal(kiloPaidVerdict("not json at all"), null);
  assert.equal(kiloPaidVerdict(""), null);
  const paid = kiloPaidVerdict('{"providerID":"openai","modelID":"gpt-5"}\n');
  assert.equal(paid.fail, true);
  assert.equal(paid.note, "kilo used a paid model or reported cost > 0: non-free model openai/gpt-5");
  const cost = kiloPaidVerdict('{"cost":0.02}\n');
  assert.equal(cost.fail, true);
  assert.match(cost.note, /^kilo used a paid model or reported cost > 0: cost 0\.02 reported$/);
}

// ---- kilo-free with real `kilo models` ids (provider-prefixed).
{
  assert.equal(isFreeModel("kilo/kilo-auto/free"), true);
  assert.equal(isFreeModel("kilo/openrouter/free"), true);
  assert.equal(isFreeModel("kilo/anthropic/claude-sonnet-4"), false, "prefixed paid id is not free");
  // pickFreeModel prefers the prefixed auto router, still accepts the bare id.
  assert.equal(pickFreeModel(["kilo/openrouter/free", "kilo/kilo-auto/free"]), "kilo/kilo-auto/free");
  assert.equal(pickFreeModel(["kilo-auto/free", "kilo/openrouter/free"]), "kilo-auto/free", "bare auto id still wins over other free models");
  assert.equal(pickFreeModel(["kilo/kilo-auto/free", "kilo-auto/free"]), "kilo/kilo-auto/free", "prefixed id preferred when both present");
  assert.equal(pickFreeModel(["kilo/anthropic/claude-sonnet-4", "kilo/openrouter/free"]), "kilo/openrouter/free");
  assert.equal(pickFreeModel(["kilo/anthropic/claude-sonnet-4", "kilo/openai/gpt-5"]), null);
  // kiloArgs pins the launch to the real prefixed id.
  assert.deepEqual(kiloArgs("do it", "kilo/kilo-auto/free"),
    ["run", "--format", "json", "--auto", "-m", "kilo/kilo-auto/free", "do it"]);
  // costCheck treats the prefixed and bare auto ids as the same free model.
  assert.equal(costCheck('{"type":"step_finish","part":{"providerID":"kilo","modelID":"kilo-auto/free","cost":0}}\n'), null);
  assert.equal(costCheck('{"type":"step_finish","part":{"modelID":"kilo-auto/free","cost":0}}\n'), null);
  assert.equal(costCheck('{"type":"step_finish","part":{"providerID":"kilo","modelID":"kilo-auto/free","cost":0.01}}\n').paid, true);
}

// ---- reviewText: freebuff gets ad-stripped, everyone else passes through.
{
  const dirty = "real output\nSponsored: try freebuff.com for more\nmore real output";
  assert.equal(reviewText("freebuff", dirty), "real output\nmore real output", "sponsor line removed");
  assert.equal(reviewText("grok", dirty), dirty, "other agents' text is untouched");
  assert.equal(reviewText("freebuff", "plain report\nwith two lines"), "plain report\nwith two lines", "ad-free freebuff text is unchanged");
}
console.log("constance-agents: tests passed");
