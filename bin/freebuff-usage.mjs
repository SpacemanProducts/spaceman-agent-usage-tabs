// Freebuff (Codebuff-based) usage, read from its own local run state —
// read-only, no network, no credentials. Freebuff keeps one directory per
// chat under ~/.config/manicode/chats/<timestamp>/ and may also keep the
// same chats under ~/.config/manicode/projects/<project>/chats/<timestamp>/
// (deduped by the timestamp folder name). run-state.json holds the counters
// it actually reports, nested at sessionState.mainAgentState
// (creditsUsed, directCreditsUsed, contextTokenCount, lastActivityAt —
// verified on the host 2026-11-25); the older top-level fields are kept as a
// fallback. chat-meta.json carries chat-level metadata. Anything the files
// do not carry is not shown: plan rate limits and reset windows are
// cloud-only, so `limits` stays [] and the note says so unless a file
// happens to hold them. Nothing here writes, refreshes or prints a
// credential.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DAY = 24 * 60 * 60 * 1000;

// Fields the run state reports usage in; only ones actually present are used.
// Nested shape first: sessionState.mainAgentState.{creditsUsed,
// directCreditsUsed, contextTokenCount, lastActivityAt}. creditsUsed and
// directCreditsUsed are incremented together upstream, so creditsUsed is the
// total and directCreditsUsed is only a fallback when creditsUsed is absent
// (summing them would double-count). CREDIT_KEYS/TOKEN_KEYS/TIME_KEYS are the
// older top-level fallback.
const NESTED_CREDIT_KEYS = ["creditsUsed", "directCreditsUsed"];
const NESTED_TOKEN_KEYS = ["contextTokenCount"];
const CREDIT_KEYS = ["creditsUsed", "credits", "creditsSpent"];
const TOKEN_KEYS = ["contextTokenCount", "tokensUsed", "totalTokens"];
// Plausible timestamp fields, most-trustworthy first. Chat-meta may also
// carry lastMessageAt/lastActivityAt.
const TIME_KEYS = ["updatedAt", "lastActiveAt", "lastActivityAt", "lastMessageAt", "lastUpdate", "finishedAt", "endedAt", "timestamp", "createdAt", "time", "startTime"];
// Keys a file could carry plan limits under; normally none do (cloud-only).
const LIMIT_KEYS = ["limits", "rateLimits", "rate_limits"];

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
const num = (v) => {
  if (typeof v === "boolean" || typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return v;
};

// Epoch seconds or milliseconds, or digits in a string, or an ISO time -> ms.
// Same magnitude rule as the other collectors: >1e10 is already ms.
function timeMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return null;
  let ms;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    ms = value > 10_000_000_000 ? value : value * 1000;
  } else {
    const s = String(value).trim();
    if (/^[0-9]{1,20}$/.test(s)) {
      const n = Number(s);
      if (!Number.isFinite(n) || n <= 0) return null;
      ms = n > 10_000_000_000 ? n : n * 1000;
    } else {
      const t = Date.parse(s);
      if (!Number.isFinite(t)) return null;
      ms = t;
    }
  }
  const d = new Date(Math.floor(ms));
  if (d.getFullYear() < 2000 || d.getFullYear() > 2100) return null;
  return ms;
}

// The first timestamp field a JSON object actually carries, in TIME_KEYS order.
function jsonTime(record) {
  for (const key of TIME_KEYS) {
    const ms = timeMs(record[key]);
    if (ms != null) return ms;
  }
  return null;
}

