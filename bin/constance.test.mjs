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
// Jobs run sandboxed, where /tmp is a fresh folder per job: the fake agents and the go-file live in
// /var/tmp (or ~/.cache where /var/tmp is read-only), which the sandbox shows read-only — the repo
// itself is the job's writable project.
let root = "";
for (const base of ["/var/tmp", path.join(os.homedir(), ".cache")]) {
  try { fs.mkdirSync(base, { recursive: true }); root = fs.mkdtempSync(path.join(base, "constance-e2e-")); break; } catch {}
}
if (!root) root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-e2e-"));
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
  { id: "devin", name: "Devin", installed: true, signedIn: true, limits: [{ title: "Daily", percent: 0.1 }] },
  { id: "copilot", installed: true, signedIn: true, limits: [{ title: "Monthly", percent: 0.94 }] }] }));
writeData();
// Practice mode is on by default; this first goal runs for real, so switch it off for now.
fs.writeFileSync(path.join(tabs, "settings.json"), JSON.stringify({ constancePractice: false }));
// Fake grok: the done file path is in the prompt (last argument). Waits for a go-file so the test can
// look at a running job. A read-only job only reports; an editing job writes the file named in
// "Only edit these files: X." and commits it — except "add g", which also leaves a stray file.
fs.writeFileSync(path.join(bin, "grok"), `#!/bin/bash
p="\${@: -1}"; f=$(grep -o '/[^ ]*/.constance/done-[0-9]*.json' <<<"$p" | head -1)
[[ -e "${root}/home/home-marker" ]] && echo "sandboxed=no" || echo "sandboxed=yes"
grep -q "stray-now" <<<"$p" && echo stray > stray-now.txt
while [[ ! -e "${root}/go" ]]; do sleep 0.2; done
if grep -q "exit now" <<<"$p"; then
  exit 0
elif grep -qi "read-only job" <<<"$p"; then
  echo '{"summary": "cause: a.txt has no b", "commit": "", "files": []}' > "$f"
elif grep -q "sneaky commit" <<<"$p"; then
  sleep 1
  echo s > sneaky.txt; git add sneaky.txt; git commit -qm "grok: sneaky"
  echo '{"summary": "committed outside its list and reported nothing", "commit": "", "files": []}' > "$f"
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
// Fake devin: same shape as fake grok, but it runs in its own worktree — the done
// file path and the file it edits both come out of the prompt, and it commits on
// whatever branch the worktree gave it. Like a careful real agent it runs the
// prompt's pwd check first: if the folder the prompt names isn't where it was
// started, or the done file isn't inside that folder, it stops and writes nothing
// (the job then ends as "exited without writing its done file").
fs.writeFileSync(path.join(bin, "devin"), `#!/bin/bash
p="\${@: -1}"; f=$(grep -o '/[^ ]*/.constance/done-[0-9]*.json' <<<"$p" | head -1)
want=$(grep -o 'if it is not exactly [^ ]*, stop now' <<<"$p" | head -1 | sed 's/^if it is not exactly //; s/, stop now$//')
here=$(pwd)
[[ -n "$want" && "$here" == "$want" ]] || { echo "pwd check failed: here=$here want=$want"; exit 1; }
# Its done file goes in its own sandbox tmp (/tmp), never the worktree: workers can't write .constance/.
[[ "$f" == "/tmp/.constance/"* ]] || { echo "done file $f is not in the sandbox tmp"; exit 1; }
while [[ ! -e "${root}/go" ]]; do sleep 0.2; done
name=$(sed -n 's/^Only edit these files: \\([^ ,]*\\)\\..*/\\1/p' <<<"$p" | head -1); name=\${name:-x.txt}
before=$(git rev-parse HEAD)
echo "devin $name" > "$name"; git add "$name"; git commit -qm "devin: $name" || true
if grep -q "sneaky copy" <<<"$p"; then echo cover > cover.txt; git add cover.txt; git commit -qm "devin: cover outside its list" || true; fi
after=$(git rev-parse HEAD); c=""; [[ "$after" != "$before" ]] && c="$after"
# The "selfmerge" marker makes it report its tests passed, so the job can self-merge.
t=""; grep -q selfmerge <<<"$p" && t=', "tests": "pass"'
echo "{\\"summary\\": \\"added \${name%.*} in $here\\", \\"commit\\": \\"$c\\", \\"files\\": [\\"$name\\"]$t}" > "$f"
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
$C delegate --agent grok --files .constance/rules.md --task "edit the rules" >> "${root}/brain.out" 2>&1 || echo "refused-constance" >> "${root}/brain.out"
touch "${root}/go"
$C wait --timeout 30 > "${root}/wait.json"
$C review 1 accept --note "cause confirmed"
$C wait --timeout 30 > "${root}/wait2.json"
$C review 2 accept --note "looks right"
echo "Report: b added by grok."
`, { mode: 0o755 });
// A fake home and projects folder: the guard snapshots HOME and ~/Projects, and the tests must
// never read or touch the real ones. A quiet fake busctl from the start, so no goal's watcher
// ever listens to the real session bus (the owner's own notifications).
const fakeHome = path.join(root, "home"); fs.mkdirSync(path.join(fakeHome, "Projects"), { recursive: true });
fs.writeFileSync(path.join(bin, "busctl"), "#!/bin/bash\nsleep 30\n", { mode: 0o755 });
// A fake notify-send: "she stops the queue and tells me" must never pop a real notification in a test.
fs.writeFileSync(path.join(bin, "notify-send"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${root}/notified.txt"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(fakeHome, "home-marker"), "the real (fake) home is visible\n");
// A fake /proc for the copy ramp: a calm machine by default (the busy one is set
// for the held-copy test), and no gap between copy starts so tests stay quick.
const proc = path.join(root, "proc"); fs.mkdirSync(proc);
const setLoad = (load) => fs.writeFileSync(path.join(proc, "loadavg"), `${load} 0.50 0.50 1/500 999\n`);
setLoad("0.10");
// Copies are held on low memory only (load no longer matters — constance-ramp.mjs).
const setMem = (availKb) => fs.writeFileSync(path.join(proc, "meminfo"), `MemTotal:       33554432 kB\nMemFree:        ${availKb} kB\nMemAvailable:   ${availKb} kB\n`);
setMem(20971520);
// Copy worktrees go in this test's own folder (removed with root), never the real
// /var/tmp/constance-worktrees, where a real Constance run may have copies going.
const worktrees = path.join(root, "worktrees");
const env = { ...process.env, CONSTANCE_WORKTREES: worktrees, HOME: fakeHome, SQUAD_PROJECTS: path.join(fakeHome, "Projects"), XDG_STATE_HOME: state, PATH: `${bin}:${process.env.PATH}`, CONSTANCE_PROC: proc, CONSTANCE_RAMP_GAP_MS: "0", CONSTANCE_TOKENS_GAP_MS: "500", XDG_DATA_HOME: path.join(fakeHome, ".local", "share") };
const run = (...a) => spawnSync("node", [CLI, ...a], { env, encoding: "utf8" });
const status = () => JSON.parse(run("status").stdout);
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };

assert.match(run("start", "--dir", repo, "--goal", "").stderr, /goal first/);
// Never the home folder itself (the panel's fallback when no folder is picked).
{
  const r = run("start", "--dir", fakeHome, "--goal", "tidy up");
  assert.notEqual(r.status, 0); assert.match(r.stderr, /never works in your home folder/);
  assert.notEqual(run("start", "--dir", root, "--goal", "tidy up").status, 0, "nor anything above it");
  assert.equal(status().goal, null, "no goal was started");
}
assert.equal(run("start", "--dir", repo, "--goal", "add b").status, 0);
assert.match(run("start", "--dir", repo, "--goal", "other").stderr, /already on a goal/, "one goal at a time");
assert.ok(await until(() => status().goal.status === "done"), "the goal finishes: " + JSON.stringify(status().goal));
const s = status();
assert.equal(s.jobs.length, 2);
assert.equal(s.jobs[0].agent, "grok"); assert.equal(s.jobs[0].status, "accepted");
assert.equal(s.jobs[0].summary, "cause: a.txt has no b"); assert.deepEqual(s.jobs[0].files, [], "the first handoff was read-only");
assert.equal(s.jobs[1].agent, "grok"); assert.equal(s.jobs[1].status, "accepted"); assert.equal(s.jobs[1].summary, "added b");
const out = fs.readFileSync(path.join(root, "brain.out"), "utf8");
// Every job ran inside the sandbox: its home was empty, so the marker in the owner's home wasn't there.
assert.match(fs.readFileSync(s.jobs[1].log, "utf8"), /sandboxed=yes/, "the job ran sandboxed");
assert.match(out, /refused-busy/, "two jobs never share files"); assert.match(out, /overlap job 2/);
assert.match(out, /refused-copilot/, "an agent near its limit is never tasked");
assert.match(out, /refused-constance/, "no worker is ever given a .constance/ file (finding 3)");
assert.match(out, /Only Constance writes \.constance\/rules\.md/);
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
// Token meter: before Grok records anything the worker is "can't tell"; once its session (in the
// project folder, started during the job) is in Grok's usage records, the background rescan
// matches it and status shows the count, live.
{
  const t0 = status().tokens;
  assert.deepEqual(t0.workers.map((w) => w.text), ["Grok  can't tell"], "no session yet: can't tell, never a guess");
  const sess = path.join(fakeHome, ".grok", "sessions", "ws", "grok-e2e");
  fs.mkdirSync(sess, { recursive: true });
  fs.writeFileSync(path.join(sess, "summary.json"), JSON.stringify({ info: { cwd: repo } }));
  fs.writeFileSync(path.join(sess, "usage.json"), JSON.stringify({ sessionId: "grok-e2e", turns: [
    { endedAt: new Date().toISOString(), modelUsage: { m: { inputTokens: 1000, cachedReadTokens: 0, outputTokens: 234, cacheCreationTokens: 0 } } }] }));
  assert.ok(await until(() => status().tokens.workers[0]?.tokens === 1234, 15000), "the running worker's tokens show: " + JSON.stringify(status().tokens));
  const t1 = status().tokens;
  assert.equal(t1.workers[0].text, "Grok  1.2K tokens");
  assert.match(t1.line, /^This goal 1\.2K \(Grok 1\.2K\) · Today /);
}
// A restart: the driver dies, recover brings it back on the same goal (and her session resumes).
process.kill(-g.driverPid, "SIGKILL");
await until(() => { try { process.kill(g.driverPid, 0); return false; } catch { return true; } }, 3000);
assert.equal(run("recover").stdout.trim(), "restarted");
assert.ok(await until(() => status().goal.driverPid !== g.driverPid), "a new driver picks the goal up");
assert.equal(run("stop").status, 0);
const after = status();
assert.equal(after.goal.status, "stopped"); assert.equal(after.jobs.find((j) => j.id === job.id).status, "stopped");
assert.equal(after.jobs.find((j) => j.id === job.id).tokens.n, 1234, "a stopped worker keeps its count");
assert.deepEqual(after.tokens.workers, [], "no worker lines once nothing runs");
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
  assert.ok(!ps.goal.nudges, "practice mode never nudges an unfinished goal");
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

// Claude's own "hit your limit" exit is a pause until the time it states, never a failure:
// wall.json is written, the goal waits paused (the reading in data.json looks fine, and
// still can't resume her), and nothing counts as a failed run.
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
echo run >> "${root}/limit-runs"
echo "You've hit your 5-hour limit · resets 5:50pm (America/New_York)"
exit 1
`, { mode: 0o755 });
assert.equal(run("start", "--dir", repo, "--goal", "limit goal").status, 0);
const wallPath = path.join(tabs, "constance", "wall.json");
assert.ok(await until(() => fs.existsSync(wallPath) && status().goal.status === "paused"), "a limit exit pauses the goal: " + JSON.stringify(status().goal));
{
  const ls = status();
  const wall = JSON.parse(fs.readFileSync(wallPath, "utf8"));
  assert.equal(wall.stated, true); assert.ok(wall.until > Date.now(), "until the stated reset time");
  assert.match(ls.goal.pauseReason, /hit its limit/);
  assert.equal(ls.pace.mode, "stop", "pace honors the wall over a low reading"); assert.equal(ls.pace.hard, true);
  assert.ok(!ls.log.some((l) => l.kind === "failed" && l.at > wall.at - 5000), "no failure logged");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(fs.readFileSync(path.join(root, "limit-runs"), "utf8").trim().split("\n").length, 1, "no retries into the wall");
}
assert.equal(run("stop").status, 0);
fs.rmSync(wallPath);

