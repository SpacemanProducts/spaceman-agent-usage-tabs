// Deeper edge-case tests for bin/constance-agents.mjs: boundaries, malformed
// inputs, precedence and coercion. Same style as constance-agents.test.mjs:
// plain asserts, mktemp state, injected clocks — never the real bus/network.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { judge, judgeAll, launchCommand, accountEnv, preferOrder, kiloPaidVerdict, reviewText, LAUNCH, DEVIN_FREE_UNTIL, FRESH_MS, RED } from "./constance-agents.mjs";

const now = Date.UTC(2026, 10, 25, 12);
const at = { now, generatedAt: now - 60e3 };
const ag = (id, extra = {}) => ({ id, name: id, installed: true, signedIn: true, limits: [{ title: "Weekly", percent: 0.2 }], ...extra });

// ---- Reason precedence: the first failing rule wins, in this order.
{
  // claude loses to nothing, not even "not installed".
  assert.equal(judge(ag("claude", { installed: false }), at).reason, "Constance herself (the paid plan)");
  // "not installed" is checked before "no headless launch known".
  assert.equal(judge(ag("kimi", { installed: false }), at).reason, "not installed");
  assert.equal(judge(ag("kimi"), at).reason, "no headless launch known");
  // sandbox refusal beats byok / devin-free / sign-in / staleness.
  const boxed = { sandbox: () => "bwrap missing" };
  assert.equal(judge(ag("grok", { usageType: "byok_no_limits", signedIn: false }), { ...at, ...boxed }).reason, "can't run sandboxed: bwrap missing");
  assert.equal(judge(ag("devin", { signedIn: false }), { now: DEVIN_FREE_UNTIL + 1, generatedAt: DEVIN_FREE_UNTIL + 1, sandbox: () => "no bwrap" }).reason, "can't run sandboxed: no bwrap");
  // byok beats the devin free-window check and every reading check.
  const byokDevin = judge(ag("devin", { usageType: "byok_no_limits", signedIn: false, cantRead: "x", unsure: "y", limits: [] }), { now: DEVIN_FREE_UNTIL + 1, generatedAt: DEVIN_FREE_UNTIL + 1 - FRESH_MS });
  assert.equal(byokDevin.reason, "bring-your-own-key: would charge");
  // devin's free-window end beats sign-in / cantRead / unsure / staleness.
  const lateDevin = judge(ag("devin", { signedIn: false, cantRead: "x", unsure: "y" }), { now: DEVIN_FREE_UNTIL + 1, generatedAt: now - 60e3 });
  assert.equal(lateDevin.reason, "free SWE-2 Flash window ended: would charge");
  // sign-in beats cantRead beats unsure beats staleness beats "no limits".
  assert.equal(judge(ag("grok", { signedIn: false, cantRead: "x" }), { now, generatedAt: now - 20 * 60e3 }).reason, "sign-in needed");
  assert.equal(judge(ag("grok", { cantRead: "x", unsure: "y" }), at).reason, "can't read its limits");
  assert.equal(judge(ag("grok", { unsure: "y", limits: [] }), { now, generatedAt: now - 20 * 60e3 }).reason, "reading is unsure");
  assert.equal(judge(ag("grok", { limits: [] }), { now, generatedAt: now - 20 * 60e3 }).reason, "usage reading is out of date", "staleness beats an empty limits list");
  // Only the exact string "byok_no_limits" is a BYOK agent.
  assert.equal(judge(ag("qwen", { usageType: "byok" }), at).available, false, "other usageTypes aren't BYOK — but qwen has no launch anyway");
  assert.equal(judge(ag("grok", { usageType: "byok_no_limits_extra" }), at).available, true, "near-miss usageType strings pass");
}

// ---- Freshness boundary: strictly less than FRESH_MS old.
{
  const fresh = ag("grok");
  assert.equal(judge(fresh, { now, generatedAt: now - FRESH_MS + 1 }).available, true, "1ms inside the window is fresh");
  assert.equal(judge(fresh, { now, generatedAt: now - FRESH_MS }).reason, "usage reading is out of date", "exactly FRESH_MS old is stale");
  assert.equal(judge(fresh, { now, generatedAt: now }).available, true, "generatedAt == now is fresh");
  // A reading stamped in the future is stale, not fresh (regression test
  // below); this assert only pins the boundary at exactly `now`.
}

// ---- installed / signedIn are strict === false checks: anything else passes.
{
  assert.equal(judge(ag("grok", { installed: undefined }), at).available, true, "missing installed flag is treated as installed");
  assert.equal(judge(ag("grok", { signedIn: undefined }), at).available, true, "missing signedIn flag is treated as signed in");
  assert.equal(judge(ag("grok", { installed: 0, signedIn: 0 }), at).available, true, "falsy-but-not-false flags pass");
  assert.equal(judge(ag("grok", { cantRead: "" }), at).available, true, "empty cantRead string is not a blocker");
  assert.equal(judge(ag("grok", { unsure: "" }), at).available, true, "empty unsure string is not a blocker");
  // name falls back to id.
  assert.equal(judge({ id: "grok", installed: true, signedIn: true, limits: [{ percent: 0.1 }] }, at).name, "grok");
}

