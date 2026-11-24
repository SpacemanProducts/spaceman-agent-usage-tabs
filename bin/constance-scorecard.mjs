// Constance's per-agent scorecard: how reviewed jobs went for each agent,
// kept in her state folder (scorecard.json). Feeds sizeHint (how big a task
// to hand that agent) and rankAgents (who gets the next job first).
import fs from "node:fs";
import path from "node:path";
import { fmtTokens } from "./constance-tokens.mjs";
import { took } from "./constance-board.mjs";

const MAX_RECENT = 20;
const MAX_SEEN = 500;
const EMPTY_AGENT = () => ({ jobs: 0, accepted: 0, sentBack: 0, tokensSum: 0, tokensN: 0, msSum: 0, msN: 0, recent: [] });

export function scorecardFile(dir) {
  return path.join(dir, "scorecard.json");
}

function emptyCard() {
  return { agents: {}, seen: [] };
}

export function readScorecard(dir) {
  try {
    const d = JSON.parse(fs.readFileSync(scorecardFile(dir), "utf8"));
    if (!d || typeof d !== "object") return emptyCard();
    const agents = {};
    for (const [id, a] of Object.entries(d.agents && typeof d.agents === "object" ? d.agents : {})) {
      const e = EMPTY_AGENT();
      agents[id] = { ...e, ...a, recent: Array.isArray(a && a.recent) ? a.recent : [] };
    }
    return { agents, seen: Array.isArray(d.seen) ? d.seen : [] };
  } catch { return emptyCard(); }
}

function writeCard(dir, card) {
  fs.mkdirSync(dir, { recursive: true });
  const file = scorecardFile(dir);
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(card, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// One review of one finished job. Practice jobs and jobs with no startedAt
// don't count; each goal:job id counts once ever.
export function recordReview(dir, job, verdict, now = Date.now()) {
  if (verdict !== "accept" && verdict !== "send-back") return readScorecard(dir);
  if (!job || !Number.isFinite(job.startedAt)) return readScorecard(dir);
  if (String(job.summary || "").startsWith("(practice run")) return readScorecard(dir);
  const card = readScorecard(dir);
  const key = job.goal + ":" + job.id;
  if (card.seen.includes(key)) return card;
  card.seen.push(key);
  if (card.seen.length > MAX_SEEN) card.seen = card.seen.slice(-MAX_SEEN);
  const agent = job.agent || "";
  const a = card.agents[agent] ||= EMPTY_AGENT();
  a.jobs += 1;
  if (verdict === "accept") a.accepted += 1; else a.sentBack += 1;
  const tokens = job.tokens && Number.isFinite(job.tokens.n) ? job.tokens.n : null;
  if (tokens !== null) { a.tokensSum += tokens; a.tokensN += 1; }
  const ms = Number.isFinite(job.startedAt) && Number.isFinite(job.finishedAt) ? job.finishedAt - job.startedAt : null;
  if (ms !== null) { a.msSum += ms; a.msN += 1; }
  a.recent.push({ job: job.id, verdict, tokens, ms, files: (job.files || []).length, at: now });
  if (a.recent.length > MAX_RECENT) a.recent = a.recent.slice(-MAX_RECENT);
  writeCard(dir, card);
  return card;
}

export function scoreRows(card, name = (id) => id) {
  const rows = Object.entries((card && card.agents) || {}).map(([agent, a]) => {
    const decided = a.accepted + a.sentBack;
    return {
      agent,
      name: name(agent),
      jobs: a.jobs,
      accepted: a.accepted,
      sentBack: a.sentBack,
      acceptRate: decided ? a.accepted / decided : null,
      avgTokens: a.tokensN ? Math.round(a.tokensSum / a.tokensN) : null,
      avgMs: a.msN ? Math.round(a.msSum / a.msN) : null,
    };
  });
  return rows.sort((x, y) => y.jobs - x.jobs || (x.agent < y.agent ? -1 : x.agent > y.agent ? 1 : 0));
}

// How big a job to hand this agent. Slow agents get one fewer file slot.
export function sizeHint(row) {
  if (!row || !row.jobs) return { maxFiles: 2, note: "no record yet: start small" };
  let maxFiles, note;
  if (row.acceptRate !== null && row.acceptRate < 0.5 && row.jobs >= 2) {
    maxFiles = 1; note = "often sent back: one narrow file";
  } else if (row.acceptRate !== null && row.acceptRate < 0.8) {
    maxFiles = 2; note = "sometimes sent back: keep it small";
  } else {
    maxFiles = 4; note = "reliable";
  }
  if (row.avgMs !== null && row.avgMs > 20 * 60e3) {
    maxFiles = Math.max(1, maxFiles - 1);
    note += "; slow jobs";
  }
  return { maxFiles, note };
}

// Best agent first: higher accept rate (no reviews counts as 0.7), then lower
// average tokens (unknown is worst), then the caller's order.
export function rankAgents(ids, card) {
  const rate = (id) => {
    const a = card && card.agents && card.agents[id];
    const decided = a ? a.accepted + a.sentBack : 0;
    return decided ? a.accepted / decided : 0.7;
  };
  const tokens = (id) => {
    const a = card && card.agents && card.agents[id];
    return a && a.tokensN ? a.tokensSum / a.tokensN : Infinity;
  };
  return ids.map((id, i) => ({ id, i })).sort((x, y) =>
    rate(y.id) - rate(x.id) || tokens(x.id) - tokens(y.id) || x.i - y.i).map((x) => x.id);
}

export function scoreLine(row) {
  if (!row) return "";
  let line = `${row.name ?? row.agent}: ${row.jobs} jobs, ${row.accepted} accepted, ${row.sentBack} sent back`;
  if (row.avgTokens !== null && row.avgTokens !== undefined) line += `, avg ${fmtTokens(row.avgTokens)} tokens`;
  if (row.avgMs !== null && row.avgMs !== undefined) line += `, avg ${took(row.avgMs)}`;
  return line;
}