// Learning layer + guardrails: the lessons file seeded itself, every handoff
// prompt carries the project rules and the guardrail block, and a run that
// leaves a stray file is caught after it finishes — restored, lesson logged,
// strike counted, and the agent is capped to smaller tasks.
fs.mkdirSync(path.join(repo, ".constance"), { recursive: true });
fs.writeFileSync(path.join(repo, ".constance", "rules.md"), "Never touch generated files.\n");
// The owner's own uncommitted note, there before the run: never flagged, never touched.
fs.writeFileSync(path.join(repo, "owner-notes.txt"), "mine\n");
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
  assert.ok(fs.existsSync(path.join(repo, "evil.txt")), "the guard never deletes: the stray file is left for the owner");
  assert.ok(!job7.guardViolation.some((v) => v.includes("owner-notes.txt")), "the owner's earlier work is not blamed on the agent");
  assert.equal(fs.readFileSync(path.join(repo, "owner-notes.txt"), "utf8"), "mine\n", "the owner's file is untouched");
  assert.ok(gs.log.some((l) => l.kind === "guard" && /left in place for you to check: evil\.txt/.test(l.text)), "the log says what was left in place");
  assert.ok(fs.existsSync(path.join(repo, "g.txt")), "the allowed commit was left alone");
  fs.rmSync(path.join(repo, "evil.txt")); fs.rmSync(path.join(repo, "owner-notes.txt"));
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

// Practice with a Devin copy: the logged prompt is the one a real copy would get —
// its own worktree under the worktree root for the pwd check and the done file,
// not the main folder — yet no worktree or branch is created.
fs.writeFileSync(path.join(tabs, "settings.json"), JSON.stringify({ constancePractice: true }));
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
C="node ${CLI}"
$C delegate --agent devin --files p1.txt --task "add p1" >> "${root}/practice-copy.out" 2>&1
$C wait --timeout 30 > "${root}/practice-copy-wait.json"
id=$(grep -o '"id": [0-9]*' "${root}/practice-copy-wait.json" | head -1 | grep -o '[0-9]*')
$C review "$id" accept --note "fine"
echo "Practice copy report."
`, { mode: 0o755 });
writeData();
assert.equal(run("start", "--dir", repo, "--goal", "practice copy goal").status, 0);
assert.ok(await until(() => status().goal && status().goal.status === "done"), "the practice copy goal finishes: " + JSON.stringify(status().goal));
{
  const ps = status();
  const pl = ps.log.filter((l) => l.kind === "practice" && l.agent === "devin").pop();
  assert.ok(pl, "the devin handoff is logged");
  const wt = path.join(worktrees, `job-${pl.job}`);
  assert.equal(pl.worktree, wt, "the log names the would-be worktree");
  assert.ok(pl.prompt.includes(`if it is not exactly ${wt}, stop now`), "the pwd check names the worktree: " + pl.prompt);
  assert.ok(pl.prompt.includes(`write the file /tmp/.constance/done-${pl.job}.json`), "the done file is in the sandbox tmp, not the worktree");
  assert.ok(!pl.prompt.includes(`${wt}/.constance/`), "never in the worktree");
  assert.ok(!pl.prompt.includes(`not exactly ${repo},`), "never the main folder for the pwd check");
  assert.ok(!fs.existsSync(wt), "practice created no worktree");
  assert.equal(git("branch", "--list", "constance/*").trim(), "", "practice created no branch");
  const pj = ps.jobs.find((j) => j.id === pl.job);
  assert.equal(pj.status, "accepted"); assert.ok(!pj.worktree && !pj.branch, "nothing for a merge to act on");
  assert.match(fs.readFileSync(path.join(root, "practice-copy.out"), "utf8"), new RegExp(`own worktree ${worktrees}/job-`));
  // Copy all: `log` prints the whole log as text, practice prompts in full.
  const lt = run("log").stdout;
  assert.ok(lt.includes(pl.prompt), "the full practice prompt is in the copied log");
  assert.ok(lt.includes(`(a real run works in ${wt} on constance/job-${pl.job})`));
  assert.ok(lt.indexOf("Goal") < lt.lastIndexOf("Practice job"), "oldest first");
}
fs.writeFileSync(path.join(tabs, "settings.json"), JSON.stringify({ constancePractice: false }));

// Devin copies: two editing jobs run at once, each in its own worktree/branch,
// tracked as Devin 1 and Devin 2. Both finish together; each is reviewed and
// merged one at a time, then the worktrees and branches are cleaned up.
fs.rmSync(path.join(root, "go"), { force: true });
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
C="node ${CLI}"
$C delegate --agent devin --files c1.txt --task "add c1" >> "${root}/copies.out" 2>&1
$C delegate --agent devin --files c2.txt --task "add c2" >> "${root}/copies.out" 2>&1
touch "${root}/go"
$C wait --timeout 30 > "${root}/wait-c1.json"
id1=$(grep -o '"id": [0-9]*' "${root}/wait-c1.json" | head -1 | grep -o '[0-9]*')
$C review "$id1" accept --note "c1 ok" > "${root}/rev-c1.txt" 2>&1
$C wait --timeout 30 > "${root}/wait-c2.json"
id2=$(grep -o '"id": [0-9]*' "${root}/wait-c2.json" | head -1 | grep -o '[0-9]*')
$C review "$id2" accept --note "c2 ok" > "${root}/rev-c2.txt" 2>&1
echo "Copies report: two Devins merged."
`, { mode: 0o755 });
writeData();
assert.equal(run("start", "--dir", repo, "--goal", "copies goal").status, 0);
assert.ok(await until(() => status().goal && status().goal.status === "done"), "the copies goal finishes: " + JSON.stringify(status().goal));
{
  const cs = status();
  const dj = cs.jobs.filter((j) => j.agent === "devin" && ["c1.txt", "c2.txt"].some((f) => j.files.includes(f)));
  assert.equal(dj.length, 2, "two devin jobs");
  assert.deepEqual(dj.map((j) => j.worker).sort(), ["Devin 1", "Devin 2"], "each copy is its own worker");
  assert.ok(dj.every((j) => j.status === "accepted"), "both copies accepted: " + JSON.stringify(dj.map((j) => [j.id, j.status])));
  for (const f of ["c1.txt", "c2.txt"]) assert.ok(fs.existsSync(path.join(repo, f)), f + " merged into the repo");
  // The fake Devin passed the pwd check in its own worktree and wrote the done file there,
  // and that is where she read it from (nothing landed in the main folder's .constance/).
  for (const j of dj) {
    assert.match(j.summary, new RegExp(`in ${worktrees}/job-${j.id}$`), "the copy worked in its worktree: " + j.summary);
    assert.ok(!fs.existsSync(path.join(repo, ".constance", `done-${j.id}.json`)), "no done file in the main folder");
  }
  assert.equal(git("branch", "--list", "constance/*").trim(), "", "copy branches are deleted after merge");
  assert.equal(git("worktree", "list", "--porcelain").split("worktree ").length - 1, 1, "only the main worktree remains");
  assert.ok(cs.log.some((l) => l.kind === "merge" && /merged constance\/job-/.test(l.text)), "the merges are in the log");
  assert.equal(git("status", "--porcelain").trim(), "", "the repo is clean after the merges");
}