function readJson(file) {
  try {
    return obj(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function mtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

// Every chat directory holding a parseable run-state.json, from both known
// layouts: <manicode>/chats/<timestamp>/ first, then
// <manicode>/projects/<project>/chats/<timestamp>/. Chats are deduped by the
// timestamp folder name (the same chat can appear under both layouts); the
// direct chats/ copy wins when both parse. Returns
// [{run, meta, runFile, metaFile}] where run/meta are the parsed objects
// (meta null when absent/corrupt).
function chatDirs(manicode) {
  const chats = [];
  const seen = new Set();
  const addFrom = (chatsDir) => {
    let chatNames;
    try {
      chatNames = fs.readdirSync(chatsDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const chat of chatNames) {
      if (!chat.isDirectory() || seen.has(chat.name)) continue;
      const dir = path.join(chatsDir, chat.name);
      const runFile = path.join(dir, "run-state.json");
      const run = readJson(runFile);
      if (!run) continue; // no run state, no usage to report
      seen.add(chat.name);
      const metaFile = path.join(dir, "chat-meta.json");
      chats.push({ run, meta: readJson(metaFile), runFile, metaFile });
    }
  };
  addFrom(path.join(manicode, "chats"));
  const projects = path.join(manicode, "projects");
  let projectNames;
  try {
    projectNames = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    projectNames = [];
  }
  for (const project of projectNames) {
    if (!project.isDirectory()) continue;
    addFrom(path.join(projects, project.name, "chats"));
  }
  return chats;
}

// sessionState.mainAgentState when the run state carries it, else null.
function mainAgentState(run) {
  const session = obj(run.sessionState);
  return session ? obj(session.mainAgentState) : null;
}

// The first numeric field present in `record` among `keys`.
function pickNum(record, keys) {
  if (!record) return null;
  for (const key of keys) {
    const v = num(record[key]);
    if (v != null) return v;
  }
  return null;
}

// The usage one chat's run state reports: {credits?, tokens?, ms} — each
// metric only when its field is actually present (nested
// sessionState.mainAgentState first, top-level fields as fallback), the time
// from the best available source (nested lastActivityAt, then run-state
// field, then run-state mtime, then chat-meta field/mtime). ms may be null:
// an undated chat still counts toward total.
function chatUsage(chat) {
  const out = { ms: null };
  const agent = mainAgentState(chat.run);
  const credits = pickNum(agent, NESTED_CREDIT_KEYS) ?? pickNum(chat.run, CREDIT_KEYS);
  if (credits != null) out.credits = credits;
  const tokens = pickNum(agent, NESTED_TOKEN_KEYS) ?? pickNum(chat.run, TOKEN_KEYS);
  if (tokens != null) out.tokens = tokens;
  out.ms =
    (agent ? timeMs(agent.lastActivityAt) : null) ??
    jsonTime(chat.run) ??
    mtimeMs(chat.runFile) ??
    jsonTime(chat.meta || {}) ??
    mtimeMs(chat.metaFile);
  return out;
}

// Freebuff usage from the local store. Returns {agent:'freebuff',
// available:true, today, last24h, total, limits, note}, or
// {agent:'freebuff', available:false, status:'local data not available'}
// when no chat run state exists. `now` is ms epoch.
export function readFreebuffUsage({ home = os.homedir(), now = Date.now() } = {}) {
  const chats = chatDirs(path.join(home, ".config", "manicode"));
  if (!chats.length) {
    return { agent: "freebuff", available: false, status: "local data not available" };
  }

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const dayAgoMs = now - DAY;

  const total = { chats: 0 };
  const today = { chats: 0 };
  const last24h = { chats: 0 };
  const limits = [];

  for (const chat of chats) {
    const usage = chatUsage(chat);
    total.chats += 1;
    if (usage.credits != null) total.credits = (total.credits || 0) + usage.credits;
    if (usage.tokens != null) total.tokens = (total.tokens || 0) + usage.tokens;
    if (usage.ms != null) {
      for (const [bucket, from] of [[today, todayMs], [last24h, dayAgoMs]]) {
        if (usage.ms < from) continue;
        bucket.chats += 1;
        if (usage.credits != null) bucket.credits = (bucket.credits || 0) + usage.credits;
        if (usage.tokens != null) bucket.tokens = (bucket.tokens || 0) + usage.tokens;
      }
    }
    for (const source of [mainAgentState(chat.run), chat.run, chat.meta]) {
      if (!source) continue;
      for (const key of LIMIT_KEYS) {
        const v = source[key];
        if (v != null && !limits.some((l) => JSON.stringify(l) === JSON.stringify(v))) limits.push(v);
      }
    }
  }

  return {
    agent: "freebuff",
    available: true,
    today,
    last24h,
    total,
    limits,
    note: limits.length
      ? "Plan limits found in local files; they may be stale — freebuff's live rate limits are cloud-only."
      : "Plan rate limits and reset windows are cloud-only; this reads freebuff's local run state (creditsUsed, contextTokenCount) and nothing else.",
  };
}

// CLI: node bin/freebuff-usage.mjs prints the usage as JSON.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  console.log(JSON.stringify(readFreebuffUsage({ home: os.homedir(), now: Date.now() }), null, 2));
}
