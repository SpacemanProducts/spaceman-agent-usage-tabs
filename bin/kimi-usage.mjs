// Kimi Code's local usage, read straight from its own append-only session logs.
// Kimi Code (the `kimi` CLI, @moonshot-ai/kimi-code) writes one JSON record per
// line to <home>/sessions/<workspace>/<session>/agents/<agent>/wire.jsonl under
// its home (KIMI_CODE_HOME, else ~/.kimi-code). A `usage.record` line carries
// { agentId, model, usage: { inputOther, output, inputCacheRead?,
// inputCacheCreation? }, usageScope?, time } where `model` is the model alias the
// request ran on and `time` is epoch milliseconds. Forked sessions copy their
// source's records verbatim, so identical records are counted once.
// Plan limits are NOT in these files (they come from the quota API), so
// `limits` is always empty. Read-only: nothing here writes, refreshes or
// prints credentials, and nothing touches the network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const USAGE_FIELDS = ["inputOther", "output", "inputCacheRead", "inputCacheCreation"];
const OPTIONAL_USAGE_FIELDS = new Set(["inputCacheRead", "inputCacheCreation"]);
const DAY_MS = 86400000;

function localDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function localMidnight(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function daysAgo(ms, now) {
  return Math.round((localMidnight(now) - localMidnight(ms)) / DAY_MS);
}

// Pure: parse one wire.jsonl's text into usage records.
// Returns [{ key, time, model, tokens }] — key dedupes fork-copied records.
export function parseWireJsonl(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.includes('"usage.record"')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || rec.type !== "usage.record") continue;
    const usage = rec.usage;
    if (!usage || typeof usage !== "object") continue;
    const counts = USAGE_FIELDS.map((f) =>
      usage[f] === undefined && OPTIONAL_USAGE_FIELDS.has(f) ? 0 : usage[f]);
    if (!counts.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) continue;
    const tokens = counts.reduce((a, b) => a + b, 0);
    if (!(tokens > 0) || typeof rec.time !== "number" || !Number.isFinite(rec.time)) continue;
    const model = typeof rec.model === "string" && rec.model ? rec.model : "unknown";
    const key = [rec.agentId, rec.time, model, ...counts].join("|");
    out.push({ key, time: rec.time, model, tokens });
  }
  return out;
}

function kimiSessionsDir({ home, env }) {
  const kimiHome = (env.KIMI_CODE_HOME || "").trim() || path.join(home, ".kimi-code");
  return path.join(kimiHome, "sessions");
}

function* wireFiles(sessionsDir) {
  let workspaces;
  try {
    workspaces = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    let sessions;
    try {
      sessions = fs.readdirSync(path.join(sessionsDir, ws.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      let agents;
      try {
        agents = fs.readdirSync(path.join(sessionsDir, ws.name, session.name, "agents"), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const agent of agents) {
        if (!agent.isDirectory()) continue;
        const file = path.join(sessionsDir, ws.name, session.name, "agents", agent.name, "wire.jsonl");
        try {
          if (fs.statSync(file).isFile()) yield file;
        } catch {
          // no wire.jsonl for this agent
        }
      }
    }
  }
}

export function readKimiUsage({ home = os.homedir(), env = process.env, now = Date.now() } = {}) {
  const sessionsDir = kimiSessionsDir({ home, env });
  const seen = new Set();
  const days = new Map();
  const models = new Map();
  let files = 0;
  for (const file of wireFiles(sessionsDir)) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    files++;
    for (const rec of parseWireJsonl(text)) {
      if (seen.has(rec.key)) continue;
      seen.add(rec.key);
      const day = localDate(rec.time);
      days.set(day, (days.get(day) || 0) + rec.tokens);
      const back = daysAgo(rec.time, now);
      if (back >= 0 && back < 7) models.set(rec.model, (models.get(rec.model) || 0) + rec.tokens);
    }
  }
  if (!files) return null;
  const today = new Date(now);
  const dayList = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const p = (n) => String(n).padStart(2, "0");
    const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    dayList.push({ date, tokens: days.get(date) || 0 });
  }
  const modelMap = {};
  for (const [model, tokens] of [...models.entries()].sort((a, b) => b[1] - a[1])) modelMap[model] = tokens;
  return { days: dayList, models: modelMap, limits: [] };
}
