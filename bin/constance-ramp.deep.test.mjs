// Deep edge-case pass for bin/constance-ramp.mjs, on top of constance-ramp.test.mjs.
// Covers copyLimit's coercion corners, roomForCopy's memory threshold boundaries
// and malformed inputs, and readMachine's /proc parsing failure paths. All state
// lives in mktemp dirs; HOME is faked and clocks are injected via `now`.
//
// roomForCopy() guards the low-memory check: a malformed/partial machine
// object (missing or non-numeric memTotal/memAvailable) counts as unreadable,
// and a malformed ramp fails closed — a NaN need never reads as room.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyLimit, roomForCopy, readMachine, PUBLISHED_MAX, RAMP } from "./constance-ramp.mjs";

const G = 1024 ** 3;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ramp-deep-"));
const fakeHome = path.join(tmp, "home");
fs.mkdirSync(fakeHome);
const realHome = process.env.HOME;
process.env.HOME = fakeHome;
const NOW = 1_700_000_000_000;

// ---- copyLimit: coercion corners -------------------------------------------

assert.equal(copyLimit("devin"), PUBLISHED_MAX.devin, "default is the published max");
assert.equal(copyLimit("devin", undefined), 10);
assert.equal(copyLimit("devin", null), 10, "null settings fall back to default");
assert.equal(copyLimit("devin", {}), 10, "missing key falls back to default");
assert.equal(copyLimit("devin", { constanceMaxCopies: undefined }), 10);
assert.equal(copyLimit("devin", { constanceMaxCopies: null }), 10, "Number(null)=0 -> invalid -> default");
assert.equal(copyLimit("devin", { constanceMaxCopies: "" }), 10, "Number(\"\")=0 -> invalid -> default");
assert.equal(copyLimit("devin", { constanceMaxCopies: NaN }), 10);
assert.equal(copyLimit("devin", { constanceMaxCopies: Infinity }), 10, "Infinity is not finite -> default");
assert.equal(copyLimit("devin", { constanceMaxCopies: -Infinity }), 10);
assert.equal(copyLimit("devin", { constanceMaxCopies: -3 }), 10, "negative -> invalid -> default (never lowered below 1)");
assert.equal(copyLimit("devin", { constanceMaxCopies: 0 }), 10);
assert.equal(copyLimit("devin", { constanceMaxCopies: 0.9 }), 10, "floor(0.9)=0 -> invalid -> default");
assert.equal(copyLimit("devin", { constanceMaxCopies: 1 }), 1);
assert.equal(copyLimit("devin", { constanceMaxCopies: 1.9 }), 1, "floored, not rounded");
assert.equal(copyLimit("devin", { constanceMaxCopies: 2.9 }), 2);
assert.equal(copyLimit("devin", { constanceMaxCopies: 9.99 }), 9);
assert.equal(copyLimit("devin", { constanceMaxCopies: "3" }), 3, "numeric strings coerce");
assert.equal(copyLimit("devin", { constanceMaxCopies: " 4 " }), 4, "whitespace tolerated");
assert.equal(copyLimit("devin", { constanceMaxCopies: "2.9" }), 2, "string floors too");
assert.equal(copyLimit("devin", { constanceMaxCopies: "0x8" }), 8, "hex string coerces via Number()");
assert.equal(copyLimit("devin", { constanceMaxCopies: "1e1" }), 10, "exponent string coerces");
assert.equal(copyLimit("devin", { constanceMaxCopies: true }), 1, "Number(true)=1 -> limit 1");
assert.equal(copyLimit("devin", { constanceMaxCopies: false }), 10, "Number(false)=0 -> invalid -> default");
assert.equal(copyLimit("devin", { constanceMaxCopies: 1e308 }), 10, "huge finite -> clamped to published");
assert.equal(copyLimit("devin", { constanceMaxCopies: 11 }), 10, "above published -> clamped");
assert.equal(copyLimit("devin", { constanceMaxCopies: 10 }), 10, "exactly published allowed");
assert.equal(copyLimit("Devin", { constanceMaxCopies: 5 }), 1, "agent ids are case-sensitive");
assert.equal(copyLimit("", { constanceMaxCopies: 5 }), 1);
assert.equal(copyLimit(undefined, { constanceMaxCopies: 5 }), 1);
assert.equal(copyLimit(null, { constanceMaxCopies: 5 }), 1);
assert.equal(copyLimit(42, { constanceMaxCopies: 5 }), 1, "non-string id -> single job");
assert.equal(copyLimit("grok"), 1);
assert.equal(copyLimit("devin", 5), 10, "non-object settings -> default");
assert.equal(copyLimit("devin", "3"), 10, "string settings -> default");

