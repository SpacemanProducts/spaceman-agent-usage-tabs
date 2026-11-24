// The morning report: which finished goals it covers, the per-goal lines, the token
// total with can't-tell jobs, the needs-you list (de-duplicated), and the stamp file.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { morningFile, stampFile, lastReportAt, buildReport, writeReport } from "./constance-morning.mjs";

const NOW = new Date(2026, 10, 24, 8, 30).getTime();   // local 2026-11-24 08:30
const rec = (over = {}) => ({ id: "g1", text: "Fix the thing", dir: "/p", startedAt: 0, finishedAt: 1000,
  status: "done", outcome: "done", needsOwner: "", jobs: 1, merged: 1, sentBack: 0, practice: false,
  tokens: 1000, tokensCantTell: 0, itemsDone: 0, itemsTotal: 0, ...over });

// since filtering: only goals finished after `since` are reported.
const old = rec({ id: "old", finishedAt: 500 });
const fresh = rec({ id: "new", finishedAt: 2000 });
const r1 = buildReport({ records: [old, fresh], since: 1000, now: NOW });
assert.equal(r1.goals, 1);
assert.match(r1.text, /# Morning report — 2026-11-24/);
assert.match(r1.text, /- Fix the thing — done · 1 merged, 0 sent back/);
assert.ok(!r1.text.includes("old"), "the old goal is filtered out");
assert.match(r1.text, /## Done\n- Fix the thing/);
assert.match(r1.text, /Tokens: 1K\n/);

// Token sum and can't-tell note over non-practice goals.
const r2 = buildReport({ records: [
  rec({ id: "a", tokens: 1_200_000, tokensCantTell: 2, merged: 3 }),
  rec({ id: "b", tokens: 300_000, tokensCantTell: 0 }),
  rec({ id: "p", text: "Practice goal", practice: true, merged: 0, tokens: 9_000_000, tokensCantTell: 7 }),
], now: NOW });
assert.match(r2.text, /Tokens: 1\.5M \(2 jobs can't tell\)/, "practice tokens and can't-tell don't count");
assert.match(r2.text, /- Practice goal — done · 0 merged, 0 sent back · \(practice\)/, "practice is marked");
assert.match(r2.body, /^3 goals done, 4 jobs merged, 1\.5M tokens\./, "body sums the same numbers");

// needsOwner and `needs` are de-duplicated; 'Nothing needs you.' when empty.
const r3 = buildReport({ records: [
  rec({ id: "a", needsOwner: "Job 4 hit a merge conflict." }),
  rec({ id: "b", needsOwner: "Job 4 hit a merge conflict." }),
  rec({ id: "c", needsOwner: "" }),
], needs: ["Job 4 hit a merge conflict.", "  ", "Check the logs"], now: NOW });
const needsLines = r3.text.split("## Needs you\n")[1].trim().split("\n");
assert.deepEqual(needsLines, ["- Job 4 hit a merge conflict.", "- Check the logs"]);
assert.match(r3.body, /Needs you: Job 4 hit a merge conflict; Check the logs\./);
const r4 = buildReport({ records: [rec()], now: NOW });
assert.match(r4.text, /## Needs you\nNothing needs you\./);
assert.match(r4.body, /Nothing needs you\.$/);

// Items and sent-back counts, outcome and first-line clipping.
const long = "x".repeat(120);
const r5 = buildReport({ records: [rec({ text: `${long}\nsecond line`, outcome: "needs you", needsOwner: "stuck",
  itemsDone: 2, itemsTotal: 3, merged: 0, sentBack: 2 })], now: NOW });
assert.match(r5.text, new RegExp(`- ${"x".repeat(79)}… — needs you · 2/3 · 0 merged, 2 sent back`));
assert.ok(!r5.text.includes("second line"));

// Empty: no goals at all.
const r6 = buildReport({ records: [], now: NOW });
assert.equal(r6.goals, 0);
assert.match(r6.text, /## Done\nNo goals finished since the last report\./);
assert.ok(!r6.text.includes("Tokens:"));
assert.match(r6.text, /Nothing needs you\./);
assert.match(r6.body, /Nothing needs you\.$/);

// The 200-char body cap.
const manyNeeds = Array.from({ length: 10 }, (_, i) => `need number ${i} with some padding text`);
const r7 = buildReport({ records: [rec()], needs: manyNeeds, now: NOW });
assert.ok(r7.body.length <= 200, `body is ${r7.body.length} chars`);
assert.ok(r7.body.endsWith("…"));

// writeReport / lastReportAt round trip in a temp dir.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-morning-"));
assert.equal(lastReportAt(dir), 0, "no stamp yet");
assert.equal(lastReportAt(path.join(dir, "missing")), 0, "missing dir");
fs.writeFileSync(stampFile(dir), "not json");
assert.equal(lastReportAt(dir), 0, "broken stamp");
const file = writeReport(dir, r4, NOW);
assert.equal(file, morningFile(dir));
assert.equal(fs.readFileSync(morningFile(dir), "utf8"), r4.text);
assert.deepEqual(JSON.parse(fs.readFileSync(stampFile(dir), "utf8")), { at: NOW, goals: 1 });
assert.equal(lastReportAt(dir), NOW);
fs.rmSync(dir, { recursive: true, force: true });

console.log("constance-morning: ok");
