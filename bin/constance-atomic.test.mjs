// Two robustness fixes in bin/constance.mjs, in a scratch state dir:
//  1. `status | head -c1` (a closed pipe) exits 0 quietly — no 'write EPIPE' stack trace.
//  2. The small state files (refills.json, spare.json, watcher.pid, the >4000-line
//     ratio-samples.jsonl trim) are rewritten via temp file + rename, never in place:
//     writeAtomic() itself is checked for inode change, temp cleanup on a failed
//     rename and clean reads while it rewrites, and the four call sites are checked
//     to go through it. watcher.pid is also exercised for real through `watch`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync, spawn } from "node:child_process";

const CLI = new URL("./constance.mjs", import.meta.url).pathname;
const SRC = fs.readFileSync(CLI, "utf8");

let root = "";
for (const base of ["/var/tmp", path.join(os.homedir(), ".cache")]) {
  try { fs.mkdirSync(base, { recursive: true }); root = fs.mkdtempSync(path.join(base, "constance-atomic-")); break; } catch {}
}
if (!root) root = fs.mkdtempSync(path.join(os.tmpdir(), "constance-atomic-"));
const state = path.join(root, "state"), fakeHome = path.join(root, "home"), proc = path.join(root, "proc");
const tabs = path.join(state, "omarchy/agent-usage-tabs"), cdir = path.join(tabs, "constance");
fs.mkdirSync(cdir, { recursive: true }); fs.mkdirSync(fakeHome, { recursive: true }); fs.mkdirSync(proc);
fs.writeFileSync(path.join(proc, "loadavg"), "0.10 0.50 0.50 1/500 999\n");
fs.writeFileSync(path.join(proc, "meminfo"), "MemTotal:       33554432 kB\nMemFree:        20971520 kB\nMemAvailable:   20971520 kB\n");

// A fake busctl so `watch` has a bus to listen to; a fake bin dir goes first on PATH.
const fakeBin = path.join(root, "bin"); fs.mkdirSync(fakeBin);
fs.writeFileSync(path.join(fakeBin, "busctl"), "#!/bin/bash\nsleep 30\n", { mode: 0o755 });

const env = { ...process.env, HOME: fakeHome, XDG_STATE_HOME: state, XDG_DATA_HOME: path.join(fakeHome, ".local", "share"),
  PATH: `${fakeBin}:${process.env.PATH}`, CONSTANCE_PROC: proc, CONSTANCE_RAMP_GAP_MS: "0", CONSTANCE_TOKENS_GAP_MS: "500" };

// ---- 1. EPIPE: `status | head -c1` -------------------------------------------------
// Enough log history that status's JSON is far bigger than the pipe buffer, so the
// reader is gone long before the writer finishes.
{
  const big = "x".repeat(2000);
  const lines = [];
  for (let i = 0; i < 150; i++) lines.push(JSON.stringify({ at: Date.now() + i, kind: "note", text: `entry ${i} ${big}` }));
  fs.writeFileSync(path.join(cdir, "log.jsonl"), lines.join("\n") + "\n");
  const errFile = path.join(root, "stderr.txt");
  const r = spawnSync("bash", ["-c", `node "$1" status 2>"$2" | head -c1 >/dev/null; printf 'status=%s\\n' "\${PIPESTATUS[0]}"`, "_", CLI, errFile], { env, encoding: "utf8" });
  assert.equal(r.status, 0, "the pipeline ran: " + r.stderr);
  assert.match(r.stdout, /status=0/, `constance exited 0 on a closed pipe, got: ${r.stdout}`);
  const err = fs.existsSync(errFile) ? fs.readFileSync(errFile, "utf8") : "";
  assert.ok(!err.includes("EPIPE") && !err.includes("at "), `no EPIPE stack trace, stderr was: ${err.slice(0, 500)}`);
}

