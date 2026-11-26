// Constance's handoff file: <project>/.constance/handoff.md.
//
// Her brain no longer carries one long Claude Code session through a goal. Each
// planning step and each review batch is a fresh session that reads this file
// (plus her lessons and what the step needs), does the step and exits. The file
// is the whole memory between sessions, so it must be short and always true:
//
// - Only the controller writes it (the driver and her own `C handoff ...`
//   commands, which run controller code). Workers can't: the sandbox binds the
//   project's .constance/ read-only. What she records lives on the goal in
//   jobs.json (`goal.handoff`, under the store's lock); the file is re-rendered
//   from that plus the job list, so a crash, a deleted file or a hand edit loses
//   nothing — the next render puts the true one back.
// - It stays under MAX_LINES: done checklist items and reviewed jobs collapse to
//   one line each, and every list keeps only its newest entries (the older ones
//   stay in jobs.json and `C handoff --all`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export const MAX_LINES = 150;
const LINE = 220;          // a rendered line never gets longer than this
const CAPS = { goal: 20, open: 30, jobs: 20, decisions: 12, problems: 10, next: 10 };

const clip = (s, n = LINE) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const sha = (text) => createHash("sha256").update(String(text)).digest("hex").slice(0, 16);

// ---------------------------------------------------------------- the memory on the goal

export function memoryOf(goal) {
  const h = goal && typeof goal.handoff === "object" && goal.handoff ? goal.handoff : {};
  const arr = (x) => (Array.isArray(x) ? x.filter((e) => e && typeof e === "object") : []);
  return { decisions: arr(h.decisions), problems: arr(h.problems), next: arr(h.next), steps: arr(h.steps), sha: typeof h.sha === "string" ? h.sha : "" };
}

// The step number new entries are filed under: the open step, else the last one.
const stepNow = (mem) => (mem.steps.length ? mem.steps[mem.steps.length - 1].n : 0);

export function addDecision(mem, text, now = Date.now()) {
  const t = clip(text, 400);
  if (!t) throw new Error("Usage: handoff decide TEXT");
  mem.decisions.push({ at: now, step: stepNow(mem), text: t });
  return mem.decisions.length;
}

export function addProblem(mem, text, now = Date.now()) {
  const t = clip(text, 400);
  if (!t) throw new Error("Usage: handoff problem TEXT");
  const n = mem.problems.reduce((m, p) => Math.max(m, Number(p.n) || 0), 0) + 1;
  mem.problems.push({ n, at: now, step: stepNow(mem), text: t });
  return n;
}

export function solveProblem(mem, n, note = "", now = Date.now()) {
  const p = mem.problems.find((x) => Number(x.n) === Number(n));
  if (!p) throw new Error(`No open problem ${n}.`);
  if (p.solvedAt) throw new Error(`Problem ${n} is already solved.`);
  p.solvedAt = now; p.solvedNote = clip(note, 300);
  return p;
}

// Notes for the next session: a step's notes replace the ones it was given,
// so the file always holds the latest step's word, not a growing pile.
export function addNext(mem, text, now = Date.now()) {
  const t = clip(text, 400);
  if (!t) throw new Error("Usage: handoff next TEXT");
  mem.next.push({ at: now, step: stepNow(mem), text: t });
  return mem.next.length;
}
export const currentNext = (mem) => {
  if (!mem.next.length) return [];
  const last = Math.max(...mem.next.map((e) => Number(e.step) || 0));
  return mem.next.filter((e) => (Number(e.step) || 0) === last);
};

// One brain session = one step. beginStep files it; endStep closes it with how it ended.
export function beginStep(mem, { kind, session = "", model = "", jobs = [], promptChars = 0, resumed = "", mark = null, now = Date.now() }) {
  const n = stepNow(mem) + 1;
  mem.steps.push({ n, kind, session, model, jobs: [...jobs], promptChars, startedAt: now, ...(mark !== null ? { mark } : {}), ...(resumed ? { resumed } : {}) });
  return n;
}
export function endStep(mem, { outcome = "ok", code = 0, outChars = 0, now = Date.now() } = {}) {
  const s = openStep(mem);
  if (!s) return null;
  s.endedAt = now; s.outcome = outcome; s.code = code; s.outChars = outChars;
  return s;
}
export const openStep = (mem) => { const s = mem.steps[mem.steps.length - 1]; return s && !s.endedAt ? s : null; };