// Merge conflict: the owner moves the main branch after the copies branched off
// but before review. Accepting the copy that touched the same file must stop and
// report — the merge is aborted, nothing is forced, the worktree/branch stay.
fs.rmSync(path.join(root, "go"), { force: true });
fs.rmSync(path.join(root, "owner-ok"), { force: true });
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
C="node ${CLI}"
p="\${@: -1}"
# A nudge resume (the goal can't tick past the merge conflict) just reports again.
[[ "$p" == *"goal is not finished"* ]] && { echo "Report: done."; exit 0; }
$C delegate --agent devin --files a.txt --task "change a" >> "${root}/conflict.out" 2>&1
$C delegate --agent devin --files b.txt --task "add b" >> "${root}/conflict.out" 2>&1
touch "${root}/go"
$C wait --timeout 30 > "${root}/wait-conf1.json"
while [[ ! -e "${root}/owner-ok" ]]; do sleep 0.2; done
id1=$(grep -o '"id": [0-9]*' "${root}/wait-conf1.json" | head -1 | grep -o '[0-9]*')
$C review "$id1" accept --note "first" > "${root}/rev-conf1.txt" 2>&1
$C wait --timeout 30 > "${root}/wait-conf2.json"
id2=$(grep -o '"id": [0-9]*' "${root}/wait-conf2.json" | head -1 | grep -o '[0-9]*')
$C review "$id2" accept --note "second" > "${root}/rev-conf2.txt" 2>&1
echo "Conflict report: one merge stopped for the owner."
`, { mode: 0o755 });
writeData();
assert.equal(run("start", "--dir", repo, "--goal", "conflict goal").status, 0);
assert.ok(await until(() => status().jobs.some((j) => j.agent === "devin" && j.status === "finished")), "a devin copy finished");
// The owner commits a competing change to a.txt on the main branch before any review.
fs.writeFileSync(path.join(repo, "a.txt"), "owner\n"); git("add", "a.txt"); git("commit", "-qm", "owner changes a");
fs.writeFileSync(path.join(root, "owner-ok"), "go\n");
assert.ok(await until(() => status().goal && status().goal.status === "done"), "the conflict goal finishes: " + JSON.stringify(status().goal));
{
  const cs = status();
  const aJob = cs.jobs.find((j) => j.agent === "devin" && j.files.includes("a.txt") && j.goal === cs.goal.id);
  const bJob = cs.jobs.find((j) => j.agent === "devin" && j.files.includes("b.txt") && j.goal === cs.goal.id);
  assert.ok(aJob && bJob, "both conflict-goal jobs exist");
  assert.equal(aJob.status, "conflict", "the conflicting copy is marked, not forced: " + JSON.stringify(aJob));
  assert.equal(bJob.status, "accepted", "the clean copy still merges");
  assert.equal(aJob.worker, "Devin 1"); assert.equal(bJob.worker, "Devin 2");
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "owner\n", "the owner's a.txt won; the conflicted branch was not forced in");
  assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "devin b.txt\n", "the clean copy merged");
  assert.ok(fs.existsSync(aJob.worktree), "the conflicted worktree is left for the owner");
  assert.ok(git("branch", "--list", aJob.branch).trim().includes(aJob.branch), "the conflicted branch is kept");
  assert.equal(git("branch", "--list", bJob.branch).trim(), "", "the merged branch is deleted");
  assert.ok(!git("branch", "--list", bJob.branch).includes(bJob.branch));
  const revs = fs.readFileSync(path.join(root, "rev-conf1.txt"), "utf8") + fs.readFileSync(path.join(root, "rev-conf2.txt"), "utf8");
  assert.match(revs, /conflicted/, "the conflict was reported, not hidden");
  assert.ok(cs.log.some((l) => l.kind === "merge" && /conflict/.test(l.text)), "the merge conflict is in her log");
  // Clean up the conflicted worktree/branch the test deliberately left behind.
  git("worktree", "remove", "--force", aJob.worktree); git("branch", "-D", aJob.branch);
}

// Ten Devin copies at once (the published limit): ten editing jobs run side by
// side as Devin 1..10, an eleventh is refused, and all ten merge after review.
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
C="node ${CLI}"
for i in $(seq 1 11); do $C delegate --agent devin --files t$i.txt --task "add t$i" >> "${root}/ten.out" 2>&1 || echo "refused-$i" >> "${root}/ten.out"; done
$C jobs > "${root}/ten-jobs.json"
touch "${root}/go"
for i in $(seq 1 10); do
  $C wait --timeout 60 > "${root}/ten-wait.json"
  id=$(grep -o '"id": [0-9]*' "${root}/ten-wait.json" | head -1 | grep -o '[0-9]*')
  $C review "$id" accept --note ok >> "${root}/ten-rev.txt" 2>&1
done
echo "Ten report: ten Devins merged."
`, { mode: 0o755 });
fs.rmSync(path.join(root, "go"), { force: true });
writeData();
assert.equal(run("start", "--dir", repo, "--goal", "ten copies").status, 0);
assert.ok(await until(() => status().goal && status().goal.status === "done", 90000), "the ten-copies goal finishes: " + JSON.stringify(status().goal));
{
  const ten = JSON.parse(fs.readFileSync(path.join(root, "ten-jobs.json"), "utf8"));
  const live = ten.jobs.filter((j) => j.agent === "devin" && j.goal === status().goal.id && ["running", "waiting"].includes(j.status));
  assert.equal(live.length, 10, "ten copies run at the same time: " + JSON.stringify(ten.jobs.map((j) => [j.id, j.worker, j.status])));
  assert.deepEqual(live.map((j) => j.worker).sort(), Array.from({ length: 10 }, (_, i) => `Devin ${i + 1}`).sort(), "Devin 1..10");
  assert.deepEqual(ten.copies.find((c) => c.agent === "devin"), { agent: "devin", limit: 10, running: 10, held: 0, heldReason: "" }, "jobs reports the copy count");
  const outTen = fs.readFileSync(path.join(root, "ten.out"), "utf8");
  assert.match(outTen, /already has 10 copies running or held/, "an eleventh copy is refused");
  assert.match(outTen, /refused-11/); assert.doesNotMatch(outTen, /refused-([1-9]|10)\n/);
  const cs = status();
  const dj = cs.jobs.filter((j) => j.agent === "devin" && j.goal === cs.goal.id);
  assert.equal(dj.length, 10); assert.ok(dj.every((j) => j.status === "accepted"), "all ten accepted: " + JSON.stringify(dj.map((j) => [j.id, j.status])));
  for (let i = 1; i <= 10; i++) assert.ok(fs.existsSync(path.join(repo, `t${i}.txt`)), `t${i}.txt merged`);
  assert.equal(git("branch", "--list", "constance/*").trim(), "", "all ten branches cleaned up");
}

