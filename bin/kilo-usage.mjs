// Kilo's local usage, read straight from its own SQLite store — no network,
// no credentials, nothing opened for writing. Kilo (the `kilo` CLI, an
// opencode fork) keeps its data at <data-home>/kilo/kilo.db
// (~/.local/share/kilo/kilo.db; XDG_DATA_HOME moves the data home). The
// `message` table's `data` JSON carries one row per message with
// role/time/modelID/providerID/cost/tokens; `requests` counts the assistant
// rows. The `session` table carries per-session cost and
// tokens_input/tokens_output/tokens_reasoning totals and is only a fallback
// for a db that has no usable message table (a session has no per-request
// time, so its requests count stays null — never invented).
// Plan limits are NOT in this file, so there is no limits field at all:
// nothing here reports a number the db does not hold.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const DAY = 86400000;
// Same plausibility window the other local readers use.
const MIN_MS = Date.UTC(2000, 0, 1);
const MAX_MS = Date.UTC(2100, 0, 1);

export function kiloDbPath({ home = os.homedir(), env = process.env } = {}) {
  const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(dataHome, "kilo", "kilo.db");
}

const localDate = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const inRange = (ms) => (ms >= MIN_MS && ms <= MAX_MS ? ms : null);

// A timestamp the db may hold as epoch ms, epoch s, an epoch string, or an
// ISO time -> ms, or null when it can't be trusted.
function toMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && /^[0-9]{1,20}$/.test(value.trim())) value = Number(value.trim());
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return inRange(value > 1e11 ? value : value * 1000);
  }
  const t = Date.parse(String(value).trim());
  return Number.isFinite(t) ? inRange(t) : null;
}

// One assistant message's tokens. Kilo is opencode-based, so `tokens` is the
// opencode shape {input, output, reasoning, cache:{read,write}}; the flat
// *Tokens spellings are tolerated too. A bare number is taken as reported.
export function kiloTokens(entry) {
  const e = obj(entry);
  const t = e.tokens;
  if (typeof t === "number") return num(t);
  const tok = obj(t);
  const cache = obj(tok.cache);
  return (
    num(tok.input ?? tok.inputTokens ?? tok.input_tokens) +
    num(tok.output ?? tok.outputTokens ?? tok.output_tokens) +
    num(tok.reasoning ?? tok.reasoningTokens ?? tok.reasoning_tokens) +
    num(cache.read ?? cache.readTokens ?? cache.read_tokens) +
    num(cache.write ?? cache.writeTokens ?? cache.write_tokens)
  );
}

export function kiloCost(entry) {
  return num(obj(entry).cost);
}

export function kiloModel(entry) {
  const raw = String(obj(entry).modelID || "").trim();
  return raw || "unknown";
}

// When the message happened, ms. data.time is authoritative (opencode writes
// {created, completed}; a bare number/string works too); the row's
// time_created is the fallback; no time at all is "now" — the same rule
// Omarchy's opencode reader uses. An untrusted time skips the row (null).
function entryTime(entry, rowCreated, now) {
  const t = obj(entry).time;
  const own = t && typeof t === "object" ? t.created ?? t.completed : t;
  if (own !== undefined && own !== null && own !== "") return toMs(own);
  if (rowCreated !== undefined && rowCreated !== null) return toMs(rowCreated);
  return now;
}

function tableColumns(conn, table) {
  try {
    return new Set(conn.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
  } catch {
    return new Set();
  }
}

const UNAVAILABLE = { agent: "kilo", available: false, status: "local data not available" };

// Pure: usage events [{ms, model, tokens, cost}] -> the report shape.
// requests counts the events; models is every model seen, most tokens first.
export function summarizeKiloUsage(events, now = Date.now()) {
  const today = localDate(now);
  const buckets = { today: { tokens: 0, requests: 0, cost: 0 }, last24h: { tokens: 0, requests: 0, cost: 0 }, total: { tokens: 0, requests: 0, cost: 0 } };
  const models = new Map();
  for (const e of events || []) {
    const tokens = num(e.tokens), cost = num(e.cost);
    buckets.total.tokens += tokens;
    buckets.total.cost += cost;
    buckets.total.requests += 1;
    const model = String(e.model || "unknown");
    const m = models.get(model) || { model, requests: 0, tokens: 0, cost: 0 };
    m.requests += 1;
    m.tokens += tokens;
    m.cost += cost;
    models.set(model, m);
    if (!Number.isFinite(e.ms)) continue;
    if (localDate(e.ms) === today) {
      buckets.today.tokens += tokens;
      buckets.today.cost += cost;
      buckets.today.requests += 1;
    }
    if (e.ms > now - DAY && e.ms <= now) {
      buckets.last24h.tokens += tokens;
      buckets.last24h.cost += cost;
      buckets.last24h.requests += 1;
    }
  }
  return {
    agent: "kilo",
    available: true,
    today: buckets.today,
    last24h: buckets.last24h,
    total: buckets.total,
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens || b.requests - a.requests),
  };
}

