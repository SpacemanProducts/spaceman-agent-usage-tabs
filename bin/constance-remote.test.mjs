// The remote summary: goal/checklist/jobs/limits lines, the <=15-line cap, the
// path-and-email stripping, and the atomic write — all on fake status objects
// in a mktemp folder with a fake HOME (nothing real is touched).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "constance-remote-home-"));

const { remoteSummary, writeRemoteStatus } = await import("./constance-remote.mjs");

const status = (over = {}) => ({
  goal: { text: "Ship the remote summary\nsecond line ignored", dir: "/nowhere" },
  board: { checklist: { items: [
    { n: 1, text: "No idle slots", state: "done" },
    { n: 2, text: "Write the module", state: "working" },
    { n: 3, text: "Write the doc", state: "todo" },
  ] } },
  jobs: [
    { id: "j1", status: "running", worker: "Devin 1", title: "t" },
    { id: "j2", status: "held", worker: "Grok", title: "t" },
    { id: "j3", status: "finished", worker: "Copilot", title: "t" },
    { id: "j4", status: "conflict", worker: "Cursor", title: "t" },
  ],
  pace: { windows: [
    { title: "Session", used: 0.42 },
    { title: "Weekly", used: 0.67 },
  ] },
  practice: false,
  ...over,
});

// A normal status: goal first, checklist count and per-item lines, job counts,
// Session/Weekly percents, no practice line.
const s1 = remoteSummary(status());
const l1 = s1.trimEnd().split("\n");
assert.equal(l1[0], "Goal: Ship the remote summary");
assert.ok(!s1.includes("second line"), "goal is one trimmed line");
assert.ok(l1.includes("Checklist: 1/3 done"));
assert.ok(l1.includes("✓ 1 No idle slots"));
assert.ok(l1.includes("… 2 Write the module"));
assert.ok(l1.includes("· 3 Write the doc"));
assert.ok(l1.includes("Jobs: 1 running · 1 held · 1 finished · 1 other"));
assert.ok(l1.includes("Limits: Session 42% · Weekly 67%"));
assert.ok(!s1.includes("Practice"));
assert.ok(l1.length <= 15, `${l1.length} lines`);
assert.ok(!s1.includes("/nowhere"), "goal dir never appears");

// Practice flag adds its line; missing windows degrade to "no data".
const s2 = remoteSummary(status({ practice: true, pace: { windows: [] }, jobs: [] }));
assert.ok(s2.includes("Practice run"));
assert.ok(s2.includes("Limits: no data"));
assert.ok(s2.includes("Jobs: 0 running · 0 held · 0 finished"));
assert.ok(!s2.includes(" other"), "no other bucket when empty");

// Paths and emails are stripped everywhere they could appear; the summary
// stays under 15 lines even with a long checklist.
const stuffed = status({
  goal: { text: "Fix /home/spaceman/secrets and mail bob@example.com now" },
  board: { checklist: { items: [
    ...Array.from({ length: 14 }, (_, i) => ({ n: i + 1, text: `item ${i + 1} in /tmp/x`, state: "todo" })),
    { n: 15, text: "reach me at a@b.co", state: "todo" },
  ] } },
});
const s3 = remoteSummary(stuffed);
assert.ok(!s3.includes("/home/"), "no /home path");
assert.ok(!s3.includes("bob@example.com") && !s3.includes("a@b.co"), "no emails");
assert.ok(!s3.includes("/tmp/x"), "absolute-path tokens are dropped too");
assert.ok(s3.split("\n").length <= 16, "15 lines + trailing newline");
assert.ok(s3.includes("… "), "overflow items are folded");

// A path-looking goal loses the path tokens but keeps the plain words.
const g = remoteSummary(status({ goal: "Work in /home/spaceman/code on it" }));
assert.ok(g.includes("Goal: Work in on it"), g.split("\n")[0]);

// Empty / broken input never throws.
for (const bad of [null, undefined, {}, { goal: null, board: null, jobs: null, pace: null }]) {
  const out = remoteSummary(bad);
  assert.ok(out.startsWith("Goal:"), "still a summary");
}

// writeRemoteStatus writes exactly remoteSummary's text, atomically.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-remote-"));
const file = path.join(dir, "nested", "status.txt");
writeRemoteStatus(status({ practice: true }), file);
assert.equal(fs.readFileSync(file, "utf8"), remoteSummary(status({ practice: true })));
assert.ok(!fs.existsSync(`${file}.${process.pid}.tmp`), "no tmp file left");
assert.deepEqual(fs.readdirSync(path.dirname(file)), ["status.txt"]);

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(process.env.HOME, { recursive: true, force: true });

console.log("constance-remote: ok");