// ---- RED boundary and hit semantics.
{
  assert.equal(judge(ag("grok", { limits: [{ percent: RED }] }), at).available, false, "exactly RED is blocked");
  assert.equal(judge(ag("grok", { limits: [{ percent: RED }] }), at).reason, `at ${Math.round(RED * 100)}% of a limit`);
  // percent 1 without hitAt is a fullest-limit block, not a wall hit.
  const noHit = judge(ag("cursor", { limits: [{ percent: 1, title: "W", resetsAt: "r" }] }), at);
  assert.equal(noHit.reason, "at 100% of a limit"); assert.equal(noHit.resetsAt, "r"); assert.equal(noHit.blockTitle, "W");
  // hitAt with percent < 1 is not a hit; the RED rule still blocks it.
  const lowHit = judge(ag("cursor", { limits: [{ percent: 0.99, hitAt: "x" }] }), at);
  assert.equal(lowHit.reason, "at 99% of a limit");
  // hitAt that is falsy doesn't count even at percent 1.
  assert.equal(judge(ag("cursor", { limits: [{ percent: 1, hitAt: "" }] }), at).reason, "at 100% of a limit");
  // percent above 1 with hitAt is a hit.
  assert.equal(judge(ag("cursor", { limits: [{ percent: 1.2, hitAt: "x" }] }), at).reason, "hit its limit");
  // The first hit-style limit wins when several qualify.
  const two = judge(ag("cursor", { limits: [{ percent: 1, hitAt: "a", title: "A", resetsAt: "ra" }, { percent: 1, hitAt: "b", title: "B", resetsAt: "rb" }] }), at);
  assert.equal(two.resetsAt, "ra"); assert.equal(two.blockTitle, "A");
  // Fullest-limit block blames the max percent limit, not the first.
  const full = judge(ag("grok", { limits: [{ percent: 0.5, title: "Low" }, { percent: 0.95, title: "High", resetsAt: "rh" }] }), at);
  assert.equal(full.blockTitle, "High"); assert.equal(full.resetsAt, "rh");
  // Equal percents: the first fullest limit is blamed.
  const tie = judge(ag("grok", { limits: [{ percent: 0.95, title: "First" }, { percent: 0.95, title: "Second" }] }), at);
  assert.equal(tie.blockTitle, "First");
  // A hit anywhere in the limits makes it a hit, even if another limit is fuller.
  const hitVsFull = judge(ag("grok", { limits: [{ percent: 0.99, title: "Big" }, { percent: 1, hitAt: "x", title: "Wall", resetsAt: "rw" }] }), at);
  assert.equal(hitVsFull.reason, "hit its limit"); assert.equal(hitVsFull.blockTitle, "Wall"); assert.equal(hitVsFull.resetsAt, "rw");
}

// ---- Percent coercion: Number() accepts strings and booleans.
{
  assert.equal(judge(ag("grok", { limits: [{ percent: "0.9" }] }), at).available, false, "numeric string percent counts");
  assert.equal(judge(ag("grok", { limits: [{ percent: "abc" }] }), at).reason, "reports no limits", "non-numeric string percent is unreadable");
  assert.equal(judge(ag("grok", { limits: [{ percent: true }] }), at).reason, "at 100% of a limit", "true coerces to 1");
  assert.equal(judge(ag("grok", { limits: [{ percent: null }] }), at).reason, "reports no limits", "null percent is no reading at all");
  assert.equal(judge(ag("grok", { limits: [{ percent: 0 }] }), at).available, true, "a real 0% limit is available");
  // A source survives if ANY of its limits is readable; unreadable ones drop out.
  const mixed = judge(ag("grok", { limits: [{ percent: "junk" }, { percent: 0.4 }] }), at);
  assert.equal(mixed.available, true); assert.equal(mixed.worst, 0.4);
  // Limits entries that are null/false/0 are skipped, not crashed on.
  const holes = judge(ag("grok", { limits: [null, false, 0, { percent: 0.3 }] }), at);
  assert.equal(holes.available, true); assert.equal(holes.worst, 0.3);
}

