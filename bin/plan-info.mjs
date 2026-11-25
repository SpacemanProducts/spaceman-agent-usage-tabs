// Plan / free-tier info from what each tool itself reports. Pure parsers
// (tested against real output) plus a cached runner. Nothing here invents a
// number: if a tool reports nothing, the result is empty and the tab shows
// nothing extra.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Amp: `amp usage`. Only the sign-in and a daily allowance (if Amp reports one)
// are used; purchased credit balances are deliberately ignored.
export function parseAmpUsage(out) {
  const text = String(out);
  if (!/Signed in as/i.test(text)) return null;
  const daily = text.match(/(?:daily[^\n$]*|[^\n$]*per day[^\n$]*)\$([\d,.]+)[^\n]*/i);
  return { signedIn: true, note: daily ? `Daily allowance $${daily[1]}` : "" };
}

const RUNNERS = {
  amp: { cmd: ["amp", "usage"], parse: parseAmpUsage },
};
const TTL_MS = 30 * 60 * 1000;

// Runs the tool (headless), cached 30 min; keeps the last good answer on failure.
export function planInfo(agentId, { env, stateDir, now = Date.now(), run = defaultRun, onUnexpected } = {}) {
  const spec = RUNNERS[agentId];
  if (!spec) return null;
  const file = path.join(stateDir, "plan-info.json");
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch {}
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) cache = {};
  const hit = cache[agentId];
  if (hit && now - hit.at < TTL_MS) return hit.info ?? null;
  const raw = String(run(spec.cmd, env) ?? "");
  const info = spec.parse(raw);
  if (!info && raw.trim() && !/not (logged|signed) in|not authenticated|log ?in|sign ?in|only available for/i.test(raw) && onUnexpected)
    onUnexpected("usage output didn't match the expected format", { command: spec.cmd.join(" "), head: raw.slice(0, 200) });
  if (info) { cache[agentId] = { at: now, info }; try { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(cache)); } catch {} return info; }
  return hit?.info ?? null;
}

function defaultRun(cmd, env) {
  const e = { ...env }; delete e.DISPLAY; delete e.WAYLAND_DISPLAY;
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", env: e, timeout: 45000, stdio: ["ignore", "pipe", "ignore"] });
  return String(r.stdout || "");
}
