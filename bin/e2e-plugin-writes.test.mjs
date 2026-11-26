// End to end for the panel-closing bug: the Omarchy shell watches
// ~/.config/omarchy/plugins/ with inotify and reloads every plugin (closing open
// panels) on any write inside it, except .git and top-level hidden entries — so
// `.constance/` done files and `handoff/HANDOFF.md` in this folder used to close
// Constance's own panel. This test puts a clone of this project where the shell
// keeps plugins (<fakehome>/.config/omarchy/plugins/spaceman.agent-usage-tabs),
// runs a real goal in it with fake agents (a Devin copy that self-merges, a
// read-only Grok job, review, done files, and a direct handoff.mjs check), then
// snapshots every file under the plugins folder before and after. Nothing may
// be created, changed or deleted there except under .git, a top-level hidden
// entry, or a file a job was told to edit.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { writeHandoff, maybeWriteHandoff } from "./handoff.mjs";

const CLI = new URL("./constance.mjs", import.meta.url).pathname;
const PROJECT = path.resolve(new URL(".", import.meta.url).pathname, "..");

// Scratch root. Sandboxed jobs can't see the host's /tmp (each gets its own),
// so the fakes, the clone and the worktrees must live elsewhere: /var/tmp, then
// the cache folders. When the only writable place is /tmp — e.g. this file run
// by runSuite with HOME already inside a temp folder — skip: a failed run here
// would sink an unrelated self-merge's suite.
const underTmp = (p) => { const r = path.resolve(p); return r === "/tmp" || r.startsWith("/tmp/"); };
let root = "";
for (const base of ["/var/tmp", path.join(os.homedir(), ".cache"), path.join(os.homedir(), ".local", "share"), os.tmpdir()]) {
  if (underTmp(base)) continue;
  try { fs.mkdirSync(base, { recursive: true }); root = fs.mkdtempSync(path.join(base, "e2e-plugin-writes-")); break; } catch {}
}
if (!root) {
  console.log("skip: no writable scratch folder outside /tmp");
  process.exit(0);
}
if (underTmp(root)) { console.log("skip: scratch folder is under /tmp, invisible to sandboxed jobs"); process.exit(0); }

const bin = path.join(root, "bin");
const fakeHome = path.join(root, "home");
const state = path.join(fakeHome, ".local", "state");
const plugins = path.join(fakeHome, ".config", "omarchy", "plugins");
const plugin = path.join(plugins, "spaceman.agent-usage-tabs");
const worktrees = path.join(root, "worktrees");
const proc = path.join(root, "proc");
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(worktrees, { recursive: true });
fs.mkdirSync(proc);
fs.mkdirSync(path.join(fakeHome, "Projects"), { recursive: true });

// The project under test: a real clone of this repo inside the plugins folder.
fs.mkdirSync(plugins, { recursive: true });
execFileSync("git", ["clone", "-q", PROJECT, plugin]);
const gitC = (...a) => execFileSync("git", ["-C", plugin, ...a], { encoding: "utf8" });
gitC("config", "user.email", "t@t"); gitC("config", "user.name", "t");
// A self-merge runs the project's test command sandboxed in the copy's
// worktree; this clone only needs to be a valid repo (and must not rerun this
// test), so the suite is dropped and a trivial `test: true` rule stands in —
// the worktree is cut from HEAD, so both must be committed.
for (const f of fs.readdirSync(path.join(plugin, "bin")).filter((f) => f.endsWith(".test.mjs"))) fs.rmSync(path.join(plugin, "bin", f));
fs.mkdirSync(path.join(plugin, ".constance"), { recursive: true });
fs.writeFileSync(path.join(plugin, ".constance", "rules.md"), "test: true\n");
gitC("add", "-A"); gitC("add", "-f", ".constance/rules.md");
gitC("commit", "-qm", "drop the test suite for the e2e clone; trivial test rule");

