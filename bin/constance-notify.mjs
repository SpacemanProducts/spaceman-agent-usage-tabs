// Constance's ears: she listens to the session bus for desktop notifications,
// read-only. Ghostty turns an agent CLI's OSC escape into a notification like
// "Devin finished"; busctl monitor lets her see those calls without being the
// notification daemon — nothing is blocked, claimed or dismissed.
//
// A notification that names an agent she has running is matched to its job by
// the done file and the folder; one with no done file gets its folder and git
// log inspected. A notification naming an agent with no job of hers is the
// owner's own run: logged and left alone.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { doneFile } from "./constance-jobs.mjs";
import { LAUNCH } from "./constance-agents.mjs";

export function notifyFile(dir) {
  return path.join(dir, "notify.jsonl");
}

// Every agent she can hear: the launchable workers plus Claude herself (the
// owner may run her in a Ghostty window too — still just logged, never touched).
export const KNOWN = [
  { id: "claude", cli: "claude", names: ["claude"] },
  ...Object.entries(LAUNCH).map(([id, l]) => ({ id, cli: l.cli, names: [id, l.cli] })),
];
KNOWN.find((k) => k.id === "cursor")?.names.push("cursor agent", "cursor-agent");
KNOWN.find((k) => k.id === "antigravity")?.names.push("antigravity", "agy");
KNOWN.find((k) => k.id === "codex")?.names.push("codex cli");

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NAME_RES = KNOWN.map((k) => ({ k, re: new RegExp(`\\b(?:${k.names.map(esc).join("|")})\\b`, "i") }));

export function agentInText(text) {
  for (const { k, re } of NAME_RES) if (re.test(text)) return k;
  return null;
}

const FINISHED = /\b(finish|finished|done|complet\w*|exit(?:ed)?|ready)\b/i;

// busctl --user monitor prints one "‣ Type=..." block per message. A Notify call
// carries its args as STRING "..." lines in signature order: app, icon, summary,
// body (then actions/hints — ignored). Feed it line by line; a block is complete
// when the next "‣ Type=" header arrives.
export class NotifyParser {
  constructor() { this.strings = null; }
  feed(line) {
    if (line.startsWith("‣ Type=")) {
      const out = this.complete() ? this.emit() : null;
      this.strings = null;
      return out;
    }
    // The Member= line opens a Notify block; it always starts a fresh collection
    // so a truncated earlier block can never bleed into this one. STRING lines
    // are never headers: a notification's text may quote the signature.
    if (!/^\s*STRING\s+"/.test(line) && /Interface=org\.freedesktop\.Notifications\s+Member=Notify\b/.test(line)) { this.strings = []; return null; }
    if (this.strings === null) return null;
    for (const m of line.matchAll(/STRING "((?:[^"\\]|\\.)*)"/g)) this.strings.push(unescape(m[1]));
    return null;
  }
  end() {
    const out = this.complete() ? this.emit() : null;
    if (out) this.strings = null;
    return out;
  }
  complete() { return !!(this.strings && this.strings.length >= 4); }
  emit() {
    const [app, , summary, body] = this.strings;
    return { app, summary, body };
  }
}

function unescape(s) {
  return String(s).replace(/\\(.)/g, (_, c) => ({ n: "\n", t: "\t", '"': '"', "\\": "\\" }[c] ?? c));
}

// Convenience for tests and one-shot text: every complete Notify block in a chunk.
export function notificationsIn(text) {
  const p = new NotifyParser();
  const out = [];
  for (const line of String(text).split("\n")) { const e = p.feed(line); if (e) out.push(e); }
  const last = p.end(); if (last) out.push(last);
  return out;
}

// Which running job (if any) a finished-sounding notification belongs to: the
// folder named in the text wins, then a job whose done file already exists,
// then the newest running job for that agent.
export function matchJob(text, jobs) {
  const agent = agentInText(text);
  if (!agent) return null;
  const running = jobs.filter((j) => j.status === "running" && j.agent === agent.id);
  if (!running.length) return { agent: agent.id, kind: "foreign" };
  const runDir = (j) => j.worktree || j.dir;
  // A dir only counts when it appears as a whole path token: "repo-a" must not
  // match inside "repo-a-long" (path chars on either side mean it continues).
  const PATH_CHAR = /[\w./~:+-]/;
  const dirInText = (dir, t) => {
    let i = t.indexOf(dir);
    while (i !== -1) {
      const before = i === 0 ? "" : t[i - 1];
      const after = t[i + dir.length] || "";
      if ((!before || !PATH_CHAR.test(before)) && (!after || !PATH_CHAR.test(after))) return true;
      i = t.indexOf(dir, i + 1);
    }
    return false;
  };
  const byDir = running.find((j) => [j.worktree, j.dir].filter(Boolean).some((d) => dirInText(d, text)));
  const withDone = running.filter((j) => { try { return fs.existsSync(doneFile(runDir(j), j.id)); } catch { return false; } });
  const job = byDir || withDone[0] || running.reduce((a, b) => ((b.startedAt || 0) > (a.startedAt || 0) ? b : a));
  const kind = FINISHED.test(text) ? "agent-done" : "agent-signal";
  return { agent: agent.id, kind, job: job.id, dir: runDir(job), ambiguous: running.length > 1 && !byDir && !withDone.length };
}

