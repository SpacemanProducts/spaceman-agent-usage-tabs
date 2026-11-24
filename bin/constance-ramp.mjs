// How many copies of one agent Constance may run, and whether the machine has
// room to start one more right now. Copies ramp up one at a time: a new copy
// starts only when the load average and free memory allow it, and not sooner
// than RAMP.gapMs after the previous copy started (so the load reading can catch
// up). A copy that can't start yet is held, and starts by itself later.
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

// Room for one more copy: the 1-minute load per core under loadPerCore, and at
// least minFreeBytes and minFreeShare of memory available.
// CONSTANCE_RAMP_GAP_MS overrides the gap (tests only).
export const RAMP = {
  loadPerCore: 0.8,
  minFreeBytes: 2 * 1024 ** 3,
  minFreeShare: 0.1,
  gapMs: Number.isFinite(Number(process.env.CONSTANCE_RAMP_GAP_MS)) && process.env.CONSTANCE_RAMP_GAP_MS !== "" ? Number(process.env.CONSTANCE_RAMP_GAP_MS) : 30e3,
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

// { ok, reason }. `running` = copies of this agent already started; `lastStartAt`
// = when the newest one started. The first copy only needs readable, healthy
// numbers; an unreadable machine allows the first copy and holds the rest.
export function roomForCopy(machine, { running = 0, lastStartAt = 0, now = Date.now(), ramp = RAMP } = {}) {
  if (!machine) return running === 0 ? { ok: true, reason: "" } : { ok: false, reason: "can't read the machine's load and memory, so only one copy runs" };
  const loadCap = ramp.loadPerCore * machine.cpus;
  if (machine.load1 >= loadCap) return { ok: false, reason: `machine busy: load ${machine.load1.toFixed(1)} on ${machine.cpus} cores (starts under ${loadCap.toFixed(1)})` };
  const memNeed = Math.max(ramp.minFreeBytes, ramp.minFreeShare * machine.memTotal);
  if (machine.memAvailable < memNeed) return { ok: false, reason: `low memory: ${gib(machine.memAvailable)} GiB free (starts at ${gib(memNeed)} GiB)` };
  if (running > 0 && now - lastStartAt < ramp.gapMs) return { ok: false, reason: `ramping up: one copy every ${Math.round(ramp.gapMs / 1000)} s` };
  return { ok: true, reason: "" };
}
