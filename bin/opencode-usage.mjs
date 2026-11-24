// OpenCode's own usage, read from its message database — no network, no
// credentials. OpenCode (the SST opencode CLI, v2 store) keeps every reply in
// a SQLite file at $XDG_DATA_HOME/opencode/opencode.db (OPENCODE_DB overrides;
// opencode-v2.db is the pre-rename fallback). Each assistant/compaction row's
// `data` JSON carries providerID/modelID (or a nested `model` object), a
// `tokens` object {input, output, reasoning, cache:{read,write}}, and
// `time.created` in milliseconds; the row's own time_created is the fallback.
// The legacy v1 store keeps the same JSON in `message.data`.
// Plan limits are NOT in this file — OpenCode's meters live behind its usage
// endpoint, which this collector never calls — so limits is always [].
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DAY = 86400000;
// Same plausibility window Omarchy's reader uses for opencode timestamps.
const MIN_MS = Date.UTC(2000, 0, 1);
const MAX_MS = Date.UTC(2100, 0, 1);

// Same resolution as Omarchy's opencode collector and bin/folder-usage.py.
export function opencodeDbPath({ home = os.homedir(), env = process.env } = {}) {
  const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const root = path.join(dataHome, "opencode");
  const configured = String(env.OPENCODE_DB || "").trim();
  if (configured) {
    const expanded = configured.startsWith("~") ? path.join(home, configured.slice(1)) : configured;
    return path.isAbsolute(expanded) ? expanded : path.join(root, expanded);
  }
  const normal = path.join(root, "opencode.db");
  const legacy = path.join(root, "opencode-v2.db");
  return fs.existsSync(normal) ? normal : legacy;
}

const localDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const lastDays = (n, now) => Array.from({ length: n }, (_, i) => localDate(now - (n - 1 - i) * DAY));

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const inRange = (ms) => (ms >= MIN_MS && ms <= MAX_MS ? ms : null);

// One reply's spend, split the way Omarchy's reader does: reasoning rides
// with output, cache reads/writes are their own counts.
export function opencodeTokens(entry) {
  const tokens = obj(obj(entry).tokens);
  const cache = obj(tokens.cache);
  return {
    input: num(tokens.input),
    output: num(tokens.output) + num(tokens.reasoning),
    cacheRead: num(cache.read),
    cacheWrite: num(cache.write),
  };
}

// The model id as the panel shows it: last path segment, variant suffix
// (":high") dropped — same normalization Omarchy applies.
export function opencodeModelName(entry) {
  const e = obj(entry);
  const nested = obj(e.model);
  const raw = String(e.modelID || nested.id || nested.modelID || "").trim();
  const name = raw.split("/").pop().split(":")[0].trim();
  if (!name) return "";
  return name.slice(0, 3).toLowerCase() === "glm" ? "GLM" + name.slice(3) : name;
}

// When the reply happened, ms. entry.time.created is authoritative; a row
// with no time of its own falls back to the row's time_created; no time at
// all is "now" (today), an untrusted one skips the row (null) — Omarchy's rule.
function entryTime(entry, rowCreated, now) {
  const own = obj(obj(entry).time).created;
  if (own !== undefined && own !== null) {
    const ms = num(own);
    return ms ? inRange(ms) : null;
  }
  if (rowCreated !== undefined && rowCreated !== null) {
    const ms = num(rowCreated);
    return ms ? inRange(ms) : null;
  }
  return now;
}

// Pure: entries [{createdMs, model, input, output, cacheRead, cacheWrite}]
// -> { days (last 30 local days, oldest first; 0 = the store reported no
//      records that day), models (last 7 calendar days, per model id),
//      limits: [] }.
export function summarizeOpencodeUsage(entries, now = Date.now()) {
  const byDay = {}, byModel = {};
  const daySet = new Set(lastDays(30, now));
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const weekStart = midnight.getTime() - 6 * DAY;
  for (const e of entries || []) {
    const total = num(e.input) + num(e.output) + num(e.cacheRead) + num(e.cacheWrite);
    if (!total || !Number.isFinite(e.createdMs)) continue;
    const day = localDate(e.createdMs);
    if (daySet.has(day)) byDay[day] = (byDay[day] || 0) + total;
    if (e.createdMs >= weekStart) {
      const name = String(e.model || "").trim() || "unknown";
      byModel[name] = (byModel[name] || 0) + total;
    }
  }
  return {
    days: lastDays(30, now).map((date) => ({ date, tokens: byDay[date] || 0 })),
    models: byModel,
    limits: [],
  };
}

function tableColumns(conn, table) {
  try {
    return new Set(conn.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
  } catch {
    return new Set();
  }
}

function collectEntries(dbPath, now) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  const entries = [];
  const seen = new Set();
  let foundStore = false;
  const add = (id, sessionId, rowType, entry, rowCreated) => {
    if (rowType !== "assistant" && rowType !== "compaction") return;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const t = opencodeTokens(entry);
    if (!(t.input + t.output + t.cacheRead + t.cacheWrite)) return;
    const createdMs = entryTime(entry, rowCreated, now);
    if (createdMs === null) return;
    const key = String(id ?? `${sessionId}:${rowType}:${createdMs}`);
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ createdMs, model: opencodeModelName(entry), ...t });
  };
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    // V2 store first (session_message -> session_v2), then the v1 store
    // (message -> session); a migrated message can sit in both under one id.
    if (tables.has("session_message")) {
      const cols = tableColumns(db, "session_message");
      if (cols.has("id") && cols.has("session_id") && cols.has("type") && cols.has("data")) {
        foundStore = true;
        const created = cols.has("time_created") ? "m.time_created" : "NULL";
        const rows = db.prepare(
          `SELECT m.id, m.session_id, m.type, m.data, ${created} AS row_created FROM session_message m WHERE m.type IN ('assistant','compaction') AND m.data LIKE '%"tokens"%'`,
        ).all();
        for (const r of rows) {
          let entry;
          try { entry = JSON.parse(r.data); } catch { continue; }
          add(r.id, r.session_id, r.type, entry, r.row_created);
        }
      }
    }
    if (tables.has("message")) {
      const cols = tableColumns(db, "message");
      if (cols.has("session_id") && cols.has("data")) {
        foundStore = true;
        const idCol = cols.has("id") ? "m.id" : "m.rowid";
        const created = cols.has("time_created") ? "m.time_created" : "NULL";
        const rows = db.prepare(
          `SELECT ${idCol} AS id, m.session_id, m.data, ${created} AS row_created FROM message m WHERE m.data LIKE '%"tokens"%'`,
        ).all();
        for (const r of rows) {
          let entry;
          try { entry = JSON.parse(r.data); } catch { continue; }
          add(r.id, r.session_id, entry && typeof entry === "object" ? entry.role : "", entry, r.row_created);
        }
      }
    }
    return foundStore ? entries : null;
  } catch {
    return null;
  } finally {
    try { db.close(); } catch {}
  }
}

export function readOpencodeUsage({ home = os.homedir(), env = process.env, now = Date.now() } = {}) {
  const dbPath = opencodeDbPath({ home, env });
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  const entries = collectEntries(dbPath, now);
  if (entries === null) return null;
  return summarizeOpencodeUsage(entries, now);
}
