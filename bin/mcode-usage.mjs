// MiniMax Code's (mcode) usage, read from its own session transcripts.
// Store (verified against Omarchy's omarchy-agent-usage-minimax reader and the
// installed @minimax-ai/code package): one directory per session under
// <data-dir>/v2/sessions, each holding messages.jsonl — one JSON object per
// line. Assistant lines carry message.role "assistant", message.model,
// message.provider (its own routes are "minimax"/"minimax_api"/"minimax_oauth",
// third-party ones "custom_provider:<name>"), and message.usage with
// input/output/cacheRead/cacheWrite/totalTokens counts. The day comes from
// message.timestamp, else the line's own timestamp (epoch s/ms or ISO).
// The data dir is $MINIMAX_DATA_DIR, else $MAVIS_DATA_DIR, else ~/.minimax.
// Plan limits are NOT in these files (they come from MiniMax's quota API), so
// limits is always []. Read-only: nothing here writes, refreshes or prints a
// credential, and nothing here makes a network call.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const num = (v) => {
  if (typeof v === "boolean" || typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
  return v;
};

const dayString = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// The local calendar day a timestamp lands on, or null when it can't be
// trusted. Epoch seconds and milliseconds, a string of digits, and ISO times
// are read — same rules as Omarchy's local_day().
export function localDay(value, nowMs = Date.now()) {
  if (value === null || value === undefined) {
    // No stamp: Omarchy books the line on today rather than dropping it.
    return dayString(new Date(nowMs));
  }
  let ms;
  if (typeof value === "string" && /^[0-9]{1,20}$/.test(value.trim())) value = Number(value.trim());
  if (typeof value === "boolean") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    ms = value > 10_000_000_000 ? value : value * 1000;
  } else {
    const t = Date.parse(String(value).trim());
    if (!Number.isFinite(t)) return null;
    ms = t;
  }
  const d = new Date(Math.floor(ms));
  if (d.getFullYear() < 2000 || d.getFullYear() > 2100) return null;
  return dayString(d);
}

// The tokens one usage object reports: every bucket MiniMax Code writes, so
// cache reads/writes count too. 0 when there is no usage or it is all zero.
export function messageTokens(usage) {
  if (!usage || typeof usage !== "object") return 0;
  const input = num(usage.input);
  const output = num(usage.output);
  const cacheRead = num(usage.cacheRead);
  const cacheWrite = num(usage.cacheWrite);
  if (input || output || cacheRead || cacheWrite) return input + output + cacheRead + cacheWrite;
  // Only a grand total was written: MiniMax's input excludes the cache
  // buckets, which keep their own counts — take it as reported.
  return num(usage.totalTokens);
}

// Adds one messages.jsonl's assistant replies to `acc` ({days, models7}).
// Pure: takes the file's text plus the window start, returns nothing.
export function addMcodeMessages(text, acc, nowMs = Date.now()) {
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  // Calendar days, not fixed 86400000 ms steps: across a DST change a local
  // day is 23 or 25 hours, and ms steps would skip or repeat a date.
  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - 6);
  const weekStartDay = dayString(weekStart);
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // one damaged line loses only itself
    }
    const message = entry && typeof entry === "object" ? entry.message : null;
    if (!message || typeof message !== "object" || message.role !== "assistant") continue;
    const tokens = messageTokens(message.usage);
    if (!tokens) continue;
    const day = localDay(message.timestamp ?? entry.timestamp, nowMs);
    if (!day) continue;
    acc.days[day] = (acc.days[day] || 0) + tokens;
    const model = String(message.model || entry.model || "").trim() || "unknown";
    if (day >= weekStartDay) {
      acc.models[model] = (acc.models[model] || 0) + tokens;
    }
  }
}

// Every messages.jsonl under `dir`, recursively (Omarchy's reader walks the
// whole sessions tree the same way; one session dir each in practice).
function* messageFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* messageFiles(p);
    else if (e.isFile() && e.name === "messages.jsonl") yield p;
  }
}

// Reads the sessions store at `root` (the v2/sessions dir). Returns null when
// the store can't be listed at all; otherwise the full shape — days the files
// report nothing for are 0 because the store is present.
export function mcodeUsageFromSessions(root, nowMs = Date.now()) {
  try {
    fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const acc = { days: {}, models: {} };
  for (const file of messageFiles(root)) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue; // an unreadable session loses only itself
    }
    addMcodeMessages(text, acc, nowMs);
  }
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const date = dayString(d);
    days.push({ date, tokens: acc.days[date] || 0 });
  }
  return { days, models: acc.models, limits: [] };
}

function dataDir(home, env) {
  for (const name of ["MINIMAX_DATA_DIR", "MAVIS_DATA_DIR"]) {
    const value = String(env[name] || "").trim();
    if (value) return path.resolve(home, value.startsWith("~") ? home + value.slice(1) : value);
  }
  return path.join(home, ".minimax");
}

export function readMcodeUsage({ home = os.homedir(), env = process.env, now = Date.now() } = {}) {
  return mcodeUsageFromSessions(path.join(dataDir(home, env), "v2", "sessions"), now);
}
