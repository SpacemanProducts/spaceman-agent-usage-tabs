// End to end for Constance's brain picker and the `summary` command, in a scratch
// state dir and repo with fake `claude` and `agy` on PATH (practice off, quiet fake
// busctl and notify-send, fake /proc for the ramp):
//  1. constanceBrain "antigravity" WITHOUT the keyring opt-in: the goal still runs on
//     fake claude, status.brain says ok:false with the keyring reason, and the owner
//     gets exactly one note.
//  2. WITH constanceKeyringAgents ["antigravity"]: fake agy runs instead (its argv
//     carries --model claude-opus-4-6 and the role inside the -p prompt), status.brain
//     reports Antigravity/"Milk Antigravity"/"Claude Opus 4.6", pace only sees the
//     Claude/GPT pool (Weekly 0.2 — the 95% Gemini bar can't stop her), and agy is
//     unavailable as a worker: "it is her brain right now".
//  3. An agy that prints "RESOURCE_EXHAUSTED: quota exceeded" and exits 1 pauses the
//     goal on "Antigravity said it hit its limit" — never a failure.
//  4. `summary` prints at most 80 lines starting "Constance summary".
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const CLI = new URL("./constance.mjs", import.meta.url).pathname;
let root = "";
for (const base of ["/var/tmp", path.join(os.homedir(), ".cache")]) {
  if (!path.isAbsolute(base)) continue;
  try { fs.mkdirSync(base, { recursive: true }); root = fs.mkdtempSync(path.join(base, "constance-brain-")); break; } catch {}
}
if (!root) root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-brain-"));
assert.ok(path.isAbsolute(root), "scratch root must be absolute");
const state = path.join(root, "state"), bin = path.join(root, "bin"), repo = path.join(root, "repo");
assert.ok(path.isAbsolute(bin), "fake bin dir must be absolute before it goes on PATH");
const tabs = path.join(state, "omarchy/agent-usage-tabs");
const cdir = path.join(tabs, "constance");
fs.mkdirSync(tabs, { recursive: true }); fs.mkdirSync(bin); fs.mkdirSync(repo);
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
fs.writeFileSync(path.join(repo, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-qm", "init");
const soon = (h) => new Date(Date.now() + h * 3600e3).toISOString();
// Claude's own bars stay low; antigravity's Gemini pool is nearly spent (95%) but
// its Claude/GPT pool — the one her picked Claude model burns — is barely touched.
const writeData = () => fs.writeFileSync(path.join(tabs, "data.json"), JSON.stringify({ generatedAt: Date.now(), agents: [
  { id: "claude", installed: true, signedIn: true, limits: [{ title: "Session", percent: 0.1, resetsAt: soon(4) }, { title: "Weekly", percent: 0.1, resetsAt: soon(150) }] },
  { id: "antigravity", installed: true, signedIn: true,
    models: [{ name: "Claude Opus 4.6", id: "claude-opus-4-6", state: "zero" }, { name: "Gemini 4 Carbon", id: "gemini-4-carbon", state: "unavailable" }],
    limits: [{ title: "Gemini Session", percent: 0.95, resetsAt: soon(5) }, { title: "Claude/GPT Weekly", percent: 0.2, resetsAt: soon(150) }] },
] }));
writeData();
const settingsFile = path.join(tabs, "settings.json");
const writeSettings = (s) => fs.writeFileSync(settingsFile, JSON.stringify({ constancePractice: false, ...s }));
// Fake Constance: which goal is running comes from jobs.json. The fake claude ticks
// the one checklist item and reports; the fake agy records its argv as JSON and does
// the same — except on "brain case three", where it hits a quota wall and exits 1.
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/bash
C="node ${CLI}"
S="${cdir}/jobs.json"
gtext=$(node -e 'let s="";try{s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).goal?.text||""}catch(e){};console.log(s)' "$S" 2>/dev/null)
echo "run: $gtext" >> "${root}/claude-runs.txt"
$C check 1 --note "done" >> "${root}/claude.out" 2>&1
echo "Report: claude done."; exit 0
`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, "agy"), `#!/bin/bash
node -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2))+"\\n")' "${root}/agy-argv.jsonl" "$@"
case "$*" in
  *"brain case three"*) echo "RESOURCE_EXHAUSTED: quota exceeded"; exit 1;;
