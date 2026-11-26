// Deep edge-case pass for bin/play-sound.mjs on top of play-sound.test.mjs.
// The module only stats the sound file and spawns a detached player, so every
// fixture lives in a fresh mkdtemp dir and HOME/XDG_* are pointed there; the
// real home folder is never touched. spawn is always faked — nothing real
// plays a sound here.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPlayCommand, playSound, DEFAULT_FILE } from "./play-sound.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "play-sound-deep-"));
const savedEnv = {};
for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
  savedEnv[k] = process.env[k];
  process.env[k] = path.join(tmp, k.toLowerCase());
  fs.mkdirSync(process.env[k], { recursive: true });
}
const savedPath = process.env.PATH;

const has = (...names) => (n) => names.includes(n);
const fakeSpawn = (calls, ret = { on() {}, unref() {} }) =>
  (cmd, args, opts) => { calls.push([cmd, args, opts]); return ret; };
const wav = path.join(tmp, "clip.wav");
fs.writeFileSync(wav, "not really audio");
const empty = path.join(tmp, "empty.wav");
fs.writeFileSync(empty, "");
const dirAsFile = path.join(tmp, "adir.wav");
fs.mkdirSync(dirAsFile);

try {
  // ---- clampVol edges via buildPlayCommand ----
  assert.equal(buildPlayCommand(has("pw-play"), wav, -10), null, "negative clamps to 0 = silent");
  assert.equal(buildPlayCommand(has("pw-play"), wav, -0.4), null, "tiny negative clamps to 0");
  assert.equal(buildPlayCommand(has("pw-play"), wav, Infinity), null, "Infinity is not finite = silent");
  assert.equal(buildPlayCommand(has("pw-play"), wav, -Infinity), null);
  assert.equal(buildPlayCommand(has("pw-play"), wav, NaN), null);
  assert.equal(buildPlayCommand(has("pw-play"), wav, null), null, "null coerces to 0");
  assert.equal(buildPlayCommand(has("pw-play"), wav, ""), null, "empty string coerces to 0");
  assert.equal(buildPlayCommand(has("pw-play"), wav, "   "), null, "whitespace coerces to 0");
  assert.equal(buildPlayCommand(has("pw-play"), wav, []), null, "[] coerces to 0");
  assert.equal(buildPlayCommand(has("pw-play"), wav, {}), null, "{} coerces to NaN = silent");

  // Coercion surprises that DO play: booleans, arrays, numeric strings.
  assert.deepEqual(buildPlayCommand(has("pw-play"), wav, true), ["pw-play", "--volume=0.01", wav],
    "true coerces to 1%");
  assert.deepEqual(buildPlayCommand(has("pw-play"), wav, [50]), ["pw-play", "--volume=0.50", wav],
    "single-element array coerces to its element");
  assert.deepEqual(buildPlayCommand(has("pw-play"), wav, " 50 "), ["pw-play", "--volume=0.50", wav],
    "numeric string with spaces coerces");
  assert.equal(buildPlayCommand(has("pw-play"), wav, 100.9)[1], "--volume=1.00", "over-100 clamps");
  assert.equal(buildPlayCommand(has("pw-play"), wav, 99.996)[1], "--volume=1.00", "rounds up inside clamp");

  // Volume rendering per player.
  assert.deepEqual(buildPlayCommand(has("pw-play"), wav, 33.333), ["pw-play", "--volume=0.33", wav]);
  assert.deepEqual(buildPlayCommand(has("paplay"), wav, 25), ["paplay", "--volume=16384", wav]);
  assert.deepEqual(buildPlayCommand(has("paplay"), wav, 0.5), ["paplay", "--volume=328", wav]);
  assert.deepEqual(buildPlayCommand(has("ffplay"), wav, 60),
    ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", "-volume", "60", wav]);
  assert.equal(buildPlayCommand(has("ffplay"), wav, 33.3)[6], "33", "ffplay rounds to int percent");

  // Player priority when several exist.
  assert.equal(buildPlayCommand(has("paplay", "ffplay"), wav, 50)[0], "paplay", "paplay beats ffplay");
  assert.equal(buildPlayCommand(has("pw-play", "ffplay"), wav, 50)[0], "pw-play", "pw-play beats ffplay");
  assert.equal(buildPlayCommand(has("pw-play", "paplay", "ffplay"), wav, 50)[0], "pw-play",
    "pw-play is first choice");

  // The file argument is not validated by buildPlayCommand.
  assert.deepEqual(buildPlayCommand(has("pw-play"), "", 50), ["pw-play", "--volume=0.50", ""],
    "empty file string is passed through untouched");
  assert.deepEqual(buildPlayCommand(has("pw-play"), "a b.wav", 50)[2], "a b.wav",
    "spaces in the path pass through as one argv element");

  // BUG: a positive volume below ~0.5% builds a command whose rendered volume
  // is 0 (pw-play --volume=0.00, ffplay -volume 0) yet still spawns a player,
  // contradicting "volume 0 plays nothing". paplay is unaffected (262 > 0).
  // assert.equal(buildPlayCommand(has("pw-play"), wav, 0.4), null, "0.4% should be silent like 0%");
  // assert.equal(buildPlayCommand(has("ffplay"), wav, 0.4), null, "0.4% should be silent like 0%");

  // ---- playSound: file checks ----
  const calls = [];
  const spawn = fakeSpawn(calls);

  assert.equal(playSound(50, wav, has("pw-play"), spawn), true, "non-audio content still 'plays' (no format check)");
  assert.equal(calls.at(-1)[1].at(-1), wav, "the file path reaches the player verbatim");

  assert.equal(playSound(50, empty, has("pw-play"), spawn), true, "empty file exists: player is spawned and fails on its own");
  assert.equal(playSound(50, path.join(tmp, "missing.wav"), has("pw-play"), spawn), false, "missing file refuses");
  assert.equal(playSound(50, "", has("pw-play"), spawn), false, "empty path refuses");

  // BUG: fs.existsSync is true for directories, so a directory 'plays' — the
  // detached player is spawned on a path that can never be audio.
  // assert.equal(playSound(50, dirAsFile, has("pw-play"), spawn), false, "a directory is not a sound file");

  // ---- playSound: spawn wiring ----
  calls.length = 0;
  const events = [];
  const child = { on(ev, fn) { events.push([ev, typeof fn]); }, unref() { events.push(["unref"]); } };
  assert.equal(playSound(50, wav, has("paplay"), fakeSpawn(calls, child)), true);
  assert.deepEqual(calls[0], ["paplay", ["--volume=32768", wav], { detached: true, stdio: "ignore" }]);
  assert.deepEqual(events, [["error", "function"], ["unref"]], "error handler attached before unref");

  // A child-like object with no on/unref still works (optional chaining).
  assert.equal(playSound(50, wav, has("pw-play"), fakeSpawn([], {})), true);

  // A spawnFn that returns null crashes on child.on?.() — spawn() never does
  // this, but the module does not guard it.
  assert.throws(() => playSound(50, wav, has("pw-play"), () => null), TypeError);
  // A synchronous spawnFn throw propagates: "never throws" only covers the
  // async 'error' event the module swallows.
  assert.throws(() => playSound(50, wav, has("pw-play"), () => { throw new Error("boom"); }), /boom/);

  // No player anywhere: refuses before touching spawn.
  calls.length = 0;
  assert.equal(playSound(50, wav, has(), spawn), false);
  assert.equal(calls.length, 0);
  // Volume 0 refuses even with a file and a player.
  assert.equal(playSound(0, wav, has("pw-play"), spawn), false);
  assert.equal(calls.length, 0);

  // Default file argument is the bundled clip.
  assert.equal(playSound(50, undefined, has("pw-play"), spawn), true);
  assert.equal(calls.at(-1)[1].at(-1), DEFAULT_FILE);

  // ---- concurrency: no shared state, no dedupe, no rate limit ----
  calls.length = 0;
  const results = [playSound(50, wav, has("pw-play"), spawn), playSound(60, wav, has("pw-play"), spawn),
    playSound(70, wav, has("pw-play"), spawn)];
  assert.deepEqual(results, [true, true, true]);
  assert.equal(calls.length, 3, "three calls spawn three players — nothing is coalesced");
  assert.deepEqual(calls.map((c) => c[1][0]), ["--volume=0.50", "--volume=0.60", "--volume=0.70"],
    "volumes are computed per call, not shared");

  // Interleaved failing and succeeding calls stay independent.
  calls.length = 0;
  assert.equal(playSound(50, path.join(tmp, "missing.wav"), has("pw-play"), spawn), false);
  assert.equal(playSound(50, wav, has("pw-play"), spawn), true);
  assert.equal(calls.length, 1);

  // ---- default `has` (onPath): PATH dirs then /usr/bin fallback ----
  // Replicate the module's lookup to know what to expect on THIS machine.
  const findPlayer = () => {
    const dirs = (process.env.PATH || "").split(":").concat(["/usr/bin"]);
    for (const name of ["pw-play", "paplay", "ffplay"]) {
      if (dirs.some((d) => { try { fs.accessSync(path.join(d, name), fs.constants.X_OK); return true; } catch { return false; } })) {
        return name;
      }
    }
    return null;
  };
  calls.length = 0;
  const expected = findPlayer();
  if (expected) {
    assert.equal(playSound(50, wav, undefined, spawn), true, `default has() finds ${expected}`);
    assert.equal(calls.at(-1)[0], expected);
    // PATH="" still falls back to /usr/bin (and to cwd-relative names via "").
    process.env.PATH = "";
    calls.length = 0;
    assert.equal(playSound(50, wav, undefined, spawn), true, "empty PATH still finds /usr/bin players");
    assert.equal(calls.at(-1)[0], expected);
    // A PATH dir with a non-executable player name changes nothing: X_OK is required.
    const fakebin = path.join(tmp, "bin");
    fs.mkdirSync(fakebin);
    fs.writeFileSync(path.join(fakebin, "paplay"), "#!/bin/sh\n", { mode: 0o644 });
    process.env.PATH = fakebin;
    calls.length = 0;
    const stillExpected = findPlayer();
    assert.equal(playSound(50, wav, undefined, spawn), stillExpected !== null);
    if (stillExpected) assert.equal(calls.at(-1)[0], stillExpected, "non-executable PATH entry is skipped");
    // An executable earlier in PATH wins only within its priority tier: pw-play
    // in /usr/bin still beats a PATH paplay.
    fs.writeFileSync(path.join(fakebin, "pw-play"), "#!/bin/sh\n", { mode: 0o755 });
    calls.length = 0;
    process.env.PATH = fakebin;
    assert.equal(playSound(50, wav, undefined, spawn), true);
    assert.equal(calls.at(-1)[0], "pw-play", "first PATH hit for the top-priority name wins");
  }

  console.log("play-sound deep: all tests passed");
} finally {
  if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
  for (const k of ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
