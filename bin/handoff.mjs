// A handoff note for the next agent. When an agent's SESSION usage nears its limit (the once-per-window warning, or the
// limit being hit), the plugin writes handoff/HANDOFF.md in the active repo, and makes sure AGENTS.md tells any agent to
// read that folder first. The note is rebuilt every time the warning fires, from recent git commits, the working tree and
// the repo's CLAUDE.md. Nothing is invented: a part with no source says so. Emails and long tokens are scrubbed.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const FOLDER = "handoff";
export const NOTE = "HANDOFF.md";
export const MARKER = "<!-- cook-meter-handoff -->";
export const AGENTS_LINE = `${MARKER} Before you start, read the \`handoff/\` folder (\`handoff/HANDOFF.md\`): it says what was in progress when the previous agent hit its usage limit.`;

const git = (repo, ...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 10000 });
const out = (r) => (r.status === 0 ? String(r.stdout || "").trim() : "");

// Keep personal data and secrets out of a file that lands in a repo.
export function scrub(text) {
  return String(text || "")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\b(sk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{16,}\b/g, "[token]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{16,}/g, "Bearer [token]");
}

// ---- CLAUDE.md -------------------------------------------------------------------------------------------------
export function parseSections(md) {
  const sections = []; let cur = { title: "", lines: [] };
  for (const line of String(md || "").split("\n")) {
    const h = line.match(/^#{1,3}\s+(.*\S)\s*$/);
    if (h) { sections.push(cur); cur = { title: h[1], lines: [] }; } else cur.lines.push(line);
  }
  sections.push(cur);
  return sections.filter((s) => s.title || s.lines.some((l) => l.trim()));
}
const bullets = (lines, max) => lines.filter((l) => /^\s*([-*]|\d+[.)])\s+\S/.test(l)).map((l) => l.replace(/^\s*([-*]|\d+[.)])\s+/, "").trim()).slice(0, max);
const paragraph = (lines) => { const p = []; for (const l of lines) { if (!l.trim()) { if (p.length) break; else continue; } p.push(l.trim()); } return p.join(" "); };
const clip = (s, n = 220) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

export function readClaudeMd(md) {
  const secs = parseSections(md);
  const goalSec = secs.find((s) => /goal|overview|about|purpose|mission/i.test(s.title)) || secs.find((s) => s.lines.some((l) => l.trim()));
  const pick = (re, max) => secs.filter((s) => re.test(s.title)).flatMap((s) => { const b = bullets(s.lines, max); return b.length ? b : (paragraph(s.lines) ? [paragraph(s.lines)] : []); }).slice(0, max);
  return {
    goal: goalSec ? clip(paragraph(goalSec.lines)) : "",
    next: pick(/^(next|up next|to-?do|roadmap|backlog|planned)/i, 8).map((x) => clip(x)),
    problems: pick(/known|open (problem|issue|question)|issues?\b|problems?\b|gaps?\b|pitfalls?|caveats?|bugs?\b|limitations?/i, 8).map((x) => clip(x)),
  };
}

// ---- the repo --------------------------------------------------------------------------------------------------
export function repoInfo(repo) {
  const log = out(git(repo, "log", "-n", "10", "--date=short", "--pretty=format:%h|%ad|%s")).split("\n").filter(Boolean)
    .map((l) => { const [h, d, ...s] = l.split("|"); return { hash: h, date: d, subject: s.join("|") }; });
  const status = out(git(repo, "status", "--short")).split("\n").filter(Boolean);
  let claudeMd = ""; try { claudeMd = fs.readFileSync(path.join(repo, "CLAUDE.md"), "utf8"); } catch {}
  return { name: path.basename(repo), branch: out(git(repo, "rev-parse", "--abbrev-ref", "HEAD")), log, status, claude: claudeMd ? readClaudeMd(claudeMd) : null };
}

