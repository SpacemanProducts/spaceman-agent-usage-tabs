// Constance's per-project backlog: worthwhile work she may spend leftover
// agent room on, kept as an owner-editable markdown file at
// <project>/.constance/backlog.md. Each item is one line:
// '- [ ] kind: text' (open) or '- [x] kind: text' (done), optionally ending
// in ' (files: a.mjs, b.mjs)' and, once handed out, ' (job 12)'. A line
// without a known 'kind:' prefix is kind 'task' with the whole text. Other
// lines (headings, blanks, prose) are kept untouched when the file is
// rewritten. User text and file names are stored with '\', '(' and ')'
// backslash-escaped so they can never be mistaken for those tags, commas
// inside file names are escaped so they survive the '(files: ...)' split,
// item text has its newlines folded to spaces, and '\r\n' line endings are
// tolerated.
import fs from "node:fs";
import path from "node:path";

export const KINDS = ["review", "bug", "design", "task", "test", "docs"];

export function backlogFile(dir) {
  return path.join(dir, ".constance", "backlog.md");
}

const ITEM_RE = /^- \[([ xX])\] (.*)\r?$/;

// User text is stored escaped so a trailing '(job N)' or '(files: ...)'
// in it stays text; parseBacklog unescapes after stripping real tags.
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const unesc = (s) => s.replace(/\\([\\()])/g, "$1");
// File names also escape ',' so the '(files: ...)' split leaves them alone;
// unescFile undoes that extra escape after the shared unesc pass.
const escFile = (s) => esc(s).replace(/,/g, "\\,");
const unescFile = (s) => unesc(s).replace(/\\,/g, ",");

// Split a '(files: ...)' body on commas, keeping backslash-escaped pairs
// (\\, \( etc.) together so an escaped comma does not split.
function splitFiles(s) {
  const parts = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) { cur += ch + s[i + 1]; i++; continue; }
    if (ch === ",") { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

// Split an item body into kind/text plus any trailing ' (files: ...)' and
// ' (job N)' groups, in whichever order they appear.
function splitBody(body) {
  const files = [];
  let job = null;
  let rest = body;
  for (;;) {
    const jm = rest.match(/^(.*) \(job (\d+)\)$/);
    if (jm) { if (job === null) job = Number(jm[2]); rest = jm[1]; continue; }
    const fm = rest.match(/^(.*) \(files: (.+)\)$/);
    if (fm) {
      files.unshift(...splitFiles(fm[2]).map((s) => s.trim()).filter(Boolean));
      rest = fm[1];
      continue;
    }
    break;
  }
  const km = rest.match(/^([a-z]+):\s+(.+)$/);
  const unescapedFiles = files.map(unescFile);
  if (km && KINDS.includes(km[1])) return { kind: km[1], text: unesc(km[2]), files: unescapedFiles, job };
  return { kind: "task", text: unesc(rest), files: unescapedFiles, job };
}

export function parseBacklog(text) {
  const lines = String(text ?? "").split("\n");
  const items = [];
  lines.forEach((line, i) => {
    const m = line.match(ITEM_RE);
    if (!m) return;
    const { kind, text: body, files, job } = splitBody(m[2]);
    items.push({ id: items.length + 1, kind, text: body, files, job, done: m[1] !== " ", line: i });
  });
  return items;
}

export function readBacklog(dir) {
  let text;
  try { text = fs.readFileSync(backlogFile(dir), "utf8"); } catch { return []; }
  return parseBacklog(text);
}

function writeBacklog(dir, content) {
  const file = backlogFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

// Find an item by id and apply fn(lines, item) to the file's lines, then
// write the result back atomically. Returns false when the item is missing.
function editItem(dir, id, fn) {
  let text;
  try { text = fs.readFileSync(backlogFile(dir), "utf8"); } catch { return false; }
  const item = parseBacklog(text).find((x) => x.id === id);
  if (!item) return false;
  const lines = text.split("\n");
  fn(lines, item);
  writeBacklog(dir, lines.join("\n"));
  return true;
}

// Append an item. Creates the folder and a '# Backlog' heading when the file
// doesn't exist. Refuses empty text or an unknown kind. Returns the existing
// item instead of adding a duplicate of an open item with the same kind/text.
export function addItem(dir, { kind = "task", text, files = [] } = {}) {
  const body = String(text ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!body) throw new Error("backlog item needs text");
  if (!KINDS.includes(kind)) throw new Error(`unknown backlog kind: ${kind}`);
  let content = "";
  try { content = fs.readFileSync(backlogFile(dir), "utf8"); } catch {}
  const items = parseBacklog(content);
  const dup = items.find((x) => !x.done && x.kind === kind && x.text === body);
  if (dup) return dup;
  const fileList = (files || []).map((f) => String(f).replace(/[\r\n]+/g, " ")).filter(Boolean);
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  let line = `- [ ] ${kind}: ${esc(body)}`;
  if (fileList.length) line += ` (files: ${fileList.map(escFile).join(", ")})`;
  if (!content) content = "# Backlog\n";
  if (!content.endsWith("\n")) content += eol;
  const lineIndex = content.split("\n").length - 1;
  writeBacklog(dir, content + line + eol);
  return { id: items.length + 1, kind, text: body, files: fileList, job: null, done: false, line: lineIndex };
}

// Tag an item as handed to a job, replacing an earlier job tag. jobId must
// be a non-negative safe integer (a numeric string is accepted); anything
// else would write a '(job ...)' tag parseBacklog can never read — e.g.
// 1e21 stringifies as '1e+21' — so it is refused with false and the file is
// left untouched.
export function markTaken(dir, id, jobId) {
  const n = typeof jobId === "string" && jobId.trim() !== "" ? Number(jobId) : jobId;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return false;
  return editItem(dir, id, (lines, item) => {
    const eol = lines[item.line].endsWith("\r") ? "\r" : "";
    const line = eol ? lines[item.line].slice(0, -1) : lines[item.line];
    lines[item.line] = `${line.replace(/ \(job \d+\)$/, "")} (job ${n})${eol}`;
  });
}

export function markDone(dir, id) {
  return editItem(dir, id, (lines, item) => {
    lines[item.line] = lines[item.line].replace(/^- \[ \]/, "- [x]");
  });
}

export function removeItem(dir, id) {
  return editItem(dir, id, (lines, item) => {
    lines.splice(item.line, 1);
  });
}

// Items Constance may still hand out: not done and not already taken.
export function openItems(dir) {
  return readBacklog(dir).filter((x) => !x.done && x.job === null);
}

export function formatItem(item) {
  let s = `${item.kind}: ${item.text}`;
  if (item.files?.length) s += ` (files: ${item.files.join(", ")})`;
  return s;
}
