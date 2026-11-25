// Constance's repo brief: a short, cached summary of a project — its top-level
// layout, how to test it, the rules that matter and the files it must never
// touch — so a worker's prompt can carry just enough context without reading
// the whole repo. The brief is rebuilt only when the tree moved a lot (more
// than 20 committed files since the cached HEAD, or files touched since a
// plain folder's cached build) or the cache is a week old; small churn keeps
// the old brief.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const LIMIT = 1500;
const MAX_CHANGED = 20;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const SKIP_DIRS = new Set([".git", "node_modules"]);

const gitRaw = (dir, exec, ...args) =>
  exec ? exec("git", ["-C", dir, ...args]) : spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });

const git = (dir, exec, ...args) => {
  const r = gitRaw(dir, exec, ...args);
  return r && r.status === 0 ? String(r.stdout || "") : "";
};

// Files tracked by git, or a plain walk when the folder isn't a repo.
function fileCount(dir, exec) {
  const listed = git(dir, exec, "ls-files");
  if (listed) return listed.split("\n").filter(Boolean).length;
  let n = 0;
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else n++;
    }
  };
  walk(dir);
  return n;
}

// Top-level entries as "name/ (N files)" for dirs, bare names for files.
// Hidden entries are skipped: .git and dotfile churn are noise in a brief.
function layout(dir) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const rows = [];
  for (const e of ents) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      let n = 0;
      const walk = (d) => {
        let kids = [];
        try { kids = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const k of kids) {
          if (k.name.startsWith(".") || SKIP_DIRS.has(k.name)) continue;
          const p = path.join(d, k.name);
          if (k.isDirectory()) walk(p); else n++;
        }
      };
      walk(path.join(dir, e.name));
      rows.push(`${e.name}/ (${n} file${n === 1 ? "" : "s"})`);
    } else if (e.isFile()) rows.push(e.name);
  }
  rows.sort((a, b) => a.localeCompare(b));
  return rows;
}

// The project's own test loop wins; then package.json's test script.
function testCommand(dir) {
  try {
    if (fs.readdirSync(path.join(dir, "bin")).some((f) => f.endsWith(".test.mjs"))) {
      return 'for t in bin/*.test.mjs; do HOME=$(mktemp -d) node "$t" || echo FAIL $t; done';
    }
  } catch { /* no bin/ */ }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    if (pkg.scripts && pkg.scripts.test) return String(pkg.scripts.test);
  } catch { /* no package.json */ }
  return "none found";
}

// Lines under a markdown heading ("## Working rules"), stopping at the next
// heading of the same or higher level.
function section(lines, headingRe) {
  const start = lines.findIndex((l) => /^\s*#{1,6}\s/.test(l) && headingRe.test(l));
  if (start < 0) return [];
  const level = lines[start].match(/^\s*(#{1,6})/)[1].length;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i].match(/^\s*(#{1,6})\s/);
    if (h && h[1].length <= level) break;
    out.push(lines[i]);
  }
  return out;
}

const readLines = (file) => {
  try { return fs.readFileSync(file, "utf8").split(/\r?\n/); } catch { return []; }
};

// The first 20 lines of .constance/rules.md, when present.
function rulesMdLines(dir) {
  return readLines(path.join(dir, ".constance", "rules.md"))
    .slice(0, 20).map((l) => l.trim()).filter(Boolean);
}

// The bullet lines of CLAUDE.md's "Working rules" section (first line of each
// bullet; wrapped continuations are dropped to keep the brief short).
function claudeBullets(dir) {
  return section(readLines(path.join(dir, "CLAUDE.md")), /working rules/i)
    .map((l) => l.trim())
    .filter((l) => /^[-*•]\s/.test(l))
    .map((l) => l.replace(/^[-*•]\s+/, "").replace(/\s+/g, " "))
    .map((l) => {
      if (l.length <= 160) return l;
      const cut = l.slice(0, 160);
      return cut.slice(0, Math.max(cut.lastIndexOf(" "), 80));
    });
}

// Every rule line a worker must see, both sources.
export function rulesLines(dir) {
  return [...rulesMdLines(dir), ...claudeBullets(dir).slice(0, 8)];
}

// Paths the rules say to never touch: .git/ and settings/credentials files
// always, plus path-looking tokens from any rule line containing "never".
export function neverTouch(dir) {
  const found = new Set([".git/", "settings/credentials files"]);
  for (const line of rulesLines(dir)) {
    if (!/never/i.test(line)) continue;
    for (const tok of line.match(/[A-Za-z0-9_.@~/-]*[/.][A-Za-z0-9_.@~/-]+/g) || []) {
      const t = tok.replace(/[.,;:)\]]+$/, "");
      if (t.length > 2 && t.length < 80 && !/\s/.test(t)) found.add(t);
    }
  }
  return [...found].slice(0, 10);
}