// A held copy: the machine is low on memory, so the copy is held (its files
// reserved, the reason shown), and it starts by itself once memory frees up.
setMem(1024 * 1024);
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
C="node ${CLI}"
$C delegate --agent devin --files h1.txt --task "add h1" > "${root}/held.out" 2>&1
$C delegate --agent grok --files h1.txt --task "same file" >> "${root}/held.out" 2>&1 || echo "refused-held-files" >> "${root}/held.out"
$C wait --timeout 60 > "${root}/held-wait.json"
id=$(grep -o '"id": [0-9]*' "${root}/held-wait.json" | head -1 | grep -o '[0-9]*')
$C review "$id" accept --note ok > "${root}/held-rev.txt" 2>&1
echo "Held report: h1 added after the machine calmed down."
`, { mode: 0o755 });
writeData();
assert.equal(run("start", "--dir", repo, "--goal", "held copy").status, 0);
assert.ok(await until(() => { try { return fs.readFileSync(path.join(root, "held.out"), "utf8").includes("refused-held-files"); } catch { return false; } }), "both delegates ran");
{
  const outHeld = fs.readFileSync(path.join(root, "held.out"), "utf8");
  assert.match(outHeld, /is held: low memory: 1\.0 GiB free/, "the delegate says it is held and why");
  assert.match(outHeld, /overlap job/, "a held job's files stay reserved");
  const hs = status();
  const hj = hs.jobs.find((j) => j.goal === hs.goal.id && j.files.includes("h1.txt"));
  assert.equal(hj.status, "held"); assert.equal(hj.worker, "Devin 1"); assert.match(hj.heldReason, /low memory/);
  assert.equal(hj.pid, undefined, "nothing launched while held");
  const c = hs.copies.find((x) => x.agent === "devin");
  assert.equal(c.held, 1); assert.equal(c.running, 0); assert.match(c.heldReason, /low memory/, "the panel gets the count and the reason");
  assert.ok(hs.log.some((l) => l.kind === "held" && l.job === hj.id), "held is in her log");
}
setMem(20971520);
assert.ok(await until(() => status().goal.status === "done", 60000), "the held copy starts once the machine calms down, and the goal finishes: " + JSON.stringify(status().goal));
{
  const hs = status();
  const hj = hs.jobs.find((j) => j.goal === hs.goal.id && j.files.includes("h1.txt"));
  assert.equal(hj.status, "accepted"); assert.ok(fs.existsSync(path.join(repo, "h1.txt")), "h1 merged");
  assert.ok(hs.log.some((l) => l.kind === "handoff" && l.job === hj.id), "it was handed off once released");
}
// The owner's setting lowers the limit (and never raises it past 10).
fs.writeFileSync(path.join(tabs, "settings.json"), JSON.stringify({ constancePractice: false, constanceMaxCopies: 3 }));
assert.equal(status().copies.find((x) => x.agent === "devin").limit, 3, "constanceMaxCopies lowers the copy limit");
fs.writeFileSync(path.join(tabs, "settings.json"), JSON.stringify({ constancePractice: false, constanceMaxCopies: 40 }));
assert.equal(status().copies.find((x) => x.agent === "devin").limit, 10, "never above the published limit");
fs.writeFileSync(path.join(tabs, "settings.json"), JSON.stringify({ constancePractice: false }));
// Only this test's own copies: every worktree it made is in its own folder.
for (const w of fs.existsSync(worktrees) ? fs.readdirSync(worktrees) : []) { try { git("worktree", "remove", "--force", path.join(worktrees, w)); } catch {} }
git("worktree", "prune");
for (const b of git("branch", "--list", "constance/*", "--format=%(refname:short)").split("\n").filter(Boolean)) git("branch", "-D", b);

// Guard wiring, end to end: an agent that tries to commit a file outside its
// list can't (its git data is read-only, finding 1); the stray file is a
// violation, left in place and reported, and Constance never commits it; a
// folder the owner makes in the home folder while a job runs is only a
// guard-notice (no strike, no lesson); and a job that exits without its done
// file records an "exit" finish signal.
fs.rmSync(path.join(root, "go"), { force: true });
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
C="node ${CLI}"
$C delegate --agent grok --files ok1.txt --task "sneaky commit: also add ok1" >> "${root}/guard2.out" 2>&1
touch "${root}/go"
$C wait --timeout 30 > "${root}/wait-sneaky.json"
id1=$(grep -o '"id": [0-9]*' "${root}/wait-sneaky.json" | head -1 | grep -o '[0-9]*')
$C review "$id1" accept --note "ok" >> "${root}/guard2.out" 2>&1
$C delegate --agent grok --files nb.txt --task "add nb" >> "${root}/guard2.out" 2>&1
mkdir -p "${root}/home/owner-made-this"
$C wait --timeout 30 > "${root}/wait-nb.json"
id2=$(grep -o '"id": [0-9]*' "${root}/wait-nb.json" | head -1 | grep -o '[0-9]*')
$C review "$id2" accept --note "ok" >> "${root}/guard2.out" 2>&1
$C delegate --agent grok --task "exit now" >> "${root}/guard2.out" 2>&1
$C wait --timeout 30 > "${root}/wait-exit.json"
id3=$(grep -o '"id": [0-9]*' "${root}/wait-exit.json" | head -1 | grep -o '[0-9]*')
$C review "$id3" accept --note "ok" >> "${root}/guard2.out" 2>&1
echo "Guard2 report: all three checked."
`, { mode: 0o755 });
writeData();
assert.equal(run("start", "--dir", repo, "--goal", "guard wiring goal").status, 0);
assert.ok(await until(() => status().goal && status().goal.status === "done", 90000), "the guard wiring goal finishes: " + JSON.stringify(status().goal));
{
  const gs2 = status();
  const mine2 = gs2.jobs.filter((j) => j.goal === gs2.goal.id);
  const sneaky = mine2.find((j) => /sneaky commit/.test(j.task));
  const nb = mine2.find((j) => j.task === "add nb");
  const ex = mine2.find((j) => /exit now/.test(j.task));
  assert.ok(sneaky && nb && ex, "all three jobs ran: " + JSON.stringify(mine2.map((j) => [j.id, j.task, j.status])));
  assert.equal(sneaky.status, "accepted");
  assert.ok(sneaky.guardViolation && sneaky.guardViolation.some((v) => v.includes("sneaky.txt")), "an unreported bad commit is still a violation: " + JSON.stringify(sneaky.guardViolation));
  assert.doesNotMatch(git("log", "--format=%s", "-20"), /grok: sneaky/, "the worker could not commit: .git is read-only in its sandbox");
  assert.ok(fs.existsSync(path.join(repo, "sneaky.txt")), "the stray file is left in place for the owner, never deleted");
  assert.equal(git("ls-files", "sneaky.txt").trim(), "", "and Constance never committed it");
  assert.ok(gs2.log.some((l) => l.kind === "guard" && l.job === sneaky.id && /sneaky\.txt \(in the project\)/.test(l.text)), "the guard reported it");
  fs.rmSync(path.join(repo, "sneaky.txt"));
  assert.equal(gs2.guards.grok.strikes, 2, "the stray file and the sneaky commit are the only strikes: " + JSON.stringify(gs2.guards));
  assert.equal(nb.status, "accepted");
  assert.ok(!nb.guardViolation, "the home-folder change is not a violation");
  const notices = gs2.log.filter((l) => l.kind === "guard-notice");
  assert.equal(notices.length, 1, "one guard-notice in the log");
  assert.match(notices[0].text, /owner-made-this/, "it names the folder the owner made");
  assert.equal(ex.status, "accepted");
  assert.match(ex.summary, /exited without writing its done file/);
  const sig2 = JSON.parse(run("signals").stdout);
  const exSig = sig2.find((s) => s.job === ex.id);
  assert.ok(exSig, "the exit was recorded as a signal: " + JSON.stringify(sig2.slice(-5)));
  assert.equal(exSig.source, "exit");
  assert.equal(sig2.find((s) => s.job === sneaky.id)?.source, "done-file", "a normal finish records done-file");
  assert.equal(git("status", "--porcelain").trim(), "", "the repo is clean afterwards");
}

// Review refuses a job that isn't finished (a running one keeps running, nothing
// is logged or merged), and Stop still runs the guard on a halted job: the fake
// grok left stray-now.txt outside its list before it was killed, and the guard
// entry is logged for it.
fs.rmSync(path.join(root, "go"), { force: true });
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
node ${CLI} delegate --agent grok --files ok2.txt --task "stray-now: also add ok2" >/dev/null 2>&1
sleep 300
`, { mode: 0o755 });
writeData();
assert.equal(run("start", "--dir", repo, "--goal", "stop guard goal").status, 0);
assert.ok(await until(() => status().jobs.some((j) => j.status === "running" && j.goal === status().goal?.id)), "the stray job is running");
{
  const rid = status().jobs.find((j) => j.status === "running" && j.goal === status().goal.id).id;
  const rv = run("review", String(rid), "accept", "--note", "too early");
  assert.notEqual(rv.status, 0, "reviewing a running job fails");
  assert.match(rv.stderr, /only a finished job can be reviewed/);
  assert.match(run("review", "9999", "accept").stderr, /No job 9999\./);
  const mid = status();
  assert.equal(mid.jobs.find((j) => j.id === rid).status, "running", "a refused review changes nothing");
  assert.ok(!mid.log.some((l) => l.kind === "review" && l.job === rid), "no review line was logged");
  assert.equal(run("stop").status, 0);
  const st = status();
  assert.equal(st.jobs.find((j) => j.id === rid).status, "stopped");
  assert.ok(st.log.some((l) => l.kind === "guard" && l.job === rid && /stray-now\.txt/.test(l.text)),
    "Stop ran the guard on the halted job: " + JSON.stringify(st.log.filter((l) => l.job === rid)));
  assert.ok(fs.existsSync(path.join(repo, "stray-now.txt")), "the stray file is left for the owner, never deleted");
  assert.equal(st.guards.grok.strikes, 3, "the stopped job's violation counted a strike: " + JSON.stringify(st.guards));
}

// The watcher: a fake busctl feeds it real-format Notify blocks. With no job
// running for the named agent, the notification is logged as the owner's own —
// noted and left alone — and `signals` shows it.
fs.writeFileSync(path.join(root, "notify-fixture.txt"), `‣ Type=method_call  Endian=l  Flags=0  Version=1 Cookie=0  Timestamp="x"
  Sender=:1.1  Destination=:1.2  Path=/org/freedesktop/Notifications  Interface=org.freedesktop.Notifications  Member=Notify
  MESSAGE "susssasa{sv}i" {
          STRING "Slack";
          UINT32 0;
          STRING "";
          STRING "Devin";
          STRING "done with lunch, ready when you are";
          INT32 -1;
  };

