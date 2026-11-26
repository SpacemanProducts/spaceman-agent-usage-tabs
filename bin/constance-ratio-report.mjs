// Constance's ratio report: after a goal, one honest look at how the free
// copies' tokens, her own Opus routing and slot idleness came out per point
// of her session window spent.
//
// ratioReport() turns a goal's jobs (tokens plus start/finish times), its step
// routes ({step, model, tokens?} — tokens summed when reported, step counts
// otherwise), slot samples ({at, copiesRunning}) and her session pct before
// and after into the report: workerTokens (kept as devinTokens for older
// callers), perPct, opusByStep, copiesAvg,
// idleSlotMinutes, topFixes and a plain-text summary. saveReport() appends it
// to dir/history.jsonl as {kind:'ratio', ...} and returns 1-3 lesson lines
// for the worst items. Pure functions; the only I/O is the history append.
import fs from "node:fs";
import path from "node:path";
import { fmtTokens } from "./constance-tokens.mjs";
import { TARGET_PER_PCT } from "./constance-leverage.mjs";

const STEPS = ["planning", "specs", "reviews", "fixes"];
const MIN_SPENT_PCT = 0.5;      // same floor as the leverage meter: below it per-1% is silly
const IDLE_FLAG_MIN = 15;        // idle slot-minutes worth a fix line
const OPUS_REVIEW_FLAG = 0.5;    // more than half of review work still on Opus
const SENDBACK_FLAG = 0.3;       // more than 30% of decided jobs sent back

// A job's token count whether kept as a bare number or { n }; null when the
// job never reported one (unknown is never zero).
const tokensOf = (j) => {
  const t = j && j.tokens;
  if (Number.isFinite(t)) return t;
  if (t && Number.isFinite(t.n)) return t.n;
  return null;
};

const isOpus = (model) => /opus/i.test(String(model || ""));
const stepOf = (r) => String(r && r.step || "").toLowerCase();

// Per step: { total, opus, share }. A step measured in tokens when any of its
// route rows carries tokens (rows without one add 0), else in step counts.
// share is the Opus fraction of that same measure; null when the step never
// ran. Steps outside the known four are ignored.
function opusByStep(routes = []) {
  const out = {};
  for (const step of STEPS) {
    const rows = (routes || []).filter((r) => stepOf(r) === step);
    const tokenMode = rows.some((r) => Number.isFinite(r && r.tokens));
    const unit = (r) => (tokenMode ? (Number.isFinite(r && r.tokens) ? r.tokens : 0) : 1);
    const total = rows.reduce((n, r) => n + unit(r), 0);
    const opus = rows.filter((r) => isOpus(r && r.model)).reduce((n, r) => n + unit(r), 0);
    out[step] = { total, opus, share: total ? opus / total : null, unit: tokenMode ? "tokens" : "steps" };
  }
  return out;
}

// Slot-idle minutes: each gap between consecutive samples (sorted by `at`)
// contributes (slots - copiesRunning at the gap's start) slot-minutes, never
// negative. Rounded to a tenth of a minute.
export function idleMinutes(samples = [], slots = 10) {
  const rows = (samples || []).filter((s) => s && Number.isFinite(s.at)).sort((a, b) => a.at - b.at);
  let idle = 0;
  for (let i = 1; i < rows.length; i++) {
    const running = Number.isFinite(rows[i - 1].copiesRunning) ? rows[i - 1].copiesRunning : slots;
    const gapMin = (rows[i].at - rows[i - 1].at) / 60e3;
    if (gapMin > 0) idle += Math.max(0, slots - running) * gapMin;
  }
  return Math.round(idle * 10) / 10;
}

// Average copies running across samples; null when no sample reported one.
function copiesAvg(samples = []) {
  const vals = (samples || []).map((s) => s && s.copiesRunning).filter(Number.isFinite);
  return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
}

// The four fix rules, ranked in the order the report lists them: biggest idle
// time, Opus share of reviews, sent-back rate, low perPct. Each returns
// { rule, text } when its condition is bad enough, else is skipped; the first
// three triggered rules become topFixes.
function fixCandidates(r) {
  const out = [];
  if (r.idleSlotMinutes >= IDLE_FLAG_MIN)
    out.push({ rule: 0, text: `${r.idleSlotMinutes} slot-minutes sat idle — keep the ready queue fuller or accept finished jobs sooner.` });
  const revShare = r.opusByStep.reviews && r.opusByStep.reviews.share;
  if (revShare !== null && revShare !== undefined && revShare > OPUS_REVIEW_FLAG)
    out.push({ rule: 1, text: `${Math.round(revShare * 100)}% of review work ran on Opus — route reviews to a free agent when its limits allow.` });
  if (r.sentBackRate !== null && r.sentBackRate > SENDBACK_FLAG)
    out.push({ rule: 2, text: `${Math.round(r.sentBackRate * 100)}% of decided jobs (${r.sentBack}/${r.decided}) were sent back — split tasks smaller or pick a stronger agent.` });
  if (r.perPct !== null && r.perPct < TARGET_PER_PCT)
    out.push({ rule: 3, text: `Only ${fmtTokens(r.perPct)} free tokens per 1% of her session (target ${fmtTokens(TARGET_PER_PCT)}) — hand off more routine work.` });
  return out.slice(0, 3);
}