// Fake agents, same shape as bin/constance.test.mjs. Devin does the editing copy
// job (own worktree, reports its tests passed so it self-merges); Grok takes a
// read-only job; the done-file path always comes out of the prompt.
fs.writeFileSync(path.join(bin, "devin"), `#!/bin/bash
p="\${@: -1}"; f=$(grep -o '/[^ ]*/.constance/done-[0-9]*.json' <<<"$p" | head -1)
[[ -n "$f" ]] || exit 0   # not a job prompt (the collector runs e.g. "grok models"): never touch the cwd
want=$(grep -o 'if it is not exactly [^ ]*, stop now' <<<"$p" | head -1 | sed 's/^if it is not exactly //; s/, stop now$//')
here=$(pwd)
[[ -n "$want" && "$here" == "$want" ]] || { echo "pwd check failed: here=$here want=$want"; exit 1; }
[[ "$f" == "/tmp/.constance/"* ]] || { echo "done file $f is not in the sandbox tmp"; exit 1; }
while [[ ! -e "${root}/go" ]]; do sleep 0.2; done
name=$(sed -n 's/^Only edit these files: \\([^ ,]*\\)\\..*/\\1/p' <<<"$p" | head -1); name=\${name:-x.txt}
before=$(git rev-parse HEAD)
echo "devin $name" > "$name"; git add "$name"; git commit -qm "devin: $name" || true
after=$(git rev-parse HEAD); c=""; [[ "$after" != "$before" ]] && c="$after"
t=""; grep -q selfmerge <<<"$p" && t=', "tests": "pass"'
echo "{\\"summary\\": \\"added \${name%.*}\\", \\"commit\\": \\"$c\\", \\"files\\": [\\"$name\\"]$t}" > "$f"
`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, "grok"), `#!/bin/bash
p="\${@: -1}"; f=$(grep -o '/[^ ]*/.constance/done-[0-9]*.json' <<<"$p" | head -1)
[[ -n "$f" ]] || exit 0   # not a job prompt (the collector runs e.g. "grok models"): never touch the cwd
while [[ ! -e "${root}/go" ]]; do sleep 0.2; done
echo '{"summary": "read-only look, changed nothing", "commit": "", "files": []}' > "$f"
`, { mode: 0o755 });
// Fake Constance: one editing copy job (selfmerge marker -> tests pass -> self-merge),
// one read-only job, then wait/review each to acceptance.
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
C="node ${CLI}"
$C delegate --agent devin --files e2e-copy-a.txt --task "add e2e-copy-a selfmerge" >> "${root}/brain.out" 2>&1
$C delegate --agent grok --task "read-only: what is this repo in one line" >> "${root}/brain.out" 2>&1
touch "${root}/go"
$C wait --timeout 60 > "${root}/wait1.json"
id1=$(node -e 'const w=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(w.review.id)' "${root}/wait1.json")
$C review "$id1" accept --note ok >> "${root}/brain.out" 2>&1
$C wait --timeout 60 > "${root}/wait2.json"
id2=$(node -e 'const w=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(w.review.id)' "${root}/wait2.json")
$C review "$id2" accept --note ok >> "${root}/brain.out" 2>&1
echo "Report: goal done."
`, { mode: 0o755 });
// A quiet fake bus and a fake notify-send, as in constance.test.mjs: nothing she
// does may reach the real session bus or pop a real notification.
fs.writeFileSync(path.join(bin, "busctl"), "#!/bin/bash\nsleep 30\n", { mode: 0o755 });
fs.writeFileSync(path.join(bin, "notify-send"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${root}/notified.txt"\n`, { mode: 0o755 });

// Her state: data.json makes grok/devin available workers and claude well under
// her own limit; settings turn practice mode off so jobs really launch.
const tabs = path.join(state, "omarchy/agent-usage-tabs");
fs.mkdirSync(tabs, { recursive: true });
const soon = (h) => new Date(Date.now() + h * 3600e3).toISOString();
fs.writeFileSync(path.join(tabs, "data.json"), JSON.stringify({ generatedAt: Date.now(), agents: [
  { id: "claude", installed: true, signedIn: true, limits: [{ title: "Session", percent: 0.1, resetsAt: soon(4) }, { title: "Weekly", percent: 0.1, resetsAt: soon(150) }] },
  { id: "grok", installed: true, signedIn: true, limits: [{ title: "Daily", percent: 0.1 }] },
  { id: "devin", name: "Devin", installed: true, signedIn: true, limits: [{ title: "Daily", percent: 0.1 }] }] }));
fs.writeFileSync(path.join(tabs, "settings.json"), JSON.stringify({ constancePractice: false }));

// Calm fake /proc for the copy ramp, and worktrees inside this scratch root.
fs.writeFileSync(path.join(proc, "loadavg"), "0.10 0.50 0.50 1/500 999\n");
fs.writeFileSync(path.join(proc, "meminfo"), "MemTotal:       33554432 kB\nMemFree:        20971520 kB\nMemAvailable:   20971520 kB\n");

const env = { ...process.env, HOME: fakeHome, XDG_STATE_HOME: state, XDG_CONFIG_HOME: path.join(fakeHome, ".config"), XDG_CACHE_HOME: path.join(fakeHome, ".cache"), XDG_DATA_HOME: path.join(fakeHome, ".local", "share"), SQUAD_PROJECTS: path.join(fakeHome, "Projects"), PATH: `${bin}:${process.env.PATH}`, CONSTANCE_WORKTREES: worktrees, CONSTANCE_PROC: proc, CONSTANCE_RAMP_GAP_MS: "0", CONSTANCE_TOKENS_GAP_MS: "500" };
const run = (...a) => spawnSync("node", [CLI, ...a], { env, encoding: "utf8" });
const status = () => JSON.parse(run("status").stdout);
const until = async (fn, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };

