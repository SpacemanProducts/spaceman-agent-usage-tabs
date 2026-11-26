// End to end for the handoff loop, in a scratch state dir and repo with a fake
// `claude` (a node script that acts only on its step prompt), fake devin/grok and a
// mktemp fake home (practice off, quiet fake busctl and notify-send, fake /proc):
//  1. Every brain run is a fresh session (--session-id, new each time, never
//     --resume): a planning step delegates, then a review step reviews. No brain
//     runs while the workers work: the driver waits.
//  2. .constance/handoff.md is written by the controller: goal, checklist, job
//     board, decisions, open problems, notes. A decision and a note made in the
//     planning session reach the review session through the file. The finished
//     file collapses the done items and stays under 150 lines.
//  3. A worker can't write the project's .constance/ (read-only in its sandbox),
//     and a brain that edits the file by hand gets it rewritten from her records.
//  4. A crash mid-step (driver and brain killed) loses nothing: `recover` starts a
//     fresh session told it was interrupted, its handoff still holds what the dead
//     session recorded, and the goal finishes without redoing the started job.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const CLI = new URL("./constance.mjs", import.meta.url).pathname;
let root = "";
for (const base of ["/var/tmp", path.join(os.homedir(), ".cache")]) {
  if (!path.isAbsolute(base)) continue;
  try { fs.mkdirSync(base, { recursive: true }); root = fs.mkdtempSync(path.join(base, "constance-hodrive-")); break; } catch {}
}
if (!root) root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-hodrive-"));
assert.ok(path.isAbsolute(root), "scratch root must be absolute");
const state = path.join(root, "state"), bin = path.join(root, "bin"), repo = path.join(root, "repo");
assert.ok(path.isAbsolute(bin), "fake bin dir must be absolute before it goes on PATH");
const tabs = path.join(state, "omarchy/agent-usage-tabs"), cdir = path.join(tabs, "constance");
fs.mkdirSync(tabs, { recursive: true }); fs.mkdirSync(bin); fs.mkdirSync(repo);
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
fs.writeFileSync(path.join(repo, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-qm", "init");
const soon = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const writeData = () => fs.writeFileSync(path.join(tabs, "data.json"), JSON.stringify({ generatedAt: Date.now(), agents: [
  { id: "claude", installed: true, signedIn: true, limits: [{ title: "Session", percent: 0.1, resetsAt: soon(4) }, { title: "Weekly", percent: 0.1, resetsAt: soon(150) }] },
  { id: "grok", installed: true, signedIn: true, limits: [{ title: "Daily", percent: 0.1 }] },
  { id: "devin", name: "Devin", installed: true, signedIn: true, limits: [{ title: "Daily", percent: 0.1 }] }] }));
writeData();
fs.writeFileSync(path.join(tabs, "settings.json"), JSON.stringify({ constancePractice: false, constanceSelfMerge: false, constanceUseItOrLoseIt: false }));

// Fake devin (a copy in its own worktree) and fake grok (in the project folder):
// each edits the one file its prompt allows and commits. Grok first tries to write
// the project's handoff file and records whether it could. Both wait for a go-file
// so the test can see the driver waiting with no brain running. (The sandbox
// shows /var/tmp read-only, so grok reports its try in its own log.)
const workerBody = (who, tryHandoff) => `#!/bin/bash
p="\${@: -1}"; f=$(grep -o '/[^ ]*/.constance/done-[0-9]*.json' <<<"$p" | head -1)
${tryHandoff ? `if echo "worker was here" >> "${repo}/.constance/handoff.md" 2>/dev/null; then echo "handoff-write: wrote"; else echo "handoff-write: refused"; fi` : ""}
while [[ ! -e "${root}/go" ]]; do sleep 0.2; done
name=$(sed -n 's/^Only edit these files: \\([^ ,]*\\)\\..*/\\1/p' <<<"$p" | head -1); name=\${name:-x.txt}
before=$(git rev-parse HEAD)
echo "${who} $name" > "$name"; git add "$name"; git commit -qm "${who}: $name" || true
after=$(git rev-parse HEAD); c=""; [[ "$after" != "$before" ]] && c="$after"
echo "{\\"summary\\": \\"added \${name%.*}\\", \\"commit\\": \\"$c\\", \\"files\\": [\\"$name\\"]}" > "$f"
`;
fs.writeFileSync(path.join(bin, "devin"), workerBody("devin", false), { mode: 0o755 });
fs.writeFileSync(path.join(bin, "grok"), workerBody("grok", true), { mode: 0o755 });

// Fake Constance: a node script that only knows what its prompt tells it, like a
// fresh session. Plan: delegate every "todo" item in the handoff's checklist (item
// 3 to grok, the rest to devin), record a decision and a note. Review: accept every
// job in the batch. Every run is logged with its argv. Marker files steer the
// special cases (a hand edit of the file; a hang so the test can crash her).
fs.writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env node
const fs = require("fs"), { spawnSync } = require("child_process");
const argv = process.argv.slice(2), p = argv.at(-1);
fs.appendFileSync(${JSON.stringify(path.join(root, "claude-runs.jsonl"))}, JSON.stringify({ at: Date.now(), argv }) + "\\n");
const C = (...a) => { const r = spawnSync("node", [${JSON.stringify(CLI)}, ...a], { encoding: "utf8" }); fs.appendFileSync(${JSON.stringify(path.join(root, "brain.out"))}, a.join(" ") + " => " + r.status + " " + r.stdout + r.stderr + "\\n"); return r; };
const mark = (f) => fs.existsSync(${JSON.stringify(root)} + "/" + f);
if (p.startsWith("Step: plan.")) {
  const todo = [...p.matchAll(/^- \\[ \\] (\\d+)\\. .* — todo$/gm)].map((m) => Number(m[1]));
  for (const n of todo) {
    C("delegate", "--agent", n === 3 ? "grok" : "devin", "--files", "f" + n + ".txt", "--item", String(n), "--title", "adding f" + n, "--task", "add f" + n);
    C("handoff", "decide", "item " + n + " goes out as its own small job");
    if (mark("hang")) { fs.writeFileSync(${JSON.stringify(root)} + "/hanging", ""); setInterval(() => {}, 1000); return; }
  }
  C("handoff", "next", "check that f1 and f2 don't touch each other");
  if (mark("tamper")) fs.appendFileSync(${JSON.stringify(path.join(repo, ".constance", "handoff.md"))}, "EVIL hand edit\\n");
  console.log("Planned items " + todo.join(", ") + ".");
} else if (p.startsWith("Step: review.")) {
  for (const m of p.matchAll(/^\\{"id":(\\d+),/gm)) C("review", m[1], "accept", "--note", "looks right");
  C("handoff", "problem", "nothing serious, just a reminder to recheck f3");
  console.log("Report: reviewed and accepted.");
} else {
  console.log("unexpected prompt");
}
`, { mode: 0o755 });

const fakeHome = path.join(root, "home"); fs.mkdirSync(path.join(fakeHome, "Projects"), { recursive: true });
fs.writeFileSync(path.join(bin, "busctl"), "#!/bin/bash\nsleep 30\n", { mode: 0o755 });
fs.writeFileSync(path.join(bin, "notify-send"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${root}/notified.txt"\n`, { mode: 0o755 });
const proc = path.join(root, "proc"); fs.mkdirSync(proc);
fs.writeFileSync(path.join(proc, "loadavg"), "0.10 0.50 0.50 1/500 999\n");
fs.writeFileSync(path.join(proc, "meminfo"), "MemTotal:       33554432 kB\nMemFree:        20971520 kB\nMemAvailable:   20971520 kB\n");
const env = { ...process.env, CONSTANCE_WORKTREES: path.join(root, "worktrees"), HOME: fakeHome, SQUAD_PROJECTS: path.join(fakeHome, "Projects"),
  XDG_STATE_HOME: state, XDG_DATA_HOME: path.join(fakeHome, ".local", "share"), PATH: `${bin}:${process.env.PATH}`,
  CONSTANCE_PROC: proc, CONSTANCE_RAMP_GAP_MS: "0", CONSTANCE_TOKENS_GAP_MS: "500", CONSTANCE_NO_NOTIFY: "1", CONSTANCE_WAIT_TICK_MS: "300" };
const run = (...a) => spawnSync("node", [CLI, ...a], { env, encoding: "utf8" });
const jobsFile = () => { try { return JSON.parse(fs.readFileSync(path.join(cdir, "jobs.json"), "utf8")); } catch { return { goal: null, jobs: [] }; } };
const status = () => JSON.parse(run("status").stdout);
const until = async (fn, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };
const runs = () => { try { return fs.readFileSync(path.join(root, "claude-runs.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const kill = (pid) => { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} } };
const handoffMd = path.join(repo, ".constance", "handoff.md");
const pids = new Set();
const notePids = () => { const g = jobsFile().goal; if (g?.driverPid) pids.add(g.driverPid); if (g?.brainPid) pids.add(g.brainPid); try { pids.add(Number(fs.readFileSync(path.join(cdir, "watcher.pid"), "utf8"))); } catch {} };

try {
  // ---- 1-3: a three-item goal, planned in one session and reviewed in another.
  fs.writeFileSync(path.join(root, "tamper"), "");
  assert.equal(run("start", "--dir", repo, "--goal", "Add the three files.\n1. add f1\n2. add f2\n3. add f3").status, 0);
  notePids();
  assert.ok(await until(() => jobsFile().jobs.filter((j) => j.status === "running").length === 3), "the planning step put three jobs out: " + JSON.stringify(jobsFile().jobs.map((j) => [j.id, j.agent, j.status])));
  // The planning session ended; while the workers work, no brain runs at all.
  assert.ok(await until(() => { const g = jobsFile().goal; return g.handoff?.steps?.[0]?.endedAt && !alive(g.brainPid); }), "the planning session exited");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(runs().length, 1, "no new brain session while the jobs run");
  {
    const md = fs.readFileSync(handoffMd, "utf8");
    assert.match(md, /^# Handoff: Add the three files\./);
    assert.match(md, /## Goal\nAdd the three files\.\n/);
    assert.match(md, /- \[ \] 1\. add f1 — working \(job \d+\)/);
    assert.match(md, /## Job board\n(- #\d+ .*running · adding f\d.*\n){3}/, "the board lists the three running jobs");
    assert.match(md, /## Decisions made\n- item 1 goes out as its own small job\n- item 2/);
    assert.match(md, /## Notes for the next session\n- check that f1 and f2 don't touch each other/);
    assert.doesNotMatch(md, /EVIL|worker was here/, "the brain's hand edit was rewritten and the worker couldn't write");
    // The worker's own log (its stdout) says what happened when it tried.
    const gj = jobsFile().jobs.find((j) => j.agent === "grok");
    assert.ok(await until(() => /handoff-write: /.test(fs.readFileSync(gj.log, "utf8")), 10000), "the grok job tried to write the handoff file");
    assert.match(fs.readFileSync(gj.log, "utf8"), /handoff-write: refused/, "the project's .constance/ is read-only in the sandbox");
    assert.ok(status().log.some((l) => l.kind === "note" && /changed outside the controller; it was rewritten/.test(l.text)), "the rewrite is logged");
    assert.ok(git("check-ignore", ".constance/handoff.md").trim(), "the handoff file is git-excluded");
  }
  fs.rmSync(path.join(root, "tamper"));
  fs.writeFileSync(path.join(root, "go"), "");
  assert.ok(await until(() => jobsFile().goal?.status === "done", 90000), "the goal finishes: " + JSON.stringify(jobsFile().goal));
  {
    const rs = runs();
    const sessions = rs.map((r) => r.argv[r.argv.indexOf("--session-id") + 1]);
    assert.ok(rs.every((r) => r.argv.includes("--session-id") && !r.argv.includes("--resume")), "every run is a fresh session");
    assert.equal(new Set(sessions).size, rs.length, "each with its own new session id");
    assert.deepEqual(rs.map((r) => r.argv.at(-1).split(".")[0]), ["Step: plan", "Step: review"], "one planning session, one review session");
    const review = rs[1].argv.at(-1);
    assert.match(review, /Review these 3 finished jobs/, "all three came back in one batch");
    assert.match(review, /- item 1 goes out as its own small job/, "the planning session's decision reached the review session");
    assert.match(review, /- check that f1 and f2 don't touch each other/, "and its note");
    assert.doesNotMatch(review, /Planned items/, "nothing else of the planning session's output rides along");
    const g = jobsFile().goal;
    assert.deepEqual(g.handoff.steps.map((x) => [x.kind, x.outcome]), [["plan", "ok"], ["review", "ok"]]);
    assert.ok(jobsFile().jobs.every((j) => j.status === "accepted"), "all three jobs accepted");
    for (const f of ["f1.txt", "f2.txt", "f3.txt"]) assert.ok(fs.existsSync(path.join(repo, f)), f + " is in the repo");
    const md = fs.readFileSync(handoffMd, "utf8");
    assert.match(md, /· done/, "the finished file says the goal is done");
    assert.match(md, /- \[x\] Done 3 of 3: 1 add f1; 2 add f2; 3 add f3/, "done items collapse into one line");
    assert.match(md, /- Closed: 3 accepted/);
    assert.match(md, /- P1: nothing serious/);
    assert.ok(md.trimEnd().split("\n").length < 150, "short");
    const steps = status().log.filter((l) => l.kind === "steps").at(-1);
    assert.equal(steps.sessions, 2); assert.equal(steps.plan, 1); assert.equal(steps.review, 1);
    assert.ok(steps.promptChars > 0 && steps.maxPromptChars <= steps.promptChars);
  }

  // ---- 4: a crash mid-step. The planning session delegates item 1, records its
  // decision, then hangs; the test kills her brain and the driver (a crash).
  fs.rmSync(path.join(root, "go"), { force: true });
  fs.rmSync(path.join(root, "claude-runs.jsonl"), { force: true });
  fs.writeFileSync(path.join(root, "hang"), "");
  assert.equal(run("start", "--dir", repo, "--goal", "1. add f4\n2. add f5").status, 0);
  notePids();
  assert.ok(await until(() => fs.existsSync(path.join(root, "hanging"))), "the planning session is mid-step");
  const before = jobsFile();
  assert.equal(before.jobs.filter((j) => j.goal === before.goal.id).length, 1, "it put item 1 out before the crash");
  kill(before.goal.driverPid); kill(before.goal.brainPid);
  assert.ok(await until(() => !alive(before.goal.driverPid) && !alive(before.goal.brainPid), 10000), "both are gone");
  fs.rmSync(path.join(root, "hang")); fs.rmSync(path.join(root, "hanging"));
  assert.equal(run("recover").stdout.trim(), "restarted", "recover picks the goal up");
  notePids();
  assert.ok(await until(() => runs().length >= 2), "a fresh session started after the crash");
  {
    const r = runs()[1].argv;
    const p = r.at(-1);
    assert.ok(r.includes("--session-id") && !r.includes("--resume"));
    assert.notEqual(r[r.indexOf("--session-id") + 1], runs()[0].argv[runs()[0].argv.indexOf("--session-id") + 1], "a new session, not the dead one");
    assert.match(p, /^Step: plan\./);
    assert.match(p, /Picking up after an interrupted session \(step 1, plan: a restart or a crash\)/);
    assert.match(p, /- item 1 goes out as its own small job/, "what the dead session recorded is still in the handoff");
    assert.match(p, /- \[ \] 1\. add f4 — working \(job \d+\)/, "its job is on the board");
    assert.match(p, /- \[ \] 2\. add f5 — todo/);
  }
  fs.writeFileSync(path.join(root, "go"), "");
  notePids();
  assert.ok(await until(() => jobsFile().goal?.status === "done", 90000), "the goal finishes after the crash: " + JSON.stringify(jobsFile().goal));
  notePids();
  {
    const s = jobsFile();
    const mine = s.jobs.filter((j) => j.goal === s.goal.id);
    // The fake names a job's file after its item number (f1, f2).
    assert.deepEqual(mine.map((j) => [j.items, j.files[0]]).sort(), [[[1], "f1.txt"], [[2], "f2.txt"]], "item 1 was not redone: one job per item");
    assert.ok(mine.every((j) => j.status === "accepted"));
    assert.deepEqual(s.goal.handoff.steps.map((x) => [x.kind, x.outcome]).slice(0, 2), [["plan", "interrupted (a restart or a crash)"], ["plan", "ok"]]);
    assert.equal(s.goal.handoff.decisions.filter((d) => /item 1/.test(d.text)).length, 1, "the decision is kept once");
  }

  // ---- 5: a ready-queue task an earlier goal left pending (a failed goal's, or
  // a spare goal's backlog refill queued after its last job) never goes to the
  // next goal on the same project. Before, fillSlots handed it out mid-goal with
  // the old goal's item numbers, and its finished job started review steps the
  // new goal never planned. Now it expires: one planning and one review session,
  // only the new goal's own job, and its refill entry is cleared.
  fs.rmSync(path.join(root, "go"), { force: true });
  fs.rmSync(path.join(root, "claude-runs.jsonl"), { force: true });
  {
    const rdir = fs.realpathSync(repo);
    const old = jobsFile().goal.id;
    fs.writeFileSync(path.join(cdir, "queue.json"), JSON.stringify({ next: 9, projects: { [rdir]: [
      { id: 7, task: "leftover: add f9", files: ["f9.txt"], agent: "devin", status: "pending", createdAt: Date.now() - 60e3, goal: old, items: [1] },
      { id: 8, task: "untagged leftover: add f8", files: ["f8.txt"], agent: "devin", status: "pending", createdAt: Date.now() - 60e3 },
    ] } }));
    fs.writeFileSync(path.join(cdir, "refills.json"), JSON.stringify({ [rdir]: { 7: "b1" } }));
  }
  fs.writeFileSync(path.join(root, "go"), "");
  assert.equal(run("start", "--dir", repo, "--goal", "1. add f6").status, 0);
  notePids();
  assert.ok(await until(() => jobsFile().goal?.status === "done", 90000), "the new goal finishes: " + JSON.stringify(jobsFile().goal));
  notePids();
  {
    const s = jobsFile();
    const mine = s.jobs.filter((j) => j.goal === s.goal.id);
    assert.ok(!s.jobs.some((j) => /leftover/.test(j.task)), "no leftover task was handed out: " + JSON.stringify(mine.map((j) => [j.id, j.task])));
    assert.equal(mine.length, 1, "only the new goal's own job: " + JSON.stringify(mine.map((j) => [j.id, j.task])));
    assert.deepEqual(runs().map((r) => r.argv.at(-1).split(".")[0]), ["Step: plan", "Step: review"], "one planning session, one review session, no extra review step");
    const q = JSON.parse(fs.readFileSync(path.join(cdir, "queue.json"), "utf8")).projects[fs.realpathSync(repo)];
    assert.deepEqual(q.filter((t) => t.id === 7 || t.id === 8).map((t) => t.status), ["expired", "expired"], "the leftovers are expired");
    assert.ok(status().log.some((l) => l.kind === "note" && /2 tasks left from an earlier goal expired/.test(l.text)), "the expiry is logged");
    const rf = JSON.parse(fs.readFileSync(path.join(cdir, "refills.json"), "utf8"));
    assert.ok(!rf[fs.realpathSync(repo)]?.[7], "the expired task's refill entry is cleared, so its backlog item can be refilled again");
  }
} finally {
  notePids();
  for (const pid of pids) if (pid) kill(pid);
  try { for (const l of git("worktree", "list", "--porcelain").split("\n")) if (l.startsWith("worktree ") && l.slice(9) !== repo) git("worktree", "remove", "--force", l.slice(9)); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("constance-handoff-drive: tests passed");
