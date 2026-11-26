// Constance ten Devin copies, end to end: a real goal (fake claude brain that
// just stays alive) in a temp repo and temp state dir, driven only through
// real `node bin/constance.mjs` processes with a fake `devin` on PATH.
//
//   - settings.json sets constanceMaxCopies 10 and practice mode off.
//   - ten `delegate --agent devin --files fN.txt` calls each get their own
//     copy number 1..10, once each, in their own worktree.
//   - an eleventh delegate is refused: all ten copy slots are taken.
//   - the fake devin edits its one file, commits and reports its tests
//     passed, so every copy self-merges: ten --no-ff merge commits land on
//     the repo's branch and every file is there afterwards.
//
// Every file lives under one mkdtemp dir; the children get HOME and the XDG
// vars pointed inside it, so nothing touches the real home or state folders.
// The scratch root must sit outside /tmp: sandboxed jobs get a fresh /tmp and
// could not see the fake agents there (same rule as e2e-plugin-writes).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const CLI = new URL("./constance.mjs", import.meta.url).pathname;
const underTmp = (p) => { const r = path.resolve(p); return r === "/tmp" || r.startsWith("/tmp/"); };
let root = "";
for (const base of ["/var/tmp", path.join(os.homedir(), ".cache"), path.join(os.homedir(), ".local", "share"), os.tmpdir()]) {
  if (!path.isAbsolute(base) || underTmp(base)) continue;
  try { fs.mkdirSync(base, { recursive: true }); root = fs.mkdtempSync(path.join(base, "constance-ten-copies-")); break; } catch {}
}
if (!root) root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-ten-copies-"));
assert.ok(path.isAbsolute(root), "scratch root must be absolute");
if (underTmp(root)) {
  console.log("skip: no writable scratch folder outside /tmp");
  process.exit(0);
}

const bin = path.join(root, "bin"), fakeHome = path.join(root, "home"), state = path.join(root, "state");
assert.ok(path.isAbsolute(bin), "fake bin dir must be absolute before it goes on PATH");
const tabs = path.join(state, "omarchy/agent-usage-tabs");
const storeDir = path.join(tabs, "constance");
const repo = path.join(root, "repo"), worktrees = path.join(root, "worktrees"), proc = path.join(root, "proc");
for (const d of [bin, fakeHome, state, repo, worktrees, proc]) fs.mkdirSync(d, { recursive: true });
fs.mkdirSync(path.join(fakeHome, "Projects"), { recursive: true });
fs.mkdirSync(path.join(fakeHome, ".config"), { recursive: true });
fs.mkdirSync(path.join(fakeHome, ".cache"), { recursive: true });

