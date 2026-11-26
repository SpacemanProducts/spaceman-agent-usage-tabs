// End to end for the goal queue's new stopping rules, in a scratch state dir and repo with a fake
// `claude` on PATH (practice off, quiet fake busctl and notify-send, fake /proc for the ramp):
// four queued goals run back to back — one checks itself off, one hits Claude's own limit wall
// once and resumes after the stated reset, one fails three times, one checks itself off — and the
// queue drains with no "needs-you" anywhere: a failure and a wall pause are notes, not stops.
// Then a goal that runs `C needs-owner` stops the queue for real and the next goal waits.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const CLI = new URL("./constance.mjs", import.meta.url).pathname;
let root = "";
for (const base of ["/var/tmp", path.join(os.homedir(), ".cache")]) {
  if (!path.isAbsolute(base)) continue;
  try { fs.mkdirSync(base, { recursive: true }); root = fs.mkdtempSync(path.join(base, "constance-q4-")); break; } catch {}
}
if (!root) root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-q4-"));
if (!path.isAbsolute(root)) throw new Error(`scratch root is not absolute: ${root}`);
const state = path.join(root, "state"), bin = path.join(root, "bin"), repo = path.join(root, "repo");
const tabs = path.join(state, "omarchy/agent-usage-tabs");
const cdir = path.join(tabs, "constance");
fs.mkdirSync(tabs, { recursive: true }); fs.mkdirSync(bin); fs.mkdirSync(repo);
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
fs.writeFileSync(path.join(repo, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-qm", "init");
const soon = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const writeData = () => fs.writeFileSync(path.join(tabs, "data.json"), JSON.stringify({ generatedAt: Date.now(), agents: [
  { id: "claude", installed: true, signedIn: true, limits: [{ title: "Session", percent: 0.1, resetsAt: soon(4) }, { title: "Weekly", percent: 0.1, resetsAt: soon(150) }] },
  { id: "grok", installed: true, signedIn: true, limits: [{ title: "Daily", percent: 0.1 }] }] }));
writeData();
// Practice mode is on by default; these goals run for real, so switch it off.
fs.writeFileSync(path.join(tabs, "settings.json"), JSON.stringify({ constancePractice: false }));
// Fake Constance: which goal is running comes from jobs.json (a wall resume and a
// failure retry both get the generic "you were interrupted" prompt, not the goal
// text). alpha and delta just tick their one item and report; beta hits the wall
// on its first run (a reset ~3 minutes out, like the wall-resume test) and ticks
// its item on the resumed run; gamma always fails; owner-stop ticks its item and
// flags the owner.
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
C="node ${CLI}"
S="${cdir}/jobs.json"
gtext=$(node -e 'let s="";try{s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).goal?.text||""}catch(e){};console.log(s)' "$S" 2>/dev/null)
echo "run: $gtext" >> "${root}/claude-runs.txt"
case "$gtext" in
  *queue-alpha*|*queue-delta*)
    $C check 1 --note "done" >> "${root}/brain.out" 2>&1
    echo "Report: done."; exit 0;;
  *queue-beta*)
    n=0; [[ -f "${root}/beta-runs" ]] && n=$(cat "${root}/beta-runs"); n=$((n+1)); echo "$n" > "${root}/beta-runs"
    if [[ "$n" == "1" ]]; then
      echo "You've hit your 5-hour limit · resets $(date -u -d '+3 minutes' '+%-I:%M%p') (UTC)"
      exit 1
    fi
    $C check 1 --note "done after the reset" >> "${root}/brain.out" 2>&1
    echo "Report: beta done after the reset."; exit 0;;
  *queue-gamma*)
    echo "boom: real failure"; exit 1;;
  *owner-stop*)
    $C check 1 --note "done" >> "${root}/brain.out" 2>&1
    $C needs-owner "need a decision" >> "${root}/brain.out" 2>&1
    echo "Report: flagged for the owner."; exit 0;;