// ---- roomForCopy: memory threshold boundaries ------------------------------

const ramp = { minFreeBytes: 2 * G, minFreeShare: 0.1 };
const calm = { load1: 0.5, cpus: 8, memTotal: 32 * G, memAvailable: 20 * G };

// need = max(2 GiB, 10% of total). 32 GiB total -> 3.2 GiB need.
assert.equal(roomForCopy(calm, { ramp, now: NOW }).ok, true);
// Exact boundary: memAvailable == memNeed is allowed (<, not <=).
assert.deepEqual(
  roomForCopy({ ...calm, memAvailable: 3.2 * G }, { ramp, now: NOW }),
  { ok: true, reason: "" },
  "memAvailable exactly at the need is allowed",
);
// One byte under the need fails.
let r = roomForCopy({ ...calm, memAvailable: 3.2 * G - 1 }, { ramp, now: NOW });
assert.equal(r.ok, false);
assert.match(r.reason, /low memory: 3\.2 GiB free \(starts at 3\.2 GiB\)/);

// Crossover: below 20 GiB total the 2 GiB floor dominates; at exactly 20 GiB
// both terms equal 2 GiB.
assert.equal(roomForCopy({ ...calm, memTotal: 19 * G, memAvailable: 2 * G }, { ramp, now: NOW }).ok, true,
  "2 GiB floor on a 19 GiB machine");
assert.equal(roomForCopy({ ...calm, memTotal: 20 * G, memAvailable: 2 * G }, { ramp, now: NOW }).ok, true,
  "share and floor coincide at 20 GiB");
assert.equal(roomForCopy({ ...calm, memTotal: 20 * G, memAvailable: 2 * G - 1 }, { ramp, now: NOW }).ok, false,
  "one byte under at the crossover fails");
assert.equal(roomForCopy({ ...calm, memTotal: 40 * G, memAvailable: 3.9 * G }, { ramp, now: NOW }).ok, false,
  "40 GiB machine needs 4 GiB free");
assert.equal(roomForCopy({ ...calm, memTotal: 40 * G, memAvailable: 4 * G }, { ramp, now: NOW }).ok, true);

// gib() rounds to 1 decimal in the reason string.
r = roomForCopy({ ...calm, memAvailable: 1.55 * G }, { ramp, now: NOW });
assert.equal(r.ok, false);
assert.match(r.reason, /low memory: 1\.6 GiB free/, "reason rounds GiB to one decimal");
r = roomForCopy({ ...calm, memAvailable: 0 }, { ramp, now: NOW });
assert.match(r.reason, /low memory: 0\.0 GiB free \(starts at 3\.2 GiB\)/);

// Tiny/zero/negative machine numbers.
assert.equal(roomForCopy({ memTotal: 0, memAvailable: 0 }, { ramp, now: NOW }).ok, false,
  "zeroed machine still needs 2 GiB");
assert.equal(roomForCopy({ memTotal: 0, memAvailable: 2 * G }, { ramp, now: NOW }).ok, true);
assert.equal(roomForCopy({ memTotal: 32 * G, memAvailable: -1 }, { ramp, now: NOW }).ok, false,
  "negative free memory fails");
assert.equal(roomForCopy({ memTotal: Infinity, memAvailable: 100 * G }, { ramp, now: NOW }).ok, false,
  "infinite total makes the need infinite");
assert.match(roomForCopy({ memTotal: Infinity, memAvailable: 100 * G }, { ramp, now: NOW }).reason,
  /starts at Infinity GiB/, "reason string leaks Infinity (cosmetic)");

// load1/cpus/running/lastStartAt/now never gate a copy when memory is fine.
for (const machine of [
  { ...calm, load1: Infinity },
  { ...calm, load1: NaN },
  { ...calm, load1: -5 },
  { ...calm, cpus: 0 },
  { ...calm, cpus: -1 },
]) {
  assert.equal(roomForCopy(machine, { running: 9, ramp, now: NOW }).ok, true,
    `load1=${machine.load1} cpus=${machine.cpus} ignored`);
}
assert.equal(roomForCopy(calm, { running: 999, lastStartAt: NOW - 1, now: NOW, ramp }).ok, true,
  "running count does not gate; copyLimit does that elsewhere");
assert.equal(roomForCopy(calm, { running: -3, ramp, now: NOW }).ok, true);
assert.equal(roomForCopy(calm, { running: 0.5, ramp, now: NOW }).ok, true);

// `now` and `lastStartAt` are accepted but ignored: same answer at any clock.
for (const now of [0, 1, NOW, NOW + 1e15, -NOW]) {
  assert.deepEqual(roomForCopy(calm, { running: 2, lastStartAt: now - 1, now, ramp }),
    { ok: true, reason: "" }, `now=${now} changes nothing`);
}

