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
// Practice mode is on by default; this first goal runs for real, so switch it off for now.
fs.writeFileSync(path.join(tabs, "settings.json"), JSON.stringify({ constancePractice: false }));
// Fake grok: the done file path is in the prompt (last argument). Waits for a go-file so the test can
// look at a running job. A read-only job only reports; an editing job writes the file named in
// "Only edit these files: X." and commits it — except "add g", which also leaves a stray file.
fs.writeFileSync(path.join(bin, "grok"), `#!/bin/bash
p="\${@: -1}"; f=$(grep -o '/[^ ]*/.constance/done-[0-9]*.json' <<<"$p" | head -1)
while [[ ! -e "${root}/go" ]]; do sleep 0.2; done
if grep -qi "read-only job" <<<"$p"; then
  echo '{"summary": "cause: a.txt has no b", "commit": "", "files": []}' > "$f"
elif grep -q "add g" <<<"$p"; then
  sleep 1
  echo g > g.txt; git add g.txt; git commit -qm "grok: g"; echo stray > evil.txt
  echo "{\\"summary\\": \\"added g and left a stray\\", \\"commit\\": \\"$(git rev-parse HEAD)\\", \\"files\\": [\\"g.txt\\"]}" > "$f"
else
  sleep 1
  name=$(sed -n 's/^Only edit these files: \\([^ ,]*\\)\\..*/\\1/p' <<<"$p" | head -1); name=\${name:-b.txt}
  before=$(git rev-parse HEAD)
  echo x > "$name"; git add "$name"; git commit -qm "grok: $name" || true
  after=$(git rev-parse HEAD); c=""; [[ "$after" != "$before" ]] && c="$after"
  echo "{\\"summary\\": \\"added \${name%.*}\\", \\"commit\\": \\"$c\\", \\"files\\": [\\"$name\\"]}" > "$f"
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

// Practice mode (the panel switch, on by default): she plans and delegates as usual, but nothing
// launches and nothing changes — each handoff lands in the log with the agent, the reason and the
// full prompt, and the job is born finished so she can still review it.
fs.writeFileSync(path.join(tabs, "settings.json"), JSON.stringify({ constancePractice: true }));
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
C="node ${CLI}"
$C delegate --agent grok --files z.txt --task "add z" >> "${root}/practice.out" 2>&1
$C delegate --agent grok --task "summarize a.txt in a few lines" >> "${root}/practice.out" 2>&1
$C wait --timeout 30 > "${root}/practice-wait.json"
$C review 4 accept --note "fine"
$C wait --timeout 30 > "${root}/practice-wait2.json"
$C review 5 accept --note "fine"
echo "Practice report: two pieces planned, nothing launched."
`, { mode: 0o755 });
writeData();
assert.equal(run("start", "--dir", repo, "--goal", "practice goal").status, 0);
assert.ok(await until(() => status().goal && status().goal.status === "done"), "the practice goal finishes: " + JSON.stringify(status().goal));
{
  const ps = status();
  assert.equal(ps.practice, true, "status reports practice mode");
  assert.equal(ps.jobs.length, 2);
  assert.ok(ps.jobs.every((j) => j.status === "accepted" && /practice run/.test(j.summary)), "practice jobs are born finished and reviewed");
  assert.deepEqual(ps.jobs.map((j) => j.files), [["z.txt"], []], "one editing and one read-only handoff");
  const plogs = ps.log.filter((l) => l.kind === "practice");
  assert.equal(plogs.length, 2, "every handoff prompt is logged");
  assert.equal(plogs[0].agent, "grok");
  assert.match(plogs[0].reason, /under its limits/, "the log says why she picked that agent");
  assert.ok(plogs[0].prompt.includes("Check:") && plogs[0].prompt.includes("done-"), "the full prompt is in the log");
  assert.equal(plogs[1].agent, "grok"); assert.deepEqual(plogs[1].files, []);
  assert.ok(!fs.existsSync(path.join(repo, "z.txt")), "practice launched nothing");
  assert.equal(git("status", "--porcelain").trim(), "", "practice changed no files");
  assert.match(ps.goal.report, /Practice report/);
}