// ---------------------------------------------------------------- rendering

const STATE_WORD = { todo: "todo", working: "working", review: "waiting for review", problem: "PROBLEM" };
const OPEN_JOB = new Set(["waiting", "held", "running", "finished", "merged", "conflict"]);
const clock = (t) => { const d = new Date(t); return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 16).replace("T", " ") + "Z" : "?"; };

// A list capped to its newest `cap` entries, with one line saying how many older ones exist.
function newest(list, cap, older) {
  if (list.length <= cap) return { shown: list, more: "" };
  return { shown: list.slice(-cap), more: older(list.length - cap) };
}

// The file's text. `items` is checklist(goal, jobs).items; `name(id)` gives an
// agent's display name. Pure: the same inputs always give the same file.
// `liveStep` is the open step whose session is running right now (not interrupted).
export function renderHandoff({ goal, jobs = [], items = [], name = (id) => id, practice = false, liveStep = 0 }) {
  if (!goal) return "";
  const mem = memoryOf(goal);
  const mine = jobs.filter((j) => !j.goal || j.goal === goal.id);
  const L = [];
  const head = clip(String(goal.text || "").split("\n").find((l) => l.trim()) || "goal", 120);
  L.push(`# Handoff: ${head}`);
  L.push(`Goal ${goal.id} · started ${clock(goal.startedAt)} · ${goal.status || "running"}${practice ? " · PRACTICE (dry run)" : ""}`);
  L.push("Written by the controller only. Change it with `C handoff decide|problem|solved|next`; never edit this file.");

  L.push("", "## Goal");
  // Lines that are checklist items are shown once, in the checklist; the goal
  // section keeps the rest (the owner's preamble and notes).
  const itemText = new Set(items.map((i) => String(i.text || "").replace(/\s+/g, " ").trim()));
  const unmark = (l) => l.replace(/^\s*(\d+[.)]|[-*•]|\[[ xX]\])\s+/, "").replace(/\s+/g, " ").trim();
  const whole = String(goal.text || "").replace(/\s+/g, " ").trim();
  const single = items.length === 1 && itemText.has(whole);
  const gl = String(goal.text || "").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() && (single || !itemText.has(unmark(l))));
  for (const l of gl.slice(0, CAPS.goal)) L.push(clip(l));
  if (gl.length > CAPS.goal) L.push(`… ${gl.length - CAPS.goal} more goal lines (full text: \`C status\`)`);
  if (!gl.length) L.push("(the checklist below is the whole goal)");

  L.push("", "## Checklist");
  const done = items.filter((i) => i.state === "done"), open = items.filter((i) => i.state !== "done");
  if (done.length) L.push(clip(`- [x] Done ${done.length} of ${items.length}: ${done.map((i) => `${i.n} ${clip(i.text, 40)}`).join("; ")}`, 400));
  const o = newest(open.slice().reverse(), CAPS.open, (k) => `- … ${k} more open items (\`C status\`)`);
  for (const i of o.shown.slice().reverse()) {
    const js = i.jobs?.length ? ` (job${i.jobs.length === 1 ? "" : "s"} ${i.jobs.join(", ")})` : "";
    L.push(clip(`- [ ] ${i.n}. ${single ? "(the goal above)" : i.text} — ${STATE_WORD[i.state] || i.state}${js}`));
  }
  if (o.more) L.push(o.more);
  if (!items.length) L.push("- (no checklist)");

  L.push("", "## Job board");
  const openJobs = mine.filter((j) => OPEN_JOB.has(j.status));
  const closed = mine.filter((j) => !OPEN_JOB.has(j.status));
  if (closed.length) {
    const by = (st) => closed.filter((j) => j.status === st).map((j) => j.id);
    const parts = [["accepted", "accepted"], ["sent back", "sent back"], ["stopped", "stopped"], ["failed", "failed"]]
      .map(([st, w]) => { const ids = by(st); return ids.length ? `${ids.length} ${w} (${ids.join(", ")})` : ""; }).filter(Boolean);
    const other = closed.filter((j) => !["accepted", "sent back", "stopped", "failed"].includes(j.status)).length;
    L.push(clip(`- Closed: ${parts.join(", ")}${other ? `, ${other} other` : ""}`, 400));
  }
  const oj = newest(openJobs, CAPS.jobs, (k) => `- … ${k} more open jobs (\`C jobs\`)`);
  for (const j of oj.shown) {
    const who = j.worker || name(j.agent);
    const it = Array.isArray(j.items) && j.items.length ? ` item ${j.items.join(",")}` : "";
    const files = j.files?.length ? ` · files ${clip(j.files.join(","), 60)}` : " · read-only";
    L.push(clip(`- #${j.id} ${who}${it} · ${j.status} · ${j.title || j.task || ""}${files}`));
  }
  if (oj.more) L.push(oj.more);
  if (!mine.length) L.push("- (no jobs yet)");

  L.push("", "## Decisions made");
  const d = newest(mem.decisions, CAPS.decisions, (k) => `- … ${k} earlier decisions (\`C handoff --all\`)`);
  if (d.more) L.push(d.more);
  for (const e of d.shown) L.push(clip(`- ${e.text}`));
  if (!mem.decisions.length) L.push("- (none yet)");

  L.push("", "## Open problems");
  const openP = mem.problems.filter((p) => !p.solvedAt);
  const solved = mem.problems.length - openP.length;
  const p = newest(openP, CAPS.problems, (k) => `- … ${k} older open problems (\`C handoff --all\`)`);
  if (p.more) L.push(p.more);
  for (const e of p.shown) L.push(clip(`- P${e.n}: ${e.text}`));
  if (!openP.length) L.push("- (none)");
  if (solved) L.push(`- (${solved} solved)`);

  L.push("", "## Notes for the next session");
  const nx = currentNext(mem);
  const n = newest(nx, CAPS.next, (k) => `- … ${k} more notes (\`C handoff --all\`)`);
  if (n.more) L.push(n.more);
  for (const e of n.shown) L.push(clip(`- ${e.text}`));
  const last = mem.steps[mem.steps.length - 1];
  const cut = last && !last.endedAt && last.n !== liveStep;
  if (last && !last.endedAt && last.n === liveStep) L.push(clip(`- Step ${last.n} (${last.kind}) is running now.`));
  else if (cut) L.push(clip(`- The step-${last.n} session (${last.kind}) did not finish: it was interrupted. Its notes may be missing; the board above is current.`));
  else if (last && last.outcome && last.outcome !== "ok") L.push(clip(`- The step-${last.n} session (${last.kind}) ended: ${last.outcome}. The board above is current.`));
  if (!nx.length && !(last && (!last.endedAt || (last.outcome && last.outcome !== "ok")))) L.push("- (none)");

  if (last) L.push("", clip(`Steps so far: ${mem.steps.length} (${mem.steps.filter((s) => s.kind === "plan").length} plan, ${mem.steps.filter((s) => s.kind === "review").length} review).`));
  // A last guard: the caps above keep it well under, but never past MAX_LINES.
  if (L.length > MAX_LINES) return [...L.slice(0, MAX_LINES - 1), "… (trimmed to stay short: `C handoff --all`)"].join("\n") + "\n";
  return L.join("\n") + "\n";
}

