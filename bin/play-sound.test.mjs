import assert from "node:assert/strict";
import fs from "node:fs";
import { buildPlayCommand, playSound, DEFAULT_FILE } from "./play-sound.mjs";

// The bundled clip: a real WAV, short (< 2 s), mono 16-bit, not silent.
const b = fs.readFileSync(DEFAULT_FILE);
assert.equal(b.toString("ascii", 0, 4), "RIFF"); assert.equal(b.toString("ascii", 8, 12), "WAVE");
const rate = b.readUInt32LE(24), bits = b.readUInt16LE(34), ch = b.readUInt16LE(22);
const dataLen = b.readUInt32LE(40), seconds = dataLen / (rate * ch * bits / 8);
assert.ok(seconds > 0.3 && seconds < 2, `duration ${seconds}s must be under 2 s`);
assert.equal(bits, 16); assert.equal(ch, 1);
let peak = 0; for (let i = 44; i + 1 < b.length; i += 2) peak = Math.max(peak, Math.abs(b.readInt16LE(i)));
assert.ok(peak > 8000 && peak < 32767, "audible but not clipping");
assert.ok(b.length < 200 * 1024, "small enough to bundle");

// The surprise fanfare is held to the same limits
for (const f of ["../sounds/jackpot.wav"]) {
  const j = fs.readFileSync(new URL(f, import.meta.url));
  const jr = j.readUInt32LE(24), jb = j.readUInt16LE(34), jc = j.readUInt16LE(22), jl = j.readUInt32LE(40);
  const js = jl / (jr * jc * jb / 8); assert.ok(js > 0.3 && js < 2, `jackpot duration ${js}s must be under 2 s`);
  let jp = 0; for (let i = 44; i + 1 < j.length; i += 2) jp = Math.max(jp, Math.abs(j.readInt16LE(i))); assert.ok(jp > 8000 && jp < 32767, "jackpot is audible and not clipping");
}

// Player choice and volume mapping
const has = (...names) => (n) => names.includes(n);
assert.deepEqual(buildPlayCommand(has("pw-play", "paplay"), "f.wav", 60), ["pw-play", "--volume=0.60", "f.wav"]);
assert.deepEqual(buildPlayCommand(has("paplay"), "f.wav", 50), ["paplay", "--volume=32768", "f.wav"]);
assert.equal(buildPlayCommand(has("ffplay"), "f.wav", 100)[0], "ffplay");
assert.equal(buildPlayCommand(has(), "f.wav", 60), null, "no player available");
assert.equal(buildPlayCommand(has("pw-play"), "f.wav", 0), null, "volume 0 plays nothing");
assert.equal(buildPlayCommand(has("pw-play"), "f.wav", 250)[1], "--volume=1.00", "clamped to 100");
assert.equal(buildPlayCommand(has("pw-play"), "f.wav", "abc"), null, "junk volume = silent");

// playSound spawns detached and never throws
const calls = []; const fake = (cmd, args, opts) => { calls.push([cmd, args, opts]); return { unref() {}, on() {} }; };
assert.equal(playSound(40, DEFAULT_FILE, has("pw-play"), fake), true);
assert.equal(calls[0][0], "pw-play"); assert.equal(calls[0][2].detached, true); assert.equal(calls[0][2].stdio, "ignore");
assert.equal(playSound(40, "/nonexistent.wav", has("pw-play"), fake), false);
assert.equal(playSound(0, DEFAULT_FILE, has("pw-play"), fake), false);
assert.equal(calls.length, 1);
console.log("play-sound: all tests passed");