// Model fallback: Opus isn't allowed on this plan, so she drops to Sonnet, says so in the log and
// starts the goal over on the new model instead of failing.
fs.writeFileSync(path.join(tabs, "settings.json"), JSON.stringify({ constancePractice: false }));
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
if [[ "$*" == *"--model opus"* && "$*" == *"fallback goal"* ]]; then
  echo "There's an issue with the selected model (opus). It may not exist or you may not have access to it." >&2
  exit 1
fi
echo "$@" > "${root}/claude-args-fallback"
C="node ${CLI}"
$C delegate --agent grok --files f.txt --task "add f" >> "${root}/brain2.out" 2>&1
touch "${root}/go"
$C wait --timeout 30 > "${root}/wait-fallback.json"
$C review 6 accept --note "ok"
echo "Fallback report: done on sonnet."
`, { mode: 0o755 });
assert.equal(run("start", "--dir", repo, "--goal", "fallback goal").status, 0);
assert.ok(await until(() => status().goal && status().goal.status === "done"), "the fallback goal finishes: " + JSON.stringify(status().goal));
{
  const fs2 = status();
  assert.equal(fs2.goal.model, "sonnet", "she dropped to the best allowed model");
  const mlog = fs2.log.find((l) => l.kind === "model");
  assert.ok(mlog && /Opus/.test(mlog.text) && /Sonnet/.test(mlog.text), "the switch is in the log: " + JSON.stringify(mlog));
  assert.match(fs.readFileSync(path.join(root, "claude-args-fallback"), "utf8"), /--model sonnet/, "the retry ran on sonnet");
  assert.match(fs2.goal.report, /Fallback report/);
  assert.equal(fs2.jobs.find((j) => j.id === 6).status, "accepted", "the delegated job still ran and was reviewed");
}

// Learning layer + guardrails: the lessons file seeded itself, every handoff
// prompt carries the project rules and the guardrail block, and a run that
// leaves a stray file is caught after it finishes — restored, lesson logged,
// strike counted, and the agent is capped to smaller tasks.
fs.mkdirSync(path.join(repo, ".constance"), { recursive: true });
fs.writeFileSync(path.join(repo, ".constance", "rules.md"), "Never touch generated files.\n");
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
echo "$@" > "${root}/claude-args-guard"
C="node ${CLI}"
$C delegate --agent grok --files g.txt --task "add g" >> "${root}/guard.out" 2>&1
touch "${root}/go"
$C wait --timeout 30 > "${root}/wait-guard.json"
$C review 7 accept --note "ok despite the stray"
$C delegate --agent grok --files a.txt,b.txt,c.txt,d.txt --task "too big" >> "${root}/guard.out" 2>&1 || echo "refused-cap" >> "${root}/guard.out"
$C lesson "always check for stray files before reporting" >> "${root}/guard.out" 2>&1
echo "Guard report: one violation caught."
`, { mode: 0o755 });
assert.equal(run("start", "--dir", repo, "--goal", "guard goal").status, 0);
assert.ok(await until(() => status().goal && status().goal.status === "done"), "the guard goal finishes: " + JSON.stringify(status().goal));
{
  const gs = status();
  const job7 = gs.jobs.find((j) => j.id === 7);
  assert.ok(job7, "job 7 exists");
  assert.ok(Array.isArray(job7.guardViolation) && job7.guardViolation.some((v) => v.includes("evil.txt")), "the stray file is flagged: " + JSON.stringify(job7.guardViolation));
  assert.equal(gs.guards.grok.strikes, 1, "one strike counted");
  assert.equal(job7.status, "accepted", "she still reviewed and accepted it");
  assert.ok(!fs.existsSync(path.join(repo, "evil.txt")), "the stray file was cleaned up");
  assert.ok(fs.existsSync(path.join(repo, "g.txt")), "the allowed commit was left alone");
  assert.match(fs.readFileSync(path.join(root, "guard.out"), "utf8"), /refused-cap/, "a 4-file job is refused after one strike");
  const kinds = gs.log.map((l) => l.kind);
  assert.ok(kinds.includes("guard"), "a guard event is in the log");
  assert.ok(kinds.includes("lesson"), "the lesson command logged");
  // The handoff prompt carried the project rules and the guardrail block.
  const stored = JSON.parse(fs.readFileSync(path.join(tabs, "constance", "jobs.json"), "utf8"));
  const p7 = stored.jobs.find((j) => j.id === 7).prompt;
  assert.match(p7, /Never touch generated files/, "project rules are in the handoff");
  assert.match(p7, /Guardrails:/, "guardrails are in the handoff");
  assert.match(p7, /rm -rf/, "the hard bans are in the handoff");
  assert.match(p7, /g\.txt/, "the allowed-files list names g.txt");
  // Lessons: seeded file exists, the violation lesson was appended, her own too.
  const lessons = JSON.parse(fs.readFileSync(path.join(tabs, "constance", "lessons.json"), "utf8")).lessons;
  assert.ok(lessons.length >= 9, "seeded lessons are there");
  assert.ok(lessons.some((l) => l.includes("broke a guardrail")), "the violation became a lesson");
  assert.ok(lessons.includes("always check for stray files before reporting"), "her lesson command worked");
  // Her first message carried the lessons and the project rules.
  assert.match(fs.readFileSync(path.join(root, "claude-args-guard"), "utf8"), /Lessons from your earlier goals/);
  assert.match(fs.readFileSync(path.join(root, "claude-args-guard"), "utf8"), /Never touch generated files/);
}

