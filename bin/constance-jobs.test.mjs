import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore, overlaps, conflicts, handoffPrompt, reviewQueue, doneFile, stateDir } from "./constance-jobs.mjs";

assert.deepEqual(overlaps(["a.js"], ["b.js"]), []);
assert.deepEqual(overlaps(["./src/a.js"], ["src/a.js"]), ["src/a.js"]);
assert.equal(overlaps(["src/a.js"], ["src/"]).length, 1, "a file inside a listed folder overlaps");
assert.equal(overlaps(["."], ["x"]).length, 1, "the whole repo overlaps everything");
const jobs = [{ id: 1, dir: "/p", files: ["Panel.qml"], status: "running" }, { id: 2, dir: "/p", files: ["x.js"], status: "accepted" }, { id: 3, dir: "/q", files: ["Panel.qml"], status: "running" }];
assert.deepEqual(conflicts(jobs, "/p", ["Panel.qml", "y"]).map((j) => j.id), [1], "only running jobs in the same folder conflict");
assert.deepEqual(conflicts(jobs, "/p", ["x.js"]), [], "finished work doesn't block");

const p = handoffPrompt({ id: 7, dir: "/home/u/proj", task: "Add the button.", files: ["Panel.qml"] });
const lines = p.split("\n");
assert.match(lines[0], /^Check: .*\/home\/u\/proj/, "the first line checks the folder");
assert.match(lines[1], /git status/, "the second line checks git status");
assert.ok(lines.findIndex((l) => l.startsWith("Task (job 7")) > 1, "the task comes after the checks");
assert.match(p, /Only edit these files: Panel\.qml/);
assert.match(p, /Everything else is off-limits/);
assert.match(p, /tests and build/);
assert.match(p, /commit only your own work in its own commit/);
assert.match(p, /never `git add -A`/);
assert.match(p, /Do not push or deploy unless the task explicitly says to/);
assert.match(p, /Report in plain text: what you changed, the test and build results, and which files you touched/);
assert.match(p, /No screenshots unless checking the look itself is the task/);
assert.match(p, /"files": \["the files you changed"\]/);
assert.ok(lines.pop().includes(doneFile("/home/u/proj", 7)), "the last instruction is the done file");
assert.equal(doneFile("/p", 3), "/p/.constance/done-3.json");

// A handoff with no files is read-only: it changes nothing and only reports (unknown-cause bugs,
// file summaries). It still gets the checks, the report rules and the done file.
const ro = handoffPrompt({ id: 8, dir: "/home/u/proj", task: "Find why the meter is gray.", files: [] });
assert.match(ro, /^Check: /);
assert.match(ro, /git status/);
assert.match(ro, /read-only job: change nothing, create nothing, delete nothing/);
assert.doesNotMatch(ro, /Only edit these files/);
assert.doesNotMatch(ro, /git add/, "a read-only job never commits");
assert.match(ro, /Do not push or deploy/);
assert.match(ro, /Report in plain text/);
assert.ok(ro.trim().split("\n").pop().includes(doneFile("/home/u/proj", 8)));
assert.match(handoffPrompt({ id: 9, dir: "/p", task: "t" }), /read-only job/, "files default to read-only");

assert.deepEqual(reviewQueue([{ id: 1, status: "finished", finishedAt: 20 }, { id: 2, status: "finished", finishedAt: 10 }, { id: 3, status: "accepted", finishedAt: 5 }]).map((j) => j.id), [2, 1], "reviewed in the order they finished");

assert.match(stateDir({ XDG_STATE_HOME: "/s" }), /^\/s\/omarchy\/agent-usage-tabs\/constance$/);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constance-test-"));
const s = openStore(dir);
assert.deepEqual(s.read(), { goal: null, jobs: [], next: 1 });
const id = s.update((d) => { d.jobs.push({ id: d.next++, status: "waiting" }); return d.next - 1; });
assert.equal(id, 1);
assert.equal(openStore(dir).read().jobs[0].status, "waiting", "the job file survives a restart");
assert.throws(() => s.update(() => { throw new Error("boom"); }));
assert.equal(s.read().next, 2, "a failed update writes nothing");
assert.ok(!fs.existsSync(path.join(dir, "jobs.lock")), "the lock is released after a failure");
s.log({ kind: "note", text: "hi" });
assert.equal(s.readLog()[0].text, "hi");
fs.rmSync(dir, { recursive: true });
console.log("constance-jobs: tests passed");
