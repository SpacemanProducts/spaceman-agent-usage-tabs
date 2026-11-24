// DeepSeek Harness (dsh) token usage, read from its own session logs —
// read-only, no network, no credentials. dsh keeps one append-only JSONL
// event log per session under $DSH_HOME/sessions/<project>/<session>/,
// named session.jsonl / session.vN.jsonl, Zstandard-compressed by default
// (.zstd suffix; dsh-session-persistence-jsonl, compression "zstd").
// Each billed model attempt settles as an assistant/message (or a log-only
// assistant/attempt) carrying the provider's usage; the request/header
// before it names the provider route and model. Format verified against the
// installed @deepseek-ai/dsh-session-persistence-jsonl and dsh-token-meter
// sources, and Omarchy's omarchy-agent-usage-deepseek reader.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

// One canonical session log generation: session.jsonl, session.v4.jsonl, and
// their Zstandard twins (same names Omarchy's reader accepts).
const LOG_NAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/;
// The most one log may inflate to; a real log is a few MiB of JSON lines.
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const ZSTD_MAGIC = 0xfd2fb528;

const num = (v) => { v = Number(v); return Number.isFinite(v) && v > 0 ? v : 0; };
const str = (v) => (typeof v === "string" ? v : "");
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
const localDayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// $DSH_HOME when set and non-blank (dsh treats blank as unset), else ~/.dsh;
// "~" expands against the given home.
export function dshHomeDir(home, env = process.env) {
  const configured = str(env?.DSH_HOME).trim();
  if (!configured) return path.join(home, ".dsh");
  const expanded = configured === "~" ? home
    : configured.startsWith("~/") || configured.startsWith("~\\") ? path.join(home, configured.slice(2))
    : configured;
  return path.resolve(expanded);
}

// The current (highest-version) log of each session directory: the layout is
// <root>/<project>/<session>/ and older generations stay only as migration
// history. Returns sorted paths; unreadable directories are skipped.
export function sessionLogFiles(root) {
  const newest = new Map(); // session dir -> { version, path }
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (depth < 4) walk(full, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const match = LOG_NAME.exec(entry.name);
      if (!match) continue;
      const version = match[1] ? Number(match[1]) : 0;
      const current = newest.get(dir);
      if (!current || version > current.version || (version === current.version && entry.name.endsWith(".zstd") && !current.path.endsWith(".zstd")))
        newest.set(dir, { version, path: full });
    }
  };
  walk(root, 0);
  return [...newest.values()].map((v) => v.path).sort();
}

// Structural scan of a concatenated-Zstandard-frames container, ported from
// dsh-session-persistence-jsonl's scanZstdFrames: one checksummed frame per
// header line and per durable append batch. Returns the complete frame
// ranges; a torn or corrupt tail simply ends the scan (its frames are kept).
export function scanZstdFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    const start = offset;
    offset += 4;
    if (offset >= buf.length) break;
    const descriptor = buf.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) break; // reserved frame-header bits: corrupt
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (offset + headerBytes > buf.length) break;
    offset += headerBytes;
    for (;;) {
      if (offset + 3 > buf.length) return { frames };
      const blockHeader = buf.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) return { frames }; // reserved block type: corrupt
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (offset + payloadBytes > buf.length) return { frames };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (offset + 4 > buf.length) return { frames };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

// Every complete frame's plaintext, bounded by MAX_LOG_BYTES; decoding stops
// at the first frame that fails (checksum, corrupt) keeping what came before.
function decompressDshLog(buf) {
  if (typeof zlib.zstdDecompressSync !== "function") return null;
  const { frames } = scanZstdFrames(buf);
  if (!frames.length) return null;
  const chunks = [];
  let total = 0;
  for (const frame of frames) {
    const remaining = MAX_LOG_BYTES - total;
    if (remaining <= 0) break;
    try {
      const out = zlib.zstdDecompressSync(buf.subarray(frame.start, frame.end), { maxOutputLength: remaining });
      chunks.push(out);
      total += out.length;
    } catch { break; }
  }
  return total ? Buffer.concat(chunks) : null;
}

// The usage one durable Assistant settlement reports for its attempt: the
// message's own usage, else the last usage chunk of its stream (the same
// fold dsh's token meter runs).
function usageSample(event) {
  const data = obj(event.data);
  if (!data) return null;
  if (event.type === "assistant/message") {
    const usage = obj(data.usage);
    if (usage) return usage;
  }
  const stream = data.stream;
  if (!Array.isArray(stream)) return null;
  for (let i = stream.length - 1; i >= 0; i--) {
    const record = obj(stream[i]);
    if (!record || record.type !== "chunk") continue;
    const chunk = obj(record.chunk);
    if (chunk && chunk.type === "usage") {
      const usage = obj(chunk.usage);
      if (usage) return usage;
    }
  }
  return null;
}

