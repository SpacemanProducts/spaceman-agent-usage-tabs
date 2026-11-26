// End to end for the panel's data path: while a real (faked) goal runs — jobs
// start in worktrees, finish, self-merge and get reviewed — a tight loop reads
// every JSON file the panel parses and runs `constance.mjs status` / `jobs`
// over and over. Every read must come back as complete, valid JSON with the
// fields Panel.qml uses: no torn writes, no empty files, no partial stdout.
//
// What the panel reads (Panel.qml):
//   - <state>/omarchy/agent-usage-tabs/data.json        (FileView, watchChanges)
//   - <state>/omarchy/agent-usage-tabs/settings.json   (FileView)
//   - <state>/omarchy/agent-usage-tabs/handoff-pending.json (FileView)
//   - <state>/omarchy/agent-usage-tabs/antigravity-surprise.json (FileView)
//   - `node bin/constance.mjs status` stdout           (constanceReader, every 3 s)
//   - `node bin/constance.mjs job ID` stdout           (constanceJobReader)
// `status` itself reads her state dir: jobs.json, log.jsonl, history.jsonl,
// goal-queue.json, queue.json, reviews.json, scorecard.json, wall.json,
// refills.json, spare.json, leverage.jsonl, ratio-samples.jsonl, notify.jsonl,
// asks.jsonl, routes.jsonl and data.json/settings.json again.
//
// Atomicity audit (temp file + rename) — see the BUG notes at the bottom for
// the writers that don't do this.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const CLI = new URL("./constance.mjs", import.meta.url).pathname;
const HERE = new URL(".", import.meta.url).pathname;

// ---- scratch world (same shape as constance.test.mjs) ---------------------
let root = "";
for (const base of ["/var/tmp", path.join(os.homedir(), ".cache")]) {
  try { fs.mkdirSync(base, { recursive: true }); root = fs.mkdtempSync(path.join(base, "constance-panel-e2e-")); break; } catch {}
}
if (!root) root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-panel-e2e-"));
const state = path.join(root, "state"), bin = path.join(root, "bin"), repo = path.join(root, "repo");
const fakeHome = path.join(root, "home");
const tabs = path.join(state, "omarchy/agent-usage-tabs");
const cdir = path.join(tabs, "constance");
for (const d of [tabs, cdir, bin, repo, path.join(fakeHome, "Projects")]) fs.mkdirSync(d, { recursive: true });

