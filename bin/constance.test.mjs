// End to end in a scratch state dir and repo, with fake `claude` and `grok` on PATH: a goal starts the
// driver, "Constance" (the fake claude) hands a task to grok, grok writes its done file and commits,
// wait returns it for review, she accepts it and reports. Also: busy files are refused, an unavailable
// agent is refused, Stop halts everything, and a restart picks the goal back up.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const CLI = new URL("./constance.mjs", import.meta.url).pathname;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-e2e-"));
const state = path.join(root, "state"), bin = path.join(root, "bin"), repo = path.join(root, "repo");
const tabs = path.join(state, "omarchy/agent-usage-tabs");
fs.mkdirSync(tabs, { recursive: true }); fs.mkdirSync(bin); fs.mkdirSync(repo);
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
fs.writeFileSync(path.join(repo, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-qm", "init");
const soon = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const writeData = (claudeSession = 0.1, grokPct = 0.1) => fs.writeFileSync(path.join(tabs, "data.json"), JSON.stringify({ generatedAt: Date.now(), agents: [
  { id: "claude", installed: true, signedIn: true, limits: [{ title: "Session", percent: claudeSession, resetsAt: soon(4) }, { title: "Weekly", percent: 0.1, resetsAt: soon(150) }] },
  { id: "grok", installed: true, signedIn: true, limits: [{ title: "Daily", percent: grokPct }] },
  { id: "copilot", installed: true, signedIn: true, limits: [{ title: "Monthly", percent: 0.94 }] }] }));
writeData();
// Fake grok: the done file path is in the prompt (last argument). Waits for a go-file so the test can
// look at a running job. A read-only job only reports; an editing job writes b.txt, commits and
// sleeps a moment first so the read-only job always finishes (and is reviewed) first.
fs.writeFileSync(path.join(bin, "grok"), `#!/bin/bash
p="\${@: -1}"; f=$(grep -o '/[^ ]*/.constance/done-[0-9]*.json' <<<"$p" | head -1)
while [[ ! -e "${root}/go" ]]; do sleep 0.2; done
if grep -qi "read-only job" <<<"$p"; then
  echo '{"summary": "cause: a.txt has no b", "commit": "", "files": []}' > "$f"
else
  sleep 1
  echo b > b.txt; git add b.txt; git commit -qm "grok: b"; echo "{\\"summary\\": \\"added b\\", \\"commit\\": \\"$(git rev-parse HEAD)\\", \\"files\\": [\\"b.txt\\"]}" > "$f"
fi
`, { mode: 0o755 });
// Fake Constance: delegate (one read-only investigation, then the fix), wait, review, report.
// Records its arguments.
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
echo "$@" > "${root}/claude-args"
C="node ${CLI}"
$C delegate --agent grok --task "why is b missing? find the cause, change nothing, report in a few lines" >> "${root}/brain.out" 2>&1
$C delegate --agent grok --files b.txt --task "add b" >> "${root}/brain.out" 2>&1
$C delegate --agent grok --files b.txt --task "again" >> "${root}/brain.out" 2>&1 || echo "refused-busy" >> "${root}/brain.out"
$C delegate --agent copilot --files c.txt --task "c" >> "${root}/brain.out" 2>&1 || echo "refused-copilot" >> "${root}/brain.out"
touch "${root}/go"
$C wait --timeout 30 > "${root}/wait.json"
$C review 1 accept --note "cause confirmed"
$C wait --timeout 30 > "${root}/wait2.json"
$C review 2 accept --note "looks right"
echo "Report: b added by grok."
`, { mode: 0o755 });
const env = { ...process.env, XDG_STATE_HOME: state, PATH: `${bin}:${process.env.PATH}` };
const run = (...a) => spawnSync("node", [CLI, ...a], { env, encoding: "utf8" });
const status = () => JSON.parse(run("status").stdout);
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };

assert.match(run("start", "--dir", repo, "--goal", "").stderr, /goal first/);
assert.equal(run("start", "--dir", repo, "--goal", "add b").status, 0);
assert.match(run("start", "--dir", repo, "--goal", "other").stderr, /already on a goal/, "one goal at a time");
assert.ok(await until(() => status().goal.status === "done"), "the goal finishes: " + JSON.stringify(status().goal));
const s = status();
assert.equal(s.jobs.length, 2);
assert.equal(s.jobs[0].agent, "grok"); assert.equal(s.jobs[0].status, "accepted");
assert.equal(s.jobs[0].summary, "cause: a.txt has no b"); assert.deepEqual(s.jobs[0].files, [], "the first handoff was read-only");
assert.equal(s.jobs[1].agent, "grok"); assert.equal(s.jobs[1].status, "accepted"); assert.equal(s.jobs[1].summary, "added b");
const out = fs.readFileSync(path.join(root, "brain.out"), "utf8");
assert.match(out, /refused-busy/, "two jobs never share files"); assert.match(out, /overlap job 2/);
assert.match(out, /refused-copilot/, "an agent near its limit is never tasked");
const w = JSON.parse(fs.readFileSync(path.join(root, "wait.json"), "utf8"));
assert.equal(w.review.id, 1); assert.deepEqual(w.review.changedFiles, [], "a read-only job changes nothing");
const w2 = JSON.parse(fs.readFileSync(path.join(root, "wait2.json"), "utf8"));
assert.equal(w2.review.id, 2); assert.deepEqual(w2.review.changedFiles, ["b.txt"]);
const args = fs.readFileSync(path.join(root, "claude-args"), "utf8");
assert.match(args, /--model opus/); assert.match(args, /--dangerously-skip-permissions/); assert.match(args, /--session-id/);
assert.match(s.goal.report, /Report: b added/);
const kinds = s.log.map((l) => l.kind);
assert.equal(kinds[0], "goal"); assert.equal(kinds.at(-1), "report");
assert.equal(kinds.filter((k) => k === "handoff").length, 2, "two handoffs: investigate, then fix");
assert.equal(kinds.filter((k) => k === "returned").length, 2);
assert.equal(kinds.filter((k) => k === "review").length, 2);
assert.match(fs.readFileSync(path.join(repo, ".git/info/exclude"), "utf8"), /^\.constance\/$/m, "done files are never committed");
assert.equal(git("status", "--porcelain").trim(), "", "the repo is clean afterwards");

// Stop: a running job and Constance halt at once. A fake claude that delegates then hangs.
fs.rmSync(path.join(root, "go"));
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash\nnode ${CLI} delegate --agent grok --files d.txt --task d >/dev/null 2>&1\nsleep 300\n`, { mode: 0o755 });
assert.equal(run("start", "--dir", repo, "--goal", "second").status, 0);
assert.ok(await until(() => status().jobs.some((j) => j.status === "running")), "the job runs");
const g = status().goal, job = status().jobs.find((j) => j.status === "running");
// A restart: the driver dies, recover brings it back on the same goal (and her session resumes).
process.kill(-g.driverPid, "SIGKILL");
await until(() => { try { process.kill(g.driverPid, 0); return false; } catch { return true; } }, 3000);
assert.equal(run("recover").stdout.trim(), "restarted");
assert.ok(await until(() => status().goal.driverPid !== g.driverPid), "a new driver picks the goal up");
assert.equal(run("stop").status, 0);
const after = status();
assert.equal(after.goal.status, "stopped"); assert.equal(after.jobs.find((j) => j.id === job.id).status, "stopped");
assert.ok(await until(() => { try { process.kill(job.pid, 0); return false; } catch { return true; } }, 5000), "the agent process is gone");
assert.ok(await until(() => { try { process.kill(g.brainPid, 0); return false; } catch { return true; } }, 5000), "Constance is gone");
assert.match(run("delegate", "--agent", "grok", "--files", "e", "--task", "e").stderr, /No goal is running/, "nothing is handed out after Stop");
assert.equal(run("recover").stdout.trim(), "ok", "a stopped goal stays stopped");

// Her own limit: at 90% of the session the driver pauses instead of starting her.
writeData(0.92);
assert.equal(run("start", "--dir", repo, "--goal", "third").status, 0);
assert.ok(await until(() => status().goal.status === "paused"), "paused at her own limit");
assert.match(status().goal.pauseReason, /Session at 92%/);
run("stop");
fs.rmSync(root, { recursive: true, force: true });
console.log("constance: tests passed");
