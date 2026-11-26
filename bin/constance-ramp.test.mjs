import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyLimit, copiesFor, roomForCopy, readMachine, PUBLISHED_MAX, CAPS } from "./constance-ramp.mjs";

// The capability table: per-agent published copy counts.
assert.deepEqual(CAPS, { devin: { copies: 10 }, kilo: { copies: 2 } });

// copiesFor: listed agents get their count; anything else gets 1.
assert.equal(copiesFor("devin"), 10);
assert.equal(copiesFor("kilo"), 2);
assert.equal(copiesFor("grok"), 1, "unlisted agent is single-copy");
assert.equal(copiesFor(null), 1, "null agent");
assert.equal(copiesFor(undefined), 1, "undefined agent");
assert.equal(copiesFor({}), 1, "object agent");
assert.equal(copiesFor(42), 1, "numeric agent");

// PUBLISHED_MAX stays derived from CAPS with the same keys and values.
assert.deepEqual(PUBLISHED_MAX, { devin: 10, kilo: 2 });
assert.deepEqual(Object.keys(PUBLISHED_MAX).sort(), Object.keys(CAPS).sort());
for (const [id, cap] of Object.entries(CAPS)) assert.equal(PUBLISHED_MAX[id], copiesFor(id));

// The limit: a listed agent's published count by default, lowered (never raised) by the setting.
assert.equal(PUBLISHED_MAX.devin, 10);
assert.equal(copyLimit("devin"), 10);
assert.equal(copyLimit("devin", {}), 10);
assert.equal(copyLimit("devin", { constanceMaxCopies: 3 }), 3);
assert.equal(copyLimit("devin", { constanceMaxCopies: 1 }), 1);
assert.equal(copyLimit("devin", { constanceMaxCopies: 50 }), 10, "never above the published limit");
assert.equal(copyLimit("devin", { constanceMaxCopies: 0 }), 10, "nonsense falls back to the default");
assert.equal(copyLimit("devin", { constanceMaxCopies: "x" }), 10);
assert.equal(copyLimit("grok", { constanceMaxCopies: 5 }), 1, "other agents stay single-job");

const ramp = { minFreeBytes: 2 * 1024 ** 3, minFreeShare: 0.1 };
const G = 1024 ** 3, now = 1e12;
const calm = { load1: 1, cpus: 8, memTotal: 32 * G, memAvailable: 20 * G };
assert.deepEqual(roomForCopy(calm, { running: 0, ramp, now }), { ok: true, reason: "" });
// A busy load no longer holds a copy: only low memory can.
let r = roomForCopy({ ...calm, load1: 99 }, { running: 2, lastStartAt: 0, ramp, now });
assert.deepEqual(r, { ok: true, reason: "" }, "busy load still allows a copy");
// Two copies 1 ms apart are both allowed.
assert.equal(roomForCopy(calm, { running: 3, lastStartAt: now - 1, ramp, now }).ok, true, "no time gap between copies");
// Low memory holds: the larger of 2 GiB and 10% of total.
r = roomForCopy({ ...calm, memAvailable: 2.5 * G }, { running: 1, ramp, now });
assert.equal(r.ok, false); assert.match(r.reason, /low memory: 2\.5 GiB free \(starts at 3\.2 GiB\)/);
assert.equal(roomForCopy({ ...calm, memTotal: 8 * G, memAvailable: 2.1 * G }, { running: 0, ramp, now }).ok, true, "2 GiB floor on a small machine");
// Unreadable machine: the first copy runs, the rest wait.
assert.equal(roomForCopy(null, { running: 0, ramp, now }).ok, true);
assert.match(roomForCopy(null, { running: 1, ramp, now }).reason, /can't read/);

// Ramping to 10 on a calm machine: all start at once, and it stops at the limit.
let started = [];
for (let step = 0; step < 40 && started.length < copyLimit("devin"); step++) {
  if (roomForCopy(calm, { running: started.length, lastStartAt: started.at(-1) || 0, ramp, now }).ok) started.push(now + step);
}
assert.equal(started.length, 10, "ten copies start");

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
