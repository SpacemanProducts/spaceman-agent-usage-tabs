// A done file caught mid-write must not finish a healthy job: sweep() used to
// JSON.parse whatever was there, mark the job finished with "(done file was not
// valid JSON)" and auto-retry it as a crash. Now an unparseable done file only
// counts once the agent is gone AND the file has sat unparseable for ~10 s.
// End to end in a scratch state dir and repo with a fake `devin` that writes
// its done file in two slow halves while `status` polls drive the sweeps; plus
// the dead-process + permanently-garbage case, which must still finish with
// the invalid-JSON summary (and still auto-retry, as before).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const CLI = new URL("./constance.mjs", import.meta.url).pathname;
// Jobs run sandboxed, where the fake agents must be visible read-only: keep the
// scratch root under /var/tmp like constance.test.mjs does.
let root = "";
for (const base of ["/var/tmp", path.join(os.homedir(), ".cache")]) {
  if (!path.isAbsolute(base)) continue;
  try { fs.mkdirSync(base, { recursive: true }); root = fs.mkdtempSync(path.join(base, "constance-donefile-")); break; } catch {}
}
if (!root) root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-donefile-"));
assert.ok(path.isAbsolute(root), "scratch root must be absolute");
const state = path.join(root, "state"), bin = path.join(root, "bin"), repo = path.join(root, "repo");
assert.ok(path.isAbsolute(bin), "fake bin dir must be absolute before it goes on PATH");
const tabs = path.join(state, "omarchy/agent-usage-tabs");
fs.mkdirSync(tabs, { recursive: true }); fs.mkdirSync(bin); fs.mkdirSync(repo);
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
fs.writeFileSync(path.join(repo, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-qm", "init");
const soon = (h) => new Date(Date.now() + h * 3600e3).toISOString();
fs.writeFileSync(path.join(tabs, "data.json"), JSON.stringify({ generatedAt: Date.now(), agents: [
  { id: "claude", installed: true, signedIn: true, limits: [{ title: "Session", percent: 0.1, resetsAt: soon(4) }, { title: "Weekly", percent: 0.1, resetsAt: soon(150) }] },
  { id: "devin", name: "Devin", installed: true, signedIn: true, limits: [{ title: "Daily", percent: 0.1 }] }] }));
// Practice mode is on by default; this test runs real (sandboxed) jobs.
fs.writeFileSync(path.join(tabs, "settings.json"), JSON.stringify({ constancePractice: false }));

// Fake devin: the done file path is in the prompt (last argument). Three modes,
// picked by the task text: an auto-retry's "Last try failed with:" prompt
// reports done at once; "two slow halves" writes half a JSON file, sleeps, then
// the rest; "garbage done file" writes unparseable bytes and exits.
fs.writeFileSync(path.join(bin, "devin"), `#!/bin/bash
p="\${@: -1}"; f=$(grep -o '/[^ ]*/.constance/done-[0-9]*.json' <<<"$p" | head -1)
[[ -n "$f" ]] || exit 0   # not a job prompt (the collector runs e.g. "grok models"): never touch the cwd
if grep -q "Last try failed" <<<"$p"; then
  echo '{"summary": "retried ok", "commit": "", "files": ["junk.txt"]}' > "$f"
elif grep -q "two slow halves" <<<"$p"; then
  printf '%s' '{"summary": "written in two slow halves", "commit": "", "files": ["slow.txt"]' > "$f"
  sleep 3
  printf '%s' '}' >> "$f"
elif grep -q "garbage done file" <<<"$p"; then
  echo 'this is not json at all' > "$f"
fi
`, { mode: 0o755 });
// Fake Constance: her planning brain just sleeps, so the goal stays running
// while the test drives delegate/status itself.
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash\nsleep 600\n`, { mode: 0o755 });
const fakeHome = path.join(root, "home"); fs.mkdirSync(path.join(fakeHome, "Projects"), { recursive: true });
fs.writeFileSync(path.join(bin, "busctl"), "#!/bin/bash\nsleep 30\n", { mode: 0o755 });
fs.writeFileSync(path.join(bin, "notify-send"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${root}/notified.txt"\n`, { mode: 0o755 });
// A fake /proc for the copy ramp: a calm machine, and no gap between copy starts.
const proc = path.join(root, "proc"); fs.mkdirSync(proc);
fs.writeFileSync(path.join(proc, "loadavg"), "0.10 0.50 0.50 1/500 999\n");
fs.writeFileSync(path.join(proc, "meminfo"), "MemTotal:       33554432 kB\nMemFree:        20971520 kB\nMemAvailable:   20971520 kB\n");
const worktrees = path.join(root, "worktrees");
const env = { ...process.env, CONSTANCE_WORKTREES: worktrees, HOME: fakeHome, SQUAD_PROJECTS: path.join(fakeHome, "Projects"), XDG_STATE_HOME: state, PATH: `${bin}:${process.env.PATH}`, CONSTANCE_PROC: proc, CONSTANCE_RAMP_GAP_MS: "0", CONSTANCE_TOKENS_GAP_MS: "500", XDG_DATA_HOME: path.join(fakeHome, ".local", "share") };
const run = (...a) => spawnSync("node", [CLI, ...a], { env, encoding: "utf8" });
const status = () => JSON.parse(run("status").stdout);
const job = (s, id) => s.jobs.find((j) => j.id === id);
const until = async (fn, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 150)); } return false; };

