// "Give it to Opus": the owner (or the stuck rule, when the Milk Opus slider leans
// toward Opus) stops a running worker and hands its job to Opus — the real
// `claude` CLI on the owner's plan — to finish in the same folder or worktree.
// The worker's partial changes and log stay; Opus gets the original prompt, the
// partial diff and the last 50 log lines. The job keeps its id, files, guard
// snapshot and done file, so the same sandbox, guard, tests and review apply.
// Pure helpers plus two git reads; bin/constance.mjs does the stop and relaunch.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { STOP_AT, LEAN_AT } from "./constance-pace.mjs";

// How Opus runs as a worker: Claude Code headless, prompts off (it only ever runs sandboxed).
export const OPUS = {
  agent: "claude",
  worker: "Opus",
  cli: "claude",
  args: (p) => ["-p", "--model", "opus", "--dangerously-skip-permissions", p],
};
export const opusCommand = (prompt) => [OPUS.cli, ...OPUS.args(prompt)];

export const DIFF_CAP = 40000;
export const LOG_LINES = 50;
export const LOG_CAP = 8000;
// Auto-handoff of stuck jobs is on once the Milk Opus slider is past the middle,
// toward the Opus end (0 = the free agents do almost everything: never automatic).
export const AUTO_FROM = 51;

export const autoTakeoverOn = (milk) => Number(milk) >= AUTO_FROM;

// Why a job can't go to Opus right now ("" when it can).
export function takeoverProblem(job) {
  if (!job) return "no such job";
  if (job.status !== "running") return `job ${job.id} is ${job.status}, not running`;
  if (job.handedFrom || job.agent === OPUS.agent) return `job ${job.id} is already Opus's`;
  return "";
}

// Why Opus can't take work now, from Claude's own meters in data.json ("" when it can).
// The owner's click is refused only at her stop line; the automatic handoff also leaves
// her pacing room (it stops once a window passes the lean line).
export function opusBlocked(claude, { auto = false } = {}) {
  const limits = Array.isArray(claude?.limits) ? claude.limits : [];
  const ls = limits.filter((l) => typeof l?.percent === "number" && Number.isFinite(l.percent));
  if (!ls.length) return "Claude's limits can't be read right now";
  const line = auto ? LEAN_AT : STOP_AT;
  const worst = ls.reduce((m, l) => (l.percent > m.percent ? l : m), ls[0]);
  if (worst.hitAt || worst.percent >= line) return `Claude's ${worst.title || "limit"} is at ${Math.round(worst.percent * 100)}%`;
  return "";
}

// The last `n` lines of a text, capped at `cap` characters from the end.
export function lastLines(text, n = LOG_LINES, cap = LOG_CAP) {
  const lines = String(text || "").replace(/\r/g, "").replace(/\n+$/, "").split("\n");
  const t = lines.slice(-n).join("\n");
  return t.length > cap ? "…" + t.slice(-cap) : t;
}

// The worker's changes since the job started: committed and uncommitted tracked changes
// (git diff against the pre-run HEAD) plus the untracked files it created, with their text.
export function partialDiff(dir, base = "", cap = DIFF_CAP) {
  const git = (...a) => spawnSync("git", ["--no-optional-locks", "-C", dir, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30e3 });
  const d = git("diff", base || "HEAD", "--", ".", ":(exclude).constance");
  let diff = d.status === 0 ? d.stdout : "";
  const u = git("ls-files", "--others", "--exclude-standard", "-z");
  const untracked = u.status === 0 ? u.stdout.split("\0").filter((p) => p && !p.startsWith(".constance/")) : [];
  // New files are only names to git diff: add their text (binary files stay names only).
  for (const p of untracked) {
    if (diff.length > cap) break;
    let t = "";
    try { const b = fs.readFileSync(path.join(dir, p)); if (!b.includes(0)) t = b.toString("utf8"); else continue; } catch { continue; }
    diff += `${diff && !diff.endsWith("\n") ? "\n" : ""}--- new file ${p} ---\n${t}${t.endsWith("\n") ? "" : "\n"}`;
  }
  if (diff.length > cap) diff = diff.slice(0, cap) + `\n… (diff cut at ${cap} characters; run \`git diff ${base || "HEAD"}\` and \`git status\` for the rest)`;
  return { diff, untracked };
}

export function readTail(file, bytes = 64 * 1024) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size, len = Math.min(bytes, size), buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return ""; }
}

// Opus's prompt: the job's original prompt (task, pwd check, file list, tests, done file,
// guardrails) and then what the stopped worker left behind.
export function takeoverPrompt({ prompt, from, reason = "", diff = "", untracked = [], logTail = "" }) {
  return [
    String(prompt || "").trim(),
    "",
    `Taking over: ${from} started this job and was stopped${reason ? ` (${reason})` : ""}. You are Opus and you finish it, in this same folder, under every rule above.`,
    "Its partial work is still here. Read it first: keep what is right, fix or finish the rest, and stay inside the same file list. If its work is wrong, undo only its changes to those files, never anything else.",
    "",
    `Its changes so far (git diff against where the job started):`,
    diff.trim() ? diff.trim() : "(no tracked changes)",
    ...(untracked.length ? ["", `New files it created: ${untracked.join(", ")}`] : []),
    "",
    `The last ${LOG_LINES} lines of its log:`,
    logTail.trim() ? logTail.trim() : "(its log is empty)",
  ].join("\n");
}
