// Constance's "Copy summary" report: section order and markers, the 80-line
// cap under a big board, the failed-job error fallback chain, and the
// leverage null/set rendering. fmtTime is fixed so nothing depends on the
// machine's time zone.
import assert from "node:assert/strict";
import { buildSummary, SUMMARY_MAX_LINES } from "./constance-summary.mjs";

const fmtTime = (ms) => `T${ms}`;
const NOW = Date.parse("2026-11-25T15:04:00"); // local-time header, TZ-free regex check
const lines = (s) => s.split("\n");

// --- Empty input: a short, valid report -------------------------------------
{
  const out = buildSummary({ now: NOW, fmtTime });
  const ls = lines(out);
  assert.ok(ls.length <= SUMMARY_MAX_LINES);
  assert.match(ls[0], /^Constance summary \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.ok(ls.includes("Goals:"));
  assert.ok(ls.includes("Failed jobs:"));
  assert.ok(ls.includes("- none"));
  assert.ok(ls.includes("Leverage: not measured"));
  assert.ok(ls.includes("Last 30 log lines:"));
  assert.ok(!ls.includes("Checklist:"), "no checklist section without items");
  assert.ok(ls.length < 15, `empty report is short, got ${ls.length} lines`);
}

// --- Section content ---------------------------------------------------------
{
  const history = Array.from({ length: 12 }, (_, i) => ({
    id: `g${i}`, text: `goal number ${i}\nsecond line`, status: i % 3 === 0 ? "failed" : "done",
    failReason: i === 2 ? "tests broke\nmore detail" : null,
    needsOwner: i === 3 ? "pick a color" : null,
    itemsDone: i, itemsTotal: 4,
  }));
  const out = buildSummary({
    now: NOW, fmtTime,
    current: { id: "cur", text: "the running goal", status: "running" },
    items: [
      { n: 1, text: "first thing", state: "done" },
      { n: 2, text: "second\nline", state: "todo" },
    ],
    history, queue: [{ id: "q1", text: "queued goal" }],
    jobs: [{ id: 7, agent: "grok", status: "sent back", title: "fix it", reviewNote: "lint failed\nstack" }],
    leverage: { label: "free agents", tokens: 151200000, spentPct: 42 },
    log: [{ at: 111, kind: "job", text: "hello\nworld" }],
  });
  const ls = lines(out);
  assert.ok(ls.includes("- … 2 earlier goals"), "history over 10 gets the earlier marker");
  assert.ok(ls.some((l) => l.includes("- [done] goal number 2")), "newest history shown");
  assert.ok(!ls.some((l) => l.includes("goal number 1 ")), "oldest history hidden by the 10 cap");
  assert.ok(ls.some((l) => l === "- [running] the running goal"), "current goal line");
  assert.ok(ls.some((l) => l === "- [queued] queued goal"), "queued goal line");
  assert.ok(ls.some((l) => l.includes("(2/4 items)")), "items count suffix");
  assert.ok(ls.some((l) => l.includes("— tests broke")), "failReason beats needsOwner, first line only");
  assert.ok(ls.some((l) => l.includes("— pick a color")), "needsOwner string as reason");
  assert.ok(ls.includes("  [x] 1. first thing"));
  assert.ok(ls.includes("  [ ] 2. second line"), "checklist newlines collapse to one line");
  assert.ok(ls.includes("- #7 grok: fix it — lint failed"));
  assert.ok(ls.includes("Leverage: free agents (151.2M tokens, 42% of the session)"));
  assert.ok(ls.includes("T111 job: hello"), "log line uses fmtTime and first non-empty line");
}

// --- Failed-job error fallback: reviewNote -> summary -> status --------------
{
  const out = buildSummary({
    now: NOW, fmtTime,
    jobs: [
      { id: 3, agent: "a", status: "failed", reviewNote: "\n\nreal note\nmore", summary: "sum", title: "t" },
      { id: 2, agent: "b", status: "conflict", reviewNote: "  ", summary: "sum\nline2", title: "t" },
      { id: 1, agent: "c", status: "sent back", title: "t" },
      { id: 9, agent: "ok", status: "merged", reviewNote: "not failed" },
    ],
  });
  const ls = lines(out);
  const section = ls.slice(ls.indexOf("Failed jobs:"));
  assert.ok(section.some((l) => l.includes("— real note")), "first non-empty reviewNote line wins");
  assert.ok(section.some((l) => l.includes("— sum")), "summary is the fallback");
  assert.ok(section.some((l) => l.endsWith("— sent back")), "status is the last resort");
  assert.ok(!section.some((l) => l.includes("#9")), "non-failed jobs stay out");
  // Newest first by id.
  const order = section.filter((l) => l.startsWith("- #")).map((l) => l.match(/#(\d+)/)[1]);
  assert.deepEqual(order, ["3", "2", "1"]);
}

// --- Big input: the 80-line cap holds ----------------------------------------
{
  const history = Array.from({ length: 40 }, (_, i) => ({
    id: `g${i}`, text: `goal ${i}`, status: "done", itemsDone: 1, itemsTotal: 2,
  }));
  const items = Array.from({ length: 50 }, (_, i) => ({ n: i + 1, text: `item ${i}\nwith newline`, state: i % 2 ? "done" : "todo" }));
  const jobs = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1, agent: "devin", status: i % 4 === 0 ? "failed" : "merged",
    title: `job ${i}`, summary: `did ${i}`,
  }));
  const log = Array.from({ length: 200 }, (_, i) => ({ at: i, kind: "k", text: `log ${i}\nsecond line ${i}` }));
  const out = buildSummary({
    now: NOW, fmtTime, history, items, jobs, log,
    queue: Array.from({ length: 30 }, (_, i) => ({ id: `q${i}`, text: `queued ${i}` })),
  });
  const ls = lines(out);
  assert.ok(ls.length <= SUMMARY_MAX_LINES, `report is ${ls.length} lines`);
  assert.equal(ls[0].startsWith("Constance summary "), true, "header survives");
  assert.ok(ls.every((l) => !/[\r\n]/.test(l)), "no raw newlines inside a line");
  assert.ok(ls.includes("T199 k: log 199"), "the last log entry survives");
  assert.ok(ls.includes("Last 30 log lines:"));
  assert.ok(!ls.includes("T0 k: log 0"), "only the last 30 log lines");
  assert.ok(ls.some((l) => l.includes("… 30 earlier goals")), "40 history -> 30 hidden");
  assert.ok(ls.some((l) => l.startsWith("  … ")), "checklist keeps its marker");
}

