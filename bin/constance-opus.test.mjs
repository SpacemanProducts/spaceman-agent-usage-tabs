// End to end, in a scratch state dir, repo and fake home (never the owner's), with fake `claude`,
// `grok` and `notify-send` on PATH:
//   1. A grok job writes half its file, then goes silent. It is flagged stuck (the idle window is
//      shortened for the test), the owner is notified once, and "takeover" hands it to Opus, which
//      sees the original task, the partial diff and the log tail, finishes it in the same folder and
//      is reviewed and accepted like any job. Its card shows Opus.
//   2. With the Milk Opus slider at 80 a stuck job goes to Opus by itself.
//   3. A paused goal queue: the current goal runs on, the next queued goal doesn't start (not after it
//      ends, not on a restart, not with Start next) while goals are still added, edited, moved and
//      removed; Resume queue starts it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const CLI = new URL("./constance.mjs", import.meta.url).pathname;
// Jobs run sandboxed, where /tmp is a fresh folder per job: the fakes live in /var/tmp (or ~/.cache
// when /var/tmp can't be used), which the sandbox shows read-only.
let root = "";
for (const base of ["/var/tmp", path.join(os.homedir(), ".cache")]) {
  try { fs.mkdirSync(base, { recursive: true }); root = fs.mkdtempSync(path.join(base, "constance-opus-")); break; } catch {}
}
if (!root) root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-opus-"));
const state = path.join(root, "state"), bin = path.join(root, "bin"), repo = path.join(root, "repo");
const tabs = path.join(state, "omarchy/agent-usage-tabs");
fs.mkdirSync(tabs, { recursive: true }); fs.mkdirSync(bin); fs.mkdirSync(repo);
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
fs.writeFileSync(path.join(repo, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-qm", "init");

const soon = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const writeData = () => fs.writeFileSync(path.join(tabs, "data.json"), JSON.stringify({ generatedAt: Date.now(), agents: [
  { id: "claude", installed: true, signedIn: true, limits: [{ title: "Session", percent: 0.1, resetsAt: soon(4) }, { title: "Weekly", percent: 0.1, resetsAt: soon(150) }] },
  { id: "grok", name: "Grok", installed: true, signedIn: true, limits: [{ title: "Daily", percent: 0.1 }] }] }));
writeData();
const settings = (extra = {}) => fs.writeFileSync(path.join(tabs, "settings.json"), JSON.stringify({ constancePractice: false, constanceUseItOrLoseIt: false, ...extra }));
settings();

// Fake grok: writes "half" into its one file, says so in its log, then hangs silently.
fs.writeFileSync(path.join(bin, "grok"), `#!/bin/bash
p="\${@: -1}"
name=$(sed -n 's/^Only edit these files: \\([^ ,]*\\)\\..*/\\1/p' <<<"$p" | head -1)
echo "grok: working on $name"
echo half > "$name"
sleep 600
`, { mode: 0o755 });
// Fake claude. As Constance (her system prompt is appended): a QUEUE-GOAL N waits for release-N and
// ticks its item; any other goal delegates FILE=x to grok and reviews whatever comes back. As the Opus
// worker (no system prompt): checks the partial work is there, finishes the file, commits, writes
// its done file — the path comes from the prompt, as for every worker.
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
C="node ${CLI}"
if [[ " $* " == *" --append-system-prompt "* ]]; then
  goal="\${@: -1}"
  n=$(grep -o 'QUEUE-GOAL [0-9]*' <<<"$goal" | head -1 | cut -d' ' -f2)
  if [[ -n "$n" ]]; then
    echo "$n" >> "${root}/goals-run.txt"
    while [[ ! -e "${root}/release-$n" ]]; do sleep 0.2; done
    $C check 1; exit 0
  fi
  f=$(grep -o 'FILE=[a-z0-9]*\\.txt' <<<"$goal" | head -1 | cut -d= -f2)
  $C delegate --agent grok --files "$f" --task "finish $f" >> "${root}/brain.out" 2>&1
  for i in $(seq 1 40); do
    out=$($C wait --timeout 15)
    id=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.review?String(j.review.id):"")}catch{}})' <<<"$out")
    if [[ -n "$id" ]]; then $C review "$id" accept --note "opus finished it" >> "${root}/brain.out" 2>&1; break; fi
  done
  echo "Report: done."
  exit 0
