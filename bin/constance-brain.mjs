// Which CLI runs Constance's own planning brain. Default is Claude Code (`claude`); the owner
// can point her at another agent's CLI with settings.constanceBrain. antigravity's login lives
// in the desktop keyring, so it is allowed only when the owner already opted that agent in via
// constanceKeyringAgents; grok, codex and copilot run her steps outside the sandbox, so they
// need the per-agent opt-in constanceBrainUnsandboxed (copilot needs the keyring opt-in too).
// Everything here is pure: the caller reads settings and data.json and passes them in. agy,
// grok, codex and copilot have no system-prompt flag, so their runs are always fresh-shaped and
// the role rides inside the prompt; their walls are read off the report text plus the agent's
// own limit bars, not Claude's "hit your limit" exit.
import { limitWall } from "./constance-wall.mjs";

export const BRAINS = {
  claude: { id: "claude", name: "Claude Code", cli: "claude" },
  antigravity: { id: "antigravity", name: "Antigravity", cli: "agy" },
  grok: { id: "grok", name: "Grok", cli: "grok" },
  codex: { id: "codex", name: "Codex", cli: "codex" },
  copilot: { id: "copilot", name: "Copilot", cli: "copilot" },
};

// What each non-Claude brain needs before she may run on it, checked in order. `list` names
// the settings.json array the agent id must appear in: constanceKeyringAgents for an agent
// whose login lives in the desktop keyring (the same opt-in sandboxed workers need), and
// constanceBrainUnsandboxed for an agent whose brain steps would run on the host, outside
// bubblewrap. claude needs nothing (it is her own paid plan) and antigravity only the keyring.
const BRAIN_NEEDS = {
  antigravity: [
    { list: "constanceKeyringAgents", why: 'Antigravity keeps its login in the desktop keyring; add "antigravity" to constanceKeyringAgents in settings to let her brain use it. She stays on Claude Code until then.' },
  ],
  grok: [
    { list: "constanceBrainUnsandboxed", why: 'Grok would run her brain steps outside the sandbox; add "grok" to constanceBrainUnsandboxed in settings to let her brain use it. She stays on Claude Code until then.' },
  ],
  codex: [
    { list: "constanceBrainUnsandboxed", why: 'Codex would run her brain steps outside the sandbox; add "codex" to constanceBrainUnsandboxed in settings to let her brain use it. She stays on Claude Code until then.' },
  ],
  copilot: [
    { list: "constanceKeyringAgents", why: 'Copilot keeps its login in the desktop keyring; add "copilot" to constanceKeyringAgents in settings to let her brain use it. She stays on Claude Code until then.' },
    { list: "constanceBrainUnsandboxed", why: 'Copilot would run her brain steps outside the sandbox; add "copilot" to constanceBrainUnsandboxed in settings to let her brain use it. She stays on Claude Code until then.' },
  ],
};

export function pickBrain(settings = {}) {
  const raw = settings?.constanceBrain;
  // Only a known brain id is honored; anything else (missing, unknown, wrong case) is Claude.
  const wanted = Object.hasOwn(BRAINS, raw) ? raw : "claude";
  if (wanted === "claude") return { ...BRAINS.claude, wanted, ok: true, why: "" };
  for (const need of BRAIN_NEEDS[wanted] || []) {
    const list = settings?.[need.list];
    if (!(Array.isArray(list) && list.includes(wanted)))
      return { ...BRAINS.claude, wanted, ok: false, why: need.why };
  }
  return { ...BRAINS[wanted], wanted, ok: true, why: "" };
}

// agy model preference, best first. A live model agy no longer lists (state "unavailable")
// never wins, no matter where it sits.
export const AGY_RANK = [
  "Claude Opus 5.5", "Gemini 4 Carbon", "Orchestrator Carbon", "Gemini 4 Argon",
  "Claude Sonnet 5.5", "Claude Opus 4.6", "Gemini 4 Hydrogen", "Claude Sonnet 4.6",
  "Gemini 3.8 Flash",
];

// Brains with no curated rank list: the model comes straight from the agent's own live
// models in data.json — the owner's constanceBrainModel override first, then a model the
// list flags as its default/recommended/top pick, else the first usable one listed.
const LIVE_LIST_BRAINS = new Set(["grok", "codex", "copilot"]);
const isFlagged = (m) => !!(m.default || m.recommended || m.top);

const usable = (m) => m && typeof m === "object" && m.state !== "unavailable";
const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

export function topModel(agent, settings = {}) {
  const models = Array.isArray(agent?.models) ? agent.models.filter(usable) : [];
  if (!models.length) return null;
  const want = settings?.constanceBrainModel;
  if (want) {
    const hit = models.find((m) => same(m.id, want) || same(m.name, want));
    if (hit) return { id: hit.id, name: hit.name };
  }
  if (LIVE_LIST_BRAINS.has(agent?.id)) {
    const pick = models.find(isFlagged) || models[0];
    return { id: pick.id, name: pick.name };
  }
  for (const rank of AGY_RANK) {
    const hit = models.find((m) => same(m.name, rank));
    if (hit) return { id: hit.id, name: hit.name };
  }
  const first = models[0];
  return { id: first.id, name: first.name };
}

// Which antigravity quota pool a model draws from: Claude and GPT models share one pool,
// everything else is Gemini.
export function poolOf(modelName) {
  return /^(claude|gpt)/i.test(String(modelName || "").trim()) ? "Claude/GPT" : "Gemini";
}