esac
C="node ${CLI}"
$C check 1 --note "done" >> "${root}/agy.out" 2>&1
echo "Report: agy done."; exit 0
`, { mode: 0o755 });
// A fake home and projects folder, a quiet fake busctl so no watcher hears the real
// session bus, and a fake notify-send so nothing pops a real notification.
const fakeHome = path.join(root, "home"); fs.mkdirSync(path.join(fakeHome, "Projects"), { recursive: true });
fs.writeFileSync(path.join(bin, "busctl"), "#!/bin/bash\nsleep 30\n", { mode: 0o755 });
fs.writeFileSync(path.join(bin, "notify-send"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${root}/notified.txt"\n`, { mode: 0o755 });
// A fake /proc for the copy ramp: a calm machine, and no gap between copy starts.
const proc = path.join(root, "proc"); fs.mkdirSync(proc);
fs.writeFileSync(path.join(proc, "loadavg"), "0.10 0.50 0.50 1/500 999\n");
fs.writeFileSync(path.join(proc, "meminfo"), "MemTotal:       33554432 kB\nMemFree:        20971520 kB\nMemAvailable:   20971520 kB\n");
const worktrees = path.join(root, "worktrees");
const env = { ...process.env, CONSTANCE_WORKTREES: worktrees, HOME: fakeHome, SQUAD_PROJECTS: path.join(fakeHome, "Projects"), XDG_STATE_HOME: state, PATH: `${bin}:${process.env.PATH}`, CONSTANCE_PROC: proc, CONSTANCE_RAMP_GAP_MS: "0", CONSTANCE_TOKENS_GAP_MS: "500", CONSTANCE_NO_NOTIFY: "1", XDG_DATA_HOME: path.join(fakeHome, ".local", "share") };
const run = (...a) => spawnSync("node", [CLI, ...a], { env, encoding: "utf8" });
const status = () => JSON.parse(run("status").stdout);
const until = async (fn, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
const logFile = path.join(cdir, "log.jsonl");
const agyArgvFile = path.join(root, "agy-argv.jsonl");
const agyArgv = () => { try { return fs.readFileSync(agyArgvFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
// Every driver/watcher pid seen, killed at the end so nothing outlives the test.
const pids = new Set();
const notePids = () => {
  const g = status().goal;
  if (g?.driverPid) pids.add(g.driverPid);
  if (g?.brainPid) pids.add(g.brainPid);
  try { const w = Number(fs.readFileSync(path.join(cdir, "watcher.pid"), "utf8")); if (w) pids.add(w); } catch {}
};

// Case 1: Antigravity wanted but not keyring-opted-in — she stays on Claude Code,
// says why once, and the goal runs on the fake claude.
writeSettings({ constanceBrain: "antigravity" });
assert.equal(run("goals", "add", "--goal", "brain case one: do the first thing", "--dir", repo).status, 0);
notePids();
assert.ok(await until(() => { writeData(); const g = status().goal; return g && g.status === "done" && /brain case one/.test(g.text || ""); }),
  "case one finished on Claude: " + JSON.stringify(status().goal));
{
  const runs = fs.existsSync(path.join(root, "claude-runs.txt")) ? fs.readFileSync(path.join(root, "claude-runs.txt"), "utf8") : "";
  assert.match(runs, /brain case one/, "the goal ran on fake claude");
  assert.equal(agyArgv().length, 0, "agy never ran without the keyring opt-in");
  const st = status();
  assert.equal(st.brain.id, "claude");
  assert.equal(st.brain.wanted, "antigravity");
  assert.equal(st.brain.ok, false, "the wanted brain is not usable: " + JSON.stringify(st.brain));
  assert.match(st.brain.why, /constanceKeyringAgents/, "the why names the opt-in setting");
  const notes = st.log.filter((l) => l.kind === "note" && /constanceKeyringAgents/.test(l.text || ""));
  assert.equal(notes.length, 1, "the owner is told exactly once: " + JSON.stringify(notes));
}
notePids();

// Case 2: opted in — agy is her brain. It runs (not claude), gets the top model and
// the role inside its prompt, pace sees only the Claude/GPT pool, and agy can't be
// a worker while it is her brain.
writeSettings({ constanceBrain: "antigravity", constanceKeyringAgents: ["antigravity"] });
assert.equal(run("goals", "add", "--goal", "brain case two: do the second thing", "--dir", repo).status, 0);
notePids();
assert.ok(await until(() => { writeData(); const g = status().goal; return g && g.status === "done" && /brain case two/.test(g.text || ""); }),
  "case two finished on agy: " + JSON.stringify(status().goal));
{
  const argv = agyArgv();
  assert.ok(argv.length >= 1, "fake agy ran: " + JSON.stringify(argv));
  const last = argv.at(-1);
  const mi = last.indexOf("--model");
  assert.ok(mi >= 0 && last[mi + 1] === "claude-opus-4-6", "agy got the top model id: " + JSON.stringify(last));
  const prompt = last[last.indexOf("-p") + 1] || "";
  assert.match(prompt, /You are Constance, the quarterback/, "the role rides inside the -p prompt");
  assert.match(prompt, /brain case two/, "the goal text is in the prompt");
  const runs = fs.readFileSync(path.join(root, "claude-runs.txt"), "utf8");
  assert.ok(!runs.includes("brain case two"), "claude did not run case two");
  const st = status();
  assert.equal(st.brain.id, "antigravity");
  assert.equal(st.brain.ok, true);
  assert.equal(st.brain.milkLabel, "Milk Antigravity");
  assert.equal(st.brain.model, "Claude Opus 4.6", "the caption model is the top model's name");
  assert.notEqual(st.pace.mode, "stop", "the 95% Gemini bar can't stop her: " + JSON.stringify(st.pace));
  assert.ok((st.pace.windows || []).every((w) => w.title === "Weekly"), "pace sees the Claude/GPT pool only: " + JSON.stringify(st.pace.windows));
  const agy = st.agents.find((a) => a.id === "antigravity");
  assert.ok(agy, "antigravity is still listed as an agent");
  assert.equal(agy.available, false, "and never available as a worker while it is her brain");
  assert.equal(agy.reason, "it is her brain right now");
}
notePids();

// Case 3: agy hits its quota wall — the goal pauses on the wall, never a failure.
writeData();
assert.equal(run("goals", "add", "--goal", "brain case three: do the third thing", "--dir", repo).status, 0);
notePids();
assert.ok(await until(() => { const g = status().goal; return g && g.status === "paused" && /Antigravity said it hit its limit/.test(g.pauseReason || ""); }),
  "case three paused by agy's wall: " + JSON.stringify(status().goal));
{
  const st = status();
  assert.ok(!st.log.some((l) => l.kind === "failed"), "no failure was logged for the wall");
  const wall = JSON.parse(fs.readFileSync(path.join(cdir, "wall.json"), "utf8"));
  assert.ok(wall.until > Date.now(), "wall.json carries a future reset: " + JSON.stringify(wall));
  assert.match(fs.readFileSync(logFile, "utf8"), /"kind":"paused"/);
}
notePids();

// Case 4: `summary` — the Copy summary report, capped at 80 lines.
{
  writeData();
  const sum = run("summary");
  assert.equal(sum.status, 0, "summary exits clean: " + sum.stderr);
  const lines = sum.stdout.replace(/\n$/, "").split("\n");
  assert.ok(lines[0].startsWith("Constance summary"), "first line is the header: " + lines[0]);
  assert.ok(lines.length <= 80, `at most 80 lines, got ${lines.length}`);
  assert.ok(sum.stdout.endsWith("\n"), "output ends with a newline");
}

for (const pid of pids) { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} } }
fs.rmSync(root, { recursive: true, force: true });
console.log("constance-brain-drive: tests passed");
