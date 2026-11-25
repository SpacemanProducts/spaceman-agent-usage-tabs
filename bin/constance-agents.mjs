// Constance: which agents she may hand work to right now, and how to launch each one headless.
//
// An agent is available only when every rule below holds (anything else is skipped, with the reason):
//   - it is installed and has a headless launch here (LAUNCH below);
//   - it is not Claude: Claude is Constance herself, on the owner's one paid plan;
//   - it is signed in and the panel can read its limits (no can't-read / sign-in-needed state);
//   - it reports at least one limit, and the account she would use is under RED (a reading we can't
//     see can't prove it is under its limit);
//   - the reading is fresh (data.json written in the last FRESH_MS);
//   - it can't start charging: no bring-your-own-key agents, and Devin only while SWE-2 Flash is free;
//   - it can run inside the sandbox (bin/constance-sandbox.mjs), because it runs with its prompts off.
// Pure functions; bin/constance.mjs feeds them data.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const RED = 0.85;                               // the panel's red line: a meter above it is near the wall
export const FRESH_MS = 15 * 60 * 1000;
// Same date as DEVIN_FLASH_FREE_UNTIL in bin/collect.mjs (constance-agents.test.mjs checks they match).
export const DEVIN_FREE_UNTIL = Date.UTC(2026, 11, 4, 18, 0);

// Headless launches with each agent's skip-permissions flag, the same flags as bin/agent-here.sh
// (the test checks they match). The prompt is the last argument. Devin is pinned to its free model.
export const LAUNCH = {
  antigravity: { cli: "agy", args: (p) => ["--dangerously-skip-permissions", "-p", p], skip: "--dangerously-skip-permissions" },
  grok: { cli: "grok", args: (p) => ["--permission-mode", "bypassPermissions", "-p", p], skip: "--permission-mode bypassPermissions" },
  copilot: { cli: "copilot", args: (p) => ["--allow-all", "--no-ask-user", "-p", p], skip: "--allow-all" },
  devin: { cli: "devin", args: (p) => ["--permission-mode", "dangerous", "--respect-workspace-trust", "false", "--model", "swe-2-flash-medium", "-p", p], skip: "--permission-mode dangerous --respect-workspace-trust false" },
  codex: { cli: "codex", args: (p) => ["exec", "--dangerously-bypass-approvals-and-sandbox", p], skip: "--dangerously-bypass-approvals-and-sandbox" },
  cursor: { cli: "cursor-agent", args: (p) => ["-p", "--yolo", "--trust", p], skip: "--yolo --trust" },
};

export function launchCommand(id, prompt) {
  const l = LAUNCH[id];
  return l ? [l.cli, ...l.args(prompt)] : null;
}

// How many copies of the same agent Constance may run at once (a copy is a
// separate git worktree + branch + sandbox, tracked as its own worker "Devin 1"..)
// and whether the machine has room for another: see constance-ramp.mjs.

// A limit's percent as a number, or NaN when the source reported no number.
// Number() alone would read null/""/false/[] as 0 and make a meter with no
// reading look like a real 0% — malformed input must never make an agent
// available. `true` still coerces to 1 (pinned by the tests).
function pctOf(l) {
  const p = l && l.percent;
  if (typeof p === "number") return Number.isFinite(p) ? p : NaN;
  if (typeof p === "string") { const t = p.trim(); return t !== "" && Number.isFinite(Number(t)) ? Number(t) : NaN; }
  return p === true ? 1 : NaN;
}

// Each registered account is its own source of capacity: she can use whichever
// login has the most room, not only the seated one. accounts[] (2+ signed-in
// accounts) lists every login; without it the agent's own limits are the only
// source. An account entry with no readable limits is not a source at all.
function sourcesOf(a) {
  const accs = (Array.isArray(a.accounts) ? a.accounts : [])
    .filter((x) => x && typeof x === "object")
    .map((x) => ({ id: x.id || "", label: x.label || "", limits: Array.isArray(x.limits) ? x.limits : [] }))
    .filter((s) => s.limits.some((l) => Number.isFinite(pctOf(l))));
  if (accs.length) return accs;
  return [{ id: "", label: "", limits: Array.isArray(a.limits) ? a.limits : [] }];
}

// One source's meters rolled up: fullest percent, whether it sits at a wall,
// and the limit to blame when it blocks.
function statsOf(limits) {
  const ls = (Array.isArray(limits) ? limits : []).filter((l) => Number.isFinite(pctOf(l)));
  if (!ls.length) return null;
  const hit = ls.find((l) => l.hitAt && pctOf(l) >= 1) || null;
  const fullest = ls.reduce((m, l) => (pctOf(l) > pctOf(m) ? l : m), ls[0]);
  return { ls, hit, fullest, worst: pctOf(fullest) };
}