// --- Failed-jobs overflow marker ---------------------------------------------
{
  const jobs = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, agent: "x", status: "failed", title: `j${i}` }));
  const out = buildSummary({ now: NOW, fmtTime, jobs });
  const ls = lines(out);
  const fi = ls.indexOf("Failed jobs:");
  const section = ls.slice(fi, ls.indexOf("Leverage:", fi));
  assert.equal(section.filter((l) => l.startsWith("- #")).length, 8);
  assert.ok(section.includes("  … 4 more"));
}

// --- Checklist overflow at 15 -------------------------------------------------
{
  const items = Array.from({ length: 20 }, (_, i) => ({ n: i + 1, text: `i${i}`, state: "todo" }));
  const out = buildSummary({ now: NOW, fmtTime, items });
  const ls = lines(out);
  const ci = ls.indexOf("Checklist:");
  assert.ok(ls.slice(ci).some((l) => l === "  … 5 more"));
  assert.equal(ls.slice(ci).filter((l) => l.startsWith("  [")).length, 15);
}

// --- Leverage variants ---------------------------------------------------------
{
  const out = buildSummary({ now: NOW, fmtTime, leverage: { label: "L", tokens: 500, spentPct: 7 } });
  assert.ok(lines(out).includes("Leverage: L (500 tokens, 7% of the session)"));
  const pctOnly = buildSummary({ now: NOW, fmtTime, leverage: { label: "L", spentPct: 3 } });
  assert.ok(lines(pctOnly).includes("Leverage: L (3% of the session)"));
}

console.log("constance-summary: tests passed");
