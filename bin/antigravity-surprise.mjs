#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export function surpriseNotifyArgs(notice, imagePath) {
  // Critical is the only urgency Omarchy's shell keeps on screen until it is
  // clicked (normal toasts expire after seconds regardless of -t).
  return ["-a", "Cook Meter", "-t", "-1", "-u", "critical", "-i", "emblem-ok-symbolic",
    "-h", "boolean:suppress-sound:true", "-h", "string:category:presence",
    "-h", `string:image-path:${imagePath}`, "--wait", "--action=default=Celebrate",
    notice.title, notice.body];
}

export function immediateResetKind(resets) {
  const immediate = (resets || []).filter(({ a, info }) => !(a?.id === "antigravity" && info?.kind === "surprise"));
  if (!immediate.length) return null;
  return immediate.some(({ info }) => info?.kind === "surprise") ? "surprise" : "scheduled";
}

export function updateSurpriseState(current, action, at) {
  const timestamp = Number(at);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error("surprise timestamp must be a positive integer");
  const state = current && typeof current === "object" && Number.isSafeInteger(current.at)
    ? { at: current.at, clickedAt: Number(current.clickedAt) || 0, playedAt: Number(current.playedAt) || 0 }
    : null;
  if (action === "record") {
    return state?.at === timestamp ? state : { at: timestamp, clickedAt: 0, playedAt: 0 };
  }
  if (action !== "click" && action !== "played") throw new Error(`unknown surprise state action: ${action}`);
  if (!state || state.at !== timestamp) return state;
  if (action === "click") state.clickedAt = timestamp;
  else state.playedAt = timestamp;
  return state;
}

export function surpriseStateFile(stateDir) {
  return path.join(stateDir, "antigravity-surprise.json");
}

// A lock file records its holder's pid. It is stale when that pid is dead, or
// — for locks with no readable pid (written before pids were recorded, or
// caught mid-creation) — once it is older than LOCK_STALE_MS. A lock with a
// live pid is held no matter its age: the critical section is a tiny
// read-modify-write, so a live holder always finishes in milliseconds.
export const LOCK_STALE_MS = 2000;

const pidAlive = (pid) => {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};
const lockPid = (lock) => {
  try {
    const pid = Number(fs.readFileSync(lock, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch { return 0; }
};
// Why the lock at `lock` can be taken over, or "" while it is really held.
function staleLockReason(lock) {
  const pid = lockPid(lock);
  if (pid) return pidAlive(pid) ? "" : `holder ${pid} is gone`;
  try { return Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS ? "no holder recorded" : ""; }
  catch { return ""; }   // gone or unreadable: just retry the create
}

export function writeSurpriseState(file, action, at) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 5000;
  let lockFd;
  while (lockFd === undefined) {
    try { lockFd = fs.openSync(lock, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (staleLockReason(lock)) {
        // Stale: take it over atomically by renaming the corpse aside first,
        // so two waiters can never both delete-and-recreate `lock` (same
        // scheme as constance-mergelock.mjs).
        const aside = `${lock}.gone-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        try { fs.renameSync(lock, aside); }
        catch (e2) { if (e2.code !== "ENOENT") throw e2; continue; }
        // The path may have changed hands between the check and the rename:
        // a live lock moved aside is put back if `lock` is still free; a
        // corpse is deleted.
        if (staleLockReason(aside) === "") {
          if (!fs.existsSync(lock)) { try { fs.renameSync(aside, lock); } catch {} }
        } else {
          try { fs.unlinkSync(aside); } catch {}
        }
        continue;
      }
      if (Date.now() >= deadline) throw error;
      Atomics.wait(wait, 0, 0, 10);
    }
  }
  fs.writeSync(lockFd, String(process.pid));
  try {
    let current = null, corrupt = false;
    try { current = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") {}
      else if (error instanceof SyntaxError) corrupt = true;
      else throw error;
    }
    const next = updateSurpriseState(current, action, at);
    if (!corrupt && JSON.stringify(next) === JSON.stringify(current)) return next;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    return next;
  } finally {
    fs.closeSync(lockFd);
    fs.unlinkSync(lock);
  }
}

const stateDir = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "omarchy", "agent-usage-tabs");
const stateFile = surpriseStateFile(stateDir);
const logError = (error) => {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(path.join(stateDir, "collector.log"), `${new Date().toISOString()} antigravity surprise notification: ${String(error.message || error)}\n`, { mode: 0o600 });
  } catch {}
};

async function showNotification(at, title, body) {
  const image = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "notify", "surprise-burst.svg");
  const child = spawn("notify-send", surpriseNotifyArgs({ title, body }, image), { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output = (output + chunk).slice(-200); });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { errors = (errors + chunk).slice(-500); });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(errors.trim() || `notify-send exited ${code}`)));
  });
  if (output.trim() === "default") writeSurpriseState(stateFile, "click", at);
}

async function main() {
  const [action, at, title, body] = process.argv.slice(2);
  if (action === "notify") {
    if (!title || !body) {
      console.error("usage: antigravity-surprise.mjs notify <at> <title> <body>");
      process.exitCode = 1;
      return;
    }
    await showNotification(at, title, body);
  }
  else writeSurpriseState(stateFile, action, at);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => { logError(error); process.exitCode = 1; });
}