// Custom ramp overrides both terms independently.
assert.equal(roomForCopy({ memTotal: 32 * G, memAvailable: 1 * G },
  { ramp: { minFreeBytes: 512 * 1024 ** 2, minFreeShare: 0 }, now: NOW }).ok, true,
  "custom byte floor respected");
assert.equal(roomForCopy({ memTotal: 32 * G, memAvailable: 1 * G },
  { ramp: { minFreeBytes: 2 * G, minFreeShare: 0 }, now: NOW }).ok, false);
assert.equal(roomForCopy({ memTotal: 100 * G, memAvailable: 9 * G },
  { ramp: { minFreeBytes: 0, minFreeShare: 0.2 }, now: NOW }).ok, false,
  "custom share-only ramp");
assert.equal(roomForCopy({ memTotal: 100 * G, memAvailable: 20 * G },
  { ramp: { minFreeBytes: 0, minFreeShare: 0.2 }, now: NOW }).ok, true,
  "exactly at custom share is allowed");
assert.equal(roomForCopy({ memTotal: 32 * G, memAvailable: 0 },
  { ramp: { minFreeBytes: 0, minFreeShare: 0 }, now: NOW }).ok, true,
  "zero ramp allows even empty memory");

// Malformed ramp: need becomes NaN and the check must fail closed, not open.
assert.equal(roomForCopy(calm, { ramp: {}, now: NOW }).ok, false,
  "empty ramp -> NaN need -> held");
assert.equal(roomForCopy(calm, { ramp: { minFreeBytes: "x", minFreeShare: "y" }, now: NOW }).ok, false,
  "non-numeric ramp -> NaN need -> held");
assert.equal(roomForCopy(calm, { ramp: null, now: NOW }).ok, false,
  "null ramp -> NaN need -> held");
assert.equal(roomForCopy(calm, { ramp: undefined, now: NOW }).ok, true,
  "explicit undefined ramp falls back to RAMP default");

// Unreadable machine (null): first copy runs, rest held. `running` is compared
// with === 0, so only a literal numeric 0 counts as "no copies yet".
assert.deepEqual(roomForCopy(null, { running: 0, now: NOW }), { ok: true, reason: "" });
assert.deepEqual(roomForCopy(null, { running: -0, now: NOW }), { ok: true, reason: "" });
assert.equal(roomForCopy(null, { running: 1, now: NOW }).ok, false);
assert.equal(roomForCopy(null, { running: 10, now: NOW }).ok, false);
assert.equal(roomForCopy(null, { running: "0", now: NOW }).ok, false,
  "string \"0\" is not === 0 -> held (current behaviour)");
