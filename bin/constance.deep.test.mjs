// Deep test of bin/constance.mjs's command line: every error path must end in a
// plain one-line failure or a clean recovery — never a stack trace, a crash or
// wiped state. Each command runs as a real `node constance.mjs ...` process
// against a fresh fs.mkdtempSync world: HOME, XDG_STATE_HOME, XDG_CONFIG_HOME,
// XDG_CACHE_HOME and XDG_DATA_HOME all point inside it, so nothing here can
// touch the real home folder, the real session bus (a fake busctl sleeps) or
// the real notify-send. data.json is always written fresh so the collector
// never runs. Plain node asserts like the other bin/*.test.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const CLI = new URL("./constance.mjs", import.meta.url).pathname;

const worlds = [];
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-deep-"));
  const w = { root };
  w.home = path.join(root, "home"); w.proj = path.join(root, "proj");
  w.state = path.join(root, "state"); w.tabs = path.join(w.state, "omarchy/agent-usage-tabs");
  w.cdir = path.join(w.tabs, "constance");   // her store dir (jobs.json, queue.json, ...)
  fs.mkdirSync(w.cdir, { recursive: true });
  fs.mkdirSync(w.home, { recursive: true });
  fs.mkdirSync(w.proj, { recursive: true });
  const proc = path.join(root, "proc"); fs.mkdirSync(proc);
  fs.writeFileSync(path.join(proc, "loadavg"), "0.10 0.50 0.50 1/500 999\n");
  fs.writeFileSync(path.join(proc, "meminfo"), "MemTotal:       33554432 kB\nMemAvailable:   20971520 kB\n");
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "busctl"), "#!/bin/bash\nsleep 30\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "notify-send"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  w.env = { ...process.env, HOME: w.home, SQUAD_PROJECTS: path.join(w.home, "Projects"),
    XDG_STATE_HOME: w.state, XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_DATA_HOME: path.join(w.home, ".local", "share"), CONSTANCE_PROC: proc,
    CONSTANCE_WORKTREES: path.join(root, "worktrees"), PATH: `${bin}:${process.env.PATH}` };
  worlds.push(w);
  return w;
}

// A fresh data.json (generatedAt now) so freshData() never falls back to running
// the collector. grok/devin look available; copilot sits at its wall.
function writeData(w) {
  const soon = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  fs.writeFileSync(path.join(w.tabs, "data.json"), JSON.stringify({ generatedAt: Date.now(), agents: [
    { id: "claude", installed: true, signedIn: true, limits: [{ title: "Session", percent: 0.1, resetsAt: soon(4) }, { title: "Weekly", percent: 0.1, resetsAt: soon(150) }] },
    { id: "grok", installed: true, signedIn: true, limits: [{ title: "Daily", percent: 0.1 }] },
    { id: "devin", name: "Devin", installed: true, signedIn: true, limits: [{ title: "Daily", percent: 0.1 }] },
    { id: "copilot", installed: true, signedIn: true, limits: [{ title: "Monthly", percent: 0.94 }] },
  ] }));
}

const jobsFile = (w) => path.join(w.cdir, "jobs.json");
const writeJobs = (w, d) => { fs.mkdirSync(w.cdir, { recursive: true }); fs.writeFileSync(jobsFile(w), typeof d === "string" ? d : JSON.stringify(d, null, 2) + "\n"); };
const writeJSON = (w, rel, d) => { const f = path.join(w.cdir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === "string" ? d : JSON.stringify(d, null, 2) + "\n"); };
const writeTabs = (w, rel, d) => { const f = path.join(w.tabs, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === "string" ? d : JSON.stringify(d) + "\n"); };
const readJobs = (w) => JSON.parse(fs.readFileSync(jobsFile(w), "utf8"));

