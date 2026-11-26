// Constance's lanes: read-only, sandboxed "lead" jobs that each work one real
// backlog item (the same .constance/backlog.md constance-backlog.mjs owns —
// there is no second backlog) and hand back a report of 'FIX: files :: what'
// lines. The controller turns those lines into small fix tasks for a free
// worker (fixJobs), so the lead only ever reads and thinks while the cheap
// agents do the editing. A lane never pads the backlog: pickLanes returns
// fewer — or nothing — when fewer real lane items are open.
import path from "node:path";

// The lane kinds, in the order classifyLane tries them (first match wins).
// Each maps onto the backlog's own kinds plus keywords in the item text:
// a 'merge' word on a review is a deep merge review, audit/sandbox/security
// on a review is a security audit, 'architecture' on a review or design is an
// architecture review, and a bug whose text marks it hard (flaky, race,
// deadlock, heisenbug, ...) is a hard bug. Keyword match is a word-boundary
// prefix on the lowercased text, so 'merges', 'sandboxed' and 'auditing' all
// count while 'emergency' does not match 'merge'.
export const LANE_KINDS = [
  { id: "merge-review", kinds: ["review"], keywords: ["merge"] },
  { id: "audit", kinds: ["review"], keywords: ["audit", "sandbox", "security"] },
  { id: "architecture", kinds: ["review", "design"], keywords: ["architecture"] },
  { id: "hard-bug", kinds: ["bug"], keywords: ["hard", "flaky", "intermittent", "race", "deadlock", "heisenbug", "heisen", "tangled", "subtle", "nasty", "gremlin", "spooky"] },
];

const kwRe = (kw) => new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
const LANE_RES = LANE_KINDS.map((k) => ({ ...k, res: k.keywords.map(kwRe) }));

// Which lane a backlog item belongs to, or null when it is ordinary backlog
// work. item is a parsed backlog item ({ kind, text, ... }); anything without
// a string text classifies as null.
export function classifyLane(item) {
  const kind = item?.kind;
  const text = typeof item?.text === "string" ? item.text : "";
  if (!text.trim()) return null;
  for (const lane of LANE_RES) {
    if (!lane.kinds.includes(kind)) continue;
    if (lane.res.some((re) => re.test(text))) return lane.id;
  }
  return null;
}

// Up to n open, untaken backlog items that classify as lanes, oldest first.
// "Open" and "untaken" follow constance-spare.mjs's convention: any truthy
// `done` is done, and only a missing job tag (null or absent) is untaken — a
// job of 0 counts as taken. Oldest means file order (line, then id, then the
// array position for items that carry neither). Items that are not lanes are
// never padding: fewer qualifying items means a shorter — or empty — result.
export function pickLanes(items, n) {
  const want = Math.max(0, Math.floor(Number(n) || 0));
  if (want === 0) return [];
  return (Array.isArray(items) ? items : [])
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => item && !item.done && item.job == null && classifyLane(item) !== null)
    .sort((a, b) => (a.item.line ?? a.item.id ?? a.i) - (b.item.line ?? b.item.id ?? b.i) || a.i - b.i)
    .slice(0, want)
    .map(({ item }) => item);
}

// The task handed to the lane's lead agent: read-only, no files, and a text
// that says to change nothing and to write findings to reportPath as
// 'FIX: path/a,path/b :: what to change' lines — the only output fixJobs reads.
export function laneTask(item, { reportPath } = {}) {
  const lane = classifyLane(item) || "lane";
  const text = [
    `Lane ${lane}: ${item?.kind || "task"}: ${String(item?.text ?? "").trim()}`,
    `This is a read-only lead job: change nothing — no edits, no new files, no commits. Investigate the backlog item above and report what should change.`,
    `Write your findings to ${reportPath} as plain lines, one per suggested fix:`,
    `FIX: path/a,path/b :: what to change`,
    `Name only real files each fix touches, and only fixes you are confident about. If nothing needs fixing, write "NO FIXES" and say why.`,
  ].join("\n");
  return { readOnly: true, files: [], text };
}

// Where the controller saves a lane job's report: one file per job under a
// 'lanes' folder in Constance's state dir, next to (never inside) the goal
// reports' report-<id>.txt namespace.
export function reportFile(stateDir, jobId) {
  return path.join(stateDir, "lanes", `report-${String(jobId).replace(/[^A-Za-z0-9_-]/g, "_")}.txt`);
}

const FIX_RE = /^FIX:\s*(.+?)\s*::\s*(\S[\s\S]*)$/;

// Parse a lane report's FIX lines into fix tasks for a free worker. Lines
// that are not 'FIX: files :: description' are ignored. Fixes that share a
// file are merged into one task so no file ever appears in two tasks
// (union-find over the file lists); a merged task with more than maxFiles
// files is kept whole — never split — and flagged big:true.
export function fixJobs(reportText, { maxFiles = 3 } = {}) {
  const fixes = [];
  const seen = new Set();
  for (const line of String(reportText ?? "").split("\n")) {
    const m = line.trim().match(FIX_RE);
    if (!m) continue;
    const files = [...new Set(m[1].split(",").map((f) => f.trim().replace(/^\.\//, "")).filter(Boolean))];
    const text = m[2].trim();
    if (!files.length || !text) continue;
    const key = files.join(",") + "" + text;
    if (seen.has(key)) continue;
    seen.add(key);
    fixes.push({ files, text });
  }
  // Union-find over fixes: two fixes land in the same task when any file
  // (transitively) overlaps.
  const parent = fixes.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const firstByFile = new Map();
  fixes.forEach((f, i) => {
    for (const file of f.files) {
      const j = firstByFile.get(file);
      if (j === undefined) firstByFile.set(file, i);
      else { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
    }
  });
  const groups = new Map();
  fixes.forEach((f, i) => {
    const root = find(i);
    let g = groups.get(root);
    if (!g) { g = { files: [], texts: [] }; groups.set(root, g); }
    for (const file of f.files) if (!g.files.includes(file)) g.files.push(file);
    g.texts.push(f.text);
  });
  return [...groups.values()].map((g) => ({
    files: g.files,
    text: g.texts.join("; "),
    big: g.files.length > maxFiles,
  }));
}
