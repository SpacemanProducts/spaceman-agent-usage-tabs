// Which CLI runs Constance's own planning brain. Default is Claude Code (`claude`); the owner
// can point her at Antigravity's CLI (`agy`) with settings.constanceBrain, but agy's login lives
// in the desktop keyring, so it is allowed only when the owner already opted that agent in via
// constanceKeyringAgents. Everything here is pure: the caller reads settings and data.json and
// passes them in. agy has no system-prompt flag and no preset session ids, so its runs are
// always fresh and the role rides inside the prompt; its wall is read off the report text plus
// the antigravity limit bars, not Claude's "hit your limit" exit.
import { limitWall } from "./constance-wall.mjs";

export const BRAINS = {
  claude: { id: "claude", name: "Claude Code", cli: "claude" },
  antigravity: { id: "antigravity", name: "Antigravity", cli: "agy" },
};

export function pickBrain(settings = {}) {
  const wanted = settings?.constanceBrain === "antigravity" ? "antigravity" : "claude";
  if (wanted === "claude") return { ...BRAINS.claude, wanted, ok: true, why: "" };
  const keyring = Array.isArray(settings?.constanceKeyringAgents) && settings.constanceKeyringAgents.includes("antigravity");
  if (keyring) return { ...BRAINS.antigravity, wanted, ok: true, why: "" };
  return {
    ...BRAINS.claude, wanted, ok: false,
    why: 'Antigravity keeps its login in the desktop keyring; add "antigravity" to constanceKeyringAgents in settings to let her brain use it. She stays on Claude Code until then.',
  };
}

// agy model preference, best first. A live model agy no longer lists (state "unavailable")
// never wins, no matter where it sits.
export const AGY_RANK = [
  "Claude Opus 5.5", "Gemini 4 Carbon", "Orchestrator Carbon", "Gemini 4 Argon",
  "Claude Sonnet 5.5", "Claude Opus 4.6", "Gemini 4 Hydrogen", "Claude Sonnet 4.6",
  "Gemini 3.8 Flash",
];

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
// to plain "Session" / "Weekly" so the pacing windows line up with Claude's.
export function brainLimits(data, brain, model) {
  const id = typeof brain === "string" ? brain : brain?.id;
  if (id !== "antigravity") {
    const entry = findAgent(data, "claude");
    return entry || { id: "claude", limits: [], unsure: true };
  }
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

// The argv for one run of her brain. claude gets the role as a system prompt and can resume a
// session; agy gets the role folded into the prompt and always starts fresh.
export function brainCommand({ brain, model, role, prompt, session, resume } = {}) {
  const id = typeof brain === "string" ? brain : brain?.id;
  if (id === "antigravity") {
    return {
      cmd: "agy",
      args: ["--dangerously-skip-permissions", "--output-format", "text",
        ...(model ? ["--model", model] : []), "-p", `${role}\n\n${prompt}`],
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
const AGY_FALLBACK_MS = 60 * 60e3;
const resetsMs = (l, now) => {
  const t = new Date(l?.resetsAt || "").getTime();
  return Number.isFinite(t) && t > now ? t : null;
};

// null when the run didn't hit a wall; else { until, stated, text } like limitWall. For agy the
// report text is the only signal, and the wait comes from her limit bars: the latest reset among
// the nearly-spent ones (percent >= 0.85), else the earliest future reset, else an hour.
export function brainWall(brain, report, now = Date.now(), limits = []) {
  const id = typeof brain === "string" ? brain : brain?.id;
  if (id !== "antigravity") return limitWall(report, now);
  const lines = String(report || "").split("\n");
  const hit = lines.find((l) => AGY_LIMIT.test(l));
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
  return brainId === "antigravity" ? "Milk Antigravity" : "Milk Opus";
}