// The ready queue for real: she queues two tasks while planning, accepts the
// running job, and the next queued task is handed to the same agent by itself —
// twice — until the queue is empty. `queue rm` drops one first.
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
C="node ${CLI}"
$C queue --task "add h" --files h.txt >> "${root}/queue.out" 2>&1
$C queue --task "add i" --files i.txt >> "${root}/queue.out" 2>&1
$C queue --task "add j" --files j.txt >> "${root}/queue.out" 2>&1
$C queue rm 3 >> "${root}/queue.out" 2>&1
$C queue >> "${root}/queue.out" 2>&1
$C delegate --agent grok --files q.txt --task "add q" >> "${root}/queue.out" 2>&1
touch "${root}/go"
$C wait --timeout 30 > "${root}/wait-q1.json"
$C review 8 accept --note "q ok" > "${root}/review-q1.txt" 2>&1
$C wait --timeout 30 > "${root}/wait-q2.json"
$C review 9 accept --note "h ok" > "${root}/review-q2.txt" 2>&1
$C wait --timeout 30 > "${root}/wait-q3.json"
$C review 10 accept --note "i ok" > "${root}/review-q3.txt" 2>&1
echo "Queue report: q, h and i all done."
`, { mode: 0o755 });
assert.equal(run("start", "--dir", repo, "--goal", "queue goal").status, 0);
assert.ok(await until(() => status().goal && status().goal.status === "done"), "the queue goal finishes: " + JSON.stringify(status().goal));
{
  const qs = status();
  const byId = Object.fromEntries(qs.jobs.map((j) => [j.id, j]));
  assert.equal(byId[8].task, "add q"); assert.equal(byId[8].status, "accepted");
  assert.equal(byId[9].task, "add h"); assert.equal(byId[9].agent, "grok", "the queued task went to the same agent");
  assert.equal(byId[9].status, "accepted");
  assert.equal(byId[10].task, "add i"); assert.equal(byId[10].status, "accepted");
  assert.equal(qs.jobs.length, 3, "exactly three jobs: the delegate plus two auto-handed");
  const qout = fs.readFileSync(path.join(root, "queue.out"), "utf8");
  assert.match(qout, /Queued as task 1/, "first queued task got id 1");
  assert.match(qout, /removed/, "queue rm worked");
  assert.match(qout, /1\. add h[\s\S]*2\. add i/, "the queue listing shows the pending tasks");
  assert.doesNotMatch(qout, /add j/, "the removed task is gone");
  assert.match(fs.readFileSync(path.join(root, "review-q1.txt"), "utf8"), /Next queued task went to grok as job 9/);
  assert.match(fs.readFileSync(path.join(root, "review-q2.txt"), "utf8"), /Next queued task went to grok as job 10/);
  assert.match(fs.readFileSync(path.join(root, "review-q3.txt"), "utf8"), /Job 10 accepted\.(\s|$)/, "nothing left queued after the last accept");
  const w1 = JSON.parse(fs.readFileSync(path.join(root, "wait-q1.json"), "utf8"));
  assert.equal(w1.review.queue.length, 2, "wait showed the two pending tasks");
  assert.deepEqual(w1.review.queue.map((t) => t.task), ["add h", "add i"]);
  assert.equal(qs.queue.length, 0, "status reports an empty queue once all are handed");
  for (const f of ["q.txt", "h.txt", "i.txt"]) assert.ok(fs.existsSync(path.join(repo, f)), f + " exists");
  assert.equal(git("status", "--porcelain").trim(), "", "the repo is clean: every auto-handed job stayed in its files");
  const qlog = qs.log.filter((l) => /Ready queue/.test(l.text || ""));
  assert.ok(qlog.length >= 3, "queue events are in the log: " + qlog.length);
}

// The watcher: a fake busctl feeds it real-format Notify blocks. With no job
// running for the named agent, the notification is logged as the owner's own —
// noted and left alone — and `signals` shows it.
fs.writeFileSync(path.join(root, "notify-fixture.txt"), `‣ Type=method_call  Endian=l  Flags=0  Version=1 Cookie=1  Timestamp="x"
  Sender=:1.1  Destination=:1.2  Path=/org/freedesktop/Notifications  Interface=org.freedesktop.Notifications  Member=Notify
  UniqueName=:1.1
  MESSAGE "susssasa{sv}i" {
          STRING "Devin";
          UINT32 0;
          STRING "";
          STRING "Devin finished";
          STRING "the task is done";
          ARRAY "s" {
          };
          ARRAY "{sv}" {
          };
          INT32 -1;
  };
