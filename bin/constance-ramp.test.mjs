import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyLimit, roomForCopy, readMachine, PUBLISHED_MAX } from "./constance-ramp.mjs";

// The limit: Devin's published 10 by default, lowered (never raised) by the setting.
assert.equal(PUBLISHED_MAX.devin, 10);
assert.equal(copyLimit("devin"), 10);
assert.equal(copyLimit("devin", {}), 10);
assert.equal(copyLimit("devin", { constanceMaxCopies: 3 }), 3);
assert.equal(copyLimit("devin", { constanceMaxCopies: 1 }), 1);
assert.equal(copyLimit("devin", { constanceMaxCopies: 50 }), 10, "never above the published limit");
assert.equal(copyLimit("devin", { constanceMaxCopies: 0 }), 10, "nonsense falls back to the default");
assert.equal(copyLimit("devin", { constanceMaxCopies: "x" }), 10);
assert.equal(copyLimit("grok", { constanceMaxCopies: 5 }), 1, "other agents stay single-job");

const ramp = { loadPerCore: 0.8, minFreeBytes: 2 * 1024 ** 3, minFreeShare: 0.1, gapMs: 30000 };
const G = 1024 ** 3, now = 1e12;
const calm = { load1: 1, cpus: 8, memTotal: 32 * G, memAvailable: 20 * G };
assert.deepEqual(roomForCopy(calm, { running: 0, ramp, now }), { ok: true, reason: "" });
// Busy CPU holds, with the numbers in the reason.
let r = roomForCopy({ ...calm, load1: 7 }, { running: 2, lastStartAt: 0, ramp, now });
assert.equal(r.ok, false); assert.match(r.reason, /load 7\.0 on 8 cores \(starts under 6\.4\)/);
// Low memory holds: the larger of 2 GiB and 10% of total.
r = roomForCopy({ ...calm, memAvailable: 2.5 * G }, { running: 1, ramp, now });
assert.equal(r.ok, false); assert.match(r.reason, /low memory: 2\.5 GiB free \(starts at 3\.2 GiB\)/);
assert.equal(roomForCopy({ ...calm, memTotal: 8 * G, memAvailable: 2.1 * G }, { running: 0, ramp, now }).ok, true, "2 GiB floor on a small machine");
// Ramp: one copy per gap, even on a calm machine.
r = roomForCopy(calm, { running: 3, lastStartAt: now - 10000, ramp, now });
assert.equal(r.ok, false); assert.match(r.reason, /ramping up: one copy every 30 s/);
assert.equal(roomForCopy(calm, { running: 3, lastStartAt: now - 31000, ramp, now }).ok, true);
// Unreadable machine: the first copy runs, the rest wait.
assert.equal(roomForCopy(null, { running: 0, ramp, now }).ok, true);
assert.match(roomForCopy(null, { running: 1, ramp, now }).reason, /can't read/);

// Ramping to 10 on a calm machine: each start waits its gap, and it stops at the limit.
let started = [], t = now;
for (let step = 0; step < 40 && started.length < copyLimit("devin"); step++, t += 10000) {
  if (roomForCopy(calm, { running: started.length, lastStartAt: started.at(-1) || 0, ramp, now: t }).ok) started.push(t);
}
assert.equal(started.length, 10, "ten copies start");
for (let i = 1; i < started.length; i++) assert.ok(started[i] - started[i - 1] >= 30000, "never two starts within the gap");

// readMachine parses /proc-style files.
const proc = fs.mkdtempSync(path.join(os.tmpdir(), "ramp-proc-"));
fs.writeFileSync(path.join(proc, "loadavg"), "3.25 2.00 1.00 2/900 12345\n");
fs.writeFileSync(path.join(proc, "meminfo"), "MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    9000000 kB\n");
assert.deepEqual(readMachine(proc, 4), { load1: 3.25, cpus: 4, memTotal: 16000000 * 1024, memAvailable: 9000000 * 1024 });
fs.rmSync(path.join(proc, "meminfo"));
assert.equal(readMachine(proc, 4), null, "missing meminfo is unreadable");
fs.rmSync(proc, { recursive: true, force: true });
assert.ok(readMachine("/proc"), "the real /proc reads");
console.log("constance-ramp: ok");
