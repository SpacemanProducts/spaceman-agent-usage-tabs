// Constance: which agents she may hand work to right now, and how to launch each one headless.
//
// An agent is available only when every rule below holds (anything else is skipped, with the reason):
//   - it is installed and has a headless launch here (LAUNCH below);
//   - it is not Claude: Claude is Constance herself, on the owner's one paid plan;
//   - it is signed in and the panel can read its limits (no can't-read / sign-in-needed state);
//   - it reports at least one limit, and every reported limit is under RED (a reading we can't see
//     can't prove it is under its limit);
//   - the reading is fresh (data.json written in the last FRESH_MS);
//   - it can't start charging: no bring-your-own-key agents, and Devin only while SWE-2 Flash is free.
// Pure functions; bin/constance.mjs feeds them data.json.

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

// All limits an agent reports, its accounts' included.
function limitsOf(a) {
  const out = [...(a.limits || [])];
  for (const acc of a.accounts || []) out.push(...(acc.limits || []));
  return out.filter((l) => l && Number.isFinite(Number(l.percent)));
}

// { id, name, available, reason, worst } for one agent.
export function judge(a, { now = Date.now(), generatedAt = now } = {}) {
  const base = { id: a.id, name: a.name || a.id, available: false, worst: null };
  const no = (reason) => ({ ...base, reason });
  if (a.id === "claude") return no("Constance herself (the paid plan)");
  if (a.installed === false) return no("not installed");
  if (!LAUNCH[a.id]) return no("no headless launch known");
  if (a.usageType === "byok_no_limits") return no("bring-your-own-key: would charge");
  if (a.id === "devin" && now >= DEVIN_FREE_UNTIL) return no("free SWE-2 Flash window ended: would charge");
  if (a.signedIn === false) return no("sign-in needed");
  if (a.cantRead) return no("can't read its limits");
  if (a.unsure) return no("reading is unsure");
  if (!(now - generatedAt < FRESH_MS)) return no("usage reading is out of date");
  const ls = limitsOf(a);
  if (ls.length === 0) return no("reports no limits");
  const worst = Math.max(...ls.map((l) => Number(l.percent)));
  const r = { ...base, worst };
  if (ls.some((l) => l.hitAt && Number(l.percent) >= 1)) return { ...r, reason: "hit its limit" };
  if (worst >= RED) return { ...r, reason: `at ${Math.round(worst * 100)}% of a limit` };
  return { ...r, available: true, reason: `under its limits (fullest ${Math.round(worst * 100)}%)` };
}

export function judgeAll(data, now = Date.now()) {
  const generatedAt = Number(data?.generatedAt) || 0;
  return (data?.agents || []).map((a) => judge(a, { now, generatedAt }));
}
