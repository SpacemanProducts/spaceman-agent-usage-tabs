// Constance remote status, step one (read-only): a short plain-text summary of
// `node bin/constance.mjs status` that is safe to sync to a phone. It is built
// only from the named status fields — goal text, checklist items, job counts,
// pace windows, practice flag — and every string is stripped of anything that
// looks like a path or an email, so no file paths, prompts, reports, log text
// or home-folder details can leak into it.
import fs from "node:fs";
import path from "node:path";

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PATHY = /(^\/|\/home\/)/;

// Drops whitespace-separated tokens that look like an email or a path
// (starts with "/" or contains "/home/"), then collapses the rest to one line.
function clean(t) {
  return String(t ?? "")
    .split(/\s+/)
    .filter((w) => w && !EMAIL.test(w) && !PATHY.test(w))
    .join(" ")
    .trim();
}

const clip = (t, n) => (t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t);
const firstLine = (t) => String(t ?? "").split(/\r?\n/)[0];

const GLYPH = { done: "✓", working: "…", review: "?", problem: "!", todo: "·" };

const pct = (w) => {
  const used = Number(w?.used);
  return Number.isFinite(used) ? Math.round(used * 100) : null;
};

// status is the JSON object `constance.mjs status` prints. Returns <= ~15 lines.
export function remoteSummary(status) {
  const s = status && typeof status === "object" ? status : {};
  const goal = typeof s.goal === "string" ? s.goal : s.goal?.text || "";
  const items = Array.isArray(s.board?.checklist?.items) ? s.board.checklist.items : [];
  const jobs = Array.isArray(s.jobs) ? s.jobs : [];
  const wins = Array.isArray(s.pace?.windows) ? s.pace.windows : [];

  const lines = [`Goal: ${clip(clean(firstLine(goal)), 80) || "none"}`];

  const counts = { running: 0, held: 0, finished: 0, other: 0 };
  for (const j of jobs) {
    const st = j?.status;
    if (st === "running" || st === "held" || st === "finished") counts[st]++;
    else counts.other++;
  }
  let jobLine = `Jobs: ${counts.running} running · ${counts.held} held · ${counts.finished} finished`;
  if (counts.other) jobLine += ` · ${counts.other} other`;

  const lim = [];
  for (const title of ["Session", "Weekly"]) {
    const w = wins.find((x) => String(x?.title || "").toLowerCase() === title.toLowerCase());
    const p = pct(w);
    if (p !== null) lim.push(`${title} ${p}%`);
  }
  const tail = [jobLine, lim.length ? `Limits: ${lim.join(" · ")}` : "Limits: no data"];
  if (s.practice) tail.push("Practice run — nothing is launched");

  if (items.length) {
    const done = items.filter((it) => it?.state === "done").length;
    lines.push(`Checklist: ${done}/${items.length} done`);
    const itemLines = items.map((it, i) => {
      const glyph = GLYPH[it?.state] || "·";
      const n = Number.isFinite(Number(it?.n)) ? it.n : i + 1;
      return `${glyph} ${n} ${clip(clean(firstLine(it?.text)) || "(no text)", 40)}`;
    });
    // Keep the whole summary under ~15 lines: goal + count + jobs + limits (+practice).
    const avail = Math.max(0, 15 - lines.length - tail.length);
    if (itemLines.length > avail) {
      const keep = Math.max(0, avail - 1);
      lines.push(...itemLines.slice(0, keep), `… ${itemLines.length - keep} more`);
    } else lines.push(...itemLines);
  }

  lines.push(...tail);
  return lines.join("\n") + "\n";
}

// Writes the summary via tmp + rename so a sync never picks up half a file.
export function writeRemoteStatus(status, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, remoteSummary(status));
  fs.renameSync(tmp, file);
  return file;
}
