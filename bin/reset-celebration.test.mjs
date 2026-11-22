import assert from "node:assert/strict";
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { applyResets, resetNotice, resetNotifyArgs, resetAssets, SURPRISE_AGENTS, FLASH_MS } from "./reset-celebration.mjs";
const A = (id, session, extra = {}) => ({ id, name: id.toUpperCase(), installed: true, limits: [{ title: "Session", percent: session }], ...extra });

assert.deepEqual(resetNotice({ name: "Claude Code" }, ["Session"]), { title: "Claude Code session reset, go cook.", body: "\u{1F4B8} Session limit reset" });
assert.equal(resetNotice({ name: "X" }, ["Session", "Weekly"]).title, "X session and weekly reset, go cook.");
assert.equal(resetNotice({ name: "Cursor Agent" }, ["Monthly", "Auto models Monthly"]).title, "Cursor Agent monthly reset, go cook.");
assert.equal(resetNotice({ name: "Devin" }, ["Daily"]).title, "Devin daily reset, go cook.");
assert.equal(resetNotice({ name: "Codex" }, ["Weekly"]).title, "Codex weekly reset, go cook.", "the example from the spec, for any agent");
assert.equal(resetNotice({ name: "X" }, ["Session", "Weekly"]).body, "\u{1F4B8} Session and Weekly limits reset");
const args = resetNotifyArgs({ title: "T", body: "B" }, "/p/cash-burst.svg");
assert.deepEqual(args.slice(-2), ["T", "B"], "title then body last");
assert.ok(args.includes("string:image-path:/p/cash-burst.svg"), "the cash-burst picture is attached");
assert.ok(args.includes("boolean:suppress-sound:true"), "the daemon stays silent; the cha-ching is played by us");
assert.equal(resetNotifyArgs({ title: "T", body: "B" }, "").some((a) => String(a).includes("image-path")), false, "no image path, no hint");
// the bundled picture exists and is a valid SVG; the panel's test notification uses it too
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.ok(fs.readFileSync(path.join(root, "notify", "cash-burst.svg"), "utf8").startsWith("<svg"), "cash-burst.svg is bundled");
assert.ok(fs.readFileSync(path.join(root, "Panel.qml"), "utf8").includes("notify/cash-burst.svg"), "the panel's Test celebration notification uses the picture");

// A big drop: flagged, noticed once.
const sent = []; const now = 1_000_000;
let agents = [A("claude", 0.03), A("grok", 0.5)];
applyResets(agents, [A("claude", 0.95), A("grok", 0.5)], (a, w) => sent.push([a.id, w]), now);
assert.deepEqual(sent, [["claude", ["Session"]]]); assert.equal(agents[0].resetAt, now); assert.deepEqual(agents[0].resetWindows, ["Session"]); assert.equal(agents[1].resetAt, undefined);

// A refresh inside the flash keeps it alive without a second notice.
const prev = agents; agents = [A("claude", 0.04)];
applyResets(agents, prev, (a) => sent.push(a.id), now + 4000);
assert.equal(sent.length, 1); assert.equal(agents[0].resetAt, now); assert.deepEqual(agents[0].resetWindows, ["Session"]);
// After it has expired it is gone.
agents = [A("claude", 0.05)]; applyResets(agents, prev, () => sent.push("x"), now + FLASH_MS + 5001);
assert.equal(agents[0].resetAt, undefined); assert.equal(sent.length, 1);
// No previous data / junk: nothing.
agents = [A("claude", 0)]; applyResets(agents, null, () => sent.push("y"), now); assert.equal(sent.length, 1); assert.equal(agents[0].resetAt, undefined);
applyResets(null, [], () => {}); applyResets([], undefined, () => {});

// ---- the window and its size travel with the flag
const wk = [{ id: "codex", name: "Codex", limits: [{ title: "Weekly", percent: 0 }] }];
applyResets(wk, [{ id: "codex", limits: [{ title: "Weekly", percent: 0.9 }] }], () => {}, 1000);
assert.equal(wk[0].resetPhrase, "weekly"); assert.equal(wk[0].resetMagnitude, 1.25);
const se = [{ id: "codex", name: "Codex", limits: [{ title: "Session", percent: 0 }] }];
applyResets(se, [{ id: "codex", limits: [{ title: "Session", percent: 0.9 }] }], () => {}, 1000);
assert.equal(se[0].resetMagnitude, 1, "a session reset is the unchanged baseline"); assert.ok(wk[0].resetMagnitude > se[0].resetMagnitude, "weekly is the bigger win");
const mo = [{ id: "cursor", name: "Cursor Agent", limits: [{ title: "Monthly", percent: 0 }] }];
const got = []; applyResets(mo, [{ id: "cursor", limits: [{ title: "Monthly", percent: 0.95 }] }], (a, w) => got.push(w), 1000);
assert.deepEqual(got, [["Monthly"]], "a monthly meter celebrates now"); assert.equal(mo[0].resetMagnitude, 1.5);

