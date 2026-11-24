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
assert.match(p.split("\n")[0], /^Check: .*\/home\/u\/proj/, "the first line checks the folder");
assert.match(p, /git status/);
assert.match(p, /commit only your own changes/);
assert.match(p, /never `git add -A`/);
assert.ok(p.trim().split("\n").pop().includes(doneFile("/home/u/proj", 7)), "the last instruction is the done file");
assert.equal(doneFile("/p", 3), "/p/.constance/done-3.json");

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