‣ Type=method_call  Endian=l  Flags=0  Version=1 Cookie=1  Timestamp="x"
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
// Kill any watcher the goals spawned, then start ours against the fixture bus.
{
  const wp = path.join(tabs, "constance", "watcher.pid");
  try { const pid = Number(fs.readFileSync(wp, "utf8")); process.kill(pid, "SIGKILL"); } catch {}
  try { fs.rmSync(wp); } catch {}
}
const { spawn } = await import("node:child_process");
const watcher = spawn("node", [CLI, "watch"], { env, stdio: "ignore" });
const notifyJsonl = path.join(tabs, "constance", "notify.jsonl");
assert.ok(await until(() => { try { return fs.readFileSync(notifyJsonl, "utf8").includes('"kind":"foreign"'); } catch { return false; } }, 10000), "the watcher recorded the notification");
watcher.kill("SIGKILL");
{
  const sig = JSON.parse(run("signals").stdout);
  const mine = sig.find((s) => s.agent === "devin" && s.kind === "foreign");
  assert.ok(mine, "the fake notification was recorded: " + JSON.stringify(sig));
  assert.equal(mine.kind, "foreign", "no job of hers -> the owner's own agent");
  assert.equal(mine.summary, undefined, "the owner's own run keeps no notification text");
  const slog = status().log.filter((l) => l.kind === "signal").find((l) => l.agent === "devin");
  assert.ok(slog && /left alone/.test(slog.text), "the signal is in her log: " + JSON.stringify(slog));
  // The unrelated chat message in the same stream never reached any file.
  const files = [notifyJsonl, path.join(tabs, "constance", "log.jsonl")].map((f) => fs.readFileSync(f, "utf8")).join("");
  assert.ok(!/lunch|Slack/.test(files), "an unrelated notification is never written anywhere");
}
// The goal queue: a goal added while she is free starts at once; goals added while she works wait
// their turn (reordered and edited meanwhile) and start by themselves when the one before ends well.
// A goal that ends needing the owner stops the queue and tells them; "goals next" starts it again.
{
  fs.writeFileSync(path.join(tabs, "settings.json"), JSON.stringify({ constancePractice: false }));
  writeData();
  try { fs.rmSync(path.join(root, "go")); } catch {}
  try { fs.rmSync(path.join(root, "notified.txt")); } catch {}
  // Fake Constance for queued goals: the goal text is in her first message. "build q1" delegates one
  // tagged job and waits for it; "ask owner" flags a question; anything else just reports.
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
C="node ${CLI}"
p="\${@: -1}"
[[ "$p" == "Goal from the owner:"* ]] && echo "$p" | head -1 >> "${root}/queue-goals.txt"
while [[ ! -e "${root}/qgo" ]]; do sleep 0.2; done
if grep -q "build q1" <<<"$p"; then
  $C delegate --agent grok --files q1.txt --item 1 --title "building q1" --task "add q1" >> "${root}/brain.out" 2>&1
  touch "${root}/go"
  $C wait --timeout 30 > /dev/null
  $C review $($C jobs | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d).jobs.at(-1);console.log(j.id)})') accept --note "q1 is in"
elif grep -q "ask owner" <<<"$p"; then
  $C needs-owner "Pick a color for the button before I go on."
