// Deeper edge-case tests for constance-summary.mjs: input that is missing,
// null or the wrong type; boundary sizes (10 goals, 30 log lines, the
// 80-line cap's shrink order); field-level quirks in reasons, item counts,
// token formatting and clipping; and purity (same input -> same report, a
// deep-frozen input changes nothing). The module is synchronous and pure —
// no files, no clock reads beyond the `now` argument — so the "timing"
// surface is just `now`/`fmtTime` handling. Anything found that looks like a
// real bug is a commented-out test with a note — the module is not changed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "constance-summary-deep-home-"));
process.env.HOME = home;
process.env.XDG_STATE_HOME = path.join(home, "state");
process.env.XDG_CONFIG_HOME = path.join(home, "config");
process.env.XDG_CACHE_HOME = path.join(home, "cache");
for (const d of [process.env.XDG_STATE_HOME, process.env.XDG_CONFIG_HOME, process.env.XDG_CACHE_HOME]) {
  fs.mkdirSync(d, { recursive: true });
}

const { buildSummary, SUMMARY_MAX_LINES } = await import("./constance-summary.mjs");

const NOW = Date.parse("2026-11-25T15:04:00");
const fmtTime = (ms) => `T${ms}`;
const sum = (input) => buildSummary({ now: NOW, fmtTime, ...input });
const ls = (s) => s.split("\n");
const section = (lines, name, next) => {
  const i = lines.findIndex((l) => l.startsWith(name));
  assert.notEqual(i, -1, `missing section "${name}"`);
  const j = next ? lines.findIndex((l, k) => k > i && l.startsWith(next)) : -1;
  return lines.slice(i + 1, j === -1 ? lines.length : j);
};

// ---------- missing / wrong-typed top-level input ----------

