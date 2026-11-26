// How many copies of one agent Constance may run, and whether the machine has
// room to start one more right now: enough free memory (read fresh before each
// start) and a few seconds since the previous start. A copy that can't start
// yet is held, and starts by itself later.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Per-agent capabilities, keyed by agent id. `copies` is the published number
// of concurrent copies Constance may run for that agent (each gets its own
// worktree). An agent with no entry gets one job and no worktree copies.
export const CAPS = {
  devin: { copies: 10 },
  kilo: { copies: 2 },
};

// The published copy count for an agent: its CAPS entry, or 1 when the agent
// is unlisted or the entry is malformed.
export function copiesFor(agent) {
  const n = CAPS[agent]?.copies;
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

// Derived from CAPS so existing importers keep working: { agent: copies }.
export const PUBLISHED_MAX = Object.fromEntries(
  Object.entries(CAPS).map(([id, cap]) => [id, cap.copies ?? 1]),
);

// The owner can lower it (settings.json `constanceMaxCopies`, 1..the published max).
export function copyLimit(id, settings = {}) {
  const top = copiesFor(id);
  const want = Math.floor(Number(settings?.constanceMaxCopies));
  return Number.isFinite(want) && want >= 1 ? Math.min(top, want) : top;
}

// Room for one more copy: at least minFreeBytes and minFreeShare of memory
// available, read fresh before EVERY start, and at least minGapMs since the
// last copy started. The gap matters because a CLI takes a few seconds to
// allocate: without it ten copies all read the same free memory in the same
// second and start together (finding 17). CONSTANCE_RAMP_GAP_MS overrides the
// gap (the tests use 0).
export const RAMP = {
  minFreeBytes: 2 * 1024 ** 3,
  minFreeShare: 0.1,
  minGapMs: 5000,
};

export function rampGap(env = process.env, ramp = RAMP) {
  const v = env.CONSTANCE_RAMP_GAP_MS;
  const n = v === undefined || v === "" ? NaN : Number(v);
  // A null ramp must not throw here: roomForCopy fails it closed on memory.
  return Number.isFinite(n) && n >= 0 ? n : ramp?.minGapMs;
}

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

// { ok, reason }. `running` = copies of this agent already started;
// `lastStartAt` = when the newest copy started (0 = never): starts are spaced
// by the ramp gap. The first copy only needs readable, healthy numbers; an
// unreadable machine allows the first copy and holds the rest. A malformed
// machine object counts as unreadable, and a malformed ramp fails closed (no
// copy) — a NaN need must never read as room.
export function roomForCopy(machine, { running = 0, lastStartAt = 0, now = Date.now(), ramp = RAMP, gapMs = rampGap(process.env, ramp) } = {}) {
  const since = now - (Number(lastStartAt) || 0);
  if (lastStartAt > 0 && since < gapMs) return { ok: false, reason: `spacing copy starts: the last one started ${Math.max(0, Math.round(since / 1000))} s ago (next after ${Math.round(gapMs / 1000)} s)` };
  const unreadable = running === 0
    ? { ok: true, reason: "" }
    : { ok: false, reason: "can't read the machine's load and memory, so only one copy runs" };
  if (!machine || !numeric(machine.memTotal) || !numeric(machine.memAvailable)) return unreadable;
  const memNeed = Math.max(ramp?.minFreeBytes, ramp?.minFreeShare * machine.memTotal);
  if (!numeric(memNeed)) return { ok: false, reason: "can't read the memory floor, so no copy starts" };
  if (machine.memAvailable < memNeed) return { ok: false, reason: `low memory: ${gib(machine.memAvailable)} GiB free (starts at ${gib(memNeed)} GiB)` };
  return { ok: true, reason: "" };
}