// ---- accounts[]: mix of readable and unreadable entries, and the a.limits fallback.
{
  const acct = (id, label, limits, extra = {}) => ({ id, label, limits, ...extra });
  // One readable account + one unreadable: only the readable one is a source.
  const v = judge(ag("grok", { limits: [{ percent: 0.1 }], accounts: [acct("bad", "Bad", []), acct("good", "Good", [{ percent: 0.4 }])] }), at);
  assert.equal(v.available, true); assert.equal(v.account, "Good"); assert.equal(v.accountId, "good");
  // accounts[] with a readable entry means a.limits is ignored entirely.
  const ignore = judge(ag("grok", { limits: [{ percent: 0.05 }], accounts: [acct("hot", "Hot", [{ percent: 0.97 }])] }), at);
  assert.equal(ignore.available, false); assert.equal(ignore.reason, "at 97% of a limit");
  // All accounts unreadable -> falls back to the agent's own limits.
  const fb = judge(ag("grok", { limits: [{ percent: 0.2 }], accounts: [acct("x", "X", [{ percent: "nan" }]), acct("y", "Y", null)] }), at);
  assert.equal(fb.available, true); assert.equal(fb.account, "");
  // accounts: [] (empty array) also falls back.
  const empty = judge(ag("grok", { limits: [{ percent: 0.2 }], accounts: [] }), at);
  assert.equal(empty.available, true);
  // An account entry with no id/label still works; id "" -> accountId null.
  const anon = judge(ag("grok", { limits: [], accounts: [{ limits: [{ percent: 0.5 }] }] }), at);
  assert.equal(anon.available, true); assert.equal(anon.account, ""); assert.equal(anon.accountId, null);
  // A blocked pick names the account and carries its blocker fields. When every
  // source is blocked she names the least-bad one — here Main's wall ties Work's
  // at worst=1 and the earlier account wins the tie.
  const blk = judge(ag("grok", { limits: [], accounts: [acct("m", "Main", [{ percent: 1, hitAt: "x", title: "Week", resetsAt: "rw" }]), acct("w", "Work", [{ percent: 1, hitAt: "y" }])] }), at);
  assert.equal(blk.available, false); assert.equal(blk.reason, "hit its limit"); assert.equal(blk.account, "Main"); assert.equal(blk.resetsAt, "rw");
  // The least-bad rule: a 90% account is named over a walled one.
  const least = judge(ag("grok", { limits: [], accounts: [acct("m", "Main", [{ percent: 1, hitAt: "x" }]), acct("w", "Work", [{ percent: 0.9 }])] }), at);
  assert.equal(least.available, false); assert.equal(least.account, "Work"); assert.equal(least.reason, "at 90% of a limit");
  // Open sources are ranked by lowest worst; a tie keeps the earlier account.
  const tie2 = judge(ag("grok", { limits: [], accounts: [acct("a", "A", [{ percent: 0.3 }]), acct("b", "B", [{ percent: 0.3 }])] }), at);
  assert.equal(tie2.accountId, "a");
  // A source whose fullest limit lacks resetsAt reports null, not a crash.
  const noReset = judge(ag("grok", { limits: [{ percent: 0.95 }] }), at);
  assert.equal(noReset.resetsAt, null); assert.equal(noReset.blockTitle, null);
}

// ---- sandbox option.
{
  const calls = [];
  const spy = (id) => { calls.push(id); return ""; };
  judge(ag("grok"), { ...at, sandbox: spy });
  assert.deepEqual(calls, ["grok"], "sandbox is consulted with the agent id");
  judge(ag("claude"), { ...at, sandbox: spy });
  assert.equal(calls.length, 1, "claude never reaches the sandbox check");
  judge(ag("kimi"), { ...at, sandbox: spy });
  assert.equal(calls.length, 1, "an agent with no launch never reaches the sandbox check");
  assert.equal(judge(ag("grok"), { ...at, sandbox: () => 0 }).available, true, "falsy sandbox result means it can be boxed");
  assert.equal(judge(ag("grok"), { ...at, sandbox: () => "no" }).reason, "can't run sandboxed: no");
}

// ---- Devin free window boundary.
{
  assert.equal(judge(ag("devin"), { now: DEVIN_FREE_UNTIL - 1, generatedAt: DEVIN_FREE_UNTIL - 1 }).available, true, "1ms before the window ends Devin is free");
  assert.equal(judge(ag("devin"), { now: DEVIN_FREE_UNTIL, generatedAt: DEVIN_FREE_UNTIL }).available, false, "at the instant it ends Devin would charge");
  assert.equal(judge(ag("devin"), { now: DEVIN_FREE_UNTIL + 1, generatedAt: DEVIN_FREE_UNTIL + 1 }).reason, "free SWE-2 Flash window ended: would charge");
  // Other agents are unaffected by the Devin date.
  assert.equal(judge(ag("grok"), { now: DEVIN_FREE_UNTIL + 1e9, generatedAt: DEVIN_FREE_UNTIL + 1e9 }).available, true);
}