// ---- surprise vs scheduled: two separate celebrations
const NOW2 = Date.parse("2026-11-21T12:00:00Z"); const future = (ms) => new Date(NOW2 + ms).toISOString();
const G = (id, title, pct, resetsAt) => ({ id, name: id === "antigravity" ? "Antigravity" : id.toUpperCase(), installed: true, limits: [{ title, percent: pct, resetsAt }] });
// Antigravity meter drops long before its reset time -> SURPRISE
let events = []; let ag = [G("antigravity", "Claude/GPT Weekly", 0.02, future(7 * 86400e3))];
applyResets(ag, [G("antigravity", "Claude/GPT Weekly", 0.99, future(3 * 86400e3))], (a, w, info) => events.push([a.id, w, info.kind]), NOW2);
assert.deepEqual(events, [["antigravity", ["Claude/GPT Weekly"], "surprise"]]); assert.equal(ag[0].resetKind, "surprise"); assert.equal(ag[0].resetDetails[0].surprise, true);
// Honest wording by default: we only know OUR meter dropped early
const n = resetNotice(ag[0], ["Claude/GPT Weekly"], { kind: "surprise", details: ag[0].resetDetails });
assert.equal(n.title, "Antigravity weekly reset came early, go cook."); assert.doesNotMatch(n.title + n.body, /everyone/i, "no claim about everyone without a source");
assert.match(n.body, /^\u26A1 Claude\/GPT Weekly reset early - it wasn't due until .*\. No announcement found\.$/);
// ...and only with a matching announcement may it say everyone was reset
const ann = { id: "9", source: { author: "announcer", url: "https://x.com/announcer/status/9" } };
const n2 = resetNotice(ag[0], ["Claude/GPT Weekly"], { kind: "surprise", details: ag[0].resetDetails, confirmed: ann });
assert.equal(n2.title, "Google just reset everyone's weekly limit, go cook."); assert.match(n2.body, /Announced by @announcer \(via agyresets\.com\)$/);
// a scheduled reset never gets the surprise copy, even if someone passes `confirmed`
assert.equal(resetNotice({ id: "antigravity", name: "Antigravity" }, ["Gemini Session"], { kind: "scheduled", details: [], confirmed: ann }).title, "Antigravity session reset, go cook.");
// Antigravity meter drops AFTER its reset time -> a normal, scheduled celebration
events = []; ag = [G("antigravity", "Gemini Session", 0, future(5 * 3600e3))];
applyResets(ag, [G("antigravity", "Gemini Session", 0.95, future(-60e3))], (a, w, info) => events.push(info.kind), NOW2);
assert.deepEqual(events, ["scheduled"]); assert.equal(ag[0].resetKind, "scheduled");
assert.equal(resetNotice({ id: "antigravity", name: "Antigravity" }, ["Gemini Session"], { kind: "scheduled", details: [] }).title, "Antigravity session reset, go cook.");
// Another agent's early drop (e.g. you spent a banked reset yourself) is NOT a surprise
events = []; const cl = [G("claude", "Session", 0, future(5 * 3600e3))];
applyResets(cl, [G("claude", "Session", 0.9, future(2 * 3600e3))], (a, w, info) => events.push(info.kind), NOW2);
assert.deepEqual(events, ["scheduled"], "only Antigravity has the surprise celebration");
// A scheduled and a surprise reset in one refresh: the agent counts as a surprise, the details keep both
ag = [{ id: "antigravity", name: "Antigravity", limits: [{ title: "Gemini Session", percent: 0, resetsAt: future(5 * 3600e3) }, { title: "Gemini Weekly", percent: 0, resetsAt: future(7 * 86400e3) }] }];
applyResets(ag, [{ id: "antigravity", limits: [{ title: "Gemini Session", percent: 0.9, resetsAt: future(-1000) }, { title: "Gemini Weekly", percent: 0.9, resetsAt: future(86400e3) }] }], () => {}, NOW2);
assert.equal(ag[0].resetKind, "surprise"); assert.deepEqual(ag[0].resetDetails.map((d) => d.surprise), [false, true]);
// the kind survives a refresh that lands inside the flash
const kept = [{ id: "antigravity", name: "Antigravity", limits: [] }]; applyResets(kept, ag, () => assert.fail("no second notice"), NOW2 + 4000);
assert.equal(kept[0].resetKind, "surprise");
// each kind has its own picture and sound
assert.deepEqual(resetAssets("surprise"), { image: "surprise-burst.svg", sound: "jackpot.wav" }); assert.deepEqual(resetAssets("scheduled"), { image: "cash-burst.svg", sound: "cha-ching.wav" }); assert.deepEqual(resetAssets(undefined), resetAssets("scheduled"));
assert.deepEqual(Object.keys(SURPRISE_AGENTS), ["antigravity"]);
for (const f of ["notify/surprise-burst.svg", "notify/cash-burst.svg", "sounds/jackpot.wav", "sounds/cha-ching.wav"]) assert.ok(fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", f)), `${f} is bundled`);

// WIRING GUARD: the collector must actually call the features it advertises.
// (A refactor once deleted the celebration block and nothing noticed.)
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "collect.mjs"), "utf8");
for (const needle of ["applyResets(agents, prev?.agents", "resetNotifyArgs(", "resetAssets(", "corroborate(", "resetNotice(", "playSound(SOUND_VOLUME, ", "planLoginNotices(agents", "planInstallNotices(prev?.agents", "notifyHighUsage(agents)", "diag.flush()", "planLimitsOnly(out.limits)", "buildModels({"])
  assert.ok(src.includes(needle), `collect.mjs no longer calls: ${needle}`);