// ---- 2. Atomic writes --------------------------------------------------------------
// Importing runs no command (main only runs when argv[1] is constance.mjs itself);
// the env above is already in place so its state dir is this scratch one.
const { writeAtomic } = await import(pathToFileURL(CLI).href);

{
  const f = path.join(cdir, "atomic-target.json");
  writeAtomic(f, '{"n":1}\n');
  const ino1 = fs.statSync(f).ino;
  writeAtomic(f, '{"n":2}\n');
  assert.notEqual(fs.statSync(f).ino, ino1, "a rewrite lands by rename (new inode), not in place");
  assert.equal(fs.readFileSync(f, "utf8"), '{"n":2}\n');

  // A failed rename removes the temp file and leaves the target alone.
  const occupied = path.join(cdir, "occupied"); fs.mkdirSync(occupied);
  assert.throws(() => writeAtomic(occupied, "x"), /EISDIR|ENOTDIR|EEXIST|EPERM/);
  assert.deepEqual(fs.readdirSync(cdir).filter((n) => n.includes(".tmp")), [], "no temp file is left behind");

  // While it rewrites, a reader only ever sees a complete file.
  const g = path.join(cdir, "atomic-live.json");
  writeAtomic(g, '{"n":0}\n');
  const reader = spawn("node", ["-e", `const fs=require("fs");const f=${JSON.stringify(g)};for(let i=0;i<40000;i++){try{const t=fs.readFileSync(f,"utf8").trim();if(t){const j=JSON.parse(t);if(typeof j.n!=="number")process.exit(2);}}catch(e){if(e.code!=="ENOENT")process.exit(3);}}`], { stdio: "ignore" });
  for (let i = 1; i <= 300; i++) writeAtomic(g, `{"n":${i}}\n`);
  const code = await new Promise((res) => reader.on("exit", res));
  assert.equal(code, 0, "no torn read while writeAtomic was rewriting");
  assert.equal(fs.readFileSync(g, "utf8"), '{"n":300}\n');
}

// The four call sites all go through writeAtomic (the appends stay appends).
assert.match(SRC, /writeAtomic\(refillsFile\(\)/, "refills.json");
assert.match(SRC, /writeAtomic\(spareFile\(\)/, "spare.json");
assert.match(SRC, /writeAtomic\(pidFile,/m, "watcher.pid");
assert.match(SRC, /writeAtomic\(f, lines\.slice\(-4000\)/, "the >4000-line trim rewrite");
assert.equal((SRC.match(/fs\.writeFileSync/g) || []).length, 1, "the only writeFileSync left is inside writeAtomic itself");

// watcher.pid for real: two `watch` runs, the pid file's inode changes each time.
{
  const pidFile = path.join(cdir, "watcher.pid");
  const inoOf = () => { try { return fs.statSync(pidFile).ino; } catch { return null; } };
  const startWatch = () => {
    const p = spawn("node", [CLI, "watch"], { env, stdio: "ignore" });
    p.unref();
    return p;
  };
  const untilFile = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
    return null;
  };
  // `watch` exits by itself once it notices there is no active goal, so it may
  // already be gone: don't wait forever for an 'exit' that already fired.
  const stopWatch = async (p) => {
    if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    await Promise.race([new Promise((r) => p.on("exit", r)), new Promise((r) => setTimeout(r, 3000))]);
  };
  const w1 = startWatch();
  assert.ok(await untilFile(() => inoOf()), "first watch wrote watcher.pid");
  const ino1 = inoOf();
  await stopWatch(w1);
  const w2 = startWatch();
  assert.ok(await untilFile(() => inoOf() && inoOf() !== ino1), "second watch rewrote watcher.pid");
  assert.notEqual(inoOf(), ino1, "watcher.pid was replaced by rename");
  assert.match(fs.readFileSync(pidFile, "utf8").trim(), /^\d+$/, "it holds a pid");
  await stopWatch(w2);
}

fs.rmSync(root, { recursive: true, force: true });
console.log("constance-atomic: all assertions passed");