fi
p="\${@: -1}"
d=$(grep -o '/[^ ]*/.constance/done-[0-9]*.json' <<<"$p" | head -1)
[[ -n "$d" ]] || exit 0   # not a job prompt (the collector runs e.g. "grok models"): never touch the cwd
name=$(sed -n 's/^Only edit these files: \\([^ ,]*\\)\\..*/\\1/p' <<<"$p" | head -1)
ok=yes
grep -q '^half$' "$name" || ok=no
grep -q 'Taking over: Grok started this job' <<<"$p" || ok=no
grep -q 'grok: working on' <<<"$p" || ok=no
grep -q "^finish $name" <<<"$p" || ok=no
echo "opus: partial work seen=$ok"
echo "done by opus (saw=$ok)" > "$name"; git add "$name"; git commit -qm "opus: $name"
echo "{\\"summary\\": \\"finished $name (saw=$ok)\\", \\"commit\\": \\"$(git rev-parse HEAD)\\", \\"files\\": [\\"$name\\"]}" > "$d"
`, { mode: 0o755 });
// A fake home and projects folder (the guard snapshots them), a quiet busctl and a recording notify-send.
const fakeHome = path.join(root, "home"); fs.mkdirSync(path.join(fakeHome, "Projects"), { recursive: true });
fs.writeFileSync(path.join(bin, "busctl"), "#!/bin/bash\nsleep 30\n", { mode: 0o755 });
fs.writeFileSync(path.join(bin, "notify-send"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${root}/notified.txt"\n`, { mode: 0o755 });
const proc = path.join(root, "proc"); fs.mkdirSync(proc);
fs.writeFileSync(path.join(proc, "loadavg"), "0.10 0.50 0.50 1/500 999\n");
fs.writeFileSync(path.join(proc, "meminfo"), "MemTotal:       33554432 kB\nMemFree:        20971520 kB\nMemAvailable:   20971520 kB\n");
const env = { ...process.env, CONSTANCE_WORKTREES: path.join(root, "worktrees"), HOME: fakeHome, SQUAD_PROJECTS: path.join(fakeHome, "Projects"),
  XDG_STATE_HOME: state, XDG_DATA_HOME: path.join(fakeHome, ".local", "share"), PATH: `${bin}:${process.env.PATH}`, CONSTANCE_PROC: proc,
  CONSTANCE_RAMP_GAP_MS: "0", CONSTANCE_TOKENS_GAP_MS: "500", CONSTANCE_NO_NOTIFY: "1",
  // Stuck after 3 s of silence, looked at on every sweep (the real windows are 15 min and 30 s).
  CONSTANCE_STUCK_IDLE_MS: "3000", CONSTANCE_STUCK_CHECK_MS: "0" };
