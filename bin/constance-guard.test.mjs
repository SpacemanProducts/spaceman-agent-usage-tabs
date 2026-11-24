// Constance's post-run guardrails in a scratch HOME/projects dir and git repo:
// a clean run passes, a run that touches files outside its list or creates a
// project folder is caught, restored (commit reverted, stray project quarantined)
// and capped to smaller tasks afterwards.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { snapshot, checkRun, restoreRun, changedPaths, fileCap } from "./constance-guard.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-guard-"));
const home = path.join(root, "home"), projects = path.join(home, "Projects"), repo = path.join(projects, "app");
fs.mkdirSync(projects, { recursive: true }); fs.mkdirSync(repo);
const env = { HOME: home, SQUAD_PROJECTS: projects };
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
fs.writeFileSync(path.join(repo, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-qm", "init");
// Same exclusion the real delegate() sets up: .constance/ never shows in status.
fs.writeFileSync(path.join(repo, ".git/info/exclude"), ".constance/\n");
fs.mkdirSync(path.join(repo, ".constance"));
fs.writeFileSync(path.join(repo, ".constance", "done-1.json"), '{"summary":"ok","commit":""}');

const before = snapshot(env);
assert.deepEqual(before.home, ["Projects"], "home snapshot lists top-level names");
assert.deepEqual(before.projects, ["app"]);

// A clean run: allowed file committed, done file ignored -> no violations.
fs.writeFileSync(path.join(repo, "b.txt"), "b\n"); git("add", "b.txt"); git("commit", "-qm", "add b");
const cleanCommit = git("rev-parse", "HEAD").trim();
let res = checkRun({ dir: repo, files: ["b.txt"], commit: cleanCommit, before, env });
assert.equal(res.ok, true, JSON.stringify(res.violations));
assert.deepEqual(res.badPaths, []);

// Uncommitted leftovers count too: an allowed file plus a stray one.
fs.writeFileSync(path.join(repo, "stray.txt"), "x\n");
res = checkRun({ dir: repo, files: ["b.txt"], commit: cleanCommit, before, env });
assert.equal(res.ok, false);
assert.ok(res.violations.some((v) => v.includes("stray.txt")), "stray.txt flagged: " + res.violations);
fs.rmSync(path.join(repo, "stray.txt"));

// A file outside the allowed list inside the commit is flagged.
fs.writeFileSync(path.join(repo, "c.txt"), "c\n"); git("add", "c.txt"); git("commit", "-qm", "add c");
const badCommit = git("rev-parse", "HEAD").trim();
res = checkRun({ dir: repo, files: ["b.txt"], commit: badCommit, before, env });
assert.equal(res.ok, false);
assert.ok(res.badPaths.includes("c.txt"));

// A read-only job (no files) flags ANY change.
res = checkRun({ dir: repo, files: [], commit: badCommit, before, env });
assert.equal(res.ok, false, "read-only jobs may not change anything");

// Creating a folder in ~/Projects during the run is caught.
const projBefore = snapshot(env);
fs.mkdirSync(path.join(projects, "sneaky-app"));
res = checkRun({ dir: repo, files: ["b.txt"], commit: badCommit, before: projBefore, env });
assert.equal(res.ok, false);
assert.ok(res.violations.some((v) => v.includes("sneaky-app")), "new project folder flagged");
assert.deepEqual(res.addedProjects, ["sneaky-app"]);

// restoreRun: revert the bad commit and quarantine the stray project folder.
const did = restoreRun({ dir: repo, commit: badCommit, badPaths: ["c.txt"], addedProjects: ["sneaky-app"], projectsDir: projects });
assert.ok(did.some((d) => d.startsWith("reverted commit")), did.join("; "));
assert.ok(did.some((d) => d.startsWith("quarantined project sneaky-app")), did.join("; "));
assert.ok(!fs.existsSync(path.join(projects, "sneaky-app")), "stray project moved out of Projects");
assert.ok(fs.existsSync(path.join(repo, ".constance", "quarantine")), "quarantine dir exists");
assert.ok(fs.readdirSync(path.join(repo, ".constance", "quarantine")).some((n) => n.endsWith("-sneaky-app")), "the folder is kept, not deleted");
assert.equal(git("status", "--porcelain").trim(), "", "worktree is clean after restore");
assert.ok(!fs.existsSync(path.join(repo, "c.txt")), "reverted file is gone");

// Home-level additions are reported but never auto-touched; hidden churn is ignored.
fs.writeFileSync(path.join(home, "stray-home-file"), "x");
fs.mkdirSync(path.join(home, ".cache-churn"));
res = checkRun({ dir: repo, files: ["b.txt"], commit: "", before, env });
assert.ok(res.violations.some((v) => v.includes("stray-home-file")), "home additions flagged");
assert.ok(!res.violations.some((v) => v.includes("cache-churn")), "dotfile churn is ignored");
assert.ok(fs.existsSync(path.join(home, "stray-home-file")), "home entries are only reported, never moved");

// changedPaths sees committed and dirty paths but ignores .constance/.
assert.deepEqual(changedPaths(repo, ""), [], "clean tree, no commit: nothing");
fs.writeFileSync(path.join(repo, "d.txt"), "d\n");
assert.deepEqual(changedPaths(repo, ""), ["d.txt"]);
fs.rmSync(path.join(repo, "d.txt"));

// fileCap: clean agents uncapped, one strike -> 3 files, two+ -> 1.
assert.equal(fileCap(0), Infinity);
assert.equal(fileCap(1), 3);
assert.equal(fileCap(2), 1);
assert.equal(fileCap(5), 1);

fs.rmSync(root, { recursive: true, force: true });
console.log("constance-guard: tests passed");
