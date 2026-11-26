// End to end in a scratch state dir and repo, with fake `claude` and `grok` on PATH:
// a Claude session limit hit mid-goal makes the fake claude exit with Claude Code's
// "hit your ... limit · resets <time> (<zone>)" line. The driver must write wall.json,
// pause the goal (never a failure, never an owner ask) and leave her alone until the
// stated reset plus its grace — then resume her by herself on a current reading.
// Second goal: a Session window at 100% is a hard stop that Keep going can't override.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const CLI = new URL("./constance.mjs", import.meta.url).pathname;
// Same scratch-root pattern as constance.test.mjs: /var/tmp first (the sandbox shows it
// read-only), the real home is never touched.
let root = "";
for (const base of ["/var/tmp", path.join(os.homedir(), ".cache")]) {
  try { fs.mkdirSync(base, { recursive: true }); root = fs.mkdtempSync(path.join(base, "constance-wall-e2e-")); break; } catch {}
}
if (!root) root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-wall-e2e-"));
const state = path.join(root, "state"), bin = path.join(root, "bin"), repo = path.join(root, "repo");
const tabs = path.join(state, "omarchy/agent-usage-tabs");
const storeDir = path.join(tabs, "constance");
const dataFile = path.join(tabs, "data.json");
fs.mkdirSync(storeDir, { recursive: true }); fs.mkdirSync(bin); fs.mkdirSync(repo);
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
fs.writeFileSync(path.join(repo, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-qm", "init");

// data.json: Claude's Session percent is the knob the test turns (0.1 under the wall,
// 1.0 at it, back to 0.05 after). sessionReset is fixed up front so the keep-going.json
// the test drops keeps naming the same window resetsAt the whole run.
const sessionReset = Date.now() + 4 * 3600e3;
const writeData = (claudeSession = 0.1) => fs.writeFileSync(dataFile, JSON.stringify({ generatedAt: Date.now(), agents: [
  { id: "claude", installed: true, signedIn: true, limits: [
    { title: "Session", percent: claudeSession, resetsAt: new Date(sessionReset).toISOString() },
    { title: "Weekly", percent: 0.1, resetsAt: new Date(Date.now() + 150 * 3600e3).toISOString() }] },
  { id: "grok", installed: true, signedIn: true, limits: [{ title: "Daily", percent: 0.1 }] },
  { id: "devin", name: "Devin", installed: true, signedIn: true, limits: [{ title: "Daily", percent: 0.1 }] },
]}));
writeData();
fs.writeFileSync(path.join(tabs, "settings.json"), JSON.stringify({ constancePractice: false, constanceUseItOrLoseIt: false }));

// Fake grok: the done file path is in the prompt (last argument); it edits the one file
// the prompt allows and commits it, like the fake in constance.test.mjs but with no
// go-file wait — this test is about Constance's wall, not job pacing.
fs.writeFileSync(path.join(bin, "grok"), `#!/bin/bash
p="\${@: -1}"; f=$(grep -o '/[^ ]*/.constance/done-[0-9]*.json' <<<"$p" | head -1)
[[ -n "$f" ]] || exit 0   # not a job prompt (the collector runs e.g. "grok models"): never touch the cwd
sleep 1
name=$(sed -n 's/^Only edit these files: \\([^ ,]*\\)\\..*/\\1/p' <<<"$p" | head -1); name=\${name:-x.txt}
before=$(git rev-parse HEAD)
echo "grok $name" > "$name"; git add "$name"; git commit -qm "grok: $name" || true
after=$(git rev-parse HEAD); c=""; [[ "$after" != "$before" ]] && c="$after"
echo "{\\"summary\\": \\"added \${name%.*}\\", \\"commit\\": \\"$c\\", \\"files\\": [\\"$name\\"]}" > "$f"
`, { mode: 0o755 });

// Fake Constance (the claude CLI). Each run appends a tag to claude-runs.log so the test
// can count her starts without tripping over the multi-line role prompt:
//   wall-first — the wall goal's first run: delegates the job, then exits 1 with Claude
//     Code's real limit line and a reset two minutes out (computed at run time, in UTC).
//   resume    — any --resume run (only the wall goal ever resumes): waits for the job,
//     accepts it and reports.
//   hundred   — the 100% goal's first run: a normal delegate/wait/review/report.
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
C="node ${CLI}"
p="\${@: -1}"
if [[ "$*" == *" --resume "* ]]; then tag="resume"
elif [[ "$p" == *wall-pause-goal* ]]; then tag="wall-first"
elif [[ "$p" == *hundred-goal* ]]; then tag="hundred"
else tag="other"; fi
echo "$tag" >> "${root}/claude-runs.log"
if [[ "$tag" == "resume" ]]; then
  $C wait --timeout 120 > "${root}/wait-resume.json" 2>>"${root}/brain-resume.out"
  id=$(grep -o '"id": [0-9]*' "${root}/wait-resume.json" | head -1 | grep -o '[0-9]*')
  [ -n "$id" ] && $C review "$id" accept --note "verified after the reset" >> "${root}/brain-resume.out" 2>&1
  echo "Resumed report: the wall is over and job $id is reviewed."
  exit 0
elif [[ "$tag" == "wall-first" ]]; then
  $C delegate --agent grok --files w.txt --task "add w for the wall goal" >> "${root}/brain-wall.out" 2>&1
  reset=$(date -u -d '+120 seconds' '+%b %d, %H:%M')
  echo "You've hit your 5-hour limit · resets $reset (UTC)"
  exit 1
elif [[ "$tag" == "hundred" ]]; then
  $C delegate --agent grok --files h.txt --task "add h for the hundred goal" >> "${root}/brain-hundred.out" 2>&1
  $C wait --timeout 120 > "${root}/wait-hundred.json" 2>>"${root}/brain-hundred.out"
  id=$(grep -o '"id": [0-9]*' "${root}/wait-hundred.json" | head -1 | grep -o '[0-9]*')
  [ -n "$id" ] && $C review "$id" accept --note "ok" >> "${root}/brain-hundred.out" 2>&1
  echo "Hundred report: done once the reading dropped."
  exit 0
fi
echo "unexpected prompt" >&2
exit 1
`, { mode: 0o755 });

// A fake home and projects folder (the guard snapshots HOME and ~/Projects), a quiet
// fake busctl so no watcher hears the real session bus, and a fake notify-send so a
// needs-you never pops a real notification.
const fakeHome = path.join(root, "home"); fs.mkdirSync(path.join(fakeHome, "Projects"), { recursive: true });
fs.writeFileSync(path.join(bin, "busctl"), "#!/bin/bash\nsleep 30\n", { mode: 0o755 });
fs.writeFileSync(path.join(bin, "notify-send"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${root}/notified.txt"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(fakeHome, "home-marker"), "the real (fake) home is visible\n");
// Fake /proc for the copy ramp and no gap between copy starts (same as constance.test.mjs).
const proc = path.join(root, "proc"); fs.mkdirSync(proc);
fs.writeFileSync(path.join(proc, "loadavg"), "0.10 0.50 0.50 1/500 999\n");
fs.writeFileSync(path.join(proc, "meminfo"), "MemTotal:       33554432 kB\nMemFree:        20971520 kB\nMemAvailable:   20971520 kB\n");
const worktrees = path.join(root, "worktrees");
const env = { ...process.env, CONSTANCE_WORKTREES: worktrees, HOME: fakeHome, SQUAD_PROJECTS: path.join(fakeHome, "Projects"),
  XDG_STATE_HOME: state, XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"),
  XDG_DATA_HOME: path.join(fakeHome, ".local", "share"), PATH: `${bin}:${process.env.PATH}`,
  CONSTANCE_PROC: proc, CONSTANCE_RAMP_GAP_MS: "0", CONSTANCE_TOKENS_GAP_MS: "500", CONSTANCE_NO_NOTIFY: "1" };
const run = (...a) => spawnSync("node", [CLI, ...a], { env, encoding: "utf8" });
const status = () => JSON.parse(run("status").stdout);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000, step = 200) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return false; };
// Cheap reads straight from her state files — status() spawns a whole CLI call, so the
// tight poll loops use these and only call status() where a field needs computing.
const goal = () => { try { return JSON.parse(fs.readFileSync(path.join(storeDir, "jobs.json"), "utf8")).goal; } catch { return null; } };
const allJobs = () => { try { return JSON.parse(fs.readFileSync(path.join(storeDir, "jobs.json"), "utf8")).jobs; } catch { return []; } };
const logLines = () => { try { return fs.readFileSync(path.join(storeDir, "log.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const claudeRuns = () => { try { return fs.readFileSync(path.join(root, "claude-runs.log"), "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };
const wallPath = path.join(storeDir, "wall.json");
const keepGoingPath = path.join(storeDir, "keep-going.json");

try {
  // ---- Goal 1: her own session limit mid-goal. wall.json gets the stated reset, the goal
  // pauses (not a failure, no needs-you), nothing restarts her before the time, and once
  // it passes with a current reading she resumes on her own and finishes.
  assert.equal(run("start", "--dir", repo, "--goal", "wall-pause-goal: add w.txt via a worker").status, 0);
  assert.ok(await until(() => fs.existsSync(wallPath) && goal()?.status === "paused", 60000),
    "the limit exit paused the goal: " + JSON.stringify(goal()));
  const wall = JSON.parse(fs.readFileSync(wallPath, "utf8"));
  assert.equal(wall.stated, true, "the reset time was read from Claude's line");
  assert.match(wall.text, /hit your/, "wall.json keeps Claude's own words");
  assert.ok(wall.until > Date.now(), "the wall stands until the stated reset");
  assert.ok(wall.until - wall.at > 30e3 && wall.until - wall.at < 200e3, `until is about two minutes out, got ${wall.until - wall.at} ms`);
  {
    const g = goal(), st = status();
    assert.match(g.pauseReason, /hit its limit/, "the pause reason names the wall");
    assert.equal(st.pace.mode, "stop", "pace honors the wall over a low reading");
    assert.equal(st.pace.hard, true);
    assert.deepEqual(claudeRuns(), ["wall-first"], "she ran once and was not restarted");
    assert.ok(!logLines().some((l) => l.kind === "failed"), "the wall is not a failure");
    assert.ok(!logLines().some((l) => l.kind === "needs-you"), "she never asked the owner");
    assert.ok(!g.needsOwner, "the goal carries no needs-owner flag");
  }
  // Until the stated reset she stays paused and claude is never started again; data.json is
  // rewritten as it goes so the driver's fresh-data check never fires the real collector.
  let lastData = 0;
  const resumedAndDone = await until(() => {
    const now = Date.now();
    if (now - lastData > 20000) { writeData(0.1); lastData = now; }
    const g = goal();
    if (g?.status === "done") return true;
    if (now < wall.until) {
      assert.equal(g?.status, "paused", "still paused before the stated reset");
      assert.deepEqual(claudeRuns(), ["wall-first"], "no restart into the wall before the reset");
    }
    return false;
  }, 360000);
  assert.ok(resumedAndDone, "the goal resumed by itself and finished: " + JSON.stringify(goal()));
  {
    const g = goal(), lines = logLines();
    const resumed = lines.find((l) => l.kind === "resumed");
    assert.ok(resumed, "a resumed entry is in the log");
    assert.match(resumed.text, /stated reset/, "the log says the wall's reset ended the pause");
    assert.ok(resumed.at >= wall.until + 60e3 - 1000, `she waited for the reset plus the grace (resumed at ${resumed.at}, until ${wall.until})`);
    assert.deepEqual(claudeRuns(), ["wall-first", "resume"], "exactly one wall exit and one resume");
    assert.ok(!lines.some((l) => l.kind === "failed"), "nothing was ever counted as a failure");
    assert.ok(!lines.some((l) => l.kind === "needs-you"), "she never stopped to ask");
    assert.match(g.report || "", /Resumed report/, "the resumed run reported");
    const job = allJobs().find((j) => j.files?.includes("w.txt"));
    assert.equal(job?.status, "accepted", "the job she delegated before the wall was reviewed");
  }

  // ---- Goal 2: Session at 100% is a hard stop. Keep going is set for exactly that window,
  // yet she stays paused and claude never starts; once a current reading drops under the
  // wall she resumes on the reading's say-so (not the owner's button).
  writeData(1.0);
  fs.writeFileSync(keepGoingPath, JSON.stringify({ title: "Session", resetsAt: sessionReset, at: Date.now() }));
  assert.equal(run("start", "--dir", repo, "--goal", "hundred-goal: add h.txt via a worker").status, 0);
  assert.ok(await until(() => goal()?.status === "paused" && /100%/.test(goal()?.pauseReason || ""), 30000),
    "paused at 100%: " + JSON.stringify(goal()));
  {
    const st = status();
    assert.equal(st.pace.mode, "stop"); assert.equal(st.pace.hard, true);
    assert.match(st.goal.pauseReason, /100%/, "the pause reason is the hard stop, not the wall");
  }
  // Keep going can't override a window at 100%: over a full driver cycle she stays paused,
  // pace stays a hard stop and claude is never started.
  const obsEnd = Date.now() + 75000;
  while (Date.now() < obsEnd) {
    const g = goal();
    assert.equal(g?.status, "paused", "still paused at 100% despite Keep going");
    assert.match(g.pauseReason, /100%/);
    assert.ok(!claudeRuns().some((t) => t === "hundred"), "Keep going did not start her into the wall");
    await sleep(500);
  }
  {
    const st = status();
    assert.equal(st.pace.mode, "stop"); assert.equal(st.pace.hard, true, "still a hard stop after a full cycle");
    assert.ok(fs.existsSync(keepGoingPath), "the keep-going file was there the whole time");
  }
  // The reading drops under the wall: she resumes on it, not on Keep going.
  let lastData2 = 0;
  const finished2 = await until(() => {
    const now = Date.now();
    if (now - lastData2 > 20000) { writeData(0.05); lastData2 = now; }
    return goal()?.status === "done";
  }, 240000);
  assert.ok(finished2, "the 100% goal finished after the reading dropped: " + JSON.stringify(goal()));
  {
    const g = goal(), lines = logLines();
    const resumed = lines.filter((l) => l.kind === "resumed").at(-1);
    assert.ok(resumed, "she resumed once the reading was current and low");
    assert.match(resumed.text, /Back under her limits/, "the reading — not Keep going — freed her");
    assert.doesNotMatch(resumed.text, /Keep going/);
    assert.deepEqual(claudeRuns(), ["wall-first", "resume", "hundred"], "three brain runs in total, none into a wall");
    assert.ok(!lines.some((l) => l.kind === "failed"), "still no failure");
    assert.ok(!lines.some((l) => l.kind === "needs-you"), "still no owner ask");
    assert.match(g.report || "", /Hundred report/, "the second goal reported");
    const job = allJobs().find((j) => j.files?.includes("h.txt"));
    assert.equal(job?.status, "accepted");
  }
} finally {
  try { run("stop"); } catch {}
  await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
console.log("e2e-session-wall: ok");
