// How much of her own (Opus) context a goal costs: the same fake goal run against
// a given constance.mjs, with a fake `claude` that keeps a context ledger per
// session and acts only on what its prompt says, like a real one would.
//
//   node bin/constance-opus-bench.mjs [--cli PATH] [--items N] [--label TEXT] [--log FILE]
//
// --cli defaults to this checkout's constance.mjs; point it at an older checkout
// to measure "before". Everything runs in a mktemp folder with a fake home (never
// the real one), fake Devin copies and a quiet fake busctl/notify-send.
//
// The ledger (in characters; tokens ~ chars/4): a session's context starts with
// her role (system prompt) and the prompt, and grows with every tool call she
// makes and every tool output she reads; `--resume` carries it on. Each turn (one
// model call) re-reads the whole context, so `inputTokens` is the sum over turns
// and `peakTokens` the largest single context. NOT counted: Claude Code's own
// system prompt and tool definitions (a fixed cost per turn — see `turns`) and
// prompt caching (real limits count cached re-reads at a discount).
//
// Both modes do the same work: one `C agents` check per planning pass, one
// delegate per item, one review per job. Old mode (one long session): delegate
// everything, then `C wait` -> review until nothing is open, then report. Step
// mode: a planning step delegates from the handoff file it was handed; a review
// step reviews the jobs its prompt lists.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const tokens = (chars) => Math.ceil(chars / 4);