// No argument, explicit null and primitive inputs all degrade to defaults.
for (const input of [undefined, null, "junk", 42, []]) {
  const out = buildSummary(input);
  assert.match(out.split("\n")[0], /^Constance summary \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
}
// null input specifically still yields the full skeleton.
assert.deepEqual(ls(buildSummary(null)).slice(-4), [
  "Failed jobs:", "- none", "Leverage: not measured", "Last 30 log lines:",
]);

// Explicit null for any array field crashes: the `= []` defaults only cover
// undefined, and `null.length`/`null.filter`/`null.slice` all throw.
// BUG: buildSummary advertises "safe defaults" but { history: null } (and
// items/queue/jobs/log: null) throws a TypeError instead of reading as [].
// assert.doesNotThrow(() => sum({ history: null }));
// assert.doesNotThrow(() => sum({ items: null }));
// assert.doesNotThrow(() => sum({ queue: null }));
// assert.doesNotThrow(() => sum({ jobs: null }));
// assert.doesNotThrow(() => sum({ log: null }));

// A null *element* inside any array crashes the same way (entry.text,
// it.n, j.status, e.kind, entry.text).
// BUG: same class — one bad record kills the whole report. Probably should
// skip null/undefined entries like a missing field is skipped.
// assert.doesNotThrow(() => sum({ history: [null] }));
// assert.doesNotThrow(() => sum({ items: [null] }));
// assert.doesNotThrow(() => sum({ queue: [null] }));
// assert.doesNotThrow(() => sum({ jobs: [null] }));
// assert.doesNotThrow(() => sum({ log: [null] }));

// Non-array wrong types are handled inconsistently: numbers are silently
// ignored for history/items but throw for queue/jobs/log; plain objects
// throw everywhere a slice/filter/forEach is needed; strings iterate their
// characters as phantom entries.
assert.equal(section(ls(sum({ history: 5 })), "Goals:", "Failed jobs:").length, 0,
  "history: 5 is silently treated as no goals");
assert.equal(ls(sum({ items: 5 })).includes("Checklist:"), false,
  "items: 5 is silently treated as no checklist");
assert.throws(() => sum({ queue: 5 }), TypeError);
assert.throws(() => sum({ jobs: 5 }), TypeError);
assert.throws(() => sum({ log: 5 }), TypeError);
assert.throws(() => sum({ history: { length: 2 } }), TypeError);
assert.throws(() => sum({ items: { length: 2 } }), TypeError);
assert.throws(() => sum({ jobs: "ab" }), TypeError, "strings have no .filter");
assert.throws(() => sum({ log: {} }), TypeError);
// Strings do NOT throw for history/queue/log: each character becomes an entry.
assert.deepEqual(
  section(ls(sum({ history: "ab" })), "Goals:", "Failed jobs:"),
  ["- [unknown] ", "- [unknown] "],
);
assert.deepEqual(
  section(ls(sum({ queue: "ab" })), "Goals:", "Failed jobs:").filter((l) => l.includes("[queued]")),
  ["- [queued] ", "- [queued] "],
);

// ---------- `now` and `fmtTime` ----------

// A Date instance is equivalent to the same instant in ms.
assert.equal(
  buildSummary({ now: new Date(NOW), fmtTime }),
  buildSummary({ now: NOW, fmtTime }),
);
// A numeric string is honoured as epoch ms (2000-01-01 UTC is 1999-12-31 or
// 2000-01-01 local depending on the zone — both prove it was not Date.now()).
const strNow = buildSummary({ now: "946684800000", fmtTime }).split("\n")[0];
assert.match(strNow, /Constance summary (1999-12-31|2000-01-01) /);
// now: 0 is falsy, so it falls back to the wall clock rather than the epoch.
assert.notEqual(buildSummary({ now: 0, fmtTime }).split("\n")[0].slice(18, 22), "1970");
// BUG: an invalid Date bypasses the `Number(now) || Date.now()` fallback
// (instanceof Date wins) and prints "NaN-NaN-NaN NaN:NaN" in the header.
// const bad = buildSummary({ now: new Date(NaN), fmtTime }).split("\n")[0];
// assert.match(bad, /^Constance summary \d{4}-\d{2}-\d{2}/);

// fmtTime receives each entry's `at` verbatim (no coercion) and is called
// once per *shown* log line — at most 30, never for an empty log.
{
  const seen = [];
  sum({
    log: [{ at: "raw", kind: "k", text: "x" }, { at: null, kind: "k", text: "y" }],
    fmtTime: (ms) => { seen.push(ms); return `F${ms}`; },
  });
  assert.deepEqual(seen, ["raw", null]);
}
{
  let calls = 0;
  const ft = (ms) => { calls++; return `T${ms}`; };
  sum({ log: Array.from({ length: 40 }, (_, i) => ({ at: i })), fmtTime: ft });
  assert.equal(calls, 30);
  calls = 0;
  sum({ log: [], fmtTime: ft });
  assert.equal(calls, 0);
}
// A non-function fmtTime throws only when the log actually has entries.
assert.doesNotThrow(() => sum({ log: [], fmtTime: "nope" }));
assert.throws(() => sum({ log: [{ at: 1 }], fmtTime: "nope" }), TypeError);
// fmtTime output is flattened like everything else: an embedded newline
// becomes a space in the final pass.
assert.ok(
  ls(sum({ log: [{ at: 1, kind: "k", text: "x" }], fmtTime: () => "A\nB" }))
    .some((l) => l === "A B k: x"),
);
// With no fmtTime the default is local HH:MM — always two digits, TZ-free.
assert.ok(
  ls(buildSummary({ now: NOW, log: [{ at: NOW, kind: "k", text: "x" }] }))
    .some((l) => /^\d{2}:\d{2} k: x$/.test(l)),
  "default fmtTime renders HH:MM",
);

// ---------- goals / checklist field edges ----------

// Missing status: history entries fall back to "unknown", the current goal
// to "running"; an empty current object still prints a (blank) goal line.
{
  const out = ls(sum({
    history: [{ id: "h1", text: "old" }],
    current: {},
  }));
  assert.ok(out.includes("- [unknown] old"), "history entry without status");
  assert.ok(out.includes("- [running] "), "empty current object still shows");
}
// History marker boundary: exactly 10 shown with no marker, 11 -> "… 1 earlier".
{
  const h10 = Array.from({ length: 10 }, (_, i) => ({ id: i, text: `h${i}` }));
  const h11 = [...h10, { id: 10, text: "h10" }];
  assert.equal(ls(sum({ history: h10 })).some((l) => l.includes("earlier goals")), false);
  assert.ok(ls(sum({ history: h11 })).includes("- … 1 earlier goals"));
}
// needsOwner: a bare true (or any truthy non-string) means "needs owner";
// a failReason that is only whitespace falls through to needsOwner.
{
  const mk = (entry) => ls(sum({ current: entry })).find((l) => l.includes("[running]"));
  assert.equal(mk({ text: "a", needsOwner: true }), "- [running] a — needs owner");
  assert.equal(mk({ text: "b", failReason: "  \n ", needsOwner: "pick one" }),
    "- [running] b — pick one", "blank failReason falls through to needsOwner");
  assert.equal(mk({ text: "c", failReason: "real reason", needsOwner: "ignored" }),
    "- [running] c — real reason", "failReason beats needsOwner");
  // QUIRK: a whitespace-only needsOwner string is truthy, so it prints the
  // generic "needs owner" rather than its (blank) contents.
  assert.equal(mk({ text: "d", needsOwner: "   " }), "- [running] d — needs owner");
  // The reason is clipped to 100 chars including the ellipsis.
  const long = mk({ text: "e", failReason: "r".repeat(300) });
  const reason = long.slice(long.indexOf(" — ") + 3);
  assert.equal(reason.length, 100);
  assert.ok(reason.endsWith("…"));
}
// itemsTotal edges: 0 still prints "(0/0 items)", itemsDone alone prints
// nothing, and a non-number itemsTotal is interpolated raw.
{
  const mk = (entry) => ls(sum({ current: entry })).find((l) => l.includes("[running]"));
  assert.equal(mk({ text: "a", itemsTotal: 0 }), "- [running] a (0/0 items)");
  assert.equal(mk({ text: "b", itemsDone: 3 }), "- [running] b");
  assert.equal(mk({ text: "c", itemsTotal: 5 }), "- [running] c (0/5 items)");
  assert.equal(mk({ text: "d", itemsTotal: "5" }), "- [running] d (0/5 items)");
}
// A lone \r (no \n) survives firstLine but is flattened by the final pass.
assert.ok(
  ls(sum({ current: { text: "a\rb" } })).includes("- [running] a b"),
);
// Clipping: goal text is capped at 80 chars, failed-job label at 50 and its
// error at 100, checklist text at 90, log text at 140 — all with "…".
{
  const goal = ls(sum({ current: { text: "x".repeat(200) } }))
    .find((l) => l.includes("[running]"));
  assert.equal(goal.length, "- [running] ".length + 80);
  assert.ok(goal.endsWith("…"));
  const failed = ls(sum({
    jobs: [{ id: 1, agent: "a", status: "failed", title: "t".repeat(200), summary: "e".repeat(300) }],
  })).find((l) => l.startsWith("- #"));
  assert.ok(failed.includes("…"));
  assert.ok(!failed.includes("t".repeat(51)), "label clipped at 50");
  assert.ok(!failed.includes("e".repeat(101)), "error clipped at 100");
  const item = ls(sum({ items: [{ text: "i".repeat(200), state: "todo" }] }))
    .find((l) => l.startsWith("  ["));
  assert.equal(item.length, "  [ ] 1. ".length + 90);
  const logLine = ls(sum({ log: [{ at: 1, kind: "k", text: "x".repeat(300) }] })).pop();
  assert.equal(logLine.length, "T1 k: ".length + 140);
}
// BUG (minor): job.id and job.agent are flattened but never clipped, so one
// oversized agent name makes the failed-job line arbitrarily long — every
// other free-text field in the report is capped.
// const big = sum({ jobs: [{ id: 1, agent: "a".repeat(500), status: "failed", title: "t" }] })
//   .split("\n").find((l) => l.startsWith("- #"));
// assert.ok(big.length < 200, "agent should be clipped like the other fields");

// Checklist numbering/state edges.
{
  const items = ls(sum({
    items: [
      { n: 0, text: "zero", state: "done" },
      { text: "noN", state: "DONE" },
      { n: "7", text: "strN", state: "done" },
    ],
  })).filter((l) => l.startsWith("  ["));
  assert.deepEqual(items, [
    "  [x] 0. zero",
    "  [ ] 2. noN", // n falls back to the 1-based position; "DONE" is not "done"
    "  [x] 7. strN",
  ]);
}

// ---------- failed jobs ----------

// Status matching is exact: case variants and padding do not count as failed.
assert.deepEqual(
  section(ls(sum({
    jobs: [
      { id: 1, status: "Failed", title: "t" },
      { id: 2, status: "failed ", title: "t" },
      { id: 3, status: "FAILED", title: "t" },
    ],
  })), "Failed jobs:", "Leverage:"),
  ["- none"],
);
// Label fallback: a whitespace-only title falls through to task; with neither
// the job is "(untitled)". Missing id/agent degrade to ""/"unknown".
{
  const lines = ls(sum({
    jobs: [
      { id: 1, agent: "a", status: "failed", title: "   \n ", task: "the task" },
      { id: 2, agent: "a", status: "failed" },
      { status: "failed", title: "t" },
    ],
  }));
  const failed = section(lines, "Failed jobs:", "Leverage:");
  assert.ok(failed.some((l) => l.includes(": the task — failed")));
  assert.ok(failed.some((l) => l.includes(": (untitled) — failed")));
  assert.ok(failed.some((l) => l.startsWith("- # unknown:")));
}
// String ids containing digits sort numerically inside localeCompare:
// "j10" is newer than "j2".
{
  const order = section(ls(sum({
    jobs: [
      { id: "j2", agent: "a", status: "failed", title: "two" },
      { id: "j10", agent: "a", status: "failed", title: "ten" },
    ],
  })), "Failed jobs:", "Leverage:")
    .filter((l) => l.startsWith("- #"))
    .map((l) => l.match(/#(\S+)/)[1]);
  assert.deepEqual(order, ["j10", "j2"]);
}
// BUG: firstNonEmpty coerces with String(), so a boolean reviewNote:false
// becomes the literal error "false" and hides the real summary. A JSON false
// should fall through like null does.
// const line = sum({ jobs: [{ id: 1, status: "failed", title: "t", reviewNote: false, summary: "real" }] })
//   .split("\n").find((l) => l.startsWith("- #"));
// assert.ok(line.endsWith("— real"), `expected summary fallback, got: ${line}`);

// ---------- leverage ----------

{
  const lev = (input) => ls(sum({ leverage: input })).find((l) => l.startsWith("Leverage:"));
  assert.equal(lev({}), "Leverage: unknown");
  assert.equal(lev("x"), "Leverage: unknown");
  assert.equal(lev({ label: "L", tokens: 0, spentPct: 0 }), "Leverage: L (0 tokens, 0% of the session)");
  assert.equal(lev({ label: "L", tokens: "500" }), "Leverage: L", "non-number tokens are skipped");
  assert.equal(lev({ label: "L", tokens: -5000 }), "Leverage: L (-5K tokens)");
  assert.equal(lev({ label: "L", tokens: 1e12 }), "Leverage: L (1000B tokens)",
    "no T unit — billions are the largest suffix");
  // fmtTokens rounds each unit independently, so values just under the next
  // unit print "1000X" instead of rolling over.
  // BUG: 999999 tokens renders "1000K tokens" (and 999999999 "1000M") rather
  // than "1M" — the toFixed(1) round-up never re-checks the unit.
  // assert.equal(lev({ label: "L", tokens: 999999 }), "Leverage: L (1M tokens)");
  // Non-finite spentPct is a number, so it renders literally.
  assert.equal(lev({ label: "L", spentPct: NaN }), "Leverage: L (NaN% of the session)");
  // A newline in the label is flattened like every other field.
  assert.equal(lev({ label: "a\nb" }), "Leverage: a b");
}

// ---------- log section ----------

// Exactly 30 entries all show; 31 drops only the oldest.
{
  const log30 = Array.from({ length: 30 }, (_, i) => ({ at: i, kind: "k", text: `x${i}` }));
  const l30 = ls(sum({ log: log30 })).filter((l) => l.startsWith("T"));
  assert.equal(l30.length, 30);
  assert.ok(l30.some((l) => l.includes("x0")));
  const log31 = [...log30, { at: 30, kind: "k", text: "x30" }];
  const l31 = ls(sum({ log: log31 }));
  assert.equal(l31.filter((l) => l.startsWith("T")).length, 30);
  assert.ok(!l31.some((l) => l.endsWith("x0")), "the oldest entry is dropped");
  assert.ok(l31.some((l) => l.includes("x30")));
}
// An empty log still prints its header — and it is the report's last line.
{
  const out = ls(sum({ log: [] }));
  assert.equal(out[out.length - 1], "Last 30 log lines:");
}
// Missing/blank kind falls back to "log"; blank text leaves a trailing ": ".
{
  const out = ls(sum({ log: [{ at: 5 }] }));
  assert.ok(out.includes("T5 log: "), "kind and text both default");
}

// ---------- purity: determinism, frozen input, no mutation ----------

{
  const input = {
    now: NOW, fmtTime,
    history: [{ id: "h", text: "hist", status: "done", itemsDone: 1, itemsTotal: 2 }],
    current: { id: "c", text: "cur" },
    items: [{ n: 1, text: "i", state: "done" }],
    queue: [{ id: "q", text: "queued" }],
    jobs: [{ id: 3, agent: "a", status: "failed", title: "t", summary: "s" }],
    leverage: { label: "L", tokens: 10, spentPct: 1 },
    log: [{ at: 1, kind: "k", text: "x" }],
  };
  const a = buildSummary(input);
  const b = buildSummary(input);
  assert.equal(a, b, "same input -> identical report");
  const deepFreeze = (o) => {
    if (o && typeof o === "object") {
      for (const v of Object.values(o)) deepFreeze(v);
      Object.freeze(o);
    }
    return o;
  };
  assert.equal(buildSummary(deepFreeze(input)), a,
    "a deep-frozen input builds the same report — nothing is mutated");
}

// ---------- the 80-line cap: what shrinks first ----------

// Overflow is absorbed by Checklist first, then queued goals, then shown
// history — in that order — while Failed jobs and the log tail are fixed.
{
  const history = Array.from({ length: 12 }, (_, i) => ({ id: `h${i}`, text: `hist ${i}`, status: "done" }));
  const items = Array.from({ length: 20 }, (_, i) => ({ n: i + 1, text: `item ${i}`, state: "todo" }));
  const queue = Array.from({ length: 300 }, (_, i) => ({ id: `q${i}`, text: `queued ${i}` }));
  const jobs = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, agent: "x", status: "failed", title: `j${i}` }));
  const log = Array.from({ length: 200 }, (_, i) => ({ at: i, kind: "k", text: `l${i}` }));
  const out = ls(sum({
    history, current: { id: "c", text: "cur" }, items, queue, jobs, log,
    leverage: { label: "L", tokens: 1 },
  }));
  assert.ok(out.length <= SUMMARY_MAX_LINES, `report is ${out.length} lines`);
  assert.equal(out[0].startsWith("Constance summary "), true, "header survives");
  // Checklist was sacrificed completely: header + honest "… 20 more" only.
  const ci = out.indexOf("Checklist:");
  assert.deepEqual(out.slice(ci, ci + 2), ["Checklist:", "  … 20 more"]);
  assert.equal(out.filter((l) => l.startsWith("  [")).length, 0, "no checklist items left");
  // Queued goals absorbed the rest: every shown line plus the "… N more"
  // marker accounts for all 300.
  const goals = section(out, "Goals:", "Checklist:");
  const queued = goals.filter((l) => l.startsWith("- [queued]"));
  const more = goals.find((l) => /^- … \d+ more$/.test(l));
  assert.ok(more, "queued overflow keeps its marker");
  assert.equal(queued.length + Number(more.match(/\d+/)[0]), 300);
  // History is last to shrink: all 10 allowed entries plus the earlier marker.
  assert.equal(goals.filter((l) => l.startsWith("- [done]")).length, 10);
  assert.ok(goals.includes("- … 2 earlier goals"));
  assert.ok(goals.includes("- [running] cur"), "current goal is never dropped");
  // Fixed sections are untouched by the cap.
  assert.equal(section(out, "Failed jobs:", "Leverage:").filter((l) => l.startsWith("- #")).length, 8);
  assert.ok(out.includes("  … 4 more"), "failed-jobs overflow marker intact");
  assert.ok(out.some((l) => l.includes("l199")), "last log line survives");
}