// Parse one session log's text into billed-attempt samples
// [{ ms, model, tokens: [input, output, cacheRead, cacheWrite] }], or null
// when the text is not a session log. A fork's log opens with a copy of its
// parent's history; the last `session/end-seed` marked inherited is where its
// own spending begins. Pure: no fs, no clock.
export function dshLogSamples(text) {
  const lines = String(text ?? "").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (!lines.length) return null;
  let header;
  try { header = JSON.parse(lines[0]); } catch { return null; }
  if (!obj(header) || header.type !== "session") return null;
  const events = [];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (obj(event)) events.push(event);
    } catch { /* a torn or corrupt line loses only itself */ }
  }
  let start = 0;
  if (header.isSeeded === true) {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === "session/end-seed" && obj(event.data)?.inherited === true) { start = i + 1; break; }
    }
  }
  // One slot per billed attempt, inherited history included so a fork's own
  // settlement can replace a copied streaming sample of the same turn/step.
  const slots = [];
  let provider = "", model = "", last = null;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const data = obj(event.data) || {};
    if (event.type === "request/header") {
      const config = obj(obj(data.header)?.config);
      if (config) { provider = str(config.provider); model = str(config.model); }
      continue;
    }
    if (event.type === "llm/retry-started") {
      if (last && data.turn === last.turn && data.step === last.step) last = null;
      continue;
    }
    if (event.type !== "assistant/message" && event.type !== "assistant/attempt") continue;
    const usage = usageSample(event);
    if (!usage) continue;
    const slot = { turn: data.turn, step: data.step };
    const entry = {
      ms: event.time,
      model: model || provider || "unknown",
      tokens: [num(usage.inputTokens), num(usage.outputTokens), num(usage.cacheReadTokens), num(usage.cacheWriteTokens)],
      counted: i >= start,
    };
    // A settlement replaces the streaming sample of the same turn and step;
    // a retry starts a new attempt, so it adds to the total.
    if (last && last.turn === slot.turn && last.step === slot.step && slots.length) slots[slots.length - 1] = entry;
    else slots.push(entry);
    last = slot;
  }
  return slots.filter((s) => s.counted && s.tokens.some(Boolean))
    .map(({ counted, ...s }) => s);
}

// Read one log file to text: .zstd goes through the frame scanner, plain
// .jsonl is read as UTF-8 (a torn final line just fails to parse). null when
// unreadable, corrupt, or the runtime has no Zstandard support.
function readLogText(file) {
  let data;
  try { data = fs.readFileSync(file); } catch { return null; }
  if (file.endsWith(".zstd")) {
    const out = decompressDshLog(data);
    if (out == null) return null;
    data = out;
  }
  return data.toString("utf8");
}

const totalTokens = (t) => t[0] + t[1] + t[2] + t[3];

// dsh's own usage for the last 30 days (days) and 7 days (models), or null
// when no session log is readable. tokens = input + output + cache read +
// cache write, summed over every billed attempt the logs report, whatever
// provider route served it — the harness's own usage. dsh stores no plan
// limits (it is bring-your-own-key), so limits is always [].
export function readDshUsage({ home = os.homedir(), env = process.env, now = Date.now() } = {}) {
  const root = path.join(dshHomeDir(home, env), "sessions");
  const logs = sessionLogFiles(root);
  if (!logs.length) return null;
  const samples = [];
  let parsed = 0;
  for (const file of logs) {
    const text = readLogText(file);
    if (text == null) continue;
    const got = dshLogSamples(text);
    if (got == null) continue;
    parsed++;
    for (const s of got) {
      if (Number.isFinite(s.ms)) samples.push(s);
    }
  }
  if (!parsed) return null;

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = [];
  const byDay = new Map();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = localDayKey(d.getTime());
    const entry = { date: key, tokens: 0 };
    days.push(entry);
    byDay.set(key, entry);
  }
  const weekStartDate = new Date(today);
  weekStartDate.setDate(today.getDate() - 6);
  const weekStart = localDayKey(weekStartDate.getTime());
  const models = {};
  for (const s of samples) {
    const key = localDayKey(s.ms);
    const day = byDay.get(key);
    const total = totalTokens(s.tokens);
    if (day) day.tokens += total;
    if (key >= weekStart) models[s.model] = (models[s.model] || 0) + total;
  }
  return { days, models, limits: [] };
}