fi
echo "Report: done."
`, { mode: 0o755 });
  const r1 = run("goals", "add", "--goal", "build q1", "--dir", repo);
  assert.equal(r1.status, 0, r1.stderr); assert.match(r1.stdout, /on it: build q1/, "free: the first goal starts at once");
  assert.equal(status().goal.text, "build q1");
  assert.equal(run("goals", "add", "--goal", "ask owner", "--dir", repo).status, 0);
  assert.equal(run("goals", "add", "--goal", "third goal", "--dir", repo).status, 0);
  assert.notEqual(run("goals", "add", "--goal", "nowhere", "--dir", path.join(root, "missing")).status, 0, "a missing folder is refused");
  assert.notEqual(run("goals", "add", "--goal", "home", "--dir", fakeHome).status, 0, "never the home folder");
  let q = status().board.goalQueue.goals;
  assert.deepEqual(q.map((g) => g.text), ["ask owner", "third goal"]);
  run("goals", "move", q[1].id, "up");
  assert.deepEqual(status().board.goalQueue.goals.map((g) => g.text), ["third goal", "ask owner"], "reordered");
  run("goals", "move", q[1].id, "down");
  run("goals", "edit", q[1].id, "--goal", "third goal, edited");
  q = status().board.goalQueue.goals;
  assert.deepEqual(q.map((g) => g.text), ["ask owner", "third goal, edited"]);
  const extra = run("goals", "add", "--goal", "dropped", "--dir", repo); assert.equal(extra.status, 0);
  run("goals", "rm", status().board.goalQueue.goals.at(-1).id);
  assert.equal(status().board.goalQueue.goals.length, 2, "removed");
  assert.match(run("start", "--dir", repo, "--goal", "x").stderr, /goal queue/, "busy: start points at the queue");
  // While q1's job runs: the card, the Now line and the checklist.
  fs.writeFileSync(path.join(root, "qgo"), "");
  assert.ok(await until(() => status().jobs.some((j) => j.status === "running" && j.title === "building q1")), "the tagged job runs");
  {
    const b = status().board;
    assert.match(b.now, /^Grok is on building q1\. 2 goals queued\.$/, b.now);
    const card = b.cards.find((c) => c.title === "building q1");
    assert.equal(card.status, "running"); assert.deepEqual(card.files, ["q1.txt"]); assert.deepEqual(card.items, [1]);
    assert.equal(b.checklist.line, "0 of 1 done");
    // The card's full view: prompt and its own log lines.
    const jv = JSON.parse(run("job", String(card.id)).stdout);
    assert.match(jv.prompt, /add q1/); assert.equal(jv.guardBefore, undefined);
    assert.ok(jv.log.some((l) => l.kind === "handoff"));
  }
  // q1 ends well -> "ask owner" starts by itself -> it flags the owner -> the queue stops there.
  assert.ok(await until(() => { const g = status().goal; return g.text === "ask owner" && g.status === "done"; }, 30000), "the next goal started by itself and finished: " + JSON.stringify(status().goal));
  await until(() => status().board.goalQueue.paused !== "", 5000);
  const st = status();
  assert.match(st.board.goalQueue.paused, /Pick a color/, "the queue stopped for the owner");
  assert.deepEqual(st.board.goalQueue.goals.map((g) => g.text), ["third goal, edited"], "the third goal waits");
  assert.match(st.board.now, /^She stopped: Pick a color.*The queue waits for you\.$/, st.board.now);
  assert.ok(st.log.some((l) => l.kind === "needs-you"), "logged for the owner");
  assert.match(fs.readFileSync(path.join(root, "notified.txt"), "utf8"), /Constance needs you/, "and told with a (silent) notification");
  assert.match(fs.readFileSync(path.join(root, "notified.txt"), "utf8"), /suppress-sound:true/);
  const hist = st.board.history;
  const q1 = hist.find((h) => h.text === "build q1");
  assert.equal(q1.outcome, "done"); assert.equal(q1.jobs, 1); assert.equal(q1.merged, 1); assert.equal(q1.itemsDone, 1);
  assert.equal(hist.find((h) => h.text === "ask owner").outcome, "needs you");
  assert.ok(fs.readFileSync(path.join(tabs, "constance", "history.jsonl"), "utf8").includes('"build q1"'), "kept in history.jsonl");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(status().goal.text, "ask owner", "nothing moved on by itself");
  // The owner's "Start next".
  assert.equal(run("goals", "next").status, 0);
  assert.ok(await until(() => { const g = status().goal; return g.text === "third goal, edited" && g.status === "done"; }, 30000), "the owner restarted the queue");
  const sb = status().board;
  assert.equal(sb.goalQueue.goals.length, 0); assert.equal(sb.goalQueue.paused, "");
  assert.match(sb.now, /^Free\. Last goal finished\.$/);
  assert.match(run("goals", "next").stderr, /empty/);
  assert.deepEqual(fs.readFileSync(path.join(root, "queue-goals.txt"), "utf8").trim().split("\n").map((l) => l.replace(/^Goal from the owner: /, "")), ["build q1", "ask owner", "third goal, edited"]);
  // The queue ran empty: the morning report is written and sent (silently).
  assert.ok(await until(() => fs.existsSync(path.join(tabs, "constance", "morning-report.md")), 5000), "the morning report is written");
  const mr = fs.readFileSync(path.join(tabs, "constance", "morning-report.md"), "utf8");
  assert.match(mr, /# Morning report/); assert.match(mr, /build q1/); assert.match(mr, /third goal, edited/); assert.match(mr, /Pick a color/, "what needed the owner is in it");
  assert.match(fs.readFileSync(path.join(root, "notified.txt"), "utf8"), /Constance: morning report/, "and a desktop notification went out");
  assert.ok(sb && status().log.some((l) => l.kind === "morning"), "logged");
  // Every reviewed job counts on the scorecard, shown on the board.
  const sc = status().board.scorecard;
  const grokRow = sc.rows.find((r) => r.agent === "grok");
  assert.ok(grokRow && /accepted/.test(grokRow.line) && grokRow.hint, "grok has a scorecard row: " + JSON.stringify(sc));
  assert.equal(sc.spareOn, true, "use it or lose it is on by default");
  assert.match(run("scorecard").stdout, /grok: \d+ jobs, \d+ accepted/);
  assert.match(run("agents").stdout, /AVAILABLE  grok .*\[grok: \d+ jobs/, "agents shows each available agent's record and size hint");
}
// Second-try rule, the backlog, and use it or lose it. "retry goal": a job is sent back twice,
// the third try with the same files is refused, a split goes through. The goal also fills the
// backlog; when it ends with the queue empty, devin's room (its window resets in 30 min, barely
// used) goes to a backlog goal started by itself, once — then the morning report.
{
  fs.rmSync(path.join(root, "go"), { force: true });
  try { fs.rmSync(path.join(root, "notified.txt")); } catch {}
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
p="\${@: -1}"; C="node ${CLI}"
echo "$p" | head -1 >> "${root}/retry-goals.txt"
if grep -q "retry goal" <<<"$p"; then
  touch "${root}/go"
  $C delegate --agent grok --files r1.txt,r2.txt --task "add r" >> "${root}/retry.out" 2>&1
  $C wait --timeout 30 > /dev/null
  $C review $($C jobs | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{console.log(JSON.parse(d).jobs.at(-1).id)})') send-back --note "wrong" >> "${root}/retry.out" 2>&1
  first=$($C jobs | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{console.log(JSON.parse(d).jobs.at(-1).id)})')
  $C delegate --agent grok --files r1.txt,r2.txt --again "$first" --task "add r again" >> "${root}/retry.out" 2>&1
  $C wait --timeout 30 > /dev/null
  $C review $($C jobs | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{console.log(JSON.parse(d).jobs.at(-1).id)})') send-back --note "still wrong" >> "${root}/retry.out" 2>&1
  $C delegate --agent grok --files r2.txt,r1.txt --task "add r a third time" >> "${root}/retry.out" 2>&1 || echo "refused-third" >> "${root}/retry.out"
  $C delegate --agent grok --files r1.txt --task "add r1 only" >> "${root}/retry.out" 2>&1 || echo "refused-split" >> "${root}/retry.out"
  $C wait --timeout 30 > /dev/null
  $C review $($C jobs | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{console.log(JSON.parse(d).jobs.at(-1).id)})') accept --note "split worked" >> "${root}/retry.out" 2>&1
  $C backlog add --kind test --text "cover the parser edge cases" >> "${root}/retry.out" 2>&1
  $C backlog add --kind review --text "look over the guard design" >> "${root}/retry.out" 2>&1
  $C backlog add --kind nonsense --text "x" >> "${root}/retry.out" 2>&1 || echo "refused-kind" >> "${root}/retry.out"
  $C backlog >> "${root}/retry.out" 2>&1
  $C spare >> "${root}/retry.out" 2>&1
elif grep -q "Use it or lose it" <<<"$p"; then
  $C backlog done 1 >> "${root}/retry.out" 2>&1
fi
echo "Report: done."
`, { mode: 0o755 });
  // devin: a window that resets in 30 minutes, barely used — room it would lose.
  fs.writeFileSync(path.join(tabs, "data.json"), JSON.stringify({ generatedAt: Date.now(), agents: [
    { id: "claude", installed: true, signedIn: true, limits: [{ title: "Session", percent: 0.1, resetsAt: soon(4) }, { title: "Weekly", percent: 0.1, resetsAt: soon(150) }] },
    { id: "grok", installed: true, signedIn: true, limits: [{ title: "Daily", percent: 0.1 }] },
    { id: "devin", name: "Devin", installed: true, signedIn: true, limits: [{ title: "Daily", percent: 0.1, resetsAt: soon(0.5) }] }] }));
  // Earlier blocks gave grok guardrail strikes (one file per job); this block needs two-file jobs.
  { const jf = path.join(tabs, "constance", "jobs.json"), d = JSON.parse(fs.readFileSync(jf, "utf8")); d.guards = {}; fs.writeFileSync(jf, JSON.stringify(d)); }
  assert.equal(run("start", "--dir", repo, "--goal", "retry goal").status, 0);
  assert.ok(await until(() => { const t = fs.existsSync(path.join(root, "retry-goals.txt")) ? fs.readFileSync(path.join(root, "retry-goals.txt"), "utf8") : ""; return /Use it or lose it/.test(t) && status().goal.status === "done"; }, 60000),
    "a backlog goal started by itself after the retry goal: " + JSON.stringify(status().goal));
  const ro = fs.readFileSync(path.join(root, "retry.out"), "utf8");
  assert.match(ro, /sent back twice \(jobs \d+ and \d+\)/, "the second send-back says to split or do it");
  assert.match(ro, /were already sent back for this work.*split it into smaller jobs/s, "the third try with the same files is refused");
  assert.match(ro, /refused-third/); assert.doesNotMatch(ro, /refused-split/, "a smaller split goes through");
  assert.match(ro, /refused-kind/, "an unknown backlog kind is refused");
  assert.match(ro, /#1 test: cover the parser edge cases/); assert.match(ro, /#2 review: look over the guard design/);
  assert.match(ro, /devin: #1 test: cover the parser edge cases/, "spare: devin's leftover room goes to the backlog's worker item");
  const g = status().goal;
  assert.equal(g.fromSpare, true);
  assert.match(g.text, /Hand to Devin: test: cover the parser edge cases \(backlog #1\)/);
  assert.doesNotMatch(g.text, /look over the guard design/, "review work is only for Constance's own leftover Opus, and she has none near a reset");
  assert.match(fs.readFileSync(path.join(repo, ".constance", "backlog.md"), "utf8"), /- \[x\] test: cover the parser edge cases/, "she marked it done");
  // Once per reset window: no second backlog goal, then the morning report.
  assert.ok(await until(() => fs.existsSync(path.join(root, "notified.txt")) && /morning report/.test(fs.readFileSync(path.join(root, "notified.txt"), "utf8")), 10000), "the morning report went out after the backlog goal");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(fs.readFileSync(path.join(root, "retry-goals.txt"), "utf8").trim().split("\n").filter((l) => /Use it or lose it/.test(l)).length, 1, "only one backlog goal for that window");
  // The setting turns it off.
  fs.writeFileSync(path.join(tabs, "settings.json"), JSON.stringify({ constancePractice: false, constanceUseItOrLoseIt: false }));
  assert.match(run("spare", "--dir", repo).stdout, /use it or lose it is off/);
  assert.equal(status().board.scorecard.spareOn, false);
  fs.writeFileSync(path.join(tabs, "settings.json"), JSON.stringify({ constancePractice: false }));
  writeData();
}
// A copy job's own worktree means no excuses: the fake devin commits cover.txt
// outside its list while a shared-folder grok job's file list covers that same
// file — overlapping in time — and the copy is still flagged. The grok job,
// which stayed inside its list, is clean.
fs.rmSync(path.join(root, "go"), { force: true });
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
C="node ${CLI}"
$C delegate --agent devin --files d1.txt --task "sneaky copy: also commit cover.txt" >> "${root}/copyguard.out" 2>&1
$C delegate --agent grok --files cover.txt --task "add cover" >> "${root}/copyguard.out" 2>&1
touch "${root}/go"
$C wait --timeout 60 > "${root}/cg-wait1.json"
# Both jobs must be finished before reviewing: two waits can hand back the same
# (not yet reviewed) copy when it finishes first, and the grok review would be refused.
for i in $(seq 1 240); do
  $C jobs > "${root}/cg-jobs.json"
  node -e 'const js=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).jobs.filter(j=>j.task==="add cover"||/sneaky copy/.test(j.task));process.exit(js.length>=2&&js.every(j=>j.status==="finished"&&!j.settling)?0:1)' "${root}/cg-jobs.json" && break
  sleep 0.25
done
did=$(node -e 'const js=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).jobs;console.log(js.find(j=>j.agent==="devin"&&j.files.includes("d1.txt")).id)' "${root}/cg-jobs.json")
gid=$(node -e 'const js=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).jobs;console.log(js.find(j=>j.agent==="grok"&&j.files.includes("cover.txt")).id)' "${root}/cg-jobs.json")
$C review "$did" send-back --note "strayed outside its list" >> "${root}/copyguard.out" 2>&1
$C review "$gid" accept --note "cover is fine" >> "${root}/copyguard.out" 2>&1
echo "Copy guard report: the copy's stray commit was flagged."
`, { mode: 0o755 });
writeData();
assert.equal(run("start", "--dir", repo, "--goal", "copy guard goal").status, 0);
assert.ok(await until(() => status().goal && status().goal.status === "done", 90000), "the copy guard goal finishes: " + JSON.stringify(status().goal));
{
  const cg = status();
  const dj = cg.jobs.find((j) => j.agent === "devin" && j.files.includes("d1.txt") && j.goal === cg.goal.id);
  const gj = cg.jobs.find((j) => j.agent === "grok" && j.files.includes("cover.txt") && j.goal === cg.goal.id);
  assert.ok(dj && gj, "both jobs ran: " + JSON.stringify(cg.jobs.map((j) => [j.id, j.agent, j.task, j.status])));
  assert.ok(dj.copy && dj.branch, "the devin job was a copy with its own worktree");
  assert.ok(dj.guardViolation && dj.guardViolation.some((v) => v.includes("cover.txt")),
    "the copy's out-of-list commit is flagged even though the grok job's list covers it: " + JSON.stringify(dj.guardViolation));
  assert.ok(!gj.guardViolation, "the shared-folder job stayed inside its list");
  assert.equal(gj.status, "accepted");
  assert.equal(dj.status, "sent back");
  assert.equal(fs.readFileSync(path.join(repo, "cover.txt"), "utf8"), "x\n", "only the grok job's cover.txt is in the repo");
}
// "Never stop to ask": an exit-0 run with open checklist items is not a finished
// goal — the driver resumes her session with a nudge, at most 3 per goal, then
// ends as before. The fake claude does nothing and exits 0 every time.
fs.rmSync(path.join(root, "go"), { force: true });
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
n=0; [[ -f "${root}/nudge-runs" ]] && n=$(cat "${root}/nudge-runs"); n=$((n+1)); echo "$n" > "${root}/nudge-runs"
echo "$@" > "${root}/nudge-args-$n"
exit 0
`, { mode: 0o755 });
writeData();
assert.equal(run("start", "--dir", repo, "--goal", "1. first thing\n2. second thing").status, 0);
assert.ok(await until(() => status().goal && status().goal.status === "done", 30000), "the nudged goal finishes: " + JSON.stringify(status().goal));
{
  assert.equal(fs.readFileSync(path.join(root, "nudge-runs"), "utf8").trim(), "4", "the first run plus 3 nudges, then it ends");
  const last = fs.readFileSync(path.join(root, "nudge-args-4"), "utf8");
  assert.match(last, /--resume/, "the nudge resumes her session");
  assert.match(last, /The goal is not finished: items 1, 2 are still open/, "the nudge names what is open");
  assert.match(last, /Keep going: delegate or wait, don't ask/, "and tells her to keep going");
  assert.equal(status().goal.nudges, 3, "the nudge count is kept on the goal");
  assert.ok(status().log.some((l) => l.kind === "note" && /nudge 3 of 3/.test(l.text)), "each nudge is logged");
}

// A project-folder job's done file lives in its sandbox tmp (inside the sandbox
// that is /tmp), never in the project: sweep finds it there, the prompt says
// so, and nothing lands under the project's .constance.
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
C="node ${CLI}"
$C delegate --agent grok --task "read-only job: summarize a.txt" >> "${root}/tmpdone.out" 2>&1
touch "${root}/go"
$C wait --timeout 30 > "${root}/tmpdone-wait.json"
id=$(grep -o '"id": [0-9]*' "${root}/tmpdone-wait.json" | head -1 | grep -o '[0-9]*')
$C review "$id" accept --note "ok" >> "${root}/tmpdone.out" 2>&1
echo "Tmpdone report: done."
`, { mode: 0o755 });
writeData();
assert.equal(run("start", "--dir", repo, "--goal", "tmp done goal").status, 0);
assert.ok(await until(() => status().goal && status().goal.status === "done", 30000), "the tmp-done goal finishes: " + JSON.stringify(status().goal));
{
  const tj = status().jobs.find((j) => j.goal === status().goal.id);
  assert.equal(tj.status, "accepted");
  assert.match(tj.summary, /cause: a\.txt has no b/, "the done file in the sandbox tmp was found");
  const sig = JSON.parse(run("signals").stdout);
  assert.equal(sig.find((s) => s.job === tj.id)?.source, "done-file", "the finish was recorded from the tmp done file");
  const stored = JSON.parse(fs.readFileSync(path.join(tabs, "constance", "jobs.json"), "utf8"));
  const pj = stored.jobs.find((j) => j.id === tj.id);
  assert.match(pj.prompt, /write the file \/tmp\/\.constance\/done-\d+\.json/, "the prompt points inside the sandbox tmp");
  assert.ok(!fs.readdirSync(path.join(repo, ".constance")).some((f) => f.startsWith("done-")), "no done file in the project folder");
}

// Self-merge needs a real test command for the project (finding 4): the rules
// name one. It runs in the suite sandbox, so it must pass there.
fs.appendFileSync(path.join(repo, ".constance", "rules.md"), "test: test -f a.txt\n");
// Self-merge: a copy that stays inside its files, passes the guard and passes
// the project's test command merges itself the moment it finishes — before any review.
// `reviews` lists it for her background review; send-back reverts the merge,
// accept only confirms it.
fs.rmSync(path.join(root, "go"), { force: true });
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
C="node ${CLI}"
$C delegate --agent devin --files sm1.txt --task "add sm1 selfmerge" >> "${root}/sm.out" 2>&1
touch "${root}/go"
$C wait --timeout 60 > "${root}/sm-wait1.json"
$C reviews > "${root}/sm-reviews1.json"
id1=$(node -e 'const w=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(w.review.id)' "${root}/sm-wait1.json")
$C review "$id1" send-back --note "revert it" >> "${root}/sm.out" 2>&1
$C delegate --agent devin --files sm2.txt --task "add sm2 selfmerge" >> "${root}/sm.out" 2>&1
$C wait --timeout 60 > "${root}/sm-wait2.json"
id2=$(node -e 'const w=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(w.review.id)' "${root}/sm-wait2.json")
$C review "$id2" accept --note "fine" >> "${root}/sm.out" 2>&1
echo "SM report: done."
`, { mode: 0o755 });
writeData();
const porcelainBeforeSm = git("status", "--porcelain");
assert.equal(run("start", "--dir", repo, "--goal", "selfmerge goal").status, 0);
assert.ok(await until(() => status().goal && status().goal.status === "done", 90000), "the selfmerge goal finishes: " + JSON.stringify(status().goal));
{
  const sm = status();
  const w1 = JSON.parse(fs.readFileSync(path.join(root, "sm-wait1.json"), "utf8"));
  const rev1 = JSON.parse(fs.readFileSync(path.join(root, "sm-reviews1.json"), "utf8"));
  const j1 = sm.jobs.find((j) => j.id === w1.review.id), j2 = sm.jobs.find((j) => j.files.includes("sm2.txt") && j.goal === sm.goal.id);
  assert.ok(j1 && j2, "both selfmerge jobs ran");
  assert.equal(j1.files[0], "sm1.txt");
  assert.equal(rev1.length, 1, "reviews lists the pending self-merge: " + JSON.stringify(rev1));
  assert.equal(rev1[0].job, j1.id); assert.equal(rev1[0].branch, j1.branch);
  assert.equal(j1.status, "sent back", "send-back on a merged job marks it sent back: " + j1.status);
  assert.ok(j1.revertedAt, "the revert is recorded on the job");
  assert.equal(j2.status, "accepted", "accept on a merged job confirms it: " + j2.status);
  assert.ok(!fs.existsSync(path.join(repo, "sm1.txt")), "the reverted merge took its file back out");
  assert.ok(fs.existsSync(path.join(repo, "sm2.txt")), "the confirmed merge stayed");
  const pend = JSON.parse(fs.readFileSync(path.join(tabs, "constance", "reviews.json"), "utf8"));
  assert.equal(pend.pending.length, 0, "no review left pending");
  assert.deepEqual(pend.reviewed.map((r) => r.verdict).sort(), ["ok", "reverted"], "both reviews recorded");
  assert.ok(sm.log.some((l) => l.kind === "merge" && /self-merged constance\/job-/.test(l.text)), "self-merges are in the log");
  assert.ok(sm.log.some((l) => l.kind === "revert" && l.job === j1.id), "the revert is in the log");
  assert.equal(git("branch", "--list", "constance/*").trim(), "", "self-merged branches are deleted");
  assert.equal(git("status", "--porcelain"), porcelainBeforeSm, "the repo is left as it was found");
}

// Self-merge never fires on a guard violation: the sneaky copy reports its
// tests passed but committed outside its list, so it stays "finished" for the
// normal review and never enters the pending-review list.
fs.rmSync(path.join(root, "go"), { force: true });
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
C="node ${CLI}"
$C delegate --agent devin --files gv1.txt --task "sneaky copy selfmerge" >> "${root}/gv.out" 2>&1
touch "${root}/go"
$C wait --timeout 60 > "${root}/gv-wait.json"
$C jobs > "${root}/gv-jobs.json"
id=$(node -e 'const js=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).jobs;console.log(js.find(j=>j.files.includes("gv1.txt")).id)' "${root}/gv-jobs.json")
$C review "$id" accept --note "ok" >> "${root}/gv.out" 2>&1
echo "GV report: done."
`, { mode: 0o755 });
writeData();
assert.equal(run("start", "--dir", repo, "--goal", "selfmerge guard").status, 0);
assert.ok(await until(() => status().goal && status().goal.status === "done", 90000), "the selfmerge guard goal finishes: " + JSON.stringify(status().goal));
{
  const mid = JSON.parse(fs.readFileSync(path.join(root, "gv-jobs.json"), "utf8"));
  const gj = mid.jobs.find((j) => j.files.includes("gv1.txt"));
  assert.equal(gj.status, "finished", "a guard violation never self-merges: " + gj.status);
  const gv = status();
  const gj2 = gv.jobs.find((j) => j.id === gj.id);
  assert.ok(gj2.guardViolation?.some((v) => v.includes("cover.txt")), "the violation is flagged: " + JSON.stringify(gj2.guardViolation));
  assert.equal(gj2.status, "accepted", "the normal review path still merges it");
  assert.ok(!gv.log.some((l) => l.kind === "merge" && /self-merged/.test(l.text) && l.job === gj.id), "no self-merge for it");
  const pend = JSON.parse(fs.readFileSync(path.join(tabs, "constance", "reviews.json"), "utf8"));
  assert.ok(!pend.pending.some((p) => p.job === gj.id) && !pend.reviewed.some((p) => p.job === gj.id), "it never entered the review list");
}

// Slot filling: a queued task that names its agent starts as soon as a copy
// slot is free — no review needed. sf1 self-merges; sf2 and sf3 are handed to
// Devin 2 and Devin 3 while sf1 still waits for its background review.
fs.rmSync(path.join(root, "go"), { force: true });
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
C="node ${CLI}"
$C delegate --agent devin --files sf1.txt --task "add sf1 selfmerge" >> "${root}/sf.out" 2>&1
$C queue --task "add sf2" --files sf2.txt --agent devin >> "${root}/sf.out" 2>&1
$C queue --task "add sf3" --files sf3.txt --agent devin >> "${root}/sf.out" 2>&1
touch "${root}/go"
$C wait --timeout 60 > "${root}/sf-wait1.json"
$C jobs > "${root}/sf-jobs-mid.json"
id1=$(node -e 'const w=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(w.review.id)' "${root}/sf-wait1.json")
$C review "$id1" accept --note "ok" >> "${root}/sf.out" 2>&1
$C wait --timeout 60 > "${root}/sf-wait2.json"
id2=$(node -e 'const w=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(w.review.id)' "${root}/sf-wait2.json")
$C review "$id2" accept --note "ok" >> "${root}/sf.out" 2>&1
$C wait --timeout 60 > "${root}/sf-wait3.json"
id3=$(node -e 'const w=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(w.review.id)' "${root}/sf-wait3.json")
$C review "$id3" accept --note "ok" >> "${root}/sf.out" 2>&1
echo "SF report: done."
`, { mode: 0o755 });
writeData();
assert.equal(run("start", "--dir", repo, "--goal", "slot fill goal").status, 0);
assert.ok(await until(() => status().goal && status().goal.status === "done", 120000), "the slot fill goal finishes: " + JSON.stringify(status().goal));
{
  const mid = JSON.parse(fs.readFileSync(path.join(root, "sf-jobs-mid.json"), "utf8"));
  const sf1 = mid.jobs.find((j) => j.files.includes("sf1.txt"));
  const handed = mid.jobs.filter((j) => ["sf2.txt", "sf3.txt"].some((f) => j.files.includes(f)));
  assert.equal(sf1.status, "merged", "sf1 self-merged before any review: " + sf1.status);
  assert.equal(handed.length, 2, "both queued tasks were handed out while sf1 awaited review: " + JSON.stringify(mid.jobs.map((j) => [j.id, j.task, j.status])));
  assert.deepEqual(handed.map((j) => j.task).sort(), ["add sf2", "add sf3"]);
  const sf = status();
  const all = sf.jobs.filter((j) => j.goal === sf.goal.id);
  assert.ok(all.every((j) => j.status === "accepted"), "all three reviewed: " + JSON.stringify(all.map((j) => [j.id, j.status])));
  for (const f of ["sf1.txt", "sf2.txt", "sf3.txt"]) assert.ok(fs.existsSync(path.join(repo, f)), f + " merged");
  assert.equal(sf.queue.length, 0, "the queue drained itself");
}

// Self-merge never blocks: with the suite slowed by CONSTANCE_SELFMERGE_SUITE_DELAY_MS,
// a status call while the merge runs still returns in under 2 s, `jobs` (which
// sweeps) too, wait never hands the job out mid-merge, and it ends up merged
// for her background review.
fs.rmSync(path.join(root, "go"), { force: true });
const jobsJson = path.join(tabs, "constance", "jobs.json");
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
C="node ${CLI}"
$C delegate --agent devin --files smx.txt --task "add smx selfmerge" >> "${root}/smx.out" 2>&1
touch "${root}/go"
# Wait for the self-merge to start, then time status and jobs calls mid-suite.
for i in $(seq 1 160); do
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(s.jobs.some(j=>j.selfMerging)?0:1)' "${jobsJson}" 2>/dev/null && break
  sleep 0.25
done
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!s.jobs.some(j=>j.selfMerging))process.exit(3)' "${jobsJson}"
t0=$(date +%s%N); $C status > "${root}/smx-status.json"; t1=$(date +%s%N)
echo $(( (t1-t0)/1000000 )) > "${root}/smx-status-ms.txt"
t0=$(date +%s%N); $C jobs > "${root}/smx-jobs.json"; t1=$(date +%s%N)
echo $(( (t1-t0)/1000000 )) > "${root}/smx-jobs-ms.txt"
$C wait --timeout 90 > "${root}/smx-wait.json"
id=$(node -e 'const w=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(w.review.id)' "${root}/smx-wait.json")
$C reviews > "${root}/smx-reviews.json"
$C review "$id" accept --note "fine" >> "${root}/smx.out" 2>&1
echo "SMX report: done."
`, { mode: 0o755 });
writeData();
// The delay has to reach whichever process sweeps first (the panel-style status
// polls included), so it goes into the shared env for this goal only.
env.CONSTANCE_SELFMERGE_SUITE_DELAY_MS = "8000";
assert.equal(run("start", "--dir", repo, "--goal", "async selfmerge goal").status, 0);
assert.ok(await until(() => status().goal && status().goal.status === "done", 120000), "the async selfmerge goal finishes: " + JSON.stringify(status().goal));
delete env.CONSTANCE_SELFMERGE_SUITE_DELAY_MS;
{
  const smxMs = Number(fs.readFileSync(path.join(root, "smx-status-ms.txt"), "utf8"));
  assert.ok(smxMs > 0 && smxMs < 2000, `status during the self-merge suite returned in ${smxMs} ms`);
  const jobsMs = Number(fs.readFileSync(path.join(root, "smx-jobs-ms.txt"), "utf8"));
  assert.ok(jobsMs > 0 && jobsMs < 2000, `jobs during the self-merge suite returned in ${jobsMs} ms`);
  const w = JSON.parse(fs.readFileSync(path.join(root, "smx-wait.json"), "utf8"));
  const rev = JSON.parse(fs.readFileSync(path.join(root, "smx-reviews.json"), "utf8"));
  const smx = status();
  const j = smx.jobs.find((x) => x.files.includes("smx.txt") && x.goal === smx.goal.id);
  assert.ok(j, "the async selfmerge job ran");
  assert.equal(j.status, "accepted", "the self-merged job was reviewed: " + j.status);
  assert.ok(!j.selfMerging && !j.selfMergePid, "selfMerging cleared afterwards");
  assert.ok(fs.existsSync(path.join(repo, "smx.txt")), "the merge landed");
  assert.equal(w.review.id, j.id, "wait handed her the merged job, not one mid-merge");
  assert.equal(rev.length, 1, "reviews listed the pending self-merge: " + JSON.stringify(rev));
  assert.equal(rev[0].job, j.id);
  assert.ok(smx.log.some((l) => l.kind === "merge" && /self-merged constance\/job-/.test(l.text) && l.job === j.id), "self-merge is in the log");
}

// Every finished or stopped job removed its own sandbox /tmp.
{
  const jobsNow = JSON.parse(fs.readFileSync(path.join(tabs, "constance", "jobs.json"), "utf8")).jobs;
  for (const j of jobsNow) if (j.tmp && ["finished", "accepted", "sent back", "stopped"].includes(j.status)) assert.ok(!fs.existsSync(j.tmp), `job ${j.id}'s temp folder is gone`);
}