assert.equal(roomForCopy(null, { running: NaN, now: NOW }).ok, false);
assert.equal(roomForCopy(null, { running: 0.5, now: NOW }).ok, false);
assert.match(roomForCopy(null, { running: 1, now: NOW }).reason, /can't read the machine/);
assert.equal(roomForCopy(undefined, { running: 0, now: NOW }).ok, true,
  "undefined machine behaves like null");
assert.equal(roomForCopy(undefined, { running: 1, now: NOW }).ok, false);

// ---- readMachine: /proc parsing ----------------------------------------------

// Fake proc dir builder.
const mkproc = (files) => {
  const d = fs.mkdtempSync(path.join(tmp, "proc-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(d, name), content);
  }
  return d;
};
const GOOD_MEM = "MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    9000000 kB\n";

// Missing / unreadable paths -> null, never throw.
assert.equal(readMachine(path.join(tmp, "no-such-dir"), 4), null);
const notADir = path.join(tmp, "a-file");
fs.writeFileSync(notADir, "x");
assert.equal(readMachine(notADir, 4), null, "proc path that is a file -> null");

// Missing or malformed loadavg -> null (exception -> catch; NaN -> guard).
assert.equal(readMachine(mkproc({ meminfo: GOOD_MEM }), 4), null, "no loadavg -> null");
assert.equal(readMachine(mkproc({ loadavg: "", meminfo: GOOD_MEM }), 4)?.load1, 0,
  "empty loadavg parses as 0 (Number(\"\")=0), machine still readable");
assert.equal(readMachine(mkproc({ loadavg: "abc 1.0 1.0\n", meminfo: GOOD_MEM }), 4), null,
  "non-numeric load1 -> null");
assert.equal(readMachine(mkproc({ loadavg: "   \n", meminfo: GOOD_MEM }), 4)?.load1, 0);
assert.equal(readMachine(mkproc({ loadavg: "1.5 2.0 3.0\n", meminfo: GOOD_MEM }), 4)?.load1, 1.5);
assert.equal(readMachine(mkproc({ loadavg: "-2.5 0 0\n", meminfo: GOOD_MEM }), 4)?.load1, -2.5,
  "negative load1 is finite -> accepted");
assert.equal(readMachine(mkproc({ loadavg: "1e3 0 0\n", meminfo: GOOD_MEM }), 4)?.load1, 1000,
  "exponent load1 accepted");

// Missing meminfo keys -> null (NaN guard).
assert.equal(readMachine(mkproc({ loadavg: "1 0 0\n", meminfo: "MemFree: 1 kB\n" }), 4), null,
  "no MemTotal -> null");
assert.equal(readMachine(mkproc({ loadavg: "1 0 0\n", meminfo: "MemTotal: 16000000 kB\n" }), 4), null,
  "no MemAvailable -> null");
assert.equal(readMachine(mkproc({ loadavg: "1 0 0\n", meminfo: "" }), 4), null);
assert.equal(readMachine(mkproc({ loadavg: "1 0 0\n" }), 4), null, "no meminfo file -> null");

// Key matching is anchored, case-sensitive, first-match.
assert.equal(readMachine(mkproc({
  loadavg: "1 0 0\n",
  meminfo: " MemTotal: 16000000 kB\nMemAvailable: 9000000 kB\n",
}), 4), null, "indented keys do not match ^ anchor");
assert.equal(readMachine(mkproc({
  loadavg: "1 0 0\n",
  meminfo: "memtotal: 16000000 kB\nMemAvailable: 9000000 kB\n",
}), 4), null, "lowercase key does not match");
assert.equal(readMachine(mkproc({
  loadavg: "1 0 0\n",
  meminfo: "MemTotalx: 16000000 kB\nMemAvailable: 9000000 kB\n",
}), 4), null, "MemTotalx is not MemTotal");
assert.equal(readMachine(mkproc({
  loadavg: "1 0 0\n",
  meminfo: "MemTotal: 100 kB\nMemTotal: 200 kB\nMemAvailable: 50 kB\n",
}), 4)?.memTotal, 100 * 1024, "duplicate key: first match wins");
assert.equal(readMachine(mkproc({
  loadavg: "1 0 0\n",
  meminfo: "MemAvailable: 9000000 kB\nMemTotal: 16000000 kB\n",
}), 4)?.memTotal, 16000000 * 1024, "key order in file does not matter");
assert.equal(readMachine(mkproc({
  loadavg: "1 0 0\n",
  meminfo: "SwapTotal:       4000000 kB\nMemTotal: 16000000 kB\nMemAvailable: 9000000 kB\n",
}), 4)?.memTotal, 16000000 * 1024, "SwapTotal does not shadow MemTotal");

// Value parsing: digits only, kB suffix optional, trailing text ok.
const parsed = readMachine(mkproc({
  loadavg: "2.5 1 1\n",
  meminfo: "MemTotal: 16000000\nMemAvailable: 9000000 kB trailing junk\n",
}), 7);
assert.deepEqual(parsed, { load1: 2.5, cpus: 7, memTotal: 16000000 * 1024, memAvailable: 9000000 * 1024 });
assert.equal(readMachine(mkproc({
  loadavg: "1 0 0\n",
  meminfo: "MemTotal: 16000000 kB\nMemAvailable: -5 kB\n",
}), 4), null, "negative MemAvailable does not match \\d+ -> null");
assert.equal(readMachine(mkproc({
  loadavg: "1 0 0\n",
  meminfo: "MemTotal: 0 kB\nMemAvailable: 0 kB\n",
}), 4)?.memTotal, 0, "zero kB is finite -> readable machine with 0 bytes");
assert.equal(readMachine(mkproc({
  loadavg: "1 0 0\n",
  meminfo: "MemTotal:       999999999999 kB\nMemAvailable:    888888888888 kB\n",
}), 4)?.memTotal, 999999999999 * 1024, "huge kB values parse");
assert.equal(readMachine(mkproc({
  loadavg: "1 0 0\r\n",
  meminfo: "MemTotal: 16000000 kB\r\nMemAvailable: 9000000 kB\r\n",
}), 4)?.memAvailable, 9000000 * 1024, "CRLF tolerated");

// cpus is stored verbatim, whatever the caller passes.
assert.equal(readMachine(mkproc({ loadavg: "1 0 0\n", meminfo: GOOD_MEM }), 0)?.cpus, 0);
assert.equal(readMachine(mkproc({ loadavg: "1 0 0\n", meminfo: GOOD_MEM }), -3)?.cpus, -3);
assert.equal(readMachine(mkproc({ loadavg: "1 0 0\n", meminfo: GOOD_MEM }), NaN)?.cpus, NaN);
assert.equal(readMachine(mkproc({ loadavg: "1 0 0\n", meminfo: GOOD_MEM }))?.cpus >= 1, true,
  "default cpus comes from os.availableParallelism/cpus()");

// CONSTANCE_PROC env var is honored when no proc arg is given.
const envProc = mkproc({ loadavg: "9.9 0 0\n", meminfo: "MemTotal: 1000 kB\nMemAvailable: 500 kB\n" });
process.env.CONSTANCE_PROC = envProc;
assert.deepEqual(readMachine(undefined, 2), { load1: 9.9, cpus: 2, memTotal: 1000 * 1024, memAvailable: 500 * 1024 });
delete process.env.CONSTANCE_PROC;

// readMachine output feeds roomForCopy end-to-end on a tiny fake machine.
const tiny = readMachine(mkproc({
  loadavg: "0.1 0.1 0.1\n",
  meminfo: "MemTotal: 8000000 kB\nMemAvailable: 1000000 kB\n",
}), 4);
assert.ok(tiny, "fake proc parses");
assert.equal(roomForCopy(tiny, { ramp, now: NOW }).ok, false,
  "8 GiB machine with ~1 GiB free is held");

// RAMP defaults match the documented floor/share.
assert.deepEqual(RAMP, { minFreeBytes: 2 * G, minFreeShare: 0.1 });
assert.equal(roomForCopy(calm, { now: NOW }).ok, true, "default ramp param works");

// ---- Malformed inputs fail closed -------------------------------------------
// roomForCopy() treats any machine object with missing/non-numeric memory
// fields as unreadable (first copy allowed, the rest held), and any ramp that
// makes the need NaN holds every copy. In practice readMachine() returns null
// rather than a partial object, but roomForCopy's contract accepts any object
// and callers/tests can hand it one.
assert.equal(roomForCopy({}, { running: 5, ramp, now: NOW }).ok, false,
  "empty machine object should not count as room");
assert.equal(roomForCopy({ memTotal: 32 * G }, { running: 5, ramp, now: NOW }).ok, false,
  "missing memAvailable should not count as room");
assert.equal(roomForCopy({ memTotal: "lots", memAvailable: "lots" }, { running: 5, ramp, now: NOW }).ok, false,
  "non-numeric machine fields should not count as room");
assert.equal(roomForCopy(calm, { ramp: { minFreeBytes: "x", minFreeShare: "y" }, now: NOW }).ok, false,
  "malformed ramp should fail closed, not open");
// A malformed machine object follows the same unreadable-machine rule as null:
// the first copy may run, the rest are held.
assert.equal(roomForCopy({}, { running: 0, ramp, now: NOW }).ok, true,
  "malformed machine still allows the first copy, like null");
assert.match(roomForCopy({}, { running: 1, ramp, now: NOW }).reason, /can't read the machine/);

// ---- Deep pass 2: option coercion, non-finite values, /proc quirks ---------

// copyLimit: exotic constanceMaxCopies values and the kilo agent.
assert.equal(copyLimit("kilo"), 2, "kilo's published max is 2");
assert.equal(copyLimit("kilo", { constanceMaxCopies: 5 }), 2, "kilo clamps to 2");
assert.equal(copyLimit("kilo", { constanceMaxCopies: 1 }), 1);
assert.equal(copyLimit("kilo", { constanceMaxCopies: 2 }), 2);
assert.equal(copyLimit("devin", []), 10, "array settings have no key -> default");
assert.equal(copyLimit("devin", { constanceMaxCopies: [5] }), 5, "single-element array coerces to 5");
assert.equal(copyLimit("devin", { constanceMaxCopies: [] }), 10, "empty array -> Number([])=0 -> default");
assert.equal(copyLimit("devin", { constanceMaxCopies: {} }), 10, "plain object -> NaN -> default");
assert.equal(copyLimit("devin", { constanceMaxCopies: 5n }), 5, "BigInt coerces via Number()");
assert.equal(copyLimit("devin", { constanceMaxCopies: "0b101" }), 5, "binary string coerces");
assert.equal(copyLimit("devin", { constanceMaxCopies: "Infinity" }), 10, "Infinity string -> not finite -> default");
assert.equal(copyLimit("devin", { constanceMaxCopies: "NaN" }), 10);
assert.equal(copyLimit("devin", { constanceMaxCopies: "   " }), 10, "whitespace-only -> 0 -> default");
assert.equal(copyLimit("devin", { constanceMaxCopies: -0.5 }), 10, "floor(-0.5) = -1 -> invalid -> default");
assert.equal(copyLimit("devin", { constanceMaxCopies: new Number(4) }), 4, "boxed number coerces");
assert.equal(copyLimit("devin", { constanceMaxCopies: new String("4") }), 4);
// A throwing getter propagates (settings are expected to be plain JSON).
assert.throws(() => copyLimit("devin", { get constanceMaxCopies() { throw new Error("boom"); } }),
  /boom/, "a throwing settings getter propagates");
// BUG: copyLimit("devin", { constanceMaxCopies: Symbol() }) throws
// TypeError ("Cannot convert a Symbol value to a number") instead of falling
// back to the default. Unreachable from JSON-parsed settings.json, so it is
// a robustness gap rather than a live failure.
// assert.equal(copyLimit("devin", { constanceMaxCopies: Symbol() }), 10);

// roomForCopy: the options argument itself.
assert.deepEqual(roomForCopy(), { ok: true, reason: "" },
  "no args at all: undefined machine + running 0 -> first copy allowed");
assert.deepEqual(roomForCopy(calm), { ok: true, reason: "" }, "options omitted -> defaults");
// BUG: roomForCopy(calm, null) throws TypeError ("Cannot read properties of
// null (reading 'running')") — the destructuring default only covers
// undefined, so a null options bag crashes instead of using defaults.
// assert.deepEqual(roomForCopy(calm, null), { ok: true, reason: "" });
// Other non-object options coerce to {} and hit the defaults.
for (const opts of ["x", 5, true]) {
  assert.deepEqual(roomForCopy(calm, opts), { ok: true, reason: "" },
    `options=${JSON.stringify(opts)} destructures to defaults`);
}

// roomForCopy: machine field edge values.
assert.equal(roomForCopy({ ...calm, memAvailable: Infinity }, { ramp, now: NOW }).ok, true,
  "infinite free memory is always room");
assert.equal(roomForCopy({ ...calm, memAvailable: -Infinity }, { ramp, now: NOW }).ok, false,
  "-Infinity free memory is held");
assert.match(roomForCopy({ ...calm, memAvailable: -Infinity }, { ramp, now: NOW }).reason,
  /low memory: -Infinity GiB free/);
// A negative/absurd memTotal makes the share term negative, so the 2 GiB
// floor alone decides — an Infinity-negative total is not "unreadable".
assert.equal(roomForCopy({ memTotal: -Infinity, memAvailable: 100 * G }, { ramp, now: NOW }).ok, true,
  "-Infinity total -> share term -Inf -> floor still applies");
assert.equal(roomForCopy({ memTotal: -5, memAvailable: 3 * G }, { ramp, now: NOW }).ok, true,
  "negative total -> need is just the 2 GiB floor");
assert.equal(roomForCopy({ memTotal: -5, memAvailable: G }, { ramp, now: NOW }).ok, false);
// Numeric-looking strings are NOT numbers: numeric() requires typeof number,
// so they take the unreadable path (first copy ok, rest held) rather than
// being parsed or failing as low memory.
const stringMachine = { memTotal: "34359738368", memAvailable: "21474836480" };
assert.equal(roomForCopy(stringMachine, { running: 0, ramp, now: NOW }).ok, true,
  "string memory fields count as unreadable -> first copy allowed");
assert.equal(roomForCopy(stringMachine, { running: 1, ramp, now: NOW }).ok, false);
assert.match(roomForCopy(stringMachine, { running: 1, ramp, now: NOW }).reason, /can't read the machine/);
assert.equal(roomForCopy({ memTotal: NaN, memAvailable: 100 * G }, { running: 1, ramp, now: NOW }).ok, false,
  "NaN memTotal -> unreadable -> held");
assert.equal(roomForCopy({ memTotal: 32 * G, memAvailable: NaN }, { running: 1, ramp, now: NOW }).ok, false,
  "NaN memAvailable -> unreadable -> held");
// Non-object machines are all "unreadable".
for (const machine of [42, "x", true, [], [1], new Number(5)]) {
  assert.equal(roomForCopy(machine, { running: 0, ramp, now: NOW }).ok, true,
    `machine=${Object.prototype.toString.call(machine)} -> first copy allowed`);
  assert.equal(roomForCopy(machine, { running: 1, ramp, now: NOW }).ok, false,
    `machine=${Object.prototype.toString.call(machine)} -> rest held`);
}
// `running` is ignored entirely once the machine is readable — even nonsense.
for (const running of [Infinity, "x", {}, NaN, -Infinity]) {
  assert.equal(roomForCopy(calm, { running, ramp, now: NOW }).ok, true,
    `running=${String(running)} ignored on a readable machine`);
}

// roomForCopy: ramp shapes beyond objects/null/undefined.
for (const badRamp of [5, "x", true, NaN, { minFreeBytes: NaN }, { minFreeShare: NaN }]) {
  const res = roomForCopy(calm, { ramp: badRamp, now: NOW });
  assert.equal(res.ok, false, `ramp=${JSON.stringify(badRamp) ?? String(badRamp)} fails closed`);
  assert.match(res.reason, /can't read the memory floor/);
}
assert.equal(roomForCopy(calm, { ramp: { minFreeBytes: Infinity, minFreeShare: 0.1 }, now: NOW }).ok, false,
  "infinite byte floor -> need Infinity -> held");
assert.match(roomForCopy(calm, { ramp: { minFreeBytes: Infinity, minFreeShare: 0.1 }, now: NOW }).reason,
  /starts at Infinity GiB/);
assert.equal(roomForCopy(calm, { ramp: { minFreeBytes: 0, minFreeShare: Infinity }, now: NOW }).ok, false,
  "infinite share -> need Infinity -> held");
// Numeric strings inside ramp coerce through Math.max / multiplication.
assert.equal(roomForCopy({ ...calm, memAvailable: 3.5 * G },
  { ramp: { minFreeBytes: "2147483648", minFreeShare: "0.1" }, now: NOW }).ok, true,
  "string ramp values coerce like numbers");
// A negative ramp makes the need negative, so even zero free memory reads as
// room — fail-open. RAMP itself is a fixed positive constant; this only
// matters for a caller-supplied ramp.
assert.equal(roomForCopy({ memTotal: 32 * G, memAvailable: 0 },
  { ramp: { minFreeBytes: -1, minFreeShare: -1 }, now: NOW }).ok, true,
  "negative ramp -> negative need -> everything has room (documented)");
assert.equal(roomForCopy({ memTotal: 32 * G, memAvailable: -0.5 },
  { ramp: { minFreeBytes: -1, minFreeShare: -1 }, now: NOW }).ok, true,
  "negative ramp even allows slightly negative free memory (-0.5 > need -1)");
// Mixed-sign ramp: byte term positive, share term negative.
assert.equal(roomForCopy({ memTotal: 32 * G, memAvailable: 2 * G },
  { ramp: { minFreeBytes: 2 * G, minFreeShare: -1 }, now: NOW }).ok, true,
  "byte floor still applies when share is negative");
assert.equal(roomForCopy({ memTotal: 32 * G, memAvailable: 2 * G - 1 },
  { ramp: { minFreeBytes: 2 * G, minFreeShare: -1 }, now: NOW }).ok, false);

// ---- readMachine: more /proc parsing corners --------------------------------

// Whitespace and format quirks in meminfo.
assert.equal(readMachine(mkproc({
  loadavg: "1 0 0\n",
  meminfo: "MemTotal:16000000 kB\nMemAvailable:9000000 kB\n",
}), 4), null, "no whitespace after the colon -> key does not match");
assert.equal(readMachine(mkproc({
  loadavg: "1 0 0\n",
  meminfo: "MemTotal:\t16000000 kB\nMemAvailable:\t9000000 kB\n",
}), 4)?.memTotal, 16000000 * 1024, "tab after the colon matches \\s+");
assert.equal(readMachine(mkproc({
  loadavg: "1 0 0\n",
  meminfo: "MemTotal: 1,600 kB\nMemAvailable: 9000000 kB\n",
}), 4)?.memTotal, 1024,
  "comma-grouped digits capture only the leading run (1 kB -> 1024 B)");
assert.equal(readMachine(mkproc({
  loadavg: "1 0 0\n",
  meminfo: "MemTotal: 16000000 kB\rMemAvailable: 9000000 kB\r",
}), 4)?.memAvailable, 9000000 * 1024,
  "CR-only line endings still match ^ (JS treats \\r as a line break)");
assert.equal(readMachine(mkproc({
  loadavg: "1 0 0",
  meminfo: "MemTotal: 16000000 kB\nMemAvailable: 9000000 kB",
}), 4)?.memAvailable, 9000000 * 1024, "no trailing newline at EOF");
assert.equal(readMachine(mkproc({
  loadavg: "1 0 0\n",
  meminfo: "MemTotal: abc kB\nMemTotal: 16000000 kB\nMemAvailable: 9000000 kB\n",
}), 4)?.memTotal, 16000000 * 1024,
  "a non-numeric first MemTotal line is skipped, the numeric one wins");
assert.equal(readMachine(mkproc({
  loadavg: "1 0 0\n",
  meminfo: "MemTotal: 99999999999999999999 kB\nMemAvailable: 1 kB\n",
}), 4)?.memTotal, 1.024e23, "digits beyond MAX_SAFE_INTEGER still parse as a float");

// loadavg quirks.
assert.equal(readMachine(mkproc({ loadavg: "Infinity 0 0\n", meminfo: GOOD_MEM }), 4), null,
  "Infinity load1 is not finite -> null");
assert.equal(readMachine(mkproc({ loadavg: "0x10 0 0\n", meminfo: GOOD_MEM }), 4)?.load1, 16,
  "hex load1 coerces via Number()");
assert.equal(readMachine(mkproc({ loadavg: "7", meminfo: GOOD_MEM }), 4)?.load1, 7,
  "single-field loadavg parses");
assert.equal(readMachine(mkproc({ loadavg: "   1.5 2 3\n", meminfo: GOOD_MEM }), 4)?.load1, 1.5,
  "leading whitespace trimmed");

// proc argument that is not a usable path -> null via the catch, never throws.
assert.equal(readMachine(null, 4), null, "null proc -> path.join throws -> caught -> null");
assert.equal(readMachine(123, 4), null);
assert.equal(readMachine({}, 4), null);
assert.equal(readMachine("", 4), null, "empty proc -> relative 'loadavg' not found here -> null");
// Files where directories are expected fail the same way.
const dirAsLoadavg = mkproc({ meminfo: GOOD_MEM });
fs.mkdirSync(path.join(dirAsLoadavg, "loadavg"));
assert.equal(readMachine(dirAsLoadavg, 4), null, "loadavg as a directory -> null");
const dirAsMeminfo = mkproc({ loadavg: "1 0 0\n" });
fs.mkdirSync(path.join(dirAsMeminfo, "meminfo"));
assert.equal(readMachine(dirAsMeminfo, 4), null, "meminfo as a directory -> null");
// An empty CONSTANCE_PROC is falsy and falls back to the real /proc.
process.env.CONSTANCE_PROC = "";
assert.ok(readMachine(undefined, 4), "empty CONSTANCE_PROC falls back to /proc");
delete process.env.CONSTANCE_PROC;

// ---- Purity: no shared state, fresh objects, no mutation --------------------
// The module holds no mutable state: repeated and interleaved calls on
// different proc dirs must not cross-contaminate, and mutating a returned
// object must not affect the next call.
const procA = mkproc({ loadavg: "1.0 0 0\n", meminfo: "MemTotal: 1000 kB\nMemAvailable: 500 kB\n" });
const procB = mkproc({ loadavg: "9.9 0 0\n", meminfo: "MemTotal: 2000 kB\nMemAvailable: 100 kB\n" });
const [ra, rb] = await Promise.all([readMachine(procA, 2), readMachine(procB, 3)]);
assert.equal(ra.memTotal, 1000 * 1024, "concurrent call A keeps its own values");
assert.equal(rb.memTotal, 2000 * 1024, "concurrent call B keeps its own values");
assert.equal(ra.load1, 1.0);
assert.equal(rb.load1, 9.9);
const againA = readMachine(procA, 2);
assert.equal(againA.memTotal, 1000 * 1024, "sequential re-read unaffected");
// Mutating a returned machine object cannot corrupt later reads.
ra.memTotal = -1;
ra.memAvailable = -1;
assert.equal(readMachine(procA, 2).memTotal, 1000 * 1024, "returned objects are fresh each call");
// roomForCopy must not mutate its machine or ramp arguments.
const frozenMachine = { ...calm };
const frozenRamp = { minFreeBytes: 2 * G, minFreeShare: 0.1 };
const machineBefore = JSON.stringify(frozenMachine);
const rampBefore = JSON.stringify(frozenRamp);
roomForCopy(frozenMachine, { running: 3, ramp: frozenRamp, now: NOW });
roomForCopy({ memTotal: 8 * G, memAvailable: G }, { ramp: frozenRamp, now: NOW });
assert.equal(JSON.stringify(frozenMachine), machineBefore, "machine argument unmutated");
assert.equal(JSON.stringify(frozenRamp), rampBefore, "ramp argument unmutated");
// Determinism: same inputs, same answer, every time.
for (let i = 0; i < 100; i++) {
  assert.deepEqual(roomForCopy(calm, { running: i % 7, ramp, now: NOW + i }),
    { ok: true, reason: "" }, `iteration ${i} deterministic`);
}

process.env.HOME = realHome;
fs.rmSync(tmp, { recursive: true, force: true });
console.log("constance-ramp.deep: ok");