console.log("reset-celebration: all tests passed");

// ---- multiple accounts: celebrations name the account that reset
{
  const mk = (s) => ({ id: "claude", name: "Claude Code", limits: [], accounts: [
    { id: "main", label: "Main", limits: [{ title: "Session", percent: 0.1, resetsAt: "" }] },
    { id: "work", label: "Work", limits: [{ title: "Session", percent: s, resetsAt: "" }] }] });
  const before = mk(0.9); before.accounts[0].limits[0].percent = 0.1;
  const now = mk(0.05); let got;
  applyResets([now], [before], (a, w, info) => { got = info; });
  assert.deepEqual(got.accounts, ["Work"], "only the account that dropped is named");
  assert.equal(resetNotice(now, ["Session"], got).title, "Claude Code (Work) session reset, go cook.");
}

// ---- once per reset: a window that already celebrated never celebrates again (flicker, restart, duplicate detection)
{
  const NOW = Date.parse("2026-11-22T10:00:00Z");
  const due = "2026-11-22T09:59:00.372911+00:00";          // the window that just ended (microseconds wobble per fetch)
  const dueWobble = "2026-11-22T09:59:01.100004+00:00";
  const mk = (percent, resetsAt) => [{ id: "claude", name: "Claude Code", limits: [{ title: "Session", percent, resetsAt }] }];
  let fired = {};
  const run = (before, after, now) => { const seen = []; applyResets(after, before, (a, w) => seen.push(w), now, fired); fired = JSON.parse(JSON.stringify(fired)); return seen; };
  assert.equal(run(mk(0.96, due), mk(0.03, "2026-11-22T15:00:00Z"), NOW).length, 1, "the reset celebrates");
  // the meter flickers back up and drops again, still describing the SAME ended window: no second celebration
  assert.equal(run(mk(0.96, dueWobble), mk(0.03, "2026-11-22T15:00:00Z"), NOW + 60000).length, 0, "same window: once");
  assert.equal(run(mk(0.96, due), mk(0.03, "2026-11-22T15:00:00Z"), NOW + 120000).length, 0, "even after a restart (state kept as JSON)");
  // the next window ends and resets 5 hours later: that is a new reset, so it celebrates once
  const next = "2026-11-22T15:00:00Z";
  assert.equal(run(mk(0.97, next), mk(0.02, "2026-11-22T20:00:00Z"), NOW + 5 * 3600000 + 60000).length, 1, "the next window's reset celebrates");
  assert.equal(run(mk(0.97, next), mk(0.02, "2026-11-22T20:00:00Z"), NOW + 5 * 3600000 + 120000).length, 0);
  // a meter with no reset time: at most one celebration an hour
  fired = {};
  const nt = (p) => [{ id: "grok", name: "Grok", limits: [{ title: "Weekly", percent: p }] }];
  assert.equal(run(nt(0.9), nt(0.05), NOW).length, 1);
  assert.equal(run(nt(0.9), nt(0.05), NOW + 10 * 60000).length, 0, "no reset time: not again within the hour");
  assert.equal(run(nt(0.9), nt(0.05), NOW + 2 * 3600000).length, 1);
}