const stamp = (now) => { const d = new Date(now); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

// trigger = { agent, percent, title, resetsIn, level }
export function buildNote(info, trigger, now = Date.now()) {
  const L = [];
  const pct = Math.round((trigger.percent || 0) * 100);
  const why = trigger.level === "limit" ? `hit its ${trigger.title.toLowerCase()} limit` : `is at ${pct}% of its ${trigger.title.toLowerCase()} limit`;
  L.push("# Handoff", "");
  L.push(`Written ${stamp(now)} by Cook Meter because **${trigger.agent}** ${why}${trigger.resetsIn ? ` (${trigger.resetsIn})` : ""}. It is rebuilt each time that warning fires, so it reflects the repo as of then. Read it first, then carry on.`, "");
  L.push("## What we were working on", "");
  if (info.claude?.goal) L.push(`Project goal (from CLAUDE.md): ${info.claude.goal}`, "");
  if (info.log[0]) L.push(`Branch \`${info.branch || "?"}\`. Latest commit: \`${info.log[0].hash}\` ${info.log[0].subject} (${info.log[0].date}).`);
  if (info.status.length) L.push(`Uncommitted work in progress (${info.status.length} file${info.status.length > 1 ? "s" : ""}):`, ...info.status.slice(0, 12).map((s) => `- \`${s}\``), ...(info.status.length > 12 ? [`- …and ${info.status.length - 12} more`] : []));
  else L.push("The working tree is clean: nothing uncommitted.");
  L.push("", "## What's done", "");
  if (info.log.length) L.push(...info.log.map((c) => `- \`${c.hash}\` ${c.subject} (${c.date})`));
  else L.push("No commits yet.");
  L.push("", "## What's next", "");
  const next = info.claude?.next || [];
  if (next.length) L.push(...next.map((x) => `- ${x}`));
  else L.push("Nothing is recorded as next in CLAUDE.md." + (info.status.length ? " Finish the uncommitted work above first." : " Ask the user what to do next."));
  L.push("", "## Open problems", "");
  const probs = info.claude?.problems || [];
  if (probs.length) L.push(...probs.map((x) => `- ${x}`));
  else L.push("None recorded in CLAUDE.md." + (info.status.length ? " The uncommitted changes may be unfinished or untested; check them before building on them." : ""));
  L.push("", "---", "Sources: `git log`, `git status`, and CLAUDE.md. Check `git diff` for the details of unfinished work.", "");
  return scrub(L.join("\n"));
}

// Adds the one line to AGENTS.md (creating the file if there is none), once.
export function ensureAgentsLine(repo) {
  const file = path.join(repo, "AGENTS.md");
  let text = ""; try { text = fs.readFileSync(file, "utf8"); } catch {}
  if (text.includes(MARKER)) return false;
  fs.writeFileSync(file, text ? `${text.replace(/\n*$/, "\n")}\n${AGENTS_LINE}\n` : `${AGENTS_LINE}\n`);
  return true;
}

// handoff/ is added to .git/info/exclude (local to this clone, not a tracked file), so the notes stay on this machine
// unless you choose to commit them. Agents still find the folder on disk.
export function excludeFolder(repo) {
  const gitDir = out(git(repo, "rev-parse", "--git-dir"));
  if (!gitDir) return false;
  const file = path.join(path.isAbsolute(gitDir) ? gitDir : path.join(repo, gitDir), "info", "exclude");
  let text = ""; try { text = fs.readFileSync(file, "utf8"); } catch {}
  if (text.split("\n").some((l) => l.trim() === `${FOLDER}/`)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${text.replace(/\n*$/, text ? "\n" : "")}${FOLDER}/\n`);
  return true;
}

export function writeHandoff(repo, trigger, now = Date.now()) {
  const dir = path.join(repo, FOLDER);
  fs.mkdirSync(dir, { recursive: true });
  excludeFolder(repo);
  const file = path.join(dir, NOTE);
  fs.writeFileSync(file, buildNote(repoInfo(repo), trigger, now));
  const addedLine = ensureAgentsLine(repo);
  return { file, addedLine };
}

// ---- which repo is "active" -------------------------------------------------------------------------------------
const toplevel = (dir) => (dir && fs.existsSync(dir) ? out(git(dir, "rev-parse", "--show-toplevel")) : "");

// The repo of the most recently used Claude Code session (within `maxAgeMs`), read from its transcript's cwd; else the
// last folder picked for Claude Squad. "" when neither is a git repo.
export function findActiveRepo({ projectsDir, squadDirFile, now = Date.now(), maxAgeMs = 6 * 3600 * 1000 } = {}) {
  try {
    let best = null;
    for (const d of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(projectsDir, d.name))) {
        if (!f.endsWith(".jsonl")) continue;
        const p = path.join(projectsDir, d.name, f), m = fs.statSync(p).mtimeMs;
        if (!best || m > best.m) best = { p, m };
      }
    }
    if (best && now - best.m <= maxAgeMs) {
      const fd = fs.openSync(best.p, "r"); const size = fs.fstatSync(fd).size, len = Math.min(size, 131072);
      const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
      const all = [...buf.toString("utf8").matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)];
      for (let i = all.length - 1; i >= 0; i--) { const top = toplevel(JSON.parse(`"${all[i][1]}"`)); if (top) return top; }
    }
  } catch {}
  try { const top = toplevel(fs.readFileSync(squadDirFile, "utf8").trim()); if (top) return top; } catch {}
  return "";
}

// What the collector calls after it sent alerts. `sent` = alert items ({ agent, limit, level }) that really went out.
// Only SESSION meters count (the request is about session usage nearing its limit), one note per run for the agent
// closest to its limit.
//   settings.handoffNote === true   -> write the note
//   settings.handoffNote === false  -> never
//   not decided yet                 -> write NOTHING: remember what would be written in `pendingFile` and return "asked"
//                                      the first time, so the panel can ask. (Allow / Not now / Never are in the panel.)
// Returns the written path, "asked" (first question), "pending" (already waiting for an answer), or "".
export function maybeWriteHandoff({ sent, settings, untilReset = () => "", projectsDir, squadDirFile, pendingFile, now = Date.now() }) {
  const session = (sent || []).filter((i) => /session/i.test(String(i.limit?.title)));
  const setting = (settings || {}).handoffNote;
  if (!session.length || setting === false) return "";
  const top = session.reduce((a, b) => (b.limit.percent > a.limit.percent ? b : a));
  const repo = findActiveRepo({ projectsDir, squadDirFile, now });
  if (!repo) return "";
  const trigger = { agent: top.agent.name, percent: top.limit.percent, title: top.limit.title, resetsIn: untilReset(top.limit.resetsAt), level: top.level };
  if (setting === true) return writeHandoff(repo, trigger, now).file;
  if (!pendingFile) return "";
  const first = !fs.existsSync(pendingFile);
  fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
  fs.writeFileSync(pendingFile, JSON.stringify({ repo, trigger, at: now }) + "\n", { mode: 0o600 });
  return first ? "asked" : "pending";
}

// The panel's answer to the question. allow = write the waiting note now; dismiss = forget it (it asks again next time).
export function answerPending(pendingFile, action) {
  let p = null; try { p = JSON.parse(fs.readFileSync(pendingFile, "utf8")); } catch {}
  try { fs.unlinkSync(pendingFile); } catch {}
  if (action === "allow" && p?.repo && p?.trigger) return writeHandoff(p.repo, p.trigger).file;
  return "";
}