esac
echo "Report: fallback goal."; exit 0
`, { mode: 0o755 });
// A fake home and projects folder, a quiet fake busctl so no watcher hears the real
// session bus, and a fake notify-send so "needs you" never pops a real notification.
const fakeHome = path.join(root, "home"); fs.mkdirSync(path.join(fakeHome, "Projects"), { recursive: true });
fs.writeFileSync(path.join(bin, "busctl"), "#!/bin/bash\nsleep 30\n", { mode: 0o755 });
fs.writeFileSync(path.join(bin, "notify-send"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${root}/notified.txt"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(fakeHome, "home-marker"), "the real (fake) home is visible\n");
// A fake /proc for the copy ramp: a calm machine, and no gap between copy starts.
const proc = path.join(root, "proc"); fs.mkdirSync(proc);
fs.writeFileSync(path.join(proc, "loadavg"), "0.10 0.50 0.50 1/500 999\n");
fs.writeFileSync(path.join(proc, "meminfo"), "MemTotal:       33554432 kB\nMemFree:        20971520 kB\nMemAvailable:   20971520 kB\n");
const worktrees = path.join(root, "worktrees");
assert.ok(path.isAbsolute(bin), `fake bin dir is not absolute: ${bin}`);
const env = { ...process.env, CONSTANCE_WORKTREES: worktrees, HOME: fakeHome, SQUAD_PROJECTS: path.join(fakeHome, "Projects"), XDG_STATE_HOME: state, PATH: `${bin}:${process.env.PATH}`, CONSTANCE_PROC: proc, CONSTANCE_RAMP_GAP_MS: "0", CONSTANCE_TOKENS_GAP_MS: "500", CONSTANCE_NO_NOTIFY: "1", XDG_DATA_HOME: path.join(fakeHome, ".local", "share") };
const run = (...a) => spawnSync("node", [CLI, ...a], { env, encoding: "utf8" });
const status = () => JSON.parse(run("status").stdout);
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
const histFile = path.join(cdir, "history.jsonl");
const logFile = path.join(cdir, "log.jsonl");
const recs = () => { try { return fs.readFileSync(histFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.kind); } catch { return []; } };
// Every driver/watcher pid seen, killed at the end so nothing outlives the test.
const pids = new Set();
const notePids = () => {
  const g = status().goal;
  if (g?.driverPid) pids.add(g.driverPid);
  if (g?.brainPid) pids.add(g.brainPid);
  try { const w = Number(fs.readFileSync(path.join(cdir, "watcher.pid"), "utf8")); if (w) pids.add(w); } catch {}
};

// Four goals queued: the first starts at once, the rest wait their turn.
assert.equal(run("goals", "add", "--goal", "queue-alpha: do the alpha thing", "--dir", repo).status, 0);
for (const t of ["queue-beta: do the beta thing", "queue-gamma: do the gamma thing", "queue-delta: do the delta thing"])
  assert.equal(run("goals", "add", "--goal", t, "--dir", repo).status, 0, t);
notePids();
// The fake goals finish in seconds, so by now alpha may already be done and beta running:
// just require a queued goal to be the active one.
assert.match(status().goal?.text || "", /^queue-(alpha|beta|gamma|delta)/, "a queued goal is running: " + JSON.stringify(status().goal));
// Beta hits the wall on its first run: the goal pauses, naming the limit, until the stated reset.
let wallUntil = 0;
assert.ok(await until(() => { const g = status().goal; return g && g.status === "paused" && /hit its limit/.test(g.pauseReason || ""); }, 240000),
  "beta paused by Claude's own limit wall: " + JSON.stringify(status().goal));
{
  const wall = JSON.parse(fs.readFileSync(path.join(cdir, "wall.json"), "utf8"));
  assert.ok(wall.stated && wall.until > Date.now(), "wall.json carries the stated reset: " + JSON.stringify(wall));
  wallUntil = wall.until;
  const pl = status().log.filter((l) => l.kind === "paused");
  assert.ok(pl.some((l) => /hit its limit/.test(l.text)), "the pause is in the log naming the limit");
  assert.ok(!status().log.some((l) => l.kind === "failed"), "no failure was logged for the wall");
}
// All four goals end: beta resumes after the reset, gamma fails for real, the queue drains.
// The poll keeps data.json fresh so the driver's 5-minute refresh never launches the real collector.
assert.ok(await until(() => { writeData(); return recs().length >= 4; }, 600000), "all four goals reached history.jsonl");
{
  const rs = recs();
  assert.equal(rs.length, 4, "four goal records: " + JSON.stringify(rs.map((r) => [r.text, r.status])));
  assert.deepEqual(rs.map((r) => r.status), ["done", "done", "failed", "done"], "alpha, beta and delta done; gamma failed");
  for (const [i, tag] of ["queue-alpha", "queue-beta", "queue-gamma", "queue-delta"].entries())
    assert.ok(rs[i].text.includes(tag), `record ${i} is ${tag}: ${rs[i].text}`);
  assert.match(rs[2].failReason, /boom: real failure/, "the failed goal kept its one-line reason: " + rs[2].failReason);
  assert.ok(Array.isArray(rs[2].endNotes) && rs[2].endNotes.length && /couldn't finish/.test(rs[2].endNotes[0]),
    "the failure is an end note, not a stop: " + JSON.stringify(rs[2].endNotes));
  assert.ok(rs[1].finishedAt > wallUntil, "beta finished only after the stated reset");
  const st = status();
  assert.deepEqual(st.board.goalQueue.goals, [], "the goal queue is empty");
  assert.equal(st.board.goalQueue.paused, "", "and not paused");
  const log = fs.readFileSync(logFile, "utf8");
  assert.ok(!log.includes('"kind":"needs-you"'), "nothing needed the owner: " + log.split("\n").filter((l) => l.includes("needs-you")).join("\n"));
  assert.match(log, /Goal ended with: [^\n]*The queue goes on\./, "the end note is logged as a note");
}
notePids();

// A goal that truly needs the owner still stops the queue: owner-stop flags it,
// the goal ends done, the queue pauses on the reason and epsilon keeps waiting.
writeData();
assert.equal(run("goals", "add", "--goal", "owner-stop: needs a decision", "--dir", repo).status, 0);
notePids();
assert.equal(run("goals", "add", "--goal", "queue-epsilon: the later goal", "--dir", repo).status, 0);
assert.ok(await until(() => { const g = status().goal; return g && g.text.includes("owner-stop") && g.status === "done"; }, 120000),
  "the owner-stop goal finished: " + JSON.stringify(status().goal));
await until(() => status().board.goalQueue.paused !== "", 10000);
{
  const st = status();
  assert.match(st.board.goalQueue.paused, /need a decision/, "the queue stopped naming the reason: " + st.board.goalQueue.paused);
  assert.equal(st.board.goalQueue.goals.length, 1, "one goal still waits");
  assert.ok(st.board.goalQueue.goals[0].text.includes("queue-epsilon"), "and it is the next one");
  const ny = st.log.filter((l) => l.kind === "needs-you" && /Goal queue stopped/.test(l.text));
  assert.equal(ny.length, 1, "one needs-you line for the stop: " + JSON.stringify(ny));
  const rs = recs();
  assert.equal(rs.length, 5, "the owner-stop goal is in history too");
  const last = rs.at(-1);
  assert.ok(last.text.includes("owner-stop") && /need a decision/i.test(last.needsOwner || ""), "history keeps the owner flag: " + JSON.stringify(last));
}
notePids();
for (const pid of pids) { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} } }
fs.rmSync(root, { recursive: true, force: true });
console.log("constance-queue4: tests passed");