// ---------------------------------------------------------------- where it lives

// The Omarchy shell reloads every plugin (closing open panels) on any write inside
// ~/.config/omarchy/plugins/. A project living there keeps its handoff file in her
// state dir instead, so planning steps never close the owner's panel.
export function insidePlugins(dir, env = process.env) {
  const plugins = path.resolve(path.join(env.HOME || os.homedir(), ".config", "omarchy", "plugins"));
  const root = path.resolve(dir || "");
  return root === plugins || root.startsWith(plugins + path.sep);
}

export function handoffFile(dir, stateDir, env = process.env) {
  if (insidePlugins(dir, env)) {
    const tag = path.basename(path.resolve(dir)).replace(/[^\w.-]+/g, "_") + "-" + sha(path.resolve(dir)).slice(0, 8);
    return { file: path.join(stateDir, "handoff", `${tag}.md`), inProject: false };
  }
  return { file: path.join(dir, ".constance", "handoff.md"), inProject: true };
}

// Write the file atomically; returns its hash and whether the file on disk had
// been changed by someone else since the controller's last write (`lastSha`).
export function writeHandoff(file, text, lastSha = "") {
  let tampered = false;
  if (lastSha) { try { tampered = sha(fs.readFileSync(file, "utf8")) !== lastSha; } catch { tampered = false; } }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  return { sha: sha(text), tampered };
}
export const textSha = sha;
