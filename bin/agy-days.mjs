// Antigravity's model usage for the last 7 days, read from agy's own transcripts
// (~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript.jsonl).
// Omarchy's record only keeps all-time and today-only model totals; the transcripts date every
// step. Same rules as Omarchy's reader: a step's model carries to later steps until one names
// another ("Model Selection" steps name it the way the picker shows it), and a step that never
// had a model is "unknown". Steps without a date can't be placed in the 7 days and are skipped.
// Antigravity driven from another harness (pi, opencode) isn't in these files and isn't counted.
import fs from "node:fs";
import path from "node:path";

const DAY = 86400000;
const SELECTION = /Model Selection` (?:from .+? )?to (.+?)\.(?:\s|$|<)/;
export const modelKey = (name) => String(name || "").replace(/[()]/g, " ").trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
const n = (v) => { v = Number(v); return Number.isFinite(v) && v > 0 ? v : 0; };

export function stepTokens(s) {
  for (const src of [s?.usage && typeof s.usage === "object" ? s.usage : null, s].filter(Boolean)) {
    if ("prompt_token_count" in src || "candidates_token_count" in src) {
      const prompt = n(src.prompt_token_count), cached = Math.min(prompt, n(src.cached_content_token_count));
      return { input: prompt - cached, output: n(src.candidates_token_count) + n(src.thoughts_token_count), cacheRead: cached, cacheWrite: 0 };
    }
    if (["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"].some((k) => k in src))
      return { input: n(src.input_tokens), output: n(src.output_tokens), cacheRead: n(src.cache_read_tokens), cacheWrite: n(src.cache_write_tokens) };
  }
  return null;
}

// Adds one transcript's steps since `since` (ms) to byModel (Omarchy's modelUsage shape).
export function addTranscript(text, since, byModel) {
  let current = "";
  for (const line of String(text || "").split("\n")) {
    let s; try { s = JSON.parse(line); } catch { continue; }
    if (!s || typeof s !== "object") continue;
    let named = "";
    for (const f of ["model", "model_name", "model_id"]) if (typeof s[f] === "string" && modelKey(s[f])) { named = modelKey(s[f]); break; }
    if (!named && typeof s.content === "string" && s.content.includes("Model Selection")) { const m = SELECTION.exec(s.content); if (m) named = modelKey(m[1]); }
    current = named || current;
    const t = stepTokens(s);
    if (!t || !(t.input || t.output || t.cacheRead || t.cacheWrite)) continue;
    const ts = Date.parse(s.created_at || s.timestamp || "");
    if (!Number.isFinite(ts) || ts < since) continue;
    const b = (byModel[current || "unknown"] ||= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    b.inputTokens += t.input; b.outputTokens += t.output; b.cacheReadInputTokens += t.cacheRead; b.cacheCreationInputTokens += t.cacheWrite;
  }
  return byModel;
}

// null when agy has no transcripts here (the caller keeps Omarchy's all-time numbers).
export function agyLastDays(root, nowMs = Date.now(), days = 7) {
  const brain = path.join(root, "brain");
  let dirs; try { dirs = fs.readdirSync(brain); } catch { return null; }
  // Calendar days like Claude's "last 7 days": from local midnight 6 days ago.
  const start = new Date(nowMs); start.setHours(0, 0, 0, 0); const since = start.getTime() - (days - 1) * DAY;
  const byModel = {}; let found = false;
  for (const d of dirs) {
    const p = path.join(brain, d, ".system_generated", "logs", "transcript.jsonl");
    let st; try { st = fs.statSync(p); } catch { continue; }
    found = true;
    if (st.mtimeMs < since) continue;
    try { addTranscript(fs.readFileSync(p, "utf8"), since, byModel); } catch {}
  }
  return found ? byModel : null;
}