// No done file yet: what does the folder actually look like? Read-only git.
export function inspectJobDir(dir, id) {
  if (!dir) return "no run dir";
  const parts = [fs.existsSync(doneFile(dir, id)) ? "done file present" : "no done file yet"];
  const log = spawnSync("git", ["-C", dir, "log", "--oneline", "-3"], { encoding: "utf8", timeout: 5000 });
  if (log.status === 0 && log.stdout.trim()) parts.push("git log: " + log.stdout.trim().split("\n").join(" | "));
  const st = spawnSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8", timeout: 5000 });
  if (st.status === 0) {
    const lines = st.stdout.split("\n").filter(Boolean);
    parts.push(lines.length ? `uncommitted: ${lines.slice(0, 4).join(", ")}` : "worktree clean");
  }
  return parts.join("; ");
}

// Which notifications she may even look at (privacy): the watcher sees every
// desktop notification, so only two kinds of sender count — a terminal that
// raises an agent CLI's OSC escape (Ghostty), or an agent CLI under its own app
// name ("Devin", "codex", "Claude Code"). Mail, chat, browsers, this plugin's own
// alerts ("Cook Meter") and everything else are dropped unread: never matched,
// never written to notify.jsonl or her log.
const TERMINAL_APPS = /^(ghostty|com\.mitchellh\.ghostty)$/i;
export function agentApp(app) {
  const a = String(app || "").trim().toLowerCase().replace(/\s+(cli|code)$/, "");
  return KNOWN.find((k) => k.names.includes(a)) || null;
}
export function allowedSender(app) {
  return TERMINAL_APPS.test(String(app || "").trim()) || !!agentApp(app);
}

// Clip without leaving a lone surrogate half of a pair at the cut.
const clip = (s, n) => {
  const str = String(s || "");
  if (str.length <= n) return str;
  let cut = str.slice(0, n - 1);
  const code = cut.charCodeAt(cut.length - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut = cut.slice(0, -1);
  return cut + "…";
};

// Her own headless jobs write to a <job-id>.log in the store dir instead of a
// terminal, so Ghostty never raises a notification for them and the bus snoop
// never hears a finish. The log is the finish signal: only the tail matters —
// a job log can be megabytes — and "finished" is either finish-sounding words
// or a line naming the done file the worker was told to write.
export function logSaysFinished(text) {
  try {
    const tail = String(text ?? "").slice(-4096);
    if (!tail) return false;
    if (FINISHED.test(tail)) return true;
    return tail.split("\n").some((l) => l.includes(".constance/done-"));
  } catch { return false; }
}

// The same event shape matchJob/handleNotification produce for a bus
// notification, but sourced from the job itself (its exit, its log tail, or
// the done file appearing) rather than a desktop notification. Never carries
// log text or notification bodies — only the clipped job summary.
export function jobFinishSignal(job, { source, runDir } = {}) {
  return {
    at: Date.now(),
    agent: job.agent,
    kind: "agent-done",
    source,
    job: job.id,
    dir: runDir,
    summary: clip(job.summary, 120),
    inspection: runDir ? inspectJobDir(runDir, job.id) : "no run dir",
  };
}

// Append one signal to notify.jsonl, the same record handleNotification
// writes. A signal for a job id already on file is a duplicate — the job's
// exit, log and done file can all report the same finish — so it is skipped.
// Events without a job id (foreign/owner runs) have nothing to dedupe on.
export function recordSignal(storeDir, ev) {
  if (!storeDir || !ev || typeof ev !== "object") return false;
  if (ev && ev.job != null) {
    for (const old of recentSignals(storeDir, Infinity)) {
      if (old && old.job === ev.job) return false;
    }
  }
  try { fs.appendFileSync(notifyFile(storeDir), JSON.stringify(ev) + "\n"); return true; } catch { return false; }
}

// One notification -> record it, log what matters, return the event (null for
// unrelated notifications so they never reach her log or any file).
// What is kept is minimal: a signal for one of her running jobs keeps a clipped
// summary (never the body); one for an agent she didn't start (the owner's own
// run) keeps no text at all — just which agent finished, and when.
export function handleNotification({ app = "", summary = "", body = "" }, { jobs = [], storeDir = "" } = {}) {
  if (!allowedSender(app)) return null;
  const fromAgent = agentApp(app);
  const text = `${fromAgent ? app + " " : ""}${summary} ${body}`.trim();
  const m = matchJob(text, jobs);
  if (!m) return null;
  let ev;
  if (m.kind === "foreign") {
    if (!FINISHED.test(`${summary} ${body}`)) return null;   // only "finished" news is worth noting
    ev = { at: Date.now(), agent: m.agent, kind: "foreign" };
  } else {
    // The body is matched on but never stored — not even as a summary fallback.
    ev = { at: Date.now(), agent: m.agent, kind: m.kind, summary: clip(summary, 120), job: m.job, dir: m.dir };
    if (m.ambiguous) ev.note = "several jobs for this agent were running; matched the newest";
    if (m.kind === "agent-done") ev.inspection = inspectJobDir(m.dir, m.job);
  }
  recordSignal(storeDir, ev);
  return ev;
}

export function recentSignals(storeDir, n = 10) {
  try {
    const lines = fs.readFileSync(notifyFile(storeDir), "utf8").trim().split("\n").filter(Boolean);
    const parsed = [];
    for (const l of lines) {
      try { parsed.push(JSON.parse(l)); } catch { /* one corrupt line must not hide the rest */ }
    }
    if (!(n > 0)) return [];
    return n === Infinity ? parsed : parsed.slice(-n);
  } catch { return []; }
}