// Leverage, Milk Opus and remote status: status carries the meter and the
// policy, a finished goal's history line keeps the same leverage object, her
// first prompt carried the milk lines, and `remote` writes a phone-safe file
// with no paths in it.
{
  const ms = status();
  assert.ok(ms.leverage && typeof ms.leverage.label === "string" && Number.isFinite(ms.leverage.spentPct),
    "status has leverage: " + JSON.stringify(ms.leverage));
  assert.equal(ms.milk.value, 25, "no constanceMilk setting -> the default");
  assert.equal(ms.milk.band, "milk"); assert.equal(ms.milk.sandbox, true); assert.equal(ms.milk.guardrails, true);
  // `remote` writes the summary and prints the path; the file has no paths in it.
  const rr = run("remote");
  assert.equal(rr.status, 0, rr.stderr);
  const rfile = path.join(tabs, "constance", "remote-status.txt");
  assert.equal(rr.stdout.trim(), rfile, "remote prints the path it wrote");
  const rtext = fs.readFileSync(rfile, "utf8");
  assert.match(rtext, /^Goal: /m);
  for (const p of [root, repo, tabs, fakeHome, "/home/", "/var/tmp"]) assert.ok(!rtext.includes(p), `no "${p}" in the remote status`);
  // Every recorded goal carries the leverage object status computed.
  const hist = fs.readFileSync(path.join(tabs, "constance", "history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(hist.length > 0);
  for (const h of hist) assert.ok(h.leverage && typeof h.leverage.label === "string" && Number.isFinite(h.leverage.spentPct),
    `history line for "${h.text}" has leverage: ` + JSON.stringify(h.leverage));
  // Her first prompt carried the milk lines (after her lessons, before the rules).
  const ga = fs.readFileSync(path.join(root, "claude-args-guard"), "utf8");
  assert.match(ga, /Milk Opus is at 25 \(milk\)/, "the milk line is in her goal prompt");
  assert.match(ga, /Sandbox and guardrails stay on at every setting\./);
  assert.ok(ga.indexOf("Lessons from your earlier goals") < ga.indexOf("Milk Opus is at"), "milk comes after her lessons");
  assert.ok(ga.indexOf("Milk Opus is at") < ga.indexOf("Rules for this project"), "milk comes before the project rules");
}
fs.rmSync(root, { recursive: true, force: true });
console.log("constance: tests passed");