const run = (...a) => spawnSync("node", [CLI, ...a], { env, encoding: "utf8" });
const status = () => JSON.parse(run("status").stdout);
const until = async (fn, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
const notified = () => { try { return fs.readFileSync(path.join(root, "notified.txt"), "utf8"); } catch { return ""; } };
const card = (id) => (status().board.cards || []).find((c) => c.id === id);
const job = (id) => JSON.parse(run("job", String(id)).stdout);

try {
  // ------------------------------------------------------------ 1. stuck, then Give it to Opus
  assert.equal(run("takeover", "1").status, 1, "no goal, nothing to take over");
  assert.equal(run("start", "--dir", repo, "--goal", "finish FILE=h1.txt").status, 0);
  assert.ok(await until(() => status().jobs.some((j) => j.id === 1 && j.status === "running")), "grok is running job 1");
  let c = card(1);
  assert.equal(c.canTakeOver, true, "a running card offers Give it to Opus");
  assert.equal(c.worker, "Grok");
  assert.ok(await until(() => card(1)?.stuck !== ""), "job 1 is flagged stuck after its silence");
  assert.match(card(1).stuck, /no file changes and no log output/);
  assert.match(notified(), /Job 1 looks stuck/, "the owner is notified");
  assert.match(notified(), /press Give it to Opus/, "slider at its default: not handed over automatically");
  assert.equal(status().jobs.find((j) => j.id === 1).agent, "grok", "still grok's");
  await new Promise((r) => setTimeout(r, 1500)); status();
  assert.equal((notified().match(/Job 1 looks stuck/g) || []).length, 1, "notified once");
  assert.equal(fs.readFileSync(path.join(repo, "h1.txt"), "utf8"), "half\n", "grok's partial change is there");
  const grokPid = status().jobs.find((j) => j.id === 1).pid;

  const r = run("takeover", "1");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Opus took over job 1 from Grok/);
  assert.match(run("takeover", "1").stderr + run("takeover", "1").stdout, /already Opus's|not running/, "only once");
  let alive = true; try { process.kill(grokPid, 0); } catch { alive = false; }
  assert.equal(alive, false, "grok was stopped");
  assert.ok(await until(() => status().goal.status === "done", 40000), "the goal finishes: " + JSON.stringify(status().goal));
  const j1 = job(1);
  assert.equal(j1.status, "accepted", "Opus's work went through the normal review");
  assert.equal(j1.agent, "claude"); assert.equal(j1.worker, "Opus");
  assert.equal(j1.handedFrom.agent, "grok"); assert.equal(j1.handedFrom.auto, false);
  assert.deepEqual(j1.files, ["h1.txt"], "same file list");
  assert.ok(!j1.guardViolation, "the guard checked it and found nothing");
  assert.match(j1.summary, /finished h1\.txt \(saw=yes\)/, "Opus saw the task, the partial diff and the log tail");
  assert.ok(j1.prompt.startsWith(j1.workerPrompt), "Opus got the original prompt first");
  assert.match(j1.prompt, /Check: this job is for the project folder/);
  assert.match(j1.prompt, /--- new file h1\.txt ---\nhalf\n/, "with the partial diff");
  assert.match(j1.workerPrompt, /finish h1\.txt/);
  assert.equal(fs.readFileSync(path.join(repo, "h1.txt"), "utf8"), "done by opus (saw=yes)\n");
  assert.match(git("log", "-1", "--format=%s"), /opus: h1\.txt/);
  const log = fs.readFileSync(status().jobs.find((j) => j.id === 1).log, "utf8");   // `job` puts its log entries under .log
  assert.match(log, /grok: working on h1/, "grok's log is kept");
  assert.match(log, /handed to Opus/); assert.match(log, /opus: partial work seen=yes/, "Opus's output follows it");
  const s1 = status();
  assert.ok(s1.log.some((e) => e.kind === "stuck" && e.job === 1));
  assert.ok(s1.log.some((e) => e.kind === "takeover" && e.job === 1 && e.worker === "Opus"));
  c = card(1);
  assert.equal(c.worker, "Opus"); assert.equal(c.handedFrom, "Grok"); assert.equal(c.canTakeOver, false); assert.equal(c.stuck, "");

  // ------------------------------------------------------------ 2. Milk Opus high: automatic handoff
  settings({ constanceMilk: 80 });
  assert.equal(status().milk.autoTakeover, true);
  assert.equal(run("start", "--dir", repo, "--goal", "finish FILE=h2.txt").status, 0);
  assert.ok(await until(() => status().goal.status === "done", 45000), "the second goal finishes: " + JSON.stringify(status().goal));
  const j2 = status().jobs.find((j) => j.files[0] === "h2.txt");
  assert.equal(j2.status, "accepted"); assert.equal(j2.worker, "Opus");
  assert.equal(j2.handedFrom.auto, true, "handed over by itself");
  assert.match(j2.handedFrom.reason, /looked stuck/);
  assert.match(notified(), new RegExp(`Job ${j2.id} looks stuck.*handed to Opus automatically`));
  assert.equal(fs.readFileSync(path.join(repo, "h2.txt"), "utf8"), "done by opus (saw=yes)\n");
  settings();

  // ------------------------------------------------------------ 3. Pause queue
  assert.equal(run("start", "--dir", repo, "--goal", "QUEUE-GOAL 1").status, 0);
  assert.ok(await until(() => fs.existsSync(path.join(root, "goals-run.txt"))), "goal 1 runs");
  assert.match(run("goals", "pause").stdout, /Queue paused/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tabs, "constance", "goal-queue.json"), "utf8")).ownerPaused, true, "kept on disk");
  assert.match(run("goals", "add", "--goal", "QUEUE-GOAL 2", "--dir", repo).stdout, /queue is paused/);
  run("goals", "add", "--goal", "QUEUE-GOAL 9", "--dir", repo);
  run("goals", "add", "--goal", "QUEUE-GOAL 3", "--dir", repo);
  let q = JSON.parse(run("goals").stdout);
  assert.equal(q.ownerPaused, true);
  const id = (n) => q.goals.find((g) => g.text === `QUEUE-GOAL ${n}`).id;
  assert.equal(run("goals", "move", id(3), "top").status, 0, "reorder while paused");
  assert.equal(run("goals", "rm", id(9)).status, 0, "remove while paused");
  assert.equal(run("goals", "edit", id(2), "--goal", "QUEUE-GOAL 2 (edited)").status, 0, "edit while paused");
  q = JSON.parse(run("goals").stdout);
  assert.deepEqual(q.goals.map((g) => g.text), ["QUEUE-GOAL 3", "QUEUE-GOAL 2 (edited)"]);
  assert.equal(status().goal.status, "running", "the current goal keeps running");
  fs.writeFileSync(path.join(root, "release-1"), "");
  assert.ok(await until(() => status().goal.status === "done"), "goal 1 ends");
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(fs.readFileSync(path.join(root, "goals-run.txt"), "utf8"), "1\n", "the next goal did not start");
  assert.equal(status().goal.text, "QUEUE-GOAL 1");
  assert.equal(JSON.parse(run("goals").stdout).goals.length, 2, "both still queued");
  assert.match(status().board.now, /Queue paused: 2 goals wait for Resume queue/);
  assert.ok(status().log.some((e) => e.kind === "queue" && /2 goals wait until you press Resume queue/.test(e.text)));
  // A restart (the panel's recover) and Start next don't start it either.
  assert.equal(run("recover").stdout.trim(), "ok");
  const nx = run("goals", "next");
  assert.notEqual(nx.status, 0); assert.match(nx.stderr, /paused: press Resume queue/);
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(fs.readFileSync(path.join(root, "goals-run.txt"), "utf8"), "1\n");
  // Resume: the first queued goal starts now, and the queue runs on by itself after it.
  assert.match(run("goals", "resume").stdout, /on it: QUEUE-GOAL 3/);
  assert.equal(JSON.parse(run("goals").stdout).ownerPaused, false);
  assert.ok(await until(() => fs.readFileSync(path.join(root, "goals-run.txt"), "utf8") === "1\n3\n"), "goal 3 started on resume");
  fs.writeFileSync(path.join(root, "release-3"), ""); fs.writeFileSync(path.join(root, "release-2"), "");
  assert.ok(await until(() => fs.readFileSync(path.join(root, "goals-run.txt"), "utf8") === "1\n3\n2\n" && status().goal.status === "done"), "then goal 2, unpaused");
  assert.equal(JSON.parse(run("goals").stdout).goals.length, 0);
  console.log("constance-opus: ok");
} finally {
  run("stop");
  fs.rmSync(root, { recursive: true, force: true });
}