// A *small* overflow shrinks only the checklist — queued goals and history
// stay whole, proving the order checklist -> queue -> history.
{
  const history = Array.from({ length: 10 }, (_, i) => ({ id: `h${i}`, text: `hist ${i}`, status: "done" }));
  const items = Array.from({ length: 20 }, (_, i) => ({ n: i + 1, text: `item ${i}`, state: "todo" }));
  const queue = Array.from({ length: 9 }, (_, i) => ({ id: `q${i}`, text: `queued ${i}` }));
  const jobs = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, agent: "x", status: "failed", title: `j${i}` }));
  const log = Array.from({ length: 200 }, (_, i) => ({ at: i, kind: "k", text: `l${i}` }));
  const out = ls(sum({
    history, current: { id: "c", text: "cur" }, items, queue, jobs, log,
    leverage: { label: "L", tokens: 1 },
  }));
  assert.ok(out.length <= SUMMARY_MAX_LINES);
  const goals = section(out, "Goals:", "Checklist:");
  assert.equal(goals.filter((l) => l.startsWith("- [queued]")).length, 9,
    "small overflow never touches the queue");
  assert.ok(!goals.some((l) => /^- … \d+ more$/.test(l)), "no queue marker");
  assert.equal(goals.filter((l) => l.startsWith("- [done]")).length, 10,
    "history untouched");
  const checkItems = out.filter((l) => l.startsWith("  ["));
  assert.ok(checkItems.length > 0 && checkItems.length < 15,
    `checklist partially shrunk, got ${checkItems.length}`);
  const hidden = Number(out.find((l) => l.startsWith("  … ") && l.endsWith(" more"))
    .match(/\d+/)[0]);
  assert.equal(checkItems.length + hidden, 20, "checklist marker stays honest");
}

// When the checklist is absent (no items) the queue absorbs overflow first.
{
  const queue = Array.from({ length: 120 }, (_, i) => ({ id: `q${i}`, text: `queued ${i}` }));
  const log = Array.from({ length: 200 }, (_, i) => ({ at: i, kind: "k", text: `l${i}` }));
  const out = ls(sum({ queue, log }));
  assert.ok(out.length <= SUMMARY_MAX_LINES);
  assert.equal(out.includes("Checklist:"), false);
  const goals = section(out, "Goals:", "Failed jobs:");
  const queued = goals.filter((l) => l.startsWith("- [queued]"));
  const more = goals.find((l) => /^- … \d+ more$/.test(l));
  assert.ok(more && queued.length + Number(more.match(/\d+/)[0]) === 120);
}

fs.rmSync(home, { recursive: true, force: true });
console.log("constance-summary.deep: tests passed");
