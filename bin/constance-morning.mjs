// Constance's morning report: when her goal queue runs empty, one short markdown
// recap of what got done, what it cost in tokens, and what still needs the owner.
// Written to the state dir so the panel (or a reminder) can show it later.
import fs from "node:fs";
import path from "node:path";
import { fmtTokens } from "./constance-tokens.mjs";

export const morningFile = (dir) => path.join(dir, "morning-report.md");
export const stampFile = (dir) => path.join(dir, "morning.json");

// When the last report was written (ms), 0 when missing or broken.
export function lastReportAt(dir) {
  try {
    const d = JSON.parse(fs.readFileSync(stampFile(dir), "utf8"));
    return Number(d.at) || 0;
  } catch { return 0; }
}

const firstLine = (t) => String(t || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) || "";
const clip = (t, n) => (t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t);
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

const day = (now) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// { title, body, text, goals } for the desktop notification and the markdown file.
// Only records finished after `since` count; `needs` are extra owner-attention strings.
export function buildReport({ records = [], since = 0, now = Date.now(), needs = [] } = {}) {
  const done = records.filter((r) => Number(r.finishedAt) > since);
  const goals = done.length;

  let tokens = 0, cantTell = 0, merged = 0, sentBack = 0;
  const needsYou = new Set();
  for (const r of done) {
    if (!r.practice) {
      if (typeof r.tokens === "number") tokens += r.tokens;
      cantTell += Number(r.tokensCantTell) || 0;
      merged += Number(r.merged) || 0;
      sentBack += Number(r.sentBack) || 0;
    }
    if (r.needsOwner) needsYou.add(String(r.needsOwner).trim());
  }
  for (const n of needs) if (String(n || "").trim()) needsYou.add(String(n).trim());

  const lines = [`# Morning report — ${day(now)}`, "", "## Done"];
  if (!goals) lines.push("No goals finished since the last report.");
  for (const r of done) {
    const parts = [r.outcome || r.status || "finished"];
    if (Number(r.itemsTotal) > 0) parts.push(`${Number(r.itemsDone) || 0}/${Number(r.itemsTotal)}`);
    parts.push(`${r.merged || 0} merged, ${r.sentBack || 0} sent back`);
    if (r.practice) parts.push("(practice)");
    lines.push(`- ${clip(firstLine(r.text), 80)} — ${parts.join(" · ")}`);
  }
  if (goals) {
    lines.push("", `Tokens: ${fmtTokens(tokens)}${cantTell ? ` (${cantTell} job${cantTell === 1 ? "" : "s"} can't tell)` : ""}`);
  }
  lines.push("", "## Needs you");
  if (needsYou.size) for (const n of needsYou) lines.push(`- ${n}`);
  else lines.push("Nothing needs you.");
  const text = lines.join("\n") + "\n";

  const title = "Constance: morning report";
  const first = [...needsYou][0] ? [...needsYou][0].replace(/\.+$/, "") : "";
  let body;
  if (!goals) body = needsYou.size ? `No goals finished. Needs you: ${first}.` : "No goals finished since the last report. Nothing needs you.";
  else body = `${plural(goals, "goal")} done, ${plural(merged, "job")} merged, ${fmtTokens(tokens)} tokens.`;
  if (goals && needsYou.size) body += ` Needs you: ${[...needsYou].map((n) => n.replace(/\.+$/, "")).join("; ")}.`;
  else if (goals) body += " Nothing needs you.";
  if (body.length > 200) body = body.slice(0, 199).trimEnd() + "…";

  return { title, body, text, goals };
}

// Writes the markdown and its stamp, each via tmp + rename so a crash mid-write
// never leaves a half file. Returns the report's path.
export function writeReport(dir, report, now = Date.now()) {
  fs.mkdirSync(dir, { recursive: true });
  const atomic = (file, data) => {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  };
  atomic(morningFile(dir), report.text);
  atomic(stampFile(dir), JSON.stringify({ at: now, goals: report.goals }));
  return morningFile(dir);
}