// run() is the whole contract: the process must exit on its own (0 or the
// deliberate fail() exit 1 — never a signal, a timeout or a spawn error) and
// must not print a stack trace. timeoutMs exists for commands that can run the
// collector synchronously (freshData() allows it up to 120 s): callers pass a
// larger budget there instead of weakening the no-timeout contract.
function runT(w, timeoutMs, ...a) {
  const r = spawnSync("node", [CLI, ...a], { env: w.env, encoding: "utf8", timeout: timeoutMs });
  assert.equal(r.error, undefined, `${a.join(" ")}: spawn error ${r.error}`);
  assert.equal(r.signal, null, `${a.join(" ")}: killed by ${r.signal}`);
  assert.ok(r.status === 0 || r.status === 1, `${a.join(" ")}: unexpected exit ${r.status}`);
  assert.doesNotMatch(r.stderr, /(^|\n)\s+at\s/, `${a.join(" ")}: stack trace in stderr:\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /node:internal/, `${a.join(" ")}: node internal in stderr:\n${r.stderr}`);
  return r;
}
function run(w, ...a) { return runT(w, 60000, ...a); }
const ok = (w, ...a) => { const r = run(w, ...a); assert.equal(r.status, 0, `${a.join(" ")}: exit 1: ${r.stderr}`); return r; };
const bad = (w, re, ...a) => { const r = run(w, ...a); assert.equal(r.status, 1, `${a.join(" ")}: expected a plain failure, got ${r.status}: ${r.stdout}`); assert.match(r.stderr, re, `${a.join(" ")}: stderr was ${JSON.stringify(r.stderr)}`); return r; };

// Commands safe to run against ANY state, including a corrupt data.json (none
// of them call freshData(), so a missing/stale generatedAt can't kick off a
// collector run). Each must exit 0 or fail plainly — the assertion is "no crash".
const SAFE_COMMANDS = (w) => [
  ["status"], ["jobs"], ["goals"], ["goals", "rm", "nope"], ["goals", "move", "nope", "up"], ["goals", "edit", "nope"], ["goals", "next"],
  ["scorecard"], ["signals"], ["log"], ["summary"], ["reviews"], ["route", "plan"], ["route", "bogus"],
  ["note", "x"], ["needs-owner", "x"], ["lesson", "x"], ["recover"], ["stop"], ["batchreview"], ["selfmerge"],
  ["remote"], ["queue"], ["check"], ["review", "1", "accept"], ["delegate"], ["job", "1"],
  ["backlog", "--dir", w.proj], ["split", "--goal", "x"], ["spec", "bogus"],
];
// The same plus the commands that read data.json through freshData() — safe only
// when data.json itself is readable and fresh.
const FULL_COMMANDS = (w) => [...SAFE_COMMANDS(w), ["agents"], ["pace"], ["spare"]];
function battery(w, commands = SAFE_COMMANDS(w), timeoutMs = 60000) { for (const a of commands) runT(w, timeoutMs, ...a); }

// ---------------------------------------------------------------- fresh state
{
  const w = world(); writeData(w);
  // An unknown command is a usage failure, not a crash.
  bad(w, /Usage: constance\.mjs/, "frobnicate");
  bad(w, /Usage: constance\.mjs/, "--help");
  // Missing required arguments and missing state, goal-less.
  bad(w, /No goal is running/, "delegate");
  bad(w, /No goal is running/, "delegate", "--agent", "grok");
  bad(w, /No goal is running/, "delegate", "--task", "x");
  bad(w, /No goal is running/, "delegate", "--agent", "grok", "--task");
  bad(w, /Usage: review/, "review");
  bad(w, /Usage: review/, "review", "1");
  bad(w, /Usage: review/, "review", "1", "bogus");
  bad(w, /No job/, "review", "99", "accept", "--note", "x");
  bad(w, /No job/, "review", "abc", "accept");
  bad(w, /No goal is running, so there is no project queue/, "queue");
  bad(w, /No goal is running, so there is no project queue/, "queue", "rm", "1");
  bad(w, /No goal is running, so there is no project queue/, "queue", "--task", "x");
  bad(w, /No goal\./, "check");
  bad(w, /No goal\./, "check", "1");
  bad(w, /No goal\./, "check", "x");
  bad(w, /No goal is running: pass --dir/, "backlog");
  bad(w, /backlog item needs text/, "backlog", "add", "--dir", w.proj);
  bad(w, /unknown backlog kind/, "backlog", "add", "--dir", w.proj, "--kind", "bogus", "--text", "x");
  bad(w, /No backlog item/, "backlog", "take", "--dir", w.proj);
  bad(w, /No backlog item 99/, "backlog", "done", "99", "--dir", w.proj);
  bad(w, /No backlog item 99/, "backlog", "rm", "99", "--dir", w.proj);
  // A backlog path that is a file, not a folder: add fails plainly, reads say empty/missing.
  fs.writeFileSync(path.join(w.proj, "afile.txt"), "x\n");
  bad(w, /./, "backlog", "add", "--dir", path.join(w.proj, "afile.txt"), "--kind", "task", "--text", "x");
  assert.match(ok(w, "backlog", "--dir", path.join(w.proj, "afile.txt")).stdout, /backlog is empty/);
  bad(w, /No backlog item/, "backlog", "done", "1", "--dir", path.join(w.proj, "afile.txt"));
  // Goal queue and job lookups.
  bad(w, /No queued goal/, "goals", "rm", "nope");
  bad(w, /No queued goal/, "goals", "move", "nope", "up");
  bad(w, /No queued goal/, "goals", "edit", "nope");
  bad(w, /goal queue is empty/, "goals", "next");
  bad(w, /No job/, "job", "99");
  bad(w, /No job/, "job", "x");
  // Missing free-text arguments.
  bad(w, /Usage: needs-owner/, "needs-owner");
  bad(w, /Usage: lesson/, "lesson");
  bad(w, /Usage: route/, "route");
  bad(w, /unknown spec kind/, "spec");
  bad(w, /unknown spec kind/, "spec", "bogus", "--what", "x", "--accept", "y");
  bad(w, /No goal is running/, "split");
  // start's own argument and folder checks — all fail before a driver spawns.
  bad(w, /goal first/, "start", "--goal", "");
  bad(w, /goal first/, "start", "--dir", w.proj);
  bad(w, /No such folder/, "start", "--dir", path.join(w.root, "nope"), "--goal", "g");
  bad(w, /never works in your home folder/, "start", "--dir", w.home, "--goal", "g");
  bad(w, /never works in your home folder/, "start", "--dir", w.root, "--goal", "g");
  // Everything else recovers or answers on empty state.
  const s = JSON.parse(ok(w, "status").stdout);
  assert.equal(s.goal, null); assert.deepEqual(s.jobs, []);
  JSON.parse(ok(w, "jobs").stdout);
  ok(w, "agents"); ok(w, "pace");
  assert.deepEqual(JSON.parse(ok(w, "goals").stdout).goals, []);
  assert.match(ok(w, "scorecard").stdout, /No reviewed jobs yet/);
  assert.deepEqual(JSON.parse(ok(w, "signals").stdout), []);
  ok(w, "log"); ok(w, "summary"); assert.deepEqual(JSON.parse(ok(w, "reviews").stdout), []);
  assert.match(ok(w, "remote").stdout, /remote-status\.txt/);
  assert.equal(JSON.parse(ok(w, "route", "plan").stdout).model, "opus");
  assert.equal(JSON.parse(ok(w, "route", "bogus-step").stdout).model, "opus", "an unknown step routes to Opus, not a crash");
  assert.match(ok(w, "spec", "test", "--what", "the parser", "--accept", "tests pass").stdout, /Done when: tests pass/);
  JSON.parse(ok(w, "split", "--goal", "1. alpha\n2. beta").stdout);
  ok(w, "spare"); ok(w, "note", "hello"); ok(w, "needs-owner", "a reason"); ok(w, "lesson", "a lesson");
  assert.equal(ok(w, "recover").stdout.trim(), "ok");
  ok(w, "stop");
  assert.match(ok(w, "batchreview").stdout, /No merged jobs are waiting for review/);
  ok(w, "selfmerge");   // internal command, unknown id: exits quietly
  // The backlog works end to end with --dir and no goal.
  assert.match(ok(w, "backlog", "--dir", w.proj).stdout, /backlog is empty/);
  assert.match(ok(w, "backlog", "add", "--dir", w.proj, "--kind", "task", "--text", "first").stdout, /Backlog #1/);
  ok(w, "backlog", "take", "1", "--dir", w.proj, "--job", "5");
  ok(w, "backlog", "done", "1", "--dir", w.proj);
  assert.match(ok(w, "backlog", "--dir", w.proj).stdout, /#1 \[done\] task: first/);
}

// ------------------------------------------------- a running goal, real args
// jobs.json is written directly (no driver): a running goal, one finished job,
// one waiting job and one really-running job (a live process whose cmdline says
// "grok", so sweep's alive() check keeps it running). Practice mode is the
// default with no settings.json, so delegate logs prompts instead of launching.
{
  const w = world(); writeData(w);
  const fake = spawn("bash", ["-c", "exec -a grok sleep 300"], { detached: true, stdio: "ignore" });
  fake.unref();
  const g = { id: "g1", text: "1. add a\n2. add b", dir: w.proj, items: ["add a", "add b"], status: "running",
    session: "s1", startedAt: Date.now() - 60e3, started: true, driverPid: 0, brainPid: 0 };
  writeJobs(w, { goal: g, next: 4, guards: {}, jobs: [
    { id: 1, goal: "g1", agent: "grok", dir: w.proj, repo: w.proj, files: ["a.txt"], task: "add a", status: "finished",
      createdAt: Date.now() - 30e3, startedAt: Date.now() - 30e3, finishedAt: Date.now() - 20e3, commit: "", summary: "added a" },
    { id: 2, goal: "g1", agent: "grok", dir: w.proj, repo: w.proj, files: ["b.txt"], task: "add b", status: "waiting", createdAt: Date.now() - 25e3 },
    { id: 3, goal: "g1", agent: "grok", dir: w.proj, repo: w.proj, files: [], task: "look around", status: "running",
      pid: fake.pid, createdAt: Date.now() - 10e3, startedAt: Date.now() - 10e3 },
  ] });
  // review: bad verdict, unknown id, and jobs that aren't finished yet.
  bad(w, /Usage: review/, "review", "1", "bogus");
  bad(w, /No job 99/, "review", "99", "accept");
  bad(w, /only a finished job/, "review", "2", "accept", "--note", "x");
  bad(w, /only a finished job/, "review", "3", "accept");
  // wait hands out the finished job for review.
  assert.equal(JSON.parse(ok(w, "wait", "--timeout", "5").stdout).review.id, 1);
  // The ready queue: add, list, bad removals.
  assert.match(ok(w, "queue").stdout, /ready queue is empty/);
  assert.match(ok(w, "queue", "--task", "add c", "--files", "c.txt").stdout, /Queued as task 1/);
  assert.match(ok(w, "queue").stdout, /1\. add c\s+\[c\.txt\]/);
  bad(w, /No queued task NaN/, "queue", "rm");
  bad(w, /No queued task 99/, "queue", "rm", "99");
  // Accepting job 1 auto-hands the queued task to grok — practice mode: born finished as job 4.
  const ra = ok(w, "review", "1", "accept", "--note", "ok").stdout;
  assert.match(ra, /Job 1 accepted/);
  assert.match(ra, /Next queued task (logged for grok \(practice\)|went to grok)/, ra);
  assert.equal(JSON.parse(ok(w, "wait", "--timeout", "5").stdout).review.id, 4);
  ok(w, "review", "4", "accept", "--note", "fine");
  assert.match(ok(w, "queue").stdout, /ready queue is empty/, "the queued task was consumed");
  // delegate's own argument checks, then a real handoff in practice mode.
  bad(w, /delegate needs --agent ID and --task TEXT/, "delegate");
  bad(w, /delegate needs --agent ID and --task TEXT/, "delegate", "--agent", "grok");
  bad(w, /delegate needs --agent ID and --task TEXT/, "delegate", "--task", "x");
  bad(w, /not available/, "delegate", "--agent", "bogus", "--task", "x");
  bad(w, /not available/, "delegate", "--agent", "claude", "--task", "x", "--files", "z.txt");
  assert.match(ok(w, "delegate", "--agent", "grok", "--files", "z.txt", "--task", "add z").stdout, /Practice job 5/);
  ok(w, "review", "5", "accept", "--note", "ok");
  // check: ticks an item, refuses out-of-range and non-numeric ones.
  assert.match(ok(w, "check", "1", "--note", "did it myself").stdout, /Item 1 ticked/);
  for (const n of [[], ["0"], ["3"], ["x"], ["1.5"]]) bad(w, /Pick an item from 1 to 2/, "check", ...n);
  // job ID gives the full record; a bad id is a plain failure.
  const j2 = JSON.parse(ok(w, "job", "2").stdout);
  assert.equal(j2.id, 2); assert.equal(j2.status, "waiting");
  bad(w, /No job 99/, "job", "99");
  // wait with only running/waiting jobs left reports who is still going (~5 s).
  const w3 = JSON.parse(ok(w, "wait", "--timeout", "1").stdout);
  assert.equal(w3.review, null);
  assert.deepEqual(w3.stillRunning.map((j) => j.id), [3]);
  // status sees the same world; practice is on (no settings.json).
  const st = JSON.parse(ok(w, "status").stdout);
  assert.equal(st.goal.id, "g1"); assert.equal(st.practice, true);
  assert.ok(st.jobs.some((j) => j.id === 3 && j.status === "running"));
  // stop halts the goal and every live job.
  ok(w, "stop");
  const after = readJobs(w);
  assert.equal(after.goal.status, "stopped");
  assert.equal(after.jobs.find((j) => j.id === 2).status, "stopped");
  assert.equal(after.jobs.find((j) => j.id === 3).status, "stopped");
  try { process.kill(-fake.pid, "SIGKILL"); } catch {}
  try { process.kill(fake.pid, "SIGKILL"); } catch {}
}

// ------------------------------------------------------- corrupt store files
// Every corrupt shape must be survived by the whole SAFE_COMMANDS battery (or
// FULL_COMMANDS when data.json itself is fine): exit 0 or a plain exit 1, never
// a stack trace. jobs.json is the big one — it holds the goal AND the jobs.
{
  const JOBS_VARIANTS = [
    ["empty file", ""],
    ["not JSON", "{ this is not json"],
    ["a JSON array", "[]"],
    ["a JSON string", '"just a string"'],
    ["a JSON number", "42"],
    ["jobs not an array", '{"goal": null, "jobs": {"a": 1}, "next": 1}'],
    ["junk job entries", '{"goal": null, "jobs": [null, {}, "x", 5, true], "next": 1}'],
    ["a string goal", '{"goal": "oops", "jobs": [], "next": 1}'],
    ["an array goal", '{"goal": [1, 2], "jobs": [], "next": 1}'],
    ["an empty-object goal", '{"goal": {}, "jobs": [], "next": 1}'],
    ["a done goal, no jobs", (w) => JSON.stringify({ goal: { id: "g", text: "old goal", dir: w.proj, status: "done", startedAt: 1, finishedAt: 2 }, jobs: [], next: 1 })],
    ["a running goal with no dir", '{"goal": {"id": "g", "text": "x", "status": "running", "startedAt": 1}, "jobs": [], "next": 1}'],
    ["a running goal and dir", (w) => JSON.stringify({ goal: { id: "g", "text": "x", "dir": w.proj, status: "running", startedAt: 1 }, jobs: [], next: 1 })],
    ["a finished job with no dir", (w) => JSON.stringify({ goal: { id: "g", "text": "x", "dir": w.proj, "status": "running", "startedAt": 1 }, next: 2, guards: {},
      jobs: [{ id: 1, goal: "g", agent: "grok", status: "finished", task: "t", summary: "s", startedAt: 1, finishedAt: 2 }] })],
    ["a dead running job, junk guard", (w) => JSON.stringify({ goal: { id: "g", "text": "x", "dir": w.proj, "status": "running", "startedAt": 1 }, next: 2, guards: {},
      jobs: [{ id: 1, goal: "g", agent: "grok", dir: w.proj, repo: w.proj, files: [], task: "t", status: "running", pid: 999999, guardBefore: "junk", startedAt: 1 }] })],
    // A running record with no dir, worktree or tmp: there is nowhere its done
    // file could be, so the sweep must not die on path.join(undefined).
    ["a running job with no dir", (w) => JSON.stringify({ goal: { id: "g", text: "x", dir: w.proj, status: "running", startedAt: 1 }, next: 2, guards: {},
      jobs: [{ id: 1, goal: "g", agent: "grok", status: "running", task: "t", startedAt: 1 }] })],
  ];
  for (const [name, content, commands] of JOBS_VARIANTS) {
    const w = world(); writeData(w);
    writeJobs(w, typeof content === "function" ? content(w) : content);
    battery(w, commands ? commands(w) : FULL_COMMANDS(w));
    // Whatever happened, jobs.json must still be parseable JSON afterwards —
    // a command may rewrite it, but never leave a torn file.
    JSON.parse(fs.readFileSync(jobsFile(w), "utf8"));
    console.log(`  jobs.json variant survived: ${name}`);
  }
}
{
  // The other store files, each in its corrupt shapes.
  const FILE_VARIANTS = [
    ["goal-queue.json", ["", "{bad", "[]", '"x"', '{"goals": "x", "paused": 5}', '{"goals": [null, {"text": "t"}], "paused": ""}']],
    ["queue.json", [["empty file", ""], ["not JSON", "{bad"], ["a JSON array", "[]"], ["projects not an object", '{"projects": "x", "next": -1}'],
      ["project entry not an array", (w) => JSON.stringify({ next: 1, projects: { [w.proj]: "not-a-list" } })],
      ["junk task entries", (w) => JSON.stringify({ next: 1, projects: { [w.proj]: [null, 5, "x", { id: 99, task: "old", status: "done" }] } })],
      ["fractional next", '{"next": 1.5, "projects": {}}']]],
    ["scorecard.json", ["", "{bad", "[]", '"x"', '{"agents": "x", "seen": "y"}', '{"agents": {"grok": "x"}, "seen": "z"}']],
    ["reviews.json", ["", "{bad", "[]", '{"pending": "x", "reviewed": "y"}']],
    ["settings.json", ["", "{bad", '"x"', "[]", '{"constancePractice": "yes"}', '{"constanceMaxCopies": -5, "constanceKeyringAgents": "grok"}']],
  ];
  for (const [file, variants] of FILE_VARIANTS) {
    const isSettings = file === "settings.json";
    for (const variant of variants) {
      const [name, content] = Array.isArray(variant) ? variant : [JSON.stringify(variant).slice(0, 60), variant];
      const w = world(); writeData(w);
      (isSettings ? writeTabs : writeJSON)(w, file, typeof content === "function" ? content(w) : content);
      battery(w, FULL_COMMANDS(w));
      console.log(`  ${file} variant survived: ${name}`);
    }
  }
  // data.json corrupt: invalid JSON means readData() falls back to no agents and
  // freshData() would run the collector — so only the SAFE_COMMANDS run here.
  for (const content of ["", "{bad"]) {
    const w = world();
    writeTabs(w, "data.json", content);
    battery(w, SAFE_COMMANDS(w));
    console.log(`  data.json variant survived: ${JSON.stringify(content)}`);
  }
  // data.json valid JSON but the wrong shape: readData() treats a bad payload
  // or agent list as no data, so the whole battery is safe.
  for (const [name, content] of [
    ["null", "null"],
    ["agents not an array", () => JSON.stringify({ generatedAt: Date.now(), agents: "nope" })],
    ["null agent entries", () => JSON.stringify({ generatedAt: Date.now(), agents: [null, 5, "x", { id: "grok" }] })],
    ["no agents key", () => JSON.stringify({ generatedAt: Date.now() })],
    ["an array payload", "[]"],
    ["a number payload", "42"],
    ["limits not an array", () => JSON.stringify({ generatedAt: Date.now(), agents: [{ id: "grok", installed: true, signedIn: true, limits: "junk" }] })],
  ]) {
    const w = world(); writeTabs(w, "data.json", typeof content === "function" ? content() : content);
    // Payloads without a fresh generatedAt (null, [], 42) make readData() report
    // no data, so agents/pace/spare run the collector synchronously first — up
    // to its own 120 s timeout. Give those commands 180 s; every assertion stays.
    battery(w, FULL_COMMANDS(w), 180000);
    console.log(`  data.json wrong-shape variant survived: ${name}`);
  }
}

// ------------------------------------------------- corrupt queue.json, live goal
// queue.json feeds the ready queue, fillSlots and autoNext, so it gets its own
// world with a running goal: every corrupt shape must still let status/jobs/
// queue/check/review work or fail plainly.
{
  const QUEUE_VARIANTS = [
    ["empty file", ""],
    ["not JSON", "{bad"],
    ["a JSON array", "[]"],
    ["projects not an object", '{"projects": "x", "next": -1}'],
    ["project entry not an array", (w) => JSON.stringify({ next: 1, projects: { [w.proj]: "not-a-list" } })],
    ["junk task entries", (w) => JSON.stringify({ next: 1, projects: { [w.proj]: [null, 5, "x", { id: 99, task: "old", status: "done" }] } })],
    ["fractional next", '{"next": 1.5, "projects": {}}'],
  ];
  for (const [name, content] of QUEUE_VARIANTS) {
    const w = world(); writeData(w);
    const g = { id: "g1", text: "1. add a", dir: w.proj, items: ["add a"], status: "running", session: "s", startedAt: Date.now() - 1000, started: true };
    writeJobs(w, { goal: g, next: 2, guards: {}, jobs: [
      { id: 1, goal: "g1", agent: "grok", dir: w.proj, repo: w.proj, files: ["a.txt"], task: "add a", status: "finished",
        createdAt: Date.now() - 500, startedAt: Date.now() - 500, finishedAt: Date.now() - 100, commit: "", summary: "added a" },
    ] });
    writeJSON(w, "queue.json", typeof content === "function" ? content(w) : content);
    // status and jobs sweep + fillSlots + refillQueue over the corrupt queue.
    run(w, "status"); run(w, "jobs");
    // queue itself: lists whatever survived, adds a task, lists it again.
    run(w, "queue");
    const add = run(w, "queue", "--task", "queued work");
    assert.equal(add.status, 0, `${name}: queue add failed: ${add.stderr}`);
    run(w, "queue");
    // check and a review still work; accepting hands the queued task out (practice).
    run(w, "check", "1");
    const rv = run(w, "review", "1", "accept", "--note", "ok");
    assert.equal(rv.status, 0, `${name}: review failed: ${rv.stderr}`);
    assert.match(rv.stdout, /Job 1 accepted/, `${name}: ${rv.stdout}`);
    console.log(`  queue.json variant survived: ${name}`);
  }
}

// ------------------------------------------------------------ no data wiped
// A healthy store must come out of the whole read-mostly battery with its goal
// and jobs intact — commands may annotate (a ticked check, a log line) but must
// never drop or corrupt what was there.
{
  const w = world(); writeData(w);
  const g = { id: "g9", text: "1. add a\n2. add b", dir: w.proj, items: ["add a", "add b"], status: "done",
    session: "s", startedAt: Date.now() - 7200e3, finishedAt: Date.now() - 3600e3, report: "done" };
  const job = (id, status, extra = {}) => ({ id, goal: "g9", agent: "grok", dir: w.proj, repo: w.proj, files: [`f${id}.txt`],
    task: `task ${id}`, status, createdAt: Date.now() - 7000e3, startedAt: Date.now() - 6900e3, finishedAt: Date.now() - 6800e3, ...extra });
  writeJobs(w, { goal: g, next: 5, guards: {}, jobs: [
    job(1, "accepted", { reviewedAt: 1 }), job(2, "sent back", { reviewedAt: 1 }), job(3, "conflict"), job(4, "stopped"),
  ] });
  writeJSON(w, "queue.json", { next: 2, projects: { [w.proj]: [{ id: 1, task: "keep me", files: [], agent: "", status: "pending", createdAt: Date.now() }] } });
  writeJSON(w, "goal-queue.json", { goals: [{ id: "q1", text: "next goal", dir: w.proj, addedAt: 1 }], paused: "" });
  writeJSON(w, "scorecard.json", { agents: { grok: { jobs: 2, accepted: 1, sentBack: 1, tokensSum: 0, tokensN: 0, msSum: 0, msN: 0, recent: [] } }, seen: ["g9:1"] });
  // Everything but `goals next`: with a takeable goal queued it would really
  // start it (and a driver) — that path is covered by the goal-queue errors above.
  battery(w, FULL_COMMANDS(w).filter((a) => !(a[0] === "goals" && a[1] === "next")));
  const after = readJobs(w);
  assert.equal(after.goal.id, "g9"); assert.equal(after.goal.status, "done");
  assert.deepEqual(after.jobs.map((j) => [j.id, j.status]), [[1, "accepted"], [2, "sent back"], [3, "conflict"], [4, "stopped"]],
    "every job kept its id and status");
  const q = JSON.parse(fs.readFileSync(path.join(w.cdir, "queue.json"), "utf8"));
  assert.equal(q.projects[w.proj][0].task, "keep me", "the ready-queue task survived");
  const gq = JSON.parse(fs.readFileSync(path.join(w.cdir, "goal-queue.json"), "utf8"));
  assert.equal(gq.goals[0].text, "next goal", "the goal queue survived");
  const sc = JSON.parse(fs.readFileSync(path.join(w.cdir, "scorecard.json"), "utf8"));
  assert.equal(sc.agents.grok.jobs, 2, "the scorecard survived");
}

// ------------------------------------------------------------------ cleanup
for (const w of worlds) { try { fs.rmSync(w.root, { recursive: true, force: true }); } catch {} }
console.log("constance.deep: tests passed");

// The crash cases this file used to document as BUG notes are regression
// variants above: "junk job entries" (null in jobs[]), "a running job with no
// dir", "a string goal" (needs-owner included in the full battery) and the
// data.json wrong-shape variants (status/agents/pace/summary/remote/log/spare
// all run against them).