// ---- judgeAll: shape coercion and per-agent isolation.
{
  assert.deepEqual(judgeAll(null, now), []);
  assert.deepEqual(judgeAll(undefined, now), []);
  assert.deepEqual(judgeAll({}, now), [], "missing agents -> empty list");
  assert.deepEqual(judgeAll({ generatedAt: now }, now), [], "missing agents key -> empty list");
  // generatedAt is Number()-coerced: a numeric string works, junk reads as 0 (stale).
  const r = judgeAll({ generatedAt: String(now - 60e3), agents: [ag("grok")] }, now);
  assert.equal(r[0].available, true, "string generatedAt is coerced");
  const junk = judgeAll({ generatedAt: "not-a-date", agents: [ag("grok")] }, now);
  assert.equal(junk[0].reason, "usage reading is out of date", "NaN generatedAt -> 0 -> stale");
  const zero = judgeAll({ generatedAt: 0, agents: [ag("grok")] }, now);
  assert.equal(zero[0].reason, "usage reading is out of date", "generatedAt 0 -> stale");
  // Order is preserved and one bad agent doesn't sink the rest (each is judged alone).
  const many = judgeAll({ generatedAt: now - 60e3, agents: [ag("kimi"), ag("grok"), ag("claude")] }, now);
  assert.deepEqual(many.map((x) => x.id), ["kimi", "grok", "claude"]);
  assert.equal(many[1].available, true);
  // judgeAll forwards `now` and `sandbox` to every judge call.
  const boxed = judgeAll({ generatedAt: now - 60e3, agents: [ag("grok"), ag("devin")] }, now, { sandbox: (id) => (id === "devin" ? "no devin box" : "") });
  assert.equal(boxed[0].available, true);
  assert.equal(boxed[1].reason, "can't run sandboxed: no devin box");
}

// ---- launchCommand edges.
{
  assert.equal(launchCommand("claude", "x"), null, "claude has no worker launch");
  assert.equal(launchCommand("kimi", "x"), null, "unknown agents have no launch");
  assert.equal(launchCommand("nope", "x"), null);
  // Every launch ends with the prompt as the final argument.
  for (const id of Object.keys(LAUNCH)) {
    const cmd = launchCommand(id, "PROMPT");
    assert.equal(cmd[cmd.length - 1], "PROMPT", `${id} prompt is last`);
    assert.equal(typeof cmd[0], "string");
  }
  // grok's permission flag is a single "--permission-mode bypassPermissions" pair.
  assert.ok(launchCommand("grok", "p").includes("bypassPermissions"));
}

