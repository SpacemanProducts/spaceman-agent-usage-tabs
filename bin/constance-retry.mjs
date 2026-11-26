// Constance's second-try rule: work that was sent back twice must not go back
// out as-is — it gets split into smaller jobs (fewer files each) or done by
// Constance herself. A "sent back" job is one review rejected; `againOf` links
// a redo to the job it replaces, and jobs touching the same file set are the
// same work even without the link.

const SENT_BACK = "sent back";

function fileSet(files) {
  if (!Array.isArray(files)) return new Set();
  return new Set(files.filter((f) => f != null && f !== false).map((f) => String(f).trim()).filter(Boolean));
}

// True when both lists are non-empty and hold the same set of paths
// (order and duplicates ignored, paths trimmed).
export function sameFiles(a, b) {
  const A = fileSet(a), B = fileSet(b);
  if (!A.size || !B.size || A.size !== B.size) return false;
  for (const f of A) if (!B.has(f)) return false;
  return true;
}

// The sorted, de-duplicated ids of the 'sent back' jobs a proposal redoes: the
// job `againOf` points at plus everything its own againOf links reach (through
// jobs of any status, loops guarded), and every 'sent back' job on the same
// file set. Only 'sent back' jobs are returned.
export function chain(jobs, { files = [], againOf = null } = {}) {
  const list = jobs.filter((j) => j != null);
  const byId = new Map(list.map((j) => [j.id, j]));
  const found = new Set();
  const seen = new Set();
  let cur = byId.get(againOf);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    found.add(cur.id);
    cur = byId.get(cur.againOf ?? null);
  }
  for (const j of list) {
    if (j.status === SENT_BACK && sameFiles(j.files, files)) found.add(j.id);
  }
  return [...found].filter((id) => byId.get(id)?.status === SENT_BACK).sort((a, b) => a - b);
}

// "4 and 7" / "4, 7 and 9".
function idList(ids) {
  return ids.length <= 2 ? ids.join(" and ") : ids.slice(0, -1).join(", ") + " and " + ids[ids.length - 1];
}

// A proposal is a split when its files are non-empty and a strict subset of the
// files of every job in the chain (fewer paths, all contained).
function isSplit(jobs, files, ids) {
  const P = fileSet(files);
  if (!P.size || !ids.length) return false;
  const byId = new Map(jobs.map((j) => [j.id, j]));
  return ids.every((id) => {
    const F = fileSet(byId.get(id)?.files);
    return F.size > P.size && [...P].every((f) => F.has(f));
  });
}

// null when the handoff may go ahead, else { ids, reason }. Blocked when the
// chain has 2+ sent-back jobs and the proposal is not a split; a read-only
// proposal (no files) is never blocked.
export function secondTry(jobs, proposal = {}) {
  const files = proposal.files || [];
  if (!fileSet(files).size) return null;
  const ids = chain(jobs, { files, againOf: proposal.againOf ?? null });
  if (ids.length < 2 || isSplit(jobs, files, ids)) return null;
  return { ids, reason: `Jobs ${idList(ids)} were already sent back for this work. Don't resend it: split it into smaller jobs (fewer files each) or do it yourself.` };
}

// The note appended when a job is sent back: empty until this is the second
// send-back for the same work (the job itself counts as sent back).
export function sendBackAdvice(jobs, job = {}) {
  const ids = [...new Set([...chain(jobs, { files: job.files || [], againOf: job.againOf ?? null }), job.id])].sort((a, b) => a - b);
  if (ids.length < 2) return "";
  return `This work has now been sent back twice (jobs ${idList(ids)}): split it into smaller jobs or do it yourself. A new handoff with the same files will be refused.`;
}

// ---------------------------------------------------------------- auto-retry
// A finished job that failed on its own — tests failing, a guard violation or
// a crash — gets one automatic redo on a fresh copy of the same agent before
// Constance's review ever sees it. shouldAutoRetry decides; retrySpec builds
// the handoff ({ agent, files, task, again }) the caller passes to delegate.

// The done-file `tests` field only counts as a failure when it says so
// outright; silence is not a failure (self-merge already treats it that way).
function testsFailed(t) {
  if (t === false) return true;
  return /^(fail|failed|failing|no|none)$/i.test(String(t ?? ""));
}

// Summaries the sweep writes when no real report exists: the agent exited
// without its done file, the done file wasn't JSON, or it never launched.
const CRASH_SUMMARY = /^\((the agent exited|done file was not valid JSON|not launched|no worktree)/;

// True when the job's own record shows a failure worth retrying.
function jobFailed(job) {
  if (!job) return false;
  if (Array.isArray(job.guardViolation) && job.guardViolation.length) return true;
  if (testsFailed(job.tests)) return true;
  const s = String(job.summary || "");
  return CRASH_SUMMARY.test(s);
}

// True only when the job failed, has not been auto-retried yet (no history
// entry with againOf === job.id marked autoRetry) and is not itself an
// auto-retry, and the work is not past the second-try limit (secondTry still
// applies to the same files/againOf chain).
export function shouldAutoRetry(job, history = []) {
  if (!jobFailed(job) || job.autoRetry) return false;
  const jobs = Array.isArray(history) && history.length ? history : [job];
  if (jobs.some((h) => h && h.againOf === job.id && h.autoRetry)) return false;
  if (secondTry(jobs, { files: job.files || [], againOf: job.againOf ?? null })) return false;
  return true;
}

// The redo spec for delegate: same agent and file list, the original task
// plus a 'Last try failed with:' section carrying the last 1500 chars of the
// job's error output, linked back with again: job.id.
export function retrySpec(job, { errorOutput = "" } = {}) {
  const tail = String(errorOutput ?? "").slice(-1500);
  const task = `${String(job?.task || "").trim()}\n\nLast try failed with:\n${tail}`;
  return { agent: job?.agent, files: [...(job?.files || [])], task, again: job?.id };
}
