// Constance's autosplit: turns a goal into ready-to-delegate jobs — one per checklist
// item (bin/constance-checklist.mjs's parser), each naming the files it may touch — and,
// when the goal yields fewer than `min` jobs, pads with "deeper test" jobs for constance
// modules that have none.
//
// A job's files come only from what its item names: a NEW `bin/constance-X.mjs` gets the
// module and its `X.test.mjs` pair, an existing one just itself. No two jobs ever share
// a file — a later job naming an already-claimed file drops it and says so in `notes`.
// The list is capped by the agent's scorecard sizeHint (bin/constance-scorecard.mjs):
// the `agent` option's row, else the first (busiest) row, else 2 files with no record.
//
// Pure: the repo file list, scorecard rows and min are all passed in, so tests need no
// filesystem, network or real agents.
import { parseItems } from "./constance-checklist.mjs";
import { sizeHint } from "./constance-scorecard.mjs";

const MODULE = /\b(?:bin\/)?(constance-[\w-]+)\.mjs\b/g;
const clip = (t, n) => (t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t);
const titleOf = (text) => clip(String(text).split(/\r?\n/)[0].trim(), 60);
const deepTest = (mod) => mod.replace(/\.mjs$/, ".deep.test.mjs");

// The constance modules an item names, in order, deduped: "constance-foo" from either
// "bin/constance-foo.mjs" or a bare "constance-foo.mjs" (test-file mentions don't match).
function namedModules(text) {
  const names = [];
  for (const m of String(text).matchAll(MODULE)) if (!names.includes(m[1])) names.push(m[1]);
  return names;
}

// Files a job may touch for the modules it names: a new module brings its test along.
function filesFor(names, have) {
  const out = [];
  for (const n of names) {
    const mod = `bin/${n}.mjs`;
    out.push(mod);
    if (!have.has(mod)) out.push(`bin/${n}.test.mjs`);
  }
  return out;
}

// Claim `raw` files for the job about to be pushed: already-claimed files drop with a
// note, the rest are capped at maxFiles (drops noted too), and survivors are claimed.
function take(raw, { claimed, maxFiles, capNote, jobNo }) {
  const notes = [], keep = [];
  for (const f of raw) {
    if (claimed.has(f)) { notes.push(`${f} stays with job ${claimed.get(f)}`); continue; }
    if (!keep.includes(f)) keep.push(f);
  }
  if (keep.length > maxFiles) {
    const cut = keep.splice(maxFiles);
    notes.push(`capped at ${maxFiles} file${maxFiles === 1 ? "" : "s"} (${capNote}): dropped ${cut.join(", ")}`);
  }
  for (const f of keep) claimed.set(f, jobNo);
  return { files: keep, notes };
}

// [{ title, task, files, item, notes? }] — `item` is the 1-based checklist number, null
// for the added deeper-test jobs. `overlaps(jobs)` must be empty on the result.
export function autosplit(goalText, { files = [], scorecard = [], agent = null, min = 15 } = {}) {
  const have = new Set(files.map((f) => String(f).replace(/^\.\//, "")));
  const row = agent ? (scorecard || []).find((r) => r && r.agent === agent) || null : (scorecard || [])[0] || null;
  const { maxFiles } = sizeHint(row);
  const capNote = row ? `scorecard: ${row.name ?? row.agent}` : "no scorecard record";
  const claimed = new Map();
  const jobs = [];
  const build = (title, task, item, raw) => {
    const { files: fs, notes } = take(raw, { claimed, maxFiles, capNote, jobNo: jobs.length + 1 });
    jobs.push({ title, task, files: fs, item, ...(notes.length ? { notes } : {}) });
  };

  parseItems(goalText).forEach((text, i) => {
    build(titleOf(text), text, i + 1, filesFor(namedModules(text), have));
  });

  // Pad with deeper-test jobs until `min`: one per constance module lacking a
  // *.deep.test.mjs, in repo order, stopping when min is reached or candidates run out.
  if (jobs.length < min) {
    const seen = new Set();
    for (const f of have) {
      if (jobs.length >= min) break;
      if (!/^bin\/constance-.+\.mjs$/.test(f) || f.endsWith(".test.mjs")) continue;
      const deep = deepTest(f);
      if (have.has(deep) || seen.has(f)) continue;
      seen.add(f);
      build(`Deeper test: ${f}`, `Added to reach the minimum of ${min} jobs: write ${deep}, a deeper test for ${f} beyond its existing tests. Only touch the listed files.`, null, [f, deep]);
    }
  }
  return jobs;
}

// The files claimed by more than one job, sorted. Empty for autosplit's own output.
export function overlaps(jobs) {
  const count = new Map();
  for (const j of jobs || []) for (const f of new Set(j.files || [])) count.set(f, (count.get(f) || 0) + 1);
  return [...count.entries()].filter(([, n]) => n > 1).map(([f]) => f).sort();
}