const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
fs.writeFileSync(path.join(repo, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-qm", "init");

const soon = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const agents = () => [
  { id: "claude", installed: true, signedIn: true, limits: [{ title: "Session", percent: 0.1, resetsAt: soon(4) }, { title: "Weekly", percent: 0.1, resetsAt: soon(150) }] },
  { id: "grok", installed: true, signedIn: true, limits: [{ title: "Daily", percent: 0.1 }] },
  { id: "devin", name: "Devin", installed: true, signedIn: true, limits: [{ title: "Daily", percent: 0.1 }] },
  { id: "copilot", installed: true, signedIn: true, limits: [{ title: "Monthly", percent: 0.94 }] },
];
const dataPath = path.join(tabs, "data.json");
// The collector's own write pattern (collect.mjs): temp file + rename, mode 0600.
const writeDataJson = () => {
  const tmp = `${dataPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, version: "test", generatedAt: Date.now(), agents: agents(), weekly: {} }, null, 1) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, dataPath);
};
writeDataJson();
fs.writeFileSync(path.join(tabs, "settings.json"), JSON.stringify({ constancePractice: false }));

// ---- fake agents -----------------------------------------------------------
// Fake devin: a careful copy worker — pwd and done-file checks first, waits for
// the go-file, edits the one file its prompt allows, commits it on its own
// branch and reports tests passed (the "selfmerge" word in the task is what
// makes it claim that, same trick as constance.test.mjs).
fs.writeFileSync(path.join(bin, "devin"), `#!/bin/bash
p="\${@: -1}"; f=$(grep -o '/[^ ]*/.constance/done-[0-9]*.json' <<<"$p" | head -1)
want=$(grep -o 'if it is not exactly [^ ]*, stop now' <<<"$p" | head -1 | sed 's/^if it is not exactly //; s/, stop now$//')
here=$(pwd)
[[ -n "$want" && "$here" == "$want" ]] || { echo "pwd check failed: here=$here want=$want"; exit 1; }
[[ "$f" == "$here/.constance/"* ]] || { echo "done file $f is not in $here"; exit 1; }
while [[ ! -e "${root}/go" ]]; do sleep 0.2; done
while [[ ! -e "${root}/reads-ok" ]]; do sleep 0.2; done
name=$(sed -n 's/^Only edit these files: \\([^ ,]*\\)\\..*/\\1/p' <<<"$p" | head -1); name=\${name:-x.txt}
before=$(git rev-parse HEAD)
echo "devin $name" > "$name"; git add "$name"; git commit -qm "devin: $name" || true
after=$(git rev-parse HEAD); c=""; [[ "$after" != "$before" ]] && c="$after"
t=""; grep -q selfmerge <<<"$p" && t=', "tests": "pass"'
echo "{\\"summary\\": \\"added \${name%.*}\\", \\"commit\\": \\"$c\\", \\"files\\": [\\"$name\\"]$t}" > "$f"
`, { mode: 0o755 });
// Fake grok: a shared-folder worker. A read-only job only reports; it waits for
// the same go-file so the test can watch a running job.
fs.writeFileSync(path.join(bin, "grok"), `#!/bin/bash
p="\${@: -1}"; f=$(grep -o '/[^ ]*/.constance/done-[0-9]*.json' <<<"$p" | head -1)
while [[ ! -e "${root}/go" ]]; do sleep 0.2; done
while [[ ! -e "${root}/reads-ok" ]]; do sleep 0.2; done
if grep -qi "read-only job" <<<"$p"; then
  echo '{"summary": "a.txt has one line", "commit": "", "files": []}' > "$f"
else
  sleep 1
  name=$(sed -n 's/^Only edit these files: \\([^ ,]*\\)\\..*/\\1/p' <<<"$p" | head -1); name=\${name:-g.txt}
  echo x > "$name"; git add "$name"; git commit -qm "grok: $name" || true
  echo "{\\"summary\\": \\"added \${name%.*}\\", \\"commit\\": \\"$(git rev-parse HEAD)\\", \\"files\\": [\\"$name\\"]}" > "$f"
fi
`, { mode: 0o755 });
// Fake Constance: three copy jobs for devin (own worktrees, self-merge), one
// read-only job for grok (shared folder), then wait/review each until all are
// accepted. Review is retried: a status poll's sweep can mark a job
// self-merging in the gap between `wait` handing it out and `review`.
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
C="node ${CLI}"
$C delegate --agent devin --files b.txt --task "add b selfmerge" >> "${root}/brain.out" 2>&1
$C delegate --agent devin --files c.txt --task "add c selfmerge" >> "${root}/brain.out" 2>&1
$C delegate --agent devin --files d.txt --task "add d selfmerge" >> "${root}/brain.out" 2>&1
$C delegate --agent grok --task "read-only job: summarize a.txt in a few lines, change nothing" >> "${root}/brain.out" 2>&1
touch "${root}/go"
for i in 1 2 3 4; do
  $C wait --timeout 600 > "${root}/wait-$i.json"
  id=$(node -e 'const w=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(w.review?String(w.review.id):"")' "${root}/wait-$i.json")
  [ -z "$id" ] && break
  for try in $(seq 1 90); do
    $C review "$id" accept --note "ok" >> "${root}/brain.out" 2>&1 && break
    sleep 1
  done
done
echo "Report: four jobs ran, merged and were reviewed."
`, { mode: 0o755 });
// Quiet fakes so nothing touches the real session bus or pops real notifications.
fs.writeFileSync(path.join(bin, "busctl"), "#!/bin/bash\nsleep 30\n", { mode: 0o755 });
fs.writeFileSync(path.join(bin, "notify-send"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${root}/notified.txt"\n`, { mode: 0o755 });
fs.writeFileSync(path.join(fakeHome, "home-marker"), "fake home\n");
const proc = path.join(root, "proc"); fs.mkdirSync(proc);
fs.writeFileSync(path.join(proc, "loadavg"), "0.10 0.50 0.50 1/500 999\n");
fs.writeFileSync(path.join(proc, "meminfo"), "MemTotal:       33554432 kB\nMemFree:        20971520 kB\nMemAvailable:   20971520 kB\n");
const worktrees = path.join(root, "worktrees");
const env = {
  ...process.env,
  CONSTANCE_WORKTREES: worktrees,
  HOME: fakeHome,
  SQUAD_PROJECTS: path.join(fakeHome, "Projects"),
  XDG_STATE_HOME: state,
  XDG_CONFIG_HOME: path.join(fakeHome, ".config"),
  XDG_CACHE_HOME: path.join(fakeHome, ".cache"),
  XDG_DATA_HOME: path.join(fakeHome, ".local", "share"),
  PATH: `${bin}:${process.env.PATH}`,
  CONSTANCE_PROC: proc,
  CONSTANCE_RAMP_GAP_MS: "0",
  CONSTANCE_TOKENS_GAP_MS: "500",
};
const run = (...a) => spawnSync("node", [CLI, ...a], { env, encoding: "utf8", timeout: 120e3 });
const jobsFile = path.join(cdir, "jobs.json");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// ---- the shapes Panel.qml depends on ---------------------------------------
function assertDataJson(d, where) {
  assert.ok(d && typeof d === "object" && !Array.isArray(d), `${where}: data.json is an object`);
  assert.ok(Number(d.generatedAt) > 0, `${where}: data.json generatedAt`);
  assert.ok(typeof d.version === "string", `${where}: data.json version`);
  assert.ok(Array.isArray(d.agents), `${where}: data.json agents is an array`);
  assert.ok(d.weekly && typeof d.weekly === "object", `${where}: data.json weekly is an object`);
  for (const a of d.agents) {
    assert.equal(typeof a.id, "string", `${where}: agent has an id`);
    if (a.limits !== undefined) assert.ok(Array.isArray(a.limits), `${where}: ${a.id} limits is an array`);
    if (a.accounts !== undefined) assert.ok(Array.isArray(a.accounts), `${where}: ${a.id} accounts is an array`);
  }
}
function assertStatusPayload(d, where) {
  assert.ok(d && typeof d === "object" && !Array.isArray(d), `${where}: status is an object`);
  assert.ok(d.goal === null || (d.goal && typeof d.goal === "object"), `${where}: goal is null or an object`);
  if (d.goal) assert.equal(typeof d.goal.status, "string", `${where}: goal.status`);
  assert.ok(Array.isArray(d.jobs), `${where}: jobs is an array`);
  for (const j of d.jobs) {
    assert.ok(Number.isFinite(j.id), `${where}: job ${j.id} has a numeric id`);
    assert.equal(typeof j.status, "string", `${where}: job ${j.id} has a status`);
    assert.equal(typeof j.agent, "string", `${where}: job ${j.id} has an agent`);
  }
  assert.ok(Array.isArray(d.agents), `${where}: agents is an array`);
  assert.ok(d.pace && typeof d.pace === "object" && Array.isArray(d.pace.windows), `${where}: pace.windows`);
  assert.equal(typeof d.pace.mode, "string", `${where}: pace.mode`);
  assert.ok(Array.isArray(d.log), `${where}: log is an array`);
  assert.equal(typeof d.practice, "boolean", `${where}: practice`);
  assert.ok(Array.isArray(d.queue), `${where}: queue is an array`);
  assert.ok(Array.isArray(d.signals), `${where}: signals is an array`);
  const b = d.board;
  assert.ok(b && typeof b === "object", `${where}: board`);
  assert.ok(b.checklist && Array.isArray(b.checklist.items), `${where}: board.checklist.items`);
  assert.ok(Array.isArray(b.cards), `${where}: board.cards`);
  assert.equal(typeof b.now, "string", `${where}: board.now`);
  assert.ok(Array.isArray(b.history), `${where}: board.history`);
  assert.ok(b.goalQueue && Array.isArray(b.goalQueue.goals), `${where}: board.goalQueue.goals`);
  assert.ok(b.scorecard && Array.isArray(b.scorecard.rows), `${where}: board.scorecard.rows`);
  assert.ok(d.tokens && Array.isArray(d.tokens.workers) && typeof d.tokens.line === "string", `${where}: tokens`);
  assert.ok(d.progress && typeof d.progress.line === "string", `${where}: progress.line`);
  assert.ok(Array.isArray(d.copies), `${where}: copies is an array`);
  assert.ok(d.brain && typeof d.brain === "object", `${where}: brain`);
  assert.ok(d.leverage && typeof d.leverage === "object", `${where}: leverage`);
  assert.ok(d.milk && typeof d.milk === "object", `${where}: milk`);
}
function assertJobsCmd(d, where) {
  assert.ok(d && typeof d === "object", `${where}: jobs output is an object`);
  assert.ok(d.goal === null || (d.goal && typeof d.goal.status === "string"), `${where}: jobs.goal`);
  assert.ok(Array.isArray(d.jobs), `${where}: jobs.jobs is an array`);
  assert.ok(Array.isArray(d.queue), `${where}: jobs.queue is an array`);
  assert.ok(Array.isArray(d.copies), `${where}: jobs.copies is an array`);
}
function assertJobsFile(d, where) {
  assert.ok(d && typeof d === "object", `${where}: jobs.json is an object`);
  assert.ok(d.goal === null || (d.goal && typeof d.goal === "object"), `${where}: jobs.json goal`);
  assert.ok(Array.isArray(d.jobs), `${where}: jobs.json jobs is an array`);
  assert.ok(Number.isFinite(d.next), `${where}: jobs.json next`);
  for (const j of d.jobs) {
    assert.ok(Number.isFinite(j.id), `${where}: job ${j.id} has a numeric id`);
    assert.equal(typeof j.status, "string", `${where}: job ${j.id} has a status`);
  }
}

// ---- the poll loop ----------------------------------------------------------
const TERMINAL = new Set(["accepted", "merged", "sent back", "stopped", "conflict", "failed"]);
const OPEN = new Set(["waiting", "running", "held", "finished"]);
// State files with atomic writers that the panel or `status` parses strictly
// enough that a torn read would matter. refills.json/spare.json are
// deliberately absent: their writers aren't atomic yet (see BUG notes below)
// and every reader already tolerates a bad read.
const EXTRA_JSON = [
  path.join(cdir, "goal-queue.json"),
  path.join(cdir, "queue.json"),
  path.join(cdir, "reviews.json"),
  path.join(cdir, "scorecard.json"),
  path.join(cdir, "wall.json"),
  path.join(tabs, "settings.json"),
  path.join(tabs, "handoff-pending.json"),
];
// JSON-lines files `status` folds into its payload; every line must parse.
const JSONL = ["log.jsonl", "history.jsonl", "leverage.jsonl", "ratio-samples.jsonl", "notify.jsonl", "asks.jsonl"].map((f) => path.join(cdir, f));

let statusReads = 0, dataReads = 0, jobsFileReads = 0, jobsCmdReads = 0, extraReads = 0, jsonlReads = 0;
const counts = { status: 0, data: 0, jobsFile: 0, jobsCmd: 0, extra: 0, jsonl: 0 };

function pollOnce(iter) {
  // 1. data.json — the file the bar and tabs actually render.
  const d = readJson(dataPath);
  assertDataJson(d, `data.json read #${iter}`);
  dataReads++; counts.data++;
  // The collector refreshes it while she works; rewrite it the same atomic way.
  writeDataJson();

  // 2. `status` — the whole board payload, run exactly like the panel does.
  const r = spawnSync("node", [CLI, "status"], { env, encoding: "utf8", timeout: 60e3 });
  assert.equal(r.status, 0, `status exit ${r.status}: ${String(r.stderr || "").slice(-400)}`);
  assertStatusPayload(JSON.parse(r.stdout), `status read #${iter}`);
  statusReads++; counts.status++;

  // 3. jobs.json — the store `status` is built from, read raw.
  if (fs.existsSync(jobsFile)) {
    const s = readJson(jobsFile);
    assertJobsFile(s, `jobs.json read #${iter}`);
    jobsFileReads++; counts.jobsFile++;
  }

  // 4. `jobs` — the other JSON command the panel family uses.
  if (iter % 5 === 0) {
    const rj = spawnSync("node", [CLI, "jobs"], { env, encoding: "utf8", timeout: 60e3 });
    assert.equal(rj.status, 0, `jobs exit ${rj.status}: ${String(rj.stderr || "").slice(-400)}`);
    assertJobsCmd(JSON.parse(rj.stdout), `jobs read #${iter}`);
    jobsCmdReads++; counts.jobsCmd++;
  }

  // 5. The other atomic JSON state files, whenever they exist.
  for (const f of EXTRA_JSON) {
    if (!fs.existsSync(f)) continue;
    const j = readJson(f);   // must parse; shape is each writer's own
    assert.ok(j && typeof j === "object", `${path.basename(f)} read #${iter} is an object`);
    extraReads++; counts.extra++;
  }

  // 6. JSON-lines state: one bad line would poison readLog/readHistory's
  //    all-or-nothing parse and empty the panel's log/history for a poll.
  for (const f of JSONL) {
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, "utf8");
    if (!text) continue;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      JSON.parse(line);   // throws on a torn line
    }
    jsonlReads++; counts.jsonl++;
  }
}

// ---- run the goal -----------------------------------------------------------
assert.equal(run("start", "--dir", repo, "--goal", "panel data e2e").status, 0, "goal starts");

// The fake agents hold their done files until MIN_READS status reads have
// happened (the "reads-ok" gate), so the read-count assertions below can't
// flake on a fast machine that would otherwise settle the whole goal in a
// handful of polls. Every read is still checked exactly as before.
const GATE = path.join(root, "reads-ok");
const MIN_READS = 45;
const deadline = Date.now() + 300e3;
let iter = 0, settled = false;
while (Date.now() < deadline) {
  iter++;
  pollOnce(iter);
  if (!fs.existsSync(GATE) && statusReads >= MIN_READS) fs.writeFileSync(GATE, "go\n");
  let s = { goal: null, jobs: [] };
  try { s = readJson(jobsFile); } catch {}
  const g = s.goal;
  const open = s.jobs.some((j) => OPEN.has(j.status) || j.selfMerging);
  if (g && !["running", "paused"].includes(g.status) && !open) { settled = true; break; }
}
// If the goal somehow settled with the gate still shut (every job failed
// before finishing), open it anyway so nothing is left waiting on it.
if (!fs.existsSync(GATE)) fs.writeFileSync(GATE, "go\n");
assert.ok(settled, `the goal and its jobs settle within the deadline (${iter} polls)`);
// A few last reads after everything lands: history/scorecard/reviews writes.
for (let i = 0; i < 5; i++) pollOnce(++iter);

// ---- what the run must have shown -------------------------------------------
const finalStatus = JSON.parse(run("status").stdout);
assert.equal(finalStatus.goal.status, "done", "the goal finishes: " + JSON.stringify(finalStatus.goal));
assert.ok(finalStatus.jobs.length >= 4, "all four jobs are on record");
for (const j of finalStatus.jobs) assert.ok(TERMINAL.has(j.status) || j.status === "accepted", `job ${j.id} settled, got ${j.status}`);
const devinJobs = finalStatus.jobs.filter((j) => j.agent === "devin");
assert.equal(devinJobs.length, 3, "three devin copy jobs");
assert.ok(devinJobs.every((j) => j.status === "accepted"), "every copy job was reviewed and accepted");
assert.ok(devinJobs.some((j) => j.mergeCommit || j.mergedAt), "at least one copy self-merged (mergeCommit on the job)");
assert.ok(finalStatus.log.some((l) => l.kind === "merge"), "merge events are in the log the panel shows");
assert.equal(typeof finalStatus.board.now, "string");
assert.ok(finalStatus.board.history.length >= 0);

// The loop really was tight: the gate held the jobs open for at least
// MIN_READS polls, so every read below happened while jobs ran.
assert.ok(statusReads >= 40, `status was read ${statusReads} times while jobs ran`);
assert.ok(dataReads >= 40, `data.json was read ${dataReads} times`);
assert.ok(jobsFileReads >= 40, `jobs.json was read ${jobsFileReads} times`);
console.log(`panel data e2e: ${iter} polls — ${JSON.stringify(counts)}`);

// ---- atomicity audit ---------------------------------------------------------
// Every file the panel parses strictly must be written temp-file + rename.
// (Sources are checked so the guarantee survives refactors of the writers.)
const ATOMIC_WRITERS = [
  "collect.mjs",            // data.json
  "constance-jobs.mjs",     // jobs.json (locked)
  "constance-selfmerge.mjs",// reviews.json (locked)
  "constance-goalqueue.mjs",// goal-queue.json
  "constance-queue.mjs",    // queue.json (locked)
  "constance-scorecard.mjs",// scorecard.json
  "constance-backlog.mjs",  // .constance/backlog.md
  "settings-set.mjs",       // settings.json
  "antigravity-surprise.mjs",// antigravity-surprise.json (locked)
  "handoff.mjs",            // handoff-pending.json
  "constance-wall.mjs",     // wall.json
];
for (const f of ATOMIC_WRITERS) {
  const src = fs.readFileSync(path.join(HERE, f), "utf8");
  assert.match(src, /renameSync/, `${f} writes via temp file + rename`);
  assert.match(src, /\.tmp/, `${f} uses a temp file`);
}
// folder-usage.py (the TOKENS records behind `status`) writes tmp + replace().
{
  const src = fs.readFileSync(path.join(HERE, "folder-usage.py"), "utf8");
  assert.match(src, /\.replace\(/, "folder-usage.py replaces the file atomically");
}

// BUG (found while auditing, NOT fixed — reported instead): these writers
// update state files WITHOUT temp-file + rename, so a concurrent reader can
// catch a torn or empty file:
//   - bin/constance.mjs writeRefills() -> refills.json and the spare.json write
//     in afterGoal(): direct writeFileSync; readRefills()/readSpare() try/catch.
//   - bin/constance.mjs pidFile and the driver pid write: direct writeFileSync
//     (not JSON the panel reads).
//   - bin/constance.mjs sampleCopiesRunning() and bin/constance-leverage.mjs
//     addSample(): when the jsonl grows past its cap they rewrite the WHOLE
//     file with a plain writeFileSync (truncate + write). readSamples()
//     tolerates bad lines, but constance-jobs.mjs readLog() and
//     constance.mjs readHistory() parse every line inside ONE try — a torn
//     read there returns [] and the panel's log/history views go blank for a
//     poll. Same for the >4000-line log.jsonl rewrite in constance.mjs.
//   - bin/constance-progress.mjs progress state file and the
//     constance-tokens.mjs refresh marker: tiny direct writes; readers
//     try/catch.
// None of these broke this test's strict reads (the caps are never hit in a
// short run and the tiny files parse in one write), but they are the places a
// future panel-read file would tear first.

fs.rmSync(root, { recursive: true, force: true });
console.log("e2e-panel-data: all assertions passed");