// 1-3 short lesson lines for the worst items, phrased as advice to keep.
function lessonsOf(r, fixes) {
  const lines = [];
  for (const f of fixes) {
    if (f.rule === 0) lines.push(`Keep more ready tasks queued: ${r.idleSlotMinutes} slot-minutes sat idle this goal.`);
    else if (f.rule === 1) lines.push("Send review steps to free agents when their limits allow; Opus should plan, not re-check.");
    else if (f.rule === 2) lines.push("Split delegated tasks smaller or choose a stronger agent: too many jobs came back.");
    else if (f.rule === 3) lines.push("Delegate more routine work: free tokens per 1% of her session ran below target.");
  }
  return lines.slice(0, 3);
}

// The report itself. `goal` may be an id or the goal object; `jobs` need only
// tokens and (for copiesAvg context) nothing else — times are accepted but not
// required. perPct is null until at least MIN_SPENT_PCT of her window was
// spent or when no job reported tokens.
export function ratioReport({ goal = null, jobs = [], routes = [], samples = [], sessionStartPct = null, sessionEndPct = null, slots = 10, workerTokens, devinTokens } = {}) {
  const goalId = goal && typeof goal === "object" ? goal.id ?? null : goal ?? null;
  const goalName = goal && typeof goal === "object" ? (goal.title || goal.id || "") : "";

  // An explicit workerTokens (all free workers' tokens) wins; the old
  // devinTokens input is the fallback for callers that only know that name;
  // with neither, the jobs' own token fields are summed as before.
  const given = Number.isFinite(workerTokens) ? workerTokens : Number.isFinite(devinTokens) ? devinTokens : null;

  let summed = 0, tokN = 0;
  let sentBack = 0, decided = 0;
  for (const j of jobs || []) {
    if (!j) continue;
    const t = tokensOf(j);
    if (t !== null) { summed += t; tokN += 1; }
    if (j.verdict === "accept" || j.verdict === "send-back") {
      decided += 1;
      if (j.verdict === "send-back") sentBack += 1;
    }
  }
  const devinTokensTotal = given !== null ? given : (tokN ? summed : null);

  const start = Number.isFinite(sessionStartPct) ? sessionStartPct : null;
  const end = Number.isFinite(sessionEndPct) ? sessionEndPct : null;
  const spent = start !== null && end !== null ? end - start : null;
  const perPct = spent !== null && spent >= MIN_SPENT_PCT && devinTokensTotal !== null ? devinTokensTotal / spent : null;

  const steps = opusByStep(routes);
  const idle = idleMinutes(samples, slots);
  const avg = copiesAvg(samples);
  const sentBackRate = decided ? sentBack / decided : null;

  const r = {
    goal: goalId, goalName, slots,
    devinTokens: devinTokensTotal, workerTokens: devinTokensTotal, perPct, sessionPct: { start, end, spent },
    opusByStep: steps, copiesAvg: avg, idleSlotMinutes: idle,
    sentBack, decided, sentBackRate,
    samples: (samples || []).filter((s) => s && Number.isFinite(s.at)).length,
  };
  const fixes = fixCandidates(r);
  r.topFixes = fixes.map((f) => f.text);
  r.lessons = lessonsOf(r, fixes);

  const pctTxt = perPct === null
    ? (spent !== null && spent < MIN_SPENT_PCT ? "not enough of her session spent to measure" : "no worker tokens reported")
    : `${fmtTokens(perPct)} per 1% (target ${fmtTokens(TARGET_PER_PCT)})`;
  const rev = steps.reviews;
  const revTxt = rev && rev.share !== null
    ? `${Math.round(rev.share * 100)}% Opus (${rev.unit === "tokens" ? fmtTokens(rev.opus) : rev.opus} of ${rev.unit === "tokens" ? fmtTokens(rev.total) : rev.total})`
    : "no reviews routed";
  const lines = [
    `Goal ${goalName || goalId || "?"}: ${devinTokensTotal === null ? "no worker tokens reported" : `${fmtTokens(devinTokensTotal)} free-worker tokens`} for ${spent === null ? "?" : Math.round(spent * 10) / 10}% of her session — ${pctTxt}.`,
    `Slots: avg ${avg === null ? "?" : avg} copies, ${idle} slot-minutes idle over ${r.samples} samples.`,
    `Opus by step — planning ${steps.planning.share === null ? "-" : Math.round(steps.planning.share * 100) + "%"}, specs ${steps.specs.share === null ? "-" : Math.round(steps.specs.share * 100) + "%"}, reviews ${revTxt}, fixes ${steps.fixes.share === null ? "-" : Math.round(steps.fixes.share * 100) + "%"}.`,
    sentBackRate === null ? "No decided jobs yet." : `${sentBack} of ${decided} decided jobs sent back (${Math.round(sentBackRate * 100)}%).`,
  ];
  if (r.topFixes.length) lines.push(`Fixes: ${r.topFixes.join(" ")}`);
  r.text = lines.join("\n");
  return r;
}

// Append the report to dir/history.jsonl as {kind:'ratio', at, ...report} and
// return its lesson lines (already on report.lessons). Creates dir if needed.
export function saveReport(dir, report, now = Date.now()) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "history.jsonl");
  fs.appendFileSync(file, JSON.stringify({ kind: "ratio", at: now, ...report }) + "\n");
  return Array.isArray(report && report.lessons) ? report.lessons : [];
}
