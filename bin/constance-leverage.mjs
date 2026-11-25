// Constance's leverage meter: how many tokens her free workers burn per 1% of
// her own Claude session window. The target is TARGET_PER_PCT tokens per point —
// enough delegated work per point of Opus spent that handing jobs off pays.
//
// sessionSpent() turns a series of Claude session readings (used = 0..1 of the
// window, resets included) into percentage points spent; addSample/readSamples
// keep those readings in a small JSON-lines file; leverage() turns worker
// tokens plus spent points into the per-1% number and a one-line label.
// handoffReturns() groups finished jobs by agent and size to show which
// handoffs got accepted cheapest, and bestReturnLesson() turns the best group
// into one sentence for her lessons.
import fs from "node:fs";
import path from "node:path";
import { fmtTokens } from "./constance-tokens.mjs";

export const TARGET_PER_PCT = 5e6;    // free-agent tokens per 1% of her session
export const TARGET_PER_SESSION = 1e9;
const MAX_LINES = 2000;
const MIN_SPENT_PCT = 0.5;           // below this, per-1% math gives silly numbers

// Percentage points of the session window spent across `samples`
// ([{ at, used }], used a 0..1 fraction, in time order). Every rise counts;
// when used drops the window reset and the new reading counts from 0.
// Samples whose used isn't a finite number are ignored.
export function sessionSpent(samples) {
  let spent = 0, prev = null;
  for (const s of samples || []) {
    const u = s && typeof s.used === "number" ? s.used : NaN;
    if (!Number.isFinite(u)) continue;
    if (prev === null) { prev = u; continue; }
    if (u < prev) spent += u * 100;                    // reset: count from 0
    else if (u > prev) spent += (u - prev) * 100;
    prev = u;
  }
  return Math.round(spent * 1e9) / 1e9;   // drop float dust like 30.000000000000004
}

// The meter itself. perPct is null while too little of her session is spent
// to measure (or when worker tokens aren't known); perSession extrapolates
// perPct to a whole window and vsTarget is perPct / TARGET_PER_PCT.
export function leverage({ tokens, spentPct, name = "Opus" } = {}) {
  const pct = Number.isFinite(spentPct) ? spentPct : 0;
  const perPct = pct >= MIN_SPENT_PCT && Number.isFinite(tokens) ? tokens / pct : null;
  const perSession = perPct === null ? null : perPct * 100;
  const vsTarget = perPct === null ? null : perPct / TARGET_PER_PCT;
  const label = perPct === null
    ? (pct < MIN_SPENT_PCT ? `not enough ${name} spent to measure yet` : "no worker tokens to measure yet")
    : `${fmtTokens(perPct)} per 1% (target ${fmtTokens(TARGET_PER_PCT)})`;
  return { tokens, spentPct: pct, perPct, perSession, vsTarget, label };
}

// ---------------------------------------------------------------- samples file

export function addSample(file, { at, used } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ at, used }) + "\n");
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  if (lines.length > MAX_LINES) fs.writeFileSync(file, lines.slice(-MAX_LINES).join("\n") + "\n");
}

// The stored samples, oldest first; `sinceAt` (when finite) drops older ones.
// Broken lines are skipped.
export function readSamples(file, sinceAt) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line);
      if (!s || typeof s !== "object") continue;
      if (Number.isFinite(sinceAt) && !(Number(s.at) >= sinceAt)) continue;
      out.push(s);
    } catch {}
  }
  return out;
}

// ---------------------------------------------------------------- handoff returns

const bucketOf = (j) => {
  const n = Array.isArray(j.files) ? j.files.length : 0;
  return n === 0 ? "read-only" : n === 1 ? "1 file" : n <= 3 ? "2-3 files" : "4+ files";
};

// A job's token count whether it was kept as a bare number or { n };
// null when the job never reported one.
const tokensOf = (j) => {
  const t = j && j.tokens;
  if (Number.isFinite(t)) return t;
  if (t && Number.isFinite(t.n)) return t.n;
  return null;
};

// Finished jobs grouped by "agent, size bucket". Only accepted jobs count
// toward tokens; perJob is tokens per accepted job, null when nothing was
// accepted or no accepted job reported tokens (unknown is never "free").
// Sorted best first: fewest tokens per accepted job.
export function handoffReturns(jobs = []) {
  const groups = new Map();
  for (const j of jobs || []) {
    if (!j) continue;
    const key = `${j.agent || "?"}, ${bucketOf(j)}`;
    const g = groups.get(key) || { key, jobs: 0, tokens: 0, accepted: 0, tokN: 0 };
    g.jobs += 1;
    if (j.verdict === "accept") {
      g.accepted += 1;
      const t = tokensOf(j);
      if (t !== null) { g.tokens += t; g.tokN += 1; }
    }
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => {
      const { tokN, ...rest } = g;
      return { ...rest, perJob: g.accepted && tokN ? g.tokens / g.accepted : null };
    })
    .sort((a, b) => (a.perJob ?? Infinity) - (b.perJob ?? Infinity) || a.key.localeCompare(b.key));
}

// One plain sentence naming the cheapest accepted handoff, or "" until at
// least 3 jobs were accepted overall (a lesson from one or two is noise).
export function bestReturnLesson(jobs = []) {
  const accepted = (jobs || []).filter((j) => j && j.verdict === "accept").length;
  if (accepted < 3) return "";
  const best = handoffReturns(jobs)[0];
  if (!best || best.perJob === null) return "";
  return `Best handoff return: ${best.key} averages ${fmtTokens(best.perJob)} tokens per accepted job.`;
}
