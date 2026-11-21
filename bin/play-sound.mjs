#!/usr/bin/env node
// Plays the bundled cha-ching at a volume (0-100), detached, never blocking the
// collector. Usage: play-sound.mjs <volume 0-100> [file]
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DEFAULT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "sounds", "cha-ching.wav");
const clampVol = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0; };

// Picks the first available player. `has(name)` says whether a binary exists.
export function buildPlayCommand(has, file, volume) {
  const v = clampVol(volume) / 100;
  if (v <= 0) return null;
  if (has("pw-play")) return ["pw-play", `--volume=${v.toFixed(2)}`, file];
  if (has("paplay")) return ["paplay", `--volume=${Math.round(v * 65536)}`, file];
  if (has("ffplay")) return ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", "-volume", String(Math.round(v * 100)), file];
  return null;
}

const onPath = (name) => (process.env.PATH || "").split(":").concat(["/usr/bin"]).some((d) => { try { fs.accessSync(path.join(d, name), fs.constants.X_OK); return true; } catch { return false; } });

export function playSound(volume, file = DEFAULT_FILE, has = onPath, spawnFn = spawn) {
  if (!fs.existsSync(file)) return false;
  const cmd = buildPlayCommand(has, file, volume);
  if (!cmd) return false;
  const child = spawnFn(cmd[0], cmd.slice(1), { detached: true, stdio: "ignore" });
  child.on?.("error", () => {});
  child.unref?.();
  return true;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(playSound(process.argv[2] ?? 60, process.argv[3] || DEFAULT_FILE) ? 0 : 1);
}
