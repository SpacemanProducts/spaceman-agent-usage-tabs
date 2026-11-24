import assert from "node:assert/strict";
import { entryText, logText, stamp } from "./constance-logtext.mjs";

const at = new Date(2026, 10, 24, 9, 5).getTime();
assert.equal(stamp(at), "2026-11-24 09:05");
const prompt = "Check: this job is for the git worktree /var/tmp/constance-worktrees/job-3\n" + "line\n".repeat(60) + "Last step";
const p = entryText({ at, kind: "practice", job: 3, agent: "devin", reason: "under its limits", text: "add p1", prompt, worktree: "/var/tmp/constance-worktrees/job-3", branch: "constance/job-3" }, (id) => id === "devin" ? "Devin" : id);
assert.ok(p.startsWith("2026-11-24 09:05  Practice job 3 → Devin (under its limits): add p1\n"));
assert.ok(p.includes("(a real run works in /var/tmp/constance-worktrees/job-3 on constance/job-3)"));
assert.ok(p.endsWith(prompt), "a practice prompt is copied in full, never cut");
assert.equal(entryText({ at, kind: "review", job: 2, verdict: "send back", text: "no" }), "2026-11-24 09:05  Job 2 sent back: no");
assert.equal(entryText({ at, kind: "returned", job: 4, agent: "devin", worker: "Devin 2", text: "ok" }), "2026-11-24 09:05  Job 4 back from Devin 2: ok");
const all = logText([{ at, kind: "goal", text: "a" }, { at: at + 60e3, kind: "report", text: "b" }]);
assert.equal(all, "2026-11-24 09:05  Goal: a\n\n2026-11-24 09:06  Report: b\n", "oldest first, blank line between entries");
assert.equal(logText([]), "\n");
console.log("constance-logtext: tests passed");