// Assistant rows from the `message` table -> usage events. Returns null when
// the table can't serve as the store (missing or no `data` column).
function messageEvents(db, now) {
  const cols = tableColumns(db, "message");
  if (!cols.has("data")) return null;
  const idCol = cols.has("id") ? "m.id" : "m.rowid";
  const created = cols.has("time_created") ? "m.time_created" : "NULL";
  const rows = db.prepare(
    `SELECT ${idCol} AS id, ${created} AS row_created, m.data FROM message m WHERE m.data LIKE '%assistant%'`,
  ).all();
  const events = [];
  const seen = new Set();
  for (const r of rows) {
    let entry;
    try {
      entry = JSON.parse(r.data);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object" || entry.role !== "assistant") continue;
    const ms = entryTime(entry, r.row_created, now);
    if (ms === null) continue;
    const key = String(r.id ?? `${ms}:${kiloModel(entry)}`);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ ms, model: kiloModel(entry), tokens: kiloTokens(entry), cost: kiloCost(entry) });
  }
  return events;
}

// Fallback for a db with no usable message table: one event per `session`
// row, timed by the session's last-write column when the table has one.
// requests stays null — a session is not a request and the db doesn't say
// how many assistant calls it held.
function sessionEvents(db, now) {
  const cols = tableColumns(db, "session");
  const tokenCols = ["tokens_input", "tokens_output", "tokens_reasoning"].filter((c) => cols.has(c));
  if (!cols.has("cost") && !tokenCols.length) return null;
  const timeCol = ["time_updated", "time_created", "updated_at", "created_at"].find((c) => cols.has(c));
  const sums = tokenCols.map((c) => `COALESCE(${c},0)`).join(" + ") || "0";
  const cost = cols.has("cost") ? "COALESCE(cost,0)" : "0";
  const time = timeCol ? `s.${timeCol}` : "NULL";
  const rows = db.prepare(`SELECT ${time} AS row_created, (${sums}) AS tokens, ${cost} AS cost FROM session s`).all();
  const events = [];
  for (const r of rows) {
    const ms = r.row_created === null || r.row_created === undefined ? null : toMs(r.row_created);
    if (r.row_created !== null && r.row_created !== undefined && ms === null) continue;
    events.push({ ms: ms ?? now, model: "unknown", tokens: num(r.tokens), cost: num(r.cost), session: true });
  }
  return events;
}

export function readKiloUsage({ home = os.homedir(), env = process.env, now = Date.now() } = {}) {
  const dbPath = kiloDbPath({ home, env });
  if (!fs.existsSync(dbPath)) return { ...UNAVAILABLE };
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return { ...UNAVAILABLE };
  }
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    if (!tables.has("message") && !tables.has("session")) return { ...UNAVAILABLE };
    let events = null;
    let sessionsOnly = false;
    if (tables.has("message")) events = messageEvents(db, now);
    if (events === null && tables.has("session")) {
      events = sessionEvents(db, now);
      sessionsOnly = events !== null;
    }
    if (events === null) return { ...UNAVAILABLE };
    const report = summarizeKiloUsage(events, now);
    if (sessionsOnly) {
      // Session fallback: token/cost buckets are real, request counts are not
      // (a session is not a request) and there is no per-model breakdown.
      for (const b of [report.today, report.last24h, report.total]) b.requests = null;
      report.models = [];
    }
    return report;
  } catch {
    return { ...UNAVAILABLE };
  } finally {
    try {
      db.close();
    } catch {}
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = process.argv.slice(2).find((a) => a.startsWith("--home="));
  const home = arg ? arg.slice("--home=".length) : os.homedir();
  console.log(JSON.stringify(readKiloUsage({ home }), null, 2));
}