const clip = (rows, max) => rows.length > max ? [...rows.slice(0, max), `… +${rows.length - max} more`] : rows;

// The whole brief as plain text, under 1500 characters.
export function buildBrief(dir, { exec } = {}) {
  const rows = layout(dir);
  const parts = [
    `# ${path.basename(path.resolve(dir))}`,
    `Layout: ${clip(rows, 20).join(", ") || "(empty)"}`,
    `Files: ${fileCount(dir, exec)}`,
    `Test: ${testCommand(dir)}`,
  ];
  const rules = [...rulesMdLines(dir).slice(0, 10), ...claudeBullets(dir).slice(0, 6)];
  if (rules.length) parts.push(`Rules:\n${rules.map((l) => `- ${l}`).join("\n")}`);
  parts.push(`Never touch: ${neverTouch(dir).join(", ")}`);
  let text = parts.join("\n");
  if (text.length > LIMIT) text = text.slice(0, LIMIT - 1).replace(/\n?[^\n]*$/, "") + "…";
  return text;
}

const cacheName = (dir) => crypto.createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 16) + ".json";

// Committed files changed between two HEADs; Infinity when it can't be told
// (missing repo, bad revision) so the brief is rebuilt rather than trusted.
function changedSince(dir, from, to, exec) {
  if (!from || !to) return Infinity;
  const run = (args) => {
    const r = exec ? exec("git", ["-C", dir, ...args]) : spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    return r && r.status === 0 ? String(r.stdout || "") : null;
  };
  const diff = run(["diff", "--name-only", `${from}..${to}`]);
  if (diff === null) return Infinity;
  return diff.split("\n").filter(Boolean).length;
}

// A plain folder has no HEAD to diff, so "changed" means files whose mtime is
// newer than the cached build — the same 20-file allowance as git churn.
function changedSinceMtime(dir, sinceMs) {
  if (!Number.isFinite(sinceMs)) return Infinity;
  let n = 0;
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      try { if (fs.lstatSync(p).mtimeMs > sinceMs) n++; } catch { /* vanished mid-walk */ }
    }
  };
  walk(dir);
  return n;
}

// The brief for a project, served from cacheDir/<hash>.json while it is fresh:
// rebuilt only when the cache is missing, older than 7 days, or the tree moved
// — more than 20 committed files since the cached HEAD in a repo, more than 20
// files touched since the cached build in a plain folder. A repo whose HEAD
// can't be read (dead git, unborn branch) keeps rebuilding rather than
// trusting the cache.
export function briefFor(dir, { cacheDir, now = Date.now(), exec } = {}) {
  const t = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const file = path.join(cacheDir, cacheName(dir));
  let cached = null;
  try { cached = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* missing or corrupt */ }
  const rev = gitRaw(dir, exec, "rev-parse", "HEAD");
  const head = rev && rev.status === 0 ? String(rev.stdout || "").trim() : "";
  // "not a git repository" in stderr is the only failure that earns the
  // mtime rule; anything else (a broken repo, an exec seam with no stderr)
  // stays on the rebuild-forever path.
  const plainDir = !head && Boolean(rev) && rev.status !== 0 &&
    /not a git repository/i.test(String(rev.stderr || ""));
  const age = cached && cached.builtAt ? t - Date.parse(cached.builtAt) : Infinity;
  let changed = Infinity;
  if (cached && cached.brief) {
    if (head) changed = cached.head ? changedSince(dir, cached.head, head, exec) : Infinity;
    else if (plainDir && !cached.head) changed = changedSinceMtime(dir, Date.parse(cached.builtAt));
  }
  if (cached && cached.brief && age <= MAX_AGE_MS && changed <= MAX_CHANGED) return cached.brief;
  const brief = buildBrief(dir, { exec });
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ head, files: fileCount(dir, exec), builtAt: new Date(t).toISOString(), brief }));
  } catch { /* a cache we can't write just means the next call rebuilds */ }
  return brief;
}
