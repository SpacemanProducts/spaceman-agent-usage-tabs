// Constance's "Copy summary": a plain-text snapshot of the board — goals,
// checklist, failed jobs, leverage and the tail of the log — for pasting
// into a chat or a bug report. Pure: no imports beyond node built-ins, no
// file or network access, every line collapsed to one line, and the whole
// report capped at SUMMARY_MAX_LINES by shrinking the Goals and Checklist
// sections first (the header line is never dropped).

export const SUMMARY_MAX_LINES = 80;

const CHECKLIST_MAX = 15;
const GOALS_HISTORY_MAX = 10;
const FAILED_MAX = 8;
const LOG_MAX = 30;

const pad = (n) => String(n).padStart(2, "0");

// Local YYYY-MM-DD HH:MM for the header, HH:MM for log lines.
const localStamp = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const defaultFmtTime = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// First line of a value, trimmed; "" for null/undefined.
const firstLine = (v) => String(v ?? "").split(/\r?\n/)[0].trim();

// First line with any content, trimmed; "" when every line is blank.
const firstNonEmpty = (v) =>
  String(v ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";

// One line, at most max chars including the ellipsis.
const clip = (s, max) => {
  const t = String(s ?? "");
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

// A goal/checklist/job field that could smuggle a newline: flatten it.
const flat = (v) => String(v ?? "").replace(/[\r\n]+/g, " ").trim();

// "151.2M"-style token counts.
const fmtTokens = (n) => {
  const units = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [div, suffix] of units) {
    if (Math.abs(n) >= div) {
      const v = n / div;
      return `${Number.isInteger(v) ? v : v.toFixed(1).replace(/\.0$/, "")}${suffix}`;
    }
  }
  return String(Math.round(n));
};

// " — <reason>" suffix for a goal line: failReason wins, then needsOwner
// (a string reason, or plain "needs owner" for a bare true).
const reasonSuffix = (entry) => {
  const why = firstNonEmpty(entry.failReason)
    || (typeof entry.needsOwner === "string" ? entry.needsOwner.trim() : "")
    || (entry.needsOwner ? "needs owner" : "");
  return why ? ` — ${clip(flat(why), 100)}` : "";
};

const itemsSuffix = (entry) =>
  entry.itemsTotal != null ? ` (${entry.itemsDone ?? 0}/${entry.itemsTotal} items)` : "";

// "- [<status>] <first line, 80> (<items>) — <reason>"
const goalLine = (entry, status) =>
  `- [${flat(status)}] ${clip(firstLine(entry.text), 80)}${itemsSuffix(entry)}${reasonSuffix(entry)}`;

// Newest first by id; numeric ids compare numerically, the rest as strings.
const byIdDesc = (a, b) => {
  const na = Number(a.id), nb = Number(b.id);
  if (Number.isFinite(na) && Number.isFinite(nb)) return nb - na;
  return String(b.id).localeCompare(String(a.id), undefined, { numeric: true });
};

const failedLine = (job) => {
  const label = firstLine(job.title) || firstLine(job.task) || "(untitled)";
  const err = firstNonEmpty(job.reviewNote) || firstNonEmpty(job.summary) || String(job.status ?? "");
  return `- #${flat(job.id)} ${flat(job.agent) || "unknown"}: ${clip(flat(label), 50)} — ${clip(flat(err), 100)}`;
};

const failedSection = (jobs) => {
  const bad = jobs.filter((j) => ["sent back", "conflict", "failed"].includes(j.status));
  bad.sort(byIdDesc);
  const lines = ["Failed jobs:"];
  if (!bad.length) return [...lines, "- none"];
  for (const j of bad.slice(0, FAILED_MAX)) lines.push(failedLine(j));
  if (bad.length > FAILED_MAX) lines.push(`  … ${bad.length - FAILED_MAX} more`);
  return lines;
};

const leverageSection = (leverage) => {
  if (!leverage) return ["Leverage: not measured"];
  const label = flat(leverage.label) || "unknown";
  const parts = [];
  if (typeof leverage.tokens === "number") parts.push(`${fmtTokens(leverage.tokens)} tokens`);
  if (typeof leverage.spentPct === "number") parts.push(`${leverage.spentPct}% of the session`);
  return [`Leverage: ${label}${parts.length ? ` (${parts.join(", ")})` : ""}`];
};

const logSection = (log, fmtTime) => {
  const lines = ["Last 30 log lines:"];
  for (const e of log.slice(-LOG_MAX)) {
    const kind = flat(e.kind) || "log";
    lines.push(`${fmtTime(e.at)} ${kind}: ${clip(flat(firstNonEmpty(e.text)), 140)}`);
  }
  return lines;
};

// One goal-list entry block: the "… N earlier goals" marker for history cut
// by the 10-entry rule (or by the line cap), the shown history entries, the
// current goal, the shown queued goals, and a "… N more" marker for queued
// goals the cap hid.
function goalsSection({ history, current, queue, histCount, queueCount }) {
  const lines = ["Goals:"];
  const earlier = history.length - histCount;
  if (earlier > 0) lines.push(`- … ${earlier} earlier goals`);
  for (const g of histCount ? history.slice(-histCount) : []) lines.push(goalLine(g, g.status ?? "unknown"));
  if (current) lines.push(goalLine(current, current.status ?? "running"));
  for (const q of queue.slice(0, queueCount)) lines.push(goalLine(q, "queued"));
  const hiddenQueued = queue.length - queueCount;
  if (hiddenQueued > 0) lines.push(`- … ${hiddenQueued} more`);
  return lines;
}

function checklistSection(items, shown) {
  if (!items.length) return [];
  const lines = ["Checklist:"];
  items.slice(0, shown).forEach((it, i) => {
    const n = it.n ?? i + 1;
    lines.push(`  [${it.state === "done" ? "x" : " "}] ${n}. ${clip(flat(it.text), 90)}`);
  });
  if (items.length > shown) lines.push(`  … ${items.length - shown} more`);
  return lines;
}

// The whole report. `input` fields all have safe defaults; `fmtTime(ms)`
// renders a log timestamp (default: local HH:MM).
export function buildSummary(input = {}) {
  const {
    now = Date.now(),
    current = null,
    items = [],
    history = [],
    queue = [],
    jobs = [],
    leverage = null,
    log = [],
    fmtTime = defaultFmtTime,
  } = input ?? {};
  const t = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const header = `Constance summary ${localStamp(t)}`;

  let histCount = Math.min(history.length, GOALS_HISTORY_MAX);
  let queueCount = queue.length;
  let checkCount = Math.min(items.length, CHECKLIST_MAX);

  const assemble = () => [
    header,
    ...goalsSection({ history, current, queue, histCount, queueCount }),
    ...checklistSection(items, checkCount),
    ...failedSection(jobs),
    ...leverageSection(leverage),
    ...logSection(log, fmtTime),
  ];

  // Over the cap? Shrink Checklist, then queued goals, then shown history —
  // the "…" markers keep the dropped counts honest. Fixed sections are small
  // enough that this always fits.
  let lines = assemble();
  while (lines.length > SUMMARY_MAX_LINES) {
    if (checkCount > 0) checkCount--;
    else if (queueCount > 0) queueCount--;
    else if (histCount > 0) histCount--;
    else break;
    lines = assemble();
  }
  return lines.map((l) => l.replace(/[\r\n]+/g, " ")).join("\n");
}