const findAgent = (data, id) => (Array.isArray(data?.agents) ? data.agents : []).find((a) => a && a.id === id);

// The { id, limits, unsure } object pace() reads. For antigravity the bars arrive titled
// "<pool> Session" / "<pool> Weekly"; she only sees the pool her chosen model burns, renamed
// to plain "Session" / "Weekly" so the pacing windows line up with Claude's. The other
// brains pass their own agent entry through like Claude does.
export function brainLimits(data, brain, model) {
  const id = typeof brain === "string" ? brain : brain?.id;
  if (id === "antigravity") {
    const entry = findAgent(data, "antigravity");
    if (!entry) return { id: "antigravity", limits: [], unsure: true };
    const pool = model?.name ? poolOf(model.name) : "Gemini";
    const limits = (Array.isArray(entry.limits) ? entry.limits : []).flatMap((l) => {
      const title = String(l?.title || "");
      const suffix = title === `${pool} Session` ? "Session" : title === `${pool} Weekly` ? "Weekly" : null;
      return suffix ? [{ ...l, title: suffix }] : [];
    });
    return { id: "antigravity", limits, unsure: entry.unsure };
  }
  const own = Object.hasOwn(BRAINS, id) ? id : "claude";
  const entry = findAgent(data, own);
  return entry || { id: own, limits: [], unsure: true };
}

// The argv for one run of her brain. claude gets the role as a system prompt and can resume a
// session; the other brains have no system-prompt flag, so the role is folded into the prompt
// (agy always starts fresh; grok/copilot resume with -r, codex with `exec resume`).
export function brainCommand({ brain, model, role, prompt, session, resume } = {}) {
  const id = typeof brain === "string" ? brain : brain?.id;
  const text = `${role}\n\n${prompt}`;
  if (id === "antigravity") {
    return {
      cmd: "agy",
      args: ["--dangerously-skip-permissions", "--output-format", "text",
        ...(model ? ["--model", model] : []), "-p", text],
    };
  }
  if (id === "grok") {
    return {
      cmd: "grok",
      args: ["--permission-mode", "bypassPermissions", "--output-format", "json",
        ...(model ? ["-m", model] : []),
        ...(resume && session ? ["-r", session] : []), "-p", text],
    };
  }
  if (id === "codex") {
    return {
      cmd: "codex",
      args: resume && session
        ? ["exec", "resume", session, text]
        : ["exec", "--dangerously-bypass-approvals-and-sandbox", "--json",
           ...(model ? ["-m", model] : []), text],
    };
  }
  if (id === "copilot") {
    return {
      cmd: "copilot",
      args: ["--allow-all", "--no-ask-user", "-s",
        ...(model ? ["--model", model] : []),
        ...(resume && session ? ["-r", session] : []), "-p", text],
    };
  }
  return {
    cmd: "claude",
    args: ["-p", "--model", model || "opus", "--dangerously-skip-permissions",
      "--output-format", "text", "--append-system-prompt", role,
      ...(resume ? ["--resume", session] : ["--session-id", session]), prompt],
  };
}

const AGY_LIMIT = /quota|rate.?limit|resource.?exhausted|\b429\b|usage limit|limit reached/i;
// grok/codex/copilot don't share one wording: any report line naming a limit or a quota is a
// wall (Copilot's "You've hit the rate limit for this model." / "... session rate limit." /
// "... weekly rate limit." all land here).
const REPORT_LIMIT = /\b(?:limits?|quota)\b|resource.?exhausted|\b429\b/i;
const WALL_REPORT = { antigravity: AGY_LIMIT, grok: REPORT_LIMIT, codex: REPORT_LIMIT, copilot: REPORT_LIMIT };
const AGY_FALLBACK_MS = 60 * 60e3;
const resetsMs = (l, now) => {
  const t = new Date(l?.resetsAt || "").getTime();
  return Number.isFinite(t) && t > now ? t : null;
};

// null when the run didn't hit a wall; else { until, stated, text } like limitWall. For the
// report-scanning brains the report text is the only signal, and the wait comes from the
// agent's limit bars: the latest reset among the nearly-spent ones (percent >= 0.85), else the
// earliest future reset, else an hour.
export function brainWall(brain, report, now = Date.now(), limits = []) {
  const id = typeof brain === "string" ? brain : brain?.id;
  const re = Object.hasOwn(WALL_REPORT, id) ? WALL_REPORT[id] : null;
  if (!re) return limitWall(report, now);
  const lines = String(report || "").split("\n");
  const hit = lines.find((l) => re.test(l));
  if (hit === undefined) return null;
  const list = Array.isArray(limits) ? limits : [];
  const hot = list.filter((l) => (Number(l?.percent) || 0) >= 0.85).map((l) => resetsMs(l, now)).filter((t) => t !== null);
  const all = list.map((l) => resetsMs(l, now)).filter((t) => t !== null);
  let until = null;
  if (hot.length) until = Math.max(...hot);
  else if (all.length) until = Math.min(...all);
  return { until: until ?? now + AGY_FALLBACK_MS, stated: until !== null, text: hit.trim().slice(0, 200) };
}

export function milkLabel(brainId) {
  if (brainId === "antigravity") return "Milk Antigravity";
  if (Object.hasOwn(BRAINS, brainId) && brainId !== "claude") return `Milk ${BRAINS[brainId].name}`;
  return "Milk Opus";
}
