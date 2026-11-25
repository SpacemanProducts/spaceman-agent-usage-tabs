// How many copies of one agent Constance may run, and whether the machine has
// room to start one more right now. Copies start as fast as work is ready:
// the ONLY thing that may hold a new copy is low free memory. A copy that
// can't start yet is held, and starts by itself later.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Devin's published concurrent session limit. Agents not listed stay single-job.
export const PUBLISHED_MAX = { devin: 10 };

// The owner can lower it (settings.json `constanceMaxCopies`, 1..the published max).
export function copyLimit(id, settings = {}) {
  const top = PUBLISHED_MAX[id];
  if (!top) return 1;
  const want = Math.floor(Number(settings?.constanceMaxCopies));
  return Number.isFinite(want) && want >= 1 ? Math.min(top, want) : top;
}

// Room for one more copy: at least minFreeBytes and minFreeShare of memory
// available. Load and time since the last copy no longer matter.
export const RAMP = {
  minFreeBytes: 2 * 1024 ** 3,
  minFreeShare: 0.1,
};

// Reads /proc (or CONSTANCE_PROC, a fake one in tests). null when unreadable.
export function readMachine(proc = process.env.CONSTANCE_PROC || "/proc", cpus = os.availableParallelism?.() || os.cpus().length || 1) {
  try {
    const load1 = Number(fs.readFileSync(path.join(proc, "loadavg"), "utf8").trim().split(/\s+/)[0]);
    const mem = fs.readFileSync(path.join(proc, "meminfo"), "utf8");
    const kb = (k) => { const m = mem.match(new RegExp(`^${k}:\\s+(\\d+)`, "m")); return m ? Number(m[1]) * 1024 : NaN; };
    const memTotal = kb("MemTotal"), memAvailable = kb("MemAvailable");
    if (![load1, memTotal, memAvailable].every(Number.isFinite)) return null;
    return { load1, cpus, memTotal, memAvailable };
  } catch { return null; }
}

const gib = (b) => (b / 1024 ** 3).toFixed(1);
const numeric = (v) => typeof v === "number" && !Number.isNaN(v);

// { ok, reason }. `running` = copies of this agent already started; `lastStartAt`
// is accepted for callers' convenience but ignored. The first copy only needs
// readable, healthy numbers; an unreadable machine allows the first copy and
// holds the rest. A malformed machine object counts as unreadable, and a
// malformed ramp fails closed (no copy) — a NaN need must never read as room.
export function roomForCopy(machine, { running = 0, lastStartAt = 0, now = Date.now(), ramp = RAMP } = {}) {
  const unreadable = running === 0
    ? { ok: true, reason: "" }
    : { ok: false, reason: "can't read the machine's load and memory, so only one copy runs" };
  if (!machine || !numeric(machine.memTotal) || !numeric(machine.memAvailable)) return unreadable;
  const memNeed = Math.max(ramp?.minFreeBytes, ramp?.minFreeShare * machine.memTotal);
  if (!numeric(memNeed)) return { ok: false, reason: "can't read the memory floor, so no copy starts" };
  if (machine.memAvailable < memNeed) return { ok: false, reason: `low memory: ${gib(machine.memAvailable)} GiB free (starts at ${gib(memNeed)} GiB)` };
  return { ok: true, reason: "" };
}
