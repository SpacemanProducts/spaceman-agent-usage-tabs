// Job control helpers for Constance's board: is a worker waiting on a person,
// a safe peek at its latest output, a read-only diff of what it changed, and
// SIGSTOP/SIGCONT on the job's whole process group. Ideas only from
// herdr/Claude Squad; all code here is ours. Pure helpers — the caller owns
// the store, so pause/resume return the fields to merge, never write jobs.json.
import { safeGit } from "./constance-git.mjs";

// ---- blockedReason ---------------------------------------------------------
// The last few non-empty lines of a worker's log decide "waiting on a person".
// A prompt answered earlier has been pushed out of the tail by the output that
// followed it, so it does not count.
const BLOCK_LINES = 4;
// [pattern, short reason]. First match on the newest matching line wins; order
// the specific prompts (allow/permission) before the generic yes/no ones.
const BLOCK_PATTERNS = [
  [/\bwaiting for (?:input|your input|a response|confirmation|the user|you)\b/i, "waiting for input"],
  [/\b(?:press|hit|type)\s+(?:enter|return|any key|esc(?:ape)?)\b/i, "waiting for a key press"],
  [/\ballow\b[^\n?]{0,80}\?\s*$/i, "asking for permission"],
  [/\(\s*[yY]\s*[/,|]\s*[nN]\s*\)|\[y\s*\/\s*n\]|y\s*\/\s*n\b|yes\s*\/\s*no\b|y or n\b/i, "asking yes or no"],
  [/\b(?:do you want|would you like|shall i|do you wish|may i)\b/i, "asking a question"],
  [/\b(?:enter|type|paste|provide)\b[^\n]{0,60}\b(?:password|passphrase|api[-_ ]?key|secret|credential|token)\b/i, "asking for a credential"],
  [/\b(?:log ?in|sign ?in|authentication|authorization|verification code|one[- ]time (?:code|password)|2fa)\b[^\n]{0,50}(?:\?|required|to continue|:)\s*$/i, "asking to log in"],
  [/(?:❯|›|»)\s*\d*\s*\.?\s*(?:yes|no|allow|deny|approve)/i, "asking which option"],
];

// A short plain reason when the log tail shows the job is waiting for a
// person, else null. Only the last BLOCK_LINES non-empty lines are read.
export function blockedReason(logTail) {
  const lines = String(logTail || "").replace(/\r/g, "").split("\n")
    .map((l) => l.trim()).filter(Boolean).slice(-BLOCK_LINES);
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const [re, reason] of BLOCK_PATTERNS) if (re.test(lines[i])) return reason;
  }
  return null;
}

// ---- peek ------------------------------------------------------------------
// ANSI escapes matched through for stripping (same pattern as freebuff-ads).
const ANSI_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])|\x9b[0-?]*[ -/]*[@-~]/g;

// Secret-looking tokens masked before anything is shown: known key prefixes,
// bearer tokens, then long hex and long base64-ish runs.
const SECRET_RES = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-…"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/g, "gh*_…"],
  [/\bgithub_pat_[A-Za-z0-9_]{8,}/g, "github_pat_…"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer …"],
  [/[A-Za-z0-9+/=_-]{40,}/g, "…"],
  [/\b[0-9a-fA-F]{32,}\b/g, "…"],
];

const maskSecrets = (s) => SECRET_RES.reduce((t, [re, sub]) => t.replace(re, sub), s);

// The latest `lines` lines of a worker's log, ANSI-stripped, secrets masked,
// capped at `maxChars` from the end (the newest output is what matters).
export function peek(logText, { lines = 12, maxChars = 1500 } = {}) {
  const tail = String(logText || "").replace(/\r/g, "").split("\n")
    .map((l) => l.replace(ANSI_RE, "")).slice(-lines).join("\n");
  const masked = maskSecrets(tail);
  return masked.length > maxChars ? "…" + masked.slice(-(maxChars - 1)) : masked;
}

// ---- jobDiff ----------------------------------------------------------------
// What the job changed since baseRef: `git diff --stat` for the summary and
// `git diff` for the patch, both read-only through safeGit (never stash, never
// write). The patch is clipped to maxChars from the top so the file headers
// survive; `clipped` says it was cut.
export function jobDiff(dir, baseRef, { maxChars = 6000 } = {}) {
  if (!baseRef) return { stat: "", patch: "", clipped: false, error: "no base ref" };
  const git = (...a) => safeGit(dir, ["--no-optional-locks", ...a], { timeout: 30e3 });
  const s = git("diff", "--stat", baseRef);
  const d = git("diff", baseRef);
  if (d.status !== 0) return { stat: "", patch: "", clipped: false, error: (d.stderr || "").trim() || "git diff failed" };
  let patch = d.stdout, clipped = false;
  if (patch.length > maxChars) {
    patch = patch.slice(0, maxChars) + `\n… (diff cut at ${maxChars} characters)`;
    clipped = true;
  }
  return { stat: s.status === 0 ? s.stdout.trim() : "", patch, clipped };
}

// ---- pauseJob / resumeJob ---------------------------------------------------
// A job runs as its own process-group leader (the sandbox relies on this for
// Stop's group kill), so the signal goes to -pid: the worker and everything it
// spawned freeze or wake together. The store is the caller's job — these return
// the fields to merge ({ paused: true, pausedAt } / { paused: false }) and
// refuse, by throwing, a job that isn't running or has no pid.
function controlProblem(job) {
  if (!job) return "no such job";
  if (job.status !== "running") return `job ${job.id} is ${job.status}, not running`;
  if (!Number.isInteger(job.pid) || job.pid <= 0) return `job ${job.id} has no pid`;
  return "";
}

export function pauseJob(job, { kill = process.kill, now = Date.now() } = {}) {
  const why = controlProblem(job);
  if (why) throw new Error(why);
  kill(-job.pid, "SIGSTOP");
  return { paused: true, pausedAt: now };
}

export function resumeJob(job, { kill = process.kill } = {}) {
  const why = controlProblem(job);
  if (why) throw new Error(why);
  kill(-job.pid, "SIGCONT");
  return { paused: false };
}