// The fake brain. Writes one ledger line per run to $BENCH_OUT.
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const argv = process.argv.slice(2), prompt = argv.at(-1);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ""; };
const role = opt("--append-system-prompt"), resume = opt("--resume"), session = resume || opt("--session-id");
const dir = process.env.BENCH_SESSIONS, out = process.env.BENCH_OUT, CLI = process.env.BENCH_CLI;
const file = path.join(dir, session + ".json");
let conv = 0;
if (resume) { try { conv = JSON.parse(fs.readFileSync(file, "utf8")).conv; } catch {} }
const runStart = conv;
let turns = 0, input = 0, peak = 0, outChars = 0;
conv += prompt.length;
// One model call: reads role + the whole conversation, then writes \`said\`.
const turn = (said) => { turns++; const ctx = role.length + conv; input += ctx; peak = Math.max(peak, ctx); conv += said.length; outChars += said.length; };
const C = (...a) => {
  turn("I'll run: node constance.mjs " + a.join(" ") + " ".repeat(120));  // her tool call, with a little reasoning
  const r = spawnSync("node", [CLI, ...a], { encoding: "utf8", maxBuffer: 64 << 20 });
  conv += (r.stdout || "").length + (r.stderr || "").length;                 // the tool result she reads
  return r;
};
const finish = (text) => {
  turn(text);
  fs.writeFileSync(file, JSON.stringify({ conv }));
  fs.appendFileSync(out, JSON.stringify({ session, resumed: !!resume, kind: prompt.startsWith("Step: review") ? "review" : prompt.startsWith("Step: plan") ? "plan" : resume ? "resume" : "first",
    turns, inputChars: input, peakChars: peak, outChars, startChars: runStart, promptChars: prompt.length, roleChars: role.length }) + "\n");
  console.log(text);
};
// One planning pass: check who is free, delegate each item; returns the refused ones
// (e.g. past Devin's copy limit), which a later pass tries again.
const delegateAll = (todo) => { C("agents"); return todo.filter((n) => C("delegate", "--agent", "devin", "--files", "f" + n + ".txt", "--item", String(n), "--title", "adding f" + n, "--task", "add f" + n).status !== 0); };
if (prompt.startsWith("Step: plan.")) {
  const todo = [...prompt.matchAll(/^- \[ \] (\d+)\. .* — todo$/gm)].map((m) => Number(m[1]));
  if (todo.length) delegateAll(todo);
  C("handoff", "decide", "one small devin copy per item; their files never overlap");
  C("handoff", "next", "review each copy against its item");
  finish("Planned and delegated items " + todo.join(", ") + ".");
} else if (prompt.startsWith("Step: review.")) {
  for (const m of prompt.matchAll(/^\{"id":(\d+),/gm)) C("review", m[1], "accept", "--note", "matches its item");
  C("handoff", "next", "nothing left to watch");
  finish("Reviewed the batch. Report: every item is done.");
} else {
  // Old mode: the goal text is in the first prompt; a resume just carries on.
  let pending = [];
  if (!resume) {
    // The first item shares its line with "Goal from the owner: ".
    const todo = [...prompt.matchAll(/^(?:Goal from the owner: )?(\d+)\. add f/gm)].map((m) => Number(m[1]));
    pending = delegateAll(todo);
  }
  for (;;) {
    const w = C("wait", "--timeout", "540");
    let j = {}; try { j = JSON.parse(w.stdout); } catch {}
    if (j.review) {
      C("review", String(j.review.id), "accept", "--note", "matches its item");
      if (pending.length) pending = delegateAll(pending);   // a slot freed up: hand out what was refused
      continue;
    }
    if (/No jobs are running/.test(j.next || "")) break;
    if (/Stopped/.test(j.next || "")) break;
  }
  finish("Report: every item is done; each Devin copy was reviewed and accepted.");
}
`;

// Fake Devin copy: edits its one file in its worktree, commits, writes its done
// file. Item n finishes about n*0.6 s after the go-file, so returns are staggered.
const FAKE_DEVIN = String.raw`#!/bin/bash
p="${"$"}{@: -1}"; f=$(grep -o '/[^ ]*/.constance/done-[0-9]*.json' <<<"$p" | head -1)
name=$(sed -n 's/^Only edit these files: \([^ ,]*\)\..*/\1/p' <<<"$p" | head -1); name=${"$"}{name:-x.txt}
n=$(tr -dc 0-9 <<<"$name"); sleep $(awk "BEGIN{print 0.6*${"$"}{n:-1}}")
before=$(git rev-parse HEAD)
echo "devin $name" > "$name"; git add "$name"; git commit -qm "devin: $name" || true
after=$(git rev-parse HEAD); c=""; [[ "$after" != "$before" ]] && c="$after"
echo "{\"summary\": \"added ${"$"}{name%.*}; its check passes\", \"commit\": \"$c\", \"files\": [\"$name\"]}" > "$f"
`;

export async function runBench({ cli = path.join(HERE, "constance.mjs"), items = 6, timeoutMs = 240e3, keep = false } = {}) {
  let root = "";
  for (const base of ["/var/tmp", path.join(os.homedir(), ".cache")]) {
    if (!path.isAbsolute(base)) continue;
    try { fs.mkdirSync(base, { recursive: true }); root = fs.mkdtempSync(path.join(base, "constance-bench-")); break; } catch {}
  }
  if (!root) root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-bench-"));
  if (!path.isAbsolute(root)) throw new Error("scratch root must be absolute");
  const state = path.join(root, "state"), bin = path.join(root, "bin"), repo = path.join(root, "repo"), sessions = path.join(root, "sessions");
  const tabs = path.join(state, "omarchy/agent-usage-tabs"), cdir = path.join(tabs, "constance");
  for (const d of [tabs, bin, repo, sessions]) fs.mkdirSync(d, { recursive: true });
  if (!path.isAbsolute(bin)) throw new Error("the fake bin dir on PATH must be absolute");
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n"); git("add", "a.txt"); git("commit", "-qm", "init");
  const soon = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  const writeData = () => fs.writeFileSync(path.join(tabs, "data.json"), JSON.stringify({ generatedAt: Date.now(), agents: [
    { id: "claude", installed: true, signedIn: true, limits: [{ title: "Session", percent: 0.1, resetsAt: soon(4) }, { title: "Weekly", percent: 0.1, resetsAt: soon(150) }] },
    { id: "devin", name: "Devin", installed: true, signedIn: true, limits: [{ title: "Daily", percent: 0.1 }] }] }));
  writeData();
  fs.writeFileSync(path.join(tabs, "settings.json"), JSON.stringify({ constancePractice: false, constanceSelfMerge: false, constanceUseItOrLoseIt: false }));
  fs.writeFileSync(path.join(bin, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "devin"), FAKE_DEVIN, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "busctl"), "#!/bin/bash\nsleep 30\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "notify-send"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  const fakeHome = path.join(root, "home"); fs.mkdirSync(path.join(fakeHome, "Projects"), { recursive: true });
  const proc = path.join(root, "proc"); fs.mkdirSync(proc);
  fs.writeFileSync(path.join(proc, "loadavg"), "0.10 0.50 0.50 1/500 999\n");
  fs.writeFileSync(path.join(proc, "meminfo"), "MemTotal:       33554432 kB\nMemFree:        20971520 kB\nMemAvailable:   20971520 kB\n");
  const ledger = path.join(root, "ledger.jsonl");
  const env = { ...process.env, HOME: fakeHome, SQUAD_PROJECTS: path.join(fakeHome, "Projects"), XDG_STATE_HOME: state, XDG_DATA_HOME: path.join(fakeHome, ".local", "share"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"), PATH: `${bin}:${process.env.PATH}`,
    CONSTANCE_WORKTREES: path.join(root, "worktrees"), CONSTANCE_PROC: proc, CONSTANCE_RAMP_GAP_MS: "0", CONSTANCE_TOKENS_GAP_MS: "500", CONSTANCE_NO_NOTIFY: "1",
    CONSTANCE_WAIT_TICK_MS: "300", BENCH_CLI: cli, BENCH_SESSIONS: sessions, BENCH_OUT: ledger };
  const run = (...a) => spawnSync("node", [cli, ...a], { env, encoding: "utf8" });
  const jobsFile = () => { try { return JSON.parse(fs.readFileSync(path.join(cdir, "jobs.json"), "utf8")); } catch { return { goal: null, jobs: [] }; } };
  const pids = new Set();
  const note = () => { const g = jobsFile().goal; if (g?.driverPid) pids.add(g.driverPid); if (g?.brainPid) pids.add(g.brainPid); try { pids.add(Number(fs.readFileSync(path.join(cdir, "watcher.pid"), "utf8"))); } catch {} };
  const goal = Array.from({ length: items }, (_, i) => `${i + 1}. add f${i + 1}`).join("\n");
  const t0 = Date.now();
  try {
    const r = run("start", "--dir", repo, "--goal", goal);
    if (r.status !== 0) throw new Error("start failed: " + r.stderr);
    let g = null;
    while (Date.now() - t0 < timeoutMs) {
      note(); writeData();
      g = jobsFile().goal;
      if (g && !["running", "paused"].includes(g.status)) break;
      await new Promise((res) => setTimeout(res, 300));
    }
    note();
    if (!g || g.status !== "done") throw new Error("the bench goal didn't finish: " + JSON.stringify(g)?.slice(0, 400));
    const runs = fs.readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const jobs = jobsFile().jobs.filter((j) => j.goal === g.id);
    const sum = (k) => runs.reduce((a, x) => a + x[k], 0);
    return {
      cli, items, at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000),
      jobs: jobs.length, accepted: jobs.filter((j) => j.status === "accepted").length,
      brainRuns: runs.length, sessions: new Set(runs.map((x) => x.session)).size, resumes: runs.filter((x) => x.resumed).length,
      kinds: runs.map((x) => x.kind), turns: sum("turns"),
      inputTokens: tokens(sum("inputChars")), peakTokens: tokens(Math.max(...runs.map((x) => x.peakChars))),
      outputTokens: tokens(sum("outChars")), perRun: runs.map((x) => ({ kind: x.kind, turns: x.turns, inputTokens: tokens(x.inputChars), peakTokens: tokens(x.peakChars) })),
    };
  } finally {
    for (const pid of pids) { if (pid) { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} } } }
    if (!keep) fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = (k, d = "") => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
  const res = await runBench({ cli: path.resolve(arg("--cli", path.join(HERE, "constance.mjs"))), items: Number(arg("--items", "6")) || 6 });
  const label = arg("--label");
  const line = { ...(label ? { label } : {}), ...res };
  if (arg("--log")) fs.appendFileSync(arg("--log"), JSON.stringify(line) + "\n");
  process.stdout.write(JSON.stringify(line, null, 2) + "\n");
}