assert.equal(run("start", "--dir", repo, "--goal", "done-file race check").status, 0);

// Job 1: the agent writes its done file in two halves ~3 s apart. Every sweep
// in between sees unparseable JSON while the process is alive — the job must
// stay running and no retry job may appear.
assert.equal(run("delegate", "--agent", "devin", "--files", "slow.txt", "--task", "write the done file in two slow halves").status, 0);
let sawRunning = false;
const finished1 = await until(() => {
  const s = status(), j = job(s, 1);
  assert.ok(j, "job 1 exists");
  if (j.status !== "running") return true;
  sawRunning = true;
  assert.equal(j.status, "running");
  assert.equal(s.jobs.length, 1, "no retry job while the first is still running");
  assert.ok(!/not valid JSON/.test(j.summary || ""), "never finished on the torn read");
  return false;
});
assert.ok(finished1, "job 1 finishes");
assert.ok(sawRunning, "job 1 was observed running");
{
  const s = status(), j = job(s, 1);
  assert.equal(j.status, "finished");
  assert.match(j.summary, /two slow halves/);
  assert.equal(s.jobs.length, 1, "still exactly one job: no phantom retry");
}

// Job 2: the agent writes garbage and exits. The file is fresh (< ~10 s) at
// first, so the sweep must wait for it to go stale; only then does the job
// finish with the invalid-JSON summary — and, as before, auto-retry fires.
assert.equal(run("delegate", "--agent", "devin", "--files", "junk.txt", "--task", "leave a garbage done file").status, 0);
const retried = await until(() => {
  const s = status(), j = job(s, 2);
  assert.ok(j, "job 2 exists");
  if (j.status === "running") {
    assert.ok(!/not valid JSON/.test(j.summary || ""), "garbage file is not believed while it is still fresh");
    return false;
  }
  return true;
}, 45000);
assert.ok(retried, "job 2 leaves running once the garbage file is stale");
{
  const s = status(), j = job(s, 2);
  assert.match(j.summary, /done file was not valid JSON/);
  assert.equal(j.status, "sent back", "the crash path still auto-retries it");
}
assert.ok(await until(() => status().jobs.length === 3, 20000), "the auto-retry handed out a redo");
assert.ok(await until(() => job(status(), 3)?.status === "finished", 30000), "the retry job finishes normally");

run("stop");
console.log("constance-donefile: ok");
