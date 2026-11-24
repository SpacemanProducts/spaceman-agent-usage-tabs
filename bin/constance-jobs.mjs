// Constance's job file, log and handoff prompts.
//
// State lives in <state>/constance/: jobs.json (the goal plus one entry per task: agent, folder, what it
// was told, status) and log.jsonl (every handoff, result and review, newest last). jobs.json is written
// atomically under a small lock, because the driver, Constance's own tool calls and the Stop button all
// touch it. After a restart everything needed to pick up again is in these two files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STATUSES = ["waiting", "running", "finished", "accepted", "sent back", "stopped"];

export function stateDir(env = process.env) {
  const base = env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), ".local/state");
  return path.join(base, "omarchy/agent-usage-tabs/constance");
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function openStore(dir = stateDir()) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "jobs.json"), logFile = path.join(dir, "log.jsonl"), lock = path.join(dir, "jobs.lock");
  const read = () => {
    try { const d = JSON.parse(fs.readFileSync(file, "utf8")); return { goal: d.goal || null, jobs: Array.isArray(d.jobs) ? d.jobs : [], next: d.next || 1 }; }
    catch { return { goal: null, jobs: [], next: 1 }; }
  };
  const write = (d) => { const tmp = file + "." + process.pid + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + "\n"); fs.renameSync(tmp, file); };
  // Run fn(state) under the lock and save what it returns state as. A lock older than 10 s is stale.
  const update = (fn) => {
    for (let i = 0; ; i++) {
      try { fs.mkdirSync(lock); break; } catch {
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.rmdirSync(lock); continue; } } catch {}
        if (i > 200) throw new Error("job file is locked");
        sleepSync(25);
      }
    }
    try { const d = read(); const out = fn(d); write(d); return out; } finally { try { fs.rmdirSync(lock); } catch {} }
  };
  const log = (entry) => fs.appendFileSync(logFile, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
  const readLog = (n = 200) => {
    try { return fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).slice(-n).map((l) => JSON.parse(l)); }
    catch { return []; }
  };
  return { dir, file, logFile, read, update, log, readLog };
}

// Two file lists overlap when a path is the same as, or inside, a path in the other list.
export function overlaps(a = [], b = []) {
  const norm = (p) => String(p).replace(/^\.\//, "").replace(/\/+$/, "");
  const hits = [];
  for (const x of a.map(norm)) for (const y of b.map(norm)) {
    if (x === y || x.startsWith(y + "/") || y.startsWith(x + "/") || x === "." || y === ".") hits.push(x === y ? x : `${x} ~ ${y}`);
  }
  return [...new Set(hits)];
}

// The running jobs in the same folder whose files overlap these.
export function conflicts(jobs, dir, files) {
  return jobs.filter((j) => (j.status === "running" || j.status === "waiting") && j.dir === dir && overlaps(j.files, files).length > 0);
}

export const doneFile = (dir, id) => path.join(dir, ".constance", `done-${id}.json`);

// The handoff prompt, self-contained so the agent needs no other context: a folder check first, a git
// status check and what not to touch, the task, tests and build, its own commit (never a push or
// deploy unless the task says so), a plain-text report, and the done file last. With no files listed
// the job is read-only: the agent changes nothing and only reports.
export function handoffPrompt({ id, dir, task, files = [] }) {
  const readOnly = !files || files.length === 0;
  return [
    `Check: this job is for the project folder ${dir}. Run \`pwd\` first; if it is not exactly ${dir}, stop now and change nothing.`,
    `Then run \`git status\`. Other agents may be working in this folder at the same time: never touch, stage, revert or commit changes you did not make.`,
    ``,
    `Task (job ${id}, from Constance):`,
    String(task).trim(),
    ``,
    readOnly
      ? `This is a read-only job: change nothing, create nothing, delete nothing.`
      : `Only edit these files: ${files.join(", ")}. Everything else is off-limits; if the task needs other files, say so in your report instead of editing them.`,
    `Run the project's tests and build, if it has them, and make sure they pass.`,
    ...(readOnly ? [] : [`When you are done, commit only your own work in its own commit: \`git add\` the files you changed by name (never \`git add -A\` or \`git add .\`), then \`git commit\` with a short message.`]),
    `Do not push or deploy unless the task explicitly says to.`,
    ``,
    `Report in plain text: what you changed, the test and build results, and which files you touched. No screenshots unless checking the look itself is the task. If you could not finish, say why in a few lines and stop.`,
    ``,
    `Last step, even if you could not finish: write the file ${doneFile(dir, id)} containing JSON like {"summary": "what you did or why you stopped, in a few lines", "commit": "the full hash of your commit, or empty if you made none", "files": ["the files you changed"]}. Do not commit that file.`,
  ].join("\n");
}

// Finished jobs waiting for review, oldest finish first (two that finish together are reviewed in order).
export function reviewQueue(jobs) {
  return jobs.filter((j) => j.status === "finished").sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0) || a.id - b.id);
}