`);
fs.writeFileSync(path.join(bin, "busctl"), `#!/bin/bash\ncat "${root}/notify-fixture.txt"\nsleep 30\n`, { mode: 0o755 });
// Kill any real watcher the goals spawned, then start ours against the fake bus.
{
  const wp = path.join(tabs, "constance", "watcher.pid");
  try { const pid = Number(fs.readFileSync(wp, "utf8")); process.kill(pid, "SIGKILL"); } catch {}
  try { fs.rmSync(wp); } catch {}
}
const { spawn } = await import("node:child_process");
const watcher = spawn("node", [CLI, "watch"], { env, stdio: "ignore" });
const notifyJsonl = path.join(tabs, "constance", "notify.jsonl");
assert.ok(await until(() => { try { return fs.readFileSync(notifyJsonl, "utf8").includes("Devin finished"); } catch { return false; } }, 10000), "the watcher recorded the notification");
watcher.kill("SIGKILL");
{
  const sig = JSON.parse(run("signals").stdout);
  const mine = sig.find((s) => s.agent === "devin" && s.summary === "Devin finished");
  assert.ok(mine, "the fake notification was recorded: " + JSON.stringify(sig));
  assert.equal(mine.kind, "foreign", "no job of hers -> the owner's own agent");
  const slog = status().log.filter((l) => l.kind === "signal").find((l) => /Devin finished/.test(l.text || ""));
  assert.ok(slog && /left alone/.test(slog.text), "the signal is in her log: " + JSON.stringify(slog));
}
fs.rmSync(root, { recursive: true, force: true });
console.log("constance: tests passed");