// Every file and folder under the plugins dir -> "mtime:size" (dirs marked).
const snapshot = (dir) => {
  const m = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), rel = path.relative(dir, p).split(path.sep).join("/");
      if (e.isDirectory()) { m.set(rel + "/", "dir"); walk(p); }
      else if (e.isFile()) { const s = fs.statSync(p); m.set(rel, `${s.mtimeMs}:${s.size}`); }
    }
  };
  walk(dir);
  return m;
};
// The watcher's exemptions, on a path relative to the plugins dir: anything
// under a .git folder, or a top-level hidden entry (a name starting with ".").
const exempt = (rel) => rel.split("/").includes(".git") || rel.startsWith(".");

const before = snapshot(plugins);
const jobFiles = new Set();   // filled in after the goal, from the jobs' file lists
try {
  assert.equal(run("start", "--dir", plugin, "--goal", "add a file inside the plugin folder").status, 0);
  assert.ok(await until(() => status().goal && status().goal.status === "done", 90000), "the goal finishes: " + JSON.stringify(status().goal));
  // Wait for every job to reach a terminal state so a still-running self-merge
  // can't land a write after the snapshot.
  assert.ok(await until(() => { const s = status(); return s.jobs.length >= 2 && s.jobs.every((j) => ["accepted", "sent back", "conflict", "stopped"].includes(j.status)); }, 60000), "all jobs are reviewed: " + JSON.stringify(status().jobs.map((j) => [j.id, j.status])));
  const s = status();
  for (const j of s.jobs) for (const f of j.files || []) jobFiles.add(`spaceman.agent-usage-tabs/${String(f).replace(/^\.\//, "")}`);

  // The copy job really ran the self-merge path: its branch merged itself before
  // her review confirmed it, and its file is the only plugin-folder write a job
  // may make.
  const dj = s.jobs.find((j) => j.agent === "devin");
  assert.ok(dj && dj.status === "accepted", "the copy job was reviewed: " + JSON.stringify(dj && [dj.id, dj.status]));
  assert.ok(s.log.some((l) => l.kind === "merge" && /self-merged constance\/job-/.test(l.text)), "the copy self-merged: " + JSON.stringify(s.log.filter((l) => l.kind === "merge")));
  assert.equal(fs.readFileSync(path.join(plugin, "e2e-copy-a.txt"), "utf8"), "devin e2e-copy-a.txt\n", "the merged file landed in the plugin folder");
  const gj = s.jobs.find((j) => j.agent === "grok");
  assert.ok(gj && gj.status === "accepted" && (gj.files || []).length === 0, "the read-only job changed nothing");

  // handoff.mjs must refuse to write inside the plugins folder: no HANDOFF.md,
  // no AGENTS.md line, no pending file — for both the direct write and the
  // collector's maybeWriteHandoff path.
  const trig = { agent: "Test", percent: 0.9, title: "Session", resetsIn: "", level: "warn" };
  assert.deepEqual(writeHandoff(plugin, trig, Date.now(), env), { file: "", addedLine: false });
  const squadDir = path.join(root, "squad-dir"); fs.writeFileSync(squadDir, plugin + "\n");
  const pending = path.join(state, "omarchy/agent-usage-tabs/handoff-pending.json");
  assert.equal(maybeWriteHandoff({ sent: [{ agent: { name: "Test" }, limit: { title: "Session", percent: 0.9 }, level: "warn" }], settings: { handoffNote: true }, projectsDir: path.join(fakeHome, "Projects"), squadDirFile: squadDir, pendingFile: pending, env }), "");
  assert.ok(!fs.existsSync(pending), "no pending handoff was recorded");

  // Give any straggler write a moment, then diff the whole plugins folder.
  await new Promise((r) => setTimeout(r, 500));
  const after = snapshot(plugins);
  const bad = [];
  for (const [rel, v] of after) {
    if (before.get(rel) === v || exempt(rel) || jobFiles.has(rel)) continue;
    bad.push(`${before.has(rel) ? "modified" : "created"} ${rel}`);
  }
  for (const rel of before.keys()) if (!after.has(rel) && !exempt(rel)) bad.push(`deleted ${rel}`);
  assert.deepEqual(bad, [], "writes inside the plugins folder reload every plugin — only .git, top-level hidden entries and the job's own files may change");
} finally {
  try { run("stop"); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