// ---- accountEnv: registry shapes, ~ expansion, seated detection.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acctenv-deep-"));
  const xdg = path.join(dir, "xdg");
  const regDir = path.join(xdg, "omarchy", "agents", "accounts");
  fs.mkdirSync(regDir, { recursive: true });
  const env = { HOME: "/h", XDG_STATE_HOME: xdg };
  const grokFile = path.join(regDir, "grok.json");
  const write = (obj) => fs.writeFileSync(grokFile, typeof obj === "string" ? obj : JSON.stringify(obj));

  // Missing file, bad JSON, non-object JSON -> {}.
  assert.deepEqual(accountEnv("grok", "w", env), {}, "no registry file");
  write("{not json");
  assert.deepEqual(accountEnv("grok", "w", env), {}, "unparseable registry");
  write("42");
  assert.deepEqual(accountEnv("grok", "w", env), {}, "registry that isn't an object");
  write({});
  assert.deepEqual(accountEnv("grok", "w", env), {}, "registry without accounts");
  // Registry path that is a directory -> read fails -> {}.
  fs.rmSync(grokFile, { force: true });
  fs.mkdirSync(grokFile);
  assert.deepEqual(accountEnv("grok", "w", env), {}, "registry path is a directory");
  fs.rmSync(grokFile, { recursive: true });

  // login beats home; ~ expands against env.HOME.
  write({ accounts: [{ id: "w", home: "/home-path", login: "~/logins/w" }] });
  assert.deepEqual(accountEnv("grok", "w", env), { GROK_HOME: "/h/logins/w" }, "login wins over home, ~ expands");
  write({ accounts: [{ id: "w", home: "~/only-home" }] });
  assert.deepEqual(accountEnv("grok", "w", env), { GROK_HOME: "/h/only-home" }, "home used when login absent");
  // Only a leading ~ is special; "~user/x" collapses oddly but deterministically.
  write({ accounts: [{ id: "w", home: "~other/x" }] });
  assert.deepEqual(accountEnv("grok", "w", env), { GROK_HOME: "/hother/x" });
  // Seated detection normalizes dot segments and trailing slashes.
  write({ accounts: [{ id: "s", home: "/h/.grok/../.grok/" }] });
  assert.deepEqual(accountEnv("grok", "s", env), {}, "dot-dot path resolving to the seated home needs no pin");
  write({ accounts: [{ id: "s", home: "/h/.grok/" }] });
  assert.deepEqual(accountEnv("grok", "s", env), {}, "trailing slash still matches the seated home");
  // A different-but-similar path is NOT the seated home.
  write({ accounts: [{ id: "s", home: "/h/.grok2" }] });
  assert.deepEqual(accountEnv("grok", "s", env), { GROK_HOME: "/h/.grok2" });
  write({ accounts: [{ id: "s", home: "/h/.GROK" }] });
  assert.deepEqual(accountEnv("grok", "s", env), { GROK_HOME: "/h/.GROK" }, "case-sensitive compare");
  // First matching id wins.
  write({ accounts: [{ id: "w", home: "/first" }, { id: "w", home: "/second" }] });
  assert.deepEqual(accountEnv("grok", "w", env), { GROK_HOME: "/first" });
  // Strict id match: "1" !== 1.
  write({ accounts: [{ id: 1, home: "/num" }] });
  assert.deepEqual(accountEnv("grok", "1", env), {}, "string '1' doesn't match numeric id 1");
  assert.deepEqual(accountEnv("grok", 1, env), { GROK_HOME: "/num" }, "numeric accountId matches");
  // Null/primitive account entries are skipped safely.
  write({ accounts: [null, 5, "x", { id: "w", home: "/ok" }] });
  assert.deepEqual(accountEnv("grok", "w", env), { GROK_HOME: "/ok" }, "junk entries don't crash the scan");
  // Non-string home is String()-coerced then resolved (against cwd when relative).
  write({ accounts: [{ id: "w", home: 42 }] });
  assert.deepEqual(accountEnv("grok", "w", env), { GROK_HOME: path.resolve("42") });
  write({ accounts: [{ id: "w", home: "rel/dir" }] });
  assert.deepEqual(accountEnv("grok", "w", env), { GROK_HOME: path.resolve("rel/dir") }, "relative homes resolve against the process cwd");
  // Falsy accountId variants all mean "no pin".
  for (const bad of ["", null, undefined, 0]) assert.deepEqual(accountEnv("grok", bad, env), {}, `accountId ${JSON.stringify(bad)} -> {}`);
  // Agents without a registered home spec get {} even with a matching registry.
  fs.writeFileSync(path.join(regDir, "copilot.json"), JSON.stringify({ accounts: [{ id: "w", home: "/x" }] }));
  assert.deepEqual(accountEnv("copilot", "w", env), {});
  assert.deepEqual(accountEnv("devin", "w", env), {});
  assert.deepEqual(accountEnv("cursor", "w", env), {});
  // XDG_STATE_HOME unset -> HOME/.local/state.
  const home2 = path.join(dir, "home2");
  const rd2 = path.join(home2, ".local/state", "omarchy", "agents", "accounts");
  fs.mkdirSync(rd2, { recursive: true });
  fs.writeFileSync(path.join(rd2, "codex.json"), JSON.stringify({ accounts: [{ id: "c", home: "/cxhome" }] }));
  assert.deepEqual(accountEnv("codex", "c", { HOME: home2 }), { CODEX_HOME: "/cxhome" }, "falls back to HOME/.local/state");
  // HOME unset -> os.homedir() for ~ expansion and the seated compare; XDG still rules the file.
  write({ accounts: [{ id: "w", home: "~" }] });
  const noHome = accountEnv("grok", "w", { XDG_STATE_HOME: xdg });
  assert.deepEqual(noHome, { GROK_HOME: os.homedir() }, "~ with no HOME expands to os.homedir()");
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- launchCommand: argument shape per agent.
{
  const grok = launchCommand("grok", "p");
  assert.deepEqual(grok.slice(0, 3), ["grok", "--permission-mode", "bypassPermissions"]);
  const codex = launchCommand("codex", "p");
  assert.deepEqual(codex.slice(0, 2), ["codex", "exec"]);
  const cursor = launchCommand("cursor", "p");
  assert.ok(cursor.includes("--yolo") && cursor.includes("--trust"));
  const devin = launchCommand("devin", "p");
  assert.ok(devin.includes("swe-2-flash-medium") && devin.includes("dangerous"));
  // Prompt is never split: a prompt with spaces/semicolons stays one element.
  const tricky = launchCommand("antigravity", "a b; rm -rf ~ `x`");
  assert.equal(tricky[tricky.length - 1], "a b; rm -rf ~ `x`");
}

// ============================================================================
// REGRESSION TESTS — bugs found in review, fixed in constance-agents.mjs.
// Malformed input must make an agent unavailable, never available, and must
// never crash the judgeAll -> panel path.
// ============================================================================

// judge() doesn't throw on malformed agent records.
{
  assert.doesNotThrow(() => judge(null, at));
  assert.equal(judge(null, at).available, false, "a null record is unavailable");
  assert.doesNotThrow(() => judge(ag("grok", { accounts: {} }), at));
  assert.equal(judge(ag("grok", { accounts: {} }), at).available, true, "a non-array accounts field falls back to the agent's own limits");
  assert.equal(judge(ag("grok", { limits: "x" }), at).reason, "reports no limits", "non-array limits reads as no limits");
}

