// Qwen Code keeps its usage on disk as chat transcripts: every billed API
// response lands as a JSONL record under <runtime>/projects/<project>/chats/
// <session>.jsonl. <runtime> is QWEN_RUNTIME_DIR or settings.json's
// advanced.runtimeOutputDir when set, else QWEN_HOME or ~/.qwen (the "qwen
// home"). A record that counts is {"type":"system","subtype":"ui_telemetry",
// "systemPayload":{"uiEvent":{...}}} with event.name "qwen-code.api_response",
// carrying model, auth_type, event.timestamp and the provider's token counts
// (input/cached/output/thoughts/total_token_count). Format verified against
// the installed @qwen-code/qwen-code package and Omarchy's own reader
// (omarchy-agent-usage-qwen). *.ledger.jsonl files sit beside transcripts and
// repeat nothing billable, so they are skipped. Neither Qwen Code nor Alibaba
// publishes a readable plan quota, so limits is always empty.
// Read-only: opens transcripts and settings.json only, never credentials,
// never writes, never spawns anything.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const API_RESPONSE = "qwen-code.api_response";
// Qwen Code's own rule (getEventTotalTokenCount / outputIncludesThoughts):
// a response's total wins when present; otherwise thinking counts on top of
// the output only where the output leaves it out.
const THOUGHTS_IN_OUTPUT = new Set(["openai", "openai-responses", "qwen-oauth"]);
const DAY_MS = 86400000;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function eventTokens(e) {
  const total = num(e.total_token_count);
  if (total > 0) return total;
  const input = num(e.input_token_count) || num(e.cached_content_token_count);
  const thoughts = THOUGHTS_IN_OUTPUT.has(String(e.auth_type || "")) ? 0 : num(e.thoughts_token_count);
  return input + num(e.output_token_count) + thoughts;
}

function localDay(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function lastDays(now, count) {
  const end = new Date(now);
  const days = [];
  for (let i = count - 1; i >= 0; i--) days.push(localDay(new Date(end.getFullYear(), end.getMonth(), end.getDate() - i).getTime()));
  return days;
}

// One transcript's JSONL text -> billed-response entries
// {key, copy, at, model, tokens}; at is ms or null when the record carries no
// usable time (the caller dates it by the file's mtime, as Qwen Code's own
// statistics do). Pure: no fs, no env.
export function parseQwenUsageText(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.includes(API_RESPONSE)) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || record.type !== "system" || record.subtype !== "ui_telemetry") continue;
    const payload = record.systemPayload;
    const event = payload && typeof payload === "object" ? payload.uiEvent : null;
    if (!event || event["event.name"] !== API_RESPONSE) continue;
    const tokens = eventTokens(event);
    if (tokens <= 0) continue;
    const stamp = Date.parse(event["event.timestamp"] ?? record.timestamp ?? "");
    const model = String(event.model || "").trim();
    const key = String(record.uuid || event.response_id || "");
    if (!key) continue; // a forked session repeats records verbatim; with no id we can't dedup them
    out.push({ key, copy: record.forkedFrom != null, at: Number.isFinite(stamp) ? stamp : null, model, tokens });
  }
  return out;
}

function resolveDir(value, home) {
  if (typeof value !== "string" || !value.trim()) return null;
  let v = value.trim();
  if (v === "~" || v.startsWith("~/")) v = path.join(home, v.slice(1));
  return path.isAbsolute(v) ? v : null;
}

function qwenHome(home, env) {
  return resolveDir(env.QWEN_HOME, home) || path.join(home, ".qwen");
}

function runtimeDirs(home, env) {
  const qhome = qwenHome(home, env);
  let runtimeOutputDir = null;
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(qhome, "settings.json"), "utf8"));
    runtimeOutputDir = resolveDir(settings?.advanced?.runtimeOutputDir, home);
  } catch {}
  const dirs = [];
  for (const d of [resolveDir(env.QWEN_RUNTIME_DIR, home), runtimeOutputDir, qhome]) {
    if (d && !dirs.includes(d)) dirs.push(d);
  }
  return dirs;
}

function chatFiles(dirs) {
  const files = [];
  for (const base of dirs) {
    let projects = [];
    try { projects = fs.readdirSync(path.join(base, "projects")); } catch { continue; }
    for (const project of projects) {
      let chats = [];
      try { chats = fs.readdirSync(path.join(base, "projects", project, "chats")); } catch { continue; }
      for (const name of chats) {
        if (!name.endsWith(".jsonl") || name.endsWith(".ledger.jsonl")) continue;
        const file = path.join(base, "projects", project, "chats", name);
        if (!files.includes(file)) files.push(file);
      }
    }
  }
  return files;
}

function modelLabel(raw) {
  const value = String(raw || "").replace(/\/+$/, "").split("/").pop();
  return value && value.length <= 120 ? value : null;
}

// {days:[{date,tokens}] for the last 30 local days, models:{name:tokens} over
// the last 7, limits:[]} or null when no transcript is readable.
export function readQwenUsage({ home = os.homedir(), env = process.env, now = Date.now() } = {}) {
  const files = chatFiles(runtimeDirs(home, env));
  const entries = new Map(); // key -> entry; a fork's copy yields to the original
  let storePresent = false;
  for (const file of files) {
    let text, mtime;
    try {
      text = fs.readFileSync(file, "utf8");
      mtime = fs.statSync(file).mtimeMs;
    } catch { continue; }
    storePresent = true;
    for (const e of parseQwenUsageText(text)) {
      if (e.at === null) e.at = mtime;
      const prev = entries.get(e.key);
      if (prev && !(prev.copy && !e.copy)) continue;
      entries.set(e.key, e);
    }
  }
  if (!storePresent) return null;

  const daySet = new Set(lastDays(now, 30));
  const weekSet = new Set(lastDays(now, 7));
  const days = new Map();
  const models = {};
  for (const e of entries.values()) {
    const day = localDay(e.at);
    if (!daySet.has(day)) continue;
    days.set(day, (days.get(day) || 0) + e.tokens);
    if (weekSet.has(day)) {
      const label = modelLabel(e.model);
      if (label) models[label] = (models[label] || 0) + e.tokens;
    }
  }
  return {
    days: lastDays(now, 30).map((date) => ({ date, tokens: days.get(date) || 0 })),
    models,
    limits: [],
  };
}
