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

export function writeSurpriseState(file, action, at) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 5000;
  let lockFd;
  while (lockFd === undefined) {
    try { lockFd = fs.openSync(lock, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST" || Date.now() >= deadline) throw error;
      Atomics.wait(wait, 0, 0, 10);
    }
  }
  try {
    let current = null;
    try { current = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const next = updateSurpriseState(current, action, at);
    if (JSON.stringify(next) === JSON.stringify(current)) return next;
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
  if (action === "notify") await showNotification(at, title, body);
  else writeSurpriseState(stateFile, action, at);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => { logError(error); process.exitCode = 1; });
}
