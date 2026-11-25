// Constance's batch review: instead of reading every self-merged diff one at a
// time, the pending merged jobs are grouped into batches of up to BATCH_SIZE and
// reviewed together. batches() picks the merged, still-unreviewed jobs oldest
// first; batchPrompt() builds the one prompt sent to a reviewer (each job's id,
// task summary and diff, with the reply contract spelled out); parseVerdicts()
// turns the reply into one verdict per requested id — anything missing or
// unparseable counts as a fail with reason "no verdict"; applyVerdicts() then
// reverts the fails and marks every job reviewed. All side effects (the revert,
// the markReviewed write) are injected, so this file stays pure and testable.

export const BATCH_SIZE = 5;
const TASK_CHARS = 300;    // task summary length inside the prompt
const DIFF_CHARS = 4000;   // per-job diff length inside the prompt

// Clip a string to at most n chars, marking the cut with an ellipsis.
const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
};

const when = (j) => j.mergedAt || j.finishedAt || 0;

// The jobs still waiting for a background review: status "merged" (a reviewed
// merge moves to "accepted" or "sent back", so "merged" already means
// unreviewed), oldest merge first. Chunked into arrays of up to `size`.
export function batches(jobs, size = BATCH_SIZE) {
  const n = Number.isInteger(size) && size > 0 ? size : BATCH_SIZE;
  const pending = (jobs || [])
    .filter((j) => j && j.status === "merged")
    .sort((a, b) => when(a) - when(b) || a.id - b.id);
  const out = [];
  for (let i = 0; i < pending.length; i += n) out.push(pending.slice(i, i + n));
  return out;
}

// One prompt covering a whole batch. diffOf(job) supplies each job's diff; a
// job whose diffOf returns nothing still gets its section, with an empty diff.
// The reply contract is explicit: exactly one line per job, "ID ok" or
// "ID fail: reason".
export function batchPrompt(batch, { diffOf } = {}) {
  const diff = typeof diffOf === "function" ? diffOf : () => "";
  const lines = [
    `Review these ${batch.length} merged job${batch.length === 1 ? "" : "s"} in one pass. For each job decide whether its merged diff does what its task asked and is safe to keep. Answer with exactly one line per job and nothing else:`,
    ``,
    `<job id> ok`,
    `<job id> fail: <reason>`,
    ``,
    `Jobs:`,
    ``,
  ];
  for (const j of batch) {
    const task = clip(j.task || j.summary || "", TASK_CHARS);
    lines.push(`== Job ${j.id} ==`);
    lines.push(`Task: ${task}`);
    lines.push(`Diff:`);
    lines.push(clip(diff(j), DIFF_CHARS));
    lines.push(``);
  }
  return lines.join("\n");
}

// Parse a reviewer's reply into { [id]: { ok, reason } } for exactly the
// requested ids. A line reads "<id> ok" or "<id> fail: <reason>" (the colon is
// optional, extra text after ok is ignored). Ids the reply doesn't cover, and
// ids it invents, are handled as: requested-but-missing -> fail "no verdict";
// unrequested -> ignored.
export function parseVerdicts(text, ids) {
  const found = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s+(ok|fail)\b\s*:?\s*(.*)$/);
    if (!m || found.has(m[1])) continue;
    const reason = m[3].trim();
    found.set(m[1], m[2] === "ok"
      ? { ok: true, reason: "" }
      : { ok: false, reason: reason || "no reason given" });
  }
  const out = {};
  for (const id of ids || []) {
    const v = found.get(String(id));
    out[String(id)] = v ? { ok: v.ok, reason: v.reason } : { ok: false, reason: "no verdict" };
  }
  return out;
}

// Apply parsed verdicts to the batch's jobs. `verdicts` is either the batch
// paired with its verdicts — an array of { job, ok, reason } entries, or an
// object keyed by job id whose values carry { job, ok, reason } — or the bare
// { id: { ok, reason } } map parseVerdicts returns, with the jobs supplied as
// `jobs` in the options (matched by id). For each ok job
// markReviewed(job, "ok"); for each fail revert(job) runs first and
// markReviewed(job, "reverted") only when the revert reports ok — a failed
// revert leaves the job unmarked and is counted in the summary instead, so a
// merge that couldn't be undone is never recorded as reverted.
// Returns { total, ok, reverted, revertFailed }.
export function applyVerdicts(verdicts, { revert, markReviewed, jobs } = {}) {
  const byId = new Map((jobs || []).map((j) => [String(j.id), j]));
  const entries = (Array.isArray(verdicts) ? verdicts : Object.entries(verdicts || {}))
    .map((e) => (Array.isArray(e) ? { id: e[0], ...e[1] } : e));
  const undo = typeof revert === "function" ? revert : () => ({ ok: true });
  const mark = typeof markReviewed === "function" ? markReviewed : () => {};
  const summary = { total: entries.length, ok: 0, reverted: 0, revertFailed: [] };
  for (const e of entries) {
    const job = e && (e.job || byId.get(String(e.id)));
    if (!job) continue;
    if (e.ok) {
      mark(job, "ok");
      summary.ok++;
      continue;
    }
    const r = undo(job);
    if (r && r.ok === false) {
      summary.revertFailed.push(job.id);
      continue;
    }
    mark(job, "reverted");
    summary.reverted++;
  }
  return summary;
}