// judgeAll() treats a non-array `agents` as empty and drops null entries.
{
  assert.deepEqual(judgeAll({ generatedAt: now, agents: {} }, now), []);
  assert.deepEqual(judgeAll({ generatedAt: now, agents: [null] }, now), []);
  assert.equal(judgeAll({ generatedAt: now - 60e3, agents: [null, ag("grok")] }, now).length, 1, "null entries are skipped, real agents still judged");
}

// accountEnv() doesn't throw when the registry's `accounts` isn't an array.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acctenv-bug-"));
  const regDir = path.join(dir, "xdg", "omarchy", "agents", "accounts");
  fs.mkdirSync(regDir, { recursive: true });
  const env = { HOME: "/h", XDG_STATE_HOME: path.join(dir, "xdg") };
  const file = path.join(regDir, "grok.json");
  for (const bad of [{ accounts: {} }, { accounts: "x" }, { accounts: 5 }]) {
    fs.writeFileSync(file, JSON.stringify(bad));
    assert.deepEqual(accountEnv("grok", "w", env), {}, `accounts: ${JSON.stringify(bad.accounts)}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// A generatedAt in the future is a corrupt clock or bad write, not a fresh
// reading: stale data must not pose as brand new.
{
  const future = judge(ag("grok"), { now, generatedAt: now + 365 * 24 * 3600e3 });
  assert.equal(future.reason, "usage reading is out of date");
  assert.equal(future.available, false);
}

// percent values carrying no number (null, "", false) are not readings: they
// can't make an agent "available" at a phantom 0%.
{
  for (const p of [null, "", false]) {
    const v = judge(ag("grok", { limits: [{ title: "Weekly", percent: p }] }), at);
    assert.equal(v.reason, "reports no limits", `percent: ${JSON.stringify(p)}`);
    assert.equal(v.available, false);
  }
}

// OBSERVATION (not asserted as bug): missing `signedIn`/`installed` flags are
// treated as signed-in/installed (strict === false checks). If collectors ever
// omit the flag for "unknown", judge() would offer the agent on no evidence.

// ============================================================================
// DEEPER EDGE COVERAGE — preferOrder, kiloPaidVerdict, reviewText, and the
// remaining judge/accountEnv corners the blocks above don't reach.
// ============================================================================

// ---- judge: inputs that aren't plain agent records, and clock coercion.
{
  // Non-object records are normalized to {} -> "no headless launch known".
  for (const bad of [undefined, 5, "grok", true, () => {}]) {
    const v = judge(bad, at);
    assert.equal(v.available, false);
    assert.equal(v.reason, "no headless launch known", `judge(${String(bad)})`);
  }
  // An array record has no .id -> same path, no crash.
  assert.equal(judge(["grok"], at).reason, "no headless launch known");
  // judge's own now/generatedAt are NOT Number()-coerced (unlike judgeAll's
  // generatedAt): numeric strings subtract fine, garbage makes age NaN -> stale.
  assert.equal(judge(ag("grok"), { now: "100", generatedAt: "50" }).available, true, "numeric-string clocks subtract to a fresh age");
  assert.equal(judge(ag("grok"), { now: "soon", generatedAt: "later" }).reason, "usage reading is out of date", "NaN age is stale, not fresh");
  assert.equal(judge(ag("grok"), { now: NaN, generatedAt: NaN }).reason, "usage reading is out of date");
  // With no opts at all both clocks default to Date.now(): age 0 -> fresh.
  // (grok has no date gate, so this stays true whenever the suite runs.)
  assert.equal(judge(ag("grok")).available, true, "default clocks read as brand new");
  assert.equal(judgeAll({ generatedAt: Date.now(), agents: [ag("grok")] })[0].available, true);
  // judge() doesn't mutate the agent record it was given.
  const rec = ag("grok", { accounts: [{ id: "a", limits: [{ percent: 0.1 }] }] });
  const before = JSON.stringify(rec);
  judge(rec, at);
  assert.equal(JSON.stringify(rec), before, "judge leaves its input untouched");
  // percent edges pctOf accepts that the blocks above don't pin.
  assert.equal(judge(ag("grok", { limits: [{ percent: " 0.4 " }] }), at).available, true, "whitespace-padded numeric string counts");
  assert.equal(judge(ag("grok", { limits: [{ percent: "1e2" }] }), at).reason, "at 10000% of a limit", "exponent string coerces to a huge percent");
  assert.equal(judge(ag("grok", { limits: [{ percent: [] }] }), at).reason, "reports no limits", "array percent is not a reading");
  assert.equal(judge(ag("grok", { limits: [{ percent: {} }] }), at).reason, "reports no limits", "object percent is not a reading");
  assert.equal(judge(ag("grok", { limits: [{ percent: Infinity }] }), at).reason, "reports no limits", "Infinity is not finite");
  // A negative percent is finite, so it counts as a (weird) reading under the line.
  const neg = judge(ag("grok", { limits: [{ percent: -0.5 }] }), at);
  assert.equal(neg.available, true); assert.equal(neg.worst, -0.5);
  // A string agent id that isn't in LAUNCH still gets the launch reason.
  assert.equal(judge(ag(" Devin "), at).reason, "no headless launch known", "ids match exactly, whitespace included");
  // sandbox returning a non-string truthy is stringified into the reason.
  assert.equal(judge(ag("grok"), { ...at, sandbox: () => true }).reason, "can't run sandboxed: true");
}

// ---- judgeAll: agent entries of the wrong type, and per-call clock isolation.
{
  const r = judgeAll({ generatedAt: now - 60e3, agents: ["grok", 5, null, ag("grok")] }, now);
  assert.equal(r.length, 1, "only object records are judged");
  assert.equal(r[0].available, true);
  // Two calls with different clocks don't share state.
  const fresh = judgeAll({ generatedAt: now - 60e3, agents: [ag("grok")] }, now);
  const stale = judgeAll({ generatedAt: now - 60e3, agents: [ag("grok")] }, now + 20 * 60e3);
  assert.equal(fresh[0].available, true);
  assert.equal(stale[0].reason, "usage reading is out of date", "each call judges against its own `now`");
  // generatedAt variants judgeAll coerces via Number().
  assert.equal(judgeAll({ generatedAt: true, agents: [ag("grok")] }, now)[0].reason, "usage reading is out of date", "generatedAt true -> 1 -> ancient");
  assert.equal(judgeAll({ generatedAt: -60e3, agents: [ag("grok")] }, now)[0].reason, "usage reading is out of date", "negative generatedAt -> future relative? no: age huge -> stale");
}

// ---- preferOrder: contract subtleties not pinned above.
{
  assert.deepEqual(preferOrder(), []);
  assert.deepEqual(preferOrder({}), []);
  assert.deepEqual(preferOrder("devin"), [], "a bare string isn't a row list");
  // `available !== false` is the openness test: 0/null/undefined all count as open.
  assert.deepEqual(preferOrder([{ id: "devin", available: 0 }, { id: "grok" }]).map((r) => r.id), ["devin", "grok"], "available: 0 still ranks devin first");
  assert.deepEqual(preferOrder([{ id: "devin", available: null }, { id: "grok" }]).map((r) => r.id), ["devin", "grok"], "available: null counts as open too");
  // An unavailable devin drops to rank 2; an available kilo still leads.
  assert.deepEqual(preferOrder([{ id: "devin", available: false }, { id: "kilo" }, { id: "grok" }]).map((r) => r.id), ["kilo", "devin", "grok"]);
  // Case-sensitive ids: "Devin" is not devin.
  assert.deepEqual(preferOrder(["Devin", "kilo", "grok"]).map(String), ["kilo", "Devin", "grok"], "capital-D Devin isn't the pinned agent but stable order keeps it before grok");
  // Junk rows don't crash and sort to rank 2 in input order.
  assert.deepEqual(preferOrder([5, null, { id: "devin" }, "x"]).map((r) => (typeof r === "object" && r ? r.id : r)), ["devin", 5, null, "x"]);
  // Stability among equal ranks: devin jumps first, the two kilOS keep input order.
  assert.deepEqual(preferOrder([{ id: "kilo", tag: 1 }, { id: "devin" }, { id: "kilo", tag: 2 }]).map((r) => r.tag ?? r.id), ["devin", 1, 2]);
}

// ---- kiloPaidVerdict: input shapes and costCheck edges reached through it.
{
  for (const bad of [null, undefined, 0, {}, [], "no json"]) {
    assert.equal(kiloPaidVerdict(bad), null, `kiloPaidVerdict(${JSON.stringify(bad) ?? typeof bad})`);
  }
  // A JSON array line is scanned event by event.
  assert.equal(kiloPaidVerdict('[{"cost":0.5}]\n').fail, true, "array-wrapped events are checked");
  // Free model id with a positive cost still fails on the cost.
  const c = kiloPaidVerdict('{"type":"step_finish","part":{"providerID":"kilo","modelID":"kilo-auto/free","cost":0.01}}\n');
  assert.equal(c.fail, true); assert.match(c.note, /cost 0\.01 reported/);
  // Negative and string costs are not `typeof number` positives: ignored.
  assert.equal(kiloPaidVerdict('{"cost":-1}\n'), null);
  assert.equal(kiloPaidVerdict('{"cost":"0.5"}\n'), null, "string costs are not checked (kilo-free.mjs contract)");
  // A cost buried deeper than records()' depth cap is invisible.
  let deep = { cost: 0.5 };
  for (let i = 0; i < 12; i++) deep = { wrap: deep };
  assert.equal(kiloPaidVerdict(JSON.stringify(deep) + "\n"), null, "records() stops at depth 8");
  // BUG (in bin/kilo-free.mjs costCheck, surfaced via kiloPaidVerdict): the
  // comment promises tolerance of "a single pretty-printed doc", but output is
  // split on "\n" first and each line parsed alone, so a pretty-printed event
  // never parses and its cost/model is silently missed:
  //   assert.equal(kiloPaidVerdict('{\n  "cost": 0.5\n}\n').fail, true);
  // Real `kilo run --format json` emits one event per line, so this only bites
  // if the stream format ever changes — noted, not fixed here.
}

// ---- reviewText: passthrough contract for non-freebuff agents.
{
  const dirty = "line one\nSponsored: an ad\nline three";
  assert.equal(reviewText("freebuff", dirty), "line one\nline three", "freebuff text is ad-stripped");
  assert.equal(reviewText("Freebuff", dirty), dirty, "agent match is exact-case: 'Freebuff' passes through");
  assert.equal(reviewText(" freebuff", dirty), dirty);
  assert.strictEqual(reviewText("grok", dirty), dirty, "other agents get the identical string back");
  assert.strictEqual(reviewText("kilo", null), null, "non-freebuff null passes through as null");
  assert.equal(reviewText("freebuff", null), "", "freebuff null becomes empty string via stripAds");
  assert.equal(reviewText("freebuff", 42), "42", "non-string freebuff text is String()-coerced");
  assert.equal(reviewText("freebuff", "Sponsored: only an ad"), "", "an all-ad report strips to empty");
}

// ---- accountEnv: claude/codex homes, falsy login, no caching, HOME unset.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acctenv-deep2-"));
  const xdg = path.join(dir, "xdg");
  const regDir = path.join(xdg, "omarchy", "agents", "accounts");
  fs.mkdirSync(regDir, { recursive: true });
  const env = { HOME: "/h", XDG_STATE_HOME: xdg };

  // claude pins CLAUDE_CONFIG_DIR and detects its own seated .claude home.
  fs.writeFileSync(path.join(regDir, "claude.json"), JSON.stringify({ accounts: [
    { id: "main", home: "/h/.claude" }, { id: "alt", home: "/state/claude/alt" }] }));
  assert.deepEqual(accountEnv("claude", "alt", env), { CLAUDE_CONFIG_DIR: "/state/claude/alt" });
  assert.deepEqual(accountEnv("claude", "main", env), {}, "seated .claude needs no pin");

  // codex pins CODEX_HOME against .codex.
  fs.writeFileSync(path.join(regDir, "codex.json"), JSON.stringify({ accounts: [{ id: "c", home: "/h/.codex" }] }));
  assert.deepEqual(accountEnv("codex", "c", env), {}, "seated .codex needs no pin");
  fs.writeFileSync(path.join(regDir, "codex.json"), JSON.stringify({ accounts: [{ id: "c", home: "/cx" }] }));
  assert.deepEqual(accountEnv("codex", "c", env), { CODEX_HOME: "/cx" });

  // An account with neither login nor home pins nothing; login:"" falls back to home.
  const gf = path.join(regDir, "grok.json");
  fs.writeFileSync(gf, JSON.stringify({ accounts: [{ id: "w" }, { id: "v", login: "", home: "/vh" }] }));
  assert.deepEqual(accountEnv("grok", "w", env), {}, "account entry with no paths -> {}");
  assert.deepEqual(accountEnv("grok", "v", env), { GROK_HOME: "/vh" }, "empty login falls through to home");
  // An account whose home IS $HOME is not the seated agent home -> it pins.
  fs.writeFileSync(gf, JSON.stringify({ accounts: [{ id: "w", home: "/h" }] }));
  assert.deepEqual(accountEnv("grok", "w", env), { GROK_HOME: "/h" }, "home-as-account-home still pins (seated is home/.grok)");
  // HOME unset: ~ expands via os.homedir() while XDG still finds the registry.
  fs.writeFileSync(gf, JSON.stringify({ accounts: [{ id: "w", home: "~/alt" }] }));
  assert.deepEqual(accountEnv("grok", "w", { XDG_STATE_HOME: xdg }), { GROK_HOME: path.join(os.homedir(), "alt") });
  // No caching: rewriting the registry is seen by the very next call.
  fs.writeFileSync(gf, JSON.stringify({ accounts: [{ id: "w", home: "/first" }] }));
  assert.deepEqual(accountEnv("grok", "w", env), { GROK_HOME: "/first" });
  fs.writeFileSync(gf, JSON.stringify({ accounts: [{ id: "w", home: "/second" }] }));
  assert.deepEqual(accountEnv("grok", "w", env), { GROK_HOME: "/second" }, "registry re-read on every call");
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("constance-agents.deep: tests passed");