// { id, name, account, accountId, available, reason, worst, resetsAt, blockTitle } for one agent.
// `account`/`accountId` name the login she would use ("" / null for a
// single-account agent, so those look exactly as before).
export function judge(a, { now = Date.now(), generatedAt = now, sandbox = null } = {}) {
  a = a && typeof a === "object" ? a : {};
  const base = { id: a.id, name: a.name || a.id, account: "", accountId: null, available: false, worst: null, resetsAt: null, blockTitle: null };
  const no = (reason) => ({ ...base, reason });
  if (a.id === "claude") return no("Constance herself (the paid plan)");
  if (a.installed === false) return no("not installed");
  if (!LAUNCH[a.id]) return no("no headless launch known");
  // Every worker runs with its prompts off, so only inside the sandbox: one
  // that can't be sandboxed is never available (bin/constance-sandbox.mjs).
  const boxed = sandbox ? sandbox(a.id) : "";
  if (boxed) return no(`can't run sandboxed: ${boxed}`);
  if (a.usageType === "byok_no_limits") return no("bring-your-own-key: would charge");
  if (a.id === "devin" && now >= DEVIN_FREE_UNTIL) return no("free SWE-2 Flash window ended: would charge");
  if (a.signedIn === false) return no("sign-in needed");
  if (a.cantRead) return no("can't read its limits");
  if (a.unsure) return no("reading is unsure");
  // Fresh means 0 <= age < FRESH_MS: a generatedAt in the future is a corrupt
  // clock or bad write, and stale data must not pose as brand new.
  const age = now - generatedAt;
  if (!(age >= 0 && age < FRESH_MS)) return no("usage reading is out of date");
  const srcs = sourcesOf(a).map((s) => ({ ...s, st: statsOf(s.limits) })).filter((s) => s.st);
  if (!srcs.length) return no("reports no limits");
  // Her pick: a source under the red line with the most room; when every source
  // is blocked she still names the one closest to freeing up.
  const open = srcs.filter((s) => !s.st.hit && s.st.worst < RED);
  const pick = (open.length ? open : srcs).reduce((m, s) => (s.st.worst < m.st.worst ? s : m));
  const r = { ...base, worst: pick.st.worst, account: pick.label || "", accountId: pick.id || null };
  // The limit that blocks her (the hit one, or the fullest one) brings its reset time along, so the
  // panel can say "at 99%, resets in 3h" instead of just "at 99%".
  const blocker = (l) => ({ resetsAt: l?.resetsAt || null, blockTitle: l?.title || null });
  if (pick.st.hit) return { ...r, ...blocker(pick.st.hit), reason: "hit its limit" };
  if (pick.st.worst >= RED) return { ...r, ...blocker(pick.st.fullest), reason: `at ${Math.round(pick.st.worst * 100)}% of a limit` };
  return { ...r, available: true, reason: `under its limits (fullest ${Math.round(pick.st.worst * 100)}%)` };
}

export function judgeAll(data, now = Date.now(), { sandbox = null } = {}) {
  const generatedAt = Number(data?.generatedAt) || 0;
  const agents = Array.isArray(data?.agents) ? data.agents : [];
  return agents.filter((a) => a && typeof a === "object").map((a) => judge(a, { now, generatedAt, sandbox }));
}

// The env that pins a CLI to a registered account's home, or {} when the job
// should use the seated account (its login already lives in the primary home).
// Only claude/codex/grok have registered homes; reads Omarchy's account
// registry — ids and paths, never tokens.
const ACCOUNT_HOMES = { claude: ["CLAUDE_CONFIG_DIR", ".claude"], codex: ["CODEX_HOME", ".codex"], grok: ["GROK_HOME", ".grok"] };
export function accountEnv(agentId, accountId, env = process.env) {
  const spec = ACCOUNT_HOMES[agentId];
  if (!spec || !accountId) return {};
  const home = env.HOME || os.homedir();
  const file = path.join(env.XDG_STATE_HOME || path.join(home, ".local/state"), "omarchy", "agents", "accounts", `${agentId}.json`);
  let reg; try { reg = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
  const acc = (Array.isArray(reg?.accounts) ? reg.accounts : []).find((x) => x && x.id === accountId);
  const loginHome = acc && (acc.login || acc.home);
  if (!loginHome) return {};
  const abs = path.resolve(String(loginHome).replace(/^~/, home));
  if (abs === path.resolve(home, spec[1])) return {};
  return { [spec[0]]: abs };
}