const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
git("config", "user.email", "t@t"); git("config", "user.name", "t");
fs.writeFileSync(path.join(repo, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-qm", "init");
// The project's real test command: a self-merge runs it sandboxed (a worker's
// "tests passed" is never a signal).
fs.mkdirSync(path.join(repo, ".constance")); fs.writeFileSync(path.join(repo, ".constance", "rules.md"), "test: true\n");
git("add", ".constance/rules.md"); git("commit", "-qm", "project rules");

// Fake devin: same shape as the one in constance.test.mjs — the done file path
// and the file it edits both come out of the prompt, it passes the pwd check
// in its own worktree, commits the one file it was given and reports its tests
// passed (so the job self-merges). No go-file wait: this test is about the ten
// copies, not job pacing.
fs.writeFileSync(path.join(bin, "devin"), `#!/bin/bash
p="\${@: -1}"; f=$(grep -o '/[^ ]*/.constance/done-[0-9]*.json' <<<"$p" | head -1)
[[ -n "$f" ]] || exit 0   # not a job prompt (the collector runs e.g. "grok models"): never touch the cwd
want=$(grep -o 'if it is not exactly [^ ]*, stop now' <<<"$p" | head -1 | sed 's/^if it is not exactly //; s/, stop now$//')
here=$(pwd)
[[ -n "$want" && "$here" == "$want" ]] || { echo "pwd check failed: here=$here want=$want"; exit 1; }
[[ "$f" == "/tmp/.constance/"* ]] || { echo "done file $f is not in the sandbox tmp"; exit 1; }
name=$(sed -n 's/^Only edit these files: \\([^ ,]*\\)\\..*/\\1/p' <<<"$p" | head -1); name=\${name:-x.txt}
before=$(git rev-parse HEAD)
echo "devin $name" > "$name"; git add "$name"; git commit -qm "devin: $name" || true
after=$(git rev-parse HEAD); c=""; [[ "$after" != "$before" ]] && c="$after"
echo "{\\"summary\\": \\"added \${name%.*}, tests passed\\", \\"commit\\": \\"$c\\", \\"files\\": [\\"$name\\"], \\"tests\\": \\"passed\\"}" > "$f"
`, { mode: 0o755 });

// Fake Constance: the goal stays running while the test drives `delegate`
// itself; a long sleep keeps her (and the driver) alive until `stop`.
fs.writeFileSync(path.join(bin, "claude"), "#!/bin/bash\nsleep 600\n", { mode: 0o755 });
// A quiet fake bus and notify-send: nothing she does may reach the real session
// bus or pop a real notification.
fs.writeFileSync(path.join(bin, "busctl"), "#!/bin/bash\nsleep 30\n", { mode: 0o755 });
fs.writeFileSync(path.join(bin, "notify-send"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${root}/notified.txt"\n`, { mode: 0o755 });

// Her state: claude far under her own limit, devin available; settings turn
// practice mode off and cap copies at the published 10.
const soon = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const writeData = () => fs.writeFileSync(path.join(tabs, "data.json"), JSON.stringify({ generatedAt: Date.now(), agents: [
  { id: "claude", installed: true, signedIn: true, limits: [{ title: "Session", percent: 0.1, resetsAt: soon(4) }, { title: "Weekly", percent: 0.1, resetsAt: soon(150) }] },
  { id: "devin", name: "Devin", installed: true, signedIn: true, limits: [{ title: "Daily", percent: 0.1 }] }] }));
fs.mkdirSync(tabs, { recursive: true });
writeData();
fs.writeFileSync(path.join(tabs, "settings.json"), JSON.stringify({ constancePractice: false, constanceMaxCopies: 10, constanceUseItOrLoseIt: false }));

// Calm fake /proc for the copy ramp: plenty of memory, so all ten start.
fs.writeFileSync(path.join(proc, "loadavg"), "0.10 0.50 0.50 1/500 999\n");
fs.writeFileSync(path.join(proc, "meminfo"), "MemTotal:       33554432 kB\nMemFree:        20971520 kB\nMemAvailable:   20971520 kB\n");

const env = { ...process.env, HOME: fakeHome, XDG_STATE_HOME: state, XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"),
  XDG_DATA_HOME: path.join(fakeHome, ".local", "share"), SQUAD_PROJECTS: path.join(fakeHome, "Projects"), PATH: `${bin}:${process.env.PATH}`,
  CONSTANCE_WORKTREES: worktrees, CONSTANCE_PROC: proc, CONSTANCE_RAMP_GAP_MS: "0", CONSTANCE_TOKENS_GAP_MS: "500", CONSTANCE_NO_NOTIFY: "1" };
const run = (...a) => spawnSync("node", [CLI, ...a], { env, encoding: "utf8", timeout: 120000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jobsFile = path.join(storeDir, "jobs.json");
const allJobs = () => JSON.parse(fs.readFileSync(jobsFile, "utf8")).jobs;
const devinJobs = () => allJobs().filter((j) => j.agent === "devin").sort((a, b) => a.id - b.id);

try {
  assert.equal(run("start", "--dir", repo, "--goal", "ten devin copies").status, 0, "the goal starts");

  // Ten copy jobs, one distinct file each: copy numbers 1..10, once each.
  for (let i = 1; i <= 10; i++) {
    const r = run("delegate", "--agent", "devin", "--files", `f${i}.txt`, "--task", `add f${i} and report tests passed`);
    assert.equal(r.status, 0, `delegate ${i} failed: ${r.stderr}`);
  }
  {
    const js = devinJobs();
    assert.equal(js.length, 10, `expected 10 devin jobs, got ${js.length}`);
    assert.deepEqual(js.map((j) => j.copy).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      "copy numbers 1..10 are not each used once: " + JSON.stringify(js.map((j) => [j.id, j.copy, j.status])));
    for (const j of js) assert.equal(j.worker, `Devin ${j.copy}`, `job ${j.id} worker is ${j.worker}`);
  }

  // The eleventh delegate finds every copy slot taken: refused, and it must
  // not add a job (merged copies keep their number until review accepts them).
  const r11 = run("delegate", "--agent", "devin", "--files", "f11.txt", "--task", "add f11");
  assert.notEqual(r11.status, 0, "the eleventh delegate was not refused");
  assert.match(r11.stderr, /already has 10 copies/, `unexpected refusal: ${r11.stderr}`);
  assert.equal(devinJobs().length, 10, "the refused delegate still added a job");

  // Every copy finishes and self-merges; `jobs` is the sweep that notices the
  // done files and spawns the detached selfmerge processes.
  const deadline = Date.now() + 180000;
  let lastData = 0;
  for (;;) {
    run("jobs");
    const js = devinJobs();
    if (js.length === 10 && js.every((j) => j.status === "merged")) break;
    assert.ok(Date.now() < deadline, `the copies never all merged: ${js.map((j) => `${j.id}:${j.status}`).join(", ")}`);
    if (Date.now() - lastData > 20000) { writeData(); lastData = Date.now(); }
    await sleep(300);
  }

  const merges = git("log", "--merges", "--format=%H").split("\n").filter(Boolean);
  assert.equal(merges.length, 10, `expected 10 merge commits, got ${merges.length}`);
  for (const c of merges) {
    assert.equal(git("rev-list", "--parents", "-n", "1", c).trim().split(/\s+/).length, 3, `${c} is not a two-parent merge commit`);
  }
  for (let i = 1; i <= 10; i++) {
    assert.equal(fs.readFileSync(path.join(repo, `f${i}.txt`), "utf8"), `devin f${i}.txt\n`, `f${i}.txt missing or wrong`);
  }
  assert.equal(git("status", "--porcelain").trim(), "", "the repo is left dirty");
} finally {
  try { run("stop"); } catch {}
  await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
console.log("constance-e2e-ten-copies: tests passed");
